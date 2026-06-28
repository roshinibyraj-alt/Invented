'use strict';

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS       = 1000;
const TRAIL_DIST    = 0.05;
const BASE_SHARES   = 30;
const CONFIRM_MS    = 2000;
const RETRY_MS      = 4000;
const MARKET_SLUG   = 'crint-irl4-ind4-2026-06-28';

let dryRun = false;
let emitFn = () => {};
let slog   = () => {};
let trader = null;

let cashBalance  = 0;
let startBalance = 0;
let startTime    = Date.now();

const logs   = [];
const trades = [];

let mkt = null;
let mktReady = false;

let position    = null;
let entryPrice  = 0;
let sharesHeld  = 0;
let trailHigh   = 0;
let stopPeak    = 0;
let stopTrough  = 0;
let flipCount   = 0;
let pendingFlip = null;
let inTrade     = false;

let tradeLoopRunning = false;

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts   = new Date().toTimeString().slice(0, 8);
  const line = '[' + ts + '] [CRICKET] ' + msg;
  logs.unshift(line);
  if (logs.length > 500) logs.length = 500;
  if (slog) slog(line);
}

function logTrade(action, side, price, pnl) {
  trades.unshift({
    ts: new Date().toTimeString().slice(0, 8),
    action: action,
    side: side,
    price: f4(price),
    shares: BASE_SHARES,
    pnl: f2(pnl || 0),
  });
  if (trades.length > 200) trades.length = 200;
}

async function getJSON(url) {
  try {
    const ac = new AbortController();
    const t  = setTimeout(function() { ac.abort(); }, 10000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? r.json() : null;
  } catch (_) { return null; }
}

// Market discovery
async function discoverCricketMarket() {
  if (mktReady) return;
  log('Looking up market: ' + MARKET_SLUG);
  const d = await getJSON(GAMMA + '/events?slug=' + MARKET_SLUG);
  if (!Array.isArray(d) || !d[0] || !d[0].markets || !d[0].markets.length) {
    log('Market not found via Gamma API, retrying in 5s');
    return;
  }

  const ev = d[0];
  log('Found event: ' + ev.title + ' (' + ev.slug + ') with ' + ev.markets.length + ' markets');

  // Find the match winner market (exclude toss/completed match)
  var winnerMkt = null;
  for (var mi = 0; mi < ev.markets.length; mi++) {
    var m = ev.markets[mi];
    try {
      var q = (m.question || '').toLowerCase();
      var outcomes = JSON.parse(m.outcomes || '[]');
      if (outcomes.indexOf('Ireland') >= 0 && outcomes.indexOf('India') >= 0 && q.indexOf('toss') < 0 && q.indexOf('completed match') < 0) {
        winnerMkt = m;
        break;
      }
    } catch (_) {}
  }
  if (!winnerMkt) winnerMkt = ev.markets[0];

  log('Selected market: ' + (winnerMkt ? winnerMkt.id + ' - ' + (winnerMkt.question || '?') : 'NONE'));
  if (!winnerMkt) { log('No suitable market found'); return; }

  var ids;
  try { ids = JSON.parse(winnerMkt.clobTokenIds); } catch (_) { log('No token IDs in market'); return; }
  if (!Array.isArray(ids) || ids.length < 2) { log('Need 2+ token IDs, got ' + (ids ? ids.length : 0)); return; }

  var outcomes = JSON.parse(winnerMkt.outcomes || '[]');
  var irelandIdx = outcomes.indexOf('Ireland');
  var indiaIdx = outcomes.indexOf('India');
  if (irelandIdx < 0 || indiaIdx < 0) {
    log('Cannot map outcomes to Ireland/India — outcomes: ' + outcomes.join(','));
    return;
  }

  var irelandTokenId = ids[irelandIdx];
  var indiaTokenId = ids[indiaIdx];

  // Get prices from outcomePrices
  var prices = JSON.parse(winnerMkt.outcomePrices || '[]');
  var irelandPrice = parseFloat(prices[irelandIdx] || '0');
  var indiaPrice = parseFloat(prices[indiaIdx] || '0');

  // Try to get fresher prices from CLOB midpoint
  var [irR, iaR] = await Promise.all([
    getJSON(CLOB + '/midpoint?token_id=' + irelandTokenId),
    getJSON(CLOB + '/midpoint?token_id=' + indiaTokenId),
  ]);
  if (irR && irR.mid) irelandPrice = parseFloat(irR.mid);
  if (iaR && iaR.mid) indiaPrice = parseFloat(iaR.mid);

  var endDate = new Date(winnerMkt.endDate || ev.endDate || Date.now() + 86400000).getTime();

  mkt = {
    slug: MARKET_SLUG,
    eventId: ev.id,
    marketId: winnerMkt.id,
    irelandTokenId: irelandTokenId,
    indiaTokenId: indiaTokenId,
    irelandPrice: f4(irelandPrice),
    indiaPrice: f4(indiaPrice),
    endDate: endDate,
    question: winnerMkt.question || 'Ireland vs India',
    outcomes: outcomes,
    lastRefresh: Date.now(),
  };

  log('Market loaded: ' + mkt.question);
  log('Ireland: $' + f4(mkt.irelandPrice) + '  India: $' + f4(mkt.indiaPrice));
  log('Ends: ' + new Date(endDate).toISOString());

  mktReady = true;

  position = null;
  entryPrice = 0;
  sharesHeld = 0;
  trailHigh = mkt.irelandPrice;
  stopPeak = 0;
  stopTrough = 0;
  flipCount = 0;
  pendingFlip = null;
  inTrade = false;

  log('State reset — trailing Ireland entry at $' + f4(mkt.irelandPrice));
}

async function refreshPrices() {
  if (!mktReady || !mkt) return;
  var [ir, ia] = await Promise.all([
    getJSON(CLOB + '/midpoint?token_id=' + mkt.irelandTokenId),
    getJSON(CLOB + '/midpoint?token_id=' + mkt.indiaTokenId),
  ]);
  if (ir && ir.mid) mkt.irelandPrice = f4(parseFloat(ir.mid));
  if (ia && ia.mid) mkt.indiaPrice = f4(parseFloat(ia.mid));
  mkt.lastRefresh = Date.now();
}

async function ensureFreshPrices() {
  if (!mkt || !mkt.lastRefresh || Date.now() - mkt.lastRefresh > 3000) await refreshPrices();
}

// Trading functions
async function checkBalance() {
  if (!trader) return 0;
  try {
    var b = await trader.getBalance();
    if (b > 0) cashBalance = b;
    return cashBalance;
  } catch (_) { return cashBalance; }
}

async function buyIreland() {
  if (!mktReady || inTrade) return null;
  inTrade = true;
  try {
    var cost = f2(BASE_SHARES * mkt.irelandPrice);
    var preBal = await checkBalance();
    log('BUY Ireland ' + BASE_SHARES + 'sh @ $' + f4(mkt.irelandPrice) + ' (~$' + cost + ') bal=$' + f2(preBal));

    await trader.placeFokBuy(mkt.irelandTokenId, cost);

    // ALWAYS verify via balance change, not API response
    await sleep(CONFIRM_MS);
    var postBal = await checkBalance();
    var spent = f2(preBal - postBal);

    if (spent >= cost * 0.3) {
      log('Ireland filled - spent $' + spent);
      position = 'ireland';
      entryPrice = mkt.irelandPrice;
      sharesHeld = BASE_SHARES;
      stopPeak = entryPrice;
      logTrade('BUY', 'IRELAND', entryPrice);
      inTrade = false;
      return { filled: true, price: entryPrice };
    } else {
      log('Ireland NOT filled (spent $' + spent + ' vs expected $' + cost + ') - retry in 4s');
      await sleep(RETRY_MS);
      inTrade = false;
      return null;
    }
  } catch (e) {
    log('Buy Ireland error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    return null;
  }
}
async function buyIndia() {
  if (!mktReady || inTrade) return null;
  inTrade = true;
  try {
    var cost = f2(BASE_SHARES * mkt.indiaPrice);
    var preBal = await checkBalance();
    log('BUY India ' + BASE_SHARES + 'sh @ $' + f4(mkt.indiaPrice) + ' (~$' + cost + ') bal=$' + f2(preBal));

    await trader.placeFokBuy(mkt.indiaTokenId, cost);

    await sleep(CONFIRM_MS);
    var postBal = await checkBalance();
    var spent = f2(preBal - postBal);

    if (spent >= cost * 0.3) {
      log('India filled - spent $' + spent);
      position = 'india';
      entryPrice = mkt.indiaPrice;
      sharesHeld = BASE_SHARES;
      stopTrough = entryPrice;
      logTrade('BUY', 'INDIA', entryPrice);
      inTrade = false;
      return { filled: true, price: entryPrice };
    } else {
      log('India NOT filled (spent $' + spent + ' vs expected $' + cost + ') - retry in 4s');
      await sleep(RETRY_MS);
      inTrade = false;
      return null;
    }
  } catch (e) {
    log('Buy India error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    return null;
  }
}async function sellIreland(andFlipTo) {
  if (!mktReady || inTrade || !position) return null;
  inTrade = true;
  try {
    var mid = mkt.irelandPrice;
    var preBal = await checkBalance();
    var pnl = f2((mid - entryPrice) * BASE_SHARES);
    log('SELL Ireland ' + BASE_SHARES + 'sh @ $' + f4(mid) + ' PnL: ' + (pnl >= 0 ? '+' : '') + '$' + pnl + ' bal=$' + f2(preBal));

    await trader.placeFokSell(mkt.irelandTokenId, BASE_SHARES);

    await sleep(CONFIRM_MS);
    var postBal = await checkBalance();
    var gained = f2(postBal - preBal);

    if (gained > 0.01) {
      log('Ireland sold - PnL ' + (pnl >= 0 ? '+' : '') + '$' + pnl + ' bal $' + f2(preBal) + ' -> $' + f2(postBal));
      logTrade('SELL', 'IRELAND', mid, pnl);
      position = null;
      sharesHeld = 0;
      entryPrice = 0;
      flipCount++;
      inTrade = false;
      if (andFlipTo === 'india') {
        return await buyIndia();
      }
      return { filled: true, price: mid, pnl: pnl };
    } else {
      log('Ireland NOT sold (bal change $' + f2(gained) + ') - retry in 4s');
      await sleep(RETRY_MS);
      inTrade = false;
      return null;
    }
  } catch (e) {
    log('Sell Ireland error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    return null;
  }
}async function sellIndia(andFlipTo) {
  if (!mktReady || inTrade || !position) return null;
  inTrade = true;
  try {
    var mid = mkt.indiaPrice;
    var preBal = await checkBalance();
    var pnl = f2((entryPrice - mid) * BASE_SHARES);
    log('SELL India ' + BASE_SHARES + 'sh @ $' + f4(mid) + ' PnL: ' + (pnl >= 0 ? '+' : '') + '$' + pnl + ' bal=$' + f2(preBal));

    await trader.placeFokSell(mkt.indiaTokenId, BASE_SHARES);

    await sleep(CONFIRM_MS);
    var postBal = await checkBalance();
    var gained = f2(postBal - preBal);

    if (gained > 0.01) {
      log('India sold - PnL ' + (pnl >= 0 ? '+' : '') + '$' + pnl + ' bal $' + f2(preBal) + ' -> $' + f2(postBal));
      logTrade('SELL', 'INDIA', mid, pnl);
      position = null;
      sharesHeld = 0;
      entryPrice = 0;
      flipCount++;
      inTrade = false;
      if (andFlipTo === 'ireland') {
        return await buyIreland();
      }
      return { filled: true, price: mid, pnl: pnl };
    } else {
      log('India NOT sold (bal change $' + f2(gained) + ') - retry in 4s');
      await sleep(RETRY_MS);
      inTrade = false;
      return null;
    }
  } catch (e) {
    log('Sell India error: ' + (e.message || '').slice(0, 80));
    inTrade = false;
    return null;
  }
}async function tradeLoop() {
  if (tradeLoopRunning) return;
  tradeLoopRunning = true;

  while (mktReady && Date.now() < mkt.endDate) {
    await ensureFreshPrices();

    var ire = mkt.irelandPrice;
    var ind = mkt.indiaPrice;

    if (ire <= 0 || ind <= 0) {
      await sleep(TICK_MS);
      continue;
    }

    // Update trailing values
    if (position === 'ireland') {
      if (ire > stopPeak) stopPeak = ire;
    } else if (position === 'india') {
      if (ind < stopTrough || stopTrough === 0) stopTrough = ind;
    } else {
      if (ire > trailHigh) trailHigh = ire;
    }

    // No position — wait for entry
    if (!position && !inTrade && !pendingFlip) {
      var drop = f4(trailHigh - ire);
      if (drop >= TRAIL_DIST) {
        log('Ireland dropped $' + f4(drop) + ' from peak $' + f4(trailHigh) + ' — entering');
        await buyIreland();
      }
    }

    // Holding Ireland — trailing stop
    if (position === 'ireland' && !inTrade && !pendingFlip) {
      var drop = f4(stopPeak - ire);
      if (drop >= TRAIL_DIST) {
        log('Ireland trailing: dropped $' + f4(drop) + ' from peak $' + f4(stopPeak) + ' — sell & flip');
        await sellIreland('india');
      }
    }

    // Holding India — trailing stop
    if (position === 'india' && !inTrade && !pendingFlip) {
      var rise = f4(ind - stopTrough);
      if (rise >= TRAIL_DIST) {
        log('India trailing: rose $' + f4(rise) + ' from trough $' + f4(stopTrough) + ' — sell & flip');
        await sellIndia('ireland');
      }
    }

    // Retry failed flips
    if (pendingFlip && !inTrade) {
      if (pendingFlip === 'to_india' && !position) await buyIndia();
      else if (pendingFlip === 'to_ireland' && !position) await buyIreland();
      else if (position) pendingFlip = null;
    }

    await sleep(TICK_MS);
  }

  log('Market ended or loop finished');
  tradeLoopRunning = false;
  mktReady = false;
}

// Snapshot
function snapshot() {
  var equity = cashBalance;
  var pnl = f2(equity - startBalance);
  var irePrice = mkt ? mkt.irelandPrice : 0;
  var indPrice = mkt ? mkt.indiaPrice : 0;

  var posValue = 0;
  var posPnl = 0;
  if (position === 'ireland' && sharesHeld > 0) {
    posValue = f2(sharesHeld * irePrice);
    posPnl = f2((irePrice - entryPrice) * sharesHeld);
  } else if (position === 'india' && sharesHeld > 0) {
    posValue = f2(sharesHeld * indPrice);
    posPnl = f2((entryPrice - indPrice) * sharesHeld);
  }

  var stopLevel = 0;
  var stopDist = 0;
  if (position === 'ireland') {
    stopLevel = f4(stopPeak - TRAIL_DIST);
    stopDist = f4(stopPeak - irePrice);
  } else if (position === 'india') {
    stopLevel = f4(stopTrough + TRAIL_DIST);
    stopDist = f4(indPrice - stopTrough);
  }

  var activeMarkets = [];
  if (mktReady) {
    activeMarkets.push({
      slug: MARKET_SLUG,
      pair: 'Ireland vs India',
      upMid: f4(irePrice),
      dnMid: f4(indPrice),
      phase: (mktReady && Date.now() < mkt.endDate) ? 'trading' : 'ended',
      position: position,
      entryPrice: f4(entryPrice),
      sharesHeld: sharesHeld,
      stopLevel: f4(stopLevel),
      stopDist: f4(stopDist),
      posValue: f2(posValue),
      posPnl: f2(posPnl),
      flipCount: flipCount,
      timeLeft: Math.max(0, Math.floor((mkt.endDate - Date.now()) / 1000)),
      question: mkt.question,
    });
  }

  return {
    dryRun: dryRun,
    balance: f2(equity),
    cashBalance: f2(cashBalance),
    startBalance: f2(startBalance),
    pnl: pnl,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeMarkets: activeMarkets,
    recentTrades: trades.slice(0, 100),
    activityLog: logs.slice(0, 50),
    strategy: {
      type: 'cricket_flip',
      shares: BASE_SHARES,
      trailDist: TRAIL_DIST,
      market: MARKET_SLUG,
    },
  };
}

// Start
async function start(emit, logFn) {
  emitFn = emit || function() {};
  slog = logFn || function() {};
  startTime = Date.now();

  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    console.error('No private key');
    process.exit(1);
  }

  try {
    trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY);
    trader.setLogFn(log);
    log('Authenticating...');
    await trader.authenticate();
    log('Auth: ' + trader.address);
    var b = await trader.getBalance();
    if (b > 0) { cashBalance = b; startBalance = b; }
    log('Balance: $' + f2(cashBalance));
  } catch (e) {
    log('Auth fail: ' + (e.message || ''));
    process.exit(1);
  }

  // Discover market
  while (!mktReady) {
    await discoverCricketMarket();
    if (!mktReady) await sleep(5000);
  }

  log('Starting cricket trading loop');
  trailHigh = mkt.irelandPrice;
  tradeLoop().catch(function(e) { log('Loop error: ' + (e.message || '')); });

  setInterval(function() {
    emitFn('snapshot', snapshot());
  }, TICK_MS);
}

async function setDryRun(v) {
  dryRun = !!v;
}
function getDryRun() { return dryRun; }

module.exports = { start: start, snapshot: snapshot, setDryRun: setDryRun, getDryRun: getDryRun };
