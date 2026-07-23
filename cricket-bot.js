'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC + ETH 5-MINUTE GAP-MONITORING TRADING ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 *  Trades Polymarket's BTC and ETH "Up or Down" 5-minute markets
 *  TOGETHER, monitoring the FULL window continuously (t+0:00 to
 *  t+5:00) — there are no monitoring periods or minute buckets. Two
 *  pairs are watched every price-refresh tick for the entire window:
 *      Up-pair:   BTC-Up ask  +  ETH-Up ask
 *      Down-pair: BTC-Down ask + ETH-Down ask
 *  For each pair: the instant EITHER leg's ask price rises above 0.70,
 *  the engine immediately buys 50 shares of whichever of the two legs
 *  is CHEAPER (the presumed value side). There is NO combined-price
 *  / gap requirement anymore — a single expensive leg is enough to
 *  fire, regardless of what the other leg costs. Example: BTC-down
 *  0.82, ETH-down 0.60 -> BTC-down > 0.70 -> buy 50sh ETH-down (the
 *  cheaper leg). Combined sum/gap are still computed and shown on
 *  the dashboard for context, but play no role in the trigger.
 *
 *  ONE-SIDE-FIRST, THEN THE OTHER: each pair (Up, Down) can fire AT
 *  MOST ONCE per window — once a pair fires it's LOCKED for the rest
 *  of that window (no re-arming). Whichever side (Up or Down) meets
 *  the condition first is free to fire; after that, only the
 *  opposite side remains armed for the rest of the window. So a
 *  window can produce at most 2 buys total (one Up, one Down), and
 *  never two buys on the same side. If a pair never meets the
 *  condition during the window, no trade happens for that pair that
 *  window (not retried later).
 *
 *  BOTH markets share ONE bankroll ($2000 demo starting capital by
 *  default). Share size is fixed at 50 — no bankroll-proportional
 *  sizing or compounding.
 *
 *  NO EXIT LOGIC: whatever is bought is held to settlement. There is
 *  no take-profit, no stop-loss, no selling before resolution. Every
 *  position is marked to $1/share (winning side) or $0/share (losing
 *  side) once Polymarket resolves that asset's window, via Gamma's
 *  `closed` + `outcomePrices` fields.
 *
 *  BTC and ETH windows for the same 5-minute slot resolve
 *  INDEPENDENTLY of each other (different underlying markets), so
 *  each is tracked and resolved on its own timeline even though they
 *  share the same window clock and monitoring periods.
 *
 *  STARTUP: if the bot is started mid-window, it will NOT jump into
 *  that window's monitoring partway through. It waits, doing
 *  nothing, until the next fresh 5-minute boundary before trading
 *  begins.
 *
 *  REAL-TIME P&L: bankroll (cash), realized P&L (from settled
 *  windows) and unrealized P&L (mark-to-market on open positions,
 *  using live bid prices) are all recomputed and broadcast every
 *  tick — not just at settlement.
 *
 *  FEES: every buy here crosses the spread (a taker fill), so a taker
 *  fee is estimated and deducted at buy time.
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

// The two markets we trade every window.
const ASSETS = [
  { key: 'btc', label: 'BTC', slugPrefix: 'btc-updown-5m-' },
  { key: 'eth', label: 'ETH', slugPrefix: 'eth-updown-5m-' },
];

const PAIRS = ['up', 'down']; // Up-pair (BTC-up vs ETH-up), Down-pair (BTC-down vs ETH-down)

const GAP_THRESHOLD    = Number(process.env.BTC5M_GAP_THRESHOLD || 0.20); // informational only — no longer gates the trigger
const LEG_PRICE_THRESHOLD = Number(process.env.BTC5M_LEG_PRICE_THRESHOLD || 0.70); // trigger fires when either leg's ask exceeds this
const SHARES_PER_TRIGGER = Number(process.env.BTC5M_TRIGGER_SHARES || 50);

let DRY_RUN = (process.env.BTC5M_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const STARTING_CAPITAL = Number(process.env.BTC5M_CAPITAL || 2000);
// Observed live fee schedule for updown markets is taker-only, rate ~0.07 (see feeSchedule on the Gamma market object).
const TAKER_FEE_RATE = Number(process.env.BTC5M_TAKER_FEE_RATE || 0.07);
const MAX_PENDING_RESOLUTIONS = 40; // safety cap on the background resolution queue (2 assets/window now)

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
  bankroll: STARTING_CAPITAL,   // live cash balance (cost+fees deducted at buy, payout added at resolution)
  capital: STARTING_CAPITAL,    // fixed reference to starting capital, never changes
  realizedPnl: 0,
  feesPaid: 0,
  wins: 0, losses: 0,
  cycle: null,          // current window pair being monitored ({ windowTs, assets: { btc, eth }, entries })
  pending: [],           // past asset-windows awaiting resolution confirmation (background queue)
  history: [],           // resolved asset-windows, most recent first, capped
  logs: [],
  trades: [],
  equityCurve: [{ t: Date.now(), equity: STARTING_CAPITAL }],
  lastPriceFetch: 0,
  lastResolutionPoll: 0,
  waitingForBoundary: true,   // true until we cross a fresh 5-min boundary after startup
  boundaryWindowTs: null,     // the (mid-progress) window we refuse to trade, seen at startup
};

// ─────────────────────────────────────────
//  Logging / bookkeeping
// ─────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  engine.logs.push(line);
  if (engine.logs.length > 500) engine.logs.shift();
  slog(`[updown5m] ${line}`);
}
function registerTrade(t) {
  const trade = { seq: ++tradeSeq, time: new Date().toISOString().slice(11, 19), ...t };
  engine.trades.push(trade);
  if (engine.trades.length > 300) engine.trades.shift();
}
function recordEquity() {
  engine.equityCurve.push({ t: Date.now(), equity: round2(engine.bankroll + openPositionsMTM()) });
  if (engine.equityCurve.length > 1000) engine.equityCurve.shift();
}

// ─────────────────────────────────────────
//  HTTP / order helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-updown5m-bot/1.0' } });
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
    slog('[updown5m] ❌ LIVE trading needs trader.placeLimitBuy (and ideally getOrder) on polymarket-trader.js — LIVE buys will be skipped until added. DRY_RUN is unaffected.');
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

function freshAssetWindow(assetDef, windowTs) {
  return {
    asset: assetDef.key,
    label: assetDef.label,
    windowTs,
    slug: `${assetDef.slugPrefix}${windowTs}`,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    status: 'discovering', // 'discovering' | 'trading' | 'resolved'
    conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, downAsk: null, upBid: null, downBid: null,
    positions: { up: { shares: 0, cost: 0, fee: 0 }, down: { shares: 0, cost: 0, fee: 0 } },
    lastDiscoveryAttempt: 0,
    createdAt: Date.now(),
  };
}

// One entry slot per pair, valid for the WHOLE window (no periods). Each
// pair can fire at most once per window; once one side fires, only the
// opposite side remains armed for the rest of the window.
function freshEntries() {
  return {
    up:   { done: false, boughtAsset: null, gap: null, sum: null, ts: null },
    down: { done: false, boughtAsset: null, gap: null, sum: null, ts: null },
  };
}

function freshCycle(windowTs) {
  return {
    windowTs,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    assets: {
      btc: freshAssetWindow(ASSETS[0], windowTs),
      eth: freshAssetWindow(ASSETS[1], windowTs),
    },
    entries: freshEntries(),
    createdAt: Date.now(),
  };
}

async function discoverAssetWindow(aw) {
  try {
    const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(aw.slug)}`);
    const event = Array.isArray(events) ? events[0] : null;
    if (!event) return; // not listed yet on Gamma — will retry
    const mk = (event.markets || [])[0];
    if (!mk) return;
    const tokens = parseMarketTokens(mk);
    const up = tokens.find(t => /up/i.test(t.outcome));
    const down = tokens.find(t => /down/i.test(t.outcome));
    if (!up || !down || !up.token_id || !down.token_id) return; // not tradeable yet
    aw.conditionId = mk.conditionId || null;
    aw.upTokenId = up.token_id;
    aw.downTokenId = down.token_id;
    aw.status = 'trading';
    log(`🎯 ${aw.label} window ${aw.slug} discovered — Up ${String(up.token_id).slice(0, 10)}… / Down ${String(down.token_id).slice(0, 10)}…`);
  } catch (e) {
    log(`⚠️  discoverAssetWindow(${aw.slug}) failed: ${e.message}`);
  }
}

async function refreshAssetPrices(aw) {
  if (!aw.upTokenId || !aw.downTokenId) return;
  try {
    const [upAsk, upBid, downAsk, downBid] = await Promise.all([
      getJSON(`${CLOB}/price?token_id=${aw.upTokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${aw.upTokenId}&side=SELL`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${aw.downTokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${aw.downTokenId}&side=SELL`).catch(() => null),
    ]);
    if (upAsk?.price != null) aw.upAsk = parseFloat(upAsk.price);
    if (upBid?.price != null) aw.upBid = parseFloat(upBid.price);
    if (downAsk?.price != null) aw.downAsk = parseFloat(downAsk.price);
    if (downBid?.price != null) aw.downBid = parseFloat(downBid.price);
  } catch (_) {}
}

function affordable(shares, price) { return round2(shares * price) <= engine.bankroll; }

async function executeBuy(aw, side, shares, stepLabel) {
  const tokenId = side === 'up' ? aw.upTokenId : aw.downTokenId;
  const ask = side === 'up' ? aw.upAsk : aw.downAsk;
  if (!tokenId || ask == null) { log(`⚠️  [${aw.slug}] ${stepLabel}: no live ask for ${side.toUpperCase()} yet — skipping this trigger`); return; }
  if (!affordable(shares, ask)) { log(`⚠️  [${aw.slug}] ${stepLabel}: insufficient bankroll ($${engine.bankroll.toFixed(2)}) for ${shares}sh ${side.toUpperCase()} @ ${ask.toFixed(2)} — skipping this trigger`); return; }

  const resp = await placeAggressiveBuy(tokenId, ask, shares);
  if (!resp) { log(`❌ [${aw.slug}] ${stepLabel}: order placement failed for ${side.toUpperCase()}`); return; }

  let filled = resp.filled, fillPrice = resp.avgPrice || ask, filledShares = resp.filledShares || shares;
  if (!filled && !DRY_RUN && resp.id && trader && typeof trader.getOrder === 'function') {
    // one immediate re-check — it's priced to cross the book, so it should already have matched
    try {
      const st = await trader.getOrder(resp.id);
      if (st && st.filled) { filled = true; fillPrice = st.avgPrice || ask; filledShares = st.filledShares || shares; }
    } catch (_) {}
  }
  if (!filled) {
    log(`⏳ [${aw.slug}] ${stepLabel}: ${shares}sh ${side.toUpperCase()} @ ${ask.toFixed(2)} placed but unconfirmed — not tracked as a position, not retried`);
    return;
  }

  const cost = round2(filledShares * fillPrice);
  const fee = estimateTakerFee(filledShares, fillPrice);
  engine.bankroll = round2(engine.bankroll - cost - fee);
  engine.feesPaid = round2(engine.feesPaid + fee);

  const pos = aw.positions[side];
  pos.shares = round2(pos.shares + filledShares);
  pos.cost = round2(pos.cost + cost);
  pos.fee = round2(pos.fee + fee);

  registerTrade({ slug: aw.slug, asset: aw.asset, step: stepLabel, side, price: fillPrice, shares: filledShares, cost, fee });
  log(`✅ [${aw.slug}] ${stepLabel}: bought ${filledShares}sh ${aw.label}-${side.toUpperCase()} @ ${fillPrice.toFixed(2)} ($${cost.toFixed(2)} + $${fee.toFixed(4)} fee) | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

// Called every tick while a cycle is trading. Continuously watches both
// pairs for the ENTIRE window (no periods, no combined-sum requirement).
// The instant EITHER leg of a pair prices above LEG_PRICE_THRESHOLD, it
// fires a single buy of the CHEAPER leg for that pair and LOCKS for the
// rest of the window — it will not fire again. The other pair stays
// armed and can still fire once, whenever its own condition is met
// (before or after the first side, in any order). Once both pairs have
// fired, the window is done triggering.
async function monitorAndTrigger(cycle) {
  const elapsedSec = Math.floor(Date.now() / 1000) - cycle.windowTs;
  if (elapsedSec < 0 || elapsedSec >= WINDOW_SECONDS) return; // outside the window — just hold

  const entries = cycle.entries;
  for (const pair of PAIRS) {
    if (entries[pair].done) continue; // this side already fired this window — locked, skip

    const btcAsk = cycle.assets.btc[pair === 'up' ? 'upAsk' : 'downAsk'];
    const ethAsk = cycle.assets.eth[pair === 'up' ? 'upAsk' : 'downAsk'];
    if (btcAsk == null || ethAsk == null) continue; // no live prices yet, keep watching

    if (btcAsk <= LEG_PRICE_THRESHOLD && ethAsk <= LEG_PRICE_THRESHOLD) continue; // neither leg expensive enough yet, keep watching

    const sum = round2(btcAsk + ethAsk); // informational only, no longer gates the trigger
    const gap = round2(1 - sum);
    const cheaperAsset = btcAsk <= ethAsk ? 'btc' : 'eth';
    entries[pair].done = true;
    entries[pair].boughtAsset = cheaperAsset;
    entries[pair].gap = gap;
    entries[pair].sum = sum;
    entries[pair].ts = Date.now();

    const otherPair = pair === 'up' ? 'down' : 'up';
    const otherStatus = entries[otherPair].done ? `${otherPair}-pair already locked too — window done triggering` : `${otherPair}-pair remains armed as the only side that can still fire this window`;

    if (!engine.tradingEnabled) {
      log(`⏸️  ${pair}-pair: BTC=${btcAsk.toFixed(2)} ETH=${ethAsk.toFixed(2)} (sum=${sum.toFixed(2)}) one leg > ${LEG_PRICE_THRESHOLD.toFixed(2)} but trading is paused — skipped (${otherStatus})`);
      continue;
    }
    log(`🔎 ${pair}-pair: BTC=${btcAsk.toFixed(2)} ETH=${ethAsk.toFixed(2)} (sum=${sum.toFixed(2)}) one leg > ${LEG_PRICE_THRESHOLD.toFixed(2)} → buy ${cheaperAsset.toUpperCase()}-${pair.toUpperCase()} (cheaper leg) | ${otherStatus}`);
    await executeBuy(cycle.assets[cheaperAsset], pair, SHARES_PER_TRIGGER, `${pair}-pair leg>${LEG_PRICE_THRESHOLD.toFixed(2)}`);
  }
}

// ─────────────────────────────────────────
//  Mark-to-market (unrealized P&L)
// ─────────────────────────────────────────
function markPrice(aw, side) {
  const bid = side === 'up' ? aw.upBid : aw.downBid;
  const ask = side === 'up' ? aw.upAsk : aw.downAsk;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return null; // no live price at all — fall back to cost basis (0 unrealized) for this leg
}
function unrealizedForAssetWindow(aw) {
  if (aw.status === 'resolved') return 0;
  let u = 0;
  for (const side of ['up', 'down']) {
    const pos = aw.positions[side];
    if (pos.shares <= 0) continue;
    const mp = markPrice(aw, side);
    const mark = mp != null ? mp : (pos.cost / pos.shares);
    u += round2(pos.shares * mark - pos.cost);
  }
  return u;
}
function openCostForAssetWindow(aw) {
  if (aw.status === 'resolved') return 0;
  return round2(aw.positions.up.cost + aw.positions.down.cost);
}
function allTrackedAssetWindows() {
  const list = [...engine.pending];
  if (engine.cycle) list.push(engine.cycle.assets.btc, engine.cycle.assets.eth);
  return list;
}
function totalUnrealizedPnl() {
  return round2(allTrackedAssetWindows().reduce((sum, aw) => sum + unrealizedForAssetWindow(aw), 0));
}
function openPositionsMTM() {
  return round2(allTrackedAssetWindows().reduce((sum, aw) => sum + openCostForAssetWindow(aw) + unrealizedForAssetWindow(aw), 0));
}

// ─────────────────────────────────────────
//  Resolution (background queue — never blocks the live monitoring)
// ─────────────────────────────────────────
async function checkAssetResolution(aw) {
  try {
    let mk = null;
    if (aw.conditionId) {
      const arr = await getJSON(`${GAMMA}/markets?condition_ids=${encodeURIComponent(aw.conditionId)}`);
      mk = Array.isArray(arr) ? arr[0] : null;
    }
    if (!mk) {
      const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(aw.slug)}`);
      const event = Array.isArray(events) ? events[0] : null;
      mk = event ? (event.markets || [])[0] : null;
    }
    if (!mk || mk.closed !== true || !mk.outcomePrices) return false;
    const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : mk.outcomePrices;
    const tokens = parseMarketTokens(mk);
    const upIdx = tokens.findIndex(t => String(t.token_id) === String(aw.upTokenId));
    const downIdx = tokens.findIndex(t => String(t.token_id) === String(aw.downTokenId));
    if (upIdx < 0 || downIdx < 0 || prices[upIdx] == null) return false;
    resolveAssetWindow(aw, parseFloat(prices[upIdx]) >= 0.5 ? 'up' : 'down');
    return true;
  } catch (e) {
    log(`⚠️  checkAssetResolution(${aw.slug}) failed: ${e.message}`);
    return false;
  }
}

function resolveAssetWindow(aw, winningSide) {
  aw.status = 'resolved';
  const winPos = aw.positions[winningSide];
  const losePos = aw.positions[winningSide === 'up' ? 'down' : 'up'];
  const payout = round2(winPos.shares * 1);
  const totalCost = round2(winPos.cost + losePos.cost);
  const totalFees = round2(winPos.fee + losePos.fee);
  const pnl = round2(payout - totalCost); // fees were already deducted from bankroll at buy time — don't double-count them here

  engine.bankroll = round2(engine.bankroll + payout);
  engine.realizedPnl = round2(engine.realizedPnl + pnl);
  if (pnl >= 0) engine.wins++; else engine.losses++;

  engine.history.unshift({
    slug: aw.slug, asset: aw.asset, label: aw.label, windowTs: aw.windowTs, winningSide,
    upShares: aw.positions.up.shares, upCost: aw.positions.up.cost,
    downShares: aw.positions.down.shares, downCost: aw.positions.down.cost,
    payout, totalCost, totalFees, pnl,
    resolvedAt: Date.now(),
  });
  if (engine.history.length > 200) engine.history.pop();

  registerTrade({ slug: aw.slug, asset: aw.asset, step: 'RESOLUTION', side: winningSide, shares: winPos.shares, price: 1, pnl });
  log(`🏁 [${aw.slug}] resolved — ${aw.label}-${winningSide.toUpperCase()} won | payout $${payout.toFixed(2)} | cost $${totalCost.toFixed(2)} | fees $${totalFees.toFixed(4)} | pnl $${pnl.toFixed(2)} | bankroll $${engine.bankroll.toFixed(2)}`);
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

      // ── Startup guard: never join a window that's already in progress ──
      if (engine.waitingForBoundary) {
        if (engine.boundaryWindowTs === null) {
          engine.boundaryWindowTs = windowTs;
          const remaining = WINDOW_SECONDS - (nowSec - windowTs);
          log(`⏳ started mid-window — will NOT trade the in-progress window (ends in ${remaining}s); waiting for the next fresh 5-minute boundary`);
        }
        if (windowTs === engine.boundaryWindowTs) {
          emitFn('btc5mState', buildState());
          await new Promise(res => setTimeout(res, TICK_MS));
          continue;
        }
        engine.waitingForBoundary = false;
        log('🚦 new window boundary reached — trading starts now');
      }

      if (!engine.cycle || engine.cycle.windowTs !== windowTs) {
        if (engine.cycle) {
          for (const assetDef of ASSETS) {
            const aw = engine.cycle.assets[assetDef.key];
            if (aw.status !== 'resolved') {
              engine.pending.push(aw);
              if (engine.pending.length > MAX_PENDING_RESOLUTIONS) {
                const dropped = engine.pending.shift();
                log(`⚠️  dropped stale pending window ${dropped.slug} from the resolution queue (too many pending) — its win/loss won't be tallied, but its cost/fees were already applied to bankroll at buy time`);
              }
            }
          }
          for (const pair of PAIRS) {
            if (!engine.cycle.entries[pair].done) log(`ℹ️  window t=${engine.cycle.windowTs} closed: ${pair}-pair — neither leg ever priced above ${LEG_PRICE_THRESHOLD.toFixed(2)} — no trade that window`);
          }
        }
        engine.cycle = freshCycle(windowTs);
        log(`🆕 new window t=${windowTs} — discovering BTC + ETH markets…`);
      }

      const cycle = engine.cycle;
      for (const assetDef of ASSETS) {
        const aw = cycle.assets[assetDef.key];
        if (aw.status === 'discovering' && now - aw.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
          aw.lastDiscoveryAttempt = now;
          await discoverAssetWindow(aw);
        }
      }
      if (now - engine.lastPriceFetch >= PRICE_REFRESH_MS) {
        engine.lastPriceFetch = now;
        const toRefresh = [cycle.assets.btc, cycle.assets.eth, ...engine.pending];
        await Promise.all(toRefresh.map(aw => refreshAssetPrices(aw)));
      }
      await monitorAndTrigger(cycle);

      if (engine.pending.length && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
        engine.lastResolutionPoll = now;
        const stillPending = [];
        for (const aw of engine.pending) {
          const done = await checkAssetResolution(aw);
          if (!done) stillPending.push(aw);
        }
        engine.pending = stillPending;
      }

      emitFn('btc5mState', buildState());
    } catch (e) {
      slog(`[updown5m] ⚠️  Loop error: ${e.message}`);
    }
    await new Promise(res => setTimeout(res, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  UI state / controls
// ─────────────────────────────────────────
function assetSummary(aw) {
  return {
    asset: aw.asset, label: aw.label, slug: aw.slug, windowTs: aw.windowTs, closeAt: aw.closeAt, status: aw.status,
    upAsk: aw.upAsk, downAsk: aw.downAsk, upBid: aw.upBid, downBid: aw.downBid,
    positions: aw.positions,
    unrealizedPnl: unrealizedForAssetWindow(aw),
  };
}

function buildState() {
  const cycle = engine.cycle;
  const unrealizedPnl = totalUnrealizedPnl();
  const equity = round2(engine.bankroll + openPositionsMTM());
  return {
    dryRun: DRY_RUN,
    tradingEnabled: engine.tradingEnabled,
    waitingForBoundary: engine.waitingForBoundary,
    bankroll: engine.bankroll, capital: engine.capital,
    realizedPnl: engine.realizedPnl, unrealizedPnl, equity,
    feesPaid: engine.feesPaid,
    wins: engine.wins, losses: engine.losses,
    window: cycle ? {
      windowTs: cycle.windowTs, closeAt: cycle.closeAt,
      elapsedSec: Math.max(0, Math.min(WINDOW_SECONDS, Math.floor(Date.now() / 1000) - cycle.windowTs)),
      entries: cycle.entries,
      assets: { btc: assetSummary(cycle.assets.btc), eth: assetSummary(cycle.assets.eth) },
    } : null,
    pendingResolutionCount: engine.pending.length,
    pending: engine.pending.map(assetSummary),
    history: engine.history.slice(0, 50),
    trades: engine.trades.slice(-100).slice().reverse(),
    equityCurve: engine.equityCurve,
    logs: engine.logs.slice(-80),
    gapThreshold: GAP_THRESHOLD,
    legPriceThreshold: LEG_PRICE_THRESHOLD,
    triggerShares: SHARES_PER_TRIGGER,
    windowSeconds: WINDOW_SECONDS,
  };
}
function getStatus() { return buildState(); } // back-compat alias, some callers may still use this name

function pauseTrading() {
  engine.tradingEnabled = false;
  log('⏸️  Trading paused — gap triggers will be skipped from now on; open positions still tracked to resolution, and window discovery/rollover keeps running');
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
  slog('[updown5m] 🪙 BTC + ETH 5-Minute Gap-Monitoring Engine — fully automatic, no manual match management');
  slog(`[updown5m] ⚙️  No monitoring periods, no combined-price requirement — Up-pair (BTC-up + ETH-up) and Down-pair (BTC-down + ETH-down) are watched continuously across the ENTIRE window; the instant EITHER leg of a pair prices above ${LEG_PRICE_THRESHOLD.toFixed(2)}, buy ${SHARES_PER_TRIGGER}sh of the CHEAPER leg. Each side (up/down) fires at most once per window; once one side fires, only the opposite side stays armed for the rest of that window.`);
  slog(`[updown5m] ⚙️  Starting bankroll $${STARTING_CAPITAL} (shared across BTC+ETH) | fixed ${SHARES_PER_TRIGGER}sh per trigger, no compounding | positions held to settlement, no TP/exit logic | never trades a window it joins mid-way through`);
  slog(`[updown5m] ${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => slog(`[updown5m] ❌ Fatal: ${e.message}`));
}

module.exports = {
  init,
  pauseTrading, resumeTrading,
  setMode,
  getStatus, buildState,
};
