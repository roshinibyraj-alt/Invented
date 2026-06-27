'use strict';

// ── Flip Strategy v2 ───────────────────────────────────────────
// ONE position per market at a time. Always starts with UP.
// Entry: GTC at midpoint (retry every tick until filled)
// Exit:  FOK at best bid  (retry every tick until filled)
// Flip:  exit confirmed → immediately GTC BUY opposite side
// ────────────────────────────────────────────────────────────────

const PolymarketTrader = require('./polymarket-trader');

const GAMMA       = 'https://gamma-api.polymarket.com';
const CLOB        = 'https://clob.polymarket.com';

const TICK_MS           = 100;
const DISCOVER_EVERY    = 300;
const PRICE_FETCH_EVERY = 5;
const WINDOW_SECS       = 300;
const DEMO_BALANCE      = 50;
const DEMO_FEE_RATE     = 0.03;
const DEMO_FEE_EXP      = 1;

const SHARES_PER_LOT     = 6;
const TRAILING_STOP_DIST = 0.05;
const HARD_STOP_DIST     = 0.08;
const FORCE_SELL_SECS    = 270;
const ENTRY_WAIT_SECS    = 10;
const MIN_HOLD_SECS      = 10; // minimum seconds before any exit can fire

let DRY_RUN       = true;
const KILL_SWITCH = process.env.KILL_SWITCH === 'true';
const TARGET_PAIRS = ['BTC', 'ETH'];

// ── State ──
let emitFn = () => {};
let logFn  = () => {};
function slog(m) { if (logFn) logFn(m); }

let balance = DEMO_BALANCE;
let startBalance = DEMO_BALANCE;
let totalFeesPaid = 0;
let tickCount = 0;
let startTime = Date.now();

let positions     = []; // max ONE active per market
let pendingOrders = []; // GTC BUY orders waiting to fill
let marketCache   = {};
let recentTrades  = [];
let activityLog   = [];
let trader        = null;

// per-market state
//   started:   window entered 10s wait phase
//   side:      'up' | 'down' — which side we're trying to enter / holding
//   entrySent: GTC BUY has been submitted
//   exiting:   FOK SELL in progress (retrying until filled)
const mState = {};
let clobCleanupTick = 0;
let liveClobOrders = 0;

const fl2 = v => Math.round((v || 0) * 100) / 100;
const fl4 = v => Math.round((v || 0) * 10_000) / 10_000;

function calcFee(amount, price) {
  if (!price || price <= 0 || price >= 1) return 0;
  const eff = DEMO_FEE_RATE * Math.pow(price * (1 - price), DEMO_FEE_EXP);
  return amount * eff;
}

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Market discovery ──
function generateSlugs() {
  const now = Math.floor(Date.now() / 1000);
  const cur = Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
  const slugs = [];
  for (const pair of TARGET_PAIRS) {
    const prefix = pair.toLowerCase() + '-updown-5m-';
    for (const d of [0, 1, 2]) slugs.push(prefix + (cur + d * WINDOW_SECS));
  }
  return slugs;
}

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
      slug, pair: slug.startsWith('btc') ? 'BTC' : 'ETH',
      windowS: WINDOW_SECS, upTokenId: ids[0], downTokenId: ids[1],
      endTime, active: false, resolved: false,
      upMid: 0, downMid: 0,
      secondsToEnd: Math.floor((endTime - Date.now()) / 1000),
      fairValue: 0.50,
      windowStart: endTime - WINDOW_SECS * 1000,
    };
    mState[slug] = { started: false, side: 'up', entrySent: false, exiting: false, skipCooldown: 0, retryAfter: 0 };
  }));
  const expired = [];
  for (const [slug, m] of Object.entries(marketCache)) {
    if (Date.now() - m.endTime > 10000) expired.push(slug);
  }
  for (const slug of expired) {
    delete marketCache[slug];
    delete mState[slug];
    positions = positions.filter(p => p.slug !== slug);
  }
}

// ── Update market prices ──
async function updateMarket(m) {
  const now = Date.now();
  m.secondsToEnd = Math.floor((m.endTime - now) / 1000);
  m.active = !m.resolved && m.secondsToEnd > 0 && m.secondsToEnd <= m.windowS;
  if (m.secondsToEnd < -5 && !m.resolved) { m.resolved = true; m.active = false; return; }
  if (!m.active) return;
  const elapsed = m.windowS - m.secondsToEnd;
  m.fairValue = fl4(0.50 + (elapsed / m.windowS) * 0.50);
  const [upR, dnR] = await Promise.all([
    getJson(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
    getJson(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
  ]);
  if (upR?.mid) m.upMid   = fl4(parseFloat(upR.mid));
  if (dnR?.mid) m.downMid = fl4(parseFloat(dnR.mid));
}

// ── Entry ──
async function enterPosition(m, side, price) {
  if (price < 0.05 || price > 0.95) {
    if (mState[m.slug] && Date.now() > mState[m.slug].skipCooldown) {
      slog(`⏭️ SKIP ${m.pair} ${side.toUpperCase()} @ ${fl4(price)} — extreme`);
      mState[m.slug].skipCooldown = Date.now() + 2000;
    }
    return false;
  }
  const size = SHARES_PER_LOT;
  const cost = fl2(size * price);
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  if (cost > balance) {
    slog(`⛔ ${m.pair} ${side.toUpperCase()} too costly: $${cost} > $${balance}`);
    return false;
  }
  if (DRY_RUN) {
    const fee = calcFee(cost, price);
    balance = fl2(balance - cost - fee);
    totalFeesPaid = fl2(totalFeesPaid + fee);
    positions.push({
      id: `d_${m.slug}_${side}_${tickCount}`, slug: m.slug, side,
      entryPrice: price, size, entryTick: tickCount, peakPrice: price,
      cpCount: 0, trailingActive: true, createdAt: Date.now(),
      totalCost: cost + fee, fees: fee,
    });
    slog(`🟢 ENTRY ${m.pair} ${side.toUpperCase()} ${size}sh@${fl4(price)} fee:$${fl2(fee)} bal:$${fl2(balance)}`);
    pushTrade(m.pair, side.toUpperCase(), 'ENTRY', price, 0, size, 0, balance, fee);
    return true;
  } else {
    try {
      const cost = Math.max(fl2(size * price), 1);
      const order = await trader.placeFokOrder(tokenId, 'BUY', cost);
      if (order.isFilled) {
        const fillPrice = order.avgPrice > 0 ? order.avgPrice : price;
        const fee = calcFee(size * fillPrice, fillPrice);
        balance = fl2(balance - size * fillPrice - fee);
        totalFeesPaid = fl2(totalFeesPaid + fee);
        positions.push({
          id: `f_${m.slug}_${side}_${tickCount}`, slug: m.slug, side,
          entryPrice: fillPrice, size, entryTick: tickCount,
          peakPrice: fillPrice, cpCount: 0, trailingActive: true,
          createdAt: Date.now(), totalCost: size * fillPrice + fee, fees: fee,
        });
        slog(`🟢 FOK FILLED ${m.pair} ${side.toUpperCase()} ${size}sh@${fl4(fillPrice)} fee:${fl2(fee)} bal:${fl2(balance)}`);
        pushTrade(m.pair, side.toUpperCase(), 'ENTRY', fillPrice, 0, size, 0, balance, fee);
        return true;
      } else {
        slog(`⏭️ FOK no fill ${m.pair} ${side.toUpperCase()} ${size}sh@${fl4(price)}`);
        return false;
      }
    } catch (e) {
      slog(`❌ FOK BUY ${m.pair} ${side.toUpperCase()}: ${e.message}`);
      return false;
    }
  }
}

// ── Check GTC entry fills ──
async function processPendingOrders() {
  // FOK entries fill or cancel instantly — nothing to poll
}

// ── Manage current position ──
async function managePositions() {
  // 1) Start entries for markets that passed 10s wait
  for (const [slug, m] of Object.entries(marketCache)) {
    if (!m.active) continue;
    const st = mState[slug];
    if (!st || st.started) continue;
    const elapsed = (Date.now() - m.windowStart) / 1000;
    if (elapsed >= ENTRY_WAIT_SECS) {
      st.started = true;
      st.side = 'up';
      slog(`▶️ START ${m.pair} — entering ${st.side.toUpperCase()} @ ${fl4(m.active ? (st.side === 'up' ? m.upMid : m.downMid) : 0)}`);
    }
  }

  // 2) Submit GTC entry orders if not yet sent AND no active position
  for (const [slug, m] of Object.entries(marketCache)) {
    if (!m.active) continue;
    const st = mState[slug];
    if (!st || !st.started) continue;
    const hasPos = positions.some(p => p.slug === slug && !p.resolved);
    if (hasPos) continue;
    if (st.entrySent) continue;
    // 200ms cooldown after a failed FOK entry
    if (st.retryAfter && Date.now() < st.retryAfter) continue;

    // LIVE: use best_ask for BUY so orders fill near-instantly
    let price = st.side === 'up' ? m.upMid : m.downMid;
    if (!DRY_RUN && trader) {
      try {
        const tid = st.side === 'up' ? m.upTokenId : m.downTokenId;
        const bb = await trader.getBestBidAsk(tid);
        if (bb && bb.bestAsk && bb.bestAsk > 0.01 && bb.bestAsk < 0.99) {
          price = Math.min(fl4(bb.bestAsk + 0.01), 0.99);
        }
      } catch (_) {}
    }
    if (price > 0.01) {
      st.entrySent = true; // lock immediately to prevent concurrent entries
      const _entered = await enterPosition(m, st.side, price);
      if (!_entered) { st.entrySent = false; st.retryAfter = Date.now() + 200; }
    }
  }

  // 3) Check exit conditions on active positions + FOK exit
  for (const pos of positions) {
    if (pos.resolved) continue;
    const st = mState[pos.slug];
    const m = marketCache[pos.slug];
    if (!m || !m.active) continue;

    const sidePrice = pos.side === 'up' ? m.upMid : m.downMid;
    if (!sidePrice || sidePrice === 0) continue;
    const elapsed = (Date.now() - m.windowStart) / 1000;

    // Update peak
    if (sidePrice > pos.peakPrice) pos.peakPrice = sidePrice;

    // Check exit conditions
    const reason = checkExitConditions(pos, sidePrice, m, elapsed);
    if (!reason) continue;

    if (st) st.exiting = true;
    await exitPosition(pos, sidePrice, m, reason);
  }
  positions = positions.filter(p => !p.resolved);
}

function checkExitConditions(pos, cp, m, elapsed) {
  // Minimum hold — prevent rapid cycling
  const age = (Date.now() - pos.createdAt) / 1000;
  if (age < MIN_HOLD_SECS) return null;
  if (cp <= pos.entryPrice - HARD_STOP_DIST) {
    slog(`🔴 HARD STOP ${m.pair} ${pos.side.toUpperCase()} entry:${fl4(pos.entryPrice)} → ${fl4(cp)}`);
    return 'hard_stop';
  }
  if (pos.trailingActive && pos.peakPrice - cp >= TRAILING_STOP_DIST) {
    slog(`🔶 TRAILING ${m.pair} ${pos.side.toUpperCase()} peak:${fl4(pos.peakPrice)} → ${fl4(cp)}`);
    return 'trailing';
  }
  if (elapsed >= FORCE_SELL_SECS) {
    slog(`⏳ FORCE SELL ${m.pair} ${pos.side.toUpperCase()} @ ${elapsed.toFixed(0)}s`);
    return 'force_sell';
  }
  return null;
}

async function exitPosition(pos, exitPrice, m, exitReason) {
  const cost     = fl2(pos.size * pos.entryPrice);
  const tokenId  = pos.side === 'up' ? m.upTokenId : m.downTokenId;

  if (DRY_RUN) {
    const proceeds = fl2(pos.size * exitPrice);
    const fee = calcFee(proceeds, exitPrice);
    const pnl = fl2(proceeds - cost - fee);
    balance = fl2(balance + proceeds - fee);
    totalFeesPaid = fl2(totalFeesPaid + fee);
    slog(`📤 SELL ${m.pair} ${pos.side.toUpperCase()} ${pos.size}sh@${fl4(exitPrice)} pnl:$${pnl} fee:$${fl2(fee)} bal:$${fl2(balance)}`);
    pushTrade(m.pair, pos.side.toUpperCase(), 'SELL', pos.entryPrice, exitPrice, pos.size, pnl, balance, fee);
    pos.resolved = true;
    if (mState[pos.slug] && exitReason !== 'force_sell' && exitReason !== 'hard_stop') {
      mState[pos.slug].side = pos.side === 'up' ? 'down' : 'up';
    }
    return;
  }

  // LIVE: FOK SELL — retry until filled
  try {
    const bb = await trader.getBestBidAsk(tokenId);
    const sellPrice = bb?.bestBid || exitPrice;
    const order = await trader.placeFokOrder(tokenId, 'SELL', pos.size);
    if (order.isFilled) {
      const fillPrice = order.avgPrice > 0 ? order.avgPrice : sellPrice;
      const proceeds = fl2(pos.size * fillPrice);
      const fee = calcFee(proceeds, fillPrice);
      const pnl = fl2(proceeds - cost - fee);
      balance = fl2(balance + proceeds - fee);
      totalFeesPaid = fl2(totalFeesPaid + fee);
      slog(`📤 FOK FILLED ${m.pair} ${pos.side.toUpperCase()} ${pos.size}sh@${fl4(fillPrice)} pnl:$${pnl} bal:$${fl2(balance)}`);
      pushTrade(m.pair, pos.side.toUpperCase(), 'SELL', pos.entryPrice, fillPrice, pos.size, pnl, balance, fee);
      pos.resolved = true;
      // Flip to opposite side (only on trailing, not force sell)
      if (mState[pos.slug] && exitReason !== 'force_sell' && exitReason !== 'hard_stop') {
        mState[pos.slug].side = pos.side === 'up' ? 'down' : 'up';
        mState[pos.slug].entrySent = false;
        mState[pos.slug].exiting = false;
      } else if (mState[pos.slug]) {
        mState[pos.slug].exiting = false;
        mState[pos.slug].started = false; // don't re-enter
      }
    } else {
      if (exitReason === 'force_sell') {
        try {
          const order = await trader.placeFokOrder(tokenId, 'SELL', pos.size);
          if (order.isFilled) {
            const fillPrice = order.avgPrice > 0 ? order.avgPrice : exitPrice;
            const proceeds = fl2(pos.size * fillPrice);
            const fee = calcFee(proceeds, fillPrice);
            const pnl = fl2(proceeds - cost - fee);
            balance = fl2(balance + proceeds - fee);
            totalFeesPaid = fl2(totalFeesPaid + fee);
            slog(`📤 FORCE SELL FOK ${m.pair} ${pos.side.toUpperCase()} ${pos.size}sh@${fl4(fillPrice)} pnl:$${pnl} bal:$${fl2(balance)}`);
            pushTrade(m.pair, pos.side.toUpperCase(), 'SELL', pos.entryPrice, fillPrice, pos.size, pnl, balance, fee);
            pos.resolved = true;
            if (mState[pos.slug]) { mState[pos.slug].exiting = false; mState[pos.slug].started = false; }
          } else {
            slog(`⏭️ FORCE SELL FOK not filled — retry next tick`);
          }
        } catch(e) { slog(`❌ FORCE SELL FOK: ${e.message}`); }
      } else {
        slog(`⚠️ FOK SELL ${m.pair} ${pos.side.toUpperCase()} not filled — retry next tick`);
      }
    }
  } catch (e) {
    slog(`❌ FOK SELL ${m.pair} ${pos.side.toUpperCase()}: ${e.message}`);
  }
}

// ── Reconcile CLOB orders: cancel any orphaned GTC orders ──
async function reconcileClobOrders() {
  try {
    const oo = await trader.getOpenOrders();
    if (!Array.isArray(oo)) { liveClobOrders = 0; return; }
    liveClobOrders = oo.length;
    // Only cancel stale BUY orders — never cancel SELL orders
    let cancelled = 0;
    for (const o of oo) {
      const oid = o.id || o.orderID;
      const side = o.side || '';
      if (oid && side === 'BUY') {
        try { await trader.cancelOrder(oid); cancelled++; } catch(_) {}
      }
    }
    if (cancelled > 0) slog(`🧹 Cleaned ${cancelled} orphan CLOB orders (${oo.length} total)`);
  } catch (_) {}
}

// ── Main tick ──
async function tick() {
  try {
    tickCount++;
    if (tickCount === 1 || tickCount % DISCOVER_EVERY === 0) await discoverMarkets();
    if (tickCount % PRICE_FETCH_EVERY === 0) {
      await Promise.allSettled(Object.values(marketCache).map(m => updateMarket(m)));
    }
    if (!DRY_RUN) {
      await processPendingOrders();
      // Periodic CLOB reconciliation every 80 ticks, cancels orphan orders
      clobCleanupTick++;
      if (clobCleanupTick >= 80) {
        clobCleanupTick = 0;
        await reconcileClobOrders();
      }
    }
    await managePositions();
    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    slog(`⚠️ tick: ${e.message}`);
  }
}

function pushTrade(pair, side, action, entry, exit, shares, pnl, bal, fees) {
  recentTrades.unshift({
    ts: new Date().toTimeString().slice(0, 8), pair, side, action,
    entry: fl4(entry), exit: fl4(exit || 0), shares,
    pnl: fl2(pnl || 0), bal: fl2(bal), fees: fl2(fees || 0),
  });
  if (recentTrades.length > 100) recentTrades.length = 100;
}

function buildSnapshot() {
  let openValue = 0, unrealizedPnl = 0;
  const openPositions = positions.filter(p => !p.resolved).map(p => {
    const m = marketCache[p.slug];
    const cp = m ? (p.side === 'up' ? m.upMid : m.downMid) : 0;
    const cv = fl2(p.size * cp);
    const upnl = fl2(cv - (p.size * p.entryPrice));
    openValue += cv; unrealizedPnl += upnl;
    const st = mState[p.slug];
    return {
      id: p.id.slice(0, 12), pair: m ? m.pair : '?',
      side: p.side.toUpperCase(), entryPrice: fl4(p.entryPrice),
      currentPrice: fl4(cp), shares: p.size, cost: fl2(p.size * p.entryPrice),
      currentValue: cv, unrealizedPnl: upnl, peakPrice: fl4(p.peakPrice),
      checkpoints: p.cpCount, trailingActive: p.trailingActive,
      exiting: st?.exiting || false,
    };
  });

  const allMarkets = Object.values(marketCache).filter(m => m.active).map(m => {
    const st = mState[m.slug];
    return {
      label: `${m.pair} 5m`, secondsToEnd: m.secondsToEnd,
      secondsSinceStart: m.windowS - m.secondsToEnd,
      upMid: fl4(m.upMid), dnMid: fl4(m.downMid),
      fairValue: fl4(m.fairValue),
      active: m.active,
      phase: st ? `${st.side}${st.exiting ? '/exiting' : st.entrySent ? '/entry' : st.started ? '/wait' : '/idle'}` : '?',
    };
  });

  return {
    dryRun: DRY_RUN, balance: fl2(balance),
    openEquity: fl2(balance + openValue), startBalance: fl2(startBalance),
    pnl: fl2((balance + openValue) - startBalance),
    unrealizedPnl: fl2(unrealizedPnl), totalFeesPaid: fl2(totalFeesPaid),
    uptime: Math.floor((Date.now() - startTime) / 1000), tickCount,
    activeMarkets: allMarkets.length, openPositions,
    pendingOrders: pendingOrders.filter(p => !p._filled).length,
    liveClobOrders: liveClobOrders || 0,
    positionsCount: positions.filter(p => !p.resolved).length,
    totalTrades: recentTrades.length, recentTrades: recentTrades.slice(0, 40),
    activityLog: activityLog.slice(0, 60), allMarkets,
    strategy: {
      sharesPerLot: SHARES_PER_LOT, trailingStopDist: TRAILING_STOP_DIST,
      hardStopDist: HARD_STOP_DIST, forceSellSecs: FORCE_SELL_SECS,
    },
  };
}

async function start(emit, log) {
  emitFn = emit || (() => {}); logFn = log || (() => {});
  startTime = Date.now(); balance = DEMO_BALANCE; startBalance = DEMO_BALANCE;
  if (!DRY_RUN) {
    try {
      trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
      trader.setLogFn(logFn); slog('🔑 Authenticating...'); await trader.authenticate();
      slog(`✅ Auth: ${trader.address}`);
      await trader.approveAllowance();
      // Cancel stale open orders from previous runs
      try { const oo = await trader.getOpenOrders(); if (Array.isArray(oo)) { for (const o of oo) { try { await trader.cancelOrder(o.id || o.orderID); } catch(_) {} } } slog(`🧹 Cancelled ${oo?.length||0} stale orders`); } catch(_) {}
      const realBal = await trader.getBalance();
      if (realBal > 0) { balance = realBal; startBalance = realBal; }
      slog(`💰 Real balance: $${fl2(balance)} (demo: $${DEMO_BALANCE})`);
    } catch (e) { slog(`❌ Auth: ${e.message}`); process.exit(1); }
  }
  slog(DRY_RUN ? '📋 DEMO mode' : '🔴 LIVE mode');
  setInterval(tick, TICK_MS);
}

function flushState() {
  positions = []; recentTrades = [];
  activityLog = []; marketCache = {};
  tickCount = 0; startTime = Date.now();
  balance = DEMO_BALANCE; startBalance = DEMO_BALANCE; totalFeesPaid = 0;
  for (const k of Object.keys(mState)) delete mState[k];
}

async function setDryRun(val) {
  const goingLive = !val && DRY_RUN;
  DRY_RUN = !!val;
  if (goingLive) {
    flushState();
    if (process.env.POLYMARKET_PRIVATE_KEY) {
      try {
        if (!trader) {
          trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
          trader.setLogFn(logFn || (() => {}));
          slog('🔑 Authenticating for live...'); await trader.authenticate();
          slog(`✅ Auth: ${trader.address}`);
        }
        await trader.approveAllowance();
        try { const oo = await trader.getOpenOrders(); if (Array.isArray(oo)) { for (const o of oo) { try { await trader.cancelOrder(o.id || o.orderID); } catch(_) {} } } slog(`🧹 Cancelled ${oo?.length||0} stale orders`); } catch(_) {}
        const realBal = await trader.getBalance();
        if (realBal > 0) { balance = realBal; startBalance = realBal; }
        slog(`💰 Real balance: $${fl2(balance)}`);
      } catch (e) { slog(`❌ Live setup: ${e.message}`); DRY_RUN = true; }
    } else {
      slog('⚠️ No POLYMARKET_PRIVATE_KEY');
      DRY_RUN = true;
    }
  } else {
    flushState();
  }
  slog(DRY_RUN ? '📋 DEMO' : '🔴 LIVE');
}

function getDryRun() { return DRY_RUN; }

module.exports = { start, buildSnapshot, setDryRun, getDryRun };
