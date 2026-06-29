'use strict';

const WebSocket        = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Window & timing ──
const WINDOW_SECS       = 300;
const DISCOVER_EVERY_MS = 15000;
const TICK_MS           = 200;

// ── Strategy config ──
const TP_PRICE        = 0.99;   // Take-profit limit price
const SHARES_PER_FIRE = 6;      // Fixed 6 shares every fire, no exceptions
const FORCE_SELL_SECS = 298;    // Force-sell all positions at this second
// Entry fires at end of each minute: 60s, 120s, 180s, 240s (4 total)
const ENTRY_FIRE_SECS = [60, 120, 180, 240];

const DRY_RUN     = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TARGET_PAIRS = ['BTC'];

let emitFn       = () => {};
let slog         = () => {};
let trader       = null;
let demoBalance  = 0;   // Starting balance (never mutated after init)
let realizedPnl  = 0;   // Sum of closed trade P&L
let startTime    = Date.now();

const logs    = [];
const trades  = [];
const markets = {};
let lastDiscoverAt = 0;

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const prefix = DRY_RUN ? '[DRY] ' : '';
  const ts     = new Date().toTimeString().slice(0, 8);
  const line   = `[${ts}] ${prefix}${msg}`;
  logs.unshift(line);
  if (logs.length > 300) logs.length = 300;
  if (slog) slog(line);
}

async function getJSON(url) {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 8000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? r.json() : null;
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────
// CANDLE HISTORY (tracks last few 5m candles)
// ─────────────────────────────────────────────
// Each entry: { open, close, type } where type = 'green'|'red'|'doji'
const candleHistory = {}; // keyed by pair

function classifyCandle(open, close) {
  const diff = close - open;
  const pct  = Math.abs(diff) / (open || 1);
  if (pct < 0.0015) return 'doji';   // < 0.15% body = doji
  return diff > 0 ? 'green' : 'red';
}

// Determine which side to trade based on previous candle & history
// Returns 'up', 'down', or null (unknown)
function resolveTradeDirection(pair) {
  const hist = candleHistory[pair];
  if (!hist || hist.length === 0) return null;

  const last = hist[hist.length - 1];

  // Doji resolution: look back at 2 consecutive candles before doji
  if (last.type === 'doji') {
    if (hist.length >= 3) {
      const prev1 = hist[hist.length - 2];
      const prev2 = hist[hist.length - 3];
      if (prev1.type === 'green' && prev2.type === 'green') {
        log(`🕯️  ${pair} Doji after 2 consecutive GREEN → treated as RED → trade DOWN`);
        return 'down';
      }
      if (prev1.type === 'red' && prev2.type === 'red') {
        log(`🕯️  ${pair} Doji after 2 consecutive RED → treated as GREEN → trade UP`);
        return 'up';
      }
    }
    // Doji with no clear consecutive context — skip
    log(`🕯️  ${pair} Doji with no clear consecutive context — skipping window`);
    return null;
  }

  if (last.type === 'green') {
    log(`🕯️  ${pair} Previous candle GREEN → trading UP only`);
    return 'up';
  }
  if (last.type === 'red') {
    log(`🕯️  ${pair} Previous candle RED → trading DOWN only`);
    return 'down';
  }

  return null;
}

// Record a completed candle for a pair
function recordCandle(pair, open, close) {
  if (!candleHistory[pair]) candleHistory[pair] = [];
  const type = classifyCandle(open, close);
  candleHistory[pair].push({ open, close, type });
  // Keep last 5 candles
  if (candleHistory[pair].length > 5) candleHistory[pair].shift();
  log(`🕯️  ${pair} Candle recorded: ${type.toUpperCase()} (${open.toFixed(4)} → ${close.toFixed(4)})`);
}

// ── WebSocket price feed ──
let ws          = null;
let wsPingTimer = null;
const wsTokenMap = {};

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log('🔌 Connecting price WebSocket…');
  ws = new WebSocket(CLOB_WS);

  ws.on('open', () => {
    log('✅ Price WebSocket connected');
    const tokenIds = Object.keys(wsTokenMap);
    if (tokenIds.length > 0) wsSubscribe(tokenIds);
    wsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({}));
    }, 10000);
  });

  ws.on('message', (raw) => {
    try {
      const msgs = JSON.parse(raw);
      const arr  = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of arr) {
        if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
          for (const pc of msg.price_changes) updateMarketPrice(pc.asset_id, pc.best_bid, pc.best_ask);
        }
        if (msg.event_type === 'best_bid_ask') {
          updateMarketPrice(msg.asset_id, msg.best_bid, msg.best_ask);
        }
        if (msg.event_type === 'book') {
          const bestBid = msg.bids?.[0]?.price ? parseFloat(msg.bids[0].price) : null;
          const bestAsk = msg.asks?.[0]?.price ? parseFloat(msg.asks[0].price) : null;
          updateMarketPrice(msg.asset_id, bestBid, bestAsk);
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    log('⚠️  Price WebSocket closed — reconnecting in 2s');
    setTimeout(wsConnect, 2000);
  });

  ws.on('error', (e) => {
    log(`⚠️  WS error: ${e.message}`);
    try { ws.terminate(); } catch (_) {}
  });
}

function updateMarketPrice(tokenId, bestBid, bestAsk) {
  if (!tokenId) return;
  const slug = wsTokenMap[tokenId];
  if (!slug || !markets[slug]) return;
  const m   = markets[slug];
  const bid = bestBid ? f4(parseFloat(bestBid)) : null;
  const rawAsk = bestAsk ? f4(parseFloat(bestAsk)) : null;
  const ask = (rawAsk && rawAsk < TP_PRICE) ? rawAsk : null;

  if (tokenId === m.upTokenId) {
    if (bid) m.upBestBid = bid;
    if (ask) m.upBestAsk = ask;
    const b = m.upBestBid, a = m.upBestAsk;
    if (b && a) { m.upMid = f4((b + a) / 2); m.lastPriceAt = Date.now(); }
    else if (bid || ask) { m.upMid = bid || ask; m.lastPriceAt = Date.now(); }
  }
  if (tokenId === m.downTokenId) {
    if (bid) m.dnBestBid = bid;
    if (ask) m.dnBestAsk = ask;
    const b = m.dnBestBid, a = m.dnBestAsk;
    if (b && a) { m.downMid = f4((b + a) / 2); m.lastPriceAt = Date.now(); }
    else if (bid || ask) { m.downMid = bid || ask; m.lastPriceAt = Date.now(); }
  }
}

function wsSubscribe(tokenIds) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ assets_ids: tokenIds, type: 'market' }));
}

async function restRefreshPrice(m) {
  const [ur, dr, ubba, dbba] = await Promise.all([
    getJSON(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
    getJSON(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
    getJSON(`${CLOB}/book?token_id=${m.upTokenId}`),
    getJSON(`${CLOB}/book?token_id=${m.downTokenId}`),
  ]);
  if (ur?.mid)  m.upMid   = f4(parseFloat(ur.mid));
  if (dr?.mid)  m.downMid = f4(parseFloat(dr.mid));
  if (ubba?.bids?.[0]?.price) m.upBestBid = f4(parseFloat(ubba.bids[0].price));
  const upAsk = ubba?.asks?.[0]?.price ? f4(parseFloat(ubba.asks[0].price)) : null;
  if (upAsk && upAsk < TP_PRICE) m.upBestAsk = upAsk;
  if (dbba?.bids?.[0]?.price) m.dnBestBid = f4(parseFloat(dbba.bids[0].price));
  const dnAsk = dbba?.asks?.[0]?.price ? f4(parseFloat(dbba.asks[0].price)) : null;
  if (dnAsk && dnAsk < TP_PRICE) m.dnBestAsk = dnAsk;
  if (!m.upBestAsk && m.upMid)   { m.upBestAsk = f4(m.upMid + 0.01); m.upBestBid = f4(m.upMid - 0.01); }
  if (!m.dnBestAsk && m.downMid) { m.dnBestAsk = f4(m.downMid + 0.01); m.dnBestBid = f4(m.downMid - 0.01); }
  m.lastPriceAt = Date.now();
}

async function ensureFreshPrice(m) {
  const stale = !m.lastPriceAt || (Date.now() - m.lastPriceAt) > 3000;
  if (stale) await restRefreshPrice(m);
}

// ── Candle Bootstrap ──
// Walk back through the last N completed 5m windows using the same slug
// structure the bot already knows: btc-updown-5m-{windowStartUnix}
// For each window fetch its UP token's opening + closing midpoint prices
// from the CLOB /timeseries endpoint, classify the candle and seed history.
async function bootstrapCandleHistory(pair, windowsToFetch = 5) {
  log(`🕯️  Bootstrapping candle history for ${pair} (last ${windowsToFetch} windows)…`);

  const nowSecs      = Math.floor(Date.now() / 1000);
  const curWinStart  = Math.floor(nowSecs / WINDOW_SECS) * WINDOW_SECS;
  const fetched      = [];

  // Walk backwards: skip the current (live) window, go back windowsToFetch
  for (let i = windowsToFetch; i >= 1; i--) {
    const winStart = curWinStart - i * WINDOW_SECS;
    const slug     = `${pair.toLowerCase()}-updown-5m-${winStart}`;

    // 1. Fetch event to get token IDs
    const d = await getJSON(`${GAMMA}/events?slug=${slug}`);
    if (!Array.isArray(d) || !d[0]?.markets?.[0]) {
      log(`🕯️  Bootstrap: no event for ${slug} — skipping`);
      continue;
    }

    const mk = d[0].markets[0];
    if (!mk.clobTokenIds) continue;

    let ids;
    try { ids = JSON.parse(mk.clobTokenIds); } catch (_) { continue; }
    if (ids.length < 2) continue;

    const upTokenId = ids[0];  // UP token
    const endTime   = mk.endDate ? Math.floor(new Date(mk.endDate).getTime() / 1000) : null;
    if (!endTime) continue;

    const startTime = endTime - WINDOW_SECS;  // unix seconds

    // 2. Fetch CLOB timeseries for the UP token over this window
    //    fidelity=1 gives per-minute bars; we want open (first bar) and close (last bar)
    const tsUrl = `${CLOB}/prices-history?market=${upTokenId}&startTs=${startTime}&endTs=${endTime}&fidelity=1`;
    const ts    = await getJSON(tsUrl);

    let open = null, close = null;

    if (ts?.history && Array.isArray(ts.history) && ts.history.length >= 2) {
      // history entries: { t: unixSecs, p: price }
      open  = parseFloat(ts.history[0].p);
      close = parseFloat(ts.history[ts.history.length - 1].p);
    } else {
      // Fallback: use midpoint at startTs and endTs via separate calls
      const [mStart, mEnd] = await Promise.all([
        getJSON(`${CLOB}/midpoint?token_id=${upTokenId}`),   // best we can do without historical snapshot
        getJSON(`${CLOB}/midpoint?token_id=${upTokenId}`),
      ]);
      // If timeseries unavailable we can still try the resolved/final price
      // from the market data itself (outcomePrices field on the event)
      const outcomes = mk.outcomePrices ? JSON.parse(mk.outcomePrices) : null;
      if (outcomes && outcomes.length >= 2) {
        // outcomePrices = [upFinalPrice, downFinalPrice] as strings
        close = parseFloat(outcomes[0]);
        // For open, we estimate 0.50 (market opens near 50/50)
        open  = 0.50;
      }
    }

    if (open === null || close === null || isNaN(open) || isNaN(close)) {
      log(`🕯️  Bootstrap: could not get open/close for ${slug} — skipping`);
      continue;
    }

    const type = classifyCandle(open, close);
    fetched.push({ open: f4(open), close: f4(close), type, slug });
    log(`🕯️  Bootstrap ${slug}: ${type.toUpperCase()} (${f4(open)} → ${f4(close)})`);
  }

  if (fetched.length === 0) {
    log(`⚠️  Bootstrap: no historical candles found for ${pair} — bot will skip first window`);
    return;
  }

  candleHistory[pair] = fetched;
  log(`✅ Bootstrap complete: ${fetched.length} candles seeded for ${pair} → direction will be: ${resolveTradeDirection(pair) || 'UNDECIDED'}`);
}

// ── Market Discovery ──
function currentWindowStart() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
}

async function discoverMarket(pair) {
  const ws_ts = currentWindowStart();
  const slug  = `${pair.toLowerCase()}-updown-5m-${ws_ts}`;
  if (markets[slug]) return;

  const d = await getJSON(`${GAMMA}/events?slug=${slug}`);
  if (!Array.isArray(d) || !d[0]?.markets?.[0]) return;

  const mk = d[0].markets[0];
  if (!mk.clobTokenIds) return;

  let ids;
  try { ids = JSON.parse(mk.clobTokenIds); } catch (_) { return; }
  if (ids.length < 2) return;

  const endTime = mk.endDate ? new Date(mk.endDate).getTime() : null;
  if (!endTime) return;

  const secsToEnd      = (endTime - Date.now()) / 1000;
  if (secsToEnd <= 0 || secsToEnd > WINDOW_SECS + 5) return;

  const windowStartMs  = endTime - WINDOW_SECS * 1000;
  const secsIntoWindow = (Date.now() - windowStartMs) / 1000;

  // Don't enter if we're past the last fire point (240s) + buffer
  if (secsIntoWindow >= ENTRY_FIRE_SECS[ENTRY_FIRE_SECS.length - 1] + 10) {
    log(`⏭️  ${pair} past all entry windows (${Math.floor(secsIntoWindow)}s in) — waiting for next`);
    return;
  }

  // Resolve trade direction from candle history
  const direction = resolveTradeDirection(pair);
  if (!direction) {
    log(`⏭️  ${pair} no clear candle direction — skipping window (need more history)`);
    return;
  }

  let upTickSize = '0.01', upNegRisk = false;
  let dnTickSize = '0.01', dnNegRisk = false;
  try {
    [upTickSize, upNegRisk, dnTickSize, dnNegRisk] = await Promise.all([
      trader._clob.getTickSize(ids[0]).catch(() => '0.01'),
      trader._clob.getNegRisk(ids[0]).catch(() => false),
      trader._clob.getTickSize(ids[1]).catch(() => '0.01'),
      trader._clob.getNegRisk(ids[1]).catch(() => false),
    ]);
  } catch (_) {}

  log(`🔍 ${pair} window found: ${slug} — direction=${direction.toUpperCase()} — ends in ${Math.floor(secsToEnd)}s (${Math.floor(secsIntoWindow)}s in)`);

  markets[slug] = {
    slug, pair,
    upTokenId: ids[0], downTokenId: ids[1],
    endTime, windowStartMs,
    upMid: 0.5, downMid: 0.5,
    upBestBid: 0, upBestAsk: 0,
    dnBestBid: 0, dnBestAsk: 0,
    lastPriceAt: 0,
    upTickSize, upNegRisk,
    dnTickSize, dnNegRisk,

    direction,          // 'up' or 'down' — only side we trade
    openPrice: 0,       // price at window open (for candle recording)

    // Position tracking for the one active side
    shares: 0,          // total shares currently held
    totalCost: 0,       // total cost basis of open position
    openTrades: [],     // [{ shares, entryPrice, cost }]
    openOrderIds: [],   // all open order IDs (entries + TPs)
    tpOrderIds: [],     // TP order IDs pending fill
    firedCount: 0,      // how many of the 4 entry fires have happened
    nextFireIdx: 0,     // index into ENTRY_FIRE_SECS
    forceSellDone: false,
    done: false,
    loopRunning: false,

    // Candle tracking
    candleOpen: null,   // price at window open (set on first price)
  };

  wsTokenMap[ids[0]] = slug;
  wsTokenMap[ids[1]] = slug;
  wsSubscribe([ids[0], ids[1]]);
  await restRefreshPrice(markets[slug]);

  // Capture opening price for candle recording at end of window
  const m = markets[slug];
  m.candleOpen = direction === 'up' ? m.upMid : m.downMid;

  // Launch the single trading loop
  tradeLoop(markets[slug]).catch(e => log(`❌ Trade loop crash ${pair}: ${e.message}`));
}

// ── Place a limit order ──
async function placeLimitOrder(tokenId, side, price, shares, label) {
  if (DRY_RUN) {
    const fakeId = `DRY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log(`[DRY_RUN] ${side} limit ${shares}sh @ ${price} for ${label} → id=${fakeId}`);
    return fakeId;
  }
  try {
    const r = await trader.placeGtcOrder(tokenId, side, price, shares);
    if (r?.id) return r.id;
    log(`⚠️  ${label} limit order returned no ID`);
    return null;
  } catch (e) {
    log(`⚠️  ${label} limit order error: ${e.message}`);
    return null;
  }
}

async function cancelOrder(orderId, label) {
  if (DRY_RUN) {
    log(`[DRY_RUN] Cancel order ${orderId} (${label})`);
    return;
  }
  try { await trader.cancelOrder(orderId); } catch (_) {}
}

async function waitForFill(orderId, timeoutMs, label) {
  if (DRY_RUN) {
    await sleep(800);
    log(`[DRY_RUN] Simulated fill for ${orderId} (${label})`);
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const order = await trader.getOrder(orderId);
      if (!order) continue;
      const status      = (order.status || '').toUpperCase();
      const matchStatus = (order.match_status || order.matchStatus || '').toLowerCase();
      const state       = (order.state || '').toLowerCase();
      if (status === 'FILLED' || matchStatus === 'filled' || state === 'filled') return true;
      if (status === 'CANCELLED' || matchStatus === 'cancelled') {
        log(`⚠️  ${label} order cancelled externally`);
        return false;
      }
    } catch (_) {}
  }
  return false;
}

// ── Calculate unrealized P&L in real time ──
// For the active direction: currentPrice vs avgCostBasis
// Win = price resolves to 1.00, loss = price resolves to 0.00
// Unrealized = (currentMid - avgCost) * shares  (rough mark-to-market)
function calcUnrealized(m) {
  if (!m || m.shares === 0) return 0;
  const avgCost    = m.totalCost / m.shares;
  const currentMid = m.direction === 'up' ? m.upMid : m.downMid;
  return f2((currentMid - avgCost) * m.shares);
}

// Capital = demoBalance + realizedPnl + sum(unrealizedPnl across all active markets)
function calcCapital() {
  let unrealized = 0;
  for (const m of Object.values(markets)) {
    unrealized += calcUnrealized(m);
  }
  return f2(demoBalance + realizedPnl + unrealized);
}

// ── Fire a single entry (called at each 60/120/180/240s mark) ──
async function fireEntry(m) {
  const isUp    = m.direction === 'up';
  const label   = isUp ? 'UP' : 'DOWN';
  const tokenId = isUp ? m.upTokenId : m.downTokenId;
  const mid     = isUp ? m.upMid : m.downMid;
  const tick    = parseFloat(isUp ? m.upTickSize : m.dnTickSize) || 0.01;

  let rawPx = mid > 0 ? mid : 0;
  if (rawPx <= 0) { log(`⚠️  ${label} no price — skip fire`); return; }
  rawPx = Math.min(rawPx, TP_PRICE - tick);
  const entryPx = f4(Math.round(rawPx / tick) * tick);
  if (entryPx <= 0.01) { log(`⚠️  ${label} price ${entryPx} too low — skip`); return; }

  const shares = SHARES_PER_FIRE; // always 6
  log(`📥 FIRE ${m.firedCount + 1}/4 — ${label} BUY ${shares}sh @ ${entryPx}`);

  const orderId = await placeLimitOrder(tokenId, 'BUY', entryPx, shares, `${label}-fire${m.firedCount + 1}`);
  if (!orderId) return;
  m.openOrderIds.push(orderId);

  // Wait up to 15s for fill
  const filled = await waitForFill(orderId, 15000, `${label}-fire${m.firedCount + 1}`);

  m.openOrderIds = m.openOrderIds.filter(id => id !== orderId);

  if (!filled) {
    log(`⏰ ${label} fire${m.firedCount + 1} not filled — cancelling`);
    await cancelOrder(orderId, `${label}-fire${m.firedCount + 1}`);
    return;
  }

  const cost = f4(entryPx * shares);
  log(`✅ ${label} fire${m.firedCount + 1} FILLED ${shares}sh @ ${entryPx} | cost $${cost}`);

  m.shares     += shares;
  m.totalCost  += cost;
  m.firedCount++;
  m.openTrades.push({ shares, entryPrice: entryPx, cost });

  trades.push({
    time: new Date().toTimeString().slice(0, 8),
    pair: m.pair, side: label,
    shares, price: entryPx, cost,
    fire: m.firedCount,
  });

  // Place TP immediately
  const tpId = await placeLimitOrder(tokenId, 'SELL', TP_PRICE, shares, `${label}-TP${m.firedCount}`);
  if (tpId) {
    m.tpOrderIds.push(tpId);
    m.openOrderIds.push(tpId);
    log(`🎯 TP placed ${shares}sh @ ${TP_PRICE} → id=${tpId}`);
  }

  // Capital updates in real-time via calcCapital()
  log(`💰 Capital (real-time): $${calcCapital()} | Unrealized: $${calcUnrealized(m)}`);
  emitFn('state', buildState());
}

// ── Force sell ALL shares at 298s ──
async function forceSell(m) {
  if (m.forceSellDone) return;
  m.forceSellDone = true;

  if (m.shares === 0) {
    log(`✅ ${m.pair} force-sell: no open shares to sell`);
    return;
  }

  const isUp    = m.direction === 'up';
  const label   = isUp ? 'UP' : 'DOWN';
  const tokenId = isUp ? m.upTokenId : m.downTokenId;
  const bid     = isUp ? m.upBestBid : m.dnBestBid;
  const mid     = isUp ? m.upMid : m.downMid;
  const tick    = parseFloat(isUp ? m.upTickSize : m.dnTickSize) || 0.01;

  // First: cancel all open TP orders
  if (m.openOrderIds.length > 0) {
    log(`🧹 Cancelling ${m.openOrderIds.length} open orders before force-sell`);
    await Promise.all(m.openOrderIds.map(id => cancelOrder(id, 'pre-forcesell')));
    m.openOrderIds = [];
    m.tpOrderIds   = [];
  }

  // Sell at best available price (bid or mid - 1 tick)
  let sellPx = bid > 0 ? bid : (mid > 0 ? f4(mid - tick) : 0);
  if (sellPx <= 0) sellPx = 0.01;
  sellPx = f4(Math.round(sellPx / tick) * tick);

  const totalShares = m.shares;
  log(`🚨 FORCE SELL ${m.pair} ${totalShares}sh @ ${sellPx} at 298s`);

  const orderId = await placeLimitOrder(tokenId, 'SELL', sellPx, totalShares, `${label}-FORCE`);
  if (!orderId) {
    log(`❌ Force sell order failed for ${m.pair}`);
    return;
  }
  m.openOrderIds.push(orderId);

  // Wait up to 4s for fill (only 2s left in window)
  const filled = await waitForFill(orderId, 4000, `${label}-FORCE`);
  m.openOrderIds = m.openOrderIds.filter(id => id !== orderId);

  if (!filled) {
    log(`⚠️  Force sell not filled in time — cancelling ${orderId}`);
    await cancelOrder(orderId, `${label}-FORCE`);
    // Even if not filled, record the attempted close
  }

  // Compute realized P&L from this force-sell
  const revenue    = f4(sellPx * totalShares);
  const tradePnl   = f2(revenue - m.totalCost);
  const won        = tradePnl > 0;

  log(`📊 Force-sell result: revenue=$${revenue} | cost=$${f2(m.totalCost)} | P&L=$${tradePnl}`);

  // Update realized P&L immediately
  realizedPnl = f2(realizedPnl + tradePnl);

  // Clear position
  m.shares    = 0;
  m.totalCost = 0;
  m.openTrades = [];

  log(`💰 Capital UPDATED (realized): $${calcCapital()} | Session P&L: $${realizedPnl}`);
  if (won) log(`🏆 ${m.pair} WINNER — capital updated immediately`);
  else     log(`📉 ${m.pair} loss — capital updated`);

  // Record candle close price for next window's direction
  const closePrice = isUp ? m.upMid : m.downMid;
  if (m.candleOpen && closePrice) {
    recordCandle(m.pair, m.candleOpen, closePrice);
  }

  emitFn('state', buildState());
}

// ── Main trading loop for one market window ──
async function tradeLoop(m) {
  m.loopRunning = true;
  const label = m.direction.toUpperCase();
  log(`🚀 Trade loop: ${m.pair} direction=${label} fires at ${ENTRY_FIRE_SECS.join('/')}s`);

  const secsIn = () => (Date.now() - m.windowStartMs) / 1000;

  // Track which fire indices we've already fired
  const fired = new Set();

  while (!m.done) {
    const secs = secsIn();

    // ── 298s: force sell ──
    if (secs >= FORCE_SELL_SECS && !m.forceSellDone) {
      await forceSell(m);
      m.done = true;
      break;
    }

    await ensureFreshPrice(m);

    // ── Check each fire point (60, 120, 180, 240s) ──
    for (let i = 0; i < ENTRY_FIRE_SECS.length; i++) {
      const fireAt = ENTRY_FIRE_SECS[i];
      if (!fired.has(i) && secs >= fireAt && secs < fireAt + 5) {
        fired.add(i);
        log(`⏱️  ${m.pair} ${secs.toFixed(1)}s — firing entry ${i + 1}/4`);
        await fireEntry(m);
        break;  // Only one entry per tick cycle
      }
    }

    // ── Real-time capital broadcast every tick ──
    emitFn('state', buildState());

    await sleep(TICK_MS);
  }

  m.loopRunning = false;
  log(`🏁 Trade loop ended for ${m.pair}`);
}

// ── Discovery loop ──
async function discoverLoop() {
  while (true) {
    if (trader && Date.now() - lastDiscoverAt > DISCOVER_EVERY_MS) {
      lastDiscoverAt = Date.now();
      for (const pair of TARGET_PAIRS) {
        await discoverMarket(pair).catch(e => log(`⚠️  Discover ${pair}: ${e.message}`));
      }
    }
    await sleep(2000);
  }
}

// ── Build dashboard state ──
function buildState() {
  const capital    = calcCapital();
  const sessionPnl = f2(capital - demoBalance);

  const mktList = Object.values(markets).map(m => {
    const unrealized = calcUnrealized(m);
    const avgCost    = m.shares > 0 ? f4(m.totalCost / m.shares) : 0;
    return {
      slug:        m.slug,
      pair:        m.pair,
      direction:   m.direction,
      secsIn:      Math.floor((Date.now() - m.windowStartMs) / 1000),
      secsLeft:    Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
      upPrice:     m.upMid,
      downPrice:   m.downMid,
      upBid:       m.upBestBid,
      downBid:     m.dnBestBid,
      shares:      m.shares,
      totalCost:   f2(m.totalCost),
      avgCost,
      unrealized,
      firedCount:  m.firedCount,
      openOrders:  m.openOrderIds.length,
      forceSellDone: m.forceSellDone,
      done:        m.done,
      dryRun:      DRY_RUN,
    };
  });

  return {
    capital,                          // real-time: demoBalance + realizedPnl + unrealized
    startBalance: demoBalance,
    realizedPnl,
    pnl: sessionPnl,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    dryRun: DRY_RUN,
    markets: mktList,
    trades: trades.slice(-50),
    logs: logs.slice(0, 80),
    candleHistory,
  };
}

// ── Exports ──
async function init(privateKey, emit, serverLog) {
  emitFn = emit || (() => {});
  slog   = serverLog || (() => {});

  log(`🤖 Bot starting… DRY_RUN=${DRY_RUN}`);
  if (DRY_RUN) log('⚠️  DRY RUN MODE — no real orders will be placed');

  trader = new PolymarketTrader(privateKey);
  trader.setLogFn(log);

  await trader.authenticate();
  await trader.approveAllowance();

  if (DRY_RUN) {
    demoBalance = 200;
    log('💰 DRY RUN demo balance set to $200');
  } else {
    demoBalance = await trader.getBalance();
    log(`💰 Live balance: $${demoBalance}`);
  }
  realizedPnl = 0;
  startTime   = Date.now();

  wsConnect();

  // Bootstrap candle history from past completed windows before trading
  for (const pair of TARGET_PAIRS) {
    await bootstrapCandleHistory(pair, 5).catch(e => log(`⚠️  Bootstrap ${pair} failed: ${e.message}`));
  }

  discoverLoop().catch(e => log(`❌ Discover loop crashed: ${e.message}`));

  // Broadcast state every second
  setInterval(() => emitFn('state', buildState()), 1000);
}

function getState() { return buildState(); }
function getLogs()  { return logs; }

module.exports = { init, getState, getLogs };
