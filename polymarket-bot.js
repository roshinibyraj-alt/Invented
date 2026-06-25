'use strict';
// ── Gabagool Grid Bot v9 ──────────────────────────────────────────────────────
// BTC 5m binary markets. Fixed 8-level MOMENTUM LONG grid.
// TRUE opposite of v7 (mean-reversion buy-the-dip):
//
// v7: Fill when mid FALLS to level → TP above entry (bet on recovery)
// v9: Fill when mid RISES to level → TP above entry (bet on continuation)
//
// ENTRY  : Limit BUY at 0.15 / 0.25 / 0.35 / 0.45 / 0.55 / 0.65 / 0.75 / 0.85
//          Fills when mid RISES to ≥ level price  (buy the breakout)
//          $10 per level → shares = floor(10 / price), balance decreases at fill
//
// ON FILL (N shares bought at price P):
//   tpShares     = floor(N / 2)
//   runnerShares = N − tpShares
//   Limit SELL @ min(P + 0.15, 0.99)  for tpShares    ← Half-TP sell
//   Limit SELL @ 0.99                 for runnerShares ← Runner sell
//   STOP  SELL @ max(P − 0.15, 0.01)  for ALL remaining ← Stop-loss if reversal
//
// PULL-STOP: if highestMid seen ≥ 0.75 and current mid drops to ≤ 0.40
//            → market-sell ALL open long positions immediately (limit losses on reversal)
//
// CUTOFF : no new BUY orders when ≤ 30 s remain (the 4:30 mark)
//
// RESOLUTION: open longs at window end → pendingRes bucket,
//             polled every 10 s until Polymarket declares binary outcome.
//             WIN = market WINS (payout 1): receive $1/share → profit.
//             LOSS = market LOSES (payout 0): receive $0 → lose cost.
//
// DRY_RUN=true: real auth, $2000 simulated, no real orders placed.
//   BUY fills when mid ≥ level price.
//   SELL (TP) fills when mid ≥ tp price.
//   STOP fills when mid ≤ stop price.

const fs   = require('fs');
const path = require('path');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA      = 'https://gamma-api.polymarket.com';
const CLOB       = 'https://clob.polymarket.com';
const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_TMP  = path.join(__dirname, 'state.json.tmp');

let DRY_RUN           = process.env.DRY_RUN !== 'false';
const DRY_RUN_BALANCE = parseFloat(process.env.DRY_RUN_BALANCE || '2000');
const KILL_SWITCH     = process.env.KILL_SWITCH === 'true';

const TICK_MS           = 100;    // main loop interval
const DISCOVER_EVERY    = 300;    // ticks between market discovery sweeps (~30 s)
const PRICE_FETCH_EVERY = 3;      // price refresh every N ticks (~300 ms)
const MAX_EQUITY_POINTS = 2880;   // ~24 h at 30 s spacing
const RESOLUTION_MS     = 10_000; // check market resolution every 10 s

// ── Strategy constants ────────────────────────────────────────────────────────
const GRID_PRICES    = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85];
const BUDGET         = 4.50;   // $ spent buying per level per window
const TP_STEP        = 0.15;   // half-TP sell offset ABOVE entry price
const RUNNER_PRICE   = 0.99;   // runner sell target (near $1 = max profit)
const PULLBACK_HIGH  = 0.75;   // if highestMid rose to or above this...
const PULLBACK_LOW   = 0.40;   // ...and mid drops back to or below this → sell all longs
const CUTOFF_SECS    = 30;     // no new BUY orders in last 30 s of window

// ── Precision helpers ─────────────────────────────────────────────────────────
const fl2 = v => Math.round((v || 0) * 100) / 100;
const fl4 = v => Math.round((v || 0) * 10_000) / 10_000;

// Shares for $BUDGET at given price, minimum 1
function gridShares(price) {
  return Math.max(1, Math.floor(BUDGET / price));
}

// Half-TP sell price: entry + 0.15, capped at 0.99
function halfTpPrice(entry) {
  return parseFloat(Math.min(entry + TP_STEP, 0.99).toFixed(2));
}

// Stop-loss price: entry − 0.15, floored at 0.01
function stopPrice(entry) {
  return parseFloat(Math.max(entry - TP_STEP, 0.01).toFixed(2));
}

// Cost basis for a fraction of a group
function partCost(k, totalShares, totalCost) {
  return fl2((k / totalShares) * totalCost);
}

// ── Network helpers ───────────────────────────────────────────────────────────
async function getJson(url) {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 8_000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return r.json();
  } catch (_) { return null; }
}

function mktLabel(slug) {
  if (slug.startsWith('btc-updown-5m-'))  return 'BTC 5m';
  if (slug.startsWith('eth-updown-5m-'))  return 'ETH 5m';
  return slug.slice(0, 16);
}

function generate5mSlugs() {
  const now = Math.floor(Date.now() / 1000);
  const ws  = 300;
  const cur = Math.floor(now / ws) * ws;
  return [-1, 0, 1, 2].map(d => `btc-updown-5m-${cur + d * ws}`);
}

// ── Runtime state ─────────────────────────────────────────────────────────────
let trader        = null;
let balance       = DRY_RUN ? DRY_RUN_BALANCE : 0;
let startBalance  = DRY_RUN ? DRY_RUN_BALANCE : 0;
let marketCache   = {};   // slug → market object
let tokenGrids    = {};   // `${slug}:${side}` → grid state
let pendingRes    = [];   // shares awaiting binary market resolution
let recentFills   = [];
let activityLog   = [];
let equityHistory = [];
let pendingRealOrders = {};  // orderId → { slug, side, dir, levelIdx, grpIdx, shares, price, status }
let tickCount     = 0;
let startTime     = Date.now();
let lastResCheck  = 0;
let emitFn        = () => {};
let logFn         = () => {};

function slog(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  activityLog.unshift(`[${ts}] ${msg}`);
  if (activityLog.length > 200) activityLog.length = 200;
  logFn(msg);
}

function pushFill(action, label, shares, price, pnl, bal) {
  recentFills.unshift({
    ts: new Date().toTimeString().slice(0, 8),
    action, label, shares,
    price: fl4(price),
    pnl:   fl2(pnl || 0),
    bal:   fl2(bal),
  });
  if (recentFills.length > 100) recentFills.length = 100;
}

// ── Grid data structures ──────────────────────────────────────────────────────
//
// level = {
//   price, tp, stop, initShares,
//   initialPlaced: bool,   ← initial buy has been submitted
//   buyPending:    bool,   ← a limit buy order is waiting
//   pendingShares: int,    ← shares for the current pending buy
//   groups: [group, ...]   ← one entry per filled buy
// }
//
// group = {
//   shares, cost,            ← total shares bought + dollar cost paid
//   tpShares, runnerShares,
//   tpFilled,  tpPnl,        ← half-TP sell leg
//   runnerFilled, runnerPnl, ← runner sell leg
//   stopFilled, stopPnl,     ← stop-loss sell (all remaining shares)
//   inResolution,            ← moved to pendingRes bucket
//   marketSold,              ← pulled out by emergency pull-stop sell
// }

function makeLevel(price) {
  const sh = gridShares(price);
  return {
    price,
    tp:            halfTpPrice(price),
    stop:          stopPrice(price),
    initShares:    sh,
    initialPlaced: false,
    buyPending:    false,
    pendingShares: sh,
    buyOrderId:    null,
    groups:        [],
  };
}

function makeGrid(slug, side) {
  return {
    slug, side,
    key:           `${slug}:${side}`,
    levels:        GRID_PRICES.map(makeLevel),
    highestMid:    0,     // track highest mid seen this window
    pullbackDone:  false,
    noMoreEntries: false,
    settled:       false,
    realizedPnl:   0,
    wins:          0,
    losses:        0,
  };
}

function getGrid(slug, side) {
  const key = `${slug}:${side}`;
  if (!tokenGrids[key]) tokenGrids[key] = makeGrid(slug, side);
  return tokenGrids[key];
}

// ── Real-order management (live mode only) ────────────────────────────────────

async function placeRealBuy(g, lv, tokenId, label) {
  const sh   = lv.initShares;
  const cost = fl2(sh * lv.price);
  balance    = fl2(balance - cost);
  try {
    const res = await trader.placeOrder(tokenId, 'BUY', lv.price, sh);
    if (!res?.id) throw new Error('no order ID');
    lv.buyPending    = true;
    lv.pendingShares = sh;
    lv.buyOrderId    = res.id;
    pendingRealOrders[res.id] = {
      slug: g.slug, side: g.side, dir: 'buy',
      levelIdx: g.levels.indexOf(lv), grpIdx: -1,
      shares: sh, price: lv.price, status: 'open',
    };
    slog(`🔏 BUY ORDER ${label} @${lv.price} | ${sh}sh id:${res.id}`);
  } catch (e) {
    balance = fl2(balance + cost);
    lv.initialPlaced = false;
    slog(`❌ BUY failed ${label} @${lv.price}: ${e.message}`);
  }
}

async function placeRealSell(tokenId, side, price, shares, slug, levelIdx, grpIdx, dir) {
  try {
    const res = await trader.placeOrder(tokenId, 'SELL', price, shares);
    if (!res?.id) throw new Error('no order ID');
    pendingRealOrders[res.id] = { slug, side, dir, levelIdx, grpIdx, shares, price, status: 'open' };
    return res.id;
  } catch (e) {
    slog(`❌ SELL order failed dir:${dir} @${price}: ${e.message}`);
    return null;
  }
}

function cancelRealOrder(orderId) {
  const po = pendingRealOrders[orderId];
  if (!po || po.status !== 'open') return;
  po.status = 'cancelling';
  trader?.cancelOrder(orderId).catch(() => {});
}

async function checkRealFills() {
  if (DRY_RUN || !trader) return;
  let openOrders;
  try { openOrders = await trader.getOpenOrders(); } catch (_) { return; }
  const openIds = new Set((openOrders || []).map(o => o.id));
  let changed = false;

  for (const [orderId, po] of Object.entries(pendingRealOrders)) {
    if (openIds.has(orderId)) continue;

    if (po.status === 'cancelling') {
      if (po.dir === 'buy') balance = fl2(balance + po.shares * po.price);
      delete pendingRealOrders[orderId];
      continue;
    }
    if (po.status !== 'open') continue;

    po.status = 'filled';
    const g   = tokenGrids[`${po.slug}:${po.side}`];
    if (!g) { delete pendingRealOrders[orderId]; continue; }
    const lv  = g.levels[po.levelIdx];
    if (!lv)  { delete pendingRealOrders[orderId]; continue; }
    const m       = marketCache[po.slug];
    const tokenId = po.side === 'up' ? m?.upTokenId : m?.downTokenId;
    const label   = `${mktLabel(po.slug)} ${po.side.toUpperCase()}`;

    if (po.dir === 'buy') {
      const sh     = po.shares;
      const cost   = fl2(sh * po.price);
      const tpSh   = Math.floor(sh / 2);
      const runSh  = sh - tpSh;
      const grpIdx = lv.groups.length;
      lv.groups.push({
        shares: sh, cost, tpShares: tpSh, runnerShares: runSh,
        tpFilled: false, tpPnl: 0, runnerFilled: false, runnerPnl: 0,
        stopFilled: false, stopPnl: 0, inResolution: false, marketSold: false,
        tpOrderId: null, runnerOrderId: null, stopOrderId: null,
      });
      lv.buyPending = false;
      lv.buyOrderId = null;
      slog(`📤 BUY ${label} @${fl4(lv.price)} | ${sh}sh (-$${fl2(cost)}) → TP:${fl4(lv.tp)} Runner:${RUNNER_PRICE} Stop:${fl4(lv.stop)} | bal:$${fl2(balance)}`);
      pushFill('BUY', label, sh, lv.price, 0, balance);
      changed = true;
      if (tokenId) {
        const grp = lv.groups[grpIdx];
        placeRealSell(tokenId, po.side, lv.tp, tpSh, po.slug, po.levelIdx, grpIdx, 'tp').then(id => { if (id) grp.tpOrderId = id; });
        placeRealSell(tokenId, po.side, RUNNER_PRICE, runSh, po.slug, po.levelIdx, grpIdx, 'runner').then(id => { if (id) grp.runnerOrderId = id; });
        placeRealSell(tokenId, po.side, lv.stop, sh, po.slug, po.levelIdx, grpIdx, 'stop').then(id => { if (id) grp.stopOrderId = id; });
      }

    } else if (po.dir === 'tp') {
      const grp = lv.groups[po.grpIdx];
      if (!grp) { delete pendingRealOrders[orderId]; continue; }
      const proceeds  = fl2(po.shares * lv.tp);
      const costBasis = partCost(po.shares, grp.shares, grp.cost);
      const pnl       = fl2(proceeds - costBasis);
      balance = fl2(balance + proceeds);
      g.realizedPnl = fl2(g.realizedPnl + pnl);
      grp.tpFilled = true; grp.tpPnl = pnl; grp.tpOrderId = null;
      if (pnl >= 0) g.wins++; else g.losses++;
      slog(`✅ HALF-TP ${label} @${fl4(lv.price)}→${fl4(lv.tp)} | ${po.shares}sh received:$${fl2(proceeds)} pnl:$${fl2(pnl)} bal:$${fl2(balance)}`);
      pushFill('HALF-TP', label, po.shares, lv.tp, pnl, balance);
      changed = true;
      if (grp.stopOrderId) { cancelRealOrder(grp.stopOrderId); grp.stopOrderId = null; }
      if (!grp.runnerFilled && tokenId) {
        placeRealSell(tokenId, po.side, lv.stop, grp.runnerShares, po.slug, po.levelIdx, po.grpIdx, 'stop').then(id => { if (id) grp.stopOrderId = id; });
      }

    } else if (po.dir === 'runner') {
      const grp = lv.groups[po.grpIdx];
      if (!grp) { delete pendingRealOrders[orderId]; continue; }
      const proceeds  = fl2(po.shares * RUNNER_PRICE);
      const costBasis = partCost(po.shares, grp.shares, grp.cost);
      const pnl       = fl2(proceeds - costBasis);
      balance = fl2(balance + proceeds);
      g.realizedPnl = fl2(g.realizedPnl + pnl);
      grp.runnerFilled = true; grp.runnerPnl = pnl; grp.runnerOrderId = null;
      if (pnl >= 0) g.wins++; else g.losses++;
      slog(`🚀 RUNNER ${label} @${fl4(lv.price)}→${RUNNER_PRICE} | ${po.shares}sh received:$${fl2(proceeds)} pnl:$${fl2(pnl)} bal:$${fl2(balance)}`);
      pushFill('RUNNER', label, po.shares, RUNNER_PRICE, pnl, balance);
      changed = true;
      if (grp.tpFilled && grp.stopOrderId) { cancelRealOrder(grp.stopOrderId); grp.stopOrderId = null; }

    } else if (po.dir === 'stop') {
      const grp = lv.groups[po.grpIdx];
      if (!grp || grp.stopFilled) { delete pendingRealOrders[orderId]; continue; }
      const proceeds  = fl2(po.shares * lv.stop);
      const costBasis = partCost(po.shares, grp.shares, grp.cost);
      const pnl       = fl2(proceeds - costBasis);
      balance = fl2(balance + proceeds);
      g.realizedPnl = fl2(g.realizedPnl + pnl);
      grp.stopFilled = true; grp.tpFilled = true; grp.runnerFilled = true;
      grp.stopPnl = pnl; grp.stopOrderId = null;
      if (pnl >= 0) g.wins++; else g.losses++;
      if (grp.tpOrderId)     { cancelRealOrder(grp.tpOrderId);     grp.tpOrderId = null; }
      if (grp.runnerOrderId) { cancelRealOrder(grp.runnerOrderId); grp.runnerOrderId = null; }
      slog(`🛑 STOP ${label} @${fl4(lv.price)}→${fl4(lv.stop)} | ${po.shares}sh received:$${fl2(proceeds)} pnl:$${fl2(pnl)} bal:$${fl2(balance)}`);
      pushFill('STOP', label, po.shares, lv.stop, pnl, balance);
      changed = true;
    }

    delete pendingRealOrders[orderId];
  }
  if (changed) { recordEquity(); saveState(); }
}

// ── State persistence ─────────────────────────────────────────────────────────
function saveState() {
  try {
    fs.writeFileSync(STATE_TMP, JSON.stringify({
      v: 9, savedAt: Date.now(),
      balance, startBalance,
      tokenGrids, pendingRes,
      equityHistory: equityHistory.slice(-MAX_EQUITY_POINTS),
      recentFills:   recentFills.slice(0, 100),
      activityLog:   activityLog.slice(0, 200),
    }), 'utf8');
    fs.renameSync(STATE_TMP, STATE_FILE);
  } catch (e) { logFn(`⚠️  saveState: ${e.message}`); }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!data || data.v !== 9) return false;
    const age = Math.floor((Date.now() - (data.savedAt || 0)) / 1000);
    balance       = typeof data.balance      === 'number' ? data.balance      : balance;
    startBalance  = typeof data.startBalance === 'number' ? data.startBalance : startBalance;
    tokenGrids    = (data.tokenGrids && typeof data.tokenGrids === 'object') ? data.tokenGrids : {};
    pendingRes    = Array.isArray(data.pendingRes)    ? data.pendingRes    : [];
    equityHistory = Array.isArray(data.equityHistory) ? data.equityHistory : [];
    recentFills   = Array.isArray(data.recentFills)   ? data.recentFills   : [];
    activityLog   = Array.isArray(data.activityLog)   ? data.activityLog   : [];
    slog(`♻️  Restored v9 | age:${age}s | bal:$${fl2(balance)} | grids:${Object.keys(tokenGrids).length} | res:${pendingRes.length}`);
    return true;
  } catch (e) {
    slog(`⚠️  loadState: ${e.message}`);
    return false;
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetState() {
  balance       = DRY_RUN_BALANCE;
  startBalance  = DRY_RUN_BALANCE;
  tokenGrids    = {};
  pendingRes    = [];
  recentFills   = [];
  activityLog   = [];
  equityHistory = [];
  tickCount     = 0;
  startTime     = Date.now();
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
  saveState();
  slog(`🔄 Reset → bal:$${fl2(balance)}`);
}

// ── Market discovery ──────────────────────────────────────────────────────────
async function discoverMarkets() {
  await Promise.allSettled(generate5mSlugs().map(async slug => {
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
      slug, windowS: 300,
      upTokenId: ids[0], downTokenId: ids[1],
      endTime, active: false, resolved: false, hasClob: false,
      upMid: 0, downMid: 0,
      secondsToEnd: Math.floor((endTime - Date.now()) / 1000),
      resolution: null,
    };
    slog(`📡 Discovered: ${slug}`);
  }));
}

// ── Resolution poller ─────────────────────────────────────────────────────────
// Polymarket UP/DN binary markets resolve via UMA.
//
// Detection:  mk.umaResolutionStatus === 'resolved'
// Outcome:    mk.outcomePrices = ["1","0"] or ["0","1"]
//               outcomePrices[0] = UP token payout  (1 if UP won, 0 if DOWN won)
//               outcomePrices[1] = DN token payout  (1 if DOWN won, 0 if UP won)
async function checkResolution() {
  if (pendingRes.length === 0) return;
  const now = Date.now();
  if (now - lastResCheck < RESOLUTION_MS) return;
  lastResCheck = now;

  const unresolved = pendingRes.filter(r => !r.resolved);
  if (unresolved.length === 0) return;

  const slugsToCheck = [...new Set(unresolved.map(r => r.slug))];

  for (const slug of slugsToCheck) {
    const d = await getJson(`${GAMMA}/events?slug=${slug}`);
    if (!Array.isArray(d) || !d[0]?.markets?.[0]) continue;
    const mk = d[0].markets[0];

    if (mk.umaResolutionStatus !== 'resolved') continue;

    let prices;
    try {
      prices = Array.isArray(mk.outcomePrices)
        ? mk.outcomePrices.map(Number)
        : JSON.parse(mk.outcomePrices).map(Number);
    } catch (_) { continue; }

    if (!Array.isArray(prices) || prices.length < 2) continue;
    const upPayout = prices[0];   // 1.0 if UP won, 0.0 if DOWN won
    const dnPayout = prices[1];   // 1.0 if DOWN won, 0.0 if UP won

    if (isNaN(upPayout) || isNaN(dnPayout)) continue;

    let changed = false;
    for (const r of pendingRes) {
      if (r.slug !== slug || r.resolved) continue;

      // LONG positions: we PAID cost at buy time, now RECEIVE the payout
      // WIN  = market WINS (payout 1) — receive $1/share, profit = $1/sh - cost/sh
      // LOSS = market LOSES (payout 0) — receive $0, lose full cost
      const payoutPerShare = r.side === 'up' ? upPayout : dnPayout;
      const proceeds = fl2(payoutPerShare * r.shares);  // received at resolution
      const pnl      = fl2(proceeds - r.cost);          // received − paid

      // In live mode balance is synced from chain — don't double-count
      if (DRY_RUN) { balance += proceeds; balance = fl2(balance); }
      r.resolved   = true;
      r.outcome    = payoutPerShare === 1 ? 'WIN' : 'LOSS';
      r.proceeds   = proceeds;
      r.pnl        = pnl;
      r.resolvedAt = Date.now();

      const sign = pnl >= 0 ? '+' : '';
      slog(`🏁 RESOLVED ${r.outcome} BUY ${r.label} @${fl4(r.levelPrice)} | ${r.shares}sh paid:$${fl2(r.cost)} received:$${fl2(proceeds)} pnl:${sign}$${fl2(pnl)} bal:$${fl2(balance)}`);
      pushFill('RESOLVE', r.label, r.shares, payoutPerShare, pnl, balance);
      changed = true;
    }
    if (changed) { recordEquity(); saveState(); }
  }
}

// ── Window expiry → push all unsold longs to resolution bucket ───────────────
function expireGrid(m, side) {
  const g = getGrid(m.slug, side);
  if (g.settled) return;
  g.settled       = true;
  g.noMoreEntries = true;
  const label   = `${mktLabel(m.slug)} ${side.toUpperCase()}`;
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;

  for (const lv of g.levels) {
    lv.buyPending = false;  // cancel pending buy orders (no cash impact, never filled)
    for (const grp of lv.groups) {
      if (grp.marketSold) continue;

      // Collect unsold shares
      let leftSh   = 0;
      let leftCost = 0;

      if (!grp.tpFilled && !grp.stopFilled) {
        leftSh   += grp.tpShares;
        leftCost += partCost(grp.tpShares, grp.shares, grp.cost);
      }
      if (!grp.runnerFilled && !grp.stopFilled && !grp.inResolution) {
        leftSh   += grp.runnerShares;
        leftCost += partCost(grp.runnerShares, grp.shares, grp.cost);
      }

      if (leftSh <= 0) continue;

      grp.inResolution = true;
      grp.tpFilled     = true;
      grp.runnerFilled = true;

      pendingRes.push({
        slug:       m.slug,
        side,
        tokenId,
        label,
        levelPrice: lv.price,
        shares:     leftSh,
        cost:       leftCost,   // amount PAID at buy time
        resolved:   false,
        outcome:    null,
        proceeds:   0,
        pnl:        0,
        resolvedAt: null,
      });
      slog(`⏳ PENDING_RES BUY ${label} @${fl4(lv.price)} | ${leftSh}sh paid:$${fl2(leftCost)}`);
    }
  }
  saveState();
}

// ── Grid tick: one token, one market ─────────────────────────────────────────
async function gridTick(m, side) {
  if (KILL_SWITCH) return;

  const mid   = side === 'up' ? m.upMid    : m.downMid;
  const label = `${mktLabel(m.slug)} ${side.toUpperCase()}`;

  if (!mid) return;

  const g = getGrid(m.slug, side);
  if (g.settled) return;

  // Track highest mid seen this window
  if (mid > g.highestMid) g.highestMid = mid;

  // Apply 4:30 cutoff
  if (m.secondsToEnd <= CUTOFF_SECS) g.noMoreEntries = true;

  let changed = false;

  // ─────────────────────────────────────────────────────────────────────────
  // PULL-STOP (momentum reversal guard)
  // If mid ever rose HIGH (≥ 0.75) and has now FALLEN back to ≤ 0.40,
  // the momentum has reversed — sell ALL open long positions at current mid.
  // ─────────────────────────────────────────────────────────────────────────
  if (!g.pullbackDone && g.highestMid >= PULLBACK_HIGH && mid <= PULLBACK_LOW) {
    g.pullbackDone  = true;
    g.noMoreEntries = true;

    let totalSh = 0, totalCost = 0, totalProceeds = 0;

    for (const lv of g.levels) {
      lv.initialPlaced = true;
      // Cancel pending buy order (live)
      if (!DRY_RUN && lv.buyOrderId) { cancelRealOrder(lv.buyOrderId); lv.buyOrderId = null; }
      lv.buyPending    = false;

      for (const grp of lv.groups) {
        if (grp.marketSold || grp.inResolution) continue;

        // Cancel any live sell orders on this group so we can re-sell at current mid
        if (!DRY_RUN) {
          if (grp.tpOrderId)     { cancelRealOrder(grp.tpOrderId);     grp.tpOrderId     = null; }
          if (grp.runnerOrderId) { cancelRealOrder(grp.runnerOrderId); grp.runnerOrderId = null; }
          if (grp.stopOrderId)   { cancelRealOrder(grp.stopOrderId);   grp.stopOrderId   = null; }
        }

        let leftSh   = 0;
        let leftCost = 0;

        if (!grp.tpFilled && !grp.stopFilled) {
          leftSh   += grp.tpShares;
          leftCost += partCost(grp.tpShares, grp.shares, grp.cost);
        }
        if (!grp.runnerFilled && !grp.stopFilled) {
          leftSh   += grp.runnerShares;
          leftCost += partCost(grp.runnerShares, grp.shares, grp.cost);
        }

        if (leftSh > 0) {
          if (DRY_RUN) {
            // Simulate immediate sell at current mid
            const proceeds = fl2(leftSh * mid);
            const pnl      = fl2(proceeds - leftCost);
            balance       = fl2(balance + proceeds);
            g.realizedPnl = fl2(g.realizedPnl + pnl);
            totalProceeds += proceeds;
          }
          grp.tpFilled     = true;
          grp.runnerFilled = true;
          grp.stopFilled   = true;
          grp.marketSold   = true;
          totalSh   += leftSh;
          totalCost += leftCost;

          // Live: post an aggressive limit sell at current mid to exit
          if (!DRY_RUN) {
            const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
            placeRealSell(tokenId, side, mid, leftSh, g.slug, g.levels.indexOf(lv), lv.groups.indexOf(grp), 'stop')
              .catch(e => slog(`❌ PULL-STOP sell: ${e.message}`));
          }
        }
      }
    }

    const totalPnl = fl2(totalProceeds - totalCost);
    slog(`⚠️  PULL-STOP ${label} | high:${fl4(g.highestMid)} now:${fl4(mid)} | ${totalSh}sh pnl:$${fl2(totalPnl)} bal:$${fl2(balance)}`);
    pushFill('PULL-STOP', label, totalSh, mid, totalPnl, balance);
    changed = true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PROCESS EACH GRID LEVEL
  // ─────────────────────────────────────────────────────────────────────────
  for (const lv of g.levels) {

    // ── 1. Check if pending BUY fills (DRY_RUN only — live fills come from checkRealFills) ──
    if (DRY_RUN && lv.buyPending && mid >= lv.price) {
      const sh   = lv.pendingShares;
      const cost = fl2(sh * lv.price);   // amount PAID
      const tpSh = Math.floor(sh / 2);
      const runSh = sh - tpSh;

      // Budget check
      if (balance < cost + 200) {
        slog(`⚠️  SKIP BUY ${label} @${lv.price} — balance low ($${fl2(balance)})`);
        lv.buyPending = false;
      } else {
        balance = fl2(balance - cost);   // PAY for the tokens
        lv.buyPending = false;

        lv.groups.push({
          shares:        sh,
          cost,           // amount PAID at buy time
          tpShares:      tpSh,
          runnerShares:  runSh,
          tpFilled:      false,
          tpPnl:         0,
          runnerFilled:  false,
          runnerPnl:     0,
          stopFilled:    false,
          stopPnl:       0,
          inResolution:  false,
          marketSold:    false,
          tpOrderId:     null, runnerOrderId: null, stopOrderId: null,
        });

        slog(`📤 BUY ${label} @${fl4(lv.price)} | ${sh}sh (-$${fl2(cost)}) → TP:${fl4(lv.tp)} Runner:${RUNNER_PRICE} Stop:${fl4(lv.stop)} | bal:$${fl2(balance)}`);
        pushFill('BUY', label, sh, lv.price, 0, balance);
        changed = true;
      }
    }

    // ── 2. Check TP, Runner, and Stop on every open group (DRY_RUN only) ──
    if (DRY_RUN) {
    for (const grp of lv.groups) {
      if (grp.marketSold || grp.inResolution || grp.stopFilled) continue;

      // Half-TP sell: fires when mid ≥ tp price (price continues upward)
      if (!grp.tpFilled && mid >= lv.tp) {
        const proceeds  = fl2(grp.tpShares * lv.tp);
        const costBasis = partCost(grp.tpShares, grp.shares, grp.cost);
        const pnl       = fl2(proceeds - costBasis);

        balance       = fl2(balance + proceeds);
        g.realizedPnl = fl2(g.realizedPnl + pnl);
        grp.tpFilled  = true;
        grp.tpPnl     = pnl;
        if (pnl >= 0) g.wins++; else g.losses++;

        slog(`✅ HALF-TP ${label} @${fl4(lv.price)}→${fl4(lv.tp)} | ${grp.tpShares}sh received:$${fl2(proceeds)} pnl:$${fl2(pnl)} bal:$${fl2(balance)}`);
        pushFill('HALF-TP', label, grp.tpShares, lv.tp, pnl, balance);
        changed = true;
      }

      // Runner sell: fires when mid ≥ 0.99 (near $1 = maximum long profit)
      if (!grp.runnerFilled && mid >= RUNNER_PRICE) {
        const proceeds  = fl2(grp.runnerShares * RUNNER_PRICE);
        const costBasis = partCost(grp.runnerShares, grp.shares, grp.cost);
        const pnl       = fl2(proceeds - costBasis);

        balance          = fl2(balance + proceeds);
        g.realizedPnl    = fl2(g.realizedPnl + pnl);
        grp.runnerFilled = true;
        grp.runnerPnl    = pnl;
        if (pnl >= 0) g.wins++; else g.losses++;

        slog(`🚀 RUNNER ${label} @${fl4(lv.price)}→${RUNNER_PRICE} | ${grp.runnerShares}sh received:$${fl2(proceeds)} pnl:$${fl2(pnl)} bal:$${fl2(balance)}`);
        pushFill('RUNNER', label, grp.runnerShares, RUNNER_PRICE, pnl, balance);
        changed = true;
      }

      // Stop-loss: fires when mid ≤ stop price (momentum reversed, cut the loss)
      // Sells ALL remaining shares (tpShares if not yet sold, plus runnerShares)
      if (mid <= lv.stop) {
        let leftSh   = 0;
        let leftCost = 0;

        if (!grp.tpFilled) {
          leftSh   += grp.tpShares;
          leftCost += partCost(grp.tpShares, grp.shares, grp.cost);
        }
        if (!grp.runnerFilled) {
          leftSh   += grp.runnerShares;
          leftCost += partCost(grp.runnerShares, grp.shares, grp.cost);
        }

        if (leftSh > 0) {
          const proceeds = fl2(leftSh * lv.stop);
          const pnl      = fl2(proceeds - leftCost);

          balance          = fl2(balance + proceeds);
          g.realizedPnl    = fl2(g.realizedPnl + pnl);
          grp.stopFilled   = true;
          grp.tpFilled     = true;
          grp.runnerFilled = true;
          grp.stopPnl      = pnl;
          if (pnl >= 0) g.wins++; else g.losses++;

          slog(`🛑 STOP ${label} @${fl4(lv.price)}→${fl4(lv.stop)} | ${leftSh}sh received:$${fl2(proceeds)} pnl:$${fl2(pnl)} bal:$${fl2(balance)}`);
          pushFill('STOP', label, leftSh, lv.stop, pnl, balance);
          changed = true;
        }
      }
    }
    } // end if (DRY_RUN) for step 2

    // ── 3. Place initial BUY order (once per window per level) ───────────
    // DRY_RUN: queued silently, fills when mid rises to lv.price.
    // LIVE: posts a real GTC limit BUY on the CLOB.
    if (!lv.initialPlaced && !lv.buyPending && !g.noMoreEntries) {
      const cost = fl2(lv.initShares * lv.price);
      if (balance >= cost + (DRY_RUN ? 200 : 5)) {
        lv.initialPlaced = true;
        if (DRY_RUN) {
          lv.buyPending    = true;
          lv.pendingShares = lv.initShares;
        } else {
          const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
          placeRealBuy(g, lv, tokenId, label).catch(e => slog(`❌ placeRealBuy: ${e.message}`));
        }
      }
    }
  }

  if (changed) { recordEquity(); saveState(); }
}

// ── Per-market update ─────────────────────────────────────────────────────────
async function updateMarket(m, fetchPrice) {
  const now = Date.now();
  m.secondsToEnd = Math.floor((m.endTime - now) / 1000);
  m.active = !m.resolved && m.secondsToEnd > 0 && m.secondsToEnd <= m.windowS;

  if (m.secondsToEnd < -5 && !m.resolved) {
    m.resolved = true;
    m.active   = false;
    expireGrid(m, 'up');
    expireGrid(m, 'dn');
    return;
  }

  if (!m.active) return;

  if (fetchPrice) {
    const [upR, dnR] = await Promise.all([
      getJson(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
      getJson(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
    ]);
    if (upR?.mid) m.upMid   = fl4(parseFloat(upR.mid));
    if (dnR?.mid) m.downMid = fl4(parseFloat(dnR.mid));
    m.hasClob = m.upMid > 0 && m.downMid > 0;
  }

  if (!m.hasClob) return;

  await Promise.all([
    gridTick(m, 'up'),
    gridTick(m, 'dn'),
  ]);
}

// ── Equity tracking ───────────────────────────────────────────────────────────
//
// Float = balance + current market value of all held tokens
//
// LONG math:
//   balance already has −cost for every buy filled.
//   Outstanding asset value = mid × openShares (what you'd get selling now).
//   float = balance + holdingValueAtMid  →  mtmValue = +holdingValueAtMid
//
//   unrealizedPnl = holdingValueAtMid − totalCostPaid = (mid − entry) × shares
//   Positive when mid > entry (price has risen → longs in profit).
//
function computeOpenPositions() {
  let holdingValue = 0;   // total value of open positions at current mid
  let totalCost    = 0;   // total amount paid for open positions
  for (const g of Object.values(tokenGrids)) {
    const m   = marketCache[g.slug];
    const mid = m ? (g.side === 'up' ? m.upMid : m.downMid) : 0;
    if (!mid) continue;
    for (const lv of g.levels) {
      for (const grp of lv.groups) {
        if (grp.marketSold || grp.inResolution || grp.stopFilled) continue;
        if (!grp.tpFilled) {
          holdingValue += mid * grp.tpShares;
          totalCost    += lv.price * grp.tpShares;
        }
        if (!grp.runnerFilled) {
          holdingValue += mid * grp.runnerShares;
          totalCost    += lv.price * grp.runnerShares;
        }
      }
    }
  }
  return {
    mtmValue:      fl2(holdingValue),                    // positive: asset value
    openCost:      fl2(totalCost),                       // for display reference
    unrealizedPnl: fl2(holdingValue - totalCost),        // (mid − entry) × shares
  };
}

function recordEquity(force) {
  const { mtmValue } = computeOpenPositions();
  const v    = fl2(balance + mtmValue);
  const t    = Math.floor(Date.now() / 1000);
  const last = equityHistory[equityHistory.length - 1];
  if (force || !last || t - last.t >= 30 || Math.abs((last.v || 0) - v) > 0.01) {
    equityHistory.push({ t, v });
    if (equityHistory.length > MAX_EQUITY_POINTS) equityHistory.shift();
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────
async function tick() {
  try {
    tickCount++;
    if (tickCount === 1 || tickCount % DISCOVER_EVERY === 0) {
      await discoverMarkets();
    }
    const fetchPrice = (tickCount % PRICE_FETCH_EVERY === 0);
    await Promise.allSettled(Object.values(marketCache).map(m => updateMarket(m, fetchPrice)));
    await checkResolution();
    if (!DRY_RUN && tickCount % 50 === 0 && trader) {
      const rb = await trader.getBalance().catch(() => -1);
      if (rb > 0) balance = rb;
    }
    if (!DRY_RUN) await checkRealFills();
    if (tickCount === 1)              { recordEquity(true); saveState(); }
    else if (tickCount % 300 === 0)   { recordEquity();     saveState(); }
    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    slog(`⚠️  tick: ${e.message}`);
  }
}

// ── Snapshot for dashboard ────────────────────────────────────────────────────
function buildSnapshot() {
  const { mtmValue, unrealizedPnl } = computeOpenPositions();
  const floatingBal   = fl2(balance + mtmValue);

  const gridRealized  = fl2(Object.values(tokenGrids).reduce((s, g) => s + (g.realizedPnl || 0), 0));
  const resRealized   = fl2(pendingRes.filter(r => r.resolved).reduce((s, r) => s + (r.pnl || 0), 0));
  const realizedPnl   = fl2(gridRealized + resRealized);
  const activeMkts    = Object.values(marketCache).filter(m => m.active);

  const openPositions = [];
  for (const g of Object.values(tokenGrids)) {
    const m   = marketCache[g.slug];
    const mid = m ? (g.side === 'up' ? m.upMid : m.downMid) : 0;
    for (const lv of g.levels) {
      for (const grp of lv.groups) {
        if (grp.marketSold || grp.inResolution || grp.stopFilled) continue;
        if (!grp.tpFilled) {
          const cb = partCost(grp.tpShares, grp.shares, grp.cost);
          openPositions.push({
            label:      `${mktLabel(g.slug)} ${g.side.toUpperCase()}`,
            type:       'HALF-TP',
            entry:      lv.price,
            target:     lv.tp,
            shares:     grp.tpShares,
            mid:        fl4(mid),
            cost:       fl2(cb),
            unrealized: fl2((mid - lv.price) * grp.tpShares),
          });
        }
        if (!grp.runnerFilled) {
          const cb = partCost(grp.runnerShares, grp.shares, grp.cost);
          openPositions.push({
            label:      `${mktLabel(g.slug)} ${g.side.toUpperCase()}`,
            type:       'RUNNER',
            entry:      lv.price,
            target:     RUNNER_PRICE,
            shares:     grp.runnerShares,
            mid:        fl4(mid),
            cost:       fl2(cb),
            unrealized: fl2((mid - lv.price) * grp.runnerShares),
          });
        }
      }
    }
  }

  const gridStatus = [];
  const sortedGrids = Object.values(tokenGrids).sort((a, b) => {
    const aActive = !!marketCache[a.slug]?.active;
    const bActive = !!marketCache[b.slug]?.active;
    return aActive === bActive ? 0 : (aActive ? -1 : 1);
  });
  for (const g of sortedGrids) {
    const m        = marketCache[g.slug];
    const isActive = !!m?.active;
    if (!isActive && !g.settled) continue;
    if (g.settled && !isActive) {
      const hasAnyGroups = g.levels.some(lv => lv.groups.length > 0);
      if (!hasAnyGroups) continue;
    }
    const mid = m ? (g.side === 'up' ? m.upMid : m.downMid) : 0;
    gridStatus.push({
      label:         `${mktLabel(g.slug)} ${g.side.toUpperCase()}`,
      mid:           fl4(mid),
      highestMid:    fl4(g.highestMid),
      noMoreEntries: g.noMoreEntries,
      pullbackDone:  g.pullbackDone,
      settled:       g.settled,
      realizedPnl:   fl2(g.realizedPnl),
      wins:          g.wins,
      losses:        g.losses,
      secondsToEnd:  m?.secondsToEnd || 0,
      levels: g.levels.map(lv => ({
        price:         lv.price,
        tp:            lv.tp,
        stop:          lv.stop,
        initShares:    lv.initShares,
        initialPlaced: lv.initialPlaced,
        buyPending:    lv.buyPending,
        pendingShares: lv.pendingShares,
        groups: lv.groups.map(grp => ({
          shares:        grp.shares,
          cost:          fl2(grp.cost),
          tpShares:      grp.tpShares,
          runnerShares:  grp.runnerShares,
          tpFilled:      grp.tpFilled,
          tpPnl:         fl2(grp.tpPnl || 0),
          runnerFilled:  grp.runnerFilled,
          runnerPnl:     fl2(grp.runnerPnl || 0),
          stopFilled:    grp.stopFilled,
          stopPnl:       fl2(grp.stopPnl || 0),
          inResolution:  grp.inResolution,
          marketSold:    grp.marketSold || false,
        })),
      })),
    });
  }

  const resSummary = pendingRes.map(r => ({
    label:      r.label,
    levelPrice: r.levelPrice,
    shares:     r.shares,
    cost:       fl2(r.cost),
    resolved:   r.resolved,
    outcome:    r.outcome,
    proceeds:   fl2(r.proceeds || 0),
    pnl:        fl2(r.pnl || 0),
  }));

  const totalWins   = Object.values(tokenGrids).reduce((s, g) => s + (g.wins   || 0), 0);
  const totalLosses = Object.values(tokenGrids).reduce((s, g) => s + (g.losses || 0), 0);
  const totalTrades = totalWins + totalLosses;
  const winRate     = totalTrades > 0 ? fl2(totalWins / totalTrades * 100) : 0;

  return {
    dryRun:      DRY_RUN,
    balance:     fl2(balance),
    unrealizedPnl,
    floatingBal,
    realizedPnl,
    startBalance: fl2(startBalance),
    pnl:         fl2(floatingBal - startBalance),
    uptime:      Math.floor((Date.now() - startTime) / 1000),
    tickCount,
    totalTrades, totalWins, totalLosses, winRate,
    totalFeesPaid: 0,
    activeMarkets: activeMkts.length,
    openPositions,
    gridStatus,
    pendingRes: resSummary,
    allMarkets: activeMkts.map(m => ({
      label:        mktLabel(m.slug),
      secondsToEnd: m.secondsToEnd,
      upMid:        fl4(m.upMid),
      dnMid:        fl4(m.downMid),
    })),
    equityHistory,
    recentFills,
    activityLog,
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start(emit, log) {
  emitFn = emit || (() => {});
  logFn  = log  || (() => {});

  if (DRY_RUN) {
    slog(`📋 DRY RUN — $${DRY_RUN_BALANCE} simulated · real auth · no real orders`);
  } else {
    slog(`🔴 LIVE TRADING — real orders will be placed on Polymarket CLOB`);
  }
  slog(`🤖 Grid Bot v9 MOMENTUM | levels:[${GRID_PRICES.join(',')}] | $${BUDGET}/level | tp:+${TP_STEP} | stop:-${TP_STEP} | runner:${RUNNER_PRICE} | cutoff:${CUTOFF_SECS}s`);

  loadState();

  try {
    slog('🔑 Authenticating with Polymarket CLOB...');
    trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
    const info = await trader.authenticate();
    const addr = info?.address || info?.wallet || '(unknown)';
    slog(`✅ Authenticated: ${addr}`);
    if (info?.proxyWallet) slog(`💼 Deposit wallet: ${info.proxyWallet}`);
    slog(`✅ AUTH OK | wallet:${addr}`);
    if (!DRY_RUN) {
      const rb = await trader.getBalance().catch(() => -1);
      if (rb > 0) {
        balance = rb;
        startBalance = rb;
        slog(`💰 Live balance from chain: $${fl2(rb)}`);
      } else {
        slog(`⚠️  Could not fetch live balance — check POLYMARKET_PRIVATE_KEY and FUNDER_ADDRESS`);
      }
    }
  } catch (e) {
    slog(`⚠️  Auth: ${e.message}`);
  }

  setInterval(tick, TICK_MS);
}

function flushState() {
  tokenGrids        = {};
  pendingRes        = [];
  recentFills       = [];
  activityLog       = [];
  equityHistory     = [];
  marketCache       = {};
  pendingRealOrders = {};
  tickCount         = 0;
  startTime         = Date.now();
  lastResCheck      = 0;
  saveState();
}

function setDryRun(val) {
  DRY_RUN = !!val;
  // Always flush all grid/fill/market state when toggling — no sim ghosts in live mode
  flushState();

  if (DRY_RUN) {
    balance      = DRY_RUN_BALANCE;
    startBalance = DRY_RUN_BALANCE;
    slog('📋 Switched to DRY RUN — sim state cleared, starting fresh with $' + fl2(DRY_RUN_BALANCE));
  } else {
    balance      = 0;
    startBalance = 0;
    slog('🔴 Switched to LIVE — all sim state cleared, balance reset to $0');
    if (!process.env.POLYMARKET_PRIVATE_KEY) {
      slog('⛔ POLYMARKET_PRIVATE_KEY not set — live orders will fail. Set it in Replit Secrets.');
    }
    if (trader) {
      trader.getBalance().then(b => {
        if (b > 0) {
          balance = b; startBalance = b;
          slog(`💰 Live balance from chain: $${fl2(b)}`);
        } else {
          slog('⚠️  getBalance returned 0 — likely geo-blocked or no USDC in deposit wallet.');
          slog('   → Set HTTPS_PROXY env var to a non-US proxy (e.g. EU) and restart.');
        }
      }).catch(e => {
        slog(`⚠️  getBalance failed: ${e.message}`);
        slog('   → Polymarket CLOB is geo-blocked from US servers. Set HTTPS_PROXY to a non-US proxy and restart.');
      });
    } else {
      slog('⛔ No trader — POLYMARKET_PRIVATE_KEY missing. Set it in Replit Secrets and restart.');
    }
  }
}
function getDryRun() { return DRY_RUN; }

module.exports = { start, buildSnapshot, resetState, setDryRun, getDryRun };
