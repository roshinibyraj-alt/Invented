'use strict';

const WebSocket = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const TICK_MS           = 350;
const DISCOVER_EVERY_MS = 10000;
const WINDOW_SECS       = 300;
const TRAIL_DIST        = 0.05;
const BASE_SHARES       = 6;
const RETRY_MS          = 3000;
const TP_PRICE          = 0.99;
const STOP_ENTRY_AT     = 280;
const FORCE_SELL_AT     = 295;
const TARGET_PAIRS      = ['BTC'];

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

let position = null;
let entryPrice = 0;
let sharesHeld = 0;
let peak = 0;
let trough = 0;
let inTrade = false;
let trailHigh = 0;
let stopPeak = 0;
let stopTrough = 0;
let windowEnding = false;
let forceSold = false;
let pendingTrade = null;
let pendingCheckAt = 0;

let tradeLoopRunning = false;

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  const line = '[' + ts + '] [BTC] ' + msg;
  logs.unshift(line);
  if (logs.length > 500) logs.length = 500;
  if (slog) slog(line);
}

function logTrade(action, side, price, pnl) {
  trades.unshift({
    ts: new Date().toTimeString().slice(0, 8),
    action, side,
    price: f4(price),
    shares: BASE_SHARES,
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
    if (ss.side === 'up' && !ss.sold) openValue += BASE_SHARES * m.upMid;
    if (ss.side === 'down' && !ss.sold) openValue += BASE_SHARES * m.downMid;
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

// ── Discovery ──
async function discoverMarket(pair, customWsTs) {
  const ws_ts = customWsTs || currentWindowStart();
  const slug = pair.toLowerCase() + '-updown-5m-' + ws_ts;
  if (markets[slug]) return;

  const d = await getJSON(GAMMA + '/events?slug=' + slug);
  if (!Array.isArray(d) || !d[0] || !d[0].markets || !d[0].markets[0]) return;
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
  const tickSize = mk.orderPriceMinTickSize || '0.01';
  const negRisk = mk.negRisk || false;

  const outcomePrices = JSON.parse(mk.outcomePrices || '[]');
  const upMid = parseFloat(outcomePrices[0] || '0');
  const downMid = parseFloat(outcomePrices[1] || '0');

  markets[slug] = {
    slug, pair, upTokenId, downTokenId,
    upMid: f4(upMid), downMid: f4(downMid), lastPriceAt: 0,
    endTime, windowStartMs: ws_ts * 1000,
    upTickSize: tickSize, dnTickSize: tickSize,
    upNegRisk: negRisk, dnNegRisk: negRisk,
    loopRunning: false, done: false,
  };

  wsTokenMap[upTokenId] = slug;
  wsTokenMap[downTokenId] = slug;
  if (wsReady) wsSubscribe([upTokenId, downTokenId]);

  await restRefreshPrice(markets[slug]);
  log(pair + ' UP:$' + f4(markets[slug].upMid) + ' DN:$' + f4(markets[slug].downMid));

  markets[slug].loopRunning = true;
  tradeLoop(markets[slug]).catch(e => log('Loop crash ' + pair + ': ' + e.message));
}

async function discover() {
  const cw = currentWindowStart();
  const timestamps = [cw, cw + WINDOW_SECS];
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

// ── Balance check ──
async function checkBalance() {
  if (!trader) return 0;
  try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; return cashBalance; }
  catch (_) { return cashBalance; }
}

// ── Trade functions — balance-based confirmation only ──

async function buyUp(m, st) {
  if (!m || inTrade || pendingTrade) return null;
  inTrade = true;
  try {
    var cost = f2(BASE_SHARES * m.upMid);
    var preBal = await checkBalance();
    log('BUY UP ' + BASE_SHARES + 'sh @ $' + f4(m.upMid) + ' (~$' + cost + ') bal=$' + f2(preBal));

    await trader.placeFokBuy(m.upTokenId, cost);

    // Non-blocking: set pendingTrade, main loop checks balance
    pendingTrade = { type: 'buyUp', m: m, st: st, preBal: preBal, cost: cost, entryPriceAt: m.upMid };
    pendingCheckAt = Date.now();
    return { pending: true };
  } catch (e) {
    log('Buy UP error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    return null;
  }
}

async function buyDown(m, st) {
  if (!m || inTrade || pendingTrade) return null;
  inTrade = true;
  try {
    var cost = f2(BASE_SHARES * m.downMid);
    var preBal = await checkBalance();
    log('BUY DOWN ' + BASE_SHARES + 'sh @ $' + f4(m.downMid) + ' (~$' + cost + ') bal=$' + f2(preBal));

    await trader.placeFokBuy(m.downTokenId, cost);

    pendingTrade = { type: 'buyDown', m: m, st: st, preBal: preBal, cost: cost, entryPriceAt: m.downMid };
    pendingCheckAt = Date.now();
    return { pending: true };
  } catch (e) {
    log('Buy DOWN error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    return null;
  }
}

async function sellUp(m, flipTo, st) {
  if (!m || inTrade || !position || pendingTrade) return null;
  inTrade = true;
  try {
    var mid = m.upMid;
    var pnl = f2((mid - entryPrice) * BASE_SHARES);
    var preBal = await checkBalance();
    log('SELL UP @ $' + f4(mid) + ' PnL: ' + (pnl >= 0 ? '+' : '') + '$' + pnl + ' bal=$' + f2(preBal));

    await trader.placeFokSell(m.upTokenId, BASE_SHARES);

    pendingTrade = { type: 'sellUp', m: m, st: st, flipTo: flipTo, preBal: preBal, pnl: pnl, priceAt: mid };
    pendingCheckAt = Date.now();
    return { pending: true };
  } catch (e) {
    log('Sell UP error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    return null;
  }
}

async function sellDown(m, flipTo, st) {
  if (!m || inTrade || !position) return null;
  inTrade = true;
  try {
    var mid = m.downMid;
    var pnl = f2((entryPrice - mid) * BASE_SHARES);
    var preBal = await checkBalance();
    log('SELL DOWN @ $' + f4(mid) + ' PnL: ' + (pnl >= 0 ? '+' : '') + '$' + pnl + ' bal=$' + f2(preBal));

    await trader.placeFokSell(m.downTokenId, BASE_SHARES);

    await sleep(3000);
    var postBal = await checkBalance();
    var gained = f2(postBal - preBal);

    if (gained > 0.01) {
      log('DOWN SOLD PnL: ' + (pnl >= 0 ? '+' : '') + '$' + pnl + ' gained $' + gained);
      logTrade('SELL', 'DOWN', mid, pnl);
      position = null;
      sharesHeld = 0;
      entryPrice = 0;
      if (st) { st.side = null; st.sharesHeld = 0; st.entryPrice = 0; }
      inTrade = false;
      if (flipTo === 'up') return await buyDown(m, st);
      return { filled: true, price: mid, pnl: pnl };
    }

    log('DOWN NOT sold (gained $' + f2(gained) + ') - retry in 3s');
    await sleep(RETRY_MS);
    inTrade = false;
    return null;
  } catch (e) {
    log('Sell DOWN error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    return null;
  }
}

// ── Trade Loop ──
async function tradeLoop(m) {
  log('Loop ' + m.pair + ' waiting for window...');

  if (m.windowStartMs > Date.now() + 2000) {
    await sleep(m.windowStartMs - Date.now());
  }

  log(m.pair + ' window STARTED');

  var ss = { side: null, sold: false, done: false, entryPrice: 0, sharesHeld: 0, peak: 0, trough: 0 };
  stratState[m.slug] = ss;

  while (true) {
    var elapsed = (Date.now() - m.windowStartMs) / 1000;
    if (elapsed >= WINDOW_SECS + 1) break;

    await ensureFreshPrice(m);

    var up = m.upMid;
    var dn = m.downMid;
    if (up <= 0 || dn <= 0) { await sleep(TICK_MS); continue; }

    // Track trailing values (runs EVERY tick, never blocked)
    if (ss.side === 'up') {
      if (up > ss.peak) ss.peak = up;
    } else if (ss.side === 'down') {
      if (dn < ss.trough || ss.trough === 0) ss.trough = dn;
    } else {
      if (up > ss.peak || ss.peak === 0) ss.peak = up;
    }

    // Check pending trade confirmation (non-blocking, runs every tick)
    if (pendingTrade && Date.now() - pendingCheckAt > 3000) {
      var pt = pendingTrade;
      var postBal = await checkBalance();

      if (pt.type === 'buyUp' || pt.type === 'buyDown') {
        var spent = f2(pt.preBal - postBal);
        if (spent >= pt.cost * 0.3) {
          log((pt.type === 'buyUp' ? 'UP' : 'DOWN') + ' FILLED spent $' + spent);
          var side = pt.type === 'buyUp' ? 'up' : 'down';
          var priceKey = pt.type === 'buyUp' ? 'entryPriceAt' : 'entryPriceAt';
          position = side;
          entryPrice = pt[priceKey];
          sharesHeld = BASE_SHARES;
          if (side === 'up') peak = pt[priceKey];
          else trough = pt[priceKey];
          if (pt.st) {
            pt.st.side = side;
            pt.st.entryPrice = pt[priceKey];
            pt.st.sharesHeld = BASE_SHARES;
            if (side === 'up') pt.st.peak = pt[priceKey];
            else pt.st.trough = pt[priceKey];
          }
          logTrade('BUY', side.toUpperCase(), pt[priceKey]);
          inTrade = false;
          pendingTrade = null;
        } else {
          log((pt.type === 'buyUp' ? 'UP' : 'DOWN') + ' NOT filled (spent $' + spent + ') - retrying');
          // Retry
          if (pt.type === 'buyUp') {
            pendingTrade = null; inTrade = false;
            // Will trigger re-entry on next tick if condition still met
          } else {
            pendingTrade = null; inTrade = false;
          }
        }
      }

      if (pt.type === 'sellUp' || pt.type === 'sellDown') {
        var gained = f2(postBal - pt.preBal);
        if (gained > 0.01) {
          log((pt.type === 'sellUp' ? 'UP' : 'DOWN') + ' SOLD PnL: ' + (pt.pnl >= 0 ? '+' : '') + '$' + pt.pnl);
          logTrade('SELL', (pt.type === 'sellUp' ? 'UP' : 'DOWN'), pt.priceAt, pt.pnl);
          position = null; sharesHeld = 0; entryPrice = 0;
          if (pt.st) { pt.st.side = null; pt.st.sharesHeld = 0; pt.st.entryPrice = 0; }
          inTrade = false;
          pendingTrade = null;
          if (pt.flipTo) {
            // Trigger flip immediately
            if (pt.flipTo === 'down') await buyDown(pt.m, pt.st);
            else if (pt.flipTo === 'up') await buyUp(pt.m, pt.st);
          }
        } else {
          log((pt.type === 'sellUp' ? 'UP' : 'DOWN') + ' NOT sold (gained $' + f2(gained) + ') - retrying');
          pendingTrade = null; inTrade = false;
        }
      }

      if (pendingTrade === null) {
        // Reset peak/trough after position change
        if (position === 'up' && peak > 0) { ss.peak = peak; }
        if (position === 'down' && trough > 0) { ss.trough = trough; }
      }
    }

    // Phase 1: < 280s — trailing + flip
    if (elapsed < STOP_ENTRY_AT) {
      if (!ss.side && !inTrade) {
        var drop = f4(ss.peak - up);
        if (drop >= TRAIL_DIST) {
          log('UP dropped $' + f4(drop) + ' from peak $' + f4(ss.peak) + ' — entering');
          var r = await buyUp(m, ss);
          if (r && r.filled) {
            ss.side = 'up'; ss.entryPrice = m.upMid; ss.sharesHeld = BASE_SHARES; ss.peak = m.upMid;
            position = 'up'; entryPrice = m.upMid; sharesHeld = BASE_SHARES; peak = m.upMid;
          }
        }
      }

      if (ss.side === 'up' && !inTrade) {
        var drop = f4(ss.peak - up);
        if (drop >= TRAIL_DIST) {
          log('UP stop hit — selling & flipping DOWN');
          await sellUp(m, 'down', ss);
        }
      }

      if (ss.side === 'down' && !inTrade) {
        var rise = f4(dn - ss.trough);
        if (rise >= TRAIL_DIST) {
          log('DOWN stop hit — selling & flipping UP');
          await sellDown(m, 'up', ss);
        }
      }
    }

    // Phase 2: 280-295s — stop entries, place TP sell @0.99
    if (elapsed >= STOP_ENTRY_AT && elapsed < FORCE_SELL_AT && !ss._tpPlaced && ss.side) {
      ss._tpPlaced = true;
      log(m.pair + ' — placing TP @0.99 for ' + ss.side.toUpperCase());
      if (dryRun) { ss._tpId = 'demo_tp'; }
      else {
        var tokenId = ss.side === 'up' ? m.upTokenId : m.downTokenId;
        try { var r = await trader.placeGtcOrder(tokenId, 'SELL', TP_PRICE, BASE_SHARES); ss._tpId = r ? r.id : null; }
        catch(e) { log('TP err: ' + (e.message || '').slice(0, 60)); }
      }
    }

    // Phase 3: 295s+ — force sell
    if (elapsed >= FORCE_SELL_AT && !ss._forceSold && ss.side) {
      ss._forceSold = true;
      log(m.pair + ' FORCE SELL at ' + elapsed.toFixed(1) + 's');
      if (ss.side === 'up') { await sellUp(m, null, ss); ss.side = null; ss.sold = true; position = null; }
      if (ss.side === 'down') { await sellDown(m, null, ss); ss.side = null; ss.sold = true; position = null; }
    }

    await sleep(TICK_MS);
  }

  log(m.pair + ' window done');
  ss.done = true;
  m.loopRunning = false;
}

// ── Snapshot ──
function snapshot() {
  const equity = calcEquity();
  const pnl = f2(equity - startBalance);

  const activeMarkets = Object.values(markets)
    .filter(m => m.windowStartMs <= Date.now() && Date.now() < m.endTime + 30000)
    .map(m => {
    var ss = stratState[m.slug] || {};
    var elapsed = Math.max(0, (Date.now() - m.windowStartMs) / 1000);
    var phase = 'waiting';
    if (elapsed >= FORCE_SELL_AT) phase = 'force_sell';
    else if (elapsed >= STOP_ENTRY_AT) phase = 'tp_phase';
    else if (elapsed > 0) phase = 'trading';

    return {
      slug: m.slug, pair: m.pair,
      upMid: f4(m.upMid), dnMid: f4(m.downMid),
      secsLeft: Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
      elapsed: Math.floor(elapsed),
      phase: phase,
      position: ss.side || null,
      entryPrice: f4(ss.entryPrice || 0),
      sharesHeld: ss.sharesHeld || 0,
      stopPeak: f4(ss.peak || 0),
      stopTrough: f4(ss.trough || 0),
    };
  });

  return {
    dryRun, balance: f2(equity), cashBalance: f2(cashBalance),
    startBalance: f2(startBalance), pnl,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeMarkets,
    recentTrades: trades.slice(0, 100),
    activityLog: logs.slice(0, 50),
    strategy: { type: 'btc_trail_flip', shares: BASE_SHARES, trailDist: TRAIL_DIST, tpPrice: TP_PRICE },
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
  } catch (e) { log('Auth fail: ' + e.message); process.exit(1); }

  wsConnect();
  log('Starting main loop');

  setInterval(async () => {
    var now = Date.now();
    if (now - lastDiscoverAt >= DISCOVER_EVERY_MS) {
      lastDiscoverAt = now;
      await discover();
    }
    emitFn('snapshot', snapshot());
  }, TICK_MS);
}

async function setDryRun(v) { dryRun = !!v; }
function getDryRun() { return dryRun; }

module.exports = { start, snapshot, setDryRun, getDryRun };
