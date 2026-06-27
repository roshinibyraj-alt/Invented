'use strict';

const WebSocket        = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const TICK_MS           = 500;
const DISCOVER_EVERY_MS = 15000;
const WINDOW_SECS       = 300;
const ENTRY_WAIT_SECS   = 10;
const SHARES            = 6;
const FORCE_CLOSE_SECS  = 30;
const HARD_SELL_SECS    = 15;
const MIN_ENTRY_PRICE   = 0.10;
const MAX_ENTRY_PRICE   = 0.90;
const LIMIT_OFFSET      = 0.10;
const FOK_RETRY_MS      = 2000;
const TARGET_PAIRS      = ['BTC'];
let dryRun = process.env.DRY_RUN === 'true';
const DEMO_BALANCE = parseFloat(process.env.DEMO_BALANCE || '50');

let emitFn     = () => {};
let slog       = () => {};
let trader     = null;
let balance    = 0;
let startBalance = 0;
let startTime  = Date.now();

const logs     = [];
const trades   = [];
const markets  = {};
let lastDiscoverAt = 0;

// Dashboard state per market
const dashState = {};

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
let ws = null, wsReady = false, wsPingTimer = null;
const wsTokenMap = {};

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log('Connecting price WS...');
  ws = new WebSocket(CLOB_WS);
  ws.on('open', () => {
    wsReady = true;
    log('Price WS connected');
    const ids = Object.keys(wsTokenMap);
    if (ids.length) wsSubscribe(ids);
    wsPingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000);
  });
  ws.on('message', (raw) => {
    try {
      const msgs = JSON.parse(raw);
      const arr = Array.isArray(msgs) ? msgs : [msgs];
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
    log('Price WS closed - reconnect 2s');
    setTimeout(wsConnect, 2000);
  });
  ws.on('error', (e) => { log(`WS err: ${e.message}`); try { ws.terminate(); } catch(_) {} });
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
  if (ur?.mid) m.upMid = f4(parseFloat(ur.mid));
  if (dr?.mid) m.downMid = f4(parseFloat(dr.mid));
  m.lastPriceAt = Date.now();
}

async function ensureFreshPrice(m) {
  const stale = !m.lastPriceAt || (Date.now() - m.lastPriceAt) > 3000;
  if (stale) await restRefreshPrice(m);
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

  dashState[slug] = {
    phase: 'entry',     // 'entry', 'holding', 'limit_watch', 'force_sell', 'done'
    side: null,         // 'up' or 'down'
    entryPrice: 0,
    sellOrderId: null,  // current GTC sell limit order ID
    buyOrderId: null,   // current GTC buy limit order ID
    sellPrice: 0,       // current sell limit price
    buyPrice: 0,        // current buy limit price
  };

  tradeLoop(markets[slug]).catch(e => log(`Loop crash ${pair}: ${e.message}`));
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
      delete dashState[slug];
    }
  }
}

// ── BUY initial position - FOK market order ──
async function buyInitial(m, side) {
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  const tickSize = side === 'up' ? m.upTickSize : m.dnTickSize;
  const negRisk = side === 'up' ? m.upNegRisk : m.dnNegRisk;
  const { Side, OrderType } = require('@polymarket/clob-client-v2');

  const price = side === 'up' ? m.upMid : m.downMid;
  if (price < MIN_ENTRY_PRICE || price > MAX_ENTRY_PRICE) {
    log(`${m.pair} ${side.toUpperCase()} price ${f4(price)} out of range`);
    return null;
  }

  const dollarAmount = f2(SHARES * price);
  log(`${m.pair} BUY INITIAL ${side.toUpperCase()} $${dollarAmount} (${SHARES}sh)`);

  if (dryRun) {
    if (balance < dollarAmount) { log(`DEMO insufficient $${f2(balance)}`); return null; }
    balance = f2(balance - dollarAmount);
    log(`DEMO FILLED BUY ${m.pair} ${side.toUpperCase()} @${f4(price)}`);
    return price;
  }

  const balBefore = await trader.getBalance();
  try {
    await trader._clob.createAndPostMarketOrder(
      { tokenID: tokenId, amount: dollarAmount, side: Side.BUY, orderType: OrderType.FOK },
      { tickSize, negRisk }, OrderType.FOK
    );
  } catch (e) { log(`BUY ERR ${m.pair}: ${e.message.slice(0, 80)}`); }

  const balAfter = await trader.getBalance();
  const drop = f2(balBefore - balAfter);
  if (drop >= dollarAmount * 0.5) {
    balance = balAfter;
    log(`FILLED BUY ${m.pair} ${side.toUpperCase()} cost~$${drop}`);
    return price;
  }
  log(`NOFILL BUY ${m.pair} (dropped $${drop})`);
  return null;
}

// ── FORCE SELL at market (for window end) ──
async function forceSell(m, side) {
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  const tickSize = side === 'up' ? m.upTickSize : m.dnTickSize;
  const negRisk = side === 'up' ? m.upNegRisk : m.dnNegRisk;
  const { Side, OrderType } = require('@polymarket/clob-client-v2');

  log(`FORCE SELL ${m.pair} ${side.toUpperCase()} ${SHARES}sh`);

  if (dryRun) {
    const price = side === 'up' ? m.upMid : m.downMid;
    const proceeds = f2(SHARES * price);
    balance = f2(balance + proceeds);
    log(`DEMO FILLED SELL @${f4(price)}`);
    return true;
  }

  const balBefore = await trader.getBalance();
  try {
    await trader._clob.createAndPostMarketOrder(
      { tokenID: tokenId, amount: SHARES, side: Side.SELL, orderType: OrderType.FOK },
      { tickSize, negRisk }, OrderType.FOK
    );
  } catch (e) { log(`SELL ERR ${m.pair}: ${e.message.slice(0, 80)}`); }

  const balAfter = await trader.getBalance();
  const rise = f2(balAfter - balBefore);
  if (rise > 0.01) { balance = balAfter; log(`FILLED SELL ${m.pair} proceeds~$${rise}`); return true; }
  log(`NOFILL SELL ${m.pair}`);
  return false;
}

// ── Cancel all pending GTC orders for a market ──
async function cancelAllOrders(slug) {
  const ds = dashState[slug];
  if (!ds) return;
  if (ds.sellOrderId) {
    try { await trader.cancelOrder(ds.sellOrderId); } catch (_) {}
    ds.sellOrderId = null;
  }
  if (ds.buyOrderId) {
    try { await trader.cancelOrder(ds.buyOrderId); } catch (_) {}
    ds.buyOrderId = null;
  }
}

// ── Update GTC limit orders (cancel old, place new) ──
async function updateLimitOrders(m) {
  const ds = dashState[m.slug];
  if (!ds || !ds.side) return;

  const sellTokenId = ds.side === 'up' ? m.upTokenId : m.downTokenId;
  const buyTokenId = ds.side === 'up' ? m.downTokenId : m.upTokenId;
  const sellPrice = f4((ds.side === 'up' ? m.upMid : m.downMid) + LIMIT_OFFSET);
  const buyPrice = f4((ds.side === 'up' ? m.downMid : m.upMid) - LIMIT_OFFSET);

  // Skip if price is invalid
  if (sellPrice <= 0 || buyPrice <= 0) return;

  // Cancel old orders
  if (ds.sellOrderId) {
    try { await trader.cancelOrder(ds.sellOrderId); } catch (_) {}
    ds.sellOrderId = null;
  }
  if (ds.buyOrderId) {
    try { await trader.cancelOrder(ds.buyOrderId); } catch (_) {}
    ds.buyOrderId = null;
  }

  // Place new GTC limit orders
  try {
    const sell = await trader.placeGtcOrder(sellTokenId, 'SELL', sellPrice, SHARES);
    if (sell?.id) ds.sellOrderId = sell.id;
  } catch (e) { log(`GTC SELL err: ${e.message.slice(0, 60)}`); }

  try {
    const buy = await trader.placeGtcOrder(buyTokenId, 'BUY', buyPrice, SHARES);
    if (buy?.id) ds.buyOrderId = buy.id;
  } catch (e) { log(`GTC BUY err: ${e.message.slice(0, 60)}`); }

  ds.sellPrice = sellPrice;
  ds.buyPrice = buyPrice;
}

// ── Check if GTC orders filled using getOpenOrders ──
async function checkFills(m) {
  const ds = dashState[m.slug];
  if (!ds) return { sellFilled: false, buyFilled: false };

  let openIds = new Set();
  try {
    const openOrders = await trader.getOpenOrders();
    openIds = new Set((openOrders || []).map(o => o.id));
  } catch (_) { return { sellFilled: false, buyFilled: false }; }

  const sellFilled = ds.sellOrderId ? !openIds.has(ds.sellOrderId) : false;
  const buyFilled = ds.buyOrderId ? !openIds.has(ds.buyOrderId) : false;

  if (sellFilled) { ds.sellOrderId = null; }
  if (buyFilled) { ds.buyOrderId = null; }

  return { sellFilled, buyFilled };
}

// ── Core Trade Loop (limit-order strategy) ──
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;
  const ds = dashState[m.slug];
  log(`Trade loop started ${m.pair}`);

  // Wait for window to open
  if (m.windowStartMs > Date.now() + 5000) {
    const w = m.windowStartMs - Date.now();
    log(`${m.pair} window starts in ${Math.ceil(w / 1000)}s`);
    await sleep(w);
  }

  // Wait for entry delay (ENTRY_WAIT_SECS after window open)
  const entryAt = m.windowStartMs + ENTRY_WAIT_SECS * 1000;
  const ew = entryAt - Date.now();
  if (ew > 0) { log(`${m.pair} entry in ${Math.ceil(ew / 1000)}s`); await sleep(ew); }

  // Pick cheapest side and buy initial
  await ensureFreshPrice(m);
  const initialSide = m.upMid <= m.downMid ? 'up' : 'down';
  log(`${m.pair} cheapest = ${initialSide.toUpperCase()} (up:${f4(m.upMid)} dn:${f4(m.downMid)})`);

  const ep = await buyInitial(m, initialSide);
  if (!ep) { log(`${m.pair} no entry`); m.done = true; m.loopRunning = false; return; }

  ds.side = initialSide;
  ds.entryPrice = ep;
  ds.phase = 'holding';

  trades.unshift({
    ts: new Date().toTimeString().slice(0, 8),
    pair: m.pair, side: initialSide.toUpperCase(),
    action: 'BUY', price: f4(ep), shares: SHARES,
  });
  if (trades.length > 200) trades.length = 200;

  // ── Limit-order management loop ──
  let forceSellTriggered = false;
  while (true) {
    const secsLeft = (m.endTime - Date.now()) / 1000;
    if (secsLeft <= 0) { log(`${m.pair} window ended`); break; }

    // Force sell at market when closing in
    if (secsLeft <= FORCE_CLOSE_SECS && !forceSellTriggered) {
      log(`${m.pair} force sell window closing (${Math.floor(secsLeft)}s)`);
      await cancelAllOrders(m.slug);

      if (ds.side) {
        const sold = await forceSell(m, ds.side);
        if (sold) {
          const exitP = ds.side === 'up' ? m.upMid : m.downMid;
          const pnl = f2((exitP - ds.entryPrice) * SHARES);
          trades.unshift({
            ts: new Date().toTimeString().slice(0, 8), pair: m.pair,
            side: ds.side.toUpperCase(), action: 'SELL', price: f4(exitP),
            shares: SHARES, pnl,
          });
          log(`${m.pair} closed pnl:$${pnl}`);
          if (trades.length > 200) trades.length = 200;
        }
        ds.side = null;
      }
      forceSellTriggered = true;
    }

    // Update prices
    await ensureFreshPrice(m);

    // Check if our GTC limit orders filled
    const fills = await checkFills(m);

    if (fills.sellFilled && ds.side) {
      // Sell limit filled! Position closed.
      const exitP = ds.side === 'up' ? m.upMid : m.downMid;
      const pnl = f2((exitP - ds.entryPrice) * SHARES);
      trades.unshift({
        ts: new Date().toTimeString().slice(0, 8), pair: m.pair,
        side: ds.side.toUpperCase(), action: 'SELL', price: f4(exitP),
        shares: SHARES, pnl,
      });
      log(`${m.pair} SELL LIMIT FILLED pnl:$${pnl}`);
      if (trades.length > 200) trades.length = 200;
      ds.side = null;  // Flat now
      ds.phase = 'flat';
    }

    if (fills.buyFilled && ds.side === null) {
      // Buy limit filled on opposite! Now holding opposite.
      const newSide = initialSide === 'up' ? 'down' : 'up';
      ds.side = newSide;
      ds.entryPrice = newSide === 'up' ? m.upMid : m.downMid;
      ds.phase = 'holding';
      log(`${m.pair} BUY LIMIT FILLED - now holding ${newSide.toUpperCase()} @ ${f4(ds.entryPrice)}`);
    }

    // Place/update GTC limit orders
    if (ds.side && !forceSellTriggered) {
      await updateLimitOrders(m);
    }

    // Log current state every 5s for dashboard
    if (ds.sellOrderId || ds.buyOrderId || ds.side) {
      log(`Orders: sell${ds.sellOrderId ? '@' + f4(ds.sellPrice) : ' none'} buy${ds.buyOrderId ? '@' + f4(ds.buyPrice) : ' none'} held:${ds.side || 'none'}`);
    }

    await sleep(500);
  }

  // Cleanup
  await cancelAllOrders(m.slug);
  m.done = true;
  m.loopRunning = false;
  log(`${m.pair} loop finished`);
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
  const activeMarkets = Object.values(markets).map(m => {
    const ds = dashState[m.slug] || {};
    return {
      slug: m.slug, pair: m.pair,
      upMid: f4(m.upMid), dnMid: f4(m.downMid),
      secsLeft: Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
      loopRunning: m.loopRunning, done: m.done,
      // Dashboard extras
      phase: ds.phase || 'idle',
      positionSide: ds.side ? ds.side.toUpperCase() : null,
      entryPrice: f4(ds.entryPrice || 0),
      sellLimitPrice: f4(ds.sellPrice || 0),
      buyLimitPrice: f4(ds.buyPrice || 0),
      sellOrderActive: !!ds.sellOrderId,
      buyOrderActive: !!ds.buyOrderId,
    };
  });

  return {
    dryRun, balance: f2(balance), startBalance: f2(startBalance),
    pnl: f2(balance - startBalance),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeMarkets, totalTrades: trades.length,
    recentTrades: trades.slice(0, 60),
    activityLog: logs.slice(0, 80),
    strategy: { shares: SHARES, limitOffset: LIMIT_OFFSET,
      entryWaitSecs: ENTRY_WAIT_SECS, forceCloseSecs: FORCE_CLOSE_SECS,
      dryRun, demoBalance: DEMO_BALANCE },
  };
}

async function setDryRun(v) {
  dryRun = !!v;
  if (dryRun) { balance = DEMO_BALANCE; startBalance = DEMO_BALANCE; }
  log(`Dry-run: ${dryRun ? 'ON $' + DEMO_BALANCE : 'OFF'}`);
  if (!dryRun && trader) {
    try { const b = await trader.getBalance(); if (b > 0) { balance = b; startBalance = b; } } catch (_) {}
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
    if (dryRun) { balance = DEMO_BALANCE; startBalance = DEMO_BALANCE; log(`DEMO $${f2(balance)}`); }
    else { const b = await trader.getBalance(); if (b > 0) { balance = b; startBalance = b; } log(`LIVE $${f2(balance)}`); }
  } catch (e) { log(`Auth fail: ${e.message}`); process.exit(1); }

  wsConnect();
  log('Starting main loop');
  setInterval(tick, TICK_MS);
}

module.exports = { start, snapshot, setDryRun, getDryRun };
