'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — TIME DECAY MEAN REVERSION
 * ═══════════════════════════════════════════════════════════════
 *
 *  DETECT overreaction: if a side's mid price deviates > threshold
 *  from 0.50 early in window → BUY the OPPOSITE side (mean reversion
 *  toward 0.50).
 *
 *  TIME DECAY makes everything size/TP/SL proportional to
 *  timeRemaining / totalWindow:
 *    • More time left → bigger position, wider TP, wider SL
 *    • Less time left → smaller position, tighter TP, tighter SL
 *
 *  Max 5 mean reversion trades per window per pair.
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
const CHECK_INTERVAL_S        = Number(process.env.CHECK_INTERVAL_S || 10);
const OVERREACTION_THRESHOLD  = Number(process.env.OVERREACTION_THRESHOLD || 0.04);
const BASE_SHARES             = Number(process.env.BASE_SHARES || 25);
const MAX_TRADES_PER_WINDOW   = Number(process.env.MAX_TRADES || 5);
const TP_REVERSION_FACTOR     = Number(process.env.TP_FACTOR || 0.7);
const SL_PROTECTION_FACTOR    = Number(process.env.SL_FACTOR || 0.5);

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
    side: null,             // 'Up' or 'Down' — the CHEAP side we bought
    overreactedSide: null,  // 'Up' or 'Down' — the side that overreacted
    entryPrice: null,
    shares: 0,
    cost: 0,
    tpPrice: null,
    slPrice: null,
    placedAt: null,
    filledAt: null,
    buyOrderId: null,
    tpOrderId: null,
    slOrderId: null,
    state: 'pending',       // pending → resting → filled → tp-filled|sl-filled|resolved
    profit: null,
    timeFactorAtEntry: 0,
    deviationAtEntry: 0,
    outcome: null,
    reason: null,
    rebateEarned: 0,
  };
}

function freshPairState(symbol) {
  return {
    symbol,
    slug: null,
    conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    windowStart: null,
    windowEnd: null,
    tradable: false,
    resolvedThisWindow: false,
    bankroll: perPairCapital,
    realizedPnl: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,
    reversionTrades: [],
    lastCheckTick: -1,
    equityCurve: [],
  };
}

function resetPairs() {
  pairs = {};
  for (const sym of pairList) pairs[sym] = freshPairState(sym);
}

// ── Window slug / market lookup ──
function currentWindowStart(tsSec = nowSec()) {
  return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS;
}
function slugFor(symbol, windowStartSec) {
  return `${symbol.toLowerCase()}-${windowStartSec}`;
}
function qOf(m) { return (m.question || m.groupItemTitle || m.title || '').toLowerCase(); }
function parseMarketTokens(m) {
  const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
  const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
  return outcomes.map((o, i) => ({ outcome: o.trim(), tokenId: tokenIds[i] }));
}
function tokenIdForSide(market, side) {
  const tokens = parseMarketTokens(market);
  const want = (side || '').trim().toLowerCase();
  const tok = tokens.find(t => (t.outcome || '').toLowerCase() === want);
  return tok ? tok.tokenId : (market.clobTokenIds || '') || (tokens[0] || {}).tokenId;
}

async function fetchEventForWindow(symbol, windowStart) {
  // 1) Try direct slug lookup first
  for (const offset of SLUG_OFFSET_FALLBACKS) {
    const ws = windowStart + offset;
    const slug = slugFor(symbol, ws);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.markets && event.markets.length > 0) return { event, windowStart: ws, slug };
    } catch (_) {}
  }
  // 2) Search tagged events
  try {
    const tag = symbol.toLowerCase();
    const events = await getJSON(`${GAMMA}/events?closed=false&limit=100&tag=${encodeURIComponent(tag)}`);
    for (const ev of [].concat(events)) {
      const title = (ev.title || ev.question || ev.groupItemTitle || '').toLowerCase();
      if ((title.includes('5 minute') || title.includes('5min') || title.includes('5 min'))) {
        const market = (ev.markets || []).find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || ev.markets[0];
        if (market) return { event: ev, windowStart, slug: ev.slug || slugFor(symbol, windowStart) };
      }
    }
  } catch (_) {}
  // 3) Broad search — recent open events
  try {
    const all = await getJSON(`${GAMMA}/events?closed=false&limit=200`);
    for (const ev of [].concat(all)) {
      const title = (ev.title || ev.question || ev.groupItemTitle || '').toLowerCase();
      if ((title.includes(symbol.toLowerCase()) || title.includes('bitcoin'))) {
        if (title.includes('5 minute') || title.includes('5min') || title.includes('5 min')) {
          const market = (ev.markets || []).find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || ev.markets[0];
          if (market) return { event: ev, windowStart, slug: ev.slug || slugFor(symbol, windowStart) };
        }
      }
    }
  } catch (_) {}
  return null;
}

async function loadPairWindow(p) {
  const ws = currentWindowStart();
  if (p.windowStart !== null && ws === p.windowStart) return;

  // Retry cooldown: only re-fetch every 10s if previous attempt failed
  if (p._lastFetchFail && (Date.now() - p._lastFetchFail) < 10000) return;

  const found = await fetchEventForWindow(p.symbol, ws);
  if (!found) {
    p._lastFetchFail = Date.now();
    log(`⚠️  ${p.symbol}: no event found for window ${ws}`);
    return;
  }
  p._lastFetchFail = null;
  const { event, windowStart, slug } = found;
  const market = (event.markets || []).find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];
  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');

  // Carry over unfinished trades from previous window
  const carryOver = p.reversionTrades.filter(t =>
    t.state === 'resting' || t.state === 'filled' || t.state === 'tp-sl-placed' ||
    t.state === 'tp-resting' || t.state === 'sl-resting'
  );

  p.slug = slug;
  p.conditionId = market.conditionId || event.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.tradable = true;
  p.resolvedThisWindow = false;
  p.lastCheckTick = -1;
  p.reversionTrades = carryOver;

  log(`📡 ${p.symbol}: window ${windowStart} → ${windowStart + WINDOW_SECS}`);
}

// ── Price refresh ──
async function refreshPolyPrices() {
  const requests = [];
  for (const p of Object.values(pairs)) {
    if (p.upTokenId) requests.push({ token_id: p.upTokenId, side: 'BUY' });
    if (p.upTokenId) requests.push({ token_id: p.upTokenId, side: 'SELL' });
    if (p.downTokenId) requests.push({ token_id: p.downTokenId, side: 'BUY' });
    if (p.downTokenId) requests.push({ token_id: p.downTokenId, side: 'SELL' });
  }
  if (requests.length === 0) return;

  function apply(tid, side, price) {
    if (price == null || isNaN(price)) return;
    for (const p of Object.values(pairs)) {
      const isUp = p.upTokenId === tid;
      const isDown = p.downTokenId === tid;
      if (!isUp && !isDown) continue;
      if (side === 'SELL') { if (isUp) p.upAsk = price; if (isDown) p.downAsk = price; }
      if (side === 'BUY')  { if (isUp) p.upBid = price; if (isDown) p.downBid = price; }
    }
  }

  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const side = (row.side || '').toUpperCase();
        const price = parseFloat(row.price || row.mid);
        if (tid && side && !isNaN(price)) apply(tid, side, price);
      }
    }
  } catch (e) {
    // Fallback: fetch individually
    for (const p of Object.values(pairs)) {
      try {
        if (p.upTokenId) {
          const [upAsk, upBid, downAsk, downBid] = await Promise.all([
            getJSON(`${CLOB}/price?token_id=${p.upTokenId}&side=SELL`).then(r => parseFloat(r.price)).catch(() => null),
            getJSON(`${CLOB}/price?token_id=${p.upTokenId}&side=BUY`).then(r => parseFloat(r.price)).catch(() => null),
            getJSON(`${CLOB}/price?token_id=${p.downTokenId}&side=SELL`).then(r => parseFloat(r.price)).catch(() => null),
            getJSON(`${CLOB}/price?token_id=${p.downTokenId}&side=BUY`).then(r => parseFloat(r.price)).catch(() => null),
          ]);
          if (upAsk != null) p.upAsk = upAsk;
          if (upBid != null) p.upBid = upBid;
          if (downAsk != null) p.downAsk = downAsk;
          if (downBid != null) p.downBid = downBid;
        }
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
//  TIME DECAY MEAN REVERSION STRATEGY
// ═══════════════════════════════════════════════════════════════

/**
 * Time decay factor: 1.0 at window open → 0.05 near window close.
 * Higher = more time remaining = bigger positions, wider TP/SL.
 */
function timeDecayFactor(p) {
  if (!p.windowStart) return 0;
  const elapsed = nowSec() - p.windowStart;
  return Math.max(0.05, Math.min(1.0, 1.0 - elapsed / WINDOW_SECS));
}

/**
 * Detect overreaction: is either side's mid price pushing away from 0.50?
 * Returns { overreactedSide, cheapSide, cheapPrice, deviation, spread } or null.
 *
 * We BUY the CHEAP side expecting mean reversion back toward 0.50.
 */
function detectOverreactionSignal(p) {
  const upMid = computeMid(p.upAsk, p.upBid);
  const downMid = computeMid(p.downAsk, p.downBid);
  if (upMid == null || downMid == null) return null;

  const upDev = Math.abs(upMid - 0.50);
  const downDev = Math.abs(downMid - 0.50);

  // At least one side must have overreacted
  if (upDev < OVERREACTION_THRESHOLD && downDev < OVERREACTION_THRESHOLD) return null;

  // Ensure the spread between sides is meaningful
  const spread = Math.abs(upMid - downMid);
  if (spread < OVERREACTION_THRESHOLD * 1.5) return null;

  // Determine which side overreacted and which is cheap
  if (upMid > downMid) {
    // UP is overreacted (expensive), DOWN is cheap — buy DOWN
    return {
      overreactedSide: 'Up',
      cheapSide: 'Down',
      cheapPrice: downMid,
      deviation: round5(upMid - 0.50),
      spread: round5(spread),
    };
  } else {
    // DOWN is overreacted (expensive), UP is cheap — buy UP
    return {
      overreactedSide: 'Down',
      cheapSide: 'Up',
      cheapPrice: upMid,
      deviation: round5(downMid - 0.50),
      spread: round5(spread),
    };
  }
}

/**
 * Calculate position size based on time decay.
 * More time remaining + bigger deviation → more shares.
 */
function calcReversionSize(deviation) {
  const pair = Object.values(pairs)[0];
  if (!pair) return BASE_SHARES;
  const tf = timeDecayFactor(pair);
  const deviationFactor = Math.min(1.0, deviation / 0.50);
  const timeFactor = 0.3 + 0.7 * tf; // 0.3 to 1.0
  const size = Math.round(BASE_SHARES * timeFactor * (0.5 + 0.5 * deviationFactor));
  return Math.max(1, size);
}

/**
 * Calculate TP and SL for mean reversion.
 *
 * We bought the CHEAP side (< 0.50), expecting reversion toward 0.50.
 * TP: sell as price reverts toward 0.50. More time → closer to target.
 * SL: protect if price keeps diverging. More time → wider stop.
 */
function calcReversionTpSl(entryPrice) {
  const pair = Object.values(pairs)[0];
  const tf = pair ? timeDecayFactor(pair) : 0.5;

  // Distance from entry to 0.50 (always positive since we bought below 0.50)
  const reversionDist = 0.50 - entryPrice;

  // TP: capture 40-70% of reversion distance toward 0.50
  // Early (tf=1.0): TP = entry + reversionDist * 0.70
  // Late  (tf=0.05): TP = entry + reversionDist * 0.415
  const tpCapture = 0.40 + 0.30 * tf;
  let tpPrice = round5(entryPrice + reversionDist * tpCapture);

  // SL: allow entry * (0.3 + 0.2 * tf) room against us
  // Early (tf=1.0): keep 50% of entry → wide stop at 50% below
  // Late  (tf=0.05): keep 69% of entry → tight stop at 31% below
  const slFraction = 0.3 + 0.2 * tf;
  let slPrice = round5(entryPrice * (1 - slFraction));

  // Bounds
  tpPrice = Math.max(entryPrice + 0.003, Math.min(0.995, tpPrice));
  slPrice = Math.max(0.003, slPrice);

  return { tpPrice, slPrice };
}

/**
 * Try to place one mean reversion trade.
 * Buys the CHEAP side when the other side overreacts.
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

  // Buy cheap side at mid price (maker limit order)
  const buyPrice = signal.cheapPrice;
  const cost = round2(buyPrice * shares);
  const { tpPrice, slPrice } = calcReversionTpSl(buyPrice);

  const tokenId = signal.cheapSide === 'Up' ? p.upTokenId : p.downTokenId;
  if (!tokenId) return;

  const orderResult = await placeLimitBuy(tokenId, buyPrice, shares);

  const trade = freshTradeEntry();
  trade.side = signal.cheapSide;
  trade.overreactedSide = signal.overreactedSide;
  trade.entryPrice = buyPrice;
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

  log(`🔄 ${p.symbol} REVERSION: buy ${signal.cheapSide} ${shares}sh @ ${buyPrice.toFixed(4)} ` +
    `(overreacted=${signal.overreactedSide}, dev=${signal.deviation.toFixed(3)}, tf=${tf.toFixed(2)}) ` +
    `TP=${tpPrice.toFixed(4)} SL=${slPrice.toFixed(4)} ` +
    `[trade ${activeTrades.length + 1}/${MAX_TRADES_PER_WINDOW}]`);
}

// ── Order management ──

/**
 * Check fills on resting buy orders → on fill, place TP + SL sells.
 */
async function manageTpSl(p) {
  for (const t of p.reversionTrades) {
    if (t.state !== 'resting') continue;

    // Check if our limit buy filled (ask crossed down to/through our entry price)
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

    const tpOrder = await placeLimitSell(tokenId, t.tpPrice, t.shares);
    t.tpOrderId = tpOrder.id || tpOrder.orderId || null;

    const slOrder = await placeLimitSell(tokenId, t.slPrice, t.shares);
    t.slOrderId = slOrder.id || slOrder.orderId || null;

    t.state = 'tp-sl-placed';
    log(`🧯 ${p.symbol} TP/SL placed: sell TP @ ${t.tpPrice.toFixed(4)} / SL @ ${t.slPrice.toFixed(4)} on ${t.side}`);

    registerTrade(p, {
      side: 'BUY', outcome: t.side, price: t.entryPrice, shares: t.shares,
      cost: t.cost, rebate, reason: 'REVERSION',
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

// ── Window resolution ──

/**
 * Cancel unfilled orders at window end before resolution.
 */
async function cancelRemainingOrders(p) {
  for (const t of p.reversionTrades) {
    if (t.state === 'resting') {
      await cancelOrder(t.buyOrderId);
      log(`🛑 ${p.symbol}: buy on ${t.side} @ ${t.entryPrice.toFixed(4)} never filled — cancelled`);
      t.state = 'cancelled';
      continue;
    }
    if (t.state === 'tp-sl-placed') {
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

  await cancelRemainingOrders(p);

  // Resolve still-held positions to 0 or 1 after market closes
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
      const signal = detectOverreactionSignal(p);
      if (signal) {
        await tryPlaceReversionTrade(p, signal);
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
      activeTrades: activeTrades.map(t => ({
        id: t.id,
        side: t.side,
        overreactedSide: t.overreactedSide,
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
        side: t.side,
        overreactedSide: t.overreactedSide,
        entryPrice: t.entryPrice, shares: t.shares,
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
    totalPnl: round2(totalMark > 0 ? totalMark - TOTAL_CAPITAL : 0),
    totalWins, totalLosses,
    totalRebatesEarned,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      checkIntervalS: CHECK_INTERVAL_S,
      overreactionThreshold: OVERREACTION_THRESHOLD,
      baseShares: BASE_SHARES,
      maxTrades: MAX_TRADES_PER_WINDOW,
      tpFactor: TP_REVERSION_FACTOR,
      slFactor: SL_PROTECTION_FACTOR,
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
  log(`🚀 5-Minute BTC Up/Down — Time Decay Mean Reversion`);
  log(`⚙️  $${TOTAL_CAPITAL} capital | ${pairList.join(', ')} | max ${MAX_TRADES_PER_WINDOW} trades/window`);
  log(`⚙️  Every ${CHECK_INTERVAL_S}s: detect overreaction > ${OVERREACTION_THRESHOLD} from 0.50 → buy OPPOSITE side (mean reversion) | base ${BASE_SHARES}sh`);
  log(`⚙️  Time decay: position × tf | TP = entry+(0.50-entry)×(0.40+0.30×tf) | SL = entry×(0.30+0.20×tf)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills' : '🔴 LIVE MODE — real money'}`);

  // Initialize pair states
  resetPairs();
  log(`✅ Pairs initialized: ${pairList.join(', ')}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
