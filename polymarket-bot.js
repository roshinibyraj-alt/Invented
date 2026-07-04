'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — TWO-PHASE LADDER BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  Completely replaces the old flip/recovery martingale strategy.
 *  No deficit ledger, no flips, no fixed entry-trigger price.
 *
 *  PER WINDOW (BTC 5-minute Up/Down), timed from window open (t=0):
 *
 *  PHASE 1 — seconds 0..120, every 15s (9 ticks: 0,15,30,...,120):
 *    At each tick, look at current Up/Down mid prices RIGHT NOW and
 *    place a resting maker limit BUY on whichever side is currently
 *    CHEAPER, at that side's mid price, for `10 * compounding` shares.
 *    Side is re-evaluated fresh every tick — Phase 1 buys can end up
 *    split across Up and Down if the cheaper side flips mid-phase.
 *
 *  PHASE 2 — seconds 135..255, every 15s (9 ticks: 135,150,...,255):
 *    Same mechanic, but targets whichever side is currently the
 *    EXPENSIVE one, at mid price, for `20 * compounding` shares.
 *
 *  Ticks never cancel/replace a prior tick's still-resting order —
 *  orders simply accumulate as a ladder (up to 18 resting/filled buy
 *  orders per window, 9 from each phase).
 *
 *  AT t=280s: for every side that has any filled shares, place one
 *  aggregated resting maker limit SELL (take-profit) at 0.99 for the
 *  full filled quantity on that side.
 *
 *  AT WINDOW CLOSE: any shares that never hit the 0.99 TP (whole
 *  position, since it's one order per side) are settled at actual
 *  Polymarket resolution — $1/share if that side won, $0 if it lost.
 *  Any entry orders that never filled are simply cancelled (no cost).
 *
 *  COMPOUNDING: order size scales with cumulative realized profit
 *  on the pair:
 *      compounding = 1 + (realizedPnl / startingCapital)
 *      shares      = baseShares(10 or 20) * compounding
 *  `realizedPnl` and `startingCapital` persist across windows (not
 *  reset each window) — only orders/positions/schedule reset fresh
 *  each new window.
 *
 *  FEES (Polymarket Fee Structure V2, crypto: taker fee = shares *
 *  0.07 * price * (1-price), maker rebate = that * 20%): every order
 *  in this strategy — every laddered entry buy AND the TP sell — is
 *  a genuine resting maker order, so every fill earns a rebate and
 *  there are no taker fees anywhere. Resolution settlement is always
 *  fee-free.
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

// ── Ladder schedule (all in seconds from window open) ──
const LADDER_INTERVAL_S = Number(process.env.LADDER_INTERVAL_S || 15);
const PHASE1_START_S    = Number(process.env.PHASE1_START_S || 0);
const PHASE1_END_S      = Number(process.env.PHASE1_END_S || 120);   // last Phase 1 tick (9th tick)
const PHASE2_START_S    = Number(process.env.PHASE2_START_S || 135);
const PHASE2_END_S      = Number(process.env.PHASE2_END_S || 255);   // last Phase 2 tick (9th tick)
const TP_SUBMIT_AT_S    = Number(process.env.TP_SUBMIT_AT_S || 280);
const LADDER_PRICE_OFFSET = Number(process.env.LADDER_PRICE_OFFSET || 0.05); // resting buy = side's current mid minus this

// ── Env / config ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ── Strategy parameters ──
const PHASE1_BASE_SHARES = Number(process.env.PHASE1_BASE_SHARES || 10);
const PHASE2_BASE_SHARES = Number(process.env.PHASE2_BASE_SHARES || 20);
const TP_PRICE           = Number(process.env.TP_PRICE || 0.99);

// ── Entry filters (skip a ladder tick rather than force a no-edge trade) ──
// NOTE: Phase 1 deliberately wants the cheap "lottery ticket" side, sometimes as low as $0.01 —
// MIN_ENTRY_MID is just a data-sanity floor, not a strategic block on cheap entries.
const MIN_ENTRY_MID   = Number(process.env.MIN_ENTRY_MID || 0.01);
// MAX_ENTRY_MID matters mainly for Phase 2 (the "expensive" side): paying $0.95+ for a shot at the
// $0.99 TP has almost no room left and terrible risk/reward if it reverses — skip those.
const MAX_ENTRY_MID   = Number(process.env.MAX_ENTRY_MID || 0.93);
const MAX_ENTRY_SPREAD = Number(process.env.MAX_ENTRY_SPREAD || 0.15); // skip if ask-bid on chosen side is this wide (stale/illiquid quote)

// ── Late-window stop-loss (caps a losing position instead of riding it to a 100% loss at resolution) ──
const STOP_LOSS_ENABLED        = (process.env.STOP_LOSS_ENABLED || 'true').toLowerCase() === 'true';
const STOP_LOSS_AT_S           = Number(process.env.STOP_LOSS_AT_S || 295); // checked once, after TP has had time to fill
const STOP_LOSS_BID_THRESHOLD  = Number(process.env.STOP_LOSS_BID_THRESHOLD || 0.10); // force-sell if bid has crashed to/below this

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
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-ladder-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-ladder-bot/1.0' },
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
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Ladder schedule (built once, reused every window)
// ─────────────────────────────────────────
function buildSchedule() {
  const arr = [];
  for (let t = PHASE1_START_S; t <= PHASE1_END_S; t += LADDER_INTERVAL_S) {
    arr.push({ time: t, phase: 1, base: PHASE1_BASE_SHARES });
  }
  for (let t = PHASE2_START_S; t <= PHASE2_END_S; t += LADDER_INTERVAL_S) {
    arr.push({ time: t, phase: 2, base: PHASE2_BASE_SHARES });
  }
  return arr;
}
const LADDER_SCHEDULE = buildSchedule();

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshPositionSide() {
  return { shares: 0, cost: 0, tpOrderId: null, tpState: 'none', exitReason: null }; // tpState: none|resting|filled
}
function freshPairState(symbol, carry = {}) {
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

    // persists across windows (compounding basis)
    startingCapital: carry.startingCapital ?? perPairCapital,
    bankroll: carry.bankroll ?? perPairCapital,
    realizedPnl: carry.realizedPnl ?? 0,
    feesPaid: carry.feesPaid ?? 0,
    rebatesEarned: carry.rebatesEarned ?? 0,
    wins: carry.wins ?? 0, losses: carry.losses ?? 0,

    // reset every window
    nextTickIndex: 0,
    tpFired: false,
    stopLossChecked: false,
    orders: [],                                   // ladder buy orders this window
    positions: { Up: freshPositionSide(), Down: freshPositionSide() },
    resolvedThisWindow: true,
    equityCurve: carry.equityCurve ?? [{ t: Date.now(), equity: perPairCapital }],
  };
}

function resetPairs() {
  perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
  pairs = {};
  for (const sym of pairList) pairs[sym] = freshPairState(sym, {});
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

  // fresh-per-window state (compounding fields deliberately NOT reset)
  p.nextTickIndex = 0;
  p.tpFired = false;
  p.stopLossChecked = false;
  p.orders = [];
  p.positions = { Up: freshPositionSide(), Down: freshPositionSide() };

  const mult = round2(1 + (p.realizedPnl / p.startingCapital));
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | compounding x${mult} (realizedPnl $${p.realizedPnl.toFixed(2)})`);
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
function positionsMarkValue(p) {
  let v = 0;
  for (const side of ['Up', 'Down']) {
    const pos = p.positions[side];
    if (!pos || pos.shares <= 0) continue;
    const bid = side === 'Up' ? p.upBid : p.downBid;
    const price = bid ?? (pos.cost / pos.shares);
    v += pos.shares * price;
  }
  return round2(v);
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
//  Compounded share size
// ─────────────────────────────────────────
function compoundedShares(p, baseShares) {
  const multiplier = 1 + (p.realizedPnl / p.startingCapital);
  return round2(Math.max(baseShares * 0.1, baseShares * multiplier)); // floor so a big drawdown never goes to ~0
}

// ─────────────────────────────────────────
//  Ladder tick — fire the next scheduled order, if its time has come
// ─────────────────────────────────────────
function midPrice(ask, bid) {
  if (ask != null && bid != null) return round2((ask + bid) / 2);
  if (ask != null) return round2(ask);
  if (bid != null) return round2(bid);
  return null;
}
async function maybeFireLadderTick(p) {
  if (p.nextTickIndex >= LADDER_SCHEDULE.length) return;
  const elapsed = nowSec() - p.windowStart;
  const next = LADDER_SCHEDULE[p.nextTickIndex];
  if (elapsed < next.time) return;

  const upMid = midPrice(p.upAsk, p.upBid);
  const downMid = midPrice(p.downAsk, p.downBid);
  if (upMid == null || downMid == null) {
    // no prices yet — don't burn the tick, just wait and retry next loop
    return;
  }

  let side, refMid;
  if (next.phase === 1) {
    // cheapest side, fresh each tick
    if (upMid <= downMid) { side = 'Up'; refMid = upMid; } else { side = 'Down'; refMid = downMid; }
  } else {
    // expensive side, fresh each tick
    if (upMid >= downMid) { side = 'Up'; refMid = upMid; } else { side = 'Down'; refMid = downMid; }
  }

  // Filter 1: skip if the chosen side is already too close to $0 or $1 — no real edge left.
  if (refMid < MIN_ENTRY_MID || refMid > MAX_ENTRY_MID) {
    p.nextTickIndex++;
    log(`⏭️  ${p.symbol} tick#${p.nextTickIndex} (phase ${next.phase} @ t=${next.time}s): skip — ${side} mid ${refMid.toFixed(2)} outside [${MIN_ENTRY_MID},${MAX_ENTRY_MID}] entry band`);
    return;
  }
  // Filter 2: skip if the quote is too wide (stale/illiquid) — a bad reference price to ladder off of.
  const sideAsk = side === 'Up' ? p.upAsk : p.downAsk;
  const sideBid = side === 'Up' ? p.upBid : p.downBid;
  if (sideAsk != null && sideBid != null && (sideAsk - sideBid) > MAX_ENTRY_SPREAD) {
    p.nextTickIndex++;
    log(`⏭️  ${p.symbol} tick#${p.nextTickIndex} (phase ${next.phase} @ t=${next.time}s): skip — ${side} spread ${(sideAsk - sideBid).toFixed(2)} > ${MAX_ENTRY_SPREAD} max`);
    return;
  }

  // Rest the order LADDER_PRICE_OFFSET below that side's current mid, not at the mid itself.
  // It only counts as filled once the ask actually trades down through this price (checkLadderFills).
  const price = Math.max(0.01, round2(refMid - LADDER_PRICE_OFFSET));

  const shares = compoundedShares(p, next.base);
  const cost = round2(price * shares);
  p.nextTickIndex++; // consume this tick regardless, so schedule keeps moving

  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol} tick#${p.nextTickIndex} (phase ${next.phase} @ t=${next.time}s): skip — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)})`);
    return;
  }

  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  const order = await placeLimitBuy(tokenId, price, shares);
  p.orders.push({
    id: order.id || order.orderId || null,
    side, price, shares, cost,
    phase: next.phase,
    state: 'resting',
    placedAt: Date.now(),
  });
  log(`🪜 ${p.symbol} P${next.phase} tick#${p.nextTickIndex}/${LADDER_SCHEDULE.length} @ t=${next.time}s: resting buy ${shares}sh @ ${price.toFixed(2)} on ${side} (${next.phase === 1 ? 'cheapest' : 'expensive'}, mid was ${refMid.toFixed(2)}, -${LADDER_PRICE_OFFSET})`);
}

// ─────────────────────────────────────────
//  Ladder order fill check
// ─────────────────────────────────────────
async function checkLadderFills(p) {
  for (const ord of p.orders) {
    if (ord.state !== 'resting') continue;
    const ask = ord.side === 'Up' ? p.upAsk : p.downAsk;
    if (ask == null || ask > ord.price) continue; // fills once ask trades down to/through our resting bid

    const rebate = makerRebate(ord.shares, ord.price);
    p.bankroll = round2(p.bankroll - ord.cost + rebate);
    p.realizedPnl = round2(p.realizedPnl + rebate);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    ord.state = 'filled';

    const pos = p.positions[ord.side];
    pos.shares = round2(pos.shares + ord.shares);
    pos.cost = round2(pos.cost + ord.cost);

    recordEquity(p);
    log(`🎯 ${p.symbol} P${ord.phase} BUY filled ${ord.shares}sh @ ${ord.price.toFixed(2)} on ${ord.side} | cost=$${ord.cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)}`);
    registerTrade(p, { side: 'BUY', outcome: ord.side, reason: `P${ord.phase}`, price: ord.price, shares: ord.shares, cost: ord.cost, rebate });
  }
}

// ─────────────────────────────────────────
//  TP submission (t=280s) — one aggregated sell per side with shares
// ─────────────────────────────────────────
async function maybeSubmitTp(p) {
  if (p.tpFired) return;
  const elapsed = nowSec() - p.windowStart;
  if (elapsed < TP_SUBMIT_AT_S) return;
  p.tpFired = true;

  for (const side of ['Up', 'Down']) {
    const pos = p.positions[side];
    if (!pos || pos.shares <= 0) continue;
    const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
    const order = await placeLimitSell(tokenId, TP_PRICE, pos.shares);
    pos.tpOrderId = order.id || order.orderId || null;
    pos.tpState = 'resting';
    log(`🏁 ${p.symbol} TP submitted: sell ${pos.shares}sh @ ${TP_PRICE} on ${side} (avg entry $${(pos.cost / pos.shares).toFixed(3)})`);
  }
}

// ─────────────────────────────────────────
//  TP fill check (maker)
// ─────────────────────────────────────────
async function checkTpFills(p) {
  for (const side of ['Up', 'Down']) {
    const pos = p.positions[side];
    if (!pos || pos.tpState !== 'resting') continue;
    const bid = side === 'Up' ? p.upBid : p.downBid;
    if (bid == null || bid < TP_PRICE) continue;

    const proceeds = round2(TP_PRICE * pos.shares);
    const rebate = makerRebate(pos.shares, TP_PRICE);
    const net = round2(proceeds + rebate);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    if (profit >= 0) p.wins++; else p.losses++;
    pos.tpState = 'filled';
    pos.exitReason = 'tp';

    log(`💰 ${p.symbol} TP filled ${pos.shares}sh @ ${TP_PRICE} on ${side} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: 'TP', price: TP_PRICE, shares: pos.shares, profit, rebate });
    pos.shares = 0;
    pos.cost = 0;
    recordEquity(p);
  }
}

// ─────────────────────────────────────────
//  Late-window stop-loss — checked once, after TP has had a chance to fill.
//  If a side has clearly crashed (bid <= STOP_LOSS_BID_THRESHOLD) and never hit
//  TP, force-sell it now as a taker order at the live bid instead of riding it
//  all the way to a guaranteed $0 at resolution. Salvages partial value.
// ─────────────────────────────────────────
async function maybeStopLoss(p) {
  if (!STOP_LOSS_ENABLED || p.stopLossChecked) return;
  const elapsed = nowSec() - p.windowStart;
  if (elapsed < STOP_LOSS_AT_S) return;
  p.stopLossChecked = true;

  for (const side of ['Up', 'Down']) {
    const pos = p.positions[side];
    if (!pos || pos.shares <= 0 || pos.tpState === 'filled') continue;
    const bid = side === 'Up' ? p.upBid : p.downBid;
    if (bid == null || bid > STOP_LOSS_BID_THRESHOLD) continue;

    if (pos.tpState === 'resting') await cancelOrder(pos.tpOrderId);

    const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
    await placeLimitSell(tokenId, bid, pos.shares); // marketable at the live bid — fills as a taker order

    const proceeds = round2(bid * pos.shares);
    const fee = takerFee(pos.shares, bid);
    const net = round2(proceeds - fee);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.feesPaid = round2(p.feesPaid + fee);
    if (profit >= 0) p.wins++; else p.losses++;
    pos.tpState = 'filled'; // mark closed so resolvePairWindow doesn't also settle it
    pos.exitReason = 'stoploss';

    log(`🧯 ${p.symbol} STOP-LOSS ${side} ${pos.shares}sh force-sold @ ${bid.toFixed(2)} (taker) | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: 'STOP_LOSS', price: bid, shares: pos.shares, profit, fee });
    pos.shares = 0;
    pos.cost = 0;
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
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  // Cancel any entry orders still resting — never filled, no cost.
  for (const ord of p.orders) {
    if (ord.state === 'resting') {
      await cancelOrder(ord.id);
      log(`🛑 ${p.symbol}: unfilled P${ord.phase} ladder buy ${ord.shares}sh @ ${ord.price.toFixed(2)} on ${ord.side} cancelled at window close`);
    }
  }

  let winner = null;
  for (const side of ['Up', 'Down']) {
    const pos = p.positions[side];
    if (!pos || pos.shares <= 0) continue;

    // Cancel a still-resting TP order for this side (didn't hit 0.99).
    if (pos.tpState === 'resting') {
      await cancelOrder(pos.tpOrderId);
    }
    if (pos.tpState === 'filled') continue; // already settled by TP fill

    if (winner === null) winner = await determineWinningSide(p);
    const won = winner === side;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (won) p.wins++; else p.losses++;
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION ${side} ${pos.shares}sh cost=$${pos.cost.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
    pos.exitReason = 'resolution';
    pos.shares = 0;
    pos.cost = 0;
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

  await checkLadderFills(p);      // 1) did any resting ladder buy get hit?
  if (tradingEnabled) await maybeFireLadderTick(p); // 2) is it time for the next scheduled ladder order?
  await maybeSubmitTp(p);         // 3) t=280s — submit aggregated TP sells
  await checkTpFills(p);          // 4) did a TP sell get hit?
  await maybeStopLoss(p);         // 5) t=295s — force-sell anything that's clearly lost, instead of riding to $0

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(positionsMarkValue(p) -
      (p.positions.Up.cost + p.positions.Down.cost));
    const markValue = pairMarkValue(p);
    const elapsed = p.windowStart ? Math.max(0, nowSec() - p.windowStart) : 0;
    let phaseLabel = 'waiting';
    if (p.tradable) {
      if (elapsed < PHASE1_END_S + LADDER_INTERVAL_S && p.nextTickIndex <= 9) phaseLabel = 'Phase 1 (cheapest)';
      else if (elapsed < TP_SUBMIT_AT_S) phaseLabel = 'Phase 2 (expensive)';
      else if (!p.resolvedThisWindow) phaseLabel = 'TP / resolution';
      else phaseLabel = 'resolved';
    }
    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      phaseLabel,
      ticksFired: p.nextTickIndex,
      ticksTotal: LADDER_SCHEDULE.length,
      compoundMultiplier: round2(1 + (p.realizedPnl / p.startingCapital)),
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      positions: {
        Up: { shares: p.positions.Up.shares, cost: p.positions.Up.cost, tpState: p.positions.Up.tpState, exitReason: p.positions.Up.exitReason },
        Down: { shares: p.positions.Down.shares, cost: p.positions.Down.cost, tpState: p.positions.Down.tpState, exitReason: p.positions.Down.exitReason },
      },
      restingOrders: p.orders.filter(o => o.state === 'resting').map(o => ({ side: o.side, price: o.price, shares: o.shares, phase: o.phase })),
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
      ladderIntervalS: LADDER_INTERVAL_S,
      phase1EndS: PHASE1_END_S,
      phase2StartS: PHASE2_START_S,
      phase2EndS: PHASE2_END_S,
      tpSubmitAtS: TP_SUBMIT_AT_S,
      ladderPriceOffset: LADDER_PRICE_OFFSET,
      phase1BaseShares: PHASE1_BASE_SHARES,
      phase2BaseShares: PHASE2_BASE_SHARES,
      tpPrice: TP_PRICE,
      minEntryMid: MIN_ENTRY_MID,
      maxEntryMid: MAX_ENTRY_MID,
      maxEntrySpread: MAX_ENTRY_SPREAD,
      stopLossEnabled: STOP_LOSS_ENABLED,
      stopLossAtS: STOP_LOSS_AT_S,
      stopLossBidThreshold: STOP_LOSS_BID_THRESHOLD,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates,
    totalEquityCurve,
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
  log('⏸️  Trading paused (open positions still managed for TP-fill/resolution; no new ladder orders placed)');
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
  log(`🚀 5-Minute BTC Up/Down — Two-Phase Ladder Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Phase 1: every ${LADDER_INTERVAL_S}s from t=0..${PHASE1_END_S}s, cheapest side, ${PHASE1_BASE_SHARES}sh base | Phase 2: t=${PHASE2_START_S}..${PHASE2_END_S}s, expensive side, ${PHASE2_BASE_SHARES}sh base`);
  log(`⚙️  Entry price = chosen side's current mid minus $${LADDER_PRICE_OFFSET} (confirmed filled only once ask trades through that price)`);
  log(`⚙️  Entry filters: skip if mid outside [${MIN_ENTRY_MID}, ${MAX_ENTRY_MID}] or spread > ${MAX_ENTRY_SPREAD}`);
  log(`⚙️  Stop-loss: ${STOP_LOSS_ENABLED ? `checked once @t=${STOP_LOSS_AT_S}s, force-sells (taker) any open side with bid <= ${STOP_LOSS_BID_THRESHOLD}` : 'disabled'}`);
  log(`⚙️  TP submitted @t=${TP_SUBMIT_AT_S}s at ${TP_PRICE} for all filled shares per side | unfilled TP settles via resolution at window close`);
  log(`⚙️  Compounding: shares = base × (1 + realizedPnl/startingCapital) | all orders are maker (rebate ${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% of crypto taker-fee rate ${CRYPTO_TAKER_FEE_RATE})`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
