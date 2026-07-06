'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — TIME DECAY MOMENTUM CONTINUATION
 * ═══════════════════════════════════════════════════════════════
 *
 *  DETECT momentum: if a side's mid price deviates > threshold
 *  from 0.50 early in window → BUY that SIDE (momentum continuation
 *  toward 1.00).
 *
 *  TIME DECAY makes everything size/TP/SL proportional to
 *  timeRemaining / totalWindow:
 *    • More time left → bigger position, higher TP, wider SL
 *    • Less time left → smaller position, lower TP, tighter SL
 *
 *  Max 5 momentum trades per window per pair.
 *  All orders are maker limit (fee-free + rebate).
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Core timing ──
const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const ENTRY_CUTOFF_SECS     = 280;
const RESOLUTION_BUFFER_S   = 8;
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

// ── Strategy params ──
const CHECK_INTERVAL_S         = Number(process.env.CHECK_INTERVAL_S || 10);
const OVERREACTION_THRESHOLD   = Number(process.env.OVERREACTION_THRESHOLD || 0.12);
const BASE_SHARES              = Number(process.env.BASE_SHARES || 20);
const MAX_TRADES_PER_WINDOW    = Number(process.env.MAX_TRADES || 5);
const TP_TARGET_PRICE          = Number(process.env.TP_TARGET || 0.50);
const SL_BASE_FRACTION         = Number(process.env.SL_BASE_FRACTION || 0.50);

// ── Fees ──
const CRYPTO_TAKER_FEE_RATE    = 0.07;
const CRYPTO_MAKER_REBATE_SHARE = 0.20;

// ── Env ──
const DRY_RUN      = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
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

// ── Helpers ──
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}
function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── API ──
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-bot/3.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-bot/3.0' },
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

// ── State management ──
function freshTradeEntry() {
  return {
    id: `t${Date.now()}-${(Math.random() * 1e6).toFixed(0)}`,
    side: null,          // 'Up' or 'Down' — the momentum side we BOUGHT
    entryPrice: null,
    shares: 0,
    cost: 0,
    tpPrice: null,       // sell price for TP (above entry)
    slPrice: null,       // sell price for SL (below entry)
    placedAt: null,
    filledAt: null,
    buyOrderId: null,
    tpOrderId: null,
    slOrderId: null,
    state: 'idle',       // idle → resting → filled → tp-sl-placed → tp-filled|sl-filled|resolved
    profit: null,
    rebate: null,
    timeFactorAtEntry: 0,
    deviationAtEntry: 0,
    tpFilledAt: null,
    slFilledAt: null,
  };
}

function freshPairState(symbol) {
  return {
    symbol, tradable: false,
    windowStart: null, windowEnd: null,
    slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    // Overreversion trades
    reversionTrades: [],   // active trade entries
    lastCheckTick: 0,      // last CHECK_INTERVAL_S we processed
    resolvedThisWindow: true,
    bankroll: perPairCapital,
    realizedPnl: 0, feesPaid: 0, rebatesEarned: 0,
    wins: 0, losses: 0,
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

// ── Window slug / market lookup ──
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
  const market = (event.markets || []).find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];
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
  // Clear previous window's trades
  const carryOver = p.reversionTrades.filter(t =>
    t.state === 'tp-resting' || t.state === 'tp-sl-placed' || t.state === 'filled' || t.state === 'resting'
  );
  if (carryOver.length > 0) {
    log(`⚠️  ${p.symbol}: ${carryOver.length} trade(s) carried over from previous window`);
    for (const t of carryOver) {
      if (t.buyOrderId) await cancelOrder(t.buyOrderId);
      if (t.tpOrderId) await cancelOrder(t.tpOrderId);
      if (t.slOrderId) await cancelOrder(t.slOrderId);
      t.state = 'cancelled';
    }
  }
  p.reversionTrades = [];
  p.lastCheckTick = 0;
  log(`🔭 ${p.symbol} new window: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11, 19)}Z`);
}

// ── Price refresh ──
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
        const price = parseFloat(row.price || row.mid);
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
    // Fallback: individual price fetches
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

// ── Mark value / equity ──
function pairMarkValue(p) {
  let posVal = 0;
  for (const t of p.reversionTrades) {
    if (t.state === 'filled' || t.state === 'tp-sl-placed' || t.state === 'tp-resting' || t.state === 'sl-resting') {
      const bid = t.side === 'Up' ? p.upBid : p.downBid;
      posVal += round2(t.shares * (bid ?? t.entryPrice));
    }
  }
  return round2(p.bankroll + posVal);
}

function recordEquity(p) {
  p.equityCurve.push({ t: Date.now(), equity: pairMarkValue(p) });
  if (p.equityCurve.length > 300) p.equityCurve.shift();
  const total = round2(Object.values(pairs).reduce((s, p) => s + pairMarkValue(p), 0));
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > 500) totalEquityCurve.shift();
}

function registerTrade(p, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: p.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ═══════════════════════════════════════════════════════════════
//  TIME DECAY MOMENTUM CONTINUATION STRATEGY
// ═══════════════════════════════════════════════════════════════

/**
 * Time decay factor: 1.0 at window open → 0.0 at window close.
 * Controls position sizing, TP targets, and SL tightness.
 */
function timeDecayFactor(p) {
  if (!p.windowStart) return 0;
  const elapsed = nowSec() - p.windowStart;
  return Math.max(0.05, Math.min(1.0, 1.0 - elapsed / WINDOW_SECS));
}

/**
 * Detect overreaction: is either side's mid price too far from 0.50?
 * Returns { cheapSide, cheapPrice, deviation } or null.
 */
function detectOverreaction(p) {
  const upMid = computeMid(p.upAsk, p.upBid);
  const downMid = computeMid(p.downAsk, p.downBid);
  if (upMid == null || downMid == null) return null;

  const upDev = Math.abs(upMid - 0.50);
  const downDev = Math.abs(downMid - 0.50);

  // At least one side must be overreacted
  if (upDev < OVERREACTION_THRESHOLD && downDev < OVERREACTION_THRESHOLD) return null;

  // Ensure the deviation is meaningful — the spread between sides
  const spread = Math.abs(upMid - downMid);
  if (spread < OVERREACTION_THRESHOLD * 1.5) return null;

  // Cheap side = lower price; expensive side = higher price.
  // (UP/DOWN mids always straddle ~0.50, so compare directly.
  //  Using price order avoids IEEE 754 precision bugs when
  //  the two sides have equal deviation e.g. 0.70 vs 0.30.)
  if (upMid <= downMid) {
    // UP is cheaper → buy UP
    return { cheapSide: 'Up', cheapPrice: upMid, expensiveSide: 'Down', expensivePrice: downMid, deviation: round5(0.50 - upMid) };
  } else {
    // DOWN is cheaper → buy DOWN
    return { cheapSide: 'Down', cheapPrice: downMid, expensiveSide: 'Up', expensivePrice: upMid, deviation: round5(0.50 - downMid) };
  }
}

/**
 * Calculate position size based on time decay.
 * Earlier window + bigger deviation → more shares.
 */
function calcReversionSize(deviation) {
  const pair = Object.values(pairs)[0];
  if (!pair) return BASE_SHARES;
  const tf = timeDecayFactor(pair);
  // deviationFactor: how extreme is the cheap side (0.0-1.0)
  const deviationFactor = Math.min(1.0, deviation / 0.50);
  // timeFactor: scales from max at t=0 to min at t=300
  const timeFactor = 0.2 + 0.8 * tf; // 0.2 to 1.0
  const size = Math.round(BASE_SHARES * timeFactor * (0.5 + 0.5 * deviationFactor));
  return Math.max(1, size);
}

/**
 * Calculate TP and SL prices based on time decay.
 * Early → TP near 0.50, SL wider.
 * Late → TP closer to entry, SL tighter.
 */
function calcMomentumTpSl(entryPrice) {
  const pair = Object.values(pairs)[0];
  const tf = pair ? timeDecayFactor(pair) : 0.5;

  // MOMENTUM TP/SL: buy the side moving away from 0.50,
  // expecting continuation toward 1.00.
  //
  // TP: capture 40-85% of remaining distance to 1.00.
  //   tf=1.0 (early): entry + (1.00-entry)*0.85 — target 0.95 for entry 0.70
  //   tf=0.2 (late):  entry + (1.00-entry)*0.44 — target 0.83 for entry 0.70
  //
  // SL: protect against reversion toward 0.50.
  //   tf=1.0 (early): keep 50% of entry — 35¢ buffer for entry 0.70
  //   tf=0.2 (late):  keep 75% of entry — 17.5¢ buffer for entry 0.70
  const continuationDist = 1.00 - entryPrice;
  const tpCapture = 0.40 + 0.45 * tf;
  const tpPrice = round5(entryPrice + continuationDist * tpCapture);

  const slKeepFraction = 0.50 + 0.25 * tf;
  const slPrice = round5(entryPrice * slKeepFraction);

  return {
    tpPrice: Math.max(entryPrice + 0.005, Math.min(0.995, tpPrice)),
    slPrice: Math.max(0.005, slPrice),
  };
}

/**
 * Try to place one overreversion trade.
 */
async function tryPlaceReversionTrade(p, signal) {
  if (!tradingEnabled) return;
  const elapsed = nowSec() - p.windowStart;
  if (elapsed >= ENTRY_CUTOFF_SECS) return;

  // Count active trades (exclude resolved/cancelled)
  const activeTrades = p.reversionTrades.filter(t =>
    t.state === 'resting' || t.state === 'filled' || t.state === 'tp-sl-placed' ||
    t.state === 'tp-resting' || t.state === 'sl-resting'
  );
  if (activeTrades.length >= MAX_TRADES_PER_WINDOW) return;

  // Don't re-trade the same cheap side if we already have an unfilled resting buy on it
  const hasPendingBuy = activeTrades.some(t =>
    t.side === signal.cheapSide && (t.state === 'resting')
  );
  if (hasPendingBuy) return;

  const tf = timeDecayFactor(p);
  const shares = calcReversionSize(signal.deviation);
  const cost = round2(signal.cheapPrice * shares);
  const { tpPrice, slPrice } = calcTpSl(signal.cheapPrice);

  const expiry = signal.cheapSide === 'Up' ? p.upTokenId : p.downTokenId;
  if (!expiry) return;

  const orderResult = await placeLimitBuy(expiry, signal.cheapPrice, shares);

  const trade = freshTradeEntry();
  trade.side = signal.cheapSide;
  trade.entryPrice = signal.cheapPrice;
  trade.shares = shares;
  trade.cost = cost;
  trade.tpPrice = tpPrice;
  trade.slPrice = slPrice;
  trade.placedAt = Date.now();
  trade.buyOrderId = orderResult.id || orderResult.orderId || null;
  trade.state = 'resting';
  trade.timeFactorAtEntry = round2(tf);
  trade.deviationAtEntry = round5(signal.deviation);

  p.reversionTrades.push(trade);

  const emoji = signal.cheapSide === 'Up' ? '🟢' : '🔴';
  log(`${emoji} ${p.symbol} OVERREVERSION: buy ${signal.cheapSide} ${shares}sh @ ${signal.cheapPrice.toFixed(4)} ` +
    `(dev=${signal.deviation.toFixed(3)}, tf=${tf.toFixed(2)}) TP=${tpPrice.toFixed(4)} SL=${slPrice.toFixed(4)} ` +
    `[trade ${activeTrades.length + 1}/${MAX_TRADES_PER_WINDOW}]`);
}

/**
 * Check fills on resting buy orders → on fill, place TP + SL sells.
 */
async function manageTpSl(p) {
  for (const t of p.reversionTrades) {
    if (t.state !== 'resting') continue;

    // Check if our buy filled
    const ask = t.side === 'Up' ? p.upAsk : p.downAsk;
    if (ask == null || ask > t.entryPrice) continue;

    const rebate = makerRebate(t.shares, t.entryPrice);
    p.bankroll = round2(p.bankroll - t.cost + rebate);
    p.realizedPnl = round2(p.realizedPnl + rebate);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    t.state = 'filled';
    t.filledAt = Date.now();
    t.rebate = rebate;

    log(`🎯 ${p.symbol} BUY filled ${t.shares}sh ${t.side} @ ${t.entryPrice.toFixed(4)} | cost=$${t.cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)}`);

    // Place TP and SL sells
    const tokenId = t.side === 'Up' ? p.upTokenId : p.downTokenId;
    if (!tokenId) continue;

    // Place TP sell
    const tpOrder = await placeLimitSell(tokenId, t.tpPrice, t.shares);
    t.tpOrderId = tpOrder.id || tpOrder.orderId || null;

    // Place SL sell
    const slOrder = await placeLimitSell(tokenId, t.slPrice, t.shares);
    t.slOrderId = slOrder.id || slOrder.orderId || null;

    t.state = 'tp-sl-placed';
    log(`🧯 ${p.symbol} TP/SL placed: TP sell @ ${t.tpPrice.toFixed(4)}, SL sell @ ${t.slPrice.toFixed(4)} on ${t.side}`);

    registerTrade(p, {
      side: 'BUY', outcome: t.side, price: t.entryPrice, shares: t.shares,
      cost: t.cost, rebate, reason: 'OVERREVERSION',
    });
    recordEquity(p);
  }
}

/**
 * Check if TP or SL sell orders got filled.
 */
async function checkTpSlFills(p) {
  for (const t of p.reversionTrades) {
    if (t.state !== 'tp-sl-placed') continue;

    // Check TP fill
    if (t.tpOrderId) {
      const tpBid = t.side === 'Up' ? p.upBid : p.downBid;
      if (tpBid != null && tpBid >= t.tpPrice) {
        const proceeds = round2(t.tpPrice * t.shares);
        const rebate = makerRebate(t.shares, t.tpPrice);
        const net = round2(proceeds + rebate);
        p.bankroll = round2(p.bankroll + net);
        const profit = round2(net - t.cost);
        p.realizedPnl = round2(p.realizedPnl + profit);
        p.rebatesEarned = round2(p.rebatesEarned + rebate);
        p.wins++;
        t.state = 'tp-filled';
        t.tpFilledAt = Date.now();
        t.profit = profit;
        // Cancel SL
        await cancelOrder(t.slOrderId);
        log(`💰 ${p.symbol} TP FILLED ${t.shares}sh ${t.side} @ ${t.tpPrice.toFixed(4)} | pnl=$${profit.toFixed(2)}`);
        registerTrade(p, {
          side: 'SELL', outcome: t.side, reason: 'TP', price: t.tpPrice,
          shares: t.shares, profit, rebate,
        });
        recordEquity(p);
        continue;
      }
    }

    // Check SL fill
    if (t.slOrderId) {
      const slBid = t.side === 'Up' ? p.upBid : p.downBid;
      if (slBid != null && slBid <= t.slPrice) {
        const proceeds = round2(t.slPrice * t.shares);
        const rebate = makerRebate(t.shares, t.slPrice);
        const net = round2(proceeds + rebate);
        p.bankroll = round2(p.bankroll + net);
        const profit = round2(net - t.cost);
        p.realizedPnl = round2(p.realizedPnl + profit);
        p.rebatesEarned = round2(p.rebatesEarned + rebate);
        p.losses++;
        t.state = 'sl-filled';
        t.slFilledAt = Date.now();
        t.profit = profit;
        // Cancel TP
        await cancelOrder(t.tpOrderId);
        log(`🛑 ${p.symbol} SL FILLED ${t.shares}sh ${t.side} @ ${t.slPrice.toFixed(4)} | pnl=$${profit.toFixed(2)}`);
        registerTrade(p, {
          side: 'SELL', outcome: t.side, reason: 'SL', price: t.slPrice,
          shares: t.shares, profit, rebate,
        });
        recordEquity(p);
        continue;
      }
    }
  }
}

/**
 * Cancel unfilled TP/SL orders at window end, let resolution handle rest.
 */
async function resolveOverreversionTrades(p) {
  for (const t of p.reversionTrades) {
    if (t.state === 'resting') {
      await cancelOrder(t.buyOrderId);
      log(`🛑 ${p.symbol}: overreversion buy on ${t.side} @ ${t.entryPrice.toFixed(4)} never filled — cancelled`);
      t.state = 'cancelled';
      continue;
    }
    if (t.state === 'tp-sl-placed') {
      // Cancel TP and SL, position goes to resolution
      await cancelOrder(t.tpOrderId);
      await cancelOrder(t.slOrderId);
    }
  }
}

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

  await resolveMomentumTrades(p);

  // Resolve still-held positions
  const unresolved = p.reversionTrades.filter(t =>
    t.state === 'filled' || t.state === 'tp-sl-placed' || t.state === 'tp-resting' || t.state === 'sl-resting'
  );
  if (unresolved.length === 0) {
    log(`✅ ${p.symbol}: window resolved — no unsettled positions`);
    recordEquity(p);
    return;
  }

  const winner = await determineWinningSide(p);
  if (!winner) {
    log(`⚠️  ${p.symbol}: couldn't determine winner, marking unresolved`);
    return;
  }

  for (const t of unresolved) {
    const won = winner === t.side;
    const proceeds = won ? round2(t.shares * 1) : 0;
    const profit = round2(proceeds - t.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    t.state = 'resolved';
    t.profit = profit;
    if (won) p.wins++; else p.losses++;
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION ${t.side} ${t.shares}sh entry=$${t.entryPrice.toFixed(4)} exit=${won ? '$1.00' : '$0.00'}/sh | pnl=$${profit.toFixed(2)}`);
    registerTrade(p, {
      side: 'SELL', outcome: t.side, reason: 'RESOLUTION',
      price: won ? 1 : 0, shares: t.shares, profit,
    });
  }
  recordEquity(p);
  log(`📊 ${p.symbol}: window complete — bankroll=$${p.bankroll.toFixed(2)}`);
}

// ── Per-pair tick ──
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable) return;

  const elapsed = nowSec() - p.windowStart;

  // Phase 1: detect overreactions and place reversion trades (every CHECK_INTERVAL_S)
  if (tradingEnabled && elapsed < ENTRY_CUTOFF_SECS) {
    const tickSlot = Math.floor(elapsed / CHECK_INTERVAL_S);
    if (tickSlot > p.lastCheckTick) {
      p.lastCheckTick = tickSlot;
      const signal = detectMomentumSignal(p);
      if (signal) {
        await tryPlaceMomentumTrade(p, signal);
      }
    }
  }

  // Phase 2: manage fills → TP/SL placement
  await manageTpSl(p);

  // Phase 3: check TP/SL fills
  await checkTpSlFills(p);

  // Phase 4: window close / resolution
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
    const activeTrades = p.reversionTrades.filter(t =>
      t.state === 'resting' || t.state === 'filled' || t.state === 'tp-sl-placed'
    );
    const tpFilled = p.reversionTrades.filter(t => t.state === 'tp-filled').length;
    const slFilled = p.reversionTrades.filter(t => t.state === 'sl-filled').length;
    const resolved = p.reversionTrades.filter(t => t.state === 'resolved').length;
    const totalPlaced = p.reversionTrades.length;

    const upMid = computeMid(p.upAsk, p.upBid);
    const downMid = computeMid(p.downAsk, p.downBid);

    return {
      symbol: p.symbol, tradable: p.tradable,
      windowElapsed: Math.max(0, Math.round(ep)),
      secsToEnd: Math.round(secsToEnd),
      timeDecayFactor: round2(p.windowStart ? Math.max(0.05, 1.0 - ep / WINDOW_SECS) : 0),
      upAsk: p.upAsk, upBid: p.upBid, upMid,
      downAsk: p.downAsk, downBid: p.downBid, downMid,
      upDeviation: upMid != null ? round5(Math.abs(upMid - 0.50)) : null,
      downDeviation: downMid != null ? round5(Math.abs(downMid - 0.50)) : null,
      bankroll: p.bankroll,
      realizedPnl: round2(p.realizedPnl),
      rebatesEarned: p.rebatesEarned,
      wins: p.wins, losses: p.losses,
      tradesPlaced: totalPlaced,
      tradesActive: activeTrades.length,
      tradesTpFilled: tpFilled,
      tradesSlFilled: slFilled,
      tradesResolved: resolved,
      maxTrades: MAX_TRADES_PER_WINDOW,
      // Detailed trade info for dashboard
      activeTrades: activeTrades.map(t => ({
        id: t.id,
        side: t.side,
        entryPrice: t.entryPrice,
        shares: t.shares,
        tpPrice: t.tpPrice,
        slPrice: t.slPrice,
        state: t.state,
        timeFactorAtEntry: t.timeFactorAtEntry,
        deviationAtEntry: t.deviationAtEntry,
        profit: t.profit,
      })),
      allTrades: p.reversionTrades.map(t => ({
        side: t.side, entryPrice: t.entryPrice, shares: t.shares,
        tpPrice: t.tpPrice, slPrice: t.slPrice,
        state: t.state, profit: t.profit,
        timeFactorAtEntry: t.timeFactorAtEntry,
      })),
      markValue: pairMarkValue(p),
      unrealizedPnl: round2(pairMarkValue(p) - p.bankroll),
      equityCurve: p.equityCurve,
      slug: p.slug,
    };
  });

  const totalBankroll = round2(pairStates.reduce((s, p) => s + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((s, p) => s + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((s, p) => s + p.realizedPnl, 0));
  const totalWins = pairStates.reduce((s, p) => s + p.wins, 0);
  const totalLosses = pairStates.reduce((s, p) => s + p.losses, 0);
  const totalRebatesEarned = round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0));

  return {
    dryRun: DRY_RUN, tradingEnabled, pairs: pairList,
    totalCapital: TOTAL_CAPITAL, perPairCapital,
    totalBankroll, totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized,
    totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalRebatesEarned,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      checkIntervalS: CHECK_INTERVAL_S,
      overreactionThreshold: OVERREACTION_THRESHOLD,
      baseShares: BASE_SHARES,
      maxTrades: MAX_TRADES_PER_WINDOW,
      tpTarget: TP_TARGET_PRICE,
      slBaseFraction: SL_BASE_FRACTION,
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

// ── Public controls ──
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

// ── Init ──
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 5-Minute BTC Up/Down — Time Decay Momentum`);
  log(`⚙️  $${TOTAL_CAPITAL} capital | ${pairList.join(', ')} | max ${MAX_TRADES_PER_WINDOW} trades/window`);
  log(`⚙️  Every ${CHECK_INTERVAL_S}s: detect momentum > ${OVERREACTION_THRESHOLD} from 0.50 → buy momentum side | base ${BASE_SHARES}sh`);
  log(`⚙️  Time decay: position size × tf | TP = entry + (1.00-entry)×(0.40+0.45×tf) | SL = entry×(0.50+0.25×tf)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
