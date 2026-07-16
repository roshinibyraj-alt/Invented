'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — TWO INDEPENDENT LIMIT STRATEGIES
 * ═══════════════════════════════════════════════════════════════
 *
 *  Complete rewrite. No candles, no signals, no external price data at all.
 *  BTC only. Two independent strategies run every window, never
 *  interacting with each other, both pulling from the same bankroll.
 *
 *  FILL SEMANTICS (both strategies): a limit buy at price P fills the
 *  moment the current ask is AT OR BELOW P, and it fills at that REAL
 *  current ask — never at P itself unless the ask happens to equal it.
 *  This is how a real limit order works (you never pay worse than your
 *  ceiling), and it matters a lot for Strategy 2 below.
 *
 *  STRATEGY 1 — cheap dip on both sides, TP/SL:
 *    Once per window (placed as early as data allows), rest a limit buy on
 *    BOTH Up and Down at 0.30, $50 each. No repeat/replace if unfilled.
 *    Whichever side(s) actually fill get managed independently:
 *      - TP at 0.70: a genuine resting sell — passive, waits for bid to
 *        rise there.
 *      - SL at 0.10: an aggressive/marketable exit — fires immediately
 *        once bid drops there, since a stop needs to actually execute.
 *
 *  STRATEGY 2 — breakout confirmation, each side fully independent:
 *    Up and Down are tracked completely separately — this is NOT a paired
 *    hedge. The FIRST time a given side's own ask reaches 0.70 in a window
 *    (each side's trigger fires at most once per window, independent of
 *    the other side), place a limit buy at 0.70 for THAT side only, $100.
 *    Reaching 0.70 on Up has no effect on Down, and vice versa — either,
 *    both, or neither side can trigger in the same window.
 *      - SL at 0.30: aggressive/marketable exit, same as Strategy 1's SL.
 *      - No TP order. If SL doesn't trigger, the position simply rides to
 *        actual window resolution (real settlement pays $1 or $0).
 *
 *  EXECUTION: entries are genuine passive limit orders (fill only
 *    confirmed when ask walks down to the specified ceiling). SL exits are
 *    deliberately marketable (priced to guarantee execution). TP (Strategy
 *    1 only) is a genuine resting sell.
 *
 *  RESOLUTION: any position still open when the window ends (no TP/SL hit)
 *    rides to actual window resolution — this bot's own bookkeeping
 *    simulates that via the public Gamma API purely to keep the
 *    dashboard's P&L figures meaningful. A separate, independent auto-claim
 *    script handles real redemption.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable (see setMode) — dashboard has
 *    a one-click toggle plus an independent pause button.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2);
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];
const SYMBOL = 'BTC'; // this bot only ever trades BTC, per spec

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // runtime-switchable — see setMode
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const S1_ENTRY_PRICE = Number(process.env.S1_ENTRY_PRICE || 0.30);
const S1_TP_PRICE    = Number(process.env.S1_TP_PRICE || 0.70);
const S1_SL_PRICE    = Number(process.env.S1_SL_PRICE || 0.10);
const S1_BET_DOLLARS = Number(process.env.S1_BET_DOLLARS || 50);

const S2_TRIGGER_PRICE = Number(process.env.S2_TRIGGER_PRICE || 0.70);
const S2_ENTRY_PRICE   = Number(process.env.S2_ENTRY_PRICE || 0.70);
const S2_SL_PRICE      = Number(process.env.S2_SL_PRICE || 0.30);
const S2_BET_DOLLARS   = Number(process.env.S2_BET_DOLLARS || 100);

const MIN_SHARES = Number(process.env.MIN_SHARES || 1);
const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let bankroll = TOTAL_CAPITAL;
let realizedPnl = 0, feesPaid = 0, rebatesEarned = 0, wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];

let state = freshMarketState();

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-two-strategy-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-two-strategy-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// Genuine resting (passive) limit buy — fills only when ask walks down to
// meet it (or below). Used for Strategy 1's entries and Strategy 2's entries.
async function placeRestingBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
// A genuine resting (passive) limit sell — Strategy 1's TP only.
async function placeRestingSell(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitSell(tokenId, shares, price);
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
// A deliberately marketable sell — priced at the current bid so it fills
// now. Used for both strategies' SL exits, since a stop needs to actually
// execute rather than wait passively.
async function placeMarketableSell(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitSell(tokenId, shares, price);
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function cancelOrder(orderId) {
  if (!DRY_RUN && trader && orderId) {
    try { await trader.cancelOrder(orderId); }
    catch (e) { log(`⚠️  cancel failed: ${e.message}`); }
  }
}
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}

// ─────────────────────────────────────────
//  Market state (single BTC market only)
// ─────────────────────────────────────────
function freshMarketState() {
  return {
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    resolvedThisWindow: true,
    s1: {
      placed: false, // one-time placement attempt done
      orders: { Up: null, Down: null },     // resting entry orders, pre-fill: {price, shares, orderId}
      positions: { Up: null, Down: null },  // filled positions: {shares, entryPrice, cost, tpOrderId, closed}
    },
    s2: {
      triggeredSide: { Up: false, Down: false }, // has this side's 0.70 trigger already fired this window
      positions: { Up: null, Down: null },       // filled positions: {shares, entryPrice, cost, closed}
    },
  };
}

// ─────────────────────────────────────────
//  Slug / window math (unchanged market-discovery plumbing)
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) { return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS; }
function slugFor(windowStartSec) { return `${SYMBOL.toLowerCase()}-updown-5m-${windowStartSec}`; }
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
async function fetchEventForWindow(windowStart) {
  for (const offset of SLUG_OFFSET_FALLBACKS) {
    const ws = windowStart + offset;
    if (ws + WINDOW_SECS <= nowSec()) continue;
    const slug = slugFor(ws);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) return { event, windowStart: ws, slug };
    } catch (_) {}
  }
  return null;
}

async function loadWindow() {
  const ws = currentWindowStart();
  if (state.windowStart === ws && state.upTokenId) return;
  const found = await fetchEventForWindow(ws);
  if (!found) { state.tradable = false; return; }
  const { event, windowStart, slug } = found;
  const market = event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];
  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) { log(`⚠️  window loaded but Up/Down token ids missing`); state.tradable = false; return; }

  const fresh = freshMarketState();
  fresh.windowStart = windowStart;
  fresh.windowEnd = windowStart + WINDOW_SECS;
  fresh.slug = slug;
  fresh.eventTitle = event.title || event.slug;
  fresh.conditionId = market.conditionId || null;
  fresh.upTokenId = upId;
  fresh.downTokenId = downId;
  fresh.tradable = true;
  fresh.resolvedThisWindow = false;
  fresh.upAsk = state.upAsk; fresh.upBid = state.upBid; fresh.downAsk = state.downAsk; fresh.downBid = state.downBid;
  state = fresh;
  log(`🔭 BTC window loaded: ${slug} | ends ${new Date(state.windowEnd * 1000).toISOString().slice(11,19)}Z`);
}

// ─────────────────────────────────────────
//  Polymarket price feed (unchanged plumbing, single-market version)
// ─────────────────────────────────────────
async function refreshPolyPrices() {
  if (!state.tradable || !state.upTokenId || !state.downTokenId) return;
  const requests = [
    { token_id: state.upTokenId, side: 'BUY' }, { token_id: state.upTokenId, side: 'SELL' },
    { token_id: state.downTokenId, side: 'BUY' }, { token_id: state.downTokenId, side: 'SELL' },
  ];
  function apply(tid, side, price) {
    if (!Number.isFinite(price)) return;
    if (tid === state.upTokenId) { if (side === 'BUY') state.upAsk = price; else state.upBid = price; }
    else if (tid === state.downTokenId) { if (side === 'BUY') state.downAsk = price; else state.downBid = price; }
  }
  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const side = (row.side || '').toUpperCase();
        const price = parseFloat(row.price);
        if (tid && Number.isFinite(price)) apply(tid, side, price);
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (val && typeof val === 'object') {
          if (val.BUY != null) apply(tid, 'BUY', parseFloat(val.BUY));
          if (val.SELL != null) apply(tid, 'SELL', parseFloat(val.SELL));
          if (val.buy != null) apply(tid, 'BUY', parseFloat(val.buy));
          if (val.sell != null) apply(tid, 'SELL', parseFloat(val.sell));
        }
      }
    }
  } catch (e) {
    try {
      const [upAsk, upBid, downAsk, downBid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${state.upTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${state.upTokenId}&side=SELL`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${state.downTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${state.downTokenId}&side=SELL`).catch(() => null),
      ]);
      if (upAsk) state.upAsk = parseFloat(upAsk.price || upAsk.mid || state.upAsk);
      if (upBid) state.upBid = parseFloat(upBid.price || upBid.mid || state.upBid);
      if (downAsk) state.downAsk = parseFloat(downAsk.price || downAsk.mid || state.downAsk);
      if (downBid) state.downBid = parseFloat(downBid.price || downBid.mid || state.downBid);
    } catch (_) {}
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function markValue() {
  let held = 0;
  for (const side of ['Up', 'Down']) {
    const pos1 = state.s1.positions[side];
    if (pos1 && !pos1.closed) held += pos1.shares * ((side === 'Up' ? state.upBid : state.downBid) ?? pos1.entryPrice);
    const pos2 = state.s2.positions[side];
    if (pos2 && !pos2.closed) held += pos2.shares * ((side === 'Up' ? state.upBid : state.downBid) ?? pos2.entryPrice);
  }
  return round2(bankroll + held);
}
function recordEquity() {
  equityCurve.push({ t: Date.now(), equity: markValue() });
  if (equityCurve.length > 500) equityCurve.shift();
}
function registerTrade(entry) {
  trades.push({ time: new Date().toISOString().slice(11, 19), symbol: SYMBOL, ...entry });
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Strategy 1 — cheap dip both sides, TP/SL
// ─────────────────────────────────────────
async function s1PlaceEntries() {
  if (state.s1.placed) return;
  const upAsk = state.upAsk, downAsk = state.downAsk;
  if (upAsk == null || downAsk == null) return; // wait for valid price data before the one-time placement
  state.s1.placed = true;

  for (const side of ['Up', 'Down']) {
    const tokenId = side === 'Up' ? state.upTokenId : state.downTokenId;
    const shares = Math.max(round2(S1_BET_DOLLARS / S1_ENTRY_PRICE), MIN_SHARES);
    const order = await placeRestingBuy(tokenId, S1_ENTRY_PRICE, shares);
    state.s1.orders[side] = { price: S1_ENTRY_PRICE, shares, orderId: order.id || order.orderId || null };
    log(`📌 S1 ${side} resting buy ${shares.toFixed(2)}sh @ ${S1_ENTRY_PRICE} placed (one-time, no repeat this window)`);
  }
}

async function s1CheckFills(side) {
  const order = state.s1.orders[side];
  if (!order || state.s1.positions[side]) return; // no order, or already filled
  const ask = side === 'Up' ? state.upAsk : state.downAsk;
  if (ask == null || ask > order.price) return; // hasn't walked down to meet it yet

  const fillPrice = ask; // real ask, never worse than the order's ceiling
  const rebate = makerRebate(order.shares, fillPrice);
  const cost = round2(fillPrice * order.shares - rebate);
  if (cost > bankroll) { log(`⏭️  S1 ${side}: would fill but bankroll insufficient, dropping`); state.s1.orders[side] = null; return; }

  bankroll = round2(bankroll - cost);
  realizedPnl = round2(realizedPnl + rebate);
  rebatesEarned = round2(rebatesEarned + rebate);
  const tokenId = side === 'Up' ? state.upTokenId : state.downTokenId;
  const tpOrder = await placeRestingSell(tokenId, S1_TP_PRICE, order.shares);
  state.s1.positions[side] = { shares: order.shares, entryPrice: fillPrice, cost, tpOrderId: tpOrder.id || tpOrder.orderId || null, closed: false };
  recordEquity();
  log(`💰 S1 ${side} FILLED ${order.shares.toFixed(2)}sh @ ${fillPrice.toFixed(2)} | cost=$${cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP resting @ ${S1_TP_PRICE}`);
  registerTrade({ strategy: 1, side: 'BUY', outcome: side, price: fillPrice, shares: order.shares, cost, rebate });
}

async function s1ManagePosition(side) {
  const pos = state.s1.positions[side];
  if (!pos || pos.closed) return;
  const bid = side === 'Up' ? state.upBid : state.downBid;
  if (bid == null) return;

  if (bid <= S1_SL_PRICE) {
    await cancelOrder(pos.tpOrderId);
    const tokenId = side === 'Up' ? state.upTokenId : state.downTokenId;
    await placeMarketableSell(tokenId, bid, pos.shares);
    const fee = takerFee(pos.shares, bid);
    const proceeds = round2(bid * pos.shares - fee);
    bankroll = round2(bankroll + proceeds);
    const profit = round2(proceeds - pos.cost);
    realizedPnl = round2(realizedPnl + profit);
    feesPaid = round2(feesPaid + fee);
    losses++;
    pos.closed = true;
    log(`🧯 S1 ${side} SL hit @ ${bid.toFixed(2)} | ${pos.shares.toFixed(2)}sh | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);
    registerTrade({ strategy: 1, side: 'SELL', outcome: side, reason: 'SL', price: bid, shares: pos.shares, profit });
    recordEquity();
    return;
  }
  if (bid >= S1_TP_PRICE) {
    const rebate = makerRebate(pos.shares, S1_TP_PRICE);
    const proceeds = round2(S1_TP_PRICE * pos.shares + rebate);
    bankroll = round2(bankroll + proceeds);
    const profit = round2(proceeds - pos.cost);
    realizedPnl = round2(realizedPnl + profit);
    rebatesEarned = round2(rebatesEarned + rebate);
    wins++;
    pos.closed = true;
    log(`🎯 S1 ${side} TP filled @ ${S1_TP_PRICE} | ${pos.shares.toFixed(2)}sh | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);
    registerTrade({ strategy: 1, side: 'SELL', outcome: side, reason: 'TP', price: S1_TP_PRICE, shares: pos.shares, profit, rebate });
    recordEquity();
  }
}

// ─────────────────────────────────────────
//  Strategy 2 — breakout confirmation, buy both sides at 0.70 ceiling
// ─────────────────────────────────────────
async function s2CheckTrigger(side) {
  if (state.s2.triggeredSide[side]) return; // this side already fired this window — fully independent of the other side
  const ask = side === 'Up' ? state.upAsk : state.downAsk;
  if (ask == null || ask < S2_TRIGGER_PRICE) return;

  state.s2.triggeredSide[side] = true;
  const tokenId = side === 'Up' ? state.upTokenId : state.downTokenId;
  const fillPrice = ask; // real ask, never worse than the ceiling
  const shares = Math.max(round2(S2_BET_DOLLARS / S2_ENTRY_PRICE), MIN_SHARES);
  const rebate = makerRebate(shares, fillPrice);
  const cost = round2(fillPrice * shares - rebate);
  if (cost > bankroll) { log(`⏭️  S2 ${side}: trigger hit but insufficient bankroll, skipping`); return; }

  await placeRestingBuy(tokenId, S2_ENTRY_PRICE, shares);
  bankroll = round2(bankroll - cost);
  realizedPnl = round2(realizedPnl + rebate);
  rebatesEarned = round2(rebatesEarned + rebate);
  state.s2.positions[side] = { shares, entryPrice: fillPrice, cost, closed: false };
  recordEquity();
  log(`🔔 S2 ${side} TRIGGERED @ ask=${ask.toFixed(2)} (>= ${S2_TRIGGER_PRICE}) — bought ${shares.toFixed(2)}sh @ ${fillPrice.toFixed(2)} | cost=$${cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | SL @ ${S2_SL_PRICE}, no TP — rides to resolution otherwise (independent of the other side)`);
  registerTrade({ strategy: 2, side: 'BUY', outcome: side, price: fillPrice, shares, cost, rebate });
}

async function s2ManagePosition(side) {
  const pos = state.s2.positions[side];
  if (!pos || pos.closed) return;
  const bid = side === 'Up' ? state.upBid : state.downBid;
  if (bid == null || bid > S2_SL_PRICE) return;

  const tokenId = side === 'Up' ? state.upTokenId : state.downTokenId;
  await placeMarketableSell(tokenId, bid, pos.shares);
  const fee = takerFee(pos.shares, bid);
  const proceeds = round2(bid * pos.shares - fee);
  bankroll = round2(bankroll + proceeds);
  const profit = round2(proceeds - pos.cost);
  realizedPnl = round2(realizedPnl + profit);
  feesPaid = round2(feesPaid + fee);
  losses++;
  pos.closed = true;
  log(`🧯 S2 ${side} SL hit @ ${bid.toFixed(2)} | ${pos.shares.toFixed(2)}sh | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);
  registerTrade({ strategy: 2, side: 'SELL', outcome: side, reason: 'SL', price: bid, shares: pos.shares, profit });
  recordEquity();
}

// ─────────────────────────────────────────
//  Window resolution
// ─────────────────────────────────────────
async function determineWinningSide() {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(state.slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === state.conditionId) || (event.markets || [])[0];
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const winner = (outcomes[bestI] || '').trim();
      if (winner) return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
    }
  } catch (_) {}
  if (state.upBid != null && state.downBid != null) return state.upBid >= state.downBid ? 'Up' : 'Down';
  return null;
}

async function resolveWindow() {
  if (state.resolvedThisWindow) return;
  state.resolvedThisWindow = true;

  const anyOpen = ['Up', 'Down'].some(s => (state.s1.positions[s] && !state.s1.positions[s].closed) || (state.s2.positions[s] && !state.s2.positions[s].closed));
  let winner = null;
  if (anyOpen) winner = await determineWinningSide();

  for (const [label, bucket] of [['S1', state.s1.positions], ['S2', state.s2.positions]]) {
    for (const side of ['Up', 'Down']) {
      const pos = bucket[side];
      if (!pos || pos.closed) continue;
      if (label === 'S1') await cancelOrder(pos.tpOrderId);
      const won = winner === side;
      const proceeds = won ? round2(pos.shares * 1) : 0;
      const profit = round2(proceeds - pos.cost);
      bankroll = round2(bankroll + proceeds);
      realizedPnl = round2(realizedPnl + profit);
      if (won) wins++; else losses++;
      pos.closed = true;
      const icon = won ? '💰' : '💥';
      log(`${icon} ${label} ${side} RESOLUTION ${pos.shares.toFixed(2)}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)} (dashboard bookkeeping only — real redemption is via the separate claim script)`);
      registerTrade({ strategy: label === 'S1' ? 1 : 2, side: 'SELL', outcome: side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
    }
  }
  recordEquity();
}

// ─────────────────────────────────────────
//  Main tick
// ─────────────────────────────────────────
async function tick() {
  const ws = currentWindowStart();
  if (state.windowStart === null || ws !== state.windowStart) {
    if (state.windowStart !== null && !state.resolvedThisWindow) await resolveWindow();
    await loadWindow();
  }
  if (!state.tradable || !tradingEnabled) return;

  const elapsed = nowSec() - state.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !state.resolvedThisWindow) {
    await resolveWindow();
  }
  if (state.resolvedThisWindow) return;

  await s1PlaceEntries();
  for (const side of ['Up', 'Down']) {
    await s1CheckFills(side);
    await s1ManagePosition(side);
    await s2CheckTrigger(side);
    await s2ManagePosition(side);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const mv = markValue();
  const held = round2(mv - bankroll);
  const costBasis = round2(
    ['Up','Down'].reduce((s, side) => {
      const p1 = state.s1.positions[side]; const p2 = state.s2.positions[side];
      return s + (p1 && !p1.closed ? p1.cost : 0) + (p2 && !p2.closed ? p2.cost : 0);
    }, 0)
  );
  const unrealizedPnl = round2(held - costBasis);
  return {
    dryRun: DRY_RUN, tradingEnabled, symbol: SYMBOL,
    tradable: state.tradable, slug: state.slug, windowEnd: state.windowEnd,
    secsToEnd: state.windowEnd ? Math.max(0, Math.floor(state.windowEnd - nowSec())) : null,
    upAsk: state.upAsk, upBid: state.upBid, downAsk: state.downAsk, downBid: state.downBid,
    s1: {
      placed: state.s1.placed,
      orders: state.s1.orders,
      positions: state.s1.positions,
    },
    s2: {
      triggered: state.s2.triggeredSide.Up || state.s2.triggeredSide.Down,
      triggeredSide: state.s2.triggeredSide,
      positions: state.s2.positions,
    },
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    realizedPnl, unrealizedPnl, feesPaid, rebatesEarned, wins, losses,
    totalPnl: round2(mv - TOTAL_CAPITAL),
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      s1EntryPrice: S1_ENTRY_PRICE, s1TpPrice: S1_TP_PRICE, s1SlPrice: S1_SL_PRICE, s1BetDollars: S1_BET_DOLLARS,
      s2TriggerPrice: S2_TRIGGER_PRICE, s2EntryPrice: S2_ENTRY_PRICE, s2SlPrice: S2_SL_PRICE, s2BetDollars: S2_BET_DOLLARS,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE, cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    equityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastPolyPriceFetch = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshPolyPrices(); }
      await tick();
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(_list) {
  // This bot only ever trades BTC — retained as a no-op for API compatibility with the dashboard.
  return { ok: true, pairs: [SYMBOL], perPairCapital: TOTAL_CAPITAL };
}
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (existing positions still tracked for resolution bookkeeping)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) {
    log(DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real orders');
  }
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Two-Strategy Limit Order Bot — BTC 5-minute windows only`);
  log(`⚙️  $${TOTAL_CAPITAL} capital`);
  log(`⚙️  Strategy 1: resting buy both sides @ ${S1_ENTRY_PRICE}, $${S1_BET_DOLLARS} each, once per window | TP @ ${S1_TP_PRICE} (resting) | SL @ ${S1_SL_PRICE} (marketable)`);
  log(`⚙️  Strategy 2: EACH side independently — if that side's own ask reaches ${S2_TRIGGER_PRICE}, buy only that side @ ${S2_ENTRY_PRICE} ceiling, $${S2_BET_DOLLARS}, once per window | SL @ ${S2_SL_PRICE} (marketable) | no TP — rides to resolution`);
  log(`⚙️  fill semantics: limit fills at the real current ask when ask<=ceiling, never worse than the ceiling price`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
