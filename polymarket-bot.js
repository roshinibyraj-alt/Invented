'use strict';

const WebSocket        = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const TICK_MS           = 500;
const DISCOVER_EVERY_MS = 15000;
const WINDOW_SECS       = 300;
const TARGET_PAIRS      = ['BTC', 'ETH', 'SOL'];

// Entry strategy – bucket system
const BUCKETS = [0.40, 0.35, 0.30, 0.25, 0.20];
const SHARES_PER_BUCKET = 50;
const TP_PRICE = 0.99;
const DEMO_BALANCE = 1000;
const FORCE_AT = 298;

let dryRun = process.env.DRY_RUN === "true";
let emitFn     = () => {};
let slog       = () => {};
let trader     = null;
let cashBalance = 0;
let startBalance = 0;
let startTime  = Date.now();

const logs     = [];
const trades   = [];
const markets  = {};
let lastDiscoverAt = 0;
const stratState = {};

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts   = new Date().toTimeString().slice(0, 8);
  const line = `[${ts}] [ENTRY] ${msg}`;
  logs.unshift(line);
  if (logs.length > 500) logs.length = 500;
  if (slog) slog(line);
}

async function getJSON(url) {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 10000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? r.json() : null;
  } catch (_) { return null; }
}

function calcEquity() {
  let openValue = 0;
  for (const [slug, ss] of Object.entries(stratState)) {
    const m = markets[slug];
    if (!m || ss.phase === 'done') continue;
    for (const bk of Object.values(ss.buckets)) {
      if (bk.upFilled && !bk.upTpFilled) openValue += SHARES_PER_BUCKET * m.upMid;
      if (bk.dnFilled && !bk.dnTpFilled) openValue += SHARES_PER_BUCKET * m.downMid;
    }
  }
  return cashBalance + openValue;
}

// ── WebSocket ──
let ws = null, wsReady = false, wsPingTimer = null;
const wsTokenMap = {};

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log('Connecting WS...');
  ws = new WebSocket(CLOB_WS);
  ws.on('open', () => {
    wsReady = true;
    log('WS connected');
    const ids = Object.keys(wsTokenMap);
    if (ids.length) wsSubscribe(ids);
    wsPingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000);
  });
  ws.on('message', raw => {
    try {
      const msgs = JSON.parse(raw);
      const arr  = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of arr) {
        const t = msg.asset_id, p = parseFloat(msg.price || msg.mid_price || '0');
        if (!t || !p) continue;
        const slug = wsTokenMap[t];
        if (!slug || !markets[slug]) continue;
        const m = markets[slug];
        if (t === m.upTokenId) { m.upMid = f4(p); m.lastPriceAt = Date.now(); }
        if (t === m.downTokenId) { m.downMid = f4(p); m.lastPriceAt = Date.now(); }
      }
    } catch (_) {}
  });
  ws.on('close', () => {
    wsReady = false;
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    log('WS closed – reconnect 2s');
    setTimeout(wsConnect, 2000);
  });
  ws.on('error', e => { log(`WS err: ${e.message}`); try { ws.terminate(); } catch(_) {} });
}

function wsSubscribe(ids) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ auth: {}, type: 'market', assets_ids: ids }));
}

async function restRefreshPrice(m) {
  const [ur, dr] = await Promise.all([
    getJSON(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
    getJSON(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
  ]);
  if (ur?.mid) m.upMid   = f4(parseFloat(ur.mid));
  if (dr?.mid) m.downMid = f4(parseFloat(dr.mid));
  m.lastPriceAt = Date.now();
}

async function ensureFreshPrice(m) {
  if (!m.lastPriceAt || Date.now() - m.lastPriceAt > 3000) await restRefreshPrice(m);
}

function currentWindowStart() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
}

// ── Market Discovery ──
async function discoverMarket(pair, customWsTs) {
  const ws_ts = customWsTs || currentWindowStart();
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
  const secsToEnd = (endTime - Date.now()) / 1000;
  if (secsToEnd < 10 || secsToEnd > WINDOW_SECS * 2) return;

  const upTokenId = ids[0], downTokenId = ids[1];
  let tickSize = '0.01', negRisk = false;
  try {
    const tsData = await getJSON(`${CLOB}/tick-size?token_id=${upTokenId}`);
    if (tsData?.minimum_tick_size) tickSize = tsData.minimum_tick_size;
    const nrData = await getJSON(`${CLOB}/neg-risk?token_id=${upTokenId}`);
    if (nrData?.neg_risk !== undefined) negRisk = nrData.neg_risk;
  } catch (_) {}

  markets[slug] = {
    slug, pair, upTokenId, downTokenId,
    upMid: 0, downMid: 0, lastPriceAt: 0,
    endTime, windowStartMs: ws_ts * 1000,
    upTickSize: tickSize, dnTickSize: tickSize,
    upNegRisk: negRisk, dnNegRisk: negRisk,
    loopRunning: false, done: false,
  };

  wsTokenMap[upTokenId] = slug;
  wsTokenMap[downTokenId] = slug;
  if (wsReady) wsSubscribe([upTokenId, downTokenId]);
  log(`Market ${pair}: ${slug}`);
  await restRefreshPrice(markets[slug]);
  log(`${pair} UP:${f4(markets[slug].upMid)} DOWN:${f4(markets[slug].downMid)}`);

  // Build bucket state
  const buckets = {};
  for (const p of BUCKETS) {
    buckets[p] = { upOrderId: null, dnOrderId: null, upFilled: false, dnFilled: false, upTpFilled: false, dnTpFilled: false };
  }
  stratState[slug] = {
    phase: 'waiting',
    buckets,
    filledCount: 0,
    tpCount: 0,
    forceClosed: false,
  };

  tradeLoop(markets[slug]).catch(e => log(`Loop crash ${pair}: ${e.message}`));
}

async function discover() {
  const cw = currentWindowStart();
  const timestamps = [cw - WINDOW_SECS, cw, cw + WINDOW_SECS];
  await Promise.allSettled(timestamps.map(ep =>
    Promise.allSettled(TARGET_PAIRS.map(p => discoverMarket(p, ep)))
  ));
  for (const [slug, m] of Object.entries(markets)) {
    if (Date.now() > m.endTime + 2000) {
      delete wsTokenMap[m.upTokenId];
      delete wsTokenMap[m.downTokenId];
      delete markets[slug];
      delete stratState[slug];
    }
  }
}

// ── Place limit buy, sell ──
async function placeBuyLimit(m, side) {
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  if (dryRun) return 'demo_' + side + '_buy';
  try {
    const ord = await trader.placeGtcOrder(tokenId, 'BUY', BUY_PRICE, SHARES);
    return ord?.id || null;
  } catch (e) { log(`BUY err ${side}: ${e.message.slice(0,60)}`); return null; }
}

async function placeSellLimit(m, side, price) {
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  if (dryRun) return 'demo_' + side + '_sell';
  try {
    const ord = await trader.placeGtcOrder(tokenId, 'SELL', price, SHARES);
    return ord?.id || null;
  } catch (e) { log(`SELL err ${side}: ${e.message.slice(0,60)}`); return null; }
}

async function marketSell(m, side) {
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  if (dryRun) {
    const mid = side === 'up' ? m.upMid : m.downMid;
    return { price: mid, proceeds: f2(SHARES_PER_BUCKET * mid) };
  }
  try {
    const { Side, OrderType } = require('@polymarket/clob-client-v2');
    await trader._clob.createAndPostMarketOrder(
      { tokenID: tokenId, amount: SHARES_PER_BUCKET, side: Side.SELL, orderType: OrderType.FOK },
      {}, OrderType.FOK
    );
    return { price: 0, proceeds: 0 };
  } catch (e) { log(`MKT SELL err ${side}: ${e.message.slice(0,60)}`); return null; }
}

// ── Core Trade Loop ──
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;
  const ss = stratState[m.slug];
  log(`Loop ${m.pair} buckets: ${BUCKETS.join(',')}`);

  // Wait for window to open
  if (m.windowStartMs > Date.now() + 2000) {
    const w = m.windowStartMs - Date.now();
    await sleep(w);
  }

  ss.phase = 'entry';
  const costPerFill = f2(SHARES_PER_BUCKET * BUCKETS[0]); // approximate
  log(`${m.pair} placing ${BUCKETS.length}×2 limit orders`);

  // Main monitor loop
  while (true) {
    const elapsed = (Date.now() - m.windowStartMs) / 1000;
    if (elapsed >= WINDOW_SECS + 1) break;

    await ensureFreshPrice(m);

    if (dryRun) {
      // Check each bucket
      for (const [priceStr, bk] of Object.entries(ss.buckets)) {
        const p = parseFloat(priceStr);
        if (elapsed < 5) continue; // brief settling delay

        // Check UP fill
        if (!bk.upFilled && !bk.upTpFilled && m.upMid > 0 && m.upMid <= p) {
          cashBalance = f2(cashBalance - costPerFill);
          bk.upFilled = true;
          ss.filledCount++;
          // Cancel opposite side at this level
          if (!bk.dnFilled) {
            bk.dnOrderId = null; // cancelled
            log(`${m.pair} UP @${priceStr} FILLED — DN@${priceStr} cancelled`);
          } else {
            log(`${m.pair} UP @${priceStr} FILLED`);
          }
        }
        // Check DN fill
        if (!bk.dnFilled && !bk.dnTpFilled && m.downMid > 0 && m.downMid <= p) {
          cashBalance = f2(cashBalance - costPerFill);
          bk.dnFilled = true;
          ss.filledCount++;
          // Cancel opposite side at this level
          if (!bk.upFilled) {
            bk.upOrderId = null; // cancelled
            log(`${m.pair} DN @${priceStr} FILLED — UP@${priceStr} cancelled`);
          } else {
            log(`${m.pair} DN @${priceStr} FILLED`);
          }
        }

        // Check TP at 0.99
        if (bk.upFilled && !bk.upTpFilled && m.upMid >= TP_PRICE) {
          cashBalance = f2(cashBalance + SHARES_PER_BUCKET * m.upMid);
          bk.upTpFilled = true;
          ss.tpCount++;
          const pnl = f2((m.upMid - p) * SHARES_PER_BUCKET);
          log(`${m.pair} UP @${priceStr} TP @0.99 +${pnl}`);
          trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'UP', action: 'TP', price: f4(m.upMid), shares: SHARES_PER_BUCKET, pnl });
        }
        if (bk.dnFilled && !bk.dnTpFilled && m.downMid >= TP_PRICE) {
          cashBalance = f2(cashBalance + SHARES_PER_BUCKET * m.downMid);
          bk.dnTpFilled = true;
          ss.tpCount++;
          const pnl = f2((m.downMid - p) * SHARES_PER_BUCKET);
          log(`${m.pair} DN @${priceStr} TP @0.99 +${pnl}`);
          trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'DOWN', action: 'TP', price: f4(m.downMid), shares: SHARES_PER_BUCKET, pnl });
        }
      }
    } else {
      // Real mode – check order fills
      try {
        const openOrders = await trader.getOpenOrders();
        const openIds = new Set((openOrders || []).map(o => o.id));
        for (const [priceStr, bk] of Object.entries(ss.buckets)) {
          if (bk.upOrderId && !bk.upFilled && !openIds.has(bk.upOrderId)) {
            bk.upFilled = true; ss.filledCount++;
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            log(`${m.pair} UP @${priceStr} FILLED`);
          }
          if (bk.dnOrderId && !bk.dnFilled && !openIds.has(bk.dnOrderId)) {
            bk.dnFilled = true; ss.filledCount++;
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            log(`${m.pair} DN @${priceStr} FILLED`);
          }
          // Place TP orders
          if (bk.upFilled && !bk.upTpFilled && !bk.upSellId) {
            bk.upSellId = await placeSellLimit(m, 'up', TP_PRICE);
          }
          if (bk.dnFilled && !bk.dnTpFilled && !bk.dnSellId) {
            bk.dnSellId = await placeSellLimit(m, 'down', TP_PRICE);
          }
          // Check TP fills
          if (bk.upSellId && bk.upFilled && !bk.upTpFilled && !openIds.has(bk.upSellId)) {
            bk.upTpFilled = true; ss.tpCount++;
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            log(`${m.pair} UP @${priceStr} TP EXIT`);
          }
          if (bk.dnSellId && bk.dnFilled && !bk.dnTpFilled && !openIds.has(bk.dnSellId)) {
            bk.dnTpFilled = true; ss.tpCount++;
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            log(`${m.pair} DN @${priceStr} TP EXIT`);
          }
        }
      } catch (_) {}
    }

    // Force sell at 298s
    if (elapsed >= FORCE_AT && !ss.forceClosed && ss.filledCount > ss.tpCount) {
      ss.forceClosed = true;
      log(`${m.pair} FORCE SELL at ${elapsed.toFixed(1)}s`);
      if (dryRun) {
        for (const [priceStr, bk] of Object.entries(ss.buckets)) {
          if (bk.upFilled && !bk.upTpFilled) {
            const res = await marketSell(m, 'up');
            if (res) { cashBalance = f2(cashBalance + res.proceeds); bk.upTpFilled = true; ss.tpCount++; }
          }
          if (bk.dnFilled && !bk.dnTpFilled) {
            const res = await marketSell(m, 'down');
            if (res) { cashBalance = f2(cashBalance + res.proceeds); bk.dnTpFilled = true; ss.tpCount++; }
          }
        }
      } else {
        for (const [priceStr, bk] of Object.entries(ss.buckets)) {
          if (bk.upFilled && !bk.upTpFilled) {
            await marketSell(m, 'up');
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            bk.upTpFilled = true; ss.tpCount++;
          }
          if (bk.dnFilled && !bk.dnTpFilled) {
            await marketSell(m, 'down');
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            bk.dnTpFilled = true; ss.tpCount++;
          }
        }
      }
    }

    await sleep(TICK_MS);
  }

  const total = f2(cashBalance - startBalance);
  log(`${m.pair} done – balance ${f2(cashBalance)} PnL ${total}`);
  ss.phase = 'done';
  m.loopRunning = false;
}

// ── Main tick ──
let lastEquityRecord = 0;
const equityHistory = [];

async function tick() {
  const now = Date.now();
  if (now - lastDiscoverAt >= DISCOVER_EVERY_MS) {
    lastDiscoverAt = now;
    await discover();
  }
  if (now - lastEquityRecord >= 5000) {
    lastEquityRecord = now;
    equityHistory.push({ t: now - startTime, v: calcEquity() });
    if (equityHistory.length > 1000) equityHistory.splice(0, equityHistory.length - 1000);
  }
  emitFn('snapshot', snapshot());
}

function snapshot() {
  const equity = calcEquity();
  const pnl = f2(equity - startBalance);

  const activeMarkets = Object.values(markets)
    .filter(m => m.windowStartMs <= Date.now() && m.endTime > Date.now())
    .map(m => {
    const ss = stratState[m.slug] || { phase: 'waiting', buckets: {} };
    const bkList = Object.entries(ss.buckets || {}).map(([p, bk]) => ({
      price: parseFloat(p),
      upFilled: bk.upFilled,
      dnFilled: bk.dnFilled,
      upTpFilled: bk.upTpFilled,
      dnTpFilled: bk.dnTpFilled,
    }));

    // Aggregate stats
    let upShares = 0, dnShares = 0, upCost = 0, dnCost = 0;
    const upEntries = [], dnEntries = [];
    for (const bk of bkList) {
      if (bk.upFilled) { upShares += SHARES_PER_BUCKET; upCost += SHARES_PER_BUCKET * bk.price; upEntries.push(bk.price); }
      if (bk.dnFilled) { dnShares += SHARES_PER_BUCKET; dnCost += SHARES_PER_BUCKET * bk.price; dnEntries.push(bk.price); }
    }

    return {
      slug: m.slug, pair: m.pair,
      upMid: f4(m.upMid), dnMid: f4(m.downMid),
      secsLeft: Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
      phase: ss.phase,
      filledCount: ss.filledCount || 0,
      tpCount: ss.tpCount || 0,
      buckets: bkList,
      upShares, dnShares,
      upCost: f2(upCost), dnCost: f2(dnCost),
      upEntry: upEntries.length ? Math.min(...upEntries) : null,
      dnEntry: dnEntries.length ? Math.min(...dnEntries) : null,
      upTp: upShares > 0 ? TP_PRICE : null,
      dnTp: dnShares > 0 ? TP_PRICE : null,
    };
  });

  return {
    dryRun, balance: f2(equity), cashBalance: f2(cashBalance),
    startBalance: f2(startBalance), pnl,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeMarkets,
    recentTrades: trades.slice(0, 100),
    activityLog: logs.slice(0, 50),
    equityHistory: equityHistory.slice(-500),
    strategy: {
      type: 'bucket', buckets: BUCKETS, sharesPerBucket: SHARES_PER_BUCKET,
      tpPrice: TP_PRICE, pairs: TARGET_PAIRS,
    },
  };
}
async function setDryRun(v) {
  dryRun = !!v;
  if (dryRun) { cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE; }
  equityHistory.length = 0;
  if (!dryRun && trader) {
    try { const b = await trader.getBalance(); if (b > 0) { cashBalance = b; startBalance = b; } } catch (_) {}
  }
}
function getDryRun() { return dryRun; }

async function start(emit, logFn) {
  emitFn = emit || (() => {});
  slog = logFn || (() => {});
  startTime = Date.now();
  if (!process.env.POLYMARKET_PRIVATE_KEY) { console.error('No private key'); process.exit(1); }

  try {
    trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY);
    trader.setLogFn(log);
    log('Authenticating...');
    await trader.authenticate();
    log(`Auth: ${trader.address}`);
    if (dryRun) { cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE; log(`DEMO $${f2(cashBalance)}`); }
    else { const b = await trader.getBalance(); if (b > 0) { cashBalance = b; startBalance = b; } log(`LIVE $${f2(cashBalance)}`); }
  } catch (e) { log(`Auth fail: ${e.message}`); process.exit(1); }

  wsConnect();
  log('Starting main loop');
  setInterval(tick, TICK_MS);
}

module.exports = { start, snapshot, setDryRun, getDryRun };
