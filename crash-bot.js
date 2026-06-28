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

// Crash strategy params
const CHECK_AT_SECS   = 240;   // 4th minute – check range & place orders
const BUY_PRICE       = 0.10;
const TP_PRICE        = 0.90;
const SHARES          = 50;
const RANGE_MIN       = 0.20;
const RANGE_MAX       = 0.80;
const FORCE_AT_SECS   = 299.5; // force sell if TP not hit

let dryRun = process.env.DRY_RUN === 'true';
const DEMO_BALANCE = parseFloat(process.env.CRASH_DEMO_BALANCE || '250');

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

// Per-market crash state
const crashState = {};

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts   = new Date().toTimeString().slice(0, 8);
  const line = `[${ts}] [CRASH] ${msg}`;
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
  for (const [slug, cs] of Object.entries(crashState)) {
    const m = markets[slug];
    if (!m || cs.done) continue;
    if (cs.bought && !cs.sold) {
      const mid = cs.side === 'up' ? m.upMid : m.downMid;
      openValue += SHARES * mid;
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

  crashState[slug] = {
    phase: 'waiting',    // waiting → monitoring → bought → tp_check → done
    bought: false,
    side: null,          // 'up' or 'down' (which side filled first)
    sold: false,
    tpHit: false,
    upOrderPlaced: false,
    dnOrderPlaced: false,
    upFilled: false,
    dnFilled: false,
    upTpFilled: false,
    dnTpFilled: false,
    done: false,
    rangeOk: false,
    buyUpOrderId: null,
    buyDnOrderId: null,
    sellUpOrderId: null,
    sellDnOrderId: null,
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
    if (Date.now() > m.endTime + 30000) {
      delete wsTokenMap[m.upTokenId];
      delete wsTokenMap[m.downTokenId];
      delete markets[slug];
      delete crashState[slug];
    }
  }
}

// ── Core Trade Loop ──
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;
  const cs = crashState[m.slug];
  log(`Loop ${m.pair}`);

  // Wait for window to open
  if (m.windowStartMs > Date.now() + 2000) {
    const w = m.windowStartMs - Date.now();
    await sleep(w);
  }

  // Wait until 240s (4th minute)
  const checkAt = m.windowStartMs + CHECK_AT_SECS * 1000;
  const waitTime = checkAt - Date.now();
  if (waitTime > 0) {
    log(`${m.pair} waiting ${Math.ceil(waitTime/1000)}s to check range`);
    await sleep(waitTime);
  }

  // Check range condition
  await ensureFreshPrice(m);
  const upOk = m.upMid >= RANGE_MIN && m.upMid <= RANGE_MAX;
  const dnOk = m.downMid >= RANGE_MIN && m.downMid <= RANGE_MAX;
  cs.rangeOk = upOk && dnOk;

  if (!cs.rangeOk) {
    log(`${m.pair} range SKIP (UP:${f4(m.upMid)} DN:${f4(m.downMid)}) outside [${RANGE_MIN},${RANGE_MAX}]`);
    cs.done = true;
    m.loopRunning = false;
    return;
  }

  log(`${m.pair} range OK (UP:${f4(m.upMid)} DN:${f4(m.downMid)}) – placing 50sh@0.10 on both`);
  cs.phase = 'monitoring';
  const cost = f2(SHARES * BUY_PRICE);

  // Place BUY orders at 0.10 on both sides (pending in demo)
  if (dryRun) {
    cs.buyUpOrderId = 'demo_up_buy';
    cs.buyDnOrderId = 'demo_dn_buy';
    cs.upOrderPlaced = true;
    cs.dnOrderPlaced = true;
    log(`UP BUY 50sh@${BUY_PRICE} (pending)`);
    log(`DN BUY 50sh@${BUY_PRICE} (pending)`);
  } else {
    try {
      const ord = await trader.placeGtcOrder(m.upTokenId, 'BUY', BUY_PRICE, SHARES);
      if (ord?.id) { cs.buyUpOrderId = ord.id; cs.upOrderPlaced = true; }
    } catch (e) { log(`UP BUY err: ${e.message.slice(0,60)}`); }
    try {
      const ord = await trader.placeGtcOrder(m.downTokenId, 'BUY', BUY_PRICE, SHARES);
      if (ord?.id) { cs.buyDnOrderId = ord.id; cs.dnOrderPlaced = true; }
    } catch (e) { log(`DN BUY err: ${e.message.slice(0,60)}`); }
  }

  // Monitor loop: check fills, TP, force close
  while (true) {
    const elapsed = (Date.now() - m.windowStartMs) / 1000;
    if (elapsed >= WINDOW_SECS + 2) break;

    await ensureFreshPrice(m);

    // Check if BUY at 0.10 filled (demo: mid <= 0.10)
    if (dryRun) {
      if (!cs.upFilled && cs.upOrderPlaced && m.upMid <= BUY_PRICE && m.upMid > 0) {
        cashBalance = f2(cashBalance - cost);
        cs.upFilled = true;
        cs.bought = true;
        cs.side = cs.side || 'up';
        log(`${m.pair} UP FILLED 50sh@${BUY_PRICE}`);
        trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'UP', action: 'BUY', price: BUY_PRICE, shares: SHARES });
        if (trades.length > 200) trades.length = 200;
      }
      if (!cs.dnFilled && cs.dnOrderPlaced && m.downMid <= BUY_PRICE && m.downMid > 0) {
        cashBalance = f2(cashBalance - cost);
        cs.dnFilled = true;
        cs.bought = true;
        cs.side = cs.side || 'down';
        log(`${m.pair} DN FILLED 50sh@${BUY_PRICE}`);
        trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'DOWN', action: 'BUY', price: BUY_PRICE, shares: SHARES });
        if (trades.length > 200) trades.length = 200;
      }

      // Check TP at 0.90
      if (cs.upFilled && !cs.upTpFilled && m.upMid >= TP_PRICE) {
        const proceeds = f2(SHARES * TP_PRICE);
        cashBalance = f2(cashBalance + proceeds);
        cs.upTpFilled = true;
        cs.tpHit = true;
        cs.sold = true;
        const pnl = f2((TP_PRICE - BUY_PRICE) * SHARES);
        log(`${m.pair} UP TP @${TP_PRICE} +$${pnl}`);
        trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'UP', action: 'SELL', price: TP_PRICE, shares: SHARES, pnl });
        if (trades.length > 200) trades.length = 200;
      }
      if (cs.dnFilled && !cs.dnTpFilled && m.downMid >= TP_PRICE) {
        const proceeds = f2(SHARES * TP_PRICE);
        cashBalance = f2(cashBalance + proceeds);
        cs.dnTpFilled = true;
        cs.tpHit = true;
        cs.sold = true;
        const pnl = f2((TP_PRICE - BUY_PRICE) * SHARES);
        log(`${m.pair} DN TP @${TP_PRICE} +$${pnl}`);
        trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'DOWN', action: 'SELL', price: TP_PRICE, shares: SHARES, pnl });
        if (trades.length > 200) trades.length = 200;
      }

      // Both sides done? exit early
      if (cs.upTpFilled && cs.dnTpFilled) { cs.done = true; break; }
    } else {
      // Real mode: check via getOpenOrders
      try {
        const openOrders = await trader.getOpenOrders();
        const openIds = new Set((openOrders || []).map(o => o.id));
        if (cs.buyUpOrderId && !cs.upFilled && !openIds.has(cs.buyUpOrderId)) {
          cs.upFilled = true; cs.bought = true; cs.side = cs.side || 'up';
          try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
          log(`${m.pair} UP FILLED 50sh@${BUY_PRICE}`);
        }
        if (cs.buyDnOrderId && !cs.dnFilled && !openIds.has(cs.buyDnOrderId)) {
          cs.dnFilled = true; cs.bought = true; cs.side = cs.side || 'down';
          try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
          log(`${m.pair} DN FILLED 50sh@${BUY_PRICE}`);
        }
        if (cs.upFilled && !cs.upTpFilled) {
          if (!cs.sellUpOrderId) {
            const ord = await trader.placeGtcOrder(m.upTokenId, 'SELL', TP_PRICE, SHARES);
            if (ord?.id) cs.sellUpOrderId = ord.id;
          } else if (!openIds.has(cs.sellUpOrderId)) {
            cs.upTpFilled = true; cs.tpHit = true; cs.sold = true;
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            log(`${m.pair} UP TP @${TP_PRICE}`);
          }
        }
        if (cs.dnFilled && !cs.dnTpFilled) {
          if (!cs.sellDnOrderId) {
            const ord = await trader.placeGtcOrder(m.downTokenId, 'SELL', TP_PRICE, SHARES);
            if (ord?.id) cs.sellDnOrderId = ord.id;
          } else if (!openIds.has(cs.sellDnOrderId)) {
            cs.dnTpFilled = true; cs.tpHit = true; cs.sold = true;
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            log(`${m.pair} DN TP @${TP_PRICE}`);
          }
        }
      } catch (_) {}
    }

    // Force sell at 299.5s if TP not hit
    if (elapsed >= FORCE_AT_SECS && (cs.upFilled || cs.dnFilled) && !cs.sold) {
      log(`${m.pair} FORCE SELL at ${elapsed.toFixed(1)}s`);
      if (dryRun) {
        if (cs.upFilled && !cs.upTpFilled) {
          const proceeds = f2(SHARES * m.upMid);
          cashBalance = f2(cashBalance + proceeds);
          cs.upTpFilled = true;
          const pnl = f2((m.upMid - BUY_PRICE) * SHARES);
          log(`FORCE SELL UP @${f4(m.upMid)} pnl:$${pnl}`);
          trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'UP', action: 'SELL', price: f4(m.upMid), shares: SHARES, pnl });
          if (trades.length > 200) trades.length = 200;
        }
        if (cs.dnFilled && !cs.dnTpFilled) {
          const proceeds = f2(SHARES * m.downMid);
          cashBalance = f2(cashBalance + proceeds);
          cs.dnTpFilled = true;
          const pnl = f2((m.downMid - BUY_PRICE) * SHARES);
          log(`FORCE SELL DN @${f4(m.downMid)} pnl:$${pnl}`);
          trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'DOWN', action: 'SELL', price: f4(m.downMid), shares: SHARES, pnl });
          if (trades.length > 200) trades.length = 200;
        }
      } else {
        if (cs.upFilled && !cs.upTpFilled) {
          if (cs.sellUpOrderId) try { await trader.cancelOrder(cs.sellUpOrderId); } catch(_) {}
          try {
            const { Side, OrderType } = require('@polymarket/clob-client-v2');
            await trader._clob.createAndPostMarketOrder({ tokenID: m.upTokenId, amount: SHARES, side: Side.SELL, orderType: OrderType.FOK }, {}, OrderType.FOK);
            cs.upTpFilled = true;
          } catch(e) { log(`FORCE SELL UP err: ${e.message.slice(0,60)}`); }
        }
        if (cs.dnFilled && !cs.dnTpFilled) {
          if (cs.sellDnOrderId) try { await trader.cancelOrder(cs.sellDnOrderId); } catch(_) {}
          try {
            const { Side, OrderType } = require('@polymarket/clob-client-v2');
            await trader._clob.createAndPostMarketOrder({ tokenID: m.downTokenId, amount: SHARES, side: Side.SELL, orderType: OrderType.FOK }, {}, OrderType.FOK);
            cs.dnTpFilled = true;
          } catch(e) { log(`FORCE SELL DN err: ${e.message.slice(0,60)}`); }
        }
      }
      cs.sold = true;
      cs.done = true;
      break;
    }

    if (cs.done) break;
    await sleep(TICK_MS);
  }

  // Cancel remaining orders
  if (cs.buyUpOrderId && !cs.upFilled) {
    if (!dryRun) try { await trader.cancelOrder(cs.buyUpOrderId); } catch(_) {}
  }
  if (cs.buyDnOrderId && !cs.dnFilled) {
    if (!dryRun) try { await trader.cancelOrder(cs.buyDnOrderId); } catch(_) {}
  }

  cs.done = true;
  cs.phase = 'done';
  m.loopRunning = false;
  log(`${m.pair} window finished`);
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

  const activeMarkets = Object.values(markets).map(m => {
    const cs = crashState[m.slug] || { phase: 'waiting', bought: false, side: null, sold: false, tpHit: false, upFilled: false, dnFilled: false, upTpFilled: false, dnTpFilled: false, rangeOk: false, done: false };
    return {
      slug: m.slug, pair: m.pair,
      upMid: f4(m.upMid), dnMid: f4(m.downMid),
      secsLeft: Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
      phase: cs.phase,
      rangeOk: cs.rangeOk,
      upFilled: cs.upFilled, dnFilled: cs.dnFilled,
      upTpFilled: cs.upTpFilled, dnTpFilled: cs.dnTpFilled,
      side: cs.side,
      tpHit: cs.tpHit, done: cs.done,
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
      type: 'crash', shares: SHARES, buyPrice: BUY_PRICE,
      tpPrice: TP_PRICE, range: [RANGE_MIN, RANGE_MAX],
      checkAt: CHECK_AT_SECS, forceAt: FORCE_AT_SECS,
      pairs: TARGET_PAIRS,
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
