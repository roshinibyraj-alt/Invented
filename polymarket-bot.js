'use strict';

const WebSocket = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Gabagool Config ──
const TICK_MS              = 350;
const DISCOVER_EVERY_MS    = 10000;
const WINDOW_SECS          = 300;
const STOP_ENTRY_AT        = 280;
const FORCE_SELL_AT        = 295;
const MIN_REPLACE_MS       = 1000;
const MIN_SECS_TO_END      = 5;
const MAX_SECS_TO_END      = 295;

// Sizing (base unit = 6 shares)
const BASE_SHARES          = 6;
const IMPROVE_TICKS        = 1;
const QUOTE_SIZE           = 6.00;   // dollars per order leg (~6 shares @ $1)

// Complete-set edge config
const MIN_EDGE             = 0.01;   // 1% min edge to trade
const MAX_SKEW_TICKS       = 2;
const IMBALANCE_FOR_MAX_SKEW = 40;   // shares imbalance for full skew

// Top-Up config
const TOP_UP_ENABLED          = true;
const TOP_UP_MIN_SHARES       = 6;
const FAST_TOP_UP_ENABLED     = true;
const FAST_TOP_UP_MIN_SHARES = 6;      // min imbalance to trigger top-up
const FAST_TOP_UP_MIN_SHAFTER = 2;    // seconds after fill
const FAST_TOP_UP_MAX_SHAFTER = 120;
const FAST_TOP_UP_COOLDOWN_MS = 5000;
const FAST_TOP_UP_MIN_EDGE    = 0.00;

// Taker config (disabled by default)
const TAKER_ENABLED    = false;
const TAKER_MAX_EDGE   = 0.015;
const TAKER_MAX_SPREAD = 0.02;

// TICK_SIZE
const DEFAULT_TICK_SIZE = 0.01;

let dryRun = process.env.DRY_RUN !== 'false';
const DEMO_BALANCE = parseFloat(process.env.DEMO_BALANCE || '1000');

let emitFn = () => {};
let slog   = () => {};
let trader = null;
let cashBalance = 0;
let startBalance = 0;
let startTime = Date.now();

const logs = [];
const trades = [];
const markets = {};
const stratState = {};
let lastDiscoverAt = 0;

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  const line = '[' + ts + '] [GAB] ' + msg;
  logs.unshift(line);
  if (logs.length > 500) logs.length = 500;
  if (slog) slog(line);
}

function logTrade(action, side, price, shares, pnl) {
  trades.unshift({
    ts: new Date().toTimeString().slice(0, 8),
    action, side: side || '',
    price: f4(price || 0),
    shares: shares || 0,
    pnl: f2(pnl || 0),
  });
  if (trades.length > 200) trades.length = 200;
}

async function getJSON(url) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? r.json() : null;
  } catch (_) { return null; }
}

function calcEquity() {
  let openValue = 0;
  for (const [slug, ss] of Object.entries(stratState)) {
    const m = markets[slug];
    if (!m || ss.done) continue;
    if (ss.upShares > 0) openValue += ss.upShares * m.upMid;
    if (ss.downShares > 0) openValue += ss.downShares * m.downMid;
  }
  return cashBalance + openValue;
}

// ── WS ──
let ws = null, wsReady = false, wsPingTimer = null;
const wsTokenMap = {};

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(CLOB_WS);
  ws.on('open', () => {
    wsReady = true;
    const ids = Object.keys(wsTokenMap);
    if (ids.length) wsSubscribe(ids);
    wsPingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000);
  });
  ws.on('message', raw => {
    try {
      const msgs = JSON.parse(raw);
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of arr) {
        const t = msg.asset_id, p = parseFloat(msg.price || msg.mid_price || '0');
        if (!t || !p) continue;
        const slug = wsTokenMap[t];
        if (!slug || !markets[slug]) continue;
        const m = markets[slug];
        if (t === m.upTokenId) m.upMid = f4(p);
        if (t === m.downTokenId) m.downMid = f4(p);
      }
    } catch (_) {}
  });
  ws.on('close', () => {
    wsReady = false;
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    setTimeout(wsConnect, 2000);
  });
  ws.on('error', () => { try { ws.terminate(); } catch(_) {} });
}

function wsSubscribe(ids) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ auth: {}, type: 'market', assets_ids: ids }));
}

async function restRefreshPrice(m) {
  const [ur, dr] = await Promise.all([
    getJSON(CLOB + '/midpoint?token_id=' + m.upTokenId),
    getJSON(CLOB + '/midpoint?token_id=' + m.downTokenId),
  ]);
  if (ur && ur.mid) m.upMid = f4(parseFloat(ur.mid));
  if (dr && dr.mid) m.downMid = f4(parseFloat(dr.mid));
  m.lastPriceAt = Date.now();
}

async function ensureFreshPrice(m) {
  if (!m.lastPriceAt || Date.now() - m.lastPriceAt > 2000) await restRefreshPrice(m);
}

function currentWindowStart() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
}

// ── Order Book (best bid/ask) via REST ──
async function refreshOrderBook(m) {
  if (!trader) return;
  // Fetch order book with timeout
  var upBook = null, dnBook = null;
  try {
    upBook = await Promise.race([
      trader.getOrderBook(m.upTokenId),
      new Promise(function(r) { setTimeout(function() { r(null); }, 3000); }),
    ]);
  } catch (_) {}
  try {
    dnBook = await Promise.race([
      trader.getOrderBook(m.downTokenId),
      new Promise(function(r) { setTimeout(function() { r(null); }, 3000); }),
    ]);
  } catch (_) {}

  if (upBook && upBook.bids && upBook.bids.length > 0 && upBook.asks && upBook.asks.length > 0) {
    m.upBid = parseFloat(upBook.bids[0]?.price || '0');
    m.upAsk = parseFloat(upBook.asks[0]?.price || '0');
  }
  if (dnBook && dnBook.bids && dnBook.bids.length > 0 && dnBook.asks && dnBook.asks.length > 0) {
    m.downBid = parseFloat(dnBook.bids[0]?.price || '0');
    m.downAsk = parseFloat(dnBook.asks[0]?.price || '0');
  }

  // Fallback: derive bid/ask from midpoint with synthetic spread
  if ((!m.upBid || !m.upAsk) && m.upMid > 0) {
    m.upBid = f4(m.upMid - 0.015);
    m.upAsk = f4(m.upMid + 0.015);
    if (m.upBid < 0.01) m.upBid = 0.01;
    if (m.upAsk > 0.99) m.upAsk = 0.99;
  }
  if ((!m.downBid || !m.downAsk) && m.downMid > 0) {
    m.downBid = f4(m.downMid - 0.015);
    m.downAsk = f4(m.downMid + 0.015);
    if (m.downBid < 0.01) m.downBid = 0.01;
    if (m.downAsk > 0.99) m.downAsk = 0.99;
  }
}

async function ensureFreshBook(m) {
  if (!m.lastBookAt || Date.now() - m.lastBookAt > 1000) {
    await refreshOrderBook(m);
    m.lastBookAt = Date.now();
  }
}

// ── Helper: round to tick ──
function roundToTick(value, tickSize, mode) {
  if (!tickSize || tickSize <= 0) return value;
  if (mode === 'down') return Math.floor(value / tickSize) * tickSize;
  if (mode === 'up') return Math.ceil(value / tickSize) * tickSize;
  return Math.round(value / tickSize) * tickSize;
}

// ── Gabagool: pickSide ──
function pickSide(upBid, upAsk, downBid, downAsk, ss) {
  if (!upBid || !upAsk || !downBid || !downAsk) return null;

  // edgeTakeUp = 1.0 - (askUp + bidDown) — buy UP at ask, buy DOWN at bid
  // edgeTakeDown = 1.0 - (bidUp + askDown) — buy UP at bid, buy DOWN at ask
  var edgeUp = f4(1.0 - (upAsk + downBid));
  var edgeDown = f4(1.0 - (upBid + downAsk));

  var upOk = edgeUp >= FAST_TOP_UP_MIN_EDGE;
  var downOk = edgeDown >= FAST_TOP_UP_MIN_EDGE;

  if (!upOk && !downOk) return null;
  if (upOk && !downOk) return 'up';
  if (downOk && !upOk) return 'down';

  if (edgeUp > edgeDown) return 'up';
  if (edgeDown > edgeUp) return 'down';

  // Tie-break by inventory imbalance
  var imbalance = (ss.upShares || 0) - (ss.downShares || 0);
  if (imbalance > 0) return 'down';   // more UP → buy DOWN
  if (imbalance < 0) return 'up';     // more DOWN → buy UP
  return 'up';
}

// ── Gabagool: calculateSkewTicks ──
function calculateSkewTicks(ss) {
  var imbalance = (ss.upShares || 0) - (ss.downShares || 0);
  var skewUp = 0, skewDown = 0;

  if (IMBALANCE_FOR_MAX_SKEW > 0 && MAX_SKEW_TICKS > 0) {
    var ratio = Math.min(1, Math.abs(imbalance) / IMBALANCE_FOR_MAX_SKEW);
    var ticks = Math.round(ratio * MAX_SKEW_TICKS);
    if (imbalance > 0) {
      // More UP → improve DOWN (positive skew), penalize UP (negative skew)
      skewDown = ticks;
      skewUp = -ticks;
    } else if (imbalance < 0) {
      // More DOWN → improve UP, penalize DOWN
      skewUp = ticks;
      skewDown = -ticks;
    }
  }
  return [skewUp, skewDown];
}

// ── Gabagool: calculateEntryPrice (maker) ──
function calculateEntryPrice(bid, ask, tickSize, skewTicks) {
  if (!bid || !ask) return null;
  var mid = f4((bid + ask) / 2);
  var spread = f4(ask - bid);
  var effectiveImprove = IMPROVE_TICKS + (skewTicks || 0);
  var entryPrice;

  if (spread >= 0.06) {
    // Wide book: quote near mid
    entryPrice = f4(mid - tickSize * Math.max(0, IMPROVE_TICKS - (skewTicks || 0)));
  } else {
    // Tight book: improve bid
    entryPrice = f4(bid + tickSize * effectiveImprove);
    entryPrice = Math.min(entryPrice, mid);
  }

  entryPrice = roundToTick(entryPrice, tickSize, 'down');
  if (entryPrice < 0.01 || entryPrice > 0.99) return null;
  if (entryPrice >= ask) entryPrice = f4(ask - tickSize);
  if (entryPrice < 0.01) return null;

  return f4(entryPrice);
}

// ── Gabagool: calculateShares ──
function calculateShares(entryPrice, secondsToEnd) {
  if (!entryPrice || entryPrice <= 0) return null;
  // Base size = BASE_SHARES, regardless of time-to-end for 5m windows
  var shares = BASE_SHARES;
  if (entryPrice > 0) {
    // Cap by QUOTE_SIZE dollars
    var maxShares = Math.floor(QUOTE_SIZE / entryPrice);
    shares = Math.min(shares, maxShares);
  }
  return Math.max(shares, 1);
}

// ── Market Discovery ──
async function discoverMarket(pair, customWsTs) {
  const ws_ts = customWsTs || currentWindowStart();
  const slug = pair.toLowerCase() + '-updown-5m-' + ws_ts;
  if (markets[slug]) return;

  var m = { slug, pair, upMid: 0, downMid: 0, upBid: null, upAsk: null, downBid: null, downAsk: null,
    upTokenId: null, downTokenId: null, endTime: 0, windowStartMs: 0, lastPriceAt: 0, lastBookAt: 0,
    loopRunning: false, active: false };

  const d = await getJSON(GAMMA + '/events?slug=' + slug);
  if (!Array.isArray(d) || !d[0] || !d[0].markets || !d[0].markets[0]) return;
  const mk = d[0].markets[0];
  if (!mk.clobTokenIds) return;

  let ids;
  try { ids = JSON.parse(mk.clobTokenIds); } catch (_) { return; }
  if (ids.length < 2) return;

  const endTime = mk.endDate ? new Date(mk.endDate).getTime() : null;
  if (!endTime) return;
  const startTime = mk.startDate ? new Date(mk.startDate).getTime() : endTime - WINDOW_SECS * 1000;

  m.upTokenId = ids[0];
  m.downTokenId = ids[1];
  // Use slug timestamp as windowStart (NOT the API's startDate which is wrong)
  m.windowStartMs = ws_ts * 1000;
  m.endTime = endTime;
  markets[slug] = m;

  // Subscribe to WS price updates
  wsTokenMap[m.upTokenId] = slug;
  wsTokenMap[m.downTokenId] = slug;
  if (wsReady) wsSubscribe([m.upTokenId, m.downTokenId]);

  log('Discovered ' + slug + ' end=' + new Date(endTime).toTimeString().slice(0,8));

  // Start trade loop if not already running
  if (!m.loopRunning) {
    m.loopRunning = true;
    tradeLoop(m).catch(e => log('Loop err: ' + (e.message || '').slice(0, 80)));
  }
}

async function discover() {
  var ws_ts = currentWindowStart();
  await discoverMarket('BTC', ws_ts);
  await discoverMarket('BTC', ws_ts + WINDOW_SECS);
}

// ── Position Tracking ──
let lastPosRefreshAt = 0;

async function syncPositions() {
  if (dryRun) return;
  if (Date.now() - lastPosRefreshAt < 5000) return;
  lastPosRefreshAt = Date.now();
  try {
    var pos = await trader._clob.getPositions(200, 0);
    if (!Array.isArray(pos)) return;
    // Reset all per-market share counts
    for (var k in stratState) {
      var ss = stratState[k];
      var m = markets[k];
      if (!m) continue;
      ss.upShares = 0;
      ss.downShares = 0;
    }
    // Aggregate positions by market
    for (var p of pos) {
      if (p.redeemable) continue;
      var assetId = p.asset;
      var size = parseFloat(p.size || '0');
      if (size <= 0) continue;
      // Find which market this token belongs to
      for (var k in markets) {
        var m = markets[k];
        if (m.upTokenId === assetId) {
          var ss = stratState[k];
          if (ss) ss.upShares += Math.round(size);
        }
        if (m.downTokenId === assetId) {
          var ss = stratState[k];
          if (ss) ss.downShares += Math.round(size);
        }
      }
    }
  } catch (_) {}
}

// ── Check balance (dry/live) ──
async function checkBalance() {
  if (dryRun) return cashBalance;
  try {
    var b = await trader.getBalance();
    if (b > 0) cashBalance = b;
  } catch (_) {}
  return cashBalance || 0;
}

// ── Gabagool: evaluate markets (main tick) ──
async function evaluateMarket(m, ss) {
  if (!m || !m.upTokenId || !ss || ss.done) return;

  var elapsed = (Date.now() - m.windowStartMs) / 1000;
  if (elapsed < 0 || elapsed > WINDOW_SECS + 5) return;

  // Get fresh prices
  await ensureFreshPrice(m);
  await ensureFreshBook(m);

  var upBid = m.upBid, upAsk = m.upAsk;
  var downBid = m.downBid, downAsk = m.downAsk;
  if (!upBid || !upAsk || !downBid || !downAsk) {
    if (Date.now() % 5000 < 100) log('No book data for ' + m.slug + ' upBid=' + upBid + ' upAsk=' + upAsk + ' dnBid=' + downBid + ' dnAsk=' + downAsk);
    return;
  }

  var secondsToEnd = Math.max(0, (m.endTime - Date.now()) / 1000);
  if (secondsToEnd < MIN_SECS_TO_END || secondsToEnd > MAX_SECS_TO_END) return;

  // Phase 3: Force sell
  if (elapsed >= FORCE_SELL_AT) {
    if (!ss._forceSold) {
      ss._forceSold = true;
      await forceSell(m, ss);
    }
    return;
  }
  // If window hasn't started yet, skip
  if (elapsed < 0) return;

  // Phase 2: Stop entries
  if (elapsed >= STOP_ENTRY_AT) {
    await cancelPendingOrders(m, ss);
    return;
  }

  // Phase 1: Active trading
  var [skewUp, skewDown] = calculateSkewTicks(ss);

  await maybeQuoteToken(m, 'up', upBid, upAsk, downBid, downAsk, skewUp, secondsToEnd);
  await maybeQuoteToken(m, 'down', downBid, downAsk, upBid, upAsk, skewDown, secondsToEnd);

  if (FAST_TOP_UP_ENABLED) {
    await maybeFastTopUp(m, ss, upBid, upAsk, downBid, downAsk, secondsToEnd);
  }
}

// ── Gabagool: maybeQuoteToken (maker) ──
async function maybeQuoteToken(m, side, bid, ask, otherBid, otherAsk, skewTicks, secondsToEnd) {
  if (!bid || !ask) return;
  var tickSize = DEFAULT_TICK_SIZE;

  // Calculate entry price
  var entryPrice = calculateEntryPrice(bid, ask, tickSize, skewTicks);
  if (!entryPrice) return;

  // Calculate shares
  var shares = calculateShares(entryPrice, secondsToEnd);
  if (!shares || shares < 1) return;

  var tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  var ss = stratState[m.slug];
  if (!ss) return;

  // Check existing order
  var pendingKey = side === 'up' ? '_pendingUp' : '_pendingDown';
  var pending = ss[pendingKey];

  if (pending) {
    // Check if order should be replaced (price improved enough)
    if (Date.now() - pending.placedAt < MIN_REPLACE_MS) return;
    var priceDiff = Math.abs(entryPrice - pending.price);
    if (priceDiff < tickSize) return; // not enough improvement

    // Cancel old order
    await cancelOrder(side, m, ss);
  }

  // Check if we already have enough shares
  var sharesKey = side === 'up' ? 'upShares' : 'downShares';
  if (ss[sharesKey] >= BASE_SHARES * 3) return; // cap at 3 base units

  // Place GTC limit order
  var cost = f4(shares * entryPrice);
  var preBal = await checkBalance();
  if (cost > preBal * 0.9) {
    shares = Math.floor(preBal * 0.9 / entryPrice);
    if (shares < 1) return;
  }

  if (dryRun) {
    // Simulate fill after 3s
    log('DEMO GTC ' + side.toUpperCase() + ' ' + shares + 'sh @ $' + f4(entryPrice) + ' (skew=' + (skewTicks || 0) + ')');
    ss[pendingKey] = { orderId: 'demo-' + side + '-' + Date.now(), price: entryPrice, size: shares, placedAt: Date.now() };
    ss['_pending' + (side === 'up' ? 'Up' : 'Down') + 'At'] = Date.now();
    return;
  }

  try {
    log('GTC ' + side.toUpperCase() + ' ' + shares + 'sh @ $' + f4(entryPrice) + ' bid=$' + f4(bid) + ' skew=' + (skewTicks || 0));
    var result = await trader.placeGtcOrder(tokenId, 'BUY', entryPrice, shares);
    if (result && result.id) {
      ss[pendingKey] = { orderId: result.id, price: entryPrice, size: shares, placedAt: Date.now() };
      ss['_pending' + (side === 'up' ? 'Up' : 'Down') + 'At'] = Date.now();
    }
  } catch (e) {
    log('GTC ' + side.toUpperCase() + ' err: ' + (e.message || '').slice(0, 60));
  }
}

// ── Gabagool: maybeFastTopUp ──
async function maybeFastTopUp(m, ss, upBid, upAsk, downBid, downAsk, secondsToEnd) {
  if (!ss) return;
  var imbalance = (ss.upShares || 0) - (ss.downShares || 0);
  var absImbalance = Math.abs(imbalance);
  if (absImbalance < FAST_TOP_UP_MIN_SHARES) return;

  // Check cooldown
  if (ss._lastTopUpAt && Date.now() - ss._lastTopUpAt < FAST_TOP_UP_COOLDOWN_MS) return;

  // Determine lagging leg (the side we have less of)
  var laggingSide = imbalance > 0 ? 'down' : 'up';
  var leadingSide = imbalance > 0 ? 'up' : 'down';

  var lagFillAtKey = laggingSide === 'up' ? '_lastUpFillAt' : '_lastDownFillAt';
  var leadFillAtKey = leadingSide === 'up' ? '_lastUpFillAt' : '_lastDownFillAt';

  var leadFillAt = ss[leadFillAtKey];
  if (!leadFillAt) return;

  var sinceLeadFillSec = (Date.now() - leadFillAt) / 1000;
  if (sinceLeadFillSec < FAST_TOP_UP_MIN_SHAFTER || sinceLeadFillSec > FAST_TOP_UP_MAX_SHAFTER) return;

  // Check that lag hasn't filled after lead
  var lagFillAt = ss[lagFillAtKey];
  if (lagFillAt && lagFillAt >= leadFillAt) return;

  // Check spread
  var lagBid = laggingSide === 'up' ? upBid : downBid;
  var lagAsk = laggingSide === 'up' ? upAsk : downAsk;
  if (!lagBid || !lagAsk) return;
  var spread = f4(lagAsk - lagBid);
  if (spread > TAKER_MAX_SPREAD) return;

  // Check edge for lagging leg
  var edgeTakeLag = laggingSide === 'up'
    ? f4(1.0 - (upAsk + downBid))
    : f4(1.0 - (upBid + downAsk));
  if (edgeTakeLag < FAST_TOP_UP_MIN_EDGE) return;

  // Don't top-up if lagging already has a pending order
  var pendingKey = laggingSide === 'up' ? '_pendingUp' : '_pendingDown';
  if (ss[pendingKey]) return;

  // Calculate top-up shares = absImbalance, capped at BASE_SHARES
  var topUpShares = Math.min(absImbalance, BASE_SHARES);

  // Place FOK (aggressive) at ask for the lagging leg
  var cost = f4(topUpShares * lagAsk);
  var preBal = await checkBalance();
  if (cost > preBal * 0.9) return;

  var lagTokenId = laggingSide === 'up' ? m.upTokenId : m.downTokenId;

  log('TOP-UP ' + laggingSide.toUpperCase() + ' ' + topUpShares + 'sh @ ask $' + f4(lagAsk) + ' imbalance=' + absImbalance);

  if (dryRun) {
    // Simulate fill
    ss[laggingSide + 'Shares'] = (ss[laggingSide + 'Shares'] || 0) + topUpShares;
    ss[lagFillAtKey] = Date.now();
    ss._lastTopUpAt = Date.now();
    if (!dryRun) cashBalance -= cost;
    log('DEMO TOP-UP filled +' + topUpShares + ' ' + laggingSide.toUpperCase());
    logTrade('TOP-UP', laggingSide.toUpperCase(), lagAsk, topUpShares);
    return;
  }

  try {
    var result = await trader.placeFokBuy(lagTokenId, cost);
    // Check if filled
    if (result && result.isFilled) {
      ss[laggingSide + 'Shares'] = (ss[laggingSide + 'Shares'] || 0) + topUpShares;
      ss[lagFillAtKey] = Date.now();
      ss._lastTopUpAt = Date.now();
      cashBalance -= cost;
      log('TOP-UP filled +' + topUpShares + ' ' + laggingSide.toUpperCase());
      logTrade('TOP-UP', laggingSide.toUpperCase(), lagAsk, topUpShares);
    } else {
      log('TOP-UP ' + laggingSide.toUpperCase() + ' NOT filled');
    }
  } catch (e) {
    log('TOP-UP err: ' + (e.message || '').slice(0, 60));
  }
}

// ── Cancel pending order ──
async function cancelOrder(side, m, ss) {
  if (!ss) return;
  var pendingKey = side === 'up' ? '_pendingUp' : '_pendingDown';
  var pending = ss[pendingKey];
  if (!pending) return;

  if (!dryRun && pending.orderId && !pending.orderId.startsWith('demo-')) {
    try {
      await trader.cancelOrder(pending.orderId);
      log('Cancelled ' + side.toUpperCase() + ' ' + pending.orderId.slice(0, 12));
    } catch (e) {
      log('Cancel ' + side.toUpperCase() + ' err: ' + (e.message || '').slice(0, 60));
    }
  }
  ss[pendingKey] = null;
}

async function cancelPendingOrders(m, ss) {
  if (!ss) return;
  await cancelOrder('up', m, ss);
  await cancelOrder('down', m, ss);
}

// ── Force sell both sides at end of window ──
async function forceSell(m, ss) {
  if (!ss) return;
  log('FORCE SELL');

  // Cancel any pending GTC orders first
  await cancelPendingOrders(m, ss);

  // Sell UP shares
  if (ss.upShares > 0) {
    var tokenId = m.upTokenId;
    var mid = m.upMid || m.upBid || 0;
    var pnl = f2((mid - (ss._avgUpPrice || mid)) * ss.upShares);
    var cost = f4(ss.upShares * mid);
    log('SELL UP ' + ss.upShares + 'sh @ $' + f4(mid) + ' PnL: ' + (pnl >= 0 ? '+' : '') + '$' + pnl);

    if (dryRun) {
      cashBalance += cost;
      logTrade('SELL', 'UP', mid, ss.upShares, pnl);
      ss.upShares = 0;
      ss._pendingUp = null;
    } else if (ss.upShares > 0) {
      try {
        var r = await trader.placeFokSell(tokenId, ss.upShares);
        if (r && r.isFilled) {
          cashBalance += cost;
          logTrade('SELL', 'UP', mid, ss.upShares, pnl);
          ss.upShares = 0;
          ss._pendingUp = null;
        } else {
          log('SELL UP NOT filled, will retry');
          ss._forceRetry = Date.now() + 2000;
        }
      } catch (e) {
        log('SELL UP err: ' + (e.message || '').slice(0, 60));
        ss._forceRetry = Date.now() + 2000;
      }
    }
  }

  // Sell DOWN shares
  if (ss.downShares > 0) {
    var tokenId = m.downTokenId;
    var mid = m.downMid || m.downBid || 0;
    var pnl = f2((mid - (ss._avgDownPrice || mid)) * ss.downShares);
    var cost = f4(ss.downShares * mid);
    log('SELL DOWN ' + ss.downShares + 'sh @ $' + f4(mid) + ' PnL: ' + (pnl >= 0 ? '+' : '') + '$' + pnl);

    if (dryRun) {
      cashBalance += cost;
      logTrade('SELL', 'DOWN', mid, ss.downShares, pnl);
      ss.downShares = 0;
      ss._pendingDown = null;
    } else if (ss.downShares > 0) {
      try {
        var r = await trader.placeFokSell(tokenId, ss.downShares);
        if (r && r.isFilled) {
          cashBalance += cost;
          logTrade('SELL', 'DOWN', mid, ss.downShares, pnl);
          ss.downShares = 0;
          ss._pendingDown = null;
        } else {
          log('SELL DOWN NOT filled, will retry');
          ss._forceRetry = Date.now() + 2000;
        }
      } catch (e) {
        log('SELL DOWN err: ' + (e.message || '').slice(0, 60));
        ss._forceRetry = Date.now() + 2000;
      }
    }
  }

  ss.done = true;
}

// ── Fill monitoring via order polling ──
async function checkPendingFills() {
  for (var slug in markets) {
    var m = markets[slug];
    if (!m || !m.upTokenId) continue;
    var ss = stratState[slug];
    if (!ss || ss.done) continue;

    // Check UP pending order
    if (ss._pendingUp) {
      var pending = ss._pendingUp;
      if (pending.orderId.startsWith('demo-')) {
        // Demo: simulate fill after 3s
        if (Date.now() - pending.placedAt >= 3000) {
          ss.upShares = (ss.upShares || 0) + pending.size;
          ss._avgUpPrice = ss._avgUpPrice
            ? f4((ss._avgUpPrice * (ss.upShares - pending.size) + pending.price * pending.size) / ss.upShares)
            : pending.price;
          ss._lastUpFillAt = Date.now();
          ss._pendingUp = null;
          log('DEMO UP FILLED +' + pending.size + 'sh @ $' + f4(pending.price) + ' total=' + ss.upShares);
          logTrade('BUY', 'UP', pending.price, pending.size);
        }
      } else {
        // Real: check order status
        try {
          var order = await trader.getOrder(pending.orderId);
          if (order) {
            var status = (order.status || '').toLowerCase();
            var matchStatus = (order.match_status || '').toLowerCase();
            var filled = status === 'filled' || matchStatus === 'filled';
            if (filled) {
              var filledSize = parseFloat(order.size_matched || order.filled_size || pending.size);
              ss.upShares = (ss.upShares || 0) + Math.round(filledSize);
              ss._avgUpPrice = pending.price;
              ss._lastUpFillAt = Date.now();
              ss._pendingUp = null;
              log('UP FILLED +' + Math.round(filledSize) + 'sh @ $' + f4(pending.price));
              logTrade('BUY', 'UP', pending.price, Math.round(filledSize));
            } else if (status === 'cancelled' || matchStatus === 'cancelled') {
              ss._pendingUp = null;
            }
          }
        } catch (_) {}
      }
    }

    // Check DOWN pending order (same logic)
    if (ss._pendingDown) {
      var pending = ss._pendingDown;
      if (pending.orderId.startsWith('demo-')) {
        if (Date.now() - pending.placedAt >= 3000) {
          ss.downShares = (ss.downShares || 0) + pending.size;
          ss._avgDownPrice = ss._avgDownPrice
            ? f4((ss._avgDownPrice * (ss.downShares - pending.size) + pending.price * pending.size) / ss.downShares)
            : pending.price;
          ss._lastDownFillAt = Date.now();
          ss._pendingDown = null;
          log('DEMO DOWN FILLED +' + pending.size + 'sh @ $' + f4(pending.price) + ' total=' + ss.downShares);
          logTrade('BUY', 'DOWN', pending.price, pending.size);
        }
      } else {
        try {
          var order = await trader.getOrder(pending.orderId);
          if (order) {
            var status = (order.status || '').toLowerCase();
            var matchStatus = (order.match_status || '').toLowerCase();
            var filled = status === 'filled' || matchStatus === 'filled';
            if (filled) {
              var filledSize = parseFloat(order.size_matched || order.filled_size || pending.size);
              ss.downShares = (ss.downShares || 0) + Math.round(filledSize);
              ss._avgDownPrice = pending.price;
              ss._lastDownFillAt = Date.now();
              ss._pendingDown = null;
              log('DOWN FILLED +' + Math.round(filledSize) + 'sh @ $' + f4(pending.price));
              logTrade('BUY', 'DOWN', pending.price, Math.round(filledSize));
            } else if (status === 'cancelled' || matchStatus === 'cancelled') {
              ss._pendingDown = null;
            }
          }
        } catch (_) {}
      }
    }
  }
}

// ── Trade Loop (per market) ──
async function tradeLoop(m) {
  log('Loop ' + m.slug + ' waiting...');

  if (m.windowStartMs > Date.now() + 2000) {
    await sleep(m.windowStartMs - Date.now());
  }

  log(m.slug + ' STARTED ws=' + new Date(m.windowStartMs).toTimeString().slice(0,8) + ' end=' + new Date(m.endTime).toTimeString().slice(0,8) + ' now=' + new Date().toTimeString().slice(0,8));

  var ss = {
    upShares: 0, downShares: 0,
    _pendingUp: null, _pendingDown: null,
    _lastUpFillAt: null, _lastDownFillAt: null,
    _lastTopUpAt: null, _avgUpPrice: null, _avgDownPrice: null,
    _forceSold: false, _forceRetry: 0,
    done: false,
  };
  stratState[m.slug] = ss;

  while (true) {
    var elapsed = (Date.now() - m.windowStartMs) / 1000;
    if (elapsed >= WINDOW_SECS + 5) break;

    // Check pending fills (non-blocking order status poll)
    await checkPendingFills();

    // Evaluate this specific market (Gabagool logic)
    await evaluateMarket(m, ss);

    await sleep(TICK_MS);
  }

  log(m.slug + ' DONE');
  var mObj = markets[m.slug];
  if (mObj) mObj.loopRunning = false;
}

// ── Snapshot (for dashboard) ──
function snapshot() {
  const equity = calcEquity();
  const pnl = f2(equity - startBalance);

  const activeMarkets = Object.values(markets)
    .filter(m => m.windowStartMs <= Date.now() && Date.now() < m.endTime + 30000 && m.upTokenId)
    .map(m => {
    var ss = stratState[m.slug] || {};
    var elapsed = Math.max(0, (Date.now() - m.windowStartMs) / 1000);
    var secsLeft = Math.max(0, Math.floor((m.endTime - Date.now()) / 1000));
    var phase = 'waiting';
    if (elapsed >= FORCE_SELL_AT) phase = 'force_sell';
    else if (elapsed >= STOP_ENTRY_AT) phase = 'closing';
    else if (elapsed > 0 && secsLeft < 300) phase = 'trading';

    var edge = 0;
    if (m.upBid && m.downBid) edge = f4(1.0 - (m.upBid + m.downBid));

    return {
      slug: m.slug, pair: m.pair,
      upMid: f4(m.upMid), dnMid: f4(m.downMid),
      upBid: f4(m.upBid || 0), upAsk: f4(m.upAsk || 0),
      downBid: f4(m.downBid || 0), downAsk: f4(m.downAsk || 0),
      secsLeft, elapsed: Math.floor(elapsed), phase,
      upShares: ss.upShares || 0,
      downShares: ss.downShares || 0,
      hasPendingUp: !!ss._pendingUp,
      hasPendingDown: !!ss._pendingDown,
      edge: edge,
      edgePct: (edge * 100).toFixed(2) + '%',
    };
  });

  return {
    dryRun, balance: f2(equity), cashBalance: f2(cashBalance),
    startBalance: f2(startBalance), pnl,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeMarkets,
    recentTrades: trades.slice(0, 100),
    activityLog: logs.slice(0, 50),
    strategy: { type: 'gabagool_complete_set', baseShares: BASE_SHARES, minEdge: MIN_EDGE },
  };
}

// ── Start ──
async function start(emit, logFn) {
  emitFn = emit || (() => {});
  slog = logFn || (() => {});
  startTime = Date.now();

  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    console.error('No private key'); process.exit(1);
  }

  try {
    trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY);
    trader.setLogFn(log);
    log('Authenticating...');
    await trader.authenticate();
    log('Auth: ' + trader.address);
    if (dryRun) { cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE; log('DEMO $' + f2(cashBalance)); }
    else { var b = await trader.getBalance(); if (b > 0) { cashBalance = b; startBalance = b; } log('LIVE $' + f2(cashBalance)); }
  } catch (e) {
    if (dryRun) { cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE; log('DEMO $' + f2(cashBalance) + ' (auth fail)'); }
    else { log('Auth fail: ' + e.message); process.exit(1); }
  }

  wsConnect();
  log('Starting Gabagool engine');

  // Main interval: discover markets + evaluate + emit snapshot
  setInterval(async () => {
    var now = Date.now();
    if (now - lastDiscoverAt >= DISCOVER_EVERY_MS) {
      lastDiscoverAt = now;
      await discover();
    }
    emitFn('snapshot', snapshot());
  }, TICK_MS);
}

async function setDryRun(v) {
  var wasDry = dryRun;
  dryRun = !!v;
  if (wasDry && !dryRun && trader) {
    try {
      var b = await trader.getBalance();
      if (b > 0) { cashBalance = b; startBalance = b; }
      log('Switched LIVE — balance: $' + f2(cashBalance));
    } catch(e) { log('Live sync err: ' + e.message); }
    // Clear all demo state
    for (var k in stratState) delete stratState[k];
    log('State cleared');
  }
  if (!wasDry && dryRun) {
    cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE;
    for (var k in stratState) delete stratState[k];
    log('Switched DEMO — balance: $' + f2(cashBalance));
  }
}
function getDryRun() { return dryRun; }

module.exports = { start, snapshot, setDryRun, getDryRun };
