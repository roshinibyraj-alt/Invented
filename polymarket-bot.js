'use strict';

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS       = 1000;
const TRAIL_DIST    = 0.05;
const BASE_SHARES   = 30;
const CONFIRM_MS    = 2000;
const MARKET_SLUG   = 'crint-irl4-ind4-2026-06-28';

// After determining the actual outcome names from the API:
// Sport event markets have outcomes like ["Ireland", "India"]
// Token_ID[0] = Ireland, Token_ID[1] = India
const SIDE_IRELAND = 'ireland';  // "UP" analog
const SIDE_INDIA   = 'india';    // "DOWN" analog

let dryRun = false; // real trading only
let emitFn = () => {};
let slog   = () => {};
let trader = null;

let cashBalance  = 0;
let startBalance = 0;
let startTime    = Date.now();

const logs   = [];
const trades = [];

// Single market data
let mkt = null;
let mktReady = false;

// Position state
let position    = null; // 'ireland' | 'india' | null
let entryPrice  = 0;
let sharesHeld  = 0;
let trailHigh   = 0; // for entry: peak of ireland price when no position
let trailLow    = 0; // for entry: trough of... not used, we only trail ireland for first entry
let stopPeak    = 0; // for position: highest price since entry (used for trailing stop)
let stopTrough  = 0; // for position: lowest price since entry (used for trailing stop)
let lastBuyTs   = 0;
let lastSellTs  = 0;
let flipCount   = 0;
let pendingFlip = null; // 'to_ireland' | 'to_india' | null — we're in the middle of a flip
let inTrade     = false; // true while executing a trade to prevent concurrent orders
let pendingSellResult = null; // saved sell result while we wait to buy the other side

let tradeLoopRunning = false;

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts   = new Date().toTimeString().slice(0, 8);
  const line = `[${ts}] [CRICKET] ${msg}`;
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
    const t  = setTimeout(() => ac.abort(), 10000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? r.json() : null;
  } catch (_) { return null; }
}

// ── Market discovery ──
async function discoverCricketMarket() {
  if (mktReady) return;
  log(`Looking up market: ${MARKET_SLUG}`);
  const d = await getJSON(`${GAMMA}/events?slug=${MARKET_SLUG}`);
  if (!Array.isArray(d) || !d[0]?.markets?.length) {
    log('Market not found yet, retrying...');
    return;
  }

  // Find the match winner market (not the "Super Over" sub-market)
  const ev = d[0];
  const winnerMkt = ev.markets.find(m => {
    try {
      const outcomes = JSON.parse(m.outcomes || '[]');
      return outcomes.includes('Ireland') && outcomes.includes('India');
    } catch (_) { return false; }
  }) || ev.markets[0]; // fallback to first market

  if (!winnerMkt) { log('No suitable market found'); return; }

  let ids;
  try { ids = JSON.parse(winnerMkt.clobTokenIds); } catch (_) { log('No token IDs'); return; }
  if (ids.length < 2) { log('Need 2 tokens'); return; }

  const outcomes = JSON.parse(winnerMkt.outcomes || '[]');
  // Determine which token is Ireland and which is India
  // Typically token[0] = first outcome, token[1] = second outcome
  const irelandIdx = outcomes.indexOf('Ireland');
  const indiaIdx   = outcomes.indexOf('India');
  if (irelandIdx < 0 || indiaIdx < 0) { log('Cannot map outcomes'); return; }

  const irelandTokenId = ids[irelandIdx];
  const indiaTokenId   = ids[indiaIdx];

  // Get prices
  const prices = JSON.parse(winnerMkt.outcomePrices || '[]');
  const irelandPrice = parseFloat(prices[irelandIdx] || '0');
  const indiaPrice   = parseFloat(prices[indiaIdx] || '0');

  const endDate = new Date(winnerMkt.endDate || ev.endDate || Date.now() + 86400000).getTime();
  const startDate = new Date(winnerMkt.gameStartTime || winnerMkt.startDate || Date.now()).getTime();

  mkt = {
    slug: MARKET_SLUG,
    eventId: ev.id,
    marketId: winnerMkt.id,
    irelandTokenId,
    indiaTokenId,
    irelandPrice: f4(irelandPrice),
    indiaPrice: f4(indiaPrice),
    endDate,
    startDate,
    question: winnerMkt.question || 'Ireland vs India',
    outcomes,
    lastRefresh: Date.now(),
  };

  log(`Market: ${mkt.question}`);
  log(`Ireland: $${f4(mkt.irelandPrice)} (token: ${irelandTokenId.slice(0, 16)}…)`);
  log(`India: $${f4(mkt.indiaPrice)} (token: ${indiaTokenId.slice(0, 16)}…)`);
  log(`Ends: ${new Date(endDate).toISOString()}`);

  mktReady = true;

  // Reset state for new market
  position = null;
  entryPrice = 0;
  sharesHeld = 0;
  trailHigh = mkt.irelandPrice;
  stopPeak = 0;
  stopTrough = 0;
  flipCount = 0;
  pendingFlip = null;
  inTrade = false;
  pendingSellResult = null;

  log('State reset – trailing Ireland for initial entry');
}

async function refreshPrices() {
  if (!mktReady || !mkt) return;
  const [ir, ia] = await Promise.all([
    getJSON(`${CLOB}/midpoint?token_id=${mkt.irelandTokenId}`),
    getJSON(`${CLOB}/midpoint?token_id=${mkt.indiaTokenId}`),
  ]);
  if (ir?.mid) mkt.irelandPrice = f4(parseFloat(ir.mid));
  if (ia?.mid) mkt.indiaPrice   = f4(parseFloat(ia.mid));
  mkt.lastRefresh = Date.now();
}

async function ensureFreshPrices() {
  if (!mkt?.lastRefresh || Date.now() - mkt.lastRefresh > 3000) await refreshPrices();
}

// ── Trading functions ──
async function checkBalance() {
  if (!trader) return 0;
  try {
    const b = await trader.getBalance();
    if (b > 0) cashBalance = b;
    return cashBalance;
  } catch (_) { return cashBalance; }
}

async function buyIreland() {
  if (!mktReady || inTrade) return null;
  inTrade = true;
  try {
    const cost = f2(BASE_SHARES * mkt.irelandPrice);
    const preBal = await checkBalance();
    log(`BUY Ireland ${BASE_SHARES}sh @ $${f4(mkt.irelandPrice)} (≈$${cost})`);

    const result = await trader.placeFokBuy(mkt.irelandTokenId, cost);
    if (!result) { inTrade = false; return null; }

    if (result.isFilled) {
      await sleep(CONFIRM_MS);
      const postBal = await checkBalance();
      const spent = f2(preBal - postBal);
      log(`✅ Bought Ireland – spent ~$${spent}`);
      position = 'ireland';
      entryPrice = result.avgPrice || mkt.irelandPrice;
      sharesHeld = BASE_SHARES;
      stopPeak = entryPrice;
      lastBuyTs = Date.now();
      logTrade('BUY', 'IRELAND', entryPrice);
      inTrade = false;
      return { filled: true, price: entryPrice };
    } else {
      log(`FOK Ireland buy didn't fill – retrying next tick`);
      inTrade = false;
      return null;
    }
  } catch (e) {
    log(`Buy Ireland error: ${e.message.slice(0, 80)}`);
    inTrade = false;
    return null;
  }
}

async function buyIndia() {
  if (!mktReady || inTrade) return null;
  inTrade = true;
  try {
    const cost = f2(BASE_SHARES * mkt.indiaPrice);
    const preBal = await checkBalance();
    log(`BUY India ${BASE_SHARES}sh @ $${f4(mkt.indiaPrice)} (≈$${cost})`);

    const result = await trader.placeFokBuy(mkt.indiaTokenId, cost);
    if (!result) { inTrade = false; return null; }

    if (result.isFilled) {
      await sleep(CONFIRM_MS);
      const postBal = await checkBalance();
      log(`✅ Bought India – balance change: $${f2(preBal)}→$${f2(postBal)}`);
      position = 'india';
      entryPrice = result.avgPrice || mkt.indiaPrice;
      sharesHeld = BASE_SHARES;
      stopTrough = entryPrice;
      lastBuyTs = Date.now();
      logTrade('BUY', 'INDIA', entryPrice);
      inTrade = false;
      return { filled: true, price: entryPrice };
    } else {
      log(`FOK India buy didn't fill – retrying next tick`);
      inTrade = false;
      return null;
    }
  } catch (e) {
    log(`Buy India error: ${e.message.slice(0, 80)}`);
    inTrade = false;
    return null;
  }
}

async function sellIreland(andFlipTo) {
  // andFlipTo: 'india' — after selling ireland, buy india
  if (!mktReady || inTrade || !position) return null;
  inTrade = true;
  try {
    const mid = mkt.irelandPrice;
    const proceeds = f2(BASE_SHARES * mid);
    const preBal = await checkBalance();
    const pnl = f2((mid - entryPrice) * BASE_SHARES);
    log(`SELL Ireland ${BASE_SHARES}sh @ $${f4(mid)} PnL: $${pnl >= 0 ? '+' : ''}${pnl}`);

    const result = await trader.placeFokSell(mkt.irelandTokenId, BASE_SHARES);
    if (!result) { inTrade = false; return null; }

    if (result.isFilled) {
      await sleep(CONFIRM_MS);
      await checkBalance();
      log(`✅ Sold Ireland – PnL $${pnl >= 0 ? '+' : ''}${pnl}`);
      logTrade('SELL', 'IRELAND', mid, pnl);
      position = null;
      sharesHeld = 0;
      entryPrice = 0;
      lastSellTs = Date.now();
      flipCount++;

      if (andFlipTo === 'india') {
        // Immediately buy India
        inTrade = false;
        pendingFlip = null;
        return await flipToIndia();
      }
      inTrade = false;
      return { filled: true, price: mid, pnl };
    } else {
      log(`FOK Ireland sell didn't fill – retrying next tick`);
      inTrade = false;
      return null;
    }
  } catch (e) {
    log(`Sell Ireland error: ${e.message.slice(0, 80)}`);
    inTrade = false;
    return null;
  }
}

async function sellIndia(andFlipTo) {
  // andFlipTo: 'ireland' — after selling india, buy ireland
  if (!mktReady || inTrade || !position) return null;
  inTrade = true;
  try {
    const mid = mkt.indiaPrice;
    const pnl = f2((entryPrice - mid) * BASE_SHARES); // for india, we profit if price goes down
    const preBal = await checkBalance();
    log(`SELL India ${BASE_SHARES}sh @ $${f4(mid)} PnL: $${pnl >= 0 ? '+' : ''}${pnl}`);

    const result = await trader.placeFokSell(mkt.indiaTokenId, BASE_SHARES);
    if (!result) { inTrade = false; return null; }

    if (result.isFilled) {
      await sleep(CONFIRM_MS);
      await checkBalance();
      log(`✅ Sold India – PnL $${pnl >= 0 ? '+' : ''}${pnl}`);
      logTrade('SELL', 'INDIA', mid, pnl);
      position = null;
      sharesHeld = 0;
      entryPrice = 0;
      lastSellTs = Date.now();
      flipCount++;

      if (andFlipTo === 'ireland') {
        inTrade = false;
        pendingFlip = null;
        return await flipToIreland();
      }
      inTrade = false;
      return { filled: true, price: mid, pnl };
    } else {
      log(`FOK India sell didn't fill – retrying next tick`);
      inTrade = false;
      return null;
    }
  } catch (e) {
    log(`Sell India error: ${e.message.slice(0, 80)}`);
    inTrade = false;
    return null;
  }
}

async function flipToIndia() {
  if (inTrade) return null;
  // Called after selling Ireland
  pendingFlip = 'to_india';
  log('FLIP → BUY India');
  return await buyIndia();
}

async function flipToIreland() {
  if (inTrade) return null;
  // Called after selling India
  pendingFlip = 'to_ireland';
  log('FLIP → BUY Ireland');
  return await buyIreland();
}

// ── Main trade loop ──
async function tradeLoop() {
  if (tradeLoopRunning) return;
  tradeLoopRunning = true;

  while (mktReady && Date.now() < mkt.endDate) {
    await ensureFreshPrices();
    const ire = mkt.irelandPrice;
    const ind = mkt.indiaPrice;

    // Update trailing values
    if (position === 'ireland') {
      // Track highest Ireland price since entry
      if (ire > stopPeak) stopPeak = ire;
    } else if (position === 'india') {
      // Track lowest India price since entry (we profit when India goes down)
      if (ind < stopTrough || stopTrough === 0) stopTrough = ind;
    } else {
      // No position – track Ireland peak for entry
      if (ire > trailHigh) trailHigh = ire;
    }

    // ── STATE: No position, waiting for entry ──
    if (!position && !inTrade && !pendingFlip) {
      const drop = f4(trailHigh - ire);
      if (drop >= TRAIL_DIST && ire > 0) {
        log(`Ireland dropped $${f4(drop)} from peak $${f4(trailHigh)} → entering`);
        await buyIreland();
      } else if (ire > 0) {
        // Log occasionally
        if (Math.random() < 0.05) {
          // silent
        }
      }
    }

    // ── STATE: Holding Ireland ──
    if (position === 'ireland' && !inTrade && !pendingFlip) {
      const drop = f4(stopPeak - ire);
      if (drop >= TRAIL_DIST && ire > 0) {
        log(`Ireland trailing stop: dropped $${f4(drop)} from peak $${f4(stopPeak)} → sell & flip`);
        await sellIreland('india');
      }
    }

    // ── STATE: Holding India ──
    if (position === 'india' && !inTrade && !pendingFlip) {
      const rise = f4(ind - stopTrough);
      if (rise >= TRAIL_DIST && ind > 0) {
        log(`India trailing stop: rose $${f4(rise)} from trough $${f4(stopTrough)} → sell & flip`);
        await sellIndia('ireland');
      }
    }

    // ── Retry failed trades ──
    // If we're in a pending flip but not inTrade, retry the buy
    if (pendingFlip && !inTrade) {
      if (pendingFlip === 'to_india' && !position) {
        await buyIndia();
      } else if (pendingFlip === 'to_ireland' && !position) {
        await buyIreland();
      } else if (position) {
        // We somehow got a position while pending flip – clear it
        pendingFlip = null;
      }
    }

    await sleep(TICK_MS);
  }

  log(`Market ended or loop finished`);
  tradeLoopRunning = false;
  mktReady = false;
}

// ── Snapshot ──
function snapshot() {
  const equity = cashBalance;
  const pnl = f2(equity - startBalance);
  const irePrice = mkt?.irelandPrice || 0;
  const indPrice = mkt?.indiaPrice || 0;

  // For position value
  let posValue = 0;
  let posPnl = 0;
  if (position === 'ireland' && sharesHeld > 0) {
    posValue = f2(sharesHeld * irePrice);
    posPnl = f2((irePrice - entryPrice) * sharesHeld);
  } else if (position === 'india' && sharesHeld > 0) {
    posValue = f2(sharesHeld * indPrice);
    posPnl = f2((entryPrice - indPrice) * sharesHeld);
  }

  let stopLevel = 0;
  let stopDist = 0;
  if (position === 'ireland') {
    stopLevel = f4(stopPeak - TRAIL_DIST);
    stopDist = f4(stopPeak - irePrice);
  } else if (position === 'india') {
    stopLevel = f4(stopTrough + TRAIL_DIST);
    stopDist = f4(indPrice - stopTrough);
  }

  return {
    dryRun,
    balance: f2(equity),
    cashBalance: f2(cashBalance),
    startBalance: f2(startBalance),
    pnl,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeMarkets: mktReady ? [{
      slug: MARKET_SLUG,
      pair: 'Ireland vs India',
      upMid: f4(irePrice),      // ireland = "up"
      dnMid: f4(indPrice),      // india = "down"
      phase: mktReady && Date.now() < mkt.endDate ? 'trading' : 'ended',
      position,
      entryPrice: f4(entryPrice),
      sharesHeld,
      stopLevel: f4(stopLevel),
      stopDist: f4(stopDist),
      posValue: f2(posValue),
      posPnl: f2(posPnl),
      flipCount,
      timeLeft: Math.max(0, Math.floor((mkt.endDate - Date.now()) / 1000)),
      question: mkt?.question || '',
    }] : [],
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

// ── Start / Stop ──
async function start(emit, logFn) {
  emitFn = emit || (() => {});
  slog   = logFn || (() => {});
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
    log(`Auth: ${trader.address}`);
    const b = await trader.getBalance();
    if (b > 0) { cashBalance = b; startBalance = b; }
    log(`Balance: $${f2(cashBalance)}`);
  } catch (e) {
    log(`Auth fail: ${e.message}`);
    process.exit(1);
  }

  // Discover the cricket market
  while (!mktReady) {
    await discoverCricketMarket();
    if (!mktReady) await sleep(5000);
  }

  // Start the main loop
  log('Starting cricket trading loop');
  trailHigh = mkt.irelandPrice; // initialize trailing peak
  tradeLoop().catch(e => log(`Loop error: ${e.message}`));

  // Separate tick for snapshot updates
  setInterval(() => {
    emitFn('snapshot', snapshot());
  }, TICK_MS);
}

async function setDryRun(v) {
  dryRun = !!v;
}
function getDryRun() { return dryRun; }

module.exports = { start, snapshot, setDryRun, getDryRun };
