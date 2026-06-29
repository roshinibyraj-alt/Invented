'use strict';

const WebSocket        = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Window & timing ──
const WINDOW_SECS       = 300;
const DISCOVER_EVERY_MS = 15000;
const TICK_MS           = 500;

// ── Strategy config ──
const TP_PRICE         = 0.99;   // Take-profit limit price
const WINDOW_CUTOFF_S  = 210;    // No new entries after this many seconds
const DRY_RUN          = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// Per-side entry rules based on price
// If price < 0.50  → 6 shares every 25s
// If price >= 0.50 → 12 shares every 50s
const RULE_LOW  = { shares: 6,  intervalMs: 25000 };
const RULE_HIGH = { shares: 12, intervalMs: 50000 };

const TARGET_PAIRS = ['BTC'];

let emitFn       = () => {};
let slog         = () => {};
let trader       = null;
let balance      = 0;
let startBalance = 0;
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
  // Ignore ask prices at or above TP_PRICE — could be our own TP sell orders polluting the book
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

  // Don't enter if past the 210s cutoff
  if (secsIntoWindow >= WINDOW_CUTOFF_S) {
    log(`⏭️  ${pair} past entry cutoff (${Math.floor(secsIntoWindow)}s in) — waiting for next window`);
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

  log(`🔍 ${pair} window found: ${slug} ends in ${Math.floor(secsToEnd)}s (${Math.floor(secsIntoWindow)}s in)`);

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
    // Per-side tracking
    upShares: 0,   downShares: 0,
    upCost:   0,   downCost:   0,
    upEntries: [], downEntries: [],  // { orderId, shares, price, tpOrderId }
    upOpenOrders: [],                // all open order IDs for UP (entries + TPs)
    downOpenOrders: [],              // all open order IDs for DOWN
    upDone: false, downDone: false,
    done: false, loopRunning: false,
  };

  wsTokenMap[ids[0]] = slug;
  wsTokenMap[ids[1]] = slug;
  wsSubscribe([ids[0], ids[1]]);
  await restRefreshPrice(markets[slug]);

  // Launch UP and DOWN loops independently in parallel
  sideLoop(markets[slug], 'up').catch(e => log(`❌ UP loop crash ${pair}: ${e.message}`));
  sideLoop(markets[slug], 'down').catch(e => log(`❌ DOWN loop crash ${pair}: ${e.message}`));
}

// ── Place a limit order (entry or TP) ──
async function placeLimitOrder(tokenId, side, price, shares, label) {
  if (DRY_RUN) {
    const fakeId = `DRY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log(`[DRY_RUN] Would place ${side} limit order: ${shares}sh @ ${price} for ${label} → fakeId=${fakeId}`);
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

// ── Cancel a single order ──
async function cancelOrder(orderId, label) {
  if (DRY_RUN) {
    log(`[DRY_RUN] Would cancel order ${orderId} (${label})`);
    return;
  }
  try { await trader.cancelOrder(orderId); } catch (_) {}
}

// ── Poll order until filled or timeout ──
async function waitForFill(orderId, timeoutMs, label) {
  if (DRY_RUN) {
    // Simulate fill after 1.5s in dry run
    await sleep(1500);
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

// ── Place TP limit sell after entry fill ──
async function placeTP(m, isUp, shares, entryPrice) {
  const tokenId = isUp ? m.upTokenId : m.downTokenId;
  const label   = isUp ? 'UP-TP' : 'DOWN-TP';
  log(`🎯 Placing ${label} SELL ${shares}sh @ ${TP_PRICE} (entry was ${entryPrice})`);
  const tpId = await placeLimitOrder(tokenId, 'SELL', TP_PRICE, shares, label);
  if (tpId) {
    if (isUp)  m.upOpenOrders.push(tpId);
    else       m.downOpenOrders.push(tpId);
    log(`✅ ${label} order placed → id=${tpId} — awaiting fill or resolution`);
    // DRY_RUN: TP stays open as a real order would. Proceeds only realised on resolution.
  }
  return tpId;
}

// ── Single entry attempt ──
async function tryEntry(m, isUp) {
  const label    = isUp ? 'UP' : 'DOWN';
  const tokenId  = isUp ? m.upTokenId  : m.downTokenId;
  const ask      = isUp ? m.upBestAsk  : m.dnBestAsk;
  const mid      = isUp ? m.upMid      : m.downMid;
  const tickSize = isUp ? m.upTickSize : m.dnTickSize;

  // Determine shares based on current price
  const price_now = isUp ? m.upMid : m.downMid;
  const rule      = price_now < 0.50 ? RULE_LOW : RULE_HIGH;
  const shares    = rule.shares;

  // Use mid as entry price — avoids picking up our own TP sell orders from the ask
  // Fall back to ask only if mid unavailable and ask is genuinely below TP
  const tick  = parseFloat(tickSize) || 0.01;
  let rawPx   = (mid && mid > 0) ? mid : (ask && ask < TP_PRICE ? ask : 0);
  if (rawPx <= 0) { log(`⚠️  ${label} no price — skip entry`); return false; }
  // Hard cap: entry must always be strictly below TP price
  rawPx = Math.min(rawPx, TP_PRICE - tick);
  let entryPx = f4(Math.round(rawPx / tick) * tick);
  if (entryPx <= 0.01) { log(`⚠️  ${label} price ${entryPx} too low — skip`); return false; }

  log(`📥 ${label} LIMIT BUY ${shares}sh @ ${entryPx} (price=${price_now}, rule=${price_now < 0.50 ? 'LOW' : 'HIGH'})`);

  const orderId = await placeLimitOrder(tokenId, 'BUY', entryPx, shares, label);
  if (!orderId) return false;

  if (isUp)  m.upOpenOrders.push(orderId);
  else       m.downOpenOrders.push(orderId);

  // Wait for fill — up to the remaining time before 210s cutoff, max 20s
  const secsIn      = (Date.now() - m.windowStartMs) / 1000;
  const timeLeft    = Math.max(0, (WINDOW_CUTOFF_S - secsIn) * 1000);
  const fillTimeout = Math.min(20000, timeLeft);

  const filled = await waitForFill(orderId, fillTimeout, label);

  if (!filled) {
    log(`⏰ ${label} entry not filled — cancelling ${orderId}`);
    await cancelOrder(orderId, label);
    // Remove from open orders
    if (isUp)  m.upOpenOrders   = m.upOpenOrders.filter(id => id !== orderId);
    else       m.downOpenOrders = m.downOpenOrders.filter(id => id !== orderId);
    return false;
  }

  // Remove entry from open orders (it's filled now)
  if (isUp)  m.upOpenOrders   = m.upOpenOrders.filter(id => id !== orderId);
  else       m.downOpenOrders = m.downOpenOrders.filter(id => id !== orderId);

  const cost = f4(entryPx * shares);
  log(`✅ ${label} FILLED ${shares}sh @ ${entryPx} | cost $${cost}`);

  if (isUp) { m.upShares += shares;   m.upCost   += cost; }
  else      { m.downShares += shares; m.downCost += cost; }

  // Deduct cost from demo balance in DRY_RUN
  if (DRY_RUN) {
    balance = f2(balance - cost);
    log(`[DRY_RUN] Demo balance after entry: $${balance}`);
  }

  trades.push({
    time: new Date().toTimeString().slice(0, 8),
    pair: m.pair, side: label,
    shares, price: entryPx, cost,
  });
  emitFn('state', buildState());

  // Place TP immediately after fill
  await placeTP(m, isUp, shares, entryPx);

  return true;
}

// ── Cancel all open orders for a side at 210s ──
async function cancelAllOpenOrders(m, isUp) {
  const label  = isUp ? 'UP' : 'DOWN';
  const orders = isUp ? m.upOpenOrders : m.downOpenOrders;
  if (orders.length === 0) {
    log(`✅ ${label} no open orders to cancel`);
    return;
  }
  log(`🧹 Cancelling ${orders.length} open ${label} orders at window cutoff`);
  await Promise.all(orders.map(id => cancelOrder(id, `${label}-cleanup`)));
  if (isUp) m.upOpenOrders   = [];
  else      m.downOpenOrders = [];
}

// ── Independent per-side loop ──
async function sideLoop(m, side) {
  const isUp  = side === 'up';
  const label = isUp ? 'UP' : 'DOWN';
  log(`🚀 ${label} loop started for ${m.pair}`);

  const secsIn = () => (Date.now() - m.windowStartMs) / 1000;

  let lastEntryAt = -Infinity; // ms timestamp of last entry fire

  while (!m.done) {
    const secs = secsIn();

    // ── 210s: cancel all open orders, stop entries, let TP/resolution handle it ──
    if (secs >= WINDOW_CUTOFF_S) {
      log(`⛔ ${label} ${WINDOW_CUTOFF_S}s reached — cancelling open orders, no more entries`);
      await cancelAllOpenOrders(m, isUp);
      log(`🏁 ${label} loop ended — awaiting TP fills or Polymarket resolution`);
      break;
    }

    await ensureFreshPrice(m);

    // Determine current rule for this side
    const price_now = isUp ? m.upMid : m.downMid;
    const rule      = price_now < 0.50 ? RULE_LOW : RULE_HIGH;
    const intervalMs = rule.intervalMs;

    const now = Date.now();
    const timeSinceLast = now - lastEntryAt;

    if (timeSinceLast >= intervalMs) {
      lastEntryAt = now;
      // Fire entry (non-blocking — loop continues after, but we await the entry+TP placement)
      await tryEntry(m, isUp);
      emitFn('state', buildState());
    }

    await sleep(TICK_MS);
  }

  log(`🏁 ${label} side loop exited for ${m.pair}`);

  // Check if both sides done
  if (isUp) m.upDone = true;
  else      m.downDone = true;
  if (m.upDone && m.downDone) {
    m.done = true;
    log(`✅ Both sides done for ${m.pair}`);
  }
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
  const mktList = Object.values(markets).map(m => ({
    slug:         m.slug,
    pair:         m.pair,
    secsIn:       Math.floor((Date.now() - m.windowStartMs) / 1000),
    secsLeft:     Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
    upPrice:      m.upMid,
    downPrice:    m.downMid,
    upAsk:        m.upBestAsk,
    downAsk:      m.dnBestAsk,
    upBid:        m.upBestBid,
    downBid:      m.dnBestBid,
    upShares:     m.upShares,
    downShares:   m.downShares,
    upCost:       f2(m.upCost),
    downCost:     f2(m.downCost),
    totalCost:    f2(m.upCost + m.downCost),
    upOpenOrders: m.upOpenOrders.length,
    dnOpenOrders: m.downOpenOrders.length,
    upDone:       m.upDone,
    downDone:     m.downDone,
    done:         m.done,
    dryRun:       DRY_RUN,
  }));
  return {
    balance:      f2(balance),
    startBalance: f2(startBalance),
    pnl:          f2(balance - startBalance),
    uptime:       Math.floor((Date.now() - startTime) / 1000),
    dryRun:       DRY_RUN,
    markets:      mktList,
    trades:       trades.slice(-50),
    logs:         logs.slice(0, 80),
  };
}

// ── Exports called by index.js ──
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
    balance = 200;
    log('💰 DRY RUN demo balance set to $200');
  } else {
    balance = await trader.getBalance();
    log(`💰 Live balance: $${balance}`);
  }
  startBalance = balance;
  startTime    = Date.now();

  wsConnect();
  discoverLoop().catch(e => log(`❌ Discover loop crashed: ${e.message}`));

  setInterval(() => emitFn('state', buildState()), 2000);
}

function getState() { return buildState(); }
function getLogs()  { return logs; }

module.exports = { init, getState, getLogs };
