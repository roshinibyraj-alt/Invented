'use strict';

const WebSocket        = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const TICK_MS           = 500;
const DISCOVER_EVERY_MS = 15000;
const WINDOW_SECS       = 300;
const GRID_LEVELS       = [0.45, 0.40, 0.35, 0.30, 0.25, 0.20, 0.15];
const SHARES            = 10;
const TP_OFFSET         = 0.10;
const CLOSE_AT_SECS     = 282;  // 4.70 minutes – cancel all + force sell
const TARGET_PAIRS      = ['BTC'];

let dryRun = process.env.DRY_RUN === 'true';
const DEMO_BALANCE = parseFloat(process.env.DEMO_BALANCE || '200');

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
const gridState = {};

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts   = new Date().toTimeString().slice(0, 8);
  const line = `[${ts}] ${msg}`;
  logs.unshift(line);
  if (logs.length > 500) logs.length = 500;
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

// ── Balance / Equity ──
function calcEquity() {
  let eq = cashBalance, costBasis = 0;
  for (const [slug, gs] of Object.entries(gridState)) {
    const m = markets[slug];
    if (!m) continue;
    for (const side of ['up', 'down']) {
      for (const lv of gs[side]) {
        if (lv.filled && !lv.sold) {
          costBasis += lv.entryCost;
          const mid = side === 'up' ? m.upMid : m.downMid;
          eq += SHARES * mid;
        }
      }
    }
  }
  return { equity: eq, costBasis, openValue: eq - cashBalance };
}

// ── WebSocket price feed ──
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

  // Init grid state
  gridState[slug] = {
    up:   GRID_LEVELS.map(p => makeGridLevel(p)),
    down: GRID_LEVELS.map(p => makeGridLevel(p)),
    started: false, forceClosed: false, done: false,
  };

  tradeLoop(markets[slug]).catch(e => log(`Loop crash ${pair}: ${e.message}`));
}

function makeGridLevel(price) {
  return {
    price, shares: SHARES,
    buyOrderId: null, filled: false, entryCost: 0,
    sellTarget: 0, sellOrderId: null, sold: false, cancelled: false,
  };
}

async function discover() {
  const cw = currentWindowStart();
  const timestamps = [cw - WINDOW_SECS, cw, cw + WINDOW_SECS];
  await Promise.allSettled(timestamps.map(ep =>
    Promise.allSettled(TARGET_PAIRS.map(p => discoverMarket(p, ep)))
  ));
  // Cleanup old markets
  for (const [slug, m] of Object.entries(markets)) {
    if (Date.now() > m.endTime + 15000) {
      delete wsTokenMap[m.upTokenId];
      delete wsTokenMap[m.downTokenId];
      delete markets[slug];
      delete gridState[slug];
    }
  }
}

// ── Place GRID orders at window start ──
async function placeGridOrders(m) {
  const gs = gridState[m.slug];
  if (!gs) return;

  for (const side of ['up', 'down']) {
    const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
    for (const lv of gs[side]) {
      if (lv.cancelled) continue;
      if (dryRun) {
        lv.buyOrderId = 'demo_' + side + '_' + lv.price;
        log(`GRID ${side.toUpperCase()} BUY ${SHARES}sh@${f4(lv.price)}`);
      } else {
        try {
          const ord = await trader.placeGtcOrder(tokenId, 'BUY', lv.price, SHARES);
          if (ord?.id) lv.buyOrderId = ord.id;
          log(`GRID ${side.toUpperCase()} BUY ${SHARES}sh@${f4(lv.price)} id:${(ord?.id||'').slice(0,10)}`);
        } catch (e) {
          log(`GRID BUY err ${side}@${lv.price}: ${e.message.slice(0,60)}`);
        }
      }
    }
  }
}

// ── Demo fill simulator ──
async function checkDemoFills(m) {
  const gs = gridState[m.slug];
  if (!gs) return;

  for (const side of ['up', 'down']) {
    const mid = side === 'up' ? m.upMid : m.downMid;
    for (const lv of gs[side]) {
      if (lv.cancelled) continue;

      // Check if grid BUY fills (mid <= grid price)
      if (!lv.filled && mid <= lv.price && mid > 0) {
        const cost = SHARES * lv.price;
        if (cashBalance < cost) {
          log(`DEMO insufficient cash $${f2(cashBalance)} for ${side}@${f4(lv.price)}`);
          continue;
        }
        cashBalance = f2(cashBalance - cost);
        lv.filled = true;
        lv.entryCost = cost;
        lv.sellTarget = f4(lv.price + TP_OFFSET);
        trades.unshift({
          ts: new Date().toTimeString().slice(0, 8),
          pair: m.pair, side: side.toUpperCase(),
          action: 'BUY', price: f4(lv.price), shares: SHARES,
        });
        if (trades.length > 400) trades.length = 400;
        log(`DEMO FILLED ${side} ${SHARES}sh@${f4(lv.price)} sell@${f4(lv.sellTarget)}`);
      }

      // Check if SELL fills (mid >= sell target)
      if (lv.filled && !lv.sold && mid >= lv.sellTarget) {
        const proceeds = SHARES * lv.sellTarget;
        cashBalance = f2(cashBalance + proceeds);
        lv.sold = true;
        const pnl = f2((lv.sellTarget - lv.price) * SHARES);
        trades.unshift({
          ts: new Date().toTimeString().slice(0, 8),
          pair: m.pair, side: side.toUpperCase(),
          action: 'SELL', price: f4(lv.sellTarget), shares: SHARES, pnl,
        });
        if (trades.length > 400) trades.length = 400;
        log(`DEMO TP ${side}@${f4(lv.sellTarget)} pnl:$${pnl}`);
      }
    }
  }
}

// ── Real fill checker via getOpenOrders ──
async function checkRealFills(m) {
  const gs = gridState[m.slug];
  if (!gs) return;

  let openIds = new Set();
  try {
    const openOrders = await trader.getOpenOrders();
    openIds = new Set((openOrders || []).map(o => o.id));
  } catch (_) { return; }

  for (const side of ['up', 'down']) {
    const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
    for (const lv of gs[side]) {
      if (lv.cancelled) continue;

      // Grid BUY filled
      if (lv.buyOrderId && !lv.filled && !openIds.has(lv.buyOrderId)) {
        lv.filled = true;
        lv.entryCost = SHARES * lv.price;
        lv.sellTarget = f4(lv.price + TP_OFFSET);
        try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
        trades.unshift({
          ts: new Date().toTimeString().slice(0, 8),
          pair: m.pair, side: side.toUpperCase(),
          action: 'BUY', price: f4(lv.price), shares: SHARES,
        });
        if (trades.length > 400) trades.length = 400;
        log(`FILLED BUY ${side} ${SHARES}sh@${f4(lv.price)}`);

        // Place SELL at target
        try {
          const ord = await trader.placeGtcOrder(tokenId, 'SELL', lv.sellTarget, SHARES);
          if (ord?.id) lv.sellOrderId = ord.id;
          log(`PLACED SELL ${side} ${SHARES}sh@${f4(lv.sellTarget)}`);
        } catch (e) {
          log(`SELL err ${side}@${lv.sellTarget}: ${e.message.slice(0,60)}`);
        }
      }

      // SELL filled
      if (lv.sellOrderId && lv.filled && !lv.sold && !openIds.has(lv.sellOrderId)) {
        lv.sold = true;
        try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
        const pnl = f2((lv.sellTarget - lv.price) * SHARES);
        trades.unshift({
          ts: new Date().toTimeString().slice(0, 8),
          pair: m.pair, side: side.toUpperCase(),
          action: 'SELL', price: f4(lv.sellTarget), shares: SHARES, pnl,
        });
        if (trades.length > 400) trades.length = 400;
        log(`TP FILLED ${side}@${f4(lv.sellTarget)} pnl:$${pnl}`);
      }
    }
  }
}

// ── Force close at 4.70 min ──
async function forceCloseWindow(m) {
  const gs = gridState[m.slug];
  if (!gs) return;
  log(`${m.pair} FORCE CLOSE at 4.70min`);

  for (const side of ['up', 'down']) {
    const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
    for (const lv of gs[side]) {
      if (lv.cancelled) continue;

      // Cancel pending BUY
      if (lv.buyOrderId && !lv.filled) {
        if (!dryRun) { try { await trader.cancelOrder(lv.buyOrderId); } catch(_) {} }
        lv.buyOrderId = null;
        lv.cancelled = true;
        log(`CANCELLED BUY ${side}@${f4(lv.price)}`);
      }
      // Cancel pending SELL and market-sell
      if (lv.sellOrderId && lv.filled && !lv.sold) {
        if (!dryRun) { try { await trader.cancelOrder(lv.sellOrderId); } catch(_) {} }
        lv.sellOrderId = null;
        // Force sell at market
        if (dryRun) {
          const mid = side === 'up' ? m.upMid : m.downMid;
          const proceeds = SHARES * mid;
          cashBalance = f2(cashBalance + proceeds);
          lv.sold = true;
          const pnl = f2((mid - lv.price) * SHARES);
          trades.unshift({
            ts: new Date().toTimeString().slice(0, 8),
            pair: m.pair, side: side.toUpperCase(),
            action: 'SELL', price: f4(mid), shares: SHARES, pnl,
          });
          if (trades.length > 400) trades.length = 400;
          log(`DEMO FORCE SELL ${side}@${f4(mid)} pnl:$${pnl}`);
        } else {
          try {
            const { Side, OrderType } = require('@polymarket/clob-client-v2');
            await trader._clob.createAndPostMarketOrder(
              { tokenID: tokenId, amount: SHARES, side: Side.SELL, orderType: OrderType.FOK },
              {}, OrderType.FOK
            );
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            lv.sold = true;
            log(`FORCE SELL ${side} ${SHARES}sh`);
          } catch (e) {
            log(`FORCE SELL err ${side}: ${e.message.slice(0,60)}`);
          }
        }
      }
      // Fill-only but no sell placed yet (shouldn't happen)
      if (lv.filled && !lv.sold && !lv.sellOrderId) {
        if (dryRun) {
          const mid = side === 'up' ? m.upMid : m.downMid;
          const proceeds = SHARES * mid;
          cashBalance = f2(cashBalance + proceeds);
          lv.sold = true;
        }
      }
    }
  }
  gs.forceClosed = true;
  log(`${m.pair} force close done`);
}

// ── Core trade loop (grid strategy) ──
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;
  const gs = gridState[m.slug];
  log(`Trade loop ${m.pair}`);

  // Wait for window to open
  if (m.windowStartMs > Date.now() + 2000) {
    const w = m.windowStartMs - Date.now();
    log(`${m.pair} window in ${Math.ceil(w/1000)}s`);
    await sleep(w);
  }

  // Place all grid BUY orders immediately
  gs.started = true;
  await placeGridOrders(m);

  // Main loop: monitor fills, place sells, force close at 282s
  let done = false;
  while (!done) {
    const elapsed = (Date.now() - m.windowStartMs) / 1000;
    if (elapsed >= WINDOW_SECS) { done = true; break; }

    await ensureFreshPrice(m);

    if (dryRun) await checkDemoFills(m);
    else        await checkRealFills(m);

    // Force close at 4.70 minutes
    if (elapsed >= CLOSE_AT_SECS && !gs.forceClosed) {
      await forceCloseWindow(m);
      done = true;
      break;
    }

    await sleep(TICK_MS);
  }

  // If natural end reached without force close, clean up
  if (!gs.forceClosed) await forceCloseWindow(m);

  gs.done = true;
  m.loopRunning = false;
  log(`${m.pair} window finished`);
}

// ── Main tick ──
async function tick() {
  const now = Date.now();
  if (now - lastDiscoverAt >= DISCOVER_EVERY_MS) {
    lastDiscoverAt = now;
    await discover();
  }
  emitFn('snapshot', snapshot());
}

function snapshot() {
  const calc = calcEquity();
  const equity = calc.equity;
  const unrealized = f2(calc.openValue - calc.costBasis);
  const pnl    = f2(equity - startBalance);

  const activeMarkets = Object.values(markets).map(m => {
    const gs = gridState[m.slug] || { up: [], down: [], started: false, forceClosed: false, done: false };
    return {
      slug: m.slug, pair: m.pair,
      upMid: f4(m.upMid), dnMid: f4(m.downMid),
      secsLeft: Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
      started: gs.started, forceClosed: gs.forceClosed,
      windowDone: gs.done,
      upGrid: (gs.up || []).map(l => ({
        p: l.price, f: l.filled, s: l.sold, c: l.cancelled, st: f4(l.sellTarget),
      })),
      dnGrid: (gs.down || []).map(l => ({
        p: l.price, f: l.filled, s: l.sold, c: l.cancelled, st: f4(l.sellTarget),
      })),
    };
  });

  return {
    dryRun, balance: f2(equity), cashBalance: f2(cashBalance),
    startBalance: f2(startBalance), pnl, unrealizedPnL: unrealized,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeMarkets, totalTrades: trades.length,
    recentTrades: trades.slice(0, 100),
    activityLog: logs.slice(0, 100),
    strategy: {
      shares: SHARES, tpOffset: TP_OFFSET,
      gridLevels: GRID_LEVELS, closeAtSecs: CLOSE_AT_SECS,
      dryRun, demoBalance: DEMO_BALANCE,
    },
  };
}

async function setDryRun(v) {
  dryRun = !!v;
  if (dryRun) { cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE; }
  log(`Dry-run: ${dryRun ? 'ON $' + DEMO_BALANCE : 'OFF'}`);
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
