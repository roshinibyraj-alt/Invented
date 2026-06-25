'use strict';
// ── Grid Bot v9 — Merged from reference bot auth + grid strategy ──────────
// BTC 5m binary markets. Fixed 8-level MOMENTUM LONG grid.
//
// ENTRY  : Limit BUY at 0.15 / 0.25 / 0.35 / 0.45 / 0.55 / 0.65 / 0.75 / 0.85
//          Fills when mid RISES to ≥ level price  (buy the breakout)
//          ~$10 per level → shares = floor(10 / price), balance decreases at fill
//
// ON FILL (N shares bought at price P):
//   tpShares     = floor(N / 2)
//   runnerShares = N − tpShares
//   Limit SELL @ min(P + 0.15, 0.99)  for tpShares    ← Half-TP sell
//   Limit SELL @ 0.99                 for runnerShares ← Runner sell
//   STOP  SELL @ max(P − 0.15, 0.01)  for ALL remaining ← Stop-loss if reversal
//
// PULL-STOP: if highestMid seen ≥ 0.75 and current mid drops to ≤ 0.40
//            → market-sell ALL open long positions immediately
//
// DRY_RUN=true: PAUSED — no orders placed, no simulated fills, just monitoring.
// DRY_RUN=false: LIVE — real orders on Polymarket CLOB.

const fs   = require('fs');
const path = require('path');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA      = 'https://gamma-api.polymarket.com';
const CLOB       = 'https://clob.polymarket.com';

let DRY_RUN           = true;  // start paused by default
const KILL_SWITCH     = process.env.KILL_SWITCH === 'true';

const TICK_MS           = 100;    // main loop interval
const DISCOVER_EVERY    = 300;    // ticks between market discovery sweeps (~30 s)
const PRICE_FETCH_EVERY = 3;      // price refresh every N ticks (~300 ms)
const MAX_EQUITY_POINTS = 2880;   // ~24 h at 30 s spacing
const RESOLUTION_MS     = 10_000; // check market resolution every 10 s

// ── Strategy constants ────────────────────────────────────────────────────────
const GRID_PRICES    = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85];
const BUDGET         = 10.00;  // $ spent buying per level per window
const TP_STEP        = 0.15;   // half-TP sell offset ABOVE entry price (max 0.99)
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
  const ws  = 300; // 5 minutes
  const cur = Math.floor(now / ws) * ws;
  return [-1, 0, 1, 2].map(d => `btc-updown-5m-${cur + d * ws}`);
}

// ── Runtime state ─────────────────────────────────────────────────────────────
let trader        = null;
let balance       = 0;
let startBalance  = 0;
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
    highestMid:    0,
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
    // Refund on failure
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
      slog(`📤 BUY FILLED ${label} @${fl4(lv.price)} | ${sh}sh (-$${fl2(cost)}) → TP:${fl4(lv.tp)} Runner:${RUNNER_PRICE} Stop:${fl4(lv.stop)} | bal:$${fl2(balance)}`);
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
  if (changed) { recordEquity(); }
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
    const upPayout = prices[0];
    const dnPayout = prices[1];

    if (isNaN(upPayout) || isNaN(dnPayout)) continue;

    let changed = false;
    for (const r of pendingRes) {
      if (r.slug !== slug || r.resolved) continue;

      const payoutPerShare = r.side === 'up' ? upPayout : dnPayout;
      // In live mode, balance is synced from chain — no need to add proceeds.
      // In dry-run, we also don't simulate — the resolution is just informational.
      const proceeds = fl2(payoutPerShare * r.shares);
      const pnl      = fl2(proceeds - r.cost);

      r.resolved   = true;
      r.outcome    = payoutPerShare === 1 ? 'WIN' : 'LOSS';
      r.proceeds   = proceeds;
      r.pnl        = pnl;
      r.resolvedAt = Date.now();

      const sign = pnl >= 0 ? '+' : '';
      slog(`🏁 RESOLVED ${r.outcome} BUY ${r.label} @${fl4(r.levelPrice)} | ${r.shares}sh paid:$${fl2(r.cost)} received:$${fl2(proceeds)} pnl:${sign}$${fl2(pnl)}`);
      pushFill('RESOLVE', r.label, r.shares, payoutPerShare, pnl, balance);
      changed = true;
    }
    if (changed) { recordEquity(); }
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
    lv.buyPending = false;
    for (const grp of lv.groups) {
      if (grp.marketSold) continue;

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
        cost:       leftCost,
        resolved:   false,
        outcome:    null,
        proceeds:   0,
        pnl:        0,
        resolvedAt: null,
      });
      slog(`⏳ PENDING_RES BUY ${label} @${fl4(lv.price)} | ${leftSh}sh paid:$${fl2(leftCost)}`);
    }
  }
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

  // Apply cutoff
  if (m.secondsToEnd <= CUTOFF_SECS) g.noMoreEntries = true;

  let changed = false;

  // ── PULL-STOP (momentum reversal guard) ──
  if (!g.pullbackDone && g.highestMid >= PULLBACK_HIGH && mid <= PULLBACK_LOW) {
    g.pullbackDone  = true;
    g.noMoreEntries = true;

    let totalSh = 0, totalCost = 0, totalProceeds = 0;

    for (const lv of g.levels) {
      lv.initialPlaced = true;
      if (!DRY_RUN && lv.buyOrderId) { cancelRealOrder(lv.buyOrderId); lv.buyOrderId = null; }
      lv.buyPending = false;

      for (const grp of lv.groups) {
        if (grp.marketSold || grp.inResolution) continue;

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
          grp.tpFilled     = true;
          grp.runnerFilled = true;
          grp.stopFilled   = true;
          grp.marketSold   = true;
          totalSh   += leftSh;
          totalCost += leftCost;

          if (!DRY_RUN) {
            const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
            placeRealSell(tokenId, side, mid, leftSh, g.slug, g.levels.indexOf(lv), lv.groups.indexOf(grp), 'stop')
              .catch(e => slog(`❌ PULL-STOP sell: ${e.message}`));
          }
        }
      }
    }

    slog(`⚠️  PULL-STOP ${label} | high:${fl4(g.highestMid)} now:${fl4(mid)} | ${totalSh}sh`);
    pushFill('PULL-STOP', label, totalSh, mid, 0, balance);
    changed = true;
  }

  // ── PROCESS EACH GRID LEVEL ──
  for (const lv of g.levels) {

    // Place initial BUY order (once per window per level)
    // LIVE: posts a real GTC limit BUY on the CLOB.
    if (!lv.initialPlaced && !lv.buyPending && !g.noMoreEntries && !DRY_RUN) {
      const cost = fl2(lv.initShares * lv.price);
      if (balance >= cost + 5) {
        lv.initialPlaced = true;
        const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
        placeRealBuy(g, lv, tokenId, label).catch(e => slog(`❌ placeRealBuy: ${e.message}`));
      }
    }
  }

  if (changed) { recordEquity(); }
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
function computeOpenPositions() {
  let holdingValue = 0;
  let totalCost    = 0;
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
    mtmValue:      fl2(holdingValue),
    openCost:      fl2(totalCost),
    unrealizedPnl: fl2(holdingValue - totalCost),
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

    // Sync balance from chain (every 5 ticks if 0, every 50 ticks otherwise)
    if (trader && (balance <= 0 ? tickCount % 5 === 0 : tickCount % 50 === 0)) {
      const rb = await trader.getBalance().catch(() => -1);
      if (rb > 0) balance = rb;
    }

    if (tickCount === 1 || tickCount % DISCOVER_EVERY === 0) {
      await discoverMarkets();
    }
    const fetchPrice = (tickCount % PRICE_FETCH_EVERY === 0);
    await Promise.allSettled(Object.values(marketCache).map(m => updateMarket(m, fetchPrice)));
    await checkResolution();
    if (!DRY_RUN) await checkRealFills();
    if (tickCount === 1)              { recordEquity(true); }
    else if (tickCount % 300 === 0)   { recordEquity(); }
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
  startTime = Date.now();

  slog(`🤖 Grid Bot v9 | levels:[${GRID_PRICES.join(',')}] | $${BUDGET}/level | tp:+${TP_STEP} | stop:-${TP_STEP} | runner:${RUNNER_PRICE}`);

  try {
    trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
    trader.setLogFn(logFn);
    slog('🔑 Authenticating with Polymarket CLOB...');
    const authResult = await trader.authenticate();
    if (!authResult) throw new Error('authentication returned empty');

    // Retry balance fetch up to 10 times with delays for slow CLOB responses
    let rb = -1;
    for (let attempt = 0; attempt < 10 && rb <= 0; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      rb = await trader.getBalance().catch(() => -1);
    }
    if (rb > 0) { balance = rb; startBalance = rb; }
    slog(`✅ Connected | wallet:${trader.address} bal:$${fl2(balance)}`);
  } catch (e) {
    slog(`❌ Auth failed: ${e.message}`);
    process.exit(1);
  }

  if (DRY_RUN) slog('📋 PAUSED — monitoring only, toggle LIVE to start trading');
  else slog('🔴 LIVE TRADING — real orders on Polymarket CLOB');

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
}

async function setDryRun(val) {
  DRY_RUN = !!val;
  flushState();
  if (!DRY_RUN && trader) {
    // Re-fetch real balance immediately when going live
    const rb = await trader.getBalance().catch(() => -1);
    if (rb > 0) { balance = rb; startBalance = rb; }
    slog(`🔴 LIVE — real orders on Polymarket CLOB | bal:$${fl2(balance)}`);
  } else {
    slog('📋 PAUSED — monitoring only, no orders placed');
  }
}

function getDryRun() { return DRY_RUN; }

module.exports = { start, buildSnapshot, setDryRun, getDryRun };
