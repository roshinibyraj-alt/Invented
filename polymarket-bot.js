'use strict';

// ── Dip-Buying Bot for Polymarket BTC/ETH/SOL 5m ──────────────────────────
// If UP price drops 0.10 in 3 ticks → buy $100 UP, sell after 3 ticks.
// If DOWN price drops 0.10 in 3 ticks → buy $100 DOWN, sell after 3 ticks.
// Mirror for both sides.

const PolymarketTrader = require('./polymarket-trader');

const GAMMA    = 'https://gamma-api.polymarket.com';
const CLOB     = 'https://clob.polymarket.com';

const TICK_MS           = 100;
const DISCOVER_EVERY    = 300;  // ticks between market discovery
const PRICE_FETCH_EVERY = 1;    // fetch price every tick (super fast)

const DIP_THRESHOLD     = 0.05;
const PRICE_HISTORY_LEN = 40;
const BUY_AMOUNT        = 100;  // $100 per dip
const TAKER_FEE         = 0.003; // 30 bps Polymarket taker fee
const SELL_AFTER_TICKS  = 40;

const DEMO_BALANCE      = 2000;
const WINDOW_SECS       = 300;  // 5 minutes
let DRY_RUN             = true;
const KILL_SWITCH       = process.env.KILL_SWITCH === 'true';

const TARGET_PAIRS = ['BTC', 'ETH', 'SOL'];

const fl2 = v => Math.round((v || 0) * 100) / 100;
const fl4 = v => Math.round((v || 0) * 10_000) / 10_000;

async function getJson(url) {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 8000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return r.json();
  } catch (_) { return null; }
}

function generateSlugs() {
  const now = Math.floor(Date.now() / 1000);
  const cur = Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
  const slugs = [];
  for (const pair of TARGET_PAIRS) {
    const prefix = pair.toLowerCase() + '-updown-5m-';
    for (const d of [0, 1, 2]) {
      slugs.push(prefix + (cur + d * WINDOW_SECS));
    }
  }
  return slugs;
}

// ── State ──
let trader        = null;
let balance       = DEMO_BALANCE;
let startBalance  = DEMO_BALANCE;
let totalFees     = 0;
let marketCache   = {};   // slug → market object
let dipState      = {};   // slug:side → { prices:[], bought:false, buyTick:-1, entryPrice:0, shares:0, sellTick:-1 }
let pendingRes    = [];
let recentTrades  = [];
let activityLog   = [];
let tickCount     = 0;
let startTime     = Date.now();
let nextFreshWindow = 0;
let emitFn        = () => {};
let logFn         = () => {};

function slog(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  activityLog.unshift(`[${ts}] ${msg}`);
  if (activityLog.length > 200) activityLog.length = 200;
  logFn(msg);
}

function pushTrade(pair, side, action, entry, exit, shares, pnl, bal) {
  recentTrades.unshift({
    ts: new Date().toTimeString().slice(0, 8),
    pair, side, action,
    entry: fl4(entry),
    exit: fl4(exit || 0),
    shares,
    pnl: fl2(pnl || 0),
    bal: fl2(bal),
  });
  if (recentTrades.length > 100) recentTrades.length = 100;
}

function getDipKey(m, side) { return m.slug + ':' + side; }

function initDipState(m, side) {
  const key = getDipKey(m, side);
  if (!dipState[key]) {
    dipState[key] = { prices: [], bought: false, buyTick: -1, entryPrice: 0, shares: 0, sellTick: -1 };
  }
  return dipState[key];
}

// ── Market discovery ──
async function discoverMarkets() {
  const slugs = generateSlugs();
  await Promise.allSettled(slugs.map(async slug => {
    if (marketCache[slug]) return;
    const d = await getJson(`${GAMMA}/events?slug=${slug}`);
    if (!Array.isArray(d) || !d[0]?.markets?.[0]) return;
    const mk = d[0].markets[0];
    if (!mk.clobTokenIds) return;
    let ids;
    try { ids = JSON.parse(mk.clobTokenIds); } catch (_) { return; }
    if (ids.length < 2) return;
    const endTime = mk.endDate ? new Date(mk.endDate).getTime() : null;
    if (!endTime) return;
    marketCache[slug] = {
      slug, pair: slug.startsWith('btc') ? 'BTC' : slug.startsWith('eth') ? 'ETH' : 'SOL',
      windowS: WINDOW_SECS,
      upTokenId: ids[0], downTokenId: ids[1],
      endTime, active: false, resolved: false, hasClob: false,
      upMid: 0, downMid: 0,
      secondsToEnd: Math.floor((endTime - Date.now()) / 1000),
    };
  }));
  // Clean stale markets
  const expired = [];
  for (const [slug, m] of Object.entries(marketCache)) {
    if (Date.now() - m.endTime > 10000) expired.push(slug);
  }
  for (const slug of expired) {
    delete marketCache[slug];
    for (const key of Object.keys(dipState)) {
      if (key.startsWith(slug)) delete dipState[key];
    }
  }
}

// ── Tick ──
async function updateMarket(m) {
  const now = Date.now();
  m.secondsToEnd = Math.floor((m.endTime - now) / 1000);
  m.active = !m.resolved && m.secondsToEnd > 0 && m.secondsToEnd <= m.windowS;

  if (m.secondsToEnd < -5 && !m.resolved) {
    m.resolved = true;
    m.active = false;
    return;
  }
  if (!m.active) return;

  // Fetch prices
  const [upR, dnR] = await Promise.all([
    getJson(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
    getJson(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
  ]);
  if (upR?.mid) m.upMid   = fl4(parseFloat(upR.mid));
  if (dnR?.mid) m.downMid = fl4(parseFloat(dnR.mid));

  // Process each side independently and concurrently for speed
  await Promise.all([
    m.upMid > 0   ? processSide(m, 'up') : Promise.resolve(),
    m.downMid > 0 ? processSide(m, 'dn') : Promise.resolve(),
  ]);
}

async function processSide(m, side) {
  if (KILL_SWITCH) return;

  const mid = side === 'up' ? m.upMid : m.downMid;
  if (!mid) return;

  const key = getDipKey(m, side);
  const st  = initDipState(m, side);

  // Update price history (keep last N)
  st.prices.push(mid);
  if (st.prices.length > PRICE_HISTORY_LEN + 1) st.prices.shift();

  // Skip until we have enough data
  if (st.prices.length < PRICE_HISTORY_LEN + 1) return;

  // ── BUY logic: price dropped 0.10 in last 3 ticks ──
  if (!st.bought) {
    const recent = st.prices.slice(-PRICE_HISTORY_LEN); // last N prices
    const highest = Math.max(...recent);
    if (highest - mid >= DIP_THRESHOLD) {
      const shares = Math.floor(BUY_AMOUNT / mid);
      if (shares < 1) return;

      const cost = fl2(shares * mid);
      if (balance < cost) return;

      const buyFeeAmt = fl2(cost * TAKER_FEE);
      balance = fl2(balance - cost - buyFeeAmt);
      totalFees = fl4(totalFees + buyFeeAmt);
      st.bought = true;
      st.buyTick = tickCount;
      st.entryPrice = mid;
      st.shares = shares;

      slog(`📥 BUY ${m.pair} ${side.toUpperCase()} @ ${fl4(mid)} x ${shares}sh (-$${cost}) | bal:$${fl2(balance)}`);

      // Place real order on CLOB
      const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
      if (tokenId && !DRY_RUN) {
        try {
          const res = await trader.placeOrder(tokenId, 'BUY', mid, shares);
          if (res?.id) slog(`🔏 BUY ORDER id:${res.id}`);
        } catch (e) {
          slog(`❌ BUY failed: ${e.message}`);
          balance = fl2(balance + cost);
          st.bought = false;
          st.shares = 0;
        }
      }
    }
  }

  // ── SELL logic: after 3 ticks ──
  if (st.bought && tickCount - st.buyTick >= SELL_AFTER_TICKS) {
    const proceeds = fl2(st.shares * mid);
    const cost     = fl2(st.shares * st.entryPrice);
    const pnl      = fl2(proceeds - cost);

    const sellFee = fl2(proceeds * TAKER_FEE);
    totalFees = fl4(totalFees + sellFee);
    balance = fl2(balance + proceeds - sellFee);
    const buyFeeAmt2 = fl2(st.shares * st.entryPrice * TAKER_FEE);
    const netPnl = fl2(pnl - buyFeeAmt2 - sellFee);
    slog(`📤 SELL ${m.pair} ${side.toUpperCase()} @ $${fl4(mid)} x ${st.shares}sh (+$${fl2(proceeds)}) fee:$${fl2(buyFeeAmt2 + sellFee)} pnl:$${fl2(netPnl)} | bal:$${fl2(balance)}`);
    pushTrade(m.pair, side.toUpperCase(), 'SELL', st.entryPrice, mid, st.shares, pnl, balance);

    // Place real sell on CLOB
    const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
    if (tokenId && !DRY_RUN) {
      try {
        const res = await trader.placeOrder(tokenId, 'SELL', mid, st.shares);
        if (res?.id) slog(`🔏 SELL ORDER id:${res.id}`);
      } catch (e) {
        slog(`❌ SELL failed: ${e.message}`);
      }
    }

    // Reset
    st.bought = false;
    st.buyTick = -1;
    st.entryPrice = 0;
    st.shares = 0;
    st.sellTick = tickCount;
  }
}

// ── Main tick ──
async function tick() {
  try {
    tickCount++;
    if (tickCount === 1 || tickCount % DISCOVER_EVERY === 0) {
      await discoverMarkets();
    }
    const fetchPrice = (tickCount % PRICE_FETCH_EVERY === 0);
    if (fetchPrice) {
      await Promise.allSettled(Object.values(marketCache).map(m => updateMarket(m)));
    }
    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    slog(`⚠️ tick: ${e.message}`);
  }
}

// ── Snapshot ──
function buildSnapshot() {
  const openPositions = [];
  let openValue = 0;
  for (const [key, st] of Object.entries(dipState)) {
    if (!st.bought) continue;
    const [slug, side] = key.split(':');
    const m = marketCache[slug];
    const mid = m ? (side === 'up' ? m.upMid : m.downMid) : 0;
    const currentVal = fl2(st.shares * mid);
    openValue += currentVal;
    openPositions.push({
      pair: m ? m.pair : slug,
      side: side.toUpperCase(),
      entryPrice: fl4(st.entryPrice),
      currentPrice: fl4(mid),
      shares: st.shares,
      cost: fl2(st.shares * st.entryPrice),
      currentValue: currentVal,
      unrealizedPnl: fl2(currentVal - (st.shares * st.entryPrice)),
      ticksHeld: tickCount - st.buyTick,
      time: new Date().toTimeString().slice(0, 8),
    });
  }

  const activeMkts = Object.values(marketCache).filter(m => m.active);

  return {
    dryRun: DRY_RUN,
    balance: fl2(balance),
    openEquity: fl2(balance + openValue),
    startBalance: fl2(startBalance),
    pnl: fl2((balance + openValue) - startBalance),
    totalFees: fl4(totalFees),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    tickCount,
    activeMarkets: activeMkts.length,
    dipThreshold: DIP_THRESHOLD,
    buyAmount: BUY_AMOUNT,
    sellAfterTicks: SELL_AFTER_TICKS,
    targetPairs: TARGET_PAIRS,
    openPositions,
    recentTrades: recentTrades.slice(0, 40),
    activityLog: activityLog.slice(0, 60),
    allMarkets: activeMkts.map(m => ({
      label: `${m.pair} 5m`,
      secondsToEnd: m.secondsToEnd,
      upMid: fl4(m.upMid),
      dnMid: fl4(m.downMid),
      active: m.active,
    })),
  };
}

// ── Start ──
async function start(emit, log) {
  emitFn = emit || (() => {});
  logFn  = log  || (() => {});
  startTime = Date.now();
  balance = DEMO_BALANCE;
  startBalance = DEMO_BALANCE;
  totalFees = 0;

  slog(`🤖 Dip-Buying Bot v1 | Pairs:${TARGET_PAIRS.join(',')} | Dip:${DIP_THRESHOLD} | Buy:$${BUY_AMOUNT} | Hold:${SELL_AFTER_TICKS}ticks`);

  if (!DRY_RUN) {
    try {
      trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
      trader.setLogFn(logFn);
      slog('🔑 Authenticating...');
      const authResult = await trader.authenticate();
      if (!authResult) throw new Error('auth returned empty');
      slog(`✅ Authenticated: ${trader.address}`);
    } catch (e) {
      slog(`❌ Auth failed: ${e.message}`);
      process.exit(1);
    }
  }

  if (DRY_RUN) slog('📋 PAUSED — toggle LIVE to start trading');
  else slog('🔴 LIVE — real Polymarket orders');

  setInterval(tick, TICK_MS);
}

function flushState() {
  dipState = {};
  recentTrades = [];
  activityLog = [];
  marketCache = {};
  tickCount = 0;
  startTime = Date.now();
  balance = DEMO_BALANCE;
  totalFees = 0;
}

async function setDryRun(val) {
  const wasDryRun = DRY_RUN;
  DRY_RUN = !!val;
  flushState();

  // Initialize trader when switching from PAUSED to LIVE
  if (wasDryRun && !DRY_RUN && !trader) {
    try {
      trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
      trader.setLogFn(logFn);
      slog('🔑 Authenticating...');
      const authResult = await trader.authenticate();
      if (!authResult) throw new Error('auth returned empty');
      slog('✅ Authenticated: ' + trader.address);
    } catch (e) {
      slog('❌ Auth failed: ' + e.message);
      DRY_RUN = true;
      slog('↩️ Reverted to PAUSED — auth failed');
    }
  }

  if (DRY_RUN) {
    slog('📋 PAUSED — monitoring only');
  } else {
    slog('🔴 LIVE — real Polymarket orders');
  }
}

function getDryRun() { return DRY_RUN; }

module.exports = { start, buildSnapshot, setDryRun, getDryRun };
