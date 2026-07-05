'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — FIXED-PRICE LADDER SCALPER
 * ═══════════════════════════════════════════════════════════════
 *
 *  Up and Down each run their own completely independent ladder
 *  within the same 5-minute window. Nothing about Up's fills/prices
 *  affects Down's orders or vice versa.
 *
 *  THE LADDER (per side, built fresh at the start of every window):
 *    Fixed, absolute price rungs — NOT relative to the live mid
 *    price — from 0.05 up to 0.50 in 0.05 steps:
 *      0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50
 *    Each rung is a maker limit BUY for a fixed size (default 50
 *    shares). All rungs a side can afford are placed up front and
 *    left resting untouched — they are never re-pegged.
 *
 *  ONE-SHOT RUNGS: each price level trades at most once per window.
 *    - Once a rung's buy fills, that exact price is retired for the
 *      rest of the window — it is never re-armed even if price comes
 *      back to it.
 *    - The instant a rung's buy fills, a maker limit SELL (TP) is
 *      rested at the fixed take-profit price of 0.70 for that lot.
 *    - If that TP later fills, the rung is fully done (paused) for
 *      the rest of the window.
 *
 *  AT 280s (ENTRY_CUTOFF_SECS): stop entries for good, per side —
 *    - Any rung that never got placed (was skipped for bankroll
 *      reasons) is marked paused — it will not be placed later in
 *      this window.
 *    - Any rung still resting unfilled is cancelled and paused.
 *    - Rungs that already filled and are sitting on a resting TP are
 *      left completely alone — no sweep, no early exit.
 *
 *  RESOLUTION (window close): any TP still unfilled at window end is
 *  cancelled and that position resolves against Polymarket's actual
 *  outcome — $1/share if that side won, $0/share if it lost.
 *
 *  SIZING: fixed shares per rung, both sides, always — no
 *  compounding, no bankroll-based up-sizing.
 *
 *  FEES: every buy and every TP sell are genuine maker orders
 *  (fee-free + rebate, Fee Structure V2). There is no taker order
 *  anywhere in this strategy.
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

// ── Ladder scalper parameters ──
const LADDER_MIN        = Number(process.env.LADDER_MIN || 0.05);   // lowest rung price
const LADDER_MAX        = Number(process.env.LADDER_MAX || 0.50);   // highest rung price
const LADDER_STEP       = Number(process.env.LADDER_STEP || 0.05);  // distance between rungs
const TP_PRICE          = Number(process.env.TP_PRICE || 0.70);     // fixed TP for every rung, every side
const FIXED_SHARES      = Number(process.env.FIXED_SHARES || 50);   // shares per rung
const ENTRY_CUTOFF_SECS = Number(process.env.ENTRY_CUTOFF_SECS || 280); // cancel/pause unfilled rungs after this

// Builds the fixed absolute-price ladder once, ascending, e.g.
// [0.05, 0.10, 0.15, ..., 0.45, 0.50]. These are NOT relative to mid
// price — every window gets the exact same grid of rungs per side.
function buildLadderPrices() {
  const prices = [];
  const steps = Math.round((LADDER_MAX - LADDER_MIN) / LADDER_STEP);
  for (let i = 0; i <= steps; i++) prices.push(Math.round((LADDER_MIN + i * LADDER_STEP) * 100) / 100);
  return prices;
}
const LADDER_PRICES = buildLadderPrices();

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

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-side-scalper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-side-scalper/1.0' },
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
//  Pair state
// ─────────────────────────────────────────
function freshSideState() {
  return {
    // One entry per ladder price, built fresh every window. Each rung's
    // status is a one-way progression (except 'cancelled' can be reached
    // from either 'pending' or 'resting'):
    //   pending    → never yet placed (bankroll not available, or not yet tried)
    //   resting    → maker BUY live on the book, unfilled
    //   filled     → BUY filled, TP resting @ TP_PRICE, position open
    //   done       → TP filled — rung fully closed, retired for the window
    //   cancelled  → paused at the 280s cutoff (never traded again this window)
    //   resolved   → still holding at window close, settled at actual outcome
    ladder: LADDER_PRICES.map(price => ({
      price, status: 'pending', orderId: null, shares: 0, cost: 0, placedAt: null, tp: null,
    })),
    cutoffDone: false,
  };
}

function freshRungStats() {
  const stats = {};
  for (const price of LADDER_PRICES) {
    stats[price.toFixed(2)] = { fills: 0, tpWins: 0, resolvedWins: 0, resolvedLosses: 0, totalCost: 0, totalPnl: 0 };
  }
  return stats;
}

function recordRungFill(p, price, cost, entryRebate) {
  const r = p.rungStats[price.toFixed(2)];
  if (!r) return;
  r.fills++;
  r.totalCost = round2(r.totalCost + cost);
  r.totalPnl = round2(r.totalPnl + (entryRebate || 0));
}

// Records the outcome of one closed rung (win via TP bounce, win via
// resolution without ever bouncing, or loss via resolution) into this pair's
// lifetime-persistent per-price-level edge stats. Never reset on window
// rollover — this is what answers "is there an actual edge at this price".
function recordRungOutcome(p, price, outcome, cost, pnl) {
  const key = price.toFixed(2);
  const r = p.rungStats[key];
  if (!r) return;
  if (outcome === 'tp') r.tpWins++;
  else if (outcome === 'resolved-win') r.resolvedWins++;
  else if (outcome === 'resolved-loss') r.resolvedLosses++;
  r.totalPnl = round2(r.totalPnl + pnl);
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

    // per-window trading state (reset in loadPairWindow)
    sides: { Up: freshSideState(), Down: freshSideState() },

    // lifetime, NEVER reset — per-ladder-price edge tracking
    rungStats: freshRungStats(),

    resolvedThisWindow: true,
    resolving: false,
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
async function fetchEventForWindow(symbol, windowStart, offsets = SLUG_OFFSET_FALLBACKS) {
  for (const offset of offsets) {
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

  // Hard safety net: NEVER wipe this pair's per-window ladder state while any
  // rung is still 'filled' (bought, TP not yet hit) — no matter which code
  // path got us here (normal rollover, a fallback slug re-match, or this
  // pair just now becoming tradable again after a gap). Resolve first, always.
  if (p.upTokenId && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }

  // Only the very first load for this pair (process just started, nothing to
  // lose) is allowed to search neighboring windows. A normal rollover must
  // match the exact expected next window (offset 0) — if it isn't indexed by
  // Polymarket yet, we simply stay non-tradable for a tick or two rather than
  // risk re-attaching to the window we just resolved and closed out.
  const isBootstrap = p.windowStart === null;
  const found = await fetchEventForWindow(p.symbol, ws, isBootstrap ? SLUG_OFFSET_FALLBACKS : [0]);
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

  // reset per-window trading state — safe now: anything still open from the
  // prior window was just resolved above, if there was a prior window at all.
  p.sides = { Up: freshSideState(), Down: freshSideState() };

  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z`);
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
  return sideState.ladder.filter(r => r.status === 'filled').reduce((s, r) => s + r.shares, 0);
}
function sideHeldCost(sideState) {
  return sideState.ladder.filter(r => r.status === 'filled').reduce((s, r) => s + r.cost, 0);
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

// ─────────────────────────────────────────
//  Buy-order placement (independent per side)
// ─────────────────────────────────────────
function reservedCashFor(p) {
  let total = 0;
  for (const side of ['Up', 'Down']) {
    for (const rung of p.sides[side].ladder) if (rung.status === 'resting') total += rung.cost;
  }
  return round2(total);
}

// Before the 280s cutoff: try to place every rung still in 'pending' status
// (one maker limit BUY per rung, at that rung's fixed price — never
// re-pegged to mid). A rung that can't be afforded right now is left
// 'pending' and retried on later ticks, up until the cutoff.
//
// At/after the 280s cutoff (run once per side, guarded by cutoffDone):
//   - any rung still 'pending' (never placed) → marked 'cancelled' (paused)
//   - any rung still 'resting' (unfilled) → order cancelled → 'cancelled'
// Rungs already 'filled' (holding shares, TP resting) are left completely
// alone — they ride their TP all the way to window resolution.
async function tickLadder(p, side, elapsed) {
  const s = p.sides[side];

  if (elapsed >= ENTRY_CUTOFF_SECS) {
    if (s.cutoffDone) return;
    s.cutoffDone = true;
    let pausedPending = 0, cancelledResting = 0;
    for (const rung of s.ladder) {
      if (rung.status === 'pending') { rung.status = 'cancelled'; pausedPending++; }
      else if (rung.status === 'resting') { await cancelOrder(rung.orderId); rung.status = 'cancelled'; cancelledResting++; }
    }
    if (pausedPending || cancelledResting) {
      log(`🛑 ${p.symbol} ${side}: entry cutoff @ ${ENTRY_CUTOFF_SECS}s — cancelled ${cancelledResting} resting rung(s), paused ${pausedPending} unplaced rung(s). Open TP position(s) left resting to window close.`);
    }
    return;
  }

  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  for (const rung of s.ladder) {
    if (rung.status !== 'pending') continue;

    const cost = round2(rung.price * FIXED_SHARES);
    const reserved = reservedCashFor(p);
    if (round2(reserved + cost) > p.bankroll) continue; // retry next tick

    const order = await placeLimitBuy(tokenId, rung.price, FIXED_SHARES);
    rung.orderId = order.id || order.orderId || null;
    rung.shares = FIXED_SHARES;
    rung.cost = cost;
    rung.placedAt = Date.now();
    rung.status = 'resting';
    log(`📥 ${p.symbol} ${side}: ladder BUY resting ${FIXED_SHARES}sh @ ${rung.price.toFixed(2)}`);
  }
}

// ─────────────────────────────────────────
//  Ladder buy-fill checking — on fill: rest TP @ TP_PRICE, rung → 'filled'
// ─────────────────────────────────────────
async function checkLadderBuyFills(p, side) {
  const s = p.sides[side];
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) return;
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;

  for (const rung of s.ladder) {
    if (rung.status !== 'resting') continue;
    if (ask > rung.price) continue; // not filled yet

    const rebate = makerRebate(rung.shares, rung.price);
    p.bankroll = round2(p.bankroll - rung.cost + rebate);
    p.realizedPnl = round2(p.realizedPnl + rebate);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);

    const tpOrder = await placeLimitSell(tokenId, TP_PRICE, rung.shares);
    rung.tp = { price: TP_PRICE, orderId: tpOrder.id || tpOrder.orderId || null, status: 'resting' };
    rung.status = 'filled';
    recordRungFill(p, rung.price, rung.cost, rebate);

    log(`🎯 ${p.symbol} ${side} ladder BUY filled ${rung.shares}sh @ ${rung.price.toFixed(2)} | cost=$${rung.cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP resting @ ${TP_PRICE.toFixed(2)} | rung ${rung.price.toFixed(2)} retired for this window`);
    registerTrade(p, { side: 'BUY', outcome: side, reason: 'ENTRY', price: rung.price, shares: rung.shares, cost: rung.cost, rebate });
    recordEquity(p);
  }
}

// ─────────────────────────────────────────
//  Ladder TP-fill checking — on fill: rung → 'done', permanently retired
// ─────────────────────────────────────────
async function checkLadderTpFills(p, side) {
  const s = p.sides[side];
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;

  for (const rung of s.ladder) {
    if (rung.status !== 'filled' || !rung.tp || rung.tp.status !== 'resting') continue;
    if (bid < rung.tp.price) continue; // TP not filled yet

    const proceeds = round2(rung.tp.price * rung.shares);
    const rebate = makerRebate(rung.shares, rung.tp.price);
    const net = round2(proceeds + rebate);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - rung.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    p.wins++;
    rung.tp.status = 'filled';
    rung.status = 'done';
    recordRungOutcome(p, rung.price, 'tp', rung.cost, profit);

    log(`💰 ${p.symbol} ${side} ladder TP filled ${rung.shares}sh @ ${rung.tp.price.toFixed(2)} (entry ${rung.price.toFixed(2)}) | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)} | rung ${rung.price.toFixed(2)} done — paused for rest of window`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: 'TP', price: rung.tp.price, shares: rung.shares, profit, rebate });
    recordEquity(p);
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
  if (p.resolvedThisWindow || p.resolving) return;
  p.resolving = true;
  try {
    // Safety net only — the 280s cutoff should already have cleared these,
    // but if a window ends unexpectedly early, don't leave dangling orders.
    for (const side of ['Up', 'Down']) {
      const s = p.sides[side];
      for (const rung of s.ladder) {
        if (rung.status === 'resting') { await cancelOrder(rung.orderId); rung.status = 'cancelled'; log(`🛑 ${p.symbol} ${side}: unfilled ladder BUY @ ${rung.price.toFixed(2)} cancelled at window close`); }
        else if (rung.status === 'pending') { rung.status = 'cancelled'; }
      }
    }

    const anyOpen = ['Up', 'Down'].some(side => p.sides[side].ladder.some(r => r.status === 'filled'));
    if (anyOpen) {
      const winner = await determineWinningSide(p);
      for (const side of ['Up', 'Down']) {
        const s = p.sides[side];
        for (const rung of s.ladder) {
          if (rung.status !== 'filled') continue;

          if (rung.tp && rung.tp.status === 'resting') {
            await cancelOrder(rung.tp.orderId);
            log(`🛑 ${p.symbol} ${side}: unfilled TP @ ${rung.tp.price.toFixed(2)} (ladder ${rung.price.toFixed(2)}) cancelled at window close — resolving instead`);
          }

          const won = winner === side;
          const proceeds = won ? round2(rung.shares * 1) : 0;
          const profit = round2(proceeds - rung.cost);
          p.bankroll = round2(p.bankroll + proceeds);
          p.realizedPnl = round2(p.realizedPnl + profit);
          if (won) p.wins++; else p.losses++;
          const icon = won ? '💰' : '💥';
          log(`${icon} ${p.symbol} RESOLUTION ${side} ladder@${rung.price.toFixed(2)} ${rung.shares}sh cost=$${rung.cost.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
          registerTrade(p, { side: 'SELL', outcome: side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: rung.shares, profit });
          rung.status = 'resolved';
          recordRungOutcome(p, rung.price, won ? 'resolved-win' : 'resolved-loss', rung.cost, profit);
        }
      }
      recordEquity(p);
    }

    // Only mark this window fully resolved once every open rung above has
    // actually been settled — if anything threw partway through, we fall
    // into the catch below and resolvedThisWindow stays false, so the very
    // next tick retries resolution instead of silently losing the position.
    p.resolvedThisWindow = true;

    // Clear the ladder the instant resolution finishes — do NOT wait for
    // loadPairWindow() to (maybe) find the next window's market first.
    // Previously the ladder was only reset once the new window's event was
    // successfully fetched from Gamma; if that fetch failed or wasn't
    // indexed yet (common right at the window boundary), the just-resolved
    // rungs — and their stale, already-expired windowEnd countdown — kept
    // rendering in the dashboard as if they belonged to the live window.
    // Resetting here means there's a clean, empty ladder the whole time
    // we're waiting to attach to the next window, with no gap where old
    // positions can leak forward.
    p.sides = { Up: freshSideState(), Down: freshSideState() };
    p.tradable = false;
  } catch (e) {
    log(`❌ ${p.symbol}: resolvePairWindow error — ${e.message}. Will retry next tick; no positions marked resolved yet.`);
  } finally {
    p.resolving = false;
  }
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

  for (const side of ['Up', 'Down']) {
    await checkLadderBuyFills(p, side);
    await checkLadderTpFills(p, side);
    await tickLadder(p, side, elapsed); // places pending rungs pre-280s, pauses/cancels at 280s
  }

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function sideSummary(p, side) {
  const s = p.sides[side];
  const ladder = s.ladder.slice().sort((a, b) => b.price - a.price).map(r => ({
    price: r.price, status: r.status, shares: r.shares, cost: r.cost,
    tpPrice: r.tp ? r.tp.price : null, tpStatus: r.tp ? r.tp.status : null,
  }));

  const pendingCount   = s.ladder.filter(r => r.status === 'pending').length;
  const restingCount   = s.ladder.filter(r => r.status === 'resting').length;
  const openCount      = s.ladder.filter(r => r.status === 'filled').length;   // holding, TP resting
  const doneCount      = s.ladder.filter(r => r.status === 'done').length;     // TP hit — retired
  const cancelledCount = s.ladder.filter(r => r.status === 'cancelled').length; // paused at cutoff
  const resolvedCount  = s.ladder.filter(r => r.status === 'resolved').length; // settled at window close

  const restingCost = round2(s.ladder.filter(r => r.status === 'resting').reduce((a, r) => a + r.cost, 0));

  return {
    ladder,
    ladderSize: s.ladder.length,
    pendingCount, restingCount, openCount, doneCount, cancelledCount, resolvedCount,
    restingCost,
    heldShares: sideHeldShares(s),
    heldCost: sideHeldCost(s),
    cutoffDone: !!s.cutoffDone,
  };
}

// Combines every pair's lifetime per-price-level stats into one table, sorted
// high-to-low price. This is the actual "is there an edge" answer: for each
// rung price, how many times it filled, what fraction of those eventually
// won (via TP bounce or outright resolution) vs lost outright at $0, and the
// realized dollar expectancy per fill and per dollar risked at that price.
function aggregateRungStats() {
  const agg = {};
  for (const price of LADDER_PRICES) {
    agg[price.toFixed(2)] = { price, fills: 0, tpWins: 0, resolvedWins: 0, resolvedLosses: 0, totalCost: 0, totalPnl: 0 };
  }
  for (const p of Object.values(pairs)) {
    for (const price of LADDER_PRICES) {
      const key = price.toFixed(2);
      const rs = p.rungStats[key];
      if (!rs) continue;
      const a = agg[key];
      a.fills += rs.fills;
      a.tpWins += rs.tpWins;
      a.resolvedWins += rs.resolvedWins;
      a.resolvedLosses += rs.resolvedLosses;
      a.totalCost = round2(a.totalCost + rs.totalCost);
      a.totalPnl = round2(a.totalPnl + rs.totalPnl);
    }
  }
  return Object.values(agg)
    .map(r => {
      const closed = r.tpWins + r.resolvedWins + r.resolvedLosses; // fills with a known final outcome
      const wins = r.tpWins + r.resolvedWins;
      return {
        price: r.price,
        fills: r.fills,
        openCount: Math.max(0, r.fills - closed), // still holding, outcome not yet known
        tpWins: r.tpWins,
        resolvedWins: r.resolvedWins,
        resolvedLosses: r.resolvedLosses,
        winRate: closed > 0 ? round2((wins / closed) * 100) : null,
        totalCost: r.totalCost,
        totalPnl: r.totalPnl,
        avgPnlPerFill: r.fills > 0 ? round2(r.totalPnl / r.fills) : null,
        roiPct: r.totalCost > 0 ? round2((r.totalPnl / r.totalCost) * 100) : null,
      };
    })
    .sort((a, b) => b.price - a.price);
}

function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(positionsMarkValue(p) - (sideHeldCost(p.sides.Up) + sideHeldCost(p.sides.Down)));
    const markValue = pairMarkValue(p);
    const elapsed = p.windowStart != null ? Math.max(0, nowSec() - p.windowStart) : null;
    let phase = '—';
    if (p.tradable && elapsed != null) {
      phase = elapsed >= ENTRY_CUTOFF_SECS ? 'CUTOFF/HOLDING' : 'LADDER OPEN';
    }
    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      windowEnd: p.windowEnd,
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
      ladderMin: LADDER_MIN,
      ladderMax: LADDER_MAX,
      ladderStep: LADDER_STEP,
      ladderPrices: LADDER_PRICES,
      tpPrice: TP_PRICE,
      fixedShares: FIXED_SHARES,
      entryCutoffSecs: ENTRY_CUTOFF_SECS,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates,
    totalEquityCurve,
    rungStats: aggregateRungStats(),
    logs: logs.slice(-100),
    trades: trades.slice(-80).reverse(),
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
  log('⏸️  Trading paused (open/pending orders still managed for fills/TP/resolution)');
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
  log(`🚀 5-Minute BTC Up/Down — Fixed-Price Ladder Scalper`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pair(s) (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Ladder (per side, both Up & Down): ${LADDER_PRICES.map(p => p.toFixed(2)).join(', ')} — ${FIXED_SHARES}sh per rung, fixed absolute prices, never re-pegged`);
  log(`⚙️  Each rung trades once per window: BUY fills → TP rests @ ${TP_PRICE.toFixed(2)} → if TP fills, rung is done and paused for the rest of the window`);
  log(`⚙️  At ${ENTRY_CUTOFF_SECS}s: any unplaced or unfilled rung is cancelled and paused for the rest of the window. Open TP positions ride untouched to window close.`);
  log(`⚙️  Unfilled TP at window close → resolves to actual outcome ($1/sh win, $0/sh loss)`);
  log(`⚙️  fees: all buys + TP sells are maker (0 fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate) | no taker orders in this strategy`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
