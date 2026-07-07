'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — MOMENTUM-LEADER ENTRY
 *  WITH BOUNDED RECOVERY SIZING
 * ═══════════════════════════════════════════════════════════════
 *
 *  ENTRY — one shot per window, per pair:
 *    Wait ENTRY_DELAY_SECS (45s) for the window to settle out of
 *    open noise. Then look at which side currently has the higher
 *    bid — that's the "leader" — and buy it, PROVIDED its ask sits
 *    in a sane [ENTRY_ZONE_MIN, ENTRY_ZONE_MAX] = [0.50, 0.90] band.
 *    Below 0.50 it isn't really leading; above 0.90 the reward left
 *    on the table no longer justifies the risk. If the zone isn't
 *    met yet, the bot keeps checking every tick until ENTRY_CUTOFF_SECS
 *    (280s) — only one entry ever fires per window.
 *
 *  EXIT:
 *    TP/SL are DELIBERATELY ASYMMETRIC: TP +0.15, SL -0.10. Entry and
 *    SL both cross the spread (taker fee each time); TP is a resting
 *    maker fill (earns a rebate instead). A naive symmetric 0.07/0.07
 *    looked "fair" but wasn't — after fees the real R:R came out near
 *    0.5:1, needing ~65% win rate just to break even (verified by
 *    simulation). These widened, skewed values bring the realized
 *    R:R to roughly 1:1 across the entry zone, so a plain coin-flip
 *    win rate is enough to break even.
 *
 *  CLOSE-OUT:
 *    At SWEEP_SECS (285s), any still-open position (never hit TP or
 *    SL) is force-flattened into one maker sell @ 0.99. Anything
 *    still unfilled at window end resolves against the real outcome.
 *
 *  RECOVERY SIZING — the actual point of this bot:
 *    Each pair keeps a `recoveryStep` counter that PERSISTS across
 *    windows (this is what makes it a recovery system rather than a
 *    fresh coin flip every 5 minutes).
 *      - shares(step) = BASE_SHARES * RECOVERY_STEP_MULT^step,
 *        capped at MAX_RECOVERY_STEPS steps and MAX_SHARES_CAP shares.
 *      - Any LOSING close (SL, losing sweep, or losing resolution)
 *        increments the step by 1 (capped — it does not grow forever).
 *      - Any WINNING close (TP, winning sweep, or winning resolution)
 *        immediately resets the step back to 0.
 *    With BASE_SHARES=30 and mult=1.3, sizes run 30 → 39 → 51 → 66 →
 *    86 across the 4 allowed steps — enough to claw back part of a
 *    losing streak on the next win, without ever compounding into a
 *    true martingale blow-up. One win anywhere wipes the streak.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Timing ──
const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const RESOLUTION_BUFFER_S   = 8;
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

// ── Env / config ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ── Entry ──
const ENTRY_DELAY_SECS  = Number(process.env.ENTRY_DELAY_SECS || 45);   // let the window settle before evaluating
const ENTRY_ZONE_MIN    = Number(process.env.ENTRY_ZONE_MIN || 0.50);   // leader must be at least this to count as "leading"
const ENTRY_ZONE_MAX    = Number(process.env.ENTRY_ZONE_MAX || 0.90);   // above this, reward no longer justifies risk
const ENTRY_CUTOFF_SECS = Number(process.env.ENTRY_CUTOFF_SECS || 280); // stop looking for the one entry after this
const SWEEP_SECS        = Number(process.env.SWEEP_SECS || 285);       // force-flatten anything still open
const FINAL_SELL_PRICE  = Number(process.env.FINAL_SELL_PRICE || 0.99);

// ── Fixed TP / SL ──
// Widened + asymmetric on purpose: entry and SL are both taker fills (fee
// each time) while TP is a maker fill (earns a rebate instead). A naive
// symmetric 0.07/0.07 looks fair but is NOT after fees — simulation showed
// a real R:R of ~0.5:1, needing a ~65% win rate just to break even. These
// values were chosen so the realized (post-fee) R:R comes out close to
// 1:1 across the whole entry zone (verified 0.50-0.90 -> ~1.0-1.2:1).
const TP_OFFSET = Number(process.env.TP_OFFSET || 0.15);
const SL_OFFSET = Number(process.env.SL_OFFSET || 0.10);

// ── Bounded recovery sizing (persists across windows, per pair) ──
const BASE_SHARES         = Number(process.env.BASE_SHARES || 30);
const RECOVERY_STEP_MULT  = Number(process.env.RECOVERY_STEP_MULT || 1.3);
const MAX_RECOVERY_STEPS  = Number(process.env.MAX_RECOVERY_STEPS || 4);
const MAX_SHARES_CAP      = Number(process.env.MAX_SHARES_CAP || 120);

// ── Fees & maker rebates (Polymarket Fee Structure V2, crypto category) ──
const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

// ── State ──
let emitFn    = () => {};
let slog      = () => {};
let trader    = null;
let startTime = Date.now();
let logs      = [];
let trades    = [];
let tradingEnabled = true;
let pairList = [...DEFAULT_PAIRS];
let perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
let pairs = {};
let lastPolyPriceFetch = 0;
let totalEquityCurve = [];

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}
function round2(n) { return Math.round(n * 100) / 100; }
function nowSec() { return Date.now() / 1000; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-recovery-scalper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-recovery-scalper/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Order helpers
// ─────────────────────────────────────────
async function placeLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function placeLimitSell(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitSell(tokenId, shares, price);
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function cancelOrder(orderId) {
  if (!DRY_RUN && trader && orderId) {
    try { await trader.cancelOrder(orderId); }
    catch (e) { log(`⚠️  cancel failed: ${e.message}`); }
  }
}
function takerFee(shares, price) {
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Bounded recovery sizing
// ─────────────────────────────────────────
function sharesForStep(step) {
  const raw = BASE_SHARES * Math.pow(RECOVERY_STEP_MULT, step);
  return Math.min(MAX_SHARES_CAP, round2(raw));
}
function applyRecoveryOutcome(p, profit) {
  if (profit >= 0) {
    if (p.recoveryStep !== 0) log(`♻️  ${p.symbol}: win — recovery step reset to 0 (was ${p.recoveryStep})`);
    p.recoveryStep = 0;
  } else {
    const before = p.recoveryStep;
    p.recoveryStep = Math.min(MAX_RECOVERY_STEPS, p.recoveryStep + 1);
    log(`♻️  ${p.symbol}: loss — recovery step ${before} → ${p.recoveryStep} (next size ${sharesForStep(p.recoveryStep)}sh)`);
  }
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshSideState() {
  return {
    positions: [], // { entryPrice, shares, cost, slPrice, exit:{kind:'TP'|'FINAL', price, orderId, status}, openedAt }
    wins: 0, losses: 0,
    realizedPnl: 0,
    rebatesEarned: 0,
    feesPaid: 0,
  };
}

function freshPairState(symbol) {
  return {
    symbol,
    tradable: false,
    windowStart: null,
    windowEnd: null,
    slug: null,
    eventTitle: null,
    conditionId: null,
    upTokenId: null,
    downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,

    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,

    recoveryStep: 0, // persists ACROSS windows — this is the recovery system's memory

    // per-window trading state (reset in loadPairWindow)
    sweepDone: false,
    tradedThisWindow: false,
    sides: { Up: freshSideState(), Down: freshSideState() },

    resolvedThisWindow: true,
    equityCurve: [{ t: Date.now(), equity: perPairCapital }],
  };
}

function resetPairs() {
  perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
  pairs = {};
  for (const sym of pairList) pairs[sym] = freshPairState(sym);
  totalEquityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];
}
resetPairs();

// ─────────────────────────────────────────
//  Slug / window math
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) {
  return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS;
}
function slugFor(symbol, windowStartSec) {
  return `${symbol.toLowerCase()}-updown-5m-${windowStartSec}`;
}
function qOf(m) { return (m.question || m.groupItemTitle || m.title || '').toLowerCase(); }
function parseMarketTokens(m) {
  try {
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
    const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}
function tokenIdForSide(market, side) {
  const tokens = parseMarketTokens(market);
  const want = (side || '').trim().toLowerCase();
  const tok = tokens.find(t => (t.outcome || '').toLowerCase() === want);
  return tok?.token_id || null;
}
async function fetchEventForWindow(symbol, windowStart) {
  for (const offset of SLUG_OFFSET_FALLBACKS) {
    const ws = windowStart + offset;
    if (ws + WINDOW_SECS <= nowSec()) continue;
    const slug = slugFor(symbol, ws);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) {
        return { event, windowStart: ws, slug };
      }
    } catch (_) { /* not indexed yet */ }
  }
  return null;
}

async function loadPairWindow(p) {
  const ws = currentWindowStart();
  if (p.windowStart === ws && p.upTokenId) return;

  const found = await fetchEventForWindow(p.symbol, ws);
  if (!found) { p.tradable = false; return; }
  const { event, windowStart, slug } = found;
  const market = event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];

  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) {
    log(`⚠️  ${p.symbol}: window loaded but Up/Down token ids missing`);
    p.tradable = false;
    return;
  }

  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.slug = slug;
  p.eventTitle = event.title || event.slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;
  p.resolvedThisWindow = false;

  // reset per-window trading state (recoveryStep is NOT reset — it persists across windows)
  p.sweepDone = false;
  p.tradedThisWindow = false;
  p.sides = { Up: freshSideState(), Down: freshSideState() };

  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | recovery step ${p.recoveryStep} (next size ${sharesForStep(p.recoveryStep)}sh)`);
}

// ─────────────────────────────────────────
//  Price feed
// ─────────────────────────────────────────
async function refreshPolyPrices() {
  const requests = [];
  for (const p of Object.values(pairs)) {
    if (!p.tradable || !p.upTokenId || !p.downTokenId) continue;
    requests.push({ token_id: p.upTokenId, side: 'BUY' });
    requests.push({ token_id: p.upTokenId, side: 'SELL' });
    requests.push({ token_id: p.downTokenId, side: 'BUY' });
    requests.push({ token_id: p.downTokenId, side: 'SELL' });
  }
  if (!requests.length) return;

  function applyPolyPrice(tid, side, price) {
    if (!Number.isFinite(price)) return;
    for (const p of Object.values(pairs)) {
      if (p.upTokenId === tid) { if (side === 'BUY') p.upAsk = price; else if (side === 'SELL') p.upBid = price; }
      else if (p.downTokenId === tid) { if (side === 'BUY') p.downAsk = price; else if (side === 'SELL') p.downBid = price; }
    }
  }

  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const side = (row.side || '').toUpperCase();
        const price = parseFloat(row.price);
        if (!tid || !Number.isFinite(price)) continue;
        applyPolyPrice(tid, side, price);
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (val && typeof val === 'object') {
          if (val.BUY != null) applyPolyPrice(tid, 'BUY', parseFloat(val.BUY));
          if (val.SELL != null) applyPolyPrice(tid, 'SELL', parseFloat(val.SELL));
          if (val.buy != null) applyPolyPrice(tid, 'BUY', parseFloat(val.buy));
          if (val.sell != null) applyPolyPrice(tid, 'SELL', parseFloat(val.sell));
        }
      }
    }
  } catch (e) {
    for (const p of Object.values(pairs)) {
      if (!p.tradable) continue;
      try {
        const [upAsk, upBid, downAsk, downBid] = await Promise.all([
          getJSON(`${CLOB}/price?token_id=${p.upTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${p.upTokenId}&side=SELL`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${p.downTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${p.downTokenId}&side=SELL`).catch(() => null),
        ]);
        if (upAsk) p.upAsk = parseFloat(upAsk.price || upAsk.mid || p.upAsk);
        if (upBid) p.upBid = parseFloat(upBid.price || upBid.mid || p.upBid);
        if (downAsk) p.downAsk = parseFloat(downAsk.price || downAsk.mid || p.downAsk);
        if (downBid) p.downBid = parseFloat(downBid.price || downBid.mid || p.downBid);
      } catch (_) { /* stale values, retry next tick */ }
    }
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function sideHeldShares(sideState) {
  return sideState.positions.reduce((s, pos) => s + pos.shares, 0);
}
function sideHeldCost(sideState) {
  return sideState.positions.reduce((s, pos) => s + pos.cost, 0);
}
function positionsMarkValue(p) {
  let total = 0;
  for (const side of ['Up', 'Down']) {
    const shares = sideHeldShares(p.sides[side]);
    if (shares <= 0) continue;
    const bid = side === 'Up' ? p.upBid : p.downBid;
    const cost = sideHeldCost(p.sides[side]);
    const price = bid ?? (cost / shares);
    total += shares * price;
  }
  return round2(total);
}
function pairMarkValue(p) {
  return round2(p.bankroll + positionsMarkValue(p));
}
function pushGlobalEquity() {
  const total = round2(Object.values(pairs).reduce((s, p) => s + pairMarkValue(p), 0));
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > 500) totalEquityCurve.shift();
}
function recordEquity(p) {
  p.equityCurve.push({ t: Date.now(), equity: pairMarkValue(p) });
  if (p.equityCurve.length > 300) p.equityCurve.shift();
  pushGlobalEquity();
}
function registerTrade(p, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: p.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

function midPrice(ask, bid) {
  if (ask != null && bid != null) return round2((ask + bid) / 2);
  if (ask != null) return round2(ask);
  if (bid != null) return round2(bid);
  return null;
}

// ─────────────────────────────────────────
//  Entry — one shot per window: buy whichever side is leading
//  (higher bid), sized by the pair's current recovery step.
// ─────────────────────────────────────────
async function maybeFireEntry(p, elapsed) {
  if (p.tradedThisWindow) return;
  if (elapsed < ENTRY_DELAY_SECS || elapsed >= ENTRY_CUTOFF_SECS) return;
  if (p.upBid == null || p.downBid == null) return;

  const side = p.upBid >= p.downBid ? 'Up' : 'Down';
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) return;
  if (ask < ENTRY_ZONE_MIN || ask > ENTRY_ZONE_MAX) return; // keep checking next tick — price may move into zone

  const shares = sharesForStep(p.recoveryStep);
  const price = round2(ask); // cross the spread — this is a one-shot directional entry, not a passive maker order
  const cost = round2(price * shares);
  const fee = takerFee(shares, price);
  const totalCost = round2(cost + fee);

  if (totalCost > p.bankroll) {
    log(`⏭️  ${p.symbol} ${side}: skip entry — insufficient bankroll ($${p.bankroll.toFixed(2)}, need $${totalCost.toFixed(2)})`);
    p.tradedThisWindow = true; // don't keep retrying this window if bankroll can't cover it
    return;
  }

  const tpPrice = round2(clamp(price + TP_OFFSET, 0.01, 0.99));
  const slPrice = round2(clamp(price - SL_OFFSET, 0.01, 0.99));

  const s = p.sides[side];
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;

  p.bankroll = round2(p.bankroll - totalCost);
  p.feesPaid = round2(p.feesPaid + fee);
  s.feesPaid = round2(s.feesPaid + fee);
  p.tradedThisWindow = true;

  const tpOrder = await placeLimitSell(tokenId, tpPrice, shares);
  s.positions.push({
    entryPrice: price, shares, cost: totalCost, slPrice,
    exit: { kind: 'TP', price: tpPrice, orderId: tpOrder.id || tpOrder.orderId || null, status: 'resting' },
    openedAt: Date.now(),
  });

  log(`🎯 ${p.symbol}: ${side} leading (bid ${(side==='Up'?p.upBid:p.downBid).toFixed(2)}) — BUY ${shares}sh @ ${price.toFixed(2)} [recovery step ${p.recoveryStep}] | TP ${tpPrice.toFixed(2)} / SL ${slPrice.toFixed(2)}`);
  registerTrade(p, { side: 'BUY', outcome: side, reason: 'ENTRY', price, shares, cost: totalCost, fee });
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Position exit checking — TP (resting maker) or SL (immediate taker)
// ─────────────────────────────────────────
async function checkPositionExits(p, side) {
  const s = p.sides[side];
  if (!s.positions.length) return;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;

  const stillOpen = [];
  for (const pos of s.positions) {
    if (pos.exit.status !== 'resting') { stillOpen.push(pos); continue; }

    if (pos.exit.kind === 'TP' && bid <= pos.slPrice) {
      await cancelOrder(pos.exit.orderId);
      const proceeds = round2(bid * pos.shares);
      const fee = takerFee(pos.shares, bid);
      const net = round2(proceeds - fee);
      p.bankroll = round2(p.bankroll + net);
      p.feesPaid = round2(p.feesPaid + fee);
      const profit = round2(net - pos.cost);
      p.realizedPnl = round2(p.realizedPnl + profit);
      s.realizedPnl = round2(s.realizedPnl + profit);
      s.feesPaid = round2(s.feesPaid + fee);
      if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }
      pos.exit.status = 'filled';

      log(`🛑 ${p.symbol} ${side} SL hit @ ${bid.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}, stop ${pos.slPrice.toFixed(2)}) | ${pos.shares}sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { side: 'SELL', outcome: side, reason: 'SL', price: bid, shares: pos.shares, profit, fee });
      applyRecoveryOutcome(p, profit);
      recordEquity(p);
      continue;
    }

    if (pos.exit.kind === 'TP' && bid >= pos.exit.price) {
      const proceeds = round2(pos.exit.price * pos.shares);
      const rebate = makerRebate(pos.shares, pos.exit.price);
      const net = round2(proceeds + rebate);
      p.bankroll = round2(p.bankroll + net);
      const profit = round2(net - pos.cost);
      p.realizedPnl = round2(p.realizedPnl + profit);
      p.rebatesEarned = round2(p.rebatesEarned + rebate);
      s.realizedPnl = round2(s.realizedPnl + profit);
      s.rebatesEarned = round2(s.rebatesEarned + rebate);
      if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }
      pos.exit.status = 'filled';

      log(`💰 ${p.symbol} ${side} TP filled ${pos.shares}sh @ ${pos.exit.price.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}) | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { side: 'SELL', outcome: side, reason: 'TP', price: pos.exit.price, shares: pos.shares, profit, rebate });
      applyRecoveryOutcome(p, profit);
      recordEquity(p);
      continue;
    }

    stillOpen.push(pos);
  }
  s.positions = stillOpen;
}

// ─────────────────────────────────────────
//  285s sweep: cancel unfilled TP, roll remainder into 0.99 sell
// ─────────────────────────────────────────
async function maybeSweep(p, elapsed) {
  if (p.sweepDone || elapsed < SWEEP_SECS) return;
  p.sweepDone = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];

    let sweepShares = 0, sweepCost = 0;
    const kept = [];
    for (const pos of s.positions) {
      if (pos.exit.status === 'resting') {
        await cancelOrder(pos.exit.orderId);
        sweepShares += pos.shares;
        sweepCost = round2(sweepCost + pos.cost);
      } else {
        kept.push(pos);
      }
    }
    s.positions = kept;

    if (sweepShares > 0) {
      const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
      const order = await placeLimitSell(tokenId, FINAL_SELL_PRICE, sweepShares);
      s.positions.push({
        entryPrice: round2(sweepCost / sweepShares), shares: sweepShares, cost: sweepCost, slPrice: 0,
        exit: { kind: 'FINAL', price: FINAL_SELL_PRICE, orderId: order.id || order.orderId || null, status: 'resting' },
        openedAt: Date.now(),
      });
      log(`🎯 ${p.symbol} ${side}: cancelled pending TP, resting FINAL SELL @ ${FINAL_SELL_PRICE} for ${sweepShares}sh`);
    }
  }
}

// ─────────────────────────────────────────
//  Window resolution
// ─────────────────────────────────────────
async function determineWinningSide(p) {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(p.slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === p.conditionId) || (event.markets || [])[0];
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const winner = (outcomes[bestI] || '').trim();
      if (winner) return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
    }
  } catch (_) { /* fall through */ }
  if (p.upBid != null && p.downBid != null) return p.upBid >= p.downBid ? 'Up' : 'Down';
  return null;
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    for (const pos of s.positions) {
      if (pos.exit.status === 'resting') {
        await cancelOrder(pos.exit.orderId);
        log(`🛑 ${p.symbol} ${side}: unfilled ${pos.exit.kind} cancelled at window close — resolving instead`);
      }
    }
  }

  const anyPosition = ['Up', 'Down'].some(s => sideHeldShares(p.sides[s]) > 0);
  if (!anyPosition) return;

  const winner = await determineWinningSide(p);
  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    const shares = sideHeldShares(s);
    if (shares <= 0) continue;
    const cost = sideHeldCost(s);
    const won = winner === side;
    const proceeds = won ? round2(shares * 1) : 0;
    const profit = round2(proceeds - cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    s.realizedPnl = round2(s.realizedPnl + profit);
    if (won) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION ${side} ${shares}sh cost=$${cost.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: 'RESOLUTION', price: won ? 1 : 0, shares, profit });
    applyRecoveryOutcome(p, profit);
    s.positions = [];
  }
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Main per-pair tick
// ─────────────────────────────────────────
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable) return;
  if (!tradingEnabled) return;

  const elapsed = nowSec() - p.windowStart;

  for (const side of ['Up', 'Down']) await checkPositionExits(p, side);
  await maybeFireEntry(p, elapsed);

  await maybeSweep(p, elapsed);

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state — full detail per side for dashboard observation
// ─────────────────────────────────────────
function sideSummary(p, side) {
  const s = p.sides[side];
  const openPositions = s.positions
    .filter(pos => pos.exit.status === 'resting')
    .map(pos => ({
      entryPrice: pos.entryPrice, shares: pos.shares, cost: pos.cost,
      tpPrice: pos.exit.kind === 'TP' ? pos.exit.price : null,
      slPrice: pos.slPrice || null,
      kind: pos.exit.kind,
    }));

  return {
    openPositions,
    heldShares: sideHeldShares(s),
    heldCost: sideHeldCost(s),
    wins: s.wins,
    losses: s.losses,
    realizedPnl: s.realizedPnl,
    rebatesEarned: s.rebatesEarned,
    feesPaid: s.feesPaid,
  };
}

function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(positionsMarkValue(p) - (sideHeldCost(p.sides.Up) + sideHeldCost(p.sides.Down)));
    const markValue = pairMarkValue(p);
    const elapsed = p.windowStart != null ? Math.max(0, nowSec() - p.windowStart) : null;
    let phase = '—';
    if (p.tradable && elapsed != null) {
      phase = elapsed >= SWEEP_SECS ? 'SWEPT / RESOLVING' : (elapsed >= ENTRY_CUTOFF_SECS ? 'NO NEW ENTRIES' : (p.tradedThisWindow ? 'TRADED THIS WINDOW' : 'WAITING FOR ENTRY'));
    }
    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      eventTitle: p.eventTitle,
      windowEnd: p.windowEnd,
      elapsedSecs: elapsed != null ? Math.floor(elapsed) : null,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      phase,
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      recoveryStep: p.recoveryStep,
      maxRecoverySteps: MAX_RECOVERY_STEPS,
      nextTradeShares: sharesForStep(p.recoveryStep),
      tradedThisWindow: p.tradedThisWindow,
      sides: { Up: sideSummary(p, 'Up'), Down: sideSummary(p, 'Down') },
      equityCurve: p.equityCurve,
    };
  });

  const totalBankroll = round2(pairStates.reduce((s, p) => s + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((s, p) => s + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((s, p) => s + p.realizedPnl, 0));
  const totalUnrealized = round2(pairStates.reduce((s, p) => s + p.unrealizedPnl, 0));
  const totalWins = pairStates.reduce((s, p) => s + p.wins, 0);
  const totalLosses = pairStates.reduce((s, p) => s + p.losses, 0);
  const totalFeesPaid = round2(pairStates.reduce((s, p) => s + p.feesPaid, 0));
  const totalRebatesEarned = round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0));

  return {
    dryRun: DRY_RUN,
    tradingEnabled,
    pairs: pairList,
    totalCapital: TOTAL_CAPITAL,
    perPairCapital,
    totalBankroll,
    totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized,
    totalUnrealizedPnl: totalUnrealized,
    totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid,
    totalRebatesEarned,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      entryDelaySecs: ENTRY_DELAY_SECS,
      entryZoneMin: ENTRY_ZONE_MIN,
      entryZoneMax: ENTRY_ZONE_MAX,
      entryCutoffSecs: ENTRY_CUTOFF_SECS,
      sweepSecs: SWEEP_SECS,
      finalSellPrice: FINAL_SELL_PRICE,
      tpOffset: TP_OFFSET,
      slOffset: SL_OFFSET,
      baseShares: BASE_SHARES,
      recoveryStepMult: RECOVERY_STEP_MULT,
      maxRecoverySteps: MAX_RECOVERY_STEPS,
      maxSharesCap: MAX_SHARES_CAP,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates,
    totalEquityCurve,
    logs: logs.slice(-120),
    trades: trades.slice(-100).reverse(),
  };
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
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) {
        lastPolyPriceFetch = now;
        await refreshPolyPrices();
      }
      for (const p of Object.values(pairs)) {
        try { await processPair(p); } catch (e) { log(`⚠️  ${p.symbol} tick error: ${e.message}`); }
      }
      emitFn('state', buildState());
    } catch (e) {
      log(`⚠️  Loop error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  Public controls
// ─────────────────────────────────────────
function setPairs(list) {
  const clean = (list || []).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!clean.length) return { ok: false, error: 'Empty pair list' };
  pairList = [...new Set(clean)];
  resetPairs();
  log(`⚙️  Pairs updated: ${pairList.join(', ')} | $${perPairCapital.toFixed(2)} per pair`);
  return { ok: true, pairs: pairList, perPairCapital };
}
function pauseTrading() {
  tradingEnabled = false;
  log('⏸️  Trading paused (open positions still managed for TP/SL/sweep/resolution)');
  return { ok: true };
}
function resumeTrading() {
  tradingEnabled = true;
  log('▶️  Trading resumed');
  return { ok: true };
}
function getStatus() { return { ok: true, ...buildState() }; }

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 5-Minute BTC Up/Down — Momentum-Leader Entry + Bounded Recovery Sizing`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pair(s) (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  One entry per window: after ${ENTRY_DELAY_SECS}s, buy whichever side leads (higher bid) if its ask is in [${ENTRY_ZONE_MIN.toFixed(2)}-${ENTRY_ZONE_MAX.toFixed(2)}]`);
  log(`⚙️  TP +${TP_OFFSET} / SL -${SL_OFFSET} around entry — deliberately asymmetric so real (post-fee) R:R lands near 1:1, not the naive nominal ratio`);
  log(`⚙️  Recovery sizing: ${BASE_SHARES}sh base, x${RECOVERY_STEP_MULT} per consecutive loss, capped at ${MAX_RECOVERY_STEPS} steps (max ${sharesForStep(MAX_RECOVERY_STEPS)}sh) — any win resets to base. Persists across windows.`);
  log(`⚙️  At ${SWEEP_SECS}s: cancel unfilled TP, roll remainder into one @ ${FINAL_SELL_PRICE} sell per side | unfilled at close resolves to actual outcome`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
