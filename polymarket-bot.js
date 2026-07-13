'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET BTC 5-MINUTE UP/DOWN — PERIODIC RESTING LIMIT BUY
 *  Every 10 seconds place resting limit buys at mid - 0.05
 *  Fill when price walks to that level. Up/Down independent.
 * ═══════════════════════════════════════════════════════════════
 *
 *  PER 5-MINUTE WINDOW:
 *    Every 10 seconds (t=0, 10, 20, ... 200) place a resting limit
 *    BUY on Up AND Down independently at currentMid - 0.05.
 *    Multiple orders stack — each is independent.
 *
 *    Fill is confirmed when the ask drops to <= the limit price.
 *    Unfilled orders are cancelled at window end.
 *    Filled positions ride to resolution (win=$1/share, lose=$0).
 *
 *  SIZING:
 *    At the time each order is placed:
 *      - mid < 0.50 → 20 shares
 *      - mid >= 0.50 → 10 shares
 *    Both Up and Down evaluated independently each tick.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable via setMode().
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2);
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];
const SYMBOL                = 'BTC';

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const PRICE_OFFSET      = -0.05;   // limit price = mid + this offset
const ORDER_TICK_SECS   = 10;      // place new orders every N seconds
const ORDER_CUTOFF_SECS = 200;     // stop placing new orders after this many seconds

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let totalEquityCurve = [];

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-btc-indep-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-btc-indep-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function placeLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function cancelOrder(orderId) {
  if (!orderId) return null;
  if (!DRY_RUN && trader) {
    if (typeof trader.cancelOrder === 'function') return await trader.cancelOrder(orderId);
    log('⚠️  trader.cancelOrder() not implemented — unfilled resting order NOT cancelled on-chain');
    return null;
  }
  return { ok: true };
}

// ─────────────────────────────────────────
//  Per-order state factory
// ─────────────────────────────────────────
function freshOrder(side, limitPrice, shares, orderId) {
  return {
    id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    side,           // 'Up' or 'Down'
    limitPrice,
    shares,
    state: 'resting',  // resting | filled | cancelled
    orderId: orderId || null,
    fillPrice: null,
    cost: 0,
    placedAtSec: 0,
  };
}

// ─────────────────────────────────────────
//  Market state (single BTC pair)
// ─────────────────────────────────────────
function freshPairState() {
  return {
    symbol: SYMBOL,
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    // Strategy
    orders: [],           // all orders this window (resting + filled + cancelled)
    lastOrderTickSec: -1, // elapsed seconds when last order batch was placed
    // Capital
    bankroll: TOTAL_CAPITAL,
    realizedPnl: 0,
    feesPaid: 0,
    wins: 0, losses: 0,
    equityCurve: [{ t: Date.now(), equity: TOTAL_CAPITAL }],
    resolvedThisWindow: true,
  };
}
let pair = freshPairState();

// ─────────────────────────────────────────
//  Slug / window math (UNCHANGED)
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) { return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS; }
function slugFor(symbol, windowStartSec) { return `${symbol.toLowerCase()}-updown-5m-${windowStartSec}`; }
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
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) return { event, windowStart: ws, slug };
    } catch (_) {}
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
  if (!upId || !downId) { log(`⚠️  ${p.symbol}: window loaded but Up/Down token ids missing`); p.tradable = false; return; }

  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.slug = slug;
  p.eventTitle = event.title || event.slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;
  p.resolvedThisWindow = false;
  p.orders = [];
  p.lastOrderTickSec = -1;
  p.upAsk = null; p.upBid = null; p.downAsk = null; p.downBid = null;
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | periodic resting buys every ${ORDER_TICK_SECS}s until ${ORDER_CUTOFF_SECS}s | offset ${PRICE_OFFSET} from mid`);
}

// ─────────────────────────────────────────
//  Polymarket price feed (UNCHANGED)
// ─────────────────────────────────────────
async function refreshPolyPrices() {
  if (!pair.tradable || !pair.upTokenId || !pair.downTokenId) return;
  const requests = [
    { token_id: pair.upTokenId, side: 'BUY' },
    { token_id: pair.upTokenId, side: 'SELL' },
    { token_id: pair.downTokenId, side: 'BUY' },
    { token_id: pair.downTokenId, side: 'SELL' },
  ];
  function applyPolyPrice(tid, side, price) {
    if (!Number.isFinite(price)) return;
    if (pair.upTokenId === tid) { if (side === 'BUY') pair.upAsk = price; else if (side === 'SELL') pair.upBid = price; }
    else if (pair.downTokenId === tid) { if (side === 'BUY') pair.downAsk = price; else if (side === 'SELL') pair.downBid = price; }
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
    try {
      const [upAsk, upBid, downAsk, downBid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${pair.upTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${pair.upTokenId}&side=SELL`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${pair.downTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${pair.downTokenId}&side=SELL`).catch(() => null),
      ]);
      if (upAsk) pair.upAsk = parseFloat(upAsk.price || upAsk.mid || pair.upAsk);
      if (upBid) pair.upBid = parseFloat(upBid.price || upBid.mid || pair.upBid);
      if (downAsk) pair.downAsk = parseFloat(downAsk.price || downAsk.mid || pair.downAsk);
      if (downBid) pair.downBid = parseFloat(downBid.price || downBid.mid || pair.downBid);
    } catch (_) {}
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function positionsMarkValue(p) {
  let v = 0;
  for (const o of p.orders) {
    if (o.state === 'filled') {
      const bid = o.side === 'Up' ? p.upBid : p.downBid;
      v += o.shares * (bid != null ? bid : o.fillPrice);
    }
  }
  return round2(v);
}
function filledCostBasis(p) {
  let v = 0;
  for (const o of p.orders) {
    if (o.state === 'filled') v += o.cost;
  }
  return round2(v);
}
function pushGlobalEquity() {
  const mark = positionsMarkValue(pair);
  const total = round2(pair.bankroll + mark);
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > 500) totalEquityCurve.shift();
}
function recordEquity(p) {
  const mark = positionsMarkValue(p);
  const total = round2(p.bankroll + mark);
  p.equityCurve.push({ t: Date.now(), equity: total });
  if (p.equityCurve.length > 300) p.equityCurve.shift();
  pushGlobalEquity();
}
function registerTrade(p, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: p.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  STRATEGY — Periodic resting limit buys
// ─────────────────────────────────────────

// Place new resting limit buys on both sides at mid - 0.05
async function placePeriodicOrders(p) {
  for (const side of ['Up', 'Down']) {
    const ask = side === 'Up' ? p.upAsk : p.downAsk;
    const bid = side === 'Up' ? p.upBid : p.downBid;
    if (ask == null || bid == null) continue;

    const mid = round2((ask + bid) / 2);
    const limitPrice = round2(mid + PRICE_OFFSET);
    const shares = mid < 0.50 ? 20 : 10;

    if (limitPrice <= 0) continue;

    const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
    const res = await placeLimitBuy(tokenId, limitPrice, shares);

    const order = freshOrder(side, limitPrice, shares, res?.id || null);
    order.placedAtSec = nowSec() - p.windowStart;
    p.orders.push(order);

    log(`📍 ${side} resting buy: ${shares}sh @ ${limitPrice.toFixed(2)} (mid=${mid.toFixed(2)}, ask=${ask.toFixed(2)})`);
  }
  p.lastOrderTickSec = nowSec() - p.windowStart;
}

// Check all resting orders — fill when ask drops to limit price
async function checkRestingFills(p) {
  for (const order of p.orders) {
    if (order.state !== 'resting') continue;

    const ask = order.side === 'Up' ? p.upAsk : p.downAsk;
    if (ask == null) continue;

    if (ask <= order.limitPrice) {
      const cost = round2(order.limitPrice * order.shares);
      if (cost > p.bankroll) {
        log(`⏭️  ${order.side} fill detected but insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)}) — cancelling`);
        order.state = 'cancelled';
        if (order.orderId) cancelOrder(order.orderId);
        continue;
      }

      order.state = 'filled';
      order.fillPrice = order.limitPrice;
      order.cost = cost;
      p.bankroll = round2(p.bankroll - cost);

      log(`✅ ${order.side} FILLED: ${order.shares}sh @ ${order.fillPrice.toFixed(2)} | cost=$${cost.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { side: 'BUY', outcome: order.side, reason: 'RESTING-FILL', price: order.fillPrice, shares: order.shares, cost, fee: 0 });
      recordEquity(p);
    }
  }
}

// Cancel all unfilled resting orders at window end
async function cancelAllResting(p) {
  for (const order of p.orders) {
    if (order.state === 'resting') {
      order.state = 'cancelled';
      if (order.orderId) cancelOrder(order.orderId);
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
  } catch (_) {}
  if (p.upBid != null && p.downBid != null) return p.upBid >= p.downBid ? 'Up' : 'Down';
  return null;
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  // Cancel unfilled resting orders
  await cancelAllResting(p);

  const hasAnyFilled = p.orders.some(o => o.state === 'filled');
  const winnerSide = hasAnyFilled ? await determineWinningSide(p) : null;
  let windowProfit = 0;

  for (const order of p.orders) {
    if (order.state !== 'filled') continue;
    const won = winnerSide === order.side;
    const proceeds = won ? round2(order.shares * 1) : 0;
    const profit = round2(proceeds - order.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    windowProfit = round2(windowProfit + profit);
    const icon = won ? '💰' : '💥';
    log(`${icon} ${order.side} RESOLUTION ${won ? 'WON' : 'LOST'} | ${order.shares}sh @ ${order.fillPrice.toFixed(2)} | proceeds=$${proceeds.toFixed(2)} | cost=$${order.cost.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: order.side, winner: winnerSide, reason: 'RESOLUTION', price: won ? 1 : 0, shares: order.shares, proceeds, profit });
    if (won) p.wins++; else p.losses++;
  }

  const filledCount = p.orders.filter(o => o.state === 'filled').length;
  const cancelledCount = p.orders.filter(o => o.state === 'cancelled').length;
  log(`📊 Window closed | filled=${filledCount} cancelled=${cancelledCount} | window P&L=${windowProfit >= 0 ? '+' : ''}$${windowProfit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)} | total realized=$${p.realizedPnl.toFixed(2)}`);
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Main per-window tick
// ─────────────────────────────────────────
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable || !tradingEnabled) return;

  const elapsed = nowSec() - p.windowStart;

  // Resolve at window end
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
  if (p.resolvedThisWindow) return;

  // Place new resting orders every ORDER_TICK_SECS until ORDER_CUTOFF_SECS
  if (elapsed <= ORDER_CUTOFF_SECS) {
    const shouldPlace = p.orders.length === 0 || (elapsed - p.lastOrderTickSec >= ORDER_TICK_SECS);
    if (shouldPlace) {
      await placePeriodicOrders(p);
    }
  }

  // Check fills on all resting orders
  await checkRestingFills(p);
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const mark = positionsMarkValue(pair);
  const totalEquity = round2(pair.bankroll + mark);
  const costBasis = filledCostBasis(pair);
  const unrealized = round2(mark - costBasis);

  const restingOrders = pair.orders.filter(o => o.state === 'resting');
  const filledOrders = pair.orders.filter(o => o.state === 'filled');
  const cancelledOrders = pair.orders.filter(o => o.state === 'cancelled');

  const upMid = (pair.upAsk != null && pair.upBid != null) ? round2((pair.upAsk + pair.upBid) / 2) : null;
  const downMid = (pair.downAsk != null && pair.downBid != null) ? round2((pair.downAsk + pair.downBid) / 2) : null;

  // Current phase
  let phase = 'loading';
  if (pair.tradable && !pair.resolvedThisWindow) {
    const elapsed = nowSec() - pair.windowStart;
    if (elapsed <= ORDER_CUTOFF_SECS) phase = 'placing';
    else phase = 'holding';
  } else if (pair.resolvedThisWindow && pair.windowStart) {
    phase = 'closed';
  }

  const pairState = {
    symbol: pair.symbol, tradable: pair.tradable, slug: pair.slug, windowEnd: pair.windowEnd,
    secsToEnd: pair.windowEnd ? Math.max(0, Math.floor(pair.windowEnd - nowSec())) : null,
    phase,
    upAsk: pair.upAsk, upBid: pair.upBid, downAsk: pair.downAsk, downBid: pair.downBid,
    upMid, downMid,
    orders: pair.orders.map(o => ({
      side: o.side, limitPrice: o.limitPrice, shares: o.shares, state: o.state,
      fillPrice: o.fillPrice, cost: o.cost, placedAtSec: Math.round(o.placedAtSec),
    })),
    restingCount: restingOrders.length,
    filledCount: filledOrders.length,
    cancelledCount: cancelledOrders.length,
    bankroll: pair.bankroll, realizedPnl: pair.realizedPnl, unrealizedPnl: unrealized,
    markValue: totalEquity, feesPaid: pair.feesPaid, wins: pair.wins, losses: pair.losses,
    equityCurve: pair.equityCurve,
  };

  const totalWins = pair.wins, totalLosses = pair.losses;
  return {
    dryRun: DRY_RUN, tradingEnabled,
    totalCapital: TOTAL_CAPITAL, totalBankroll: pair.bankroll, totalMarkValue: totalEquity,
    totalRealizedPnl: pair.realizedPnl, totalUnrealizedPnl: unrealized, totalPnl: round2(totalEquity - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid: pair.feesPaid,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      priceOffset: PRICE_OFFSET, orderTickSecs: ORDER_TICK_SECS, orderCutoffSecs: ORDER_CUTOFF_SECS,
    },
    pairState, totalEquityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
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
      try { await processPair(pair); } catch (e) { log(`⚠️  ${pair.symbol} tick error: ${e.message}`); }
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (existing resting orders still tracked)'); return { ok: true }; }
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
  log(`🚀 BTC Periodic Resting Limit Buy Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} capital | every ${ORDER_TICK_SECS}s place resting buy at mid${PRICE_OFFSET} until ${ORDER_CUTOFF_SECS}s | size: 20sh if mid<0.50, 10sh if mid>=0.50 | Up/Down independent | fill when ask walks to limit price | ride to resolution`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, pauseTrading, resumeTrading, setMode, getStatus, buildState };
