'use strict';

// ── Time-Decay Trend Strategy for BTC/ETH 5m ─────────────────────────────
// Fair value decays linearly from 0.50→1.00 over 300s.
// Buy leader when price is significantly below fair value (deviation > threshold).
// Exit with trailing stop / hard stop / time stop / force sell via FOK.

const PolymarketTrader = require('./polymarket-trader');

// ── Constants ──
const GAMMA       = 'https://gamma-api.polymarket.com';
const CLOB        = 'https://clob.polymarket.com';

const TICK_MS           = 100;
const DISCOVER_EVERY    = 300;
const PRICE_FETCH_EVERY = 5;
const CHECKPOINT_EVERY  = 250;
const WINDOW_SECS       = 300;
const DEMO_BALANCE      = 50;
const DEMO_FEE_RATE     = 0.03;
const DEMO_FEE_EXP      = 1;

const DEVIATION_THRESHOLD  = 0.05;
const MAX_DEVIATION        = 0.25;
const SHARES_PER_LOT       = 6;
const MAX_LOTS             = 5;
const TRAILING_STOP_DIST   = 0.05;
const HARD_STOP_DIST       = 0.08;
const TIME_STOP_CP         = 5;
const FORCE_SELL_SECS      = 270;
const PRICE_HISTORY_LEN    = 3;

let DRY_RUN       = true;
const KILL_SWITCH = process.env.KILL_SWITCH === 'true';
const TARGET_PAIRS = ['BTC', 'ETH'];

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function calcFee(amount, price) {
  if (!price || price <= 0 || price >= 1) return 0;
  const eff = DEMO_FEE_RATE * Math.pow(price * (1 - price), DEMO_FEE_EXP);
  return amount * eff;
}

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

// ── State ──
let trader          = null;
let balance         = DEMO_BALANCE;
let startBalance    = DEMO_BALANCE;
let totalFeesPaid   = 0;
let marketCache     = {};
let positions       = [];
let pendingOrders   = [];
let recentTrades    = [];
let activityLog     = [];
let tickCount       = 0;
let startTime       = Date.now();
let emitFn          = () => {};
let logFn           = () => {};

function slog(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  activityLog.unshift(`[${ts}] ${msg}`);
  if (activityLog.length > 200) activityLog.length = 200;
  logFn(msg);
}

function pushTrade(pair, side, action, entry, exit, shares, pnl, bal, fees) {
  recentTrades.unshift({
    ts: new Date().toTimeString().slice(0, 8), pair, side, action,
    entry: fl4(entry), exit: fl4(exit || 0), shares,
    pnl: fl2(pnl || 0), bal: fl2(bal), fees: fl2(fees || 0),
  });
  if (recentTrades.length > 100) recentTrades.length = 100;
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
      slug, pair: slug.startsWith('btc') ? 'BTC' : 'ETH',
      windowS: WINDOW_SECS, upTokenId: ids[0], downTokenId: ids[1],
      endTime, active: false, resolved: false,
      upMid: 0, downMid: 0,
      secondsToEnd: Math.floor((endTime - Date.now()) / 1000),
      fairValue: 0.50,
      windowStart: endTime - WINDOW_SECS * 1000,
      checkpointData: { prices: [], leader: null, entrySignals: 0 },
      initialEntryDone: false,
      entryCooldown: 0,
    };
  }));
  const expired = [];
  for (const [slug, m] of Object.entries(marketCache)) {
    if (Date.now() - m.endTime > 10000) expired.push(slug);
  }
  for (const slug of expired) {
    delete marketCache[slug];
    positions = positions.filter(p => p.slug !== slug);
    pendingOrders = pendingOrders.filter(p => p.slug !== slug);
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

  if (!m.checkpointData) m.checkpointData = { prices: [], leader: null };
  const cd = m.checkpointData;
  const lastP = cd.prices.length > 0 ? cd.prices[cd.prices.length - 1] : null;
  if (!lastP || tickCount % (CHECKPOINT_EVERY / 2) === 0) {
    cd.prices.push({ tick: tickCount, upPrice: m.upMid || 0, dnPrice: m.downMid || 0 });
    if (cd.prices.length > PRICE_HISTORY_LEN) cd.prices.shift();
  }
  if (cd.prices.length >= 2) {
    const recent = cd.prices.slice(-2);
    const upFair = m.fairValue;
    const dnFair = 1 - m.fairValue;
    const avgUpDev = recent.reduce((s, c) => s + (c.upPrice - upFair), 0) / recent.length;
    const avgDnDev = recent.reduce((s, c) => s + (c.dnPrice - dnFair), 0) / recent.length;
    cd.leader = avgUpDev <= avgDnDev ? 'up' : 'dn';
  }
}

function sideFair(m, side) {
  return side === 'up' ? m.fairValue : (1 - m.fairValue);
}

// ── Checkpoint: initial dual entry ──
async function runCheckpoint() {
  slog(`📊 Checkpoint ${Math.floor(tickCount / CHECKPOINT_EVERY)}`);
  for (const [slug, m] of Object.entries(marketCache)) {
    if (!m.active) continue;

    // Wait 10s after window start before first entry
    const elapsed = (Date.now() - m.windowStart) / 1000;
    if (!m.initialEntryDone && elapsed >= 10) {
      m.initialEntryDone = true;
      if (m.upMid > 0.01 && m.upMid < 0.95)   await enterPosition(m, 'up', m.upMid);
      if (m.downMid > 0.01 && m.downMid < 0.95) await enterPosition(m, 'down', m.downMid);
    }
  }
}

// ── Enter position ──
async function enterPosition(m, side, price) {
  // Respect cooldown (prevent spam on failed entries)
  if (m.entryCooldown > Date.now()) return;
  const size = SHARES_PER_LOT;
  const cost = fl2(size * price);
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;

  if (cost > balance) {
    slog(`⛔ ${m.pair} ${side.toUpperCase()} too costly: $${cost} > $${balance}`);
    return;
  }

  if (DRY_RUN) {
    const fee = calcFee(cost, price);
    balance = fl2(balance - cost - fee);
    totalFeesPaid = fl2(totalFeesPaid + fee);
    positions.push({
      id: `d_${m.slug}_${side}_${tickCount}`, slug: m.slug, side,
      entryPrice: price, size, entryTick: tickCount, peakPrice: price,
      cpCount: 0, trailingActive: true, hardStopHit: false,
      createdAt: Date.now(), totalCost: cost + fee, fees: fee,
    });
    slog(`🟢 ENTRY ${m.pair} ${side.toUpperCase()} ${size}sh@${fl4(price)} dev:${fl4(m.fairValue - price)} fee:$${fl2(fee)}`);
    pushTrade(m.pair, side.toUpperCase(), 'ENTRY', price, 0, size, 0, balance, fee);
  } else {
    // Skip if price is extreme (no liquidity near 0 or 1)
    if (price < 0.05 || price > 0.95) {
      slog(`⏭️ SKIP ${m.pair} ${side.toUpperCase()} @ ${fl4(price)} — extreme price`);
      return;
    }
    try {
      const entryPrice = fl4(price);
      const order = await trader.placeGtcOrder(tokenId, 'BUY', entryPrice, size);
      slog(`⏳ GTC BUY ${m.pair} ${side.toUpperCase()} ${size}sh@${entryPrice} id:${order.id.slice(0,12)}…`);
      pendingOrders.push({ id: order.id, slug: m.slug, side, size, price: entryPrice, createdAt: Date.now(), resolved: false });
    } catch (e) {
      m.entryCooldown = Date.now() + 5000; // 5s cooldown on failure
      slog(`❌ GTC BUY: ${e.message}`);
    }
  }
}

// ── Process live pending GTC orders ──
async function processPendingOrders() {
  for (const po of pendingOrders) {
    if (po.resolved) continue;
    const m = marketCache[po.slug];
    if (!m || !m.active) { po.resolved = true; continue; }
    try {
      const result = await trader.waitForFill(po.id, 2000);
      if (result.filled) {
        const fee = calcFee(po.size * po.price, po.price);
        balance = fl2(balance - po.size * po.price - fee);
        totalFeesPaid = fl2(totalFeesPaid + fee);
        positions.push({
          id: po.id.slice(0,12), slug: po.slug, side: po.side,
          entryPrice: po.price, size: po.size, entryTick: tickCount,
          peakPrice: po.price, cpCount: 0, trailingActive: true,
          hardStopHit: false, createdAt: Date.now(),
          totalCost: po.size * po.price + fee, fees: fee,
        });
        slog(`✅ GTC FILLED ${m.pair} ${po.side.toUpperCase()} ${po.size}sh@${fl4(po.price)} fee:$${fl2(fee)} bal:$${fl2(balance)}`);
        pushTrade(m.pair, po.side.toUpperCase(), 'ENTRY', po.price, 0, po.size, 0, balance, fee);
        po.resolved = true;
      } else if (result.timeout || result.cancelled) {
        if (result.timeout) {
          // Try again next tick instead of giving up
          // Only cancel if waiting too long (>15s)
          if (Date.now() - po.createdAt > 15000) {
            slog(`⏰ GTC TIMEOUT ${po.id.slice(0,12)}… — cancelling`);
            try { await trader.cancelOrder(po.id); } catch(_) {}
            po.resolved = true;
          }
        }
      }
    } catch (e) { slog(`⚠️ Poll: ${e.message}`); }
  }
  pendingOrders = pendingOrders.filter(p => !p.resolved);
}

// ── Manage open positions ──
async function managePositions(isCheckpoint) {
  for (const pos of positions) {
    const m = marketCache[pos.slug];
    if (!m || !m.active) continue;
    const sidePrice = pos.side === 'up' ? m.upMid : m.downMid;
    if (!sidePrice || sidePrice === 0) continue;
    const elapsed = (Date.now() - m.windowStart) / 1000;
    if (isCheckpoint) pos.cpCount++;
    if (sidePrice > pos.peakPrice) pos.peakPrice = sidePrice;
    const reason = checkExitConditions(pos, sidePrice, m, elapsed);
    if (reason) {
      await exitPosition(pos, sidePrice, m);
    }
  }
  positions = positions.filter(p => !p.resolved);
  // Fallback: if any active market has zero positions mid-window, re-enter both sides
  const now = Date.now();
  for (const [, m] of Object.entries(marketCache)) {
    if (!m.active) continue;
    const elapsed = (now - m.windowStart) / 1000;
    if (elapsed < 10 || elapsed >= FORCE_SELL_SECS) continue;
    const hasUp = positions.some(p => p.slug === m.slug && p.side === 'up');
    const hasDn = positions.some(p => p.slug === m.slug && p.side === 'down');
    if (!hasUp && !hasDn) {
      m.initialEntryDone = false;
      if (m.upMid > 0.01 && m.upMid < 0.95 && balance > m.upMid * 6) await enterPosition(m, 'up', m.upMid);
      if (m.downMid > 0.01 && m.downMid < 0.95 && balance > m.downMid * 6) await enterPosition(m, 'down', m.downMid);
    }
  }
}

function checkExitConditions(pos, cp, m, elapsed) {
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

async function exitPosition(pos, exitPrice, m) {
  const proceeds = fl2(pos.size * exitPrice);
  const cost     = fl2(pos.size * pos.entryPrice);
  const fee      = calcFee(proceeds, exitPrice);
  const pnl      = fl2(proceeds - cost - fee);
  const tokenId  = pos.side === 'up' ? m.upTokenId : m.downTokenId;

  if (DRY_RUN) {
    balance = fl2(balance + proceeds - fee);
    totalFeesPaid = fl2(totalFeesPaid + fee);
    slog(`📤 SELL ${m.pair} ${pos.side.toUpperCase()} ${pos.size}sh@${fl4(exitPrice)} pnl:$${pnl} fee:$${fl2(fee)} bal:$${fl2(balance)}`);
    pushTrade(m.pair, pos.side.toUpperCase(), 'SELL', pos.entryPrice, exitPrice, pos.size, pnl, balance, fee);
    pos.resolved = true;
  } else {
    try {
      const bb = await trader.getBestBidAsk(tokenId);
      // For SELL: sell tokens into the best bid (highest buyer price)
      const sellPrice = bb?.bestBid || exitPrice;
      // FOK SELL amount = number of tokens (for SELL side)
      const order = await trader.placeFokOrder(tokenId, 'SELL', pos.size);
      if (order.isFilled) {
        const fillPrice = order.avgPrice > 0 ? order.avgPrice : sellPrice;
        const proceeds = fl2(pos.size * fillPrice);
        const pnlAdj = fl2(proceeds - cost - fee);
        balance = fl2(balance + proceeds - fee);
        totalFeesPaid = fl2(totalFeesPaid + fee);
        slog(`📤 FOK FILLED ${m.pair} ${pos.side.toUpperCase()} ${pos.size}sh@${fl4(fillPrice)} pnl:$${pnlAdj}`);
        pos.resolved = true;
        // Flip: immediately enter opposite side since FOK filled instantly
        const flipSide = pos.side === 'up' ? 'down' : 'up';
        const flipPrice = flipSide === 'up' ? m.upMid : m.downMid;
        if (flipPrice > 0.01 && balance > flipPrice * 6) {
          await enterPosition(m, flipSide, flipPrice);
        }
      } else {
        slog(`⚠️ FOK SELL not filled (${order.status}) — retrying next tick`);
      }
    } catch (e) { slog(`❌ FOK SELL: ${e.message}`); }
  }
}

// ── Main tick ──
async function tick() {
  try {
    tickCount++;
    if (tickCount === 1 || tickCount % DISCOVER_EVERY === 0) await discoverMarkets();
    if (tickCount % PRICE_FETCH_EVERY === 0) {
      await Promise.allSettled(Object.values(marketCache).map(m => updateMarket(m)));
    }
    const isCheckpoint = (tickCount % CHECKPOINT_EVERY === 0);
    if (isCheckpoint) await runCheckpoint();
    if (!DRY_RUN) await processPendingOrders();
    await managePositions(isCheckpoint);
    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    slog(`⚠️ tick: ${e.message}`);
  }
}

function buildSnapshot() {
  let openValue = 0, unrealizedPnl = 0;
  const openPositions = positions.filter(p => !p.resolved).map(p => {
    const m = marketCache[p.slug];
    const cp = m ? (p.side === 'up' ? m.upMid : m.downMid) : 0;
    const cv = fl2(p.size * cp);
    const upnl = fl2(cv - (p.size * p.entryPrice));
    openValue += cv; unrealizedPnl += upnl;
    return {
      id: p.id.slice(0, 12), pair: m ? m.pair : '?',
      side: p.side.toUpperCase(), entryPrice: fl4(p.entryPrice),
      currentPrice: fl4(cp), shares: p.size, cost: fl2(p.size * p.entryPrice),
      currentValue: cv, unrealizedPnl: upnl, peakPrice: fl4(p.peakPrice),
      checkpoints: p.cpCount, trailingActive: p.trailingActive,
    };
  });

  const allMarkets = Object.values(marketCache).filter(m => m.active).map(m => ({
    label: `${m.pair} 5m`, secondsToEnd: m.secondsToEnd,
    secondsSinceStart: m.windowS - m.secondsToEnd,
    upMid: fl4(m.upMid), dnMid: fl4(m.downMid),
    fairValue: fl4(m.fairValue), leader: m.checkpointData?.leader || '?', active: m.active,
  }));

  return {
    dryRun: DRY_RUN, balance: fl2(balance),
    openEquity: fl2(balance + openValue), startBalance: fl2(startBalance),
    pnl: fl2((balance + openValue) - startBalance),
    unrealizedPnl: fl2(unrealizedPnl), totalFeesPaid: fl2(totalFeesPaid),
    uptime: Math.floor((Date.now() - startTime) / 1000), tickCount,
    activeMarkets: allMarkets.length, openPositions,
    pendingOrders: pendingOrders.filter(p => !p.resolved).length,
    positionsCount: positions.filter(p => !p.resolved).length,
    totalTrades: recentTrades.length, recentTrades: recentTrades.slice(0, 40),
    activityLog: activityLog.slice(0, 60), allMarkets,
    strategy: {
      sharesPerLot: SHARES_PER_LOT, maxLots: MAX_LOTS,
      deviationThreshold: DEVIATION_THRESHOLD, trailingStopDist: TRAILING_STOP_DIST,
      hardStopDist: HARD_STOP_DIST, timeStopCp: TIME_STOP_CP, forceSellSecs: FORCE_SELL_SECS,
    },
  };
}

async function start(emit, log) {
  emitFn = emit || (() => {}); logFn = log || (() => {});
  startTime = Date.now(); balance = DEMO_BALANCE; startBalance = DEMO_BALANCE;
  if (!DRY_RUN && trader) {
    try {
      const realBal = await trader.getBalance();
      if (realBal > 0) { balance = realBal; startBalance = realBal; }
      slog(`💰 Real balance: $${fl2(balance)}`);
    } catch (e) { slog(`⚠️ Balance sync: ${e.message}`); }
  }
  slog(`🤖 Time-Decay v2 | ${TARGET_PAIRS.join(',')} 5m | lots:${SHARES_PER_LOT}x${MAX_LOTS} | dev:${DEVIATION_THRESHOLD} | trail:${TRAILING_STOP_DIST}`);
  if (!DRY_RUN) {
    try {
      trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
      trader.setLogFn(logFn); slog('🔑 Authenticating...'); await trader.authenticate();
      slog(`✅ Auth: ${trader.address}`);
    } catch (e) { slog(`❌ Auth: ${e.message}`); process.exit(1); }
  }
  slog(DRY_RUN ? '📋 DEMO mode' : '🔴 LIVE mode');
  setInterval(tick, TICK_MS);
}

function flushState() {
  positions = []; pendingOrders = []; recentTrades = [];
  activityLog = []; marketCache = {};
  tickCount = 0; startTime = Date.now();
  balance = DEMO_BALANCE; startBalance = DEMO_BALANCE; totalFeesPaid = 0;
}

async function setDryRun(val) {
  DRY_RUN = !!val; flushState();
  slog(DRY_RUN ? '📋 DEMO' : '🔴 LIVE');
}

function getDryRun() { return DRY_RUN; }

module.exports = { start, buildSnapshot, setDryRun, getDryRun };
