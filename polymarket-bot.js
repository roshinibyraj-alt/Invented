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

// Entry strategy
const BUY_PRICE   = 0.35;
const TP_FIRST    = 0.66;  // first filled side
const TP_SECOND   = 0.99;  // second filled side
const SL_PRICE    = 0.15;
const SHARES      = 50;
const FORCE_AT    = 298;   // force sell at 298s (last 2s)

let dryRun = process.env.DRY_RUN === 'true';
const DEMO_BALANCE = parseFloat(process.env.DEMO_BALANCE || '250');

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
    if (ss.upFilled && !ss.upTpFilled && !ss.upSlHit)
      openValue += SHARES * m.upMid;
    if (ss.dnFilled && !ss.dnTpFilled && !ss.dnSlHit)
      openValue += SHARES * m.downMid;
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

  stratState[slug] = {
    phase: 'waiting', // waiting → entry → first_active → second_active → done
    upFilled: false, dnFilled: false,
    upTpFilled: false, dnTpFilled: false,
    upSlHit: false, dnSlHit: false,
    firstSide: null, // 'up' or 'down'
    firstExited: false,
    secondExited: false,
    upOrderId: null, dnOrderId: null,
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
    return { price: mid, proceeds: f2(SHARES * mid) };
  }
  try {
    const { Side, OrderType } = require('@polymarket/clob-client-v2');
    await trader._clob.createAndPostMarketOrder(
      { tokenID: tokenId, amount: SHARES, side: Side.SELL, orderType: OrderType.FOK },
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
  log(`Loop ${m.pair}`);

  // Wait for window to open
  if (m.windowStartMs > Date.now() + 2000) {
    const w = m.windowStartMs - Date.now();
    await sleep(w);
  }

  const cost = f2(SHARES * BUY_PRICE);
  ss.phase = 'entry';

  // Place buy at 0.35 on both sides
  log(`${m.pair} placing BUY ${SHARES}sh@${BUY_PRICE} on both`);
  ss.upOrderId = await placeBuyLimit(m, 'up');
  ss.dnOrderId = await placeBuyLimit(m, 'down');

  // Main monitor loop
  let forceClosed = false;
  while (true) {
    const elapsed = (Date.now() - m.windowStartMs) / 1000;
    if (elapsed >= WINDOW_SECS + 1) break;

    await ensureFreshPrice(m);

    // Check fills and TP/SL in demo mode
    if (dryRun) {
      // Check if 0.35 buy fills
      if (!ss.upFilled && m.upMid <= BUY_PRICE && m.upMid > 0) {
        cashBalance = f2(cashBalance - cost);
        ss.upFilled = true;
        log(`${m.pair} UP FILLED @${BUY_PRICE}`);
        if (!ss.firstSide) {
          ss.firstSide = 'up';
          ss.phase = 'first_active';
          log(`${m.pair} FIRST SIDE = UP → TP ${TP_FIRST} / SL ${SL_PRICE}`);
        }
      }
      if (!ss.dnFilled && m.downMid <= BUY_PRICE && m.downMid > 0) {
        cashBalance = f2(cashBalance - cost);
        ss.dnFilled = true;
        log(`${m.pair} DN FILLED @${BUY_PRICE}`);
        if (!ss.firstSide) {
          ss.firstSide = 'down';
          ss.phase = 'first_active';
          log(`${m.pair} FIRST SIDE = DN → TP ${TP_FIRST} / SL ${SL_PRICE}`);
        }
      }

      // If both filled, move to second_active
      if (ss.upFilled && ss.dnFilled && ss.firstSide && ss.phase === 'first_active') {
        ss.phase = 'second_active';
        const second = ss.firstSide === 'up' ? 'DOWN' : 'UP';
        log(`${m.pair} BOTH FILLED – ${second} TP ${TP_SECOND} / SL ${SL_PRICE}`);
      }

      // Check TP/SL for UP
      if (ss.upFilled) {
        const upTp = ss.firstSide === 'up' && !ss.firstExited ? TP_FIRST : TP_SECOND;
        if (!ss.upTpFilled && !ss.upSlHit && m.upMid >= upTp) {
          cashBalance = f2(cashBalance + SHARES * m.upMid);
          ss.upTpFilled = true;
          const pnl = f2((m.upMid - BUY_PRICE) * SHARES);
          log(`${m.pair} UP TP @${f4(m.upMid)} +$${pnl}`);
          trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'UP', action: 'SELL', price: f4(m.upMid), shares: SHARES, pnl });
          if (ss.firstSide === 'up') ss.firstExited = true;
          else ss.secondExited = true;
        }
        if (!ss.upTpFilled && !ss.upSlHit && m.upMid <= SL_PRICE) {
          cashBalance = f2(cashBalance + SHARES * m.upMid);
          ss.upSlHit = true;
          const pnl = f2((m.upMid - BUY_PRICE) * SHARES);
          log(`${m.pair} UP SL @${f4(m.upMid)} ${pnl >= 0 ? '+' : ''}$${pnl}`);
          trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'UP', action: 'SELL', price: f4(m.upMid), shares: SHARES, pnl });
          if (ss.firstSide === 'up') ss.firstExited = true;
          else ss.secondExited = true;
        }
      }

      // Check TP/SL for DOWN
      if (ss.dnFilled) {
        const dnTp = ss.firstSide === 'down' && !ss.firstExited ? TP_FIRST : TP_SECOND;
        if (!ss.dnTpFilled && !ss.dnSlHit && m.downMid >= dnTp) {
          cashBalance = f2(cashBalance + SHARES * m.downMid);
          ss.dnTpFilled = true;
          const pnl = f2((m.downMid - BUY_PRICE) * SHARES);
          log(`${m.pair} DN TP @${f4(m.downMid)} +$${pnl}`);
          trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'DOWN', action: 'SELL', price: f4(m.downMid), shares: SHARES, pnl });
          if (ss.firstSide === 'down') ss.firstExited = true;
          else ss.secondExited = true;
        }
        if (!ss.dnTpFilled && !ss.dnSlHit && m.downMid <= SL_PRICE) {
          cashBalance = f2(cashBalance + SHARES * m.downMid);
          ss.dnSlHit = true;
          const pnl = f2((m.downMid - BUY_PRICE) * SHARES);
          log(`${m.pair} DN SL @${f4(m.downMid)} ${pnl >= 0 ? '+' : ''}$${pnl}`);
          trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: 'DOWN', action: 'SELL', price: f4(m.downMid), shares: SHARES, pnl });
          if (ss.firstSide === 'down') ss.firstExited = true;
          else ss.secondExited = true;
        }
      }

      // Both sides exited? done
      if ((ss.upSlHit || ss.upTpFilled) && (ss.dnSlHit || ss.dnTpFilled)) {
        ss.phase = 'done';
        break;
      }
    } else {
      // Real mode: check via getOpenOrders
      try {
        const openOrders = await trader.getOpenOrders();
        const openIds = new Set((openOrders || []).map(o => o.id));
        // Check buys
        if (ss.upOrderId && !ss.upFilled && !openIds.has(ss.upOrderId)) {
          ss.upFilled = true;
          try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
          log(`${m.pair} UP FILLED @${BUY_PRICE}`);
          if (!ss.firstSide) { ss.firstSide = 'up'; ss.phase = 'first_active'; }
        }
        if (ss.dnOrderId && !ss.dnFilled && !openIds.has(ss.dnOrderId)) {
          ss.dnFilled = true;
          try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
          log(`${m.pair} DN FILLED @${BUY_PRICE}`);
          if (!ss.firstSide) { ss.firstSide = 'down'; ss.phase = 'first_active'; }
        }
        // If both filled, place TP/SL orders
        if (ss.upFilled && ss.dnFilled && ss.phase === 'first_active') {
          ss.phase = 'second_active';
          // Place sells: first side at TP_FIRST, second at TP_SECOND
          // For SL at 0.15, we just monitor and market sell
        }
        // Place sell orders for filled positions
        if (ss.upFilled && !ss.upTpFilled && !ss.upSlHit && !ss.upSellId) {
          const tp = ss.firstSide === 'up' && !ss.firstExited ? TP_FIRST : TP_SECOND;
          const oid = await placeSellLimit(m, 'up', tp);
          if (oid) ss.upSellId = oid;
        }
        if (ss.dnFilled && !ss.dnTpFilled && !ss.dnSlHit && !ss.dnSellId) {
          const tp = ss.firstSide === 'down' && !ss.firstExited ? TP_FIRST : TP_SECOND;
          const oid = await placeSellLimit(m, 'down', tp);
          if (oid) ss.dnSellId = oid;
        }
        // Check sells
        if (ss.upSellId && ss.upFilled && !ss.upTpFilled && !openIds.has(ss.upSellId)) {
          ss.upTpFilled = true;
          if (ss.firstSide === 'up') ss.firstExited = true; else ss.secondExited = true;
          try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
          log(`${m.pair} UP TP EXIT`);
        }
        if (ss.dnSellId && ss.dnFilled && !ss.dnTpFilled && !openIds.has(ss.dnSellId)) {
          ss.dnTpFilled = true;
          if (ss.firstSide === 'down') ss.firstExited = true; else ss.secondExited = true;
          try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
          log(`${m.pair} DN TP EXIT`);
        }
      } catch (_) {}
    }

    // Force sell at 295s if still holding
    if (elapsed >= FORCE_AT && !forceClosed && (ss.upFilled || ss.dnFilled)) {
      forceClosed = true;
      log(`${m.pair} FORCE SELL at ${elapsed.toFixed(1)}s`);
      if (dryRun) {
        if (ss.upFilled && !ss.upTpFilled && !ss.upSlHit) {
          const res = await marketSell(m, 'up');
          if (res) { cashBalance = f2(cashBalance + res.proceeds); ss.upTpFilled = true; }
        }
        if (ss.dnFilled && !ss.dnTpFilled && !ss.dnSlHit) {
          const res = await marketSell(m, 'down');
          if (res) { cashBalance = f2(cashBalance + res.proceeds); ss.dnTpFilled = true; }
        }
      } else {
        if (ss.upFilled && !ss.upTpFilled && !ss.upSlHit) {
          await marketSell(m, 'up');
          try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
          ss.upTpFilled = true;
        }
        if (ss.dnFilled && !ss.dnTpFilled && !ss.dnSlHit) {
          await marketSell(m, 'down');
          try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
          ss.dnTpFilled = true;
        }
      }
    }

    if ((ss.upSlHit || ss.upTpFilled) && (ss.dnSlHit || ss.dnTpFilled)) {
      ss.phase = 'done';
      break;
    }

    await sleep(TICK_MS);
  }

  const total = f2(cashBalance - startBalance);
  log(`${m.pair} done – balance $${f2(cashBalance)} PnL $${total}`);
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
    const ss = stratState[m.slug] || { phase: 'waiting', upFilled: false, dnFilled: false, upTpFilled: false, dnTpFilled: false, upSlHit: false, dnSlHit: false, firstSide: null, firstExited: false, secondExited: false };
    return {
      slug: m.slug, pair: m.pair,
      upMid: f4(m.upMid), dnMid: f4(m.downMid),
      secsLeft: Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
      phase: ss.phase,
      firstSide: ss.firstSide,
      upFilled: ss.upFilled, dnFilled: ss.dnFilled,
      upTpFilled: ss.upTpFilled, dnTpFilled: ss.dnTpFilled,
      upSlHit: ss.upSlHit, dnSlHit: ss.dnSlHit,
      firstExited: ss.firstExited, secondExited: ss.secondExited,
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
      type: 'entry', shares: SHARES, buyPrice: BUY_PRICE,
      tpFirst: TP_FIRST, tpSecond: TP_SECOND, sl: SL_PRICE,
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
