'use strict';

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS           = 100;
const DISCOVER_EVERY    = 300;
const PRICE_FETCH_EVERY = 5;
const WINDOW_SECS       = 300;
const DEMO_BALANCE      = 50;

const SHARES_PER_LOT     = 6;
const TRAILING_STOP_DIST = 0.05;
const FORCE_SELL_SECS    = 270;
const ENTRY_WAIT_SECS    = 10;
const MIN_HOLD_SECS      = 5;
const RETRY_COOLDOWN_MS  = 300;
const ORDER_TIMEOUT_MS   = 30000;

let DRY_RUN = false;
const TARGET_PAIRS = ['BTC', 'ETH'];

let emitFn = () => {};
let slog   = () => {};

let balance = 0;
let startBalance = 0;
let tickCount = 0;
let startTime = Date.now();
let trader    = null;

const markets = {};
const trades  = [];
const logs    = [];

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;

function log(msg) { logs.push(msg); if (logs.length > 200) logs.length = 200; if (slog) slog(msg); }

async function getJSON(url) {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 8000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? r.json() : null;
  } catch (_) { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function genSlugs() {
  const now = Math.floor(Date.now() / 1000);
  const cur = Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
  return TARGET_PAIRS.map(p => `${p.toLowerCase()}-updown-5m-${cur}`);
}

async function discover() {
  const slugs = genSlugs();
  await Promise.allSettled(slugs.map(async slug => {
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
    markets[slug] = {
      slug, pair: slug.startsWith('btc') ? 'BTC' : 'ETH',
      upTokenId: ids[0], downTokenId: ids[1],
      endTime, windowStart: endTime - WINDOW_SECS * 1000,
      active: false, resolved: false,
      upMid: 0, downMid: 0,
      phase: 'idle', side: 'up',
      entryLock: false, exitLock: false, retryAfter: 0,
      holdStartedAt: 0, entryPrice: 0, peakPrice: 0,
      pendingOrderId: null, pendingOrderAt: 0,
    };
  }));

  for (const [slug, m] of Object.entries(markets)) {
    if (m.resolved || Date.now() - m.endTime > 10000) {
      delete markets[slug];
    }
  }
}

async function updatePrices(m) {
  const now = Date.now();
  const secsToEnd = Math.floor((m.endTime - now) / 1000);
  m.active = !m.resolved && secsToEnd > 0 && secsToEnd <= WINDOW_SECS;
  if (secsToEnd < -5 && !m.resolved) { m.resolved = true; m.active = false; return; }
  if (!m.active) return;
  const [ur, dr] = await Promise.all([
    getJSON(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
    getJSON(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
  ]);
  if (ur?.mid) m.upMid   = f4(parseFloat(ur.mid));
  if (dr?.mid) m.downMid = f4(parseFloat(dr.mid));
}

function pickCheapestSide(m) {
  return m.upMid <= m.downMid ? 'up' : 'down';
}

async function doEntry(m) {
  const price = m.side === 'up' ? m.upMid : m.downMid;
  if (price <= 0.01) return false;

  if (DRY_RUN) {
    const cost = f2(SHARES_PER_LOT * price);
    balance = f2(balance - cost);
    m.entryPrice = price; m.peakPrice = price; m.holdStartedAt = Date.now();
    log(`🟢 ENTRY ${m.pair} ${m.side.toUpperCase()} ${SHARES_PER_LOT}sh@${f4(price)}`);
    trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: m.side.toUpperCase(), action: 'ENTRY', entry: price, shares: SHARES_PER_LOT, pnl: 0, bal: balance });
    if (trades.length > 100) trades.length = 100;
    return true;
  }

  const tid = m.side === 'up' ? m.upTokenId : m.downTokenId;
  try {
    // First: try FOK market order
    const dollarAmount = parseFloat(f2(SHARES_PER_LOT * price));
    if (dollarAmount <= 0) return false;
    const fok = await trader.placeFokOrder(tid, 'BUY', dollarAmount);
    if (fok.isFilled) {
      const fillPrice = fok.avgPrice > 0 ? fok.avgPrice : price;
      m.entryPrice = fillPrice; m.peakPrice = fillPrice; m.holdStartedAt = Date.now();
      log(`🟢 FOK ENTRY ${m.pair} ${m.side.toUpperCase()} ${SHARES_PER_LOT}sh@${f4(fillPrice)}`);
      trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: m.side.toUpperCase(), action: 'ENTRY', entry: fillPrice, shares: SHARES_PER_LOT, pnl: 0, bal: balance });
      if (trades.length > 100) trades.length = 100;
      return true;
    }

    // Fallback: GTC limit order at midpoint, poll for fill
    log(`📋 GTC ENTRY ${m.pair} ${m.side.toUpperCase()} ${SHARES_PER_LOT}sh@${f4(price)} (FOK nofill)`);
    const gtc = await trader.placeGtcOrder(tid, 'BUY', price, SHARES_PER_LOT);
    const orderId = gtc.id;
    if (!orderId) return false;

    // Poll for fill
    const deadline = Date.now() + ORDER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
          const order = await trader.getOrder(orderId);
        if (!order) continue;
        const status = order.status || '';
        const matchStatus = (order.match_status || '').toLowerCase();
        if (status === 'FILLED' || matchStatus === 'filled') {
          const fillPrice = parseFloat(order.avg_fill_price || order.price || price);
          m.entryPrice = fillPrice; m.peakPrice = fillPrice; m.holdStartedAt = Date.now();
          log(`🟢 GTC FILLED ${m.pair} ${m.side.toUpperCase()} @${f4(fillPrice)}`);
          trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: m.side.toUpperCase(), action: 'ENTRY', entry: fillPrice, shares: SHARES_PER_LOT, pnl: 0, bal: balance });
          if (trades.length > 100) trades.length = 100;
          return true;
        }
        if (status === 'CANCELLED' || matchStatus === 'cancelled') break;
      } catch (_) {}
    }
    // Timeout or cancelled - cancel the order
    try { await trader.cancelOrder(orderId); } catch (_) {}
    log(`⏰ GTC TIMEOUT ${m.pair} ${m.side.toUpperCase()}`);
    return false;
  } catch (e) {
    log(`❌ ENTRY ${m.pair}: ${e.message.slice(0,80)}`);
    return false;
  }
}

async function doExit(m) {
  if (DRY_RUN) {
    const cp = m.side === 'up' ? m.upMid : m.downMid;
    const proc = f2(SHARES_PER_LOT * cp);
    const cost = f2(SHARES_PER_LOT * m.entryPrice);
    const pnl  = f2(proc - cost);
    balance = f2(balance + proc);
    log(`📤 EXIT ${m.pair} ${m.side.toUpperCase()} @${f4(cp)} pnl:$${pnl}`);
    trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: m.side.toUpperCase(), action: 'EXIT', exit: cp, shares: SHARES_PER_LOT, pnl, bal: balance });
    if (trades.length > 100) trades.length = 100;
    return true;
  }

  const tid = m.side === 'up' ? m.upTokenId : m.downTokenId;
  try {
    const order = await trader.placeFokOrder(tid, 'SELL', SHARES_PER_LOT);
    if (order.isFilled) {
      const fillPrice = order.avgPrice > 0 ? order.avgPrice : (m.side === 'up' ? m.upMid : m.downMid);
      const cost = f2(SHARES_PER_LOT * m.entryPrice);
      const proc = f2(SHARES_PER_LOT * fillPrice);
      const pnl  = f2(proc - cost);
      log(`📤 EXIT ${m.pair} ${m.side.toUpperCase()} @${f4(fillPrice)} pnl:$${pnl}`);
      trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: m.side.toUpperCase(), action: 'EXIT', exit: fillPrice, shares: SHARES_PER_LOT, pnl, bal: balance });
      if (trades.length > 100) trades.length = 100;
      return true;
    }
    log(`⏭️ EXIT nofill ${m.pair} ${m.side.toUpperCase()}`);
    return false;
  } catch (e) {
    log(`❌ EXIT ${m.pair}: ${e.message}`);
    return false;
  }
}

async function tickMarket(m) {
  if (!m.active || m.resolved) return;
  if (m.phase === 'done') return;

  const now = Date.now();
  const elapsed = (now - m.windowStart) / 1000;
  const secsToEnd = Math.floor((m.endTime - now) / 1000);

  if (m.phase === 'idle' && elapsed >= ENTRY_WAIT_SECS) {
    m.side = pickCheapestSide(m);
    const price = m.side === 'up' ? m.upMid : m.downMid;
    if (price <= 0.01) { m.phase = 'idle'; return; }
    m.phase = 'wait';
    log(`▶️ ${m.pair} START cheapest=${m.side.toUpperCase()} up=${f4(m.upMid)} dn=${f4(m.downMid)}`);
  }

  if (m.phase === 'wait') {
    if (m.entryLock) return;
    if (now < m.retryAfter) return;
    const price = m.side === 'up' ? m.upMid : m.downMid;
    if (price <= 0.01) { m.phase = 'idle'; return; }
    m.entryLock = true;
    const ok = await doEntry(m);
    m.entryLock = false;
    if (ok) {
      m.phase = 'hold';
    } else {
      m.retryAfter = now + RETRY_COOLDOWN_MS;
    }
    return;
  }

  if (m.phase === 'hold') {
    const cp = m.side === 'up' ? m.upMid : m.downMid;
    if (!cp || cp === 0) return;
    const age = (now - m.holdStartedAt) / 1000;
    if (cp > m.peakPrice) m.peakPrice = cp;

    if (m.peakPrice - cp >= TRAILING_STOP_DIST && age >= MIN_HOLD_SECS) {
      m.phase = 'exit';
      log(`🔶 TRAILING ${m.pair} ${m.side.toUpperCase()} peak:${f4(m.peakPrice)} → ${f4(cp)}`);
    }
    if (secsToEnd <= 30 && age >= MIN_HOLD_SECS) {
      m.phase = 'exit';
      log(`⏳ FORCE SELL ${m.pair} ${secsToEnd}s left`);
    }
    return;
  }

  if (m.phase === 'exit') {
    if (m.exitLock) return;
    if (now < m.retryAfter) return;
    m.exitLock = true;
    const ok = await doExit(m);
    m.exitLock = false;
    if (ok) {
      if (secsToEnd <= 30) {
        m.phase = 'done';
        log(`🏁 ${m.pair} DONE`);
      } else {
        m.side = m.side === 'up' ? 'down' : 'up';
        m.phase = 'wait';
        log(`🔄 ${m.pair} FLIP to ${m.side.toUpperCase()}`);
      }
    } else {
      m.retryAfter = now + RETRY_COOLDOWN_MS;
    }
    return;
  }
}

async function tick() {
  try {
    tickCount++;
    if (tickCount === 1 || tickCount % DISCOVER_EVERY === 0) await discover();
    if (tickCount % PRICE_FETCH_EVERY === 0) {
      await Promise.allSettled(Object.values(markets).map(m => updatePrices(m)));
    }
    for (const m of Object.values(markets)) {
      await tickMarket(m);
    }
    emitFn('snapshot', snapshot());
  } catch (e) {
    log(`⚠️ ${e.message}`);
  }
}

function snapshot() {
  let openVal = 0, unreal = 0;
  const positions = Object.values(markets).filter(m => m.phase === 'hold').map(m => {
    const cp = m.side === 'up' ? m.upMid : m.downMid;
    const cv = f2(SHARES_PER_LOT * cp);
    const cost = f2(SHARES_PER_LOT * m.entryPrice);
    const upnl = f2(cv - cost);
    openVal += cv; unreal += upnl;
    return {
      pair: m.pair, side: m.side.toUpperCase(), entryPrice: f4(m.entryPrice),
      currentPrice: f4(cp), shares: SHARES_PER_LOT, cost, currentValue: cv,
      unrealizedPnl: upnl, peakPrice: f4(m.peakPrice), trailingDist: f4(m.peakPrice - cp),
      phase: m.phase,
    };
  });

  const allMarkets = Object.values(markets).filter(m => m.active).map(m => ({
    label: `${m.pair} 5m`, secondsToEnd: Math.floor((m.endTime - Date.now()) / 1000),
    upMid: f4(m.upMid), dnMid: f4(m.downMid),
    phase: m.phase, side: m.side.toUpperCase(),
  }));

  return {
    dryRun: DRY_RUN, balance: f2(balance),
    openEquity: f2(balance + openVal), startBalance: f2(startBalance),
    pnl: f2((balance + openVal) - startBalance), unrealizedPnl: f2(unreal),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    tickCount, activeMarkets: allMarkets.length,
    positions, positionsCount: positions.length,
    totalTrades: trades.length, recentTrades: trades.slice(0, 40),
    activityLog: logs.slice(0, 60), allMarkets,
    strategy: {
      sharesPerLot: SHARES_PER_LOT, trailingStopDist: TRAILING_STOP_DIST,
      forceSellSecs: FORCE_SELL_SECS,
    },
  };
}

function flushAll() {
  for (const k of Object.keys(markets)) delete markets[k];
  trades.length = 0; logs.length = 0;
  tickCount = 0; startTime = Date.now();
  balance = 0; startBalance = 0;
}

async function setDryRun(val) {
  const goingLive = !val && DRY_RUN;
  DRY_RUN = !!val;
  if (goingLive) {
    flushAll();
    if (process.env.POLYMARKET_PRIVATE_KEY) {
      try {
        trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY);
        trader.setLogFn(log);
        log('🔑 Authenticating...'); await trader.authenticate();
        log(`✅ Auth: ${trader.address}`);
        const realBal = await trader.getBalance();
        if (realBal > 0) { balance = realBal; startBalance = realBal; }
        log(`💰 Balance: $${f2(balance)}`);
      } catch (e) { log(`❌ Live setup: ${e.message}`); DRY_RUN = true; }
    } else {
      log('⚠️ No private key'); DRY_RUN = true;
    }
  } else {
    flushAll();
  }
  log(DRY_RUN ? '📋 DEMO' : '🔴 LIVE');
}

function getDryRun() { return DRY_RUN; }

async function start(emit, logFn) {
  emitFn = emit || (() => {});
  slog   = logFn || (() => {});
  startTime = Date.now();
  if (DRY_RUN) {
    balance = DEMO_BALANCE;
    startBalance = DEMO_BALANCE;
  } else {
    try {
      trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY);
      trader.setLogFn(log); log('🔑 Authenticating...'); await trader.authenticate();
      log(`✅ Auth: ${trader.address}`);
      const realBal = await trader.getBalance();
      if (realBal > 0) { balance = realBal; startBalance = realBal; }
      log(`💰 Balance: $${f2(balance)}`);
    } catch (e) { log(`❌ Auth: ${e.message}`); process.exit(1); }
  }
  log(DRY_RUN ? '📋 DEMO' : '🔴 LIVE');
  setInterval(tick, TICK_MS);
}

module.exports = { start, snapshot, setDryRun, getDryRun };
