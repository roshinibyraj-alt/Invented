'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 5-MINUTE AUTO-SCHEDULE ENGINE (single automatic engine)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Full replacement of the old cricket/tennis/crypto trailing-grid
 *  ladder bot. This engine trades ONLY Polymarket's BTC "Up or Down"
 *  5-minute markets (slug pattern btc-updown-5m-{unix_ts}), fully
 *  automatically — no manual "add a match" step. It computes the
 *  current window deterministically from the clock
 *  (windowTs = floor(now/300)*300), discovers that window's market on
 *  Gamma, trades it on a fixed time schedule, then rolls into the next
 *  window the instant the current 5-minute boundary passes — forever.
 *
 *  SCHEDULE (relative to each window's start, repeats every window):
 *    t+60s  (1 min elapsed)  buy the CHEAP side  — 50 shares
 *    t+120s (2 min elapsed)  buy the EXPENSIVE side — 10 shares
 *    t+180s (3 min elapsed)  buy the EXPENSIVE side — 30 shares
 *    t+240s (4 min elapsed)  buy the EXPENSIVE side — 90 shares
 *  "Cheap"/"expensive" = whichever of Up/Down has the lower/higher live
 *  ask price, re-checked FRESH and independently at each of these 4
 *  moments — the side is not fixed for the window, it can differ at
 *  every step. Each buy crosses the spread (priced at the live ask) so
 *  it fills immediately, like a market order. Share counts are FIXED,
 *  not scaled to bankroll — there is no bankroll-proportional sizing
 *  or compounding in this strategy, by design.
 *
 *  NO EXIT LOGIC: whatever is bought is held to settlement. There is
 *  no take-profit, no stop-loss, no selling before resolution. Every
 *  window's positions get marked to $1/share (winning side) or $0/share
 *  (losing side) once Polymarket resolves it, via Gamma's
 *  `closed` + `outcomePrices` fields (same detection style as before).
 *
 *  Because resolution can lag a few seconds past the 5-minute mark, a
 *  window that rolls over before it's confirmed resolved is moved to a
 *  background "pending resolution" queue and polled there independently
 *  — this never blocks the next window's schedule from starting on time.
 *
 *  FEES: every buy here crosses the spread (a taker fill), so a taker
 *  fee is estimated and deducted at buy time — there is no maker rebate
 *  in this strategy (unlike the old resting-order ladder).
 *
 *  TRADER INTERFACE (LIVE mode only):
 *    trader.placeLimitBuy(tokenId, price, size) -> { id, filled, avgPrice, filledShares }
 *    trader.getOrder(orderId)                   -> { filled, avgPrice, filledShares }
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS             = 500;
const PRICE_REFRESH_MS    = 1000;
const DISCOVERY_RETRY_MS  = 2000;   // how often to retry finding a not-yet-listed window's market
const RESOLUTION_POLL_MS  = 3000;   // how often to poll pending (past) windows for resolution
const WINDOW_SECONDS      = 300;    // 5 minutes

// The fixed time-triggered schedule. "side" is re-evaluated fresh at the
// moment each step fires — see runSchedule(). Never retried if skipped.
const SCHEDULE = [
  { key: 'min1', atSec: 60,  side: 'cheap',     shares: 50 },
  { key: 'min2', atSec: 120, side: 'expensive', shares: 10 },
  { key: 'min3', atSec: 180, side: 'expensive', shares: 30 },
  { key: 'min4', atSec: 240, side: 'expensive', shares: 90 },
];

let DRY_RUN = (process.env.BTC5M_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const STARTING_CAPITAL = Number(process.env.BTC5M_CAPITAL || 500);
// Observed live fee schedule for BTC updown markets is taker-only, rate ~0.07 (see feeSchedule on the Gamma market object).
const TAKER_FEE_RATE = Number(process.env.BTC5M_TAKER_FEE_RATE || 0.07);
const MAX_PENDING_RESOLUTIONS = 20; // safety cap on the background resolution queue

function round2(n) { return Math.round(n * 100) / 100; }
function estimateTakerFee(shares, price) {
  // Standard prediction-market fee shape: fee scales with size and with
  // how close price is to $0.50 (max uncertainty = max fee base).
  return round2(shares * TAKER_FEE_RATE * price * (1 - price));
}

let emitFn = () => {};
let slog = () => {};
let trader = null;
let warnedNoTraderMethod = false;
let tradeSeq = 0;

const engine = {
  tradingEnabled: true,
  bankroll: STARTING_CAPITAL,
  capital: STARTING_CAPITAL,
  realizedPnl: 0,
  feesPaid: 0,
  wins: 0, losses: 0,
  window: null,   // current active window being scheduled
  pending: [],    // past windows awaiting resolution confirmation (background queue)
  history: [],    // resolved windows, most recent first, capped
  logs: [],
  trades: [],
  equityCurve: [{ t: Date.now(), equity: STARTING_CAPITAL }],
  lastPriceFetch: 0,
  lastResolutionPoll: 0,
};

// ─────────────────────────────────────────
//  Logging / bookkeeping
// ─────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  engine.logs.push(line);
  if (engine.logs.length > 500) engine.logs.shift();
  slog(`[btc5m] ${line}`);
}
function registerTrade(t) {
  const trade = { seq: ++tradeSeq, time: new Date().toISOString().slice(11, 19), ...t };
  engine.trades.push(trade);
  if (engine.trades.length > 300) engine.trades.shift();
}
function recordEquity() {
  engine.equityCurve.push({ t: Date.now(), equity: engine.bankroll });
  if (engine.equityCurve.length > 1000) engine.equityCurve.shift();
}

// ─────────────────────────────────────────
//  HTTP / order helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-btc5m-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
function describeOrderError(e) {
  const parts = [e?.message || String(e)];
  const extra = e?.response?.data ?? e?.data ?? e?.body ?? null;
  if (extra) { try { parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (_) {} }
  return parts.join(' | ');
}
function traderHasLimitMethod() {
  const ok = trader && typeof trader.placeLimitBuy === 'function';
  if (!ok && !warnedNoTraderMethod) {
    warnedNoTraderMethod = true;
    slog('[btc5m] ❌ LIVE trading needs trader.placeLimitBuy (and ideally getOrder) on polymarket-trader.js — LIVE buys will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}
async function placeAggressiveBuy(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethod()) return null;
    try { return await trader.placeLimitBuy(tokenId, price, shares); }
    catch (e) { log(`❌ placeLimitBuy failed: ${describeOrderError(e)}`); return null; }
  }
  // DRY_RUN: priced exactly at the live ask, so a real book would match it immediately — simulate an instant fill.
  return { id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: true, avgPrice: price, filledShares: shares };
}

function parseMarketTokens(mk) {
  try {
    const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
    const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}

// ─────────────────────────────────────────
//  Window lifecycle
// ─────────────────────────────────────────
function currentWindowTs(nowSec) { return Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS; }

function freshWindow(windowTs) {
  return {
    windowTs,
    slug: `btc-updown-5m-${windowTs}`,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    status: 'discovering', // 'discovering' | 'trading' | 'resolved'
    conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, downAsk: null, upBid: null, downBid: null,
    scheduleDone: {},
    positions: { up: { shares: 0, cost: 0, fee: 0 }, down: { shares: 0, cost: 0, fee: 0 } },
    lastDiscoveryAttempt: 0,
    createdAt: Date.now(),
  };
}

async function discoverWindow(w) {
  try {
    const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(w.slug)}`);
    const event = Array.isArray(events) ? events[0] : null;
    if (!event) return; // not listed yet on Gamma — will retry
    const mk = (event.markets || [])[0];
    if (!mk) return;
    const tokens = parseMarketTokens(mk);
    const up = tokens.find(t => /up/i.test(t.outcome));
    const down = tokens.find(t => /down/i.test(t.outcome));
    if (!up || !down || !up.token_id || !down.token_id) return; // not tradeable yet
    w.conditionId = mk.conditionId || null;
    w.upTokenId = up.token_id;
    w.downTokenId = down.token_id;
    w.status = 'trading';
    log(`🎯 window ${w.slug} discovered — Up ${String(up.token_id).slice(0, 10)}… / Down ${String(down.token_id).slice(0, 10)}…`);
  } catch (e) {
    log(`⚠️  discoverWindow(${w.slug}) failed: ${e.message}`);
  }
}

async function refreshWindowPrices(w) {
  if (!w.upTokenId || !w.downTokenId) return;
  try {
    const [upAsk, upBid, downAsk, downBid] = await Promise.all([
      getJSON(`${CLOB}/price?token_id=${w.upTokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${w.upTokenId}&side=SELL`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${w.downTokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${w.downTokenId}&side=SELL`).catch(() => null),
    ]);
    if (upAsk?.price != null) w.upAsk = parseFloat(upAsk.price);
    if (upBid?.price != null) w.upBid = parseFloat(upBid.price);
    if (downAsk?.price != null) w.downAsk = parseFloat(downAsk.price);
    if (downBid?.price != null) w.downBid = parseFloat(downBid.price);
  } catch (_) {}
}

function affordable(shares, price) { return round2(shares * price) <= engine.bankroll; }

async function executeBuy(w, side, shares, stepLabel) {
  const tokenId = side === 'up' ? w.upTokenId : w.downTokenId;
  const ask = side === 'up' ? w.upAsk : w.downAsk;
  if (!tokenId || ask == null) { log(`⚠️  [${w.slug}] ${stepLabel}: no live ask for ${side.toUpperCase()} yet — skipping this step (not retried)`); return; }
  if (!affordable(shares, ask)) { log(`⚠️  [${w.slug}] ${stepLabel}: insufficient bankroll ($${engine.bankroll.toFixed(2)}) for ${shares}sh ${side.toUpperCase()} @ ${ask.toFixed(2)} — skipping this step (not retried)`); return; }

  const resp = await placeAggressiveBuy(tokenId, ask, shares);
  if (!resp) { log(`❌ [${w.slug}] ${stepLabel}: order placement failed for ${side.toUpperCase()}`); return; }

  let filled = resp.filled, fillPrice = resp.avgPrice || ask, filledShares = resp.filledShares || shares;
  if (!filled && !DRY_RUN && resp.id && trader && typeof trader.getOrder === 'function') {
    // one immediate re-check — it's priced to cross the book, so it should already have matched
    try {
      const st = await trader.getOrder(resp.id);
      if (st && st.filled) { filled = true; fillPrice = st.avgPrice || ask; filledShares = st.filledShares || shares; }
    } catch (_) {}
  }
  if (!filled) {
    log(`⏳ [${w.slug}] ${stepLabel}: ${shares}sh ${side.toUpperCase()} @ ${ask.toFixed(2)} placed but unconfirmed — not tracked as a position, not retried this window`);
    return;
  }

  const cost = round2(filledShares * fillPrice);
  const fee = estimateTakerFee(filledShares, fillPrice);
  engine.bankroll = round2(engine.bankroll - cost - fee);
  engine.feesPaid = round2(engine.feesPaid + fee);

  const pos = w.positions[side];
  pos.shares = round2(pos.shares + filledShares);
  pos.cost = round2(pos.cost + cost);
  pos.fee = round2(pos.fee + fee);

  registerTrade({ slug: w.slug, step: stepLabel, side, price: fillPrice, shares: filledShares, cost, fee });
  log(`✅ [${w.slug}] ${stepLabel}: bought ${filledShares}sh ${side.toUpperCase()} @ ${fillPrice.toFixed(2)} ($${cost.toFixed(2)} + $${fee.toFixed(4)} fee) | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

async function runSchedule(w) {
  if (w.status !== 'trading') return;
  const elapsedSec = Math.floor(Date.now() / 1000) - w.windowTs;
  for (const step of SCHEDULE) {
    if (w.scheduleDone[step.key]) continue;
    if (elapsedSec < step.atSec) continue;
    w.scheduleDone[step.key] = true; // mark attempted regardless of outcome — this step never fires again this window
    if (!engine.tradingEnabled) { log(`⏸️  [${w.slug}] ${step.key} (t+${step.atSec}s): trading paused, step skipped`); continue; }

    let side = null;
    if (w.upAsk != null && w.downAsk != null) {
      if (w.upAsk === w.downAsk) { side = 'up'; log(`ℹ️  [${w.slug}] ${step.key}: Up/Down tied at ${w.upAsk.toFixed(2)} — defaulting to UP`); }
      else side = step.side === 'cheap' ? (w.upAsk < w.downAsk ? 'up' : 'down') : (w.upAsk > w.downAsk ? 'up' : 'down');
    }
    if (!side) { log(`⚠️  [${w.slug}] ${step.key}: prices unavailable — cannot determine ${step.side} side, skipping (not retried)`); continue; }

    await executeBuy(w, side, step.shares, `${step.key} t+${step.atSec}s (${step.side})`);
  }
}

// ─────────────────────────────────────────
//  Resolution (background queue — never blocks the live schedule)
// ─────────────────────────────────────────
async function checkWindowResolution(w) {
  try {
    let mk = null;
    if (w.conditionId) {
      const arr = await getJSON(`${GAMMA}/markets?condition_ids=${encodeURIComponent(w.conditionId)}`);
      mk = Array.isArray(arr) ? arr[0] : null;
    }
    if (!mk) {
      const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(w.slug)}`);
      const event = Array.isArray(events) ? events[0] : null;
      mk = event ? (event.markets || [])[0] : null;
    }
    if (!mk || mk.closed !== true || !mk.outcomePrices) return false;
    const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : mk.outcomePrices;
    const tokens = parseMarketTokens(mk);
    const upIdx = tokens.findIndex(t => String(t.token_id) === String(w.upTokenId));
    const downIdx = tokens.findIndex(t => String(t.token_id) === String(w.downTokenId));
    if (upIdx < 0 || downIdx < 0 || prices[upIdx] == null) return false;
    resolveWindow(w, parseFloat(prices[upIdx]) >= 0.5 ? 'up' : 'down');
    return true;
  } catch (e) {
    log(`⚠️  checkWindowResolution(${w.slug}) failed: ${e.message}`);
    return false;
  }
}

function resolveWindow(w, winningSide) {
  w.status = 'resolved';
  const winPos = w.positions[winningSide];
  const losePos = w.positions[winningSide === 'up' ? 'down' : 'up'];
  const payout = round2(winPos.shares * 1);
  const totalCost = round2(winPos.cost + losePos.cost);
  const totalFees = round2(winPos.fee + losePos.fee);
  const pnl = round2(payout - totalCost); // fees were already deducted from bankroll at buy time — don't double-count them here

  engine.bankroll = round2(engine.bankroll + payout);
  engine.realizedPnl = round2(engine.realizedPnl + pnl);
  if (pnl >= 0) engine.wins++; else engine.losses++;

  engine.history.unshift({
    slug: w.slug, windowTs: w.windowTs, winningSide,
    upShares: w.positions.up.shares, upCost: w.positions.up.cost,
    downShares: w.positions.down.shares, downCost: w.positions.down.cost,
    payout, totalCost, totalFees, pnl,
    resolvedAt: Date.now(),
  });
  if (engine.history.length > 200) engine.history.pop();

  registerTrade({ slug: w.slug, step: 'RESOLUTION', side: winningSide, shares: winPos.shares, price: 1, pnl });
  log(`🏁 [${w.slug}] resolved — ${winningSide.toUpperCase()} won | payout $${payout.toFixed(2)} | cost $${totalCost.toFixed(2)} | fees $${totalFees.toFixed(4)} | pnl $${pnl.toFixed(2)} | bankroll $${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

// ─────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────
let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      const windowTs = currentWindowTs(nowSec);

      if (!engine.window || engine.window.windowTs !== windowTs) {
        if (engine.window && engine.window.status !== 'resolved') {
          engine.pending.push(engine.window);
          if (engine.pending.length > MAX_PENDING_RESOLUTIONS) {
            const dropped = engine.pending.shift();
            log(`⚠️  dropped stale pending window ${dropped.slug} from the resolution queue (too many pending) — its win/loss won't be tallied, but its cost/fees were already applied to bankroll at buy time`);
          }
        }
        engine.window = freshWindow(windowTs);
        log(`🆕 new window ${engine.window.slug} — discovering market…`);
      }

      const w = engine.window;
      if (w.status === 'discovering' && now - w.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
        w.lastDiscoveryAttempt = now;
        await discoverWindow(w);
      }
      if (w.upTokenId && now - engine.lastPriceFetch >= PRICE_REFRESH_MS) {
        engine.lastPriceFetch = now;
        await refreshWindowPrices(w);
      }
      await runSchedule(w);

      if (engine.pending.length && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
        engine.lastResolutionPoll = now;
        const stillPending = [];
        for (const pw of engine.pending) {
          const done = await checkWindowResolution(pw);
          if (!done) stillPending.push(pw);
        }
        engine.pending = stillPending;
      }

      emitFn('btc5mState', buildState());
    } catch (e) {
      slog(`[btc5m] ⚠️  Loop error: ${e.message}`);
    }
    await new Promise(res => setTimeout(res, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  UI state / controls
// ─────────────────────────────────────────
function buildState() {
  const w = engine.window;
  return {
    dryRun: DRY_RUN,
    tradingEnabled: engine.tradingEnabled,
    bankroll: engine.bankroll, capital: engine.capital,
    realizedPnl: engine.realizedPnl, feesPaid: engine.feesPaid,
    wins: engine.wins, losses: engine.losses,
    window: w ? {
      slug: w.slug, windowTs: w.windowTs, closeAt: w.closeAt, status: w.status,
      elapsedSec: Math.max(0, Math.min(WINDOW_SECONDS, Math.floor(Date.now() / 1000) - w.windowTs)),
      upAsk: w.upAsk, downAsk: w.downAsk, upBid: w.upBid, downBid: w.downBid,
      scheduleDone: w.scheduleDone, positions: w.positions,
    } : null,
    pendingResolutionCount: engine.pending.length,
    history: engine.history.slice(0, 50),
    trades: engine.trades.slice(-100).slice().reverse(),
    equityCurve: engine.equityCurve,
    logs: engine.logs.slice(-80),
    schedule: SCHEDULE,
    windowSeconds: WINDOW_SECONDS,
  };
}
function getStatus() { return buildState(); } // back-compat alias, some callers may still use this name

function pauseTrading() {
  engine.tradingEnabled = false;
  log('⏸️  Trading paused — scheduled buys will be skipped from now on; open positions still tracked to resolution, and window discovery/rollover keeps running');
  return { ok: true };
}
function resumeTrading() {
  engine.tradingEnabled = true;
  log('▶️  Trading resumed');
  return { ok: true };
}
function setMode(live) {
  DRY_RUN = !live;
  log(`⚙️  Switched to ${live ? '🔴 LIVE' : '⚠️  DEMO'} mode`);
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  slog('[btc5m] 🪙 BTC 5-Minute Auto-Schedule Engine — fully automatic, no manual match management');
  slog('[btc5m] ⚙️  Schedule per window: t+60s buy CHEAP 50sh | t+120s buy EXPENSIVE 10sh | t+180s buy EXPENSIVE 30sh | t+240s buy EXPENSIVE 90sh (side re-checked fresh each time)');
  slog(`[btc5m] ⚙️  Starting bankroll $${STARTING_CAPITAL} | fixed share counts, no compounding | positions held to settlement, no TP/exit logic | new window auto-discovered every 5 min forever`);
  slog(`[btc5m] ${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => slog(`[btc5m] ❌ Fatal: ${e.message}`));
}

module.exports = {
  init,
  pauseTrading, resumeTrading,
  setMode,
  getStatus, buildState,
};
