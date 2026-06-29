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
const SHARES          = 6;
const PRICE_OFFSET    = 0.03;
const FILL_WAIT_MS    = 20000;
const LAST_ENTRY_SECS = 125;
const NUKE_SECS       = 230;

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
  const ts   = new Date().toTimeString().slice(0, 8);
  const line = `[${ts}] ${msg}`;
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
  const ask = bestAsk ? f4(parseFloat(bestAsk)) : null;
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
  if (ubba?.asks?.[0]?.price) m.upBestAsk = f4(parseFloat(ubba.asks[0].price));
  if (dbba?.bids?.[0]?.price) m.dnBestBid = f4(parseFloat(dbba.bids[0].price));
  if (dbba?.asks?.[0]?.price) m.dnBestAsk = f4(parseFloat(dbba.asks[0].price));
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

  if (secsIntoWindow > LAST_ENTRY_SECS) {
    log(`⏭️  ${pair} past last entry slot (${Math.floor(secsIntoWindow)}s in) — waiting for next window`);
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
    upShares: 0, downShares: 0,
    upCost:   0, downCost:   0,
    merging: false, nuking: false,
    done: false, loopRunning: false,
  };

  wsTokenMap[ids[0]] = slug;
  wsTokenMap[ids[1]] = slug;
  wsSubscribe([ids[0], ids[1]]);
  await restRefreshPrice(markets[slug]);

  tradeLoop(markets[slug]).catch(e => log(`❌ Loop crash ${pair}: ${e.message}`));
}

// ── Single-side entry: GTC limit buy, wait 20s, cancel if not filled ──
async function tryEntry(m, side) {
  const isUp     = side === 'up';
  const tokenId  = isUp ? m.upTokenId  : m.downTokenId;
  const ask      = isUp ? m.upBestAsk  : m.dnBestAsk;
  const tickSize = isUp ? m.upTickSize : m.dnTickSize;
  const label    = isUp ? 'UP' : 'DOWN';

  if (!ask || ask <= 0) { log(`⚠️  ${label} no ask price — skip`); return 0; }

  const tick     = parseFloat(tickSize) || 0.01;
  const rawPrice = ask - PRICE_OFFSET;
  const price    = f4(Math.max(0.01, Math.round(rawPrice / tick) * tick));

  if (price <= 0.01) { log(`⚠️  ${label} price ${price} too low — skip`); return 0; }

  log(`📥 ${label} GTC BUY ${SHARES}sh @ ${price} (ask=${ask})`);

  let orderId;
  try {
    const resp = await trader.placeGtcOrder(tokenId, 'BUY', price, SHARES);
    orderId = resp?.id;
    if (!orderId) throw new Error('no orderID');
  } catch (e) {
    log(`❌ ${label} order failed: ${e.message}`);
    return 0;
  }

  const deadline = Date.now() + FILL_WAIT_MS;
  let filled = false;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const order = await trader.getOrder(orderId);
      if (!order) continue;
      const status      = (order.status || '').toUpperCase();
      const matchStatus = (order.match_status || order.matchStatus || '').toLowerCase();
      const state       = (order.state || '').toLowerCase();
      if (status === 'FILLED' || matchStatus === 'filled' || state === 'filled') { filled = true; break; }
      if (status === 'CANCELLED' || matchStatus === 'cancelled') {
        log(`⚠️  ${label} order cancelled externally`);
        return 0;
      }
    } catch (_) {}
  }

  if (!filled) {
    log(`⏰ ${label} not filled in 20s — cancelling`);
    try { await trader.cancelOrder(orderId); } catch (_) {}
    return 0;
  }

  const cost = f4(price * SHARES);
  log(`✅ ${label} FILLED ${SHARES}sh @ ${price} | cost $${cost}`);

  if (isUp) { m.upShares += SHARES;   m.upCost   += cost; }
  else      { m.downShares += SHARES; m.downCost += cost; }

  trades.push({
    time: new Date().toTimeString().slice(0, 8),
    pair: m.pair, side: label,
    shares: SHARES, price, cost,
  });

  emitFn('state', buildState());
  return SHARES;
}

// ── Cash-out: sell both sides via GTC at best bid (off-chain) ──
async function cashOut(m) {
  if (m.merging) return;
  m.merging = true;
  log(`💰 CASH OUT — selling ${m.upShares} UP + ${m.downShares} DOWN`);

  const sellSide = async (isUp) => {
    await ensureFreshPrice(m);
    const shares  = isUp ? m.upShares   : m.downShares;
    const tokenId = isUp ? m.upTokenId  : m.downTokenId;
    const bid     = isUp ? m.upBestBid  : m.dnBestBid;
    const mid     = isUp ? m.upMid      : m.downMid;
    const label   = isUp ? 'UP' : 'DOWN';
    if (shares <= 0) return;
    const price = f4(Math.max(0.01, bid || (mid - 0.01) || 0.01));
    log(`💸 Selling ${shares} ${label} @ ${price}`);
    try {
      const r = await trader.placeGtcOrder(tokenId, 'SELL', price, shares);
      if (r?.id) {
        await trader.waitForFill(r.id, 15000);
        log(`✅ ${label} sell filled`);
      }
    } catch (e) { log(`⚠️  ${label} sell error: ${e.message}`); }
  };

  await Promise.all([sellSide(true), sellSide(false)]);

  log(`📊 Cash-out done. Total cost was $${f2(m.upCost + m.downCost)}`);
  m.upShares = 0; m.downShares = 0;
  m.upCost   = 0; m.downCost   = 0;
  m.done     = true;
  balance = await trader.getBalance();
  emitFn('state', buildState());
}

// ── Force-sell at 230s: FOK market sell all remaining positions ──
async function forceSell(m) {
  if (m.nuking) return;
  m.nuking = true;
  log(`🚨 FORCE SELL at ${NUKE_SECS}s — liquidating all open positions`);

  const jobs = [];

  if (m.upShares > 0) {
    jobs.push((async () => {
      log(`🔥 Force-selling ${m.upShares} UP (FOK market)`);
      try {
        const r = await trader.placeFokSell(m.upTokenId, m.upShares);
        log(`🔥 UP → ${r.isFilled ? 'FILLED' : 'NOT FILLED'} avg:${r.avgPrice}`);
      } catch (e) { log(`⚠️  UP force-sell: ${e.message}`); }
    })());
  }

  if (m.downShares > 0) {
    jobs.push((async () => {
      log(`🔥 Force-selling ${m.downShares} DOWN (FOK market)`);
      try {
        const r = await trader.placeFokSell(m.downTokenId, m.downShares);
        log(`🔥 DOWN → ${r.isFilled ? 'FILLED' : 'NOT FILLED'} avg:${r.avgPrice}`);
      } catch (e) { log(`⚠️  DOWN force-sell: ${e.message}`); }
    })());
  }

  if (jobs.length === 0) log(`✅ No open positions at force-sell`);
  else await Promise.all(jobs);

  m.upShares = 0; m.downShares = 0;
  m.done     = true;
  balance = await trader.getBalance();
  emitFn('state', buildState());
}

// ── Main trade loop ──
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;
  log(`🚀 Trade loop started for ${m.pair}`);

  const secsIn = () => (Date.now() - m.windowStartMs) / 1000;
  const entrySlots = [0, 25, 50, 75, 100, 125];
  let slotIndex = 0;

  // Skip slots already elapsed when joining mid-window
  while (slotIndex < entrySlots.length && secsIn() > entrySlots[slotIndex] + 2) {
    log(`⏩ Skipping elapsed slot ${entrySlots[slotIndex]}s`);
    slotIndex++;
  }

  while (!m.done) {
    const secs = secsIn();

    // 230s: force-sell everything
    if (secs >= NUKE_SECS && !m.nuking) {
      await forceSell(m);
      break;
    }

    // Full set achieved: cash out immediately
    if (m.upShares >= SHARES && m.downShares >= SHARES && !m.merging && !m.nuking) {
      await cashOut(m);
      break;
    }

    // Next entry slot reached
    if (slotIndex < entrySlots.length && secs >= entrySlots[slotIndex]) {
      log(`⏱  Entry slot ${entrySlots[slotIndex]}s`);
      slotIndex++;

      await ensureFreshPrice(m);

      // Both sides fire in parallel unconditionally
      await Promise.all([
        m.upShares   < SHARES && !m.merging ? tryEntry(m, 'up')   : Promise.resolve(),
        m.downShares < SHARES && !m.merging ? tryEntry(m, 'down') : Promise.resolve(),
      ]);

      // Check for full set immediately after fills
      if (m.upShares >= SHARES && m.downShares >= SHARES && !m.merging) {
        await cashOut(m);
        break;
      }

      emitFn('state', buildState());
    }

    await sleep(TICK_MS);
  }

  log(`🏁 Trade loop ended for ${m.pair}`);
  m.loopRunning = false;
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
    slug:       m.slug,
    pair:       m.pair,
    secsIn:     Math.floor((Date.now() - m.windowStartMs) / 1000),
    secsLeft:   Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
    upPrice:    m.upMid,
    downPrice:  m.downMid,
    upAsk:      m.upBestAsk,
    downAsk:    m.dnBestAsk,
    upBid:      m.upBestBid,
    downBid:    m.dnBestBid,
    upShares:   m.upShares,
    downShares: m.downShares,
    upCost:     f2(m.upCost),
    downCost:   f2(m.downCost),
    totalCost:  f2(m.upCost + m.downCost),
    merging:    m.merging,
    nuking:     m.nuking,
    done:       m.done,
  }));
  return {
    balance:      f2(balance),
    startBalance: f2(startBalance),
    pnl:          f2(balance - startBalance),
    uptime:       Math.floor((Date.now() - startTime) / 1000),
    markets:      mktList,
    trades:       trades.slice(-50),
    logs:         logs.slice(0, 80),
  };
}

// ── Exports called by index.js ──
async function init(privateKey, emit, serverLog) {
  emitFn = emit || (() => {});
  slog   = serverLog || (() => {});

  log('🤖 Sniper bot starting…');
  trader = new PolymarketTrader(privateKey);
  trader.setLogFn(log);

  await trader.authenticate();
  await trader.approveAllowance();

  balance      = await trader.getBalance();
  startBalance = balance;
  startTime    = Date.now();

  log(`💰 Balance: $${balance}`);

  wsConnect();
  discoverLoop().catch(e => log(`❌ Discover loop crashed: ${e.message}`));

  setInterval(() => emitFn('state', buildState()), 2000);
}

function getState() { return buildState(); }
function getLogs()  { return logs; }

module.exports = { init, getState, getLogs };
