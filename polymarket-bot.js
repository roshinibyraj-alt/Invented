'use strict';

// ── Time-Decay Checkpoint Strategy for Polymarket BTC/ETH/SOL 5m ──────
// Every 25s: buy 100 shares of the cheapest side
// For lots held ≥25s: sell if in profit, buy 100 more if in loss (avg down)
// At 240s (4th min): force sell ALL, stop new entries

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS           = 100;
const DISCOVER_EVERY    = 300;   // ticks between market discovery
const WINDOW_SECS       = 300;   // 5 minutes
const CHECKPOINT_SECS   = 25;
const SHARES_PER_LOT    = 100;
const DEMO_BALANCE      = 2000;
const TAKER_FEE         = 0.003;
const STOP_ELAPSED      = 240;   // 4th minute — force sell all
const TARGET_PAIRS      = ['BTC', 'ETH', 'SOL'];

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
      pair: slug.startsWith('btc') ? 'BTC' : slug.startsWith('eth') ? 'ETH' : 'SOL',
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
  // Clean stale
  const expired = [];
  for (const [slug, m] of Object.entries(marketCache)) {
    if (Date.now() - m.endTime > 10000) expired.push(slug);
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

  // ── 4th minute: force sell ALL, stop ──
  // Check BEFORE cpIdx guard so we catch it even if cpIdx didn't change
  if (elapsed >= STOP_ELAPSED && !m.forceStopped) {
    m.forceStopped = true;
    await sellAllForMarket(m);
    slog(`\u23f9\ufe0f ${m.pair} force sold at ${elapsed}s`);
    return;
  }

  // Track history
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
    slog(`🟢 ${m.pair} window started — ${WINDOW_SECS}s remaining`);
  }

  if (m.forceStopped) return;

  // ── Step 1: Buy 100 shares of the cheapest side ──
  const cheaperSide = m.upMid <= m.downMid ? 'up' : 'dn';
  const cheaperPrice = cheaperSide === 'up' ? m.upMid : m.downMid;
  if (cheaperPrice > 0 && cheaperPrice < 0.99) {
    await buyShares(m, cheaperSide, SHARES_PER_LOT);
  }

  // ── Step 2: Check existing lots held ≥1 checkpoint ──
  const myLots = getPositionsForMarket(m.slug);
  for (const pos of myLots) {
    if (cpIdx - pos.checkpointIdx < 1) continue; // held less than 25s
    const mid = pos.side === 'up' ? m.upMid : m.downMid;
    if (!mid || mid <= 0) continue;

    if (mid > pos.entryPrice) {
      // In profit → sell (take profit)
      await sellPosition(pos, m);
      // Don't avg down after selling
    } else if (mid < pos.entryPrice) {
      // In loss → average down: buy another lot
      slog(`📉 ${m.pair} ${pos.side.toUpperCase()} dropping — averaging down @ $${fl4(mid)}`);
      await buyShares(m, pos.side, SHARES_PER_LOT);
    }
  }
}

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
      if (!m.active && !m.forceStopped && getPositionsForMarket(m.slug).length > 0) {
        // Market ended with open positions — force sell
        await sellAllForMarket(m);
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

    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    slog(`⚠️ tick: ${e.message}`);
  }
}

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
        time: new Date().toTimeString().slice(0, 8),
      });
    }
  }

  const activeMkts = Object.values(marketCache).filter(m => m.active || (!m.resolved && m.secondsToEnd > 0));

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
      const isUpDominant = m.upMid > m.downMid;
      const fairDominant  = fl4(0.50 + (elapsed / WINDOW_SECS) * 0.50);
      const fairLagging   = fl4(1.0 - fairDominant);
      return {
        label: `${m.pair} 5m`,
        elapsed: `${elapsed}s`,
        remaining: `${Math.max(0, m.secondsToEnd)}s`,
        upMid: fl4(m.upMid),
        dnMid: fl4(m.dnMid),
        spread: fl4(Math.abs((m.upMid || 0) - (m.downMid || 0))),
        checkpoint: `${cpIdx}/${cpTotal}`,
        dominantSide: isUpDominant ? 'UP' : 'DN',
        fairDominant,
        fairLagging,
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

  slog(`🤖 Time-Decay Bot | ${TARGET_PAIRS.join(',')} | ${WINDOW_SECS}s windows | ${CHECKPOINT_SECS}s checkpoints | ${SHARES_PER_LOT}sh/lot`);
  slog(`📐 Stop at ${STOP_ELAPSED}s — force sell all`);

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
