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
let pendingTrade = null;
let pendingCheckAt = 0;

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

function logTrade(action, side, price, pnl, shares) {
  trades.unshift({
    ts: new Date().toTimeString().slice(0, 8),
    action, side,
    price: f4(price),
    shares: shares || BASE_SHARES,
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
    if (ss.side === 'up' && ss.positionOpen) openValue += (ss.sharesHeld || BASE_SHARES) * m.upMid;
    if (ss.side === 'down' && ss.positionOpen) openValue += (ss.sharesHeld || BASE_SHARES) * m.downMid;
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

  if (!markets[slug].loopRunning) {
    markets[slug].loopRunning = true;
    tradeLoop(markets[slug]).catch(e => log('Loop crash ' + pair + ': ' + e.message));
  }
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

// ── Trade functions ──

async function buySide(m, side, ss) {
  if (!m || inTrade || pendingTrade) return null;
  inTrade = true;
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  try {
    var price = side === 'up' ? m.upMid : m.downMid;
    if (!price || price <= 0.01) { inTrade = false; return null; }
    var cost = f2(BASE_SHARES * price);
    var preBal = await checkBalance();
    if (cost > preBal * 0.9) cost = f2(preBal * 0.9);
    if (cost <= 0.01) { inTrade = false; return null; }
    log('BUY ' + side.toUpperCase() + ' ~' + BASE_SHARES + 'sh @ $' + f4(price) + ' (~$' + cost + ') bal=$' + f2(preBal));
    if (dryRun) {
      cashBalance -= cost;
      if (cashBalance < 0) cashBalance = 0;
      log('DEMO placed -$' + f2(cost) + ' bal=$' + f2(cashBalance));
      pendingTrade = { type: 'buy', side: side, m: m, ss: ss, preBal: preBal, cost: cost, entryPriceAt: price, isDemo: true };
      pendingCheckAt = Date.now();
      return { pending: true };
    }
    await trader.placeFokBuy(tokenId, cost);
    pendingTrade = { type: 'buy', side: side, m: m, ss: ss, preBal: preBal, cost: cost, entryPriceAt: price };
    pendingCheckAt = Date.now();
    return { pending: true };
  } catch (e) {
    log('Buy ' + side.toUpperCase() + ' error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    if (ss) ss._retryCooldown = Date.now() + 5000;
    return null;
  }
}

async function sellSide(m, flipTo, ss) {
  if (!m || inTrade || pendingTrade) return null;
  var sellSideName = position || (ss && ss.side) || null;
  if (!sellSideName) { log('SELL skipped — no position'); return null; }
  inTrade = true;
  const tokenId = sellSideName === 'up' ? m.upTokenId : m.downTokenId;
  try {
    var actualShares = (ss && ss.sharesHeld > 0) ? ss.sharesHeld : (sharesHeld > 0 ? sharesHeld : BASE_SHARES);
    var mid = sellSideName === 'up' ? m.upMid : m.downMid;
    var pnl = f2((mid - entryPrice) * actualShares);
    var preBal = await checkBalance();
    log('SELL ' + sellSideName.toUpperCase() + ' ' + actualShares + 'sh @ $' + f4(mid) + ' PnL: ' + (pnl >= 0 ? '+' : '') + '$' + pnl + ' bal=$' + f2(preBal));
    if (dryRun) {
      var proceeds = f4(actualShares * mid);
      cashBalance += proceeds;
      log('DEMO sold +$' + f2(proceeds) + ' bal=$' + f2(cashBalance));
      // In demo, skip sell confirmation, mark as sold immediately
      position = null;
      sharesHeld = 0;
      entryPrice = 0;
      if (ss) {
        ss.side = null;
        ss.sharesHeld = 0;
        ss.entryPrice = 0;
        ss.peak = 0;
        ss.trough = 0;
        ss.positionOpen = false;
        if (ss._forceSold) ss.sold = true;
        ss._forceSelling = false;
      }
      inTrade = false;
      if (flipTo) {
        log('Flipping to ' + flipTo.toUpperCase());
        await buySide(m, flipTo, ss);
      }
      return { pending: false };
    }
    await trader.placeFokSell(tokenId, actualShares);
    pendingTrade = { type: 'sell', side: sellSideName, m: m, ss: ss, flipTo: flipTo, preBal: preBal, pnl: pnl, priceAt: mid, shares: actualShares };
    pendingCheckAt = Date.now();
    return { pending: true };
  } catch (e) {
    log('Sell ' + sellSideName.toUpperCase() + ' error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    return null;
  }
}

async function checkPendingTrade() {
  if (!pendingTrade) return;
  if (Date.now() - pendingCheckAt < 3000) return;

  var pt = pendingTrade;
  var postBal = await checkBalance();

  if (pt.type === 'buy') {
    if (pt.isDemo) {
      var actualShares = Math.round(pt.cost / pt.entryPriceAt);
      if (actualShares < 1) actualShares = BASE_SHARES;
      log(pt.side.toUpperCase() + ' DEMO BUY FILLED ~' + actualShares + 'sh');
      position = pt.side;
      entryPrice = pt.entryPriceAt;
      sharesHeld = actualShares;
      logTrade('BUY', pt.side.toUpperCase(), pt.entryPriceAt, 0, actualShares);
      if (pt.ss) {
        pt.ss.side = pt.side;
        pt.ss.entryPrice = pt.entryPriceAt;
        pt.ss.sharesHeld = actualShares;
        pt.ss.positionOpen = true;
        pt.ss._pendingEntry = false;
      }
      inTrade = false;
      pendingTrade = null;
      return;
    }
    var spent = f2(pt.preBal - postBal);
    if (spent >= pt.cost * 0.3) {
      var actualShares = Math.round(spent / pt.entryPriceAt);
      if (actualShares < 1) actualShares = Math.round(spent / (spent / BASE_SHARES));
      log(pt.side.toUpperCase() + ' BUY FILLED spent $' + spent + ' got ~' + actualShares + 'sh');
      position = pt.side;
      entryPrice = pt.entryPriceAt;
      sharesHeld = actualShares;
      logTrade('BUY', pt.side.toUpperCase(), pt.entryPriceAt, 0, actualShares);
      if (pt.ss) {
        pt.ss.side = pt.side;
        pt.ss.entryPrice = pt.entryPriceAt;
        pt.ss.sharesHeld = actualShares;
        pt.ss.positionOpen = true;
        pt.ss._pendingEntry = false;
      }
      inTrade = false;
      pendingTrade = null;
    } else {
      log(pt.side.toUpperCase() + ' BUY NOT filled (spent $' + spent + ')');
      if (pt.ss) {
        pt.ss._pendingEntry = false;
        pt.ss.side = null;
        pt.ss.sharesHeld = 0;
        pt.ss.positionOpen = false;
        pt.ss._retryCooldown = Date.now() + 5000;
      }
      inTrade = false;
      pendingTrade = null;
    }
    return;
  }

  if (pt.type === 'sell') {
    // Demo sells are handled inline in sellSide, skip confirmation
    if (pt.isDemo) { pendingTrade = null; inTrade = false; return; }
    var gained = f2(postBal - pt.preBal);
    var expectedGain = (pt.shares || BASE_SHARES) * (pt.priceAt || 0.5);
    if (gained >= expectedGain * 0.3) {
      log(pt.side.toUpperCase() + ' SOLD PnL: ' + (pt.pnl >= 0 ? '+' : '') + '$' + pt.pnl);
      logTrade('SELL', pt.side.toUpperCase(), pt.priceAt, pt.pnl, pt.shares || BASE_SHARES);

      position = null;
      sharesHeld = 0;
      entryPrice = 0;

      if (pt.ss) {
        pt.ss.side = null;
        pt.ss.sharesHeld = 0;
        pt.ss.entryPrice = 0;
        pt.ss.peak = 0;
        pt.ss.trough = 0;
        pt.ss.positionOpen = false;
        if (pt.ss._forceSold) pt.ss.sold = true;
        pt.ss._forceSelling = false;
      }

      inTrade = false;
      pendingTrade = null;

      if (pt.flipTo) {
        log('Flipping to ' + pt.flipTo.toUpperCase());
        await buySide(pt.m, pt.flipTo, pt.ss);
      }
    } else {
      log(pt.side.toUpperCase() + ' NOT sold (gained $' + f2(gained) + ')');
      pendingTrade = null;
      inTrade = false;

      if (pt.ss && pt.ss._forceSelling) {
        log('Force sell retrying...');
        await sellSide(pt.m, null, pt.ss);
      }
    }
    return;
  }
}

// ── Trade Loop ──
async function tradeLoop(m) {
  log('Loop ' + m.pair + ' waiting for window...');

  if (m.windowStartMs > Date.now() + 2000) {
    await sleep(m.windowStartMs - Date.now());
  }

  log(m.pair + ' window STARTED');

  var ss = {
    side: null, sold: false, done: false,
    entryPrice: 0, sharesHeld: 0,
    peak: 0, trough: 0,
    positionOpen: false,
    _pendingEntry: false,
    _retryCooldown: 0,
    _forceSold: false, _forceSelling: false,
  };
  stratState[m.slug] = ss;

  while (true) {
    var elapsed = (Date.now() - m.windowStartMs) / 1000;
    if (elapsed >= WINDOW_SECS + 1) break;

    await ensureFreshPrice(m);

    var up = m.upMid;
    var dn = m.downMid;
    if (up <= 0 || dn <= 0) { await sleep(TICK_MS); continue; }

    // Track trailing values (runs EVERY tick, never blocked)
    if (ss.positionOpen) {
      if (ss.side === 'up') {
        if (up > ss.peak) ss.peak = up;
      } else if (ss.side === 'down') {
        if (dn < ss.trough || ss.trough === 0) ss.trough = dn;
      }
    } else {
      if (up > ss.peak || ss.peak === 0) ss.peak = up;
      if ((dn < ss.trough || ss.trough === 0) && dn > 0) ss.trough = dn;
    }

    // Check pending trade confirmations (non-blocking)
    await checkPendingTrade();

    // Phase 1: < 280s — trailing stop + flip
    if (elapsed < STOP_ENTRY_AT) {
      // No position — entry opportunity (only UP first, flip to DOWN via trailing stop)
      if (!ss.positionOpen && !ss._pendingEntry && !inTrade && !pendingTrade && (!ss._retryCooldown || Date.now() > ss._retryCooldown)) {
        var drop = f4(ss.peak - up);
        if (drop >= TRAIL_DIST) {
          log('UP dropped $' + f4(drop) + ' from peak $' + f4(ss.peak) + ' — entering UP');
          ss._pendingEntry = true;
          var r = await buySide(m, 'up', ss);
          if (!r) ss._pendingEntry = false; // buy rejected immediately
        }
      }

      // UP position — check trailing stop
      if (ss.positionOpen && ss.side === 'up' && !inTrade && !pendingTrade) {
        var drop = f4(ss.peak - up);
        if (drop >= TRAIL_DIST) {
          log('UP stop hit — selling & flipping DOWN');
          await sellSide(m, 'down', ss);
        }
      }

      // DOWN position — check trailing stop
      if (ss.positionOpen && ss.side === 'down' && !inTrade && !pendingTrade) {
        var rise = f4(dn - ss.trough);
        if (rise >= TRAIL_DIST) {
          log('DOWN stop hit — selling & flipping UP');
          await sellSide(m, 'up', ss);
        }
      }
    }

    // Phase 2: 280-295s — stop entries, place TP @0.99
    if (elapsed >= STOP_ENTRY_AT && elapsed < FORCE_SELL_AT && !ss._tpPlaced && ss.positionOpen) {
      ss._tpPlaced = true;
      log(m.pair + ' — placing TP @0.99 for ' + ss.side.toUpperCase());
      if (!dryRun) {
        var tokenId = ss.side === 'up' ? m.upTokenId : m.downTokenId;
        var tpShares = ss.sharesHeld > 0 ? ss.sharesHeld : BASE_SHARES;
        try { await trader.placeGtcOrder(tokenId, 'SELL', TP_PRICE, tpShares); }
        catch(e) { log('TP err: ' + (e.message || '').slice(0, 60)); }
      }
    }

    // Phase 3: 295s+ — force sell with retry
    if (elapsed >= FORCE_SELL_AT && !ss._forceSold && ss.positionOpen) {
      ss._forceSold = true;
      ss._forceSelling = true;
      // Ensure position global matches ss.side for sellSide to work
      if (!position && ss.side) position = ss.side;
      log(m.pair + ' FORCE SELL at ' + elapsed.toFixed(1) + 's');
      if (!inTrade && !pendingTrade) {
        await sellSide(m, null, ss);
      }
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
      position: (ss.positionOpen ? ss.side : null) || null,
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
  } catch (e) {
    if (dryRun) { cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE; log('DEMO $' + f2(cashBalance) + ' (auth failed, data only)'); }
    else { log('Auth fail: ' + e.message); process.exit(1); }
  }

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

async function setDryRun(v) {
  var wasDry = dryRun;
  dryRun = !!v;
  // Switching from DEMO → LIVE: sync balance and clear stale demo positions
  if (wasDry && !dryRun && trader) {
    try {
      var b = await trader.getBalance();
      if (b > 0) { cashBalance = b; startBalance = b; }
      log('Switched to LIVE — balance: $' + f2(cashBalance));
    } catch(e) { log('Live sync err: ' + e.message); }
    // Clear any stale positions from demo mode
    position = null; sharesHeld = 0; entryPrice = 0;
    inTrade = false; pendingTrade = null;
    for (var k in stratState) {
      var ss = stratState[k];
      ss.positionOpen = false; ss.side = null; ss.sharesHeld = 0;
      ss.entryPrice = 0; ss.peak = 0; ss.trough = 0;
      ss._pendingEntry = false; ss._retryCooldown = 0;
    }
    log('Demo positions cleared');
  }
  // Switching from LIVE → DEMO: reset demo balance
  if (!wasDry && dryRun) {
    cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE;
    position = null; sharesHeld = 0; entryPrice = 0;
    inTrade = false; pendingTrade = null;
    for (var k in stratState) {
      var ss = stratState[k];
      ss.positionOpen = false; ss.side = null; ss.sharesHeld = 0;
      ss.entryPrice = 0; ss.peak = 0; ss.trough = 0;
      ss._pendingEntry = false; ss._retryCooldown = 0;
    }
    log('Switched to DEMO — balance: $' + f2(cashBalance));
  }
}
function getDryRun() { return dryRun; }

module.exports = { start, snapshot, setDryRun, getDryRun };
