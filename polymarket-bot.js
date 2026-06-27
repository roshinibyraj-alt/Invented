'use strict';

// ── Flip Bot v3 — Clean rewrite ────────────────────────────────
// One position per market. All orders FOK (fill-or-kill).
// State machine per market — never two orders at once.
// ────────────────────────────────────────────────────────────────

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS           = 100;
const DISCOVER_EVERY    = 300;
const PRICE_FETCH_EVERY = 5;
const WINDOW_SECS       = 300;
const DEMO_BALANCE      = 50;
const DEMO_FEE_RATE     = 0.03;

const SHARES_PER_LOT     = 6;
const TRAILING_STOP_DIST = 0.05;
const HARD_STOP_DIST     = 0.08;
const FORCE_SELL_SECS    = 270;
const ENTRY_WAIT_SECS    = 10;
const MIN_HOLD_SECS      = 10;
const RETRY_COOLDOWN_MS  = 300;

let DRY_RUN = true;
const TARGET_PAIRS = ['BTC', 'ETH'];

// ── State ──
let emitFn = () => {};
let slog   = () => {};

let balance = DEMO_BALANCE;
let startBalance = DEMO_BALANCE;
let totalFees = 0;
let tickCount = 0;
let startTime = Date.now();
let trader    = null;

// Per-market state machine
// phase: 'idle'|'wait'|'enter'|'hold'|'exit'|'done'
// side:  'up'|'down'
// When phase='hold', trailing stop & exit checks run.
// When phase='enter' or 'exit', exactly ONE FOK is in flight.
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

// ── Market discovery ──
function genSlugs() {
  const now = Math.floor(Date.now() / 1000);
  const cur = Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
  const out = [];
  for (const p of TARGET_PAIRS) {
    const pre = p.toLowerCase() + '-updown-5m-';
    for (const d of [0, 1, 2]) out.push(pre + (cur + d * WINDOW_SECS));
  }
  return out;
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
      upMid: 0, downMid: 0, fairValue: 0.5,
      phase: 'idle', side: 'up',
      entryLock: false,       // prevents placing >1 entry
      exitLock: false,        // prevents placing >1 exit
      retryAfter: 0,          // cooldown after failed FOK
      holdStartedAt: 0,       // when position opened
      entryPrice: 0, peakPrice: 0, posId: null,
    };
  }));
  // Clean expired
  for (const [slug, m] of Object.entries(markets)) {
    if (Date.now() - m.endTime > 10000) {
      delete markets[slug];
    }
  }
}

// ── Price update ──
async function updatePrices(m) {
  const now = Date.now();
  const secsToEnd = Math.floor((m.endTime - now) / 1000);
  m.active = !m.resolved && secsToEnd > 0 && secsToEnd <= WINDOW_SECS;
  if (secsToEnd < -5 && !m.resolved) { m.resolved = true; m.active = false; return; }
  if (!m.active) return;
  const elapsed = WINDOW_SECS - secsToEnd;
  m.fairValue = f4(0.5 + (elapsed / WINDOW_SECS) * 0.5);
  const [ur, dr] = await Promise.all([
    getJSON(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
    getJSON(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
  ]);
  if (ur?.mid) m.upMid   = f4(parseFloat(ur.mid));
  if (dr?.mid) m.downMid = f4(parseFloat(dr.mid));
}

// ── FOK Entry ──
async function doEntry(m) {
  if (DRY_RUN) {
    const price = m.side === 'up' ? m.upMid : m.downMid;
    if (price < 0.05 || price > 0.95) { log(`⏭️ SKIP ${m.pair} ${m.side.toUpperCase()} @ ${f4(price)}`); return false; }
    const cost = f2(SHARES_PER_LOT * price);
    if (cost > balance) { log(`⛔ ${m.pair} cost $${cost} > $${balance}`); return false; }
    const fee = f2(cost * DEMO_FEE_RATE * price * (1 - price));
    balance = f2(balance - cost - fee);
    totalFees = f2(totalFees + fee);
    m.entryPrice = price; m.peakPrice = price; m.holdStartedAt = Date.now();
    log(`🟢 DEMO ENTRY ${m.pair} ${m.side.toUpperCase()} ${SHARES_PER_LOT}sh@${f4(price)}`);
    trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: m.side.toUpperCase(), action: 'ENTRY', entry: price, shares: SHARES_PER_LOT, pnl: 0, bal: balance });
    if (trades.length > 100) trades.length = 100;
    return true;
  }
  // LIVE: GTC BUY at best_ask (marketable limit, fills in 1-2 ticks)
  const mid = m.side === 'up' ? m.upMid : m.downMid;
  if (mid < 0.05 || mid > 0.95) { log(`⏭️ SKIP ${m.pair} ${m.side.toUpperCase()} @ ${f4(mid)}`); return false; }
  const tid = m.side === 'up' ? m.upTokenId : m.downTokenId;
  let entryPrice = mid;
  try {
    const bb = await trader.getBestBidAsk(tid);
    if (bb && bb.bestAsk && bb.bestAsk > 0.01 && bb.bestAsk < 0.99) entryPrice = Math.min(f4(bb.bestAsk), 0.99);
  } catch (_) {}
  const cost = f2(SHARES_PER_LOT * entryPrice);
  if (cost > balance) { log(`⛔ ${m.pair} cost ${cost} > ${balance}`); return false; }
  try {
    const order = await trader.placeGtcOrder(tid, 'BUY', entryPrice, SHARES_PER_LOT);
    log(`⏳ GTC ENTRY ${m.pair} ${m.side.toUpperCase()} ${SHARES_PER_LOT}sh@${f4(entryPrice)}`);
    // Track this GTC order and poll next ticks
    m._pendingEntry = { id: order.id, price: entryPrice, cost, createdAt: Date.now() };
    return true;
  } catch (e) {
    log(`❌ GTC ENTRY ${m.pair}: ${e.message}`);
    return false;
  }
}

// ── FOK Exit ──
async function doExit(m, exitReason) {
  if (DRY_RUN) {
    const cp = m.side === 'up' ? m.upMid : m.downMid;
    const cost = f2(SHARES_PER_LOT * m.entryPrice);
    const proc = f2(SHARES_PER_LOT * cp);
    const fee  = f2(proc * DEMO_FEE_RATE * cp * (1 - cp));
    const pnl  = f2(proc - cost - fee);
    balance = f2(balance + proc - fee);
    totalFees = f2(totalFees + fee);
    log(`📤 DEMO EXIT ${m.pair} ${m.side.toUpperCase()} @${f4(cp)} pnl:$${pnl}`);
    trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: m.side.toUpperCase(), action: `EXIT(${exitReason})`, exit: cp, shares: SHARES_PER_LOT, pnl, bal: balance });
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
      const fee  = f2(proc * DEMO_FEE_RATE * fillPrice * (1 - fillPrice));
      const pnl  = f2(proc - cost - fee);
      balance = f2(balance + proc - fee);
      totalFees = f2(totalFees + fee);
      log(`📤 FOK EXIT ${m.pair} ${m.side.toUpperCase()} @${f4(fillPrice)} pnl:$${pnl}`);
      trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: m.side.toUpperCase(), action: `EXIT(${exitReason})`, exit: fillPrice, shares: SHARES_PER_LOT, pnl, bal: balance });
      if (trades.length > 100) trades.length = 100;
      return true;
    }
    log(`⏭️ FOK nofill exit ${m.pair} ${m.side.toUpperCase()}`);
    return false;
  } catch (e) {
    log(`❌ FOK EXIT ${m.pair}: ${e.message}`);
    return false;
  }
}

// ── Per-market tick (state machine) ──
async function tickMarket(m) {
  if (!m.active || m.resolved) return;
  if (m.phase === 'done') return;

  const elapsed = (Date.now() - m.windowStart) / 1000;

  // --- IDLE → WAIT after entry delay ---
  if (m.phase === 'idle' && elapsed >= ENTRY_WAIT_SECS) {
    m.phase = 'wait';
    m.side = 'up';
    log(`▶️ ${m.pair} START`);
  }

  // --- WAIT → poll pending GTC or place new entry ---
  if (m.phase === 'wait') {
    // Check if a pending GTC order filled
    if (m._pendingEntry) {
      if (Date.now() - m._pendingEntry.createdAt > 2000) {
        // 2s timeout: cancel and retry
        try { await trader.cancelOrder(m._pendingEntry.id); } catch(_) {}
        delete m._pendingEntry;
        m.retryAfter = Date.now() + 200;
        return;
      }
      try {
        const ord = await trader._clob.getOrder(m._pendingEntry.id).catch(() => null);
        if (ord) {
          const oStatus = (ord.status || '').toUpperCase();
          const oMatch = (ord.match_status || '').toLowerCase();
          const oFilled = parseFloat(ord.size_matched || ord.filled_size || '0');
          const filled = oStatus === 'FILLED' || oMatch === 'filled' || oFilled >= SHARES_PER_LOT;
          if (filled) {
            const fillPrice = parseFloat(ord.avg_fill_price || ord.price || m._pendingEntry.price);
            const cost = m._pendingEntry.cost;
            const fee = f2(cost * DEMO_FEE_RATE * fillPrice * (1 - fillPrice));
            balance = f2(balance - cost - fee);
            totalFees = f2(totalFees + fee);
            m.entryPrice = fillPrice; m.peakPrice = fillPrice; m.holdStartedAt = Date.now();
            delete m._pendingEntry;
            log(`🟢 GTC ENTRY FILLED ${m.pair} ${m.side.toUpperCase()} ${SHARES_PER_LOT}sh@${f4(fillPrice)}`);
            trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair, side: m.side.toUpperCase(), action: 'ENTRY', entry: fillPrice, shares: SHARES_PER_LOT, pnl: 0, bal: balance });
            if (trades.length > 100) trades.length = 100;
            m.phase = 'hold';
            return;
          }
        }
      } catch(_) {}
      return; // still waiting for fill
    }
    if (m.entryLock) return;
    if (Date.now() < m.retryAfter) return;
    const price = m.side === 'up' ? m.upMid : m.downMid;
    if (price <= 0.01) return; // no price yet
    m.entryLock = true;           // LOCK — prevents concurrent FOK
    const ok = await doEntry(m);
    if (ok) {
      m.phase = 'hold';
      m.entryLock = false;
    } else {
      m.entryLock = false;
      m.retryAfter = Date.now() + RETRY_COOLDOWN_MS;
    }
    return;
  }

  // --- HOLD → check exit conditions ---
  if (m.phase === 'hold') {
    const cp = m.side === 'up' ? m.upMid : m.downMid;
    if (!cp || cp === 0) return;
    const age = (Date.now() - m.holdStartedAt) / 1000;
    if (cp > m.peakPrice) m.peakPrice = cp;

    // Hard stop
    if (cp <= m.entryPrice - HARD_STOP_DIST && age >= MIN_HOLD_SECS) {
      m.phase = 'exit';
      log(`🔴 HARD STOP ${m.pair} ${m.side.toUpperCase()}`);
    }
    // Trailing stop
    if (m.peakPrice - cp >= TRAILING_STOP_DIST && age >= MIN_HOLD_SECS) {
      m.phase = 'exit';
      log(`🔶 TRAILING ${m.pair} ${m.side.toUpperCase()} peak:${f4(m.peakPrice)} → ${f4(cp)}`);
    }
    // Force sell
    if (elapsed >= FORCE_SELL_SECS) {
      m.phase = 'exit';
      log(`⏳ FORCE SELL ${m.pair} @ ${elapsed.toFixed(0)}s`);
    }
    return;
  }

  // --- EXIT (FOK SELL) ---
  if (m.phase === 'exit') {
    if (m.exitLock) return; // FOK in-flight
    if (Date.now() < m.retryAfter) return; // cooldown
    const exitReason = elapsed >= FORCE_SELL_SECS ? 'force' : (m.side === 'up' ? (m.peakPrice - (m.side === 'up' ? m.upMid : m.downMid) >= TRAILING_STOP_DIST ? 'trail' : 'hard') : 'trail');
    m.exitLock = true;        // LOCK — prevents concurrent FOK
    const ok = await doExit(m, exitReason);
    if (ok) {
      // Flip to opposite side (unless force sell)
      if (elapsed >= FORCE_SELL_SECS) {
        m.phase = 'done';
        m.exitLock = false;
        log(`🏁 ${m.pair} DONE (force exit)`);
      } else {
        m.side = m.side === 'up' ? 'down' : 'up';
        m.phase = 'wait';
        m.exitLock = false;
        m.entryLock = false;
        log(`🔄 ${m.pair} FLIP to ${m.side.toUpperCase()}`);
      }
    } else {
      m.exitLock = false;
      m.retryAfter = Date.now() + RETRY_COOLDOWN_MS;
    }
    return;
  }
}

// ── Main tick ──
async function tick() {
  try {
    tickCount++;
    if (tickCount === 1 || tickCount % DISCOVER_EVERY === 0) await discover();
    if (tickCount % PRICE_FETCH_EVERY === 0) {
      await Promise.allSettled(Object.values(markets).map(m => updatePrices(m)));
    }
    // Process all markets (state machine)
    for (const m of Object.values(markets)) {
      await tickMarket(m);
    }
    emitFn('snapshot', snapshot());
  } catch (e) {
    log(`⚠️ ${e.message}`);
  }
}

// ── Snapshot ──
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
    upMid: f4(m.upMid), dnMid: f4(m.downMid), fairValue: f4(m.fairValue),
    phase: m.phase, side: m.side.toUpperCase(),
  }));

  return {
    dryRun: DRY_RUN, balance: f2(balance),
    openEquity: f2(balance + openVal), startBalance: f2(startBalance),
    pnl: f2((balance + openVal) - startBalance), unrealizedPnl: f2(unreal),
    totalFees: f2(totalFees), uptime: Math.floor((Date.now() - startTime) / 1000),
    tickCount, activeMarkets: allMarkets.length,
    positions, positionsCount: positions.length,
    totalTrades: trades.length, recentTrades: trades.slice(0, 40),
    activityLog: logs.slice(0, 60), allMarkets,
    pendingOrders: 0, // FOK = zero pending always
    strategy: {
      sharesPerLot: SHARES_PER_LOT, trailingStopDist: TRAILING_STOP_DIST,
      hardStopDist: HARD_STOP_DIST, forceSellSecs: FORCE_SELL_SECS,
    },
  };
}

function flushAll() {
  for (const k of Object.keys(markets)) delete markets[k];
  trades.length = 0; logs.length = 0;
  tickCount = 0; startTime = Date.now();
  balance = DEMO_BALANCE; startBalance = DEMO_BALANCE; totalFees = 0;
}

async function setDryRun(val) {
  const goingLive = !val && DRY_RUN;
  DRY_RUN = !!val;
  if (goingLive) {
    flushAll();
    if (process.env.POLYMARKET_PRIVATE_KEY) {
      try {
        trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
        trader.setLogFn(log);
        log('🔑 Authenticating...'); await trader.authenticate();
        log(`✅ Auth: ${trader.address}`);
        await trader.approveAllowance();
        // Cancel all stale open orders
        try {
          const oo = await trader.getOpenOrders();
          if (Array.isArray(oo)) {
            let cancelled = 0;
            for (const o of oo) {
              const oid = o.id || o.orderID;
              const side = o.side || '';
              if (oid && side === 'BUY') { try { await trader.cancelOrder(oid); cancelled++; } catch(_) {} }
            }
            if (cancelled > 0) log(`🧹 Cancelled ${cancelled} stale orders`);
          }
        } catch(_) {}
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
  if (!DRY_RUN) {
    try {
      trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
      trader.setLogFn(log); log('🔑 Authenticating...'); await trader.authenticate();
      log(`✅ Auth: ${trader.address}`);
      await trader.approveAllowance();
      try {
        const oo = await trader.getOpenOrders();
        if (Array.isArray(oo)) {
          let c = 0;
          for (const o of oo) {
            const oid = o.id || o.orderID;
            if (oid && (o.side || '') === 'BUY') { try { await trader.cancelOrder(oid); c++; } catch(_) {} }
          }
          if (c > 0) log(`🧹 Cancelled ${c} stale orders`);
        }
      } catch(_) {}
      const realBal = await trader.getBalance();
      if (realBal > 0) { balance = realBal; startBalance = realBal; }
      log(`💰 Balance: $${f2(balance)}`);
    } catch (e) { log(`❌ Auth: ${e.message}`); process.exit(1); }
  }
  log(DRY_RUN ? '📋 DEMO' : '🔴 LIVE');
  setInterval(tick, TICK_MS);
}

module.exports = { start, snapshot, setDryRun, getDryRun };
