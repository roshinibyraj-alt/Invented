'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — INDEPENDENT SIDE BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  UP and DOWN are completely independent. Each side checks its
 *  own mid price against the 0.50 threshold at every 15s tick.
 *
 *  ┌─ Phase 1 (0s → 135s, every 15s) ───────────────────────────┐
 *  │  For each side: if mid < 0.50 → limit buy 10sh at mid     │
 *  │  Both sides can fire at the same tick.                    │
 *  └────────────────────────────────────────────────────────────┘
 *
 *  ┌─ Phase 2 (135s → 270s, every 15s) ─────────────────────────┐
 *  │  For each side: if mid > 0.50 → limit buy 20sh at mid     │
 *  └────────────────────────────────────────────────────────────┘
 *
 *  ┌─ TP (280s) ─────────────────────────────────────────────────┐
 *  │  For every filled position, limit sell @ 0.99.             │
 *  └────────────────────────────────────────────────────────────┘
 *
 *  ┌─ Resolution (window end) ───────────────────────────────────┐
 *  │  Polymarket outcome for unsettled positions.               │
 *  └────────────────────────────────────────────────────────────┘
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const ORDER_INTERVAL_S      = 15;
const PHASE1_ORDERS         = 9;
const PHASE2_ORDERS         = 9;
const PHASE1_START_S        = 0;
const PHASE2_START_S        = 135;
const TP_TIME_S             = 280;
const RESOLUTION_BUFFER_S   = 8;
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];
const THRESHOLD_PRICE       = 0.50;

const PHASE1_BASE_SHARES = Number(process.env.PHASE1_SHARES || 10);
const PHASE2_BASE_SHARES = Number(process.env.PHASE2_SHARES || 20);
const FIXED_TP_PRICE     = Number(process.env.TP_PRICE || 0.99);

const CRYPTO_TAKER_FEE_RATE    = 0.07;
const CRYPTO_MAKER_REBATE_SHARE = 0.20;

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

let trader, emitFn, slog = () => {};
let startTime = Date.now(), logs = [], trades = [];
let tradingEnabled = true;
let pairList = [...DEFAULT_PAIRS];
let perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
let pairs = {};
let lastPolyPriceFetch = 0;
let totalEquityCurve = [];

const ORDER_SCHEDULE = [];
for (let i = 0; i < PHASE1_ORDERS; i++) {
  ORDER_SCHEDULE.push({ time: PHASE1_START_S + i * ORDER_INTERVAL_S, phase: 1 });
}
for (let i = 0; i < PHASE2_ORDERS; i++) {
  ORDER_SCHEDULE.push({ time: PHASE2_START_S + i * ORDER_INTERVAL_S, phase: 2 });
}

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
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-bot/2.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-bot/2.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

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
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

function computeMid(ask, bid) {
  if (ask == null || bid == null) return null;
  return round5((ask + bid) / 2);
}

function freshPairState(symbol) {
  return {
    symbol, tradable: false,
    windowStart: null, windowEnd: null,
    slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    orders: [],
    nextOrderIx: 0,
    tpPlaced: false,
    scaleFactor: 1.0,
    baseCapital: perPairCapital,
    bankroll: perPairCapital,
    realizedPnl: 0, feesPaid: 0, rebatesEarned: 0,
    wins: 0, losses: 0,
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
  p.orders = [];
  p.nextOrderIx = 0;
  p.tpPlaced = false;
  p.scaleFactor = Math.max(0.1, p.bankroll / p.baseCapital);
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11, 19)}Z | scale=${p.scaleFactor.toFixed(2)}x`);
}

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
  function apply(tid, side, price) {
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
        apply(tid, side, price);
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (val && typeof val === 'object') {
          if (val.BUY != null) apply(tid, 'BUY', parseFloat(val.BUY));
          if (val.SELL != null) apply(tid, 'SELL', parseFloat(val.SELL));
        }
      }
    }
  } catch (_) {
    for (const p of Object.values(pairs)) {
      if (!p.tradable || !p.upTokenId || !p.downTokenId) continue;
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
      } catch (_) {}
    }
  }
}

function positionMarkValue(p, o) {
  if (!o || (o.state !== 'filled' && o.state !== 'tp-resting')) return 0;
  const bid = o.side === 'Up' ? p.upBid : p.downBid;
  const price = bid ?? o.price;
  return round2(o.shares * price);
}
function pairMarkValue(p) {
  const posValue = p.orders.reduce((s, o) => s + positionMarkValue(p, o), 0);
  return round2(p.bankroll + posValue);
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

// ── Independent side order placement ──
async function tryPlaceBuy(p, side, slot) {
  const baseShares = slot.phase === 1 ? PHASE1_BASE_SHARES : PHASE2_BASE_SHARES;
  const shares = Math.max(1, Math.round(baseShares * p.scaleFactor));
  const mid = computeMid(
    side === 'Up' ? p.upAsk : p.downAsk,
    side === 'Up' ? p.upBid : p.downBid
  );
  if (mid == null) return;

  const condition = slot.phase === 1 ? (mid < THRESHOLD_PRICE) : (mid > THRESHOLD_PRICE);
  if (!condition) return;

  const cost = round2(mid * shares);
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  const orderResult = await placeLimitBuy(tokenId, mid, shares);

  const orderEntry = {
    phase: slot.phase, side, price: mid,
    shares, cost, state: 'resting',
    buyOrderId: orderResult.id || orderResult.orderId || null,
    tpOrderId: null, placedAt: Date.now(),
    filledAt: null, tpFilledAt: null,
    rebate: null, profit: null,
  };
  p.orders.push(orderEntry);

  const dir = slot.phase === 1 ? '↓' : '↑';
  log(`📌 ${p.symbol} P${slot.phase} ${dir}${side} @ ${slot.time}s: buy ${shares}sh @ ${mid.toFixed(5)} (mid ${dir}${THRESHOLD_PRICE}) [scale=${p.scaleFactor.toFixed(2)}x]`);
}

async function placeScheduledOrder(p, slot) {
  // Phase 1: buy if mid < 0.50. Phase 2: buy if mid > 0.50.
  await tryPlaceBuy(p, 'Up', slot);
  await tryPlaceBuy(p, 'Down', slot);
}

// ── Fill check ──
async function checkOrderFills(p) {
  for (const o of p.orders) {
    if (o.state !== 'resting') continue;
    const ask = o.side === 'Up' ? p.upAsk : p.downAsk;
    if (ask == null || ask > o.price) continue;
    const rebate = makerRebate(o.shares, o.price);
    p.bankroll = round2(p.bankroll - o.cost + rebate);
    p.realizedPnl = round2(p.realizedPnl + rebate);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    o.state = 'filled';
    o.filledAt = Date.now();
    o.rebate = rebate;
    log(`🎯 ${p.symbol} P${o.phase} BUY filled ${o.shares}sh @ ${o.price.toFixed(5)} on ${o.side} | cost=$${o.cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)}`);
    registerTrade(p, { side: 'BUY', outcome: o.side, price: o.price, shares: o.shares, cost: o.cost, rebate, reason: `P${o.phase}` });
    recordEquity(p);
  }
}

// ── TP placement ──
async function ensureTpsPlaced(p) {
  const elapsed = nowSec() - p.windowStart;
  if (elapsed < TP_TIME_S) return;
  let placedAny = false;
  for (const o of p.orders) {
    if (o.state !== 'filled') continue;
    if (o.tpOrderId) continue;
    const tokenId = o.side === 'Up' ? p.upTokenId : p.downTokenId;
    const tpOrder = await placeLimitSell(tokenId, FIXED_TP_PRICE, o.shares);
    o.tpOrderId = tpOrder.id || tpOrder.orderId || null;
    o.state = 'tp-resting';
    placedAny = true;
    log(`🧯 ${p.symbol} TP placed: sell ${o.shares}sh @ ${FIXED_TP_PRICE} on ${o.side} (P${o.phase})`);
  }
  if (!p.tpPlaced) {
    if (!placedAny) {
      const restingCount = p.orders.filter(o => o.state === 'resting').length;
      log(`⏰ ${p.symbol}: TP time — no filled positions yet (${restingCount} orders still resting)`);
    }
    p.tpPlaced = true;
    recordEquity(p);
  }
}

// ── TP fill check ──
async function checkTpFills(p) {
  for (const o of p.orders) {
    if (o.state !== 'tp-resting') continue;
    const bid = o.side === 'Up' ? p.upBid : p.downBid;
    if (bid == null || bid < FIXED_TP_PRICE) continue;
    const proceeds = round2(FIXED_TP_PRICE * o.shares);
    const rebate = makerRebate(o.shares, FIXED_TP_PRICE);
    const net = round2(proceeds + rebate);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - o.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    p.wins++;
    o.state = 'tp-filled';
    o.tpFilledAt = Date.now();
    o.profit = profit;
    log(`💰 ${p.symbol} TP filled ${o.shares}sh @ ${FIXED_TP_PRICE} on ${o.side} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: o.side, reason: 'TP', price: FIXED_TP_PRICE, shares: o.shares, profit, rebate });
    recordEquity(p);
  }
}

// ── Window resolution ──
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
  for (const o of p.orders) {
    if (o.state === 'resting') {
      await cancelOrder(o.buyOrderId);
      log(`🛑 ${p.symbol}: P${o.phase} ${o.side} order at ${o.price.toFixed(5)} never filled — cancelled`);
      o.state = 'cancelled';
    }
  }
  const unresolved = p.orders.filter(o => o.state === 'filled' || o.state === 'tp-resting');
  if (unresolved.length === 0) {
    log(`✅ ${p.symbol}: window resolved — no unsettled positions`);
    recordEquity(p);
    p.scaleFactor = Math.max(0.1, p.bankroll / p.baseCapital);
    return;
  }
  for (const o of unresolved) {
    if (o.tpOrderId) await cancelOrder(o.tpOrderId);
  }
  const winner = await determineWinningSide(p);
  if (!winner) {
    log(`⚠️  ${p.symbol}: couldn't determine winner, marking unresolved`);
    return;
  }
  for (const o of unresolved) {
    const won = winner === o.side;
    const proceeds = won ? round2(o.shares * 1) : 0;
    const profit = round2(proceeds - o.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    o.state = 'resolved';
    o.profit = profit;
    if (won) { p.wins++; } else { p.losses++; }
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION ${o.side} ${o.shares}sh entry=$${o.price.toFixed(5)} exit=${won ? '$1.00' : '$0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: o.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: o.shares, profit });
  }
  recordEquity(p);
  p.scaleFactor = Math.max(0.1, p.bankroll / p.baseCapital);
  log(`📊 ${p.symbol}: window complete — bankroll=$${p.bankroll.toFixed(2)} | scale=${p.scaleFactor.toFixed(3)}x`);
}

// ── Per-pair tick ──
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable) return;
  if (!tradingEnabled) return;
  const elapsed = nowSec() - p.windowStart;
  while (p.nextOrderIx < ORDER_SCHEDULE.length && elapsed >= ORDER_SCHEDULE[p.nextOrderIx].time) {
    await placeScheduledOrder(p, ORDER_SCHEDULE[p.nextOrderIx]);
    p.nextOrderIx++;
  }
  await checkOrderFills(p);
  await ensureTpsPlaced(p);
  await checkTpFills(p);
  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ── State builder ──
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const ep = p.windowStart ? nowSec() - p.windowStart : 0;
    const secsToEnd = p.windowEnd ? p.windowEnd - nowSec() : 0;
    const totalPlaced = p.orders.length;
    const totalResting = p.orders.filter(o => o.state === 'resting').length;
    const totalFilled = p.orders.filter(o => o.state === 'filled' || o.state === 'tp-resting' || o.state === 'tp-filled' || o.state === 'resolved').length;
    const totalTpFilled = p.orders.filter(o => o.state === 'tp-filled').length;
    const totalResolved = p.orders.filter(o => o.state === 'resolved').length;
    const phase1Count = p.orders.filter(o => o.phase === 1).length;
    const phase2Count = p.orders.filter(o => o.phase === 2).length;

    // Per-side counts
    const upOrders = p.orders.filter(o => o.side === 'Up');
    const downOrders = p.orders.filter(o => o.side === 'Down');
    const upPlaced = upOrders.length;
    const downPlaced = downOrders.length;
    const upFilled = upOrders.filter(o => o.state === 'filled' || o.state === 'tp-resting' || o.state === 'tp-filled' || o.state === 'resolved').length;
    const downFilled = downOrders.filter(o => o.state === 'filled' || o.state === 'tp-resting' || o.state === 'tp-filled' || o.state === 'resolved').length;
    const upTpFilled = upOrders.filter(o => o.state === 'tp-filled').length;
    const downTpFilled = downOrders.filter(o => o.state === 'tp-filled').length;
    const upResolved = upOrders.filter(o => o.state === 'resolved').length;
    const downResolved = downOrders.filter(o => o.state === 'resolved').length;
    const upResting = upOrders.filter(o => o.state === 'resting').length;
    const downResting = downOrders.filter(o => o.state === 'resting').length;

    // Get the last mid prices for display
    const upMid = computeMid(p.upAsk, p.upBid);
    const downMid = computeMid(p.downAsk, p.downBid);

    const filledPositions = p.orders
      .filter(o => o.state === 'filled' || o.state === 'tp-resting' || o.state === 'tp-filled' || o.state === 'resolved')
      .map(o => ({
        phase: o.phase, side: o.side, shares: o.shares,
        price: o.price, cost: o.cost, state: o.state, profit: o.profit,
      }));

    const totalFilledShares = filledPositions.reduce((s, o) => s + o.shares, 0);

    return {
      symbol: p.symbol, tradable: p.tradable,
      windowElapsed: Math.max(0, Math.round(ep)),
      secsToEnd: Math.round(secsToEnd),
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      upMid, downMid,
      bankroll: p.bankroll, baseCapital: p.baseCapital, scaleFactor: p.scaleFactor,
      realizedPnl: round2(p.realizedPnl),
      feesPaid: p.feesPaid, rebatesEarned: p.rebatesEarned,
      wins: p.wins, losses: p.losses,
      ordersPlaced: totalPlaced, ordersResting: totalResting,
      ordersFilled: totalFilled, ordersTpFilled: totalTpFilled, ordersResolved: totalResolved,
      phase1Count, phase2Count,
      upPlaced, downPlaced, upFilled, downFilled,
      upTpFilled, downTpFilled, upResolved, downResolved,
      upResting, downResting,
      totalFilledShares, filledPositions,
      markValue: pairMarkValue(p),
      unrealizedPnl: round2(pairMarkValue(p) - p.bankroll),
      equityCurve: p.equityCurve, slug: p.slug,
    };
  });

  const totalBankroll = round2(pairStates.reduce((s, p) => s + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((s, p) => s + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((s, p) => s + p.realizedPnl, 0));
  const totalWins = pairStates.reduce((s, p) => s + p.wins, 0);
  const totalLosses = pairStates.reduce((s, p) => s + p.losses, 0);
  const totalFeesPaid = round2(pairStates.reduce((s, p) => s + p.feesPaid, 0));
  const totalRebatesEarned = round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0));

  return {
    dryRun: DRY_RUN, tradingEnabled, pairs: pairList,
    totalCapital: TOTAL_CAPITAL, perPairCapital,
    totalBankroll, totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized,
    totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid, totalRebatesEarned,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      phase1BaseShares: PHASE1_BASE_SHARES, phase2BaseShares: PHASE2_BASE_SHARES,
      fixedTpPrice: FIXED_TP_PRICE, orderIntervalS: ORDER_INTERVAL_S,
      phase1Orders: PHASE1_ORDERS, phase2Orders: PHASE2_ORDERS,
      tpTimeS: TP_TIME_S, thresholdPrice: THRESHOLD_PRICE,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates, totalEquityCurve,
    logs: logs.slice(-100),
    trades: trades.slice(-80).reverse(),
  };
}

// ── Main loop ──
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
  log('⏸️  Trading paused');
  return { ok: true };
}
function resumeTrading() {
  tradingEnabled = true;
  log('▶️  Trading resumed');
  return { ok: true };
}
function getStatus() { return { ok: true, ...buildState() }; }

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 5-Minute Crypto Up/Down — Independent Side Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  P1: every ${ORDER_INTERVAL_S}s, ${PHASE1_BASE_SHARES}sh per side if mid<${THRESHOLD_PRICE} | P2: ${PHASE2_BASE_SHARES}sh per side if mid>${THRESHOLD_PRICE} TP@${FIXED_TP_PRICE} at ${TP_TIME_S}s`);
  log(`⚙️  fees: all orders maker (0 taker fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN' : '🔴 LIVE MODE'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
