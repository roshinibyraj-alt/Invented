'use strict';

// ── Trend-Dip Strategy for Polymarket BTC/ETH 5m — buy leader on dip, trailing stop, no avg-down ──────
// Every 25s CP: buy leader on dip (dev>0.02), pyramid if profitable, trailing stop 0.015, force sell 210s
// For lots held ≥25s: sell if in profit, buy 100 more if in loss (avg down)
// At 240s (4th min): force sell ALL, stop new entries

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS           = 100;
const DISCOVER_EVERY    = 300;   // ticks between market discovery
const WINDOW_SECS       = 300;   // 5 minutes
const CHECKPOINT_SECS   = 25;
const SHARES_PER_LOT    = 300;   // 300 shares per lot
const DEMO_BALANCE      = 2000;
const TAKER_FEE         = 0.003;
const STOP_ELAPSED      = 270;   // 4.5 minutes — force sell all   // 4th minute — force sell all
const TARGET_PAIRS      = ['BTC', 'ETH'];

let DRY_RUN = true;
const KILL_SWITCH = process.env.KILL_SWITCH === 'true';

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
  const now  = Math.floor(Date.now() / 1000);
  const cur  = Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
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
let trader       = null;
let balance      = DEMO_BALANCE;
let startBalance = DEMO_BALANCE;
let totalFees    = 0;
let marketCache  = {};      // slug → market object
let positions    = [];      // { slug, side, entryPrice, shares, tickBought, checkpointIdx, lotId }
let recentTrades = [];
let activityLog  = [];
let tickCount    = 0;
let startTime    = Date.now();
let lotCounter   = 0;
let emitFn       = () => {};
let logFn        = () => {};

function slog(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  activityLog.unshift(`[${ts}] ${msg}`);
  if (activityLog.length > 200) activityLog.length = 200;
  logFn(msg);
}

function pushTrade(pair, side, action, entry, exit, shares, pnl, bal, reason) {
  recentTrades.unshift({
    ts: new Date().toTimeString().slice(0, 8),
    pair, side, action,
    entry: fl4(entry),
    exit: fl4(exit || 0),
    shares,
    pnl: fl2(pnl || 0),
    bal: fl2(bal),
    reason: reason || '',
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
      slug,
      pair: slug.startsWith('btc') ? 'BTC' : 'ETH',
      windowS: WINDOW_SECS,
      upTokenId: ids[0], downTokenId: ids[1],
      endTime, active: false, resolved: false,
      upMid: 0, downMid: 0,
      secondsToEnd: Math.floor((endTime - Date.now()) / 1000),
      lastCheckpointElapsed: -1,  // tracks which checkpoint we've processed
      started: false,
      forceStopped: false,
      upHistory: [],
      dnHistory: [],
    };
  }));
  // Clean stale + non-target pairs
  const expired = [];
  for (const [slug, m] of Object.entries(marketCache)) {
    if (Date.now() - m.endTime > 10000) expired.push(slug);
    else if (!slug.startsWith('btc') && !slug.startsWith('eth')) expired.push(slug);
  }
  for (const slug of expired) {
    delete marketCache[slug];
    positions = positions.filter(p => p.slug !== slug);
  }
}

// ── Position helpers ──
function getPositionsForMarket(slug) {
  return positions.filter(p => p.slug === slug);
}

async function buyShares(m, side, shares) {
  const mid = side === 'up' ? m.upMid : m.downMid;
  if (!mid || mid <= 0) return;

  const cost = fl2(shares * mid);
  const fee  = fl2(cost * TAKER_FEE);

  if (balance < cost + fee) {
    slog(`⚠️ ${m.pair} insufficient balance for ${side.toUpperCase()} buy $${cost}+fee`);
    return;
  }

  balance     = fl2(balance - cost - fee);
  totalFees   = fl4(totalFees + fee);
  const lotId = ++lotCounter;
  const elapsed = WINDOW_SECS - m.secondsToEnd;
  const cpIdx   = Math.floor(elapsed / CHECKPOINT_SECS);

  positions.push({
    slug: m.slug, pair: m.pair,
    side, entryPrice: mid, shares, cost,
    tickBought: tickCount,
    checkpointIdx: cpIdx,
    lotId,
    peakPrice: mid,
  });

  slog(`📥 BUY ${m.pair} ${side.toUpperCase()} x${shares} @ $${fl4(mid)} (-$${cost}) fee:$${fee} bal:$${fl2(balance)}`);

  // Place real order on CLOB
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  if (tokenId && !DRY_RUN) {
    try {
      const res = await trader.placeOrder(tokenId, 'BUY', mid, shares);
      if (res?.id) slog(`🔏 BUY ORDER id:${res.id}`);
    } catch (e) {
      slog(`❌ BUY failed: ${e.message}`);
      balance = fl2(balance + cost + fee);
      positions = positions.filter(p => p.lotId !== lotId);
    }
  }
}

async function sellPosition(pos, m) {
  const mid = pos.side === 'up' ? m.upMid : m.downMid;
  if (!mid || mid <= 0 || pos.shares <= 0) return;

  const proceeds = fl2(pos.shares * mid);
  const cost     = fl2(pos.shares * pos.entryPrice);
  const fee      = fl2(proceeds * TAKER_FEE);
  const pnl      = fl2(proceeds - cost);
  const netPnl   = fl2(pnl - (pos.cost ? fl2(pos.cost * TAKER_FEE) : 0) - fee);

  balance   = fl2(balance + proceeds - fee);
  totalFees = fl4(totalFees + fee);

  const reason = mid > pos.entryPrice ? 'TP' : 'STOP';
  slog(`📤 SELL ${pos.pair} ${pos.side.toUpperCase()} x${pos.shares} @ $${fl4(mid)} (+$${fl2(proceeds)}) fee:$${fee} pnl:$${fl2(netPnl)} | bal:$${fl2(balance)}`);
  pushTrade(pos.pair, pos.side.toUpperCase(), 'SELL', pos.entryPrice, mid, pos.shares, netPnl, balance, reason);

  // Place real sell on CLOB
  const tokenId = pos.side === 'up' ? m.upTokenId : m.downTokenId;
  if (tokenId && !DRY_RUN) {
    try {
      const res = await trader.placeOrder(tokenId, 'SELL', mid, pos.shares);
      if (res?.id) slog(`🔏 SELL ORDER id:${res.id}`);
    } catch (e) {
      slog(`❌ SELL failed: ${e.message}`);
      balance = fl2(balance - proceeds + fee); // refund
    }
  }

  // Remove position
  positions = positions.filter(p => p.lotId !== pos.lotId);
}

async function sellAllForMarket(m) {
  const lots = getPositionsForMarket(m.slug);
  for (const pos of lots) {
    await sellPosition(pos, m);
  }
  if (lots.length > 0) slog(`🏁 ${m.pair} — force sold ${lots.length} lots at 4th minute`);
}

// ── Checkpoint logic ──
async function processCheckpoint(m) {
  const elapsed = Math.max(0, WINDOW_SECS - m.secondsToEnd);
  const cpIdx   = Math.floor(elapsed / CHECKPOINT_SECS);

  // ── 4th minute force sell ──
  if (elapsed >= STOP_ELAPSED && !m.forceStopped) {
    m.forceStopped = true;
    await sellAllForMarket(m);
    slog(`\u23f9\ufe0f ${m.pair} force sold at ${elapsed}s`);
    return;
  }

  // Track price history for leader determination
  if (m.upMid > 0) {
    m.upHistory.push({ t: Date.now(), p: m.upMid });
    if (m.upHistory.length > 100) m.upHistory.shift();
  }
  if (m.downMid > 0) {
    m.dnHistory.push({ t: Date.now(), p: m.downMid });
    if (m.dnHistory.length > 100) m.dnHistory.shift();
  }

  // Already processed this checkpoint
  if (cpIdx === m.lastCheckpointElapsed) return;
  m.lastCheckpointElapsed = cpIdx;

  if (!m.started) {
    m.started = true;
    slog(`\U0001f7e2 ${m.pair} window started \u2014 ${WINDOW_SECS}s remaining`);
  }

  if (m.forceStopped) return;

  // ── Determine dominant side via MA over last checkpoints ──
  if (!m.leaderHistory) m.leaderHistory = [];
  m.leaderHistory.push({ cpIdx, up: m.upMid, dn: m.downMid, leader: m.upMid >= m.downMid ? 'up' : 'dn' });
  if (m.leaderHistory.length > 3) m.leaderHistory.shift();

  if (m.leaderHistory.length < 2) return; // need at least 2 checkpoints of history

  // Moving averages to smooth out noise
  const upMA = m.leaderHistory.reduce((s, h) => s + h.up, 0) / m.leaderHistory.length;
  const dnMA = m.leaderHistory.reduce((s, h) => s + h.dn, 0) / m.leaderHistory.length;
  const leaderSide = upMA >= dnMA ? 'up' : 'dn';

  // Fair value: dominant side trends 0.50 -> 1.00 over the window
  const leaderFair = 0.50 + (elapsed / WINDOW_SECS) * 0.50;
  const leaderPrice = leaderSide === 'up' ? m.upMid : m.downMid;

  // Dynamic threshold: wider as time passes (less time for reversion)
  const threshold = 0.02 + (elapsed / WINDOW_SECS) * 0.04; // 0.02 at t=0, 0.06 at t=300
  const deviation = leaderFair - leaderPrice; // positive = leader is underpriced = buy

  // Record analytics for dashboard
  m.leaderSide = leaderSide;
  m.leaderFair = fl4(leaderFair);
  m.deviation = fl4(deviation);
  m.threshold = fl4(threshold);

  if (deviation > 0) {
    slog(`\U0001f4ca ${m.pair} ${leaderSide.toUpperCase()} fair:$${fl4(leaderFair)} actual:$${fl4(leaderPrice)} dev:+${fl4(deviation)} thr:$${fl4(threshold)}`);
  }

  // ── Buy signal: leader dip below fair value + threshold met ──
  const myLots = getPositionsForMarket(m.slug);
  const lotsThisSide = myLots.filter(l => l.side === leaderSide);

  // Can buy if: under max lots, AND (no lot on this side OR all existing lots on this side are profitable)
  const canPyramid = lotsThisSide.length === 0 || lotsThisSide.every(l => {
    const lp = leaderSide === 'up' ? m.upMid : m.downMid;
    return lp > l.entryPrice;
  });
  if (deviation > threshold && myLots.length < 3 && canPyramid) {
    slog(`\U0001f4e3 ${m.pair} ${leaderSide.toUpperCase()} DIP! $${fl4(leaderPrice)} vs fair $${fl4(leaderFair)} (lots:${myLots.length})`);
    await buyShares(m, leaderSide, SHARES_PER_LOT);
  }

  // ── Time exit: held 5+ CPs (125s+), get out regardless ──
  for (const pos of myLots) {
    if (cpIdx - pos.checkpointIdx < 5) continue;
    const mid = pos.side === 'up' ? m.upMid : m.downMid;
    if (!mid || mid <= 0) continue;
    slog(`\u23f0 ${m.pair} ${pos.side.toUpperCase()} time @ $${fl4(mid)} (${cpIdx - pos.checkpointIdx}CPs)`);
    await sellPosition(pos, m);
  }
}

// ── Main tick ──
// ── Main tick ──
async function tick() {
  try {
    tickCount++;
    if (tickCount === 1 || tickCount % DISCOVER_EVERY === 0) {
      await discoverMarkets();
    }

    // Update prices and check checkpoints for each active market
    await Promise.allSettled(Object.values(marketCache).map(async m => {
      const now = Date.now();
      m.secondsToEnd = Math.floor((m.endTime - now) / 1000);
      m.active = !m.resolved && m.secondsToEnd > 0 && m.secondsToEnd <= m.windowS;

      if (m.secondsToEnd < -5 && !m.resolved) {
        m.resolved = true;
        m.active = false;
        return;
      }
      // Always fetch prices (even for upcoming markets) so dashboard shows live prices
      const [upR, dnR] = await Promise.all([
        getJson(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
        getJson(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
      ]);
      if (upR?.mid) m.upMid   = fl4(parseFloat(upR.mid));
      if (dnR?.mid) m.downMid = fl4(parseFloat(dnR.mid));

      if (!m.active && !m.forceStopped && getPositionsForMarket(m.slug).length > 0) {
        // Market ended with open positions — force sell
        await sellAllForMarket(m);
        return;
      }
      if (!m.active && m.secondsToEnd <= 0) return;
      // For upcoming markets (secondsToEnd > 300), we still show prices but skip trading
      if (!m.active && m.secondsToEnd > m.windowS) {
        // Just emit snapshot, don't process checkpoints
        return;
      }

      const elapsed = Math.max(0, WINDOW_SECS - m.secondsToEnd);

      // ── 4th minute stop — check every tick ──
      if (elapsed >= STOP_ELAPSED && !m.forceStopped) {
        m.forceStopped = true;
        const lots = getPositionsForMarket(m.slug);
        if (lots.length > 0) {
          await sellAllForMarket(m);
          slog(`\u23f9\ufe0f ${m.pair} force sold at ${elapsed}s (4th minute)`);
        }
      }

      // Process checkpoint if it's time
      const cpIdx   = Math.floor(elapsed / CHECKPOINT_SECS);
      if (cpIdx > (m.lastCheckpointElapsed || -1) && cpIdx >= 1 && m.upMid > 0 && m.downMid > 0) {
        await processCheckpoint(m);
      }
    }));

    // ── Tick-level exit checks (every 100ms, not just at checkpoints) ──
    // This makes trailing/hard stops reactive instead of waiting 25s
    for (const pos of [...positions]) {
      const m = marketCache[pos.slug];
      if (!m || m.resolved) continue;
      const mid = pos.side === 'up' ? m.upMid : m.downMid;
      if (!mid || mid <= 0) continue;

      // Update peak every tick
      if (!pos.peakPrice) pos.peakPrice = pos.entryPrice;
      if (mid > pos.peakPrice) pos.peakPrice = mid;

      const trailDrop = pos.peakPrice - mid;
      const fromEntry = pos.entryPrice - mid;

      // Skip min hold for exit check (exits are reactive, not time-gated)
      // Trailing stop: 0.015 from peak (tight — captures gains, protects profits)
      if (trailDrop >= 0.015 && mid > 0.01) {
        slog(`\U0001f4aa ${m.pair} ${pos.side.toUpperCase()} trail @ $${fl4(mid)} (peak:$${fl4(pos.peakPrice)}, -$${fl2(trailDrop)})`);
        await sellPosition(pos, m);
      }
      // Hard stop: safety net if price gaps past trail
      else if (fromEntry >= 0.08 && mid > 0.01) {
        slog(`\U0001f6d1 ${m.pair} ${pos.side.toUpperCase()} stop @ $${fl4(mid)} (entry:$${fl4(pos.entryPrice)}, -$${fl2(fromEntry)})`);
        await sellPosition(pos, m);
      }
    }

    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    slog(`⚠️ tick: ${e.message}`);
  }
}

// ── Independent price refresh (every 1s) to keep dashboard live ──
setInterval(async () => {
  try {
    const promises = [];
    for (const m of Object.values(marketCache)) {
      if (!m.resolved && m.upTokenId && m.downTokenId) {
        promises.push(
          (async () => {
            try {
              const [upR, dnR] = await Promise.all([
                getJson(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
                getJson(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
              ]);
              if (upR?.mid) m.upMid   = fl4(parseFloat(upR.mid));
              if (dnR?.mid) m.downMid = fl4(parseFloat(dnR.mid));
            } catch (_) {}
          })()
        );
      }
    }
    await Promise.allSettled(promises);
  } catch (_) {}
}, 1000);

// ── Snapshot ──
function buildSnapshot() {
  const openPosLots = [...positions];
  const byMarket = {};
  for (const p of openPosLots) {
    const m = marketCache[p.slug];
    const mid = m ? (p.side === 'up' ? m.upMid : m.downMid) : 0;
    byMarket[p.slug] = byMarket[p.slug] || { pair: p.pair, lots: [], totalCost: 0, totalValue: 0 };
    byMarket[p.slug].lots.push(p);
    byMarket[p.slug].totalCost = fl2(byMarket[p.slug].totalCost + (p.shares * p.entryPrice));
    byMarket[p.slug].totalValue = fl2(byMarket[p.slug].totalValue + (p.shares * mid));
  }

  let openValue = 0;
  const posDisplay = [];
  for (const [slug, ms] of Object.entries(byMarket)) {
    const m = marketCache[slug];
    const elapsed = m ? Math.max(0, WINDOW_SECS - m.secondsToEnd) : 0;
    const cpIdx = Math.floor(elapsed / CHECKPOINT_SECS);
    openValue += ms.totalValue;
    for (const lot of ms.lots) {
      const mkt = marketCache[slug];
      const cur = mkt ? (lot.side === 'up' ? mkt.upMid : mkt.downMid) : 0;
      posDisplay.push({
        pair: lot.pair,
        side: lot.side.toUpperCase(),
        entryPrice: fl4(lot.entryPrice),
        currentPrice: fl4(cur),
        shares: lot.shares,
        cost: fl2(lot.shares * lot.entryPrice),
        currentValue: fl2(lot.shares * cur),
        unrealizedPnl: fl2((lot.shares * cur) - (lot.shares * lot.entryPrice)),
        checkpointsHeld: cpIdx - lot.checkpointIdx,
        lotId: lot.lotId,
        peakPrice: fl4(lot.peakPrice || lot.entryPrice),
        trailDrop: fl4(Math.max(0, (lot.peakPrice || lot.entryPrice) - cur)),
        time: new Date().toTimeString().slice(0, 8),
      });
    }
  }

  const activeMkts = Object.values(marketCache).filter(m => !m.resolved && m.secondsToEnd > -300);

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
    targetPairs: TARGET_PAIRS,
    openPositions: posDisplay,
    openLotCount: openPosLots.length,
    recentTrades: recentTrades.slice(0, 40),
    activityLog: activityLog.slice(0, 60),
    allMarkets: activeMkts.map(m => {
      const elapsed = Math.max(0, WINDOW_SECS - m.secondsToEnd);
      const cpIdx = Math.floor(elapsed / CHECKPOINT_SECS);
      const cpTotal = Math.floor(WINDOW_SECS / CHECKPOINT_SECS);
      // Time decay fair value estimate
      return {
        label: `${m.pair} 5m`,
        elapsed: `${elapsed}s`,
        remaining: `${Math.max(0, m.secondsToEnd)}s`,
        upMid: fl4(m.upMid),
        dnMid: fl4(m.dnMid),
        spread: fl4(Math.abs((m.upMid || 0) - (m.downMid || 0))),
        checkpoint: `${cpIdx}/${cpTotal}`,
        dominantSide: (m.leaderSide || (m.upMid >= m.downMid ? 'UP' : 'DN')).toUpperCase(),
        fairDominant: m.leaderFair || 0.50,
        fairLagging: m.leaderFair ? fl4(1.0 - m.leaderFair) : 0.50,
        deviation: m.deviation || 0,
        threshold: m.threshold || 0.04,
        active: m.active,
        stopped: m.forceStopped,
        lots: getPositionsForMarket(m.slug).length,
      };
    }),
    config: {
      windowSecs: WINDOW_SECS,
      checkpointSecs: CHECKPOINT_SECS,
      sharesPerLot: SHARES_PER_LOT,
      stopElapsed: STOP_ELAPSED,
      demoBalance: DEMO_BALANCE,
      takerFee: TAKER_FEE,
    },
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
  positions = [];
  recentTrades = [];
  activityLog = [];

  slog(`🤖 Trend-Dip Bot | ${TARGET_PAIRS.join(',')} | ${WINDOW_SECS}s windows | dev:0.04→0.08 | trail:0.03 stop:0.05`);
  slog(`📐 Max lots: 3 | Trail: 0.015 | Threshold: 0.02→0.06 | Pyramid same-side | Force: ${STOP_ELAPSED}s`);

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
  positions = [];
  recentTrades = [];
  activityLog = [];
  marketCache = {};
  tickCount = 0;
  startTime = Date.now();
  balance = DEMO_BALANCE;
  totalFees = 0;
  lotCounter = 0;
}

async function setDryRun(val) {
  const wasDryRun = DRY_RUN;
  DRY_RUN = !!val;
  flushState();

  if (wasDryRun && !DRY_RUN && !trader) {
    try {
      trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
      trader.setLogFn(logFn);
      slog('🔑 Authenticating...');
      const authResult = await trader.authenticate();
      if (!authResult) throw new Error('auth returned empty');
      slog(`✅ Authenticated: ${trader.address}`);
    } catch (e) {
      slog(`❌ Auth failed: ${e.message}`);
      DRY_RUN = true;
      slog('↩️ Reverted to PAUSED — auth failed');
    }
  }

  if (DRY_RUN) slog('📋 PAUSED — monitoring only');
  else slog('🔴 LIVE — real Polymarket orders');
}

function getDryRun() { return DRY_RUN; }

module.exports = { start, buildSnapshot, setDryRun, getDryRun };
