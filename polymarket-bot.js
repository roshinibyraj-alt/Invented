'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — INDEPENDENT CROSS-TP STRADDLE
 * ═══════════════════════════════════════════════════════════════
 *
 *  Up and Down are traded as two completely independent positions —
 *  neither side knows or cares what the other is doing, until one
 *  side's TP fires (see CROSS-TP below).
 *
 *  Each side places ONE resting limit buy immediately when the window
 *  opens:
 *    Buy 100 shares @ 0.49 (single-shot — no re-entry, no re-arm).
 *
 *  Once that buy fills, TWO resting limit TP sells go up on that side:
 *    TP1: 50 shares @ 0.70
 *    TP2: 50 shares @ 0.80
 *
 *  NO STOP-LOSS of any kind — a filled position rides its TP orders
 *  (or the window-close resolution) with no protective exit.
 *
 *  CROSS-TP: the instant either TP tranche fills on one side (first
 *  time only, per window), the OTHER side's TP orders are cancelled
 *  and replaced with a single resting sell for all of that side's
 *  remaining shares @ 0.99. If the other side hasn't filled its buy
 *  yet, it is flagged so that whenever it does fill, it goes straight
 *  to a single 100-share TP @ 0.99 instead of the normal 0.70/0.80
 *  split.
 *
 *  ORDER TYPES: every buy and every TP sell is a genuine resting
 *  LIMIT order (maker — earns a rebate on fill). There is no taker
 *  order in this strategy since there is no stop-loss.
 *
 *  CLOSE-OUT: at SWEEP_SECS (285s) any still-unfilled resting buys
 *  are cancelled, and any open positions still waiting on their TP
 *  are rolled into one maker sell @ 0.99 per side. Anything left
 *  unfilled at window end resolves against the real outcome.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Timing ──
const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const RESOLUTION_BUFFER_S   = 8;
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

// ── Env / config ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ── Entry / TP config (identical on Up and Down, fully independent) ──
const BUY_PRICE     = Number(process.env.BUY_PRICE || 0.49);   // resting limit buy, placed immediately on window open
const ENTRY_SHARES  = Number(process.env.ENTRY_SHARES || 100); // single-shot fill, no re-entry
const TP1_PRICE     = Number(process.env.TP1_PRICE || 0.70);
const TP1_SHARES    = Number(process.env.TP1_SHARES || 50);
const TP2_PRICE     = Number(process.env.TP2_PRICE || 0.80);
const TP2_SHARES    = Number(process.env.TP2_SHARES || 50);
const CROSS_TP_PRICE = Number(process.env.CROSS_TP_PRICE || 0.99); // other side's forced TP once one side's TP fires

const ENTRY_CUTOFF_SECS = Number(process.env.ENTRY_CUTOFF_SECS || 280); // cancel unfilled resting buy after this
const SWEEP_SECS        = Number(process.env.SWEEP_SECS || 285);
const FINAL_SELL_PRICE  = Number(process.env.FINAL_SELL_PRICE || 0.99);

// ── Fees & maker rebates (Polymarket Fee Structure V2, crypto category) ──
const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

// ── State ──
let emitFn    = () => {};
let slog      = () => {};
let trader    = null;
let startTime = Date.now();
let logs      = [];
let trades    = [];
let tradingEnabled = true;
let pairList = [...DEFAULT_PAIRS];
let perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
let pairs = {};
let lastPolyPriceFetch = 0;
let totalEquityCurve = [];

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}
function round2(n) { return Math.round(n * 100) / 100; }
function nowSec() { return Date.now() / 1000; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-grid-scalper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-grid-scalper/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Order helpers
// ─────────────────────────────────────────
async function placeLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function placeLimitSell(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitSell(tokenId, shares, price);
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function marketSell(tokenId, shares) {
  // Only order type in the bot that is NOT a limit order — the hard SL
  // needs to guarantee the exit, so it crosses the spread (taker).
  if (!DRY_RUN && trader) return await trader.marketSell(tokenId, shares);
  return { id: `dry-marketsell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function cancelOrder(orderId) {
  if (!DRY_RUN && trader && orderId) {
    try { await trader.cancelOrder(orderId); }
    catch (e) { log(`⚠️  cancel failed: ${e.message}`); }
  }
}
function takerFee(shares, price) {
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshSideState() {
  return {
    buyPrice: BUY_PRICE,
    buyOrderId: null,  // resting buy order id, placed immediately on window load
    armed: true,       // resting buy still live (not yet filled/cancelled)
    entryFired: false, // filled this window — single-shot, no re-entry
    position: null,    // { entryPrice, shares, cost, costPerShare, tranches: [{id, price, shares, orderId}], openedAt } | null
    forcedCross: false, // set once either side's TP has fired — forces this side's TP to CROSS_TP_PRICE
    tpEverHit: false,   // whether THIS side's own TP has fired this window (triggers forcing the OTHER side)
    sweepPosition: null,
    wins: 0, losses: 0,
    realizedPnl: 0,
    rebatesEarned: 0,
    feesPaid: 0,
  };
}

function freshPairState(symbol) {
  return {
    symbol,
    tradable: false,
    windowStart: null,
    windowEnd: null,
    slug: null,
    eventTitle: null,
    conditionId: null,
    upTokenId: null,
    downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,

    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,

    sweepDone: false,
    sides: { Up: freshSideState(), Down: freshSideState() },

    resolvedThisWindow: true,
    equityCurve: [{ t: Date.now(), equity: perPairCapital }],
  };
}

function resetPairs() {
  perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
  pairs = {};
  for (const sym of pairList) pairs[sym] = freshPairState(sym);
  totalEquityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];
}
resetPairs();

// ─────────────────────────────────────────
//  Slug / window math
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) {
  return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS;
}
function slugFor(symbol, windowStartSec) {
  return `${symbol.toLowerCase()}-updown-5m-${windowStartSec}`;
}
function qOf(m) { return (m.question || m.groupItemTitle || m.title || '').toLowerCase(); }
function parseMarketTokens(m) {
  try {
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
    const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}
function tokenIdForSide(market, side) {
  const tokens = parseMarketTokens(market);
  const want = (side || '').trim().toLowerCase();
  const tok = tokens.find(t => (t.outcome || '').toLowerCase() === want);
  return tok?.token_id || null;
}
async function fetchEventForWindow(symbol, windowStart) {
  for (const offset of SLUG_OFFSET_FALLBACKS) {
    const ws = windowStart + offset;
    if (ws + WINDOW_SECS <= nowSec()) continue;
    const slug = slugFor(symbol, ws);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) {
        return { event, windowStart: ws, slug };
      }
    } catch (_) { /* not indexed yet */ }
  }
  return null;
}

async function loadPairWindow(p) {
  const ws = currentWindowStart();
  if (p.windowStart === ws && p.upTokenId) return;

  const found = await fetchEventForWindow(p.symbol, ws);
  if (!found) { p.tradable = false; return; }
  const { event, windowStart, slug } = found;
  const market = event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];

  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) {
    log(`⚠️  ${p.symbol}: window loaded but Up/Down token ids missing`);
    p.tradable = false;
    return;
  }

  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.slug = slug;
  p.eventTitle = event.title || event.slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;
  p.resolvedThisWindow = false;

  // fresh position state every window
  p.sweepDone = false;
  p.sides = { Up: freshSideState(), Down: freshSideState() };

  // place resting limit buys immediately, on both sides, simultaneously
  for (const side of ['Up', 'Down']) {
    const tokenId = side === 'Up' ? upId : downId;
    try {
      const order = await placeLimitBuy(tokenId, BUY_PRICE, ENTRY_SHARES);
      p.sides[side].buyOrderId = order.id || order.orderId || null;
    } catch (e) {
      log(`⚠️  ${p.symbol} ${side}: failed to place initial resting buy @ ${BUY_PRICE}: ${e.message}`);
    }
  }

  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | resting buys placed @ ${BUY_PRICE} for ${ENTRY_SHARES}sh each side | TP ${TP1_PRICE}(${TP1_SHARES}sh)/${TP2_PRICE}(${TP2_SHARES}sh) | cross-TP ${CROSS_TP_PRICE} | no SL`);
}

// ─────────────────────────────────────────
//  Price feed
// ─────────────────────────────────────────
async function refreshPolyPrices() {
  const requests = [];
  for (const p of Object.values(pairs)) {
    if (!p.tradable || !p.upTokenId || !p.downTokenId) continue;
    requests.push({ token_id: p.upTokenId, side: 'BUY' });
    requests.push({ token_id: p.upTokenId, side: 'SELL' });
    requests.push({ token_id: p.downTokenId, side: 'BUY' });
    requests.push({ token_id: p.downTokenId, side: 'SELL' });
  }
  if (!requests.length) return;

  function applyPolyPrice(tid, side, price) {
    if (!Number.isFinite(price)) return;
    for (const p of Object.values(pairs)) {
      if (p.upTokenId === tid) { if (side === 'BUY') p.upAsk = price; else if (side === 'SELL') p.upBid = price; }
      else if (p.downTokenId === tid) { if (side === 'BUY') p.downAsk = price; else if (side === 'SELL') p.downBid = price; }
    }
  }

  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const side = (row.side || '').toUpperCase();
        const price = parseFloat(row.price);
        if (!tid || !Number.isFinite(price)) continue;
        applyPolyPrice(tid, side, price);
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (val && typeof val === 'object') {
          if (val.BUY != null) applyPolyPrice(tid, 'BUY', parseFloat(val.BUY));
          if (val.SELL != null) applyPolyPrice(tid, 'SELL', parseFloat(val.SELL));
          if (val.buy != null) applyPolyPrice(tid, 'BUY', parseFloat(val.buy));
          if (val.sell != null) applyPolyPrice(tid, 'SELL', parseFloat(val.sell));
        }
      }
    }
  } catch (e) {
    for (const p of Object.values(pairs)) {
      if (!p.tradable) continue;
      try {
        const [upAsk, upBid, downAsk, downBid] = await Promise.all([
          getJSON(`${CLOB}/price?token_id=${p.upTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${p.upTokenId}&side=SELL`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${p.downTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${p.downTokenId}&side=SELL`).catch(() => null),
        ]);
        if (upAsk) p.upAsk = parseFloat(upAsk.price || upAsk.mid || p.upAsk);
        if (upBid) p.upBid = parseFloat(upBid.price || upBid.mid || p.upBid);
        if (downAsk) p.downAsk = parseFloat(downAsk.price || downAsk.mid || p.downAsk);
        if (downBid) p.downBid = parseFloat(downBid.price || downBid.mid || p.downBid);
      } catch (_) { /* stale values, retry next tick */ }
    }
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function sideHeldShares(sideState) {
  if (!sideState.position) return 0;
  return sideState.position.tranches.reduce((s, tr) => s + tr.shares, 0);
}
function sideHeldCost(sideState) {
  if (!sideState.position) return 0;
  return round2(sideState.position.tranches.reduce((s, tr) => s + sideState.position.costPerShare * tr.shares, 0));
}
function positionsMarkValue(p) {
  let total = 0;
  for (const side of ['Up', 'Down']) {
    const shares = sideHeldShares(p.sides[side]);
    if (shares <= 0) continue;
    const bid = side === 'Up' ? p.upBid : p.downBid;
    const cost = sideHeldCost(p.sides[side]);
    const price = bid ?? (cost / shares);
    total += shares * price;
  }
  return round2(total);
}
function pairMarkValue(p) {
  return round2(p.bankroll + positionsMarkValue(p));
}
function pushGlobalEquity() {
  const total = round2(Object.values(pairs).reduce((s, p) => s + pairMarkValue(p), 0));
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > 500) totalEquityCurve.shift();
}
function recordEquity(p) {
  p.equityCurve.push({ t: Date.now(), equity: pairMarkValue(p) });
  if (p.equityCurve.length > 300) p.equityCurve.shift();
  pushGlobalEquity();
}
function registerTrade(p, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: p.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Per-side: fill the resting buy (placed immediately at window open)
//  once the ask reaches BUY_PRICE. Single-shot — no re-entry.
// ─────────────────────────────────────────
async function maybeFillSideBuy(p, side, elapsed) {
  const s = p.sides[side];
  if (!s.armed || s.entryFired || s.position) return;

  if (elapsed >= ENTRY_CUTOFF_SECS) {
    // cutoff reached with no fill — cancel the resting buy
    if (s.buyOrderId) await cancelOrder(s.buyOrderId);
    s.buyOrderId = null;
    s.armed = false;
    return;
  }

  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null || ask > BUY_PRICE) return; // resting limit buy not reached yet

  const shares = ENTRY_SHARES;
  const price = BUY_PRICE; // limit buy fills at the resting limit price
  const entryRebate = makerRebate(shares, price); // maker fill — earns a rebate
  const cost = round2(price * shares - entryRebate);

  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol} ${side}: skip fill — insufficient bankroll ($${p.bankroll.toFixed(2)}, need $${cost.toFixed(2)})`);
    return;
  }

  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;

  p.bankroll = round2(p.bankroll - cost);
  p.rebatesEarned = round2(p.rebatesEarned + entryRebate);
  s.rebatesEarned = round2(s.rebatesEarned + entryRebate);
  s.entryFired = true;
  s.armed = false;
  s.buyOrderId = null; // filled

  // if the opposite side already fired its TP before this buy filled,
  // go straight to a single forced TP @ CROSS_TP_PRICE for all shares
  const tranchePlan = s.forcedCross
    ? [{ id: 'X', price: CROSS_TP_PRICE, shares }]
    : [{ id: '1', price: TP1_PRICE, shares: TP1_SHARES }, { id: '2', price: TP2_PRICE, shares: TP2_SHARES }];

  const tranches = [];
  for (const trPlan of tranchePlan) {
    const order = await placeLimitSell(tokenId, trPlan.price, trPlan.shares);
    tranches.push({ id: trPlan.id, price: trPlan.price, shares: trPlan.shares, orderId: order.id || order.orderId || null });
  }

  s.position = {
    entryPrice: price, shares, cost,
    costPerShare: round2(cost / shares),
    tranches,
    openedAt: Date.now(),
  };

  const tpTxt = tranches.map(t => `${t.shares}sh@${t.price.toFixed(2)}`).join(' + ');
  log(`📥 ${p.symbol} ${side}: BUY filled ${shares}sh @ ${price.toFixed(2)} (limit) | rebate=+$${entryRebate.toFixed(4)} | resting TP: ${tpTxt}`);
  registerTrade(p, { side: 'BUY', outcome: side, reason: 'ENTRY', price, shares, cost });
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Cross-TP: fires once (per window, per side) the FIRST time either
//  of a side's own TP tranches fills. Cancels the opposite side's
//  resting TP order(s) and replaces them with a single resting sell
//  for all its remaining shares @ CROSS_TP_PRICE. If the opposite
//  side hasn't filled its buy yet, it's flagged so its TP goes
//  straight to CROSS_TP_PRICE (single 100sh tranche) once it fills.
// ─────────────────────────────────────────
async function forceCrossTp(p, side) {
  const s = p.sides[side];
  if (s.forcedCross) return;
  s.forcedCross = true;

  if (s.position && s.position.tranches.length) {
    const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
    let remainingShares = 0;
    for (const tr of s.position.tranches) {
      await cancelOrder(tr.orderId);
      remainingShares = round2(remainingShares + tr.shares);
    }
    const order = await placeLimitSell(tokenId, CROSS_TP_PRICE, remainingShares);
    s.position.tranches = [{ id: 'X', price: CROSS_TP_PRICE, shares: remainingShares, orderId: order.id || order.orderId || null }];
    log(`🔁 ${p.symbol} ${side}: opposite side's TP hit — re-pricing remaining ${remainingShares}sh TP to ${CROSS_TP_PRICE.toFixed(2)}`);
  } else {
    log(`🔁 ${p.symbol} ${side}: opposite side's TP hit — flagged for forced ${CROSS_TP_PRICE.toFixed(2)} TP once its buy fills`);
  }
}

// ─────────────────────────────────────────
//  Per-side: TP tranche fills (limit/maker). Closes out tranches as
//  the bid reaches their price — no re-entry once fully closed. The
//  first tranche fill this window also forces the opposite side's TP
//  to CROSS_TP_PRICE.
// ─────────────────────────────────────────
async function maybeFillSideTP(p, side) {
  const s = p.sides[side];
  if (!s.position || !s.position.tranches.length) return;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;

  const pos = s.position;
  let anyFilled = false;

  for (let i = pos.tranches.length - 1; i >= 0; i--) {
    const tr = pos.tranches[i];
    if (bid < tr.price) continue;

    const proceeds = round2(tr.price * tr.shares);
    const rebate = makerRebate(tr.shares, tr.price);
    const net = round2(proceeds + rebate);
    const shareCost = round2(pos.costPerShare * tr.shares);
    const profit = round2(net - shareCost);

    p.bankroll = round2(p.bankroll + net);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    s.realizedPnl = round2(s.realizedPnl + profit);
    s.rebatesEarned = round2(s.rebatesEarned + rebate);
    if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }

    log(`💰 ${p.symbol} ${side} TP-${tr.id}: filled ${tr.shares}sh @ ${tr.price.toFixed(2)} (limit) | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: `TP-${tr.id}`, price: tr.price, shares: tr.shares, profit, rebate });

    pos.tranches.splice(i, 1);
    anyFilled = true;

    if (!s.tpEverHit) {
      s.tpEverHit = true;
      const otherSide = side === 'Up' ? 'Down' : 'Up';
      await forceCrossTp(p, otherSide);
    }
  }

  if (anyFilled && pos.tranches.length === 0) {
    s.position = null; // fully closed — done for this window, no re-entry
    log(`🔒 ${p.symbol} ${side}: position fully closed — done for this window`);
  }
  if (anyFilled) recordEquity(p);
}

// ─────────────────────────────────────────
//  285s sweep: cancel unfilled resting buys/TPs, roll open positions
//  into one maker sell @ 0.99 per side.
// ─────────────────────────────────────────
async function maybeSweep(p, elapsed) {
  if (p.sweepDone || elapsed < SWEEP_SECS) return;
  p.sweepDone = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    s.armed = false; // no more new entries this window

    if (s.buyOrderId) {
      await cancelOrder(s.buyOrderId);
      s.buyOrderId = null;
    }

    let sweepShares = 0, sweepCost = 0;
    if (s.position && s.position.tranches.length) {
      for (const tr of s.position.tranches) {
        await cancelOrder(tr.orderId);
        sweepShares = round2(sweepShares + tr.shares);
        sweepCost = round2(sweepCost + s.position.costPerShare * tr.shares);
      }
      s.position = null;
    }

    if (sweepShares > 0) {
      const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
      const order = await placeLimitSell(tokenId, FINAL_SELL_PRICE, sweepShares);
      s.sweepPosition = {
        entryPrice: round2(sweepCost / sweepShares), shares: sweepShares, cost: sweepCost,
        tpOrderId: order.id || order.orderId || null, status: 'resting',
      };
      log(`🎯 ${p.symbol} ${side}: cancelled resting orders, FINAL SELL @ ${FINAL_SELL_PRICE} resting for ${sweepShares}sh`);
    }
  }
}

async function checkSweepFill(p, side) {
  const s = p.sides[side];
  if (!s.sweepPosition || s.sweepPosition.status !== 'resting') return;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null || bid < FINAL_SELL_PRICE) return;

  const pos = s.sweepPosition;
  const proceeds = round2(FINAL_SELL_PRICE * pos.shares);
  const rebate = makerRebate(pos.shares, FINAL_SELL_PRICE);
  const net = round2(proceeds + rebate);
  const profit = round2(net - pos.cost);

  p.bankroll = round2(p.bankroll + net);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  s.realizedPnl = round2(s.realizedPnl + profit);
  s.rebatesEarned = round2(s.rebatesEarned + rebate);
  if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }

  log(`💰 ${p.symbol} ${side}: FINAL SELL filled ${pos.shares}sh @ ${FINAL_SELL_PRICE} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: side, reason: 'FINAL', price: FINAL_SELL_PRICE, shares: pos.shares, profit, rebate });
  s.sweepPosition = null;
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Window resolution
// ─────────────────────────────────────────
async function determineWinningSide(p) {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(p.slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === p.conditionId) || (event.markets || [])[0];
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const winner = (outcomes[bestI] || '').trim();
      if (winner) return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
    }
  } catch (_) { /* fall through */ }
  if (p.upBid != null && p.downBid != null) return p.upBid >= p.downBid ? 'Up' : 'Down';
  return null;
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    if (s.buyOrderId) {
      await cancelOrder(s.buyOrderId);
      s.buyOrderId = null;
      log(`🛑 ${p.symbol} ${side}: unfilled resting BUY cancelled at window close`);
    }
    if (s.position && s.position.tranches.length) {
      for (const tr of s.position.tranches) await cancelOrder(tr.orderId);
      log(`🛑 ${p.symbol} ${side}: unfilled TP(s) cancelled at window close — resolving instead`);
    }
    if (s.sweepPosition && s.sweepPosition.status === 'resting') {
      await cancelOrder(s.sweepPosition.tpOrderId);
      log(`🛑 ${p.symbol} ${side}: unfilled FINAL SELL cancelled at window close — resolving instead`);
    }
  }

  const heldShares = { Up: 0, Down: 0 };
  const heldCost = { Up: 0, Down: 0 };
  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    if (s.position && s.position.tranches.length) {
      for (const tr of s.position.tranches) {
        heldShares[side] = round2(heldShares[side] + tr.shares);
        heldCost[side] = round2(heldCost[side] + s.position.costPerShare * tr.shares);
      }
      s.position = null;
    }
    if (s.sweepPosition) { heldShares[side] = round2(heldShares[side] + s.sweepPosition.shares); heldCost[side] = round2(heldCost[side] + s.sweepPosition.cost); s.sweepPosition = null; }
  }

  if (heldShares.Up <= 0 && heldShares.Down <= 0) return;

  const winner = await determineWinningSide(p);
  for (const side of ['Up', 'Down']) {
    const shares = heldShares[side];
    if (shares <= 0) continue;
    const s = p.sides[side];
    const cost = heldCost[side];
    const won = winner === side;
    const proceeds = won ? round2(shares * 1) : 0;
    const profit = round2(proceeds - cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    s.realizedPnl = round2(s.realizedPnl + profit);
    if (won) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION ${side} ${shares}sh cost=$${cost.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: 'RESOLUTION', price: won ? 1 : 0, shares, profit });
  }
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Main per-pair tick
// ─────────────────────────────────────────
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable) return;
  if (!tradingEnabled) return;

  const elapsed = nowSec() - p.windowStart;

  for (const side of ['Up', 'Down']) {
    await maybeFillSideTP(p, side);   // check TP fills first (can trigger cross-TP on the other side)
    await maybeFillSideBuy(p, side, elapsed);
    await checkSweepFill(p, side);
  }

  await maybeSweep(p, elapsed);

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function sideSummary(p, side) {
  const s = p.sides[side];
  const tranches = s.position ? s.position.tranches.map(tr => ({ id: tr.id, price: tr.price, shares: tr.shares })) : [];
  return {
    buyPrice: s.buyPrice,
    armed: s.armed,
    entryFired: s.entryFired,
    forcedCross: s.forcedCross,
    hasPosition: !!s.position,
    entryPrice: s.position ? s.position.entryPrice : null,
    tranches,
    heldShares: sideHeldShares(s) + (s.sweepPosition ? s.sweepPosition.shares : 0),
    heldCost: sideHeldCost(s) + (s.sweepPosition ? s.sweepPosition.cost : 0),
    wins: s.wins,
    losses: s.losses,
    realizedPnl: s.realizedPnl,
    rebatesEarned: s.rebatesEarned,
    feesPaid: s.feesPaid,
  };
}

function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(positionsMarkValue(p) - (sideHeldCost(p.sides.Up) + sideHeldCost(p.sides.Down)));
    const markValue = pairMarkValue(p);
    const elapsed = p.windowStart != null ? Math.max(0, nowSec() - p.windowStart) : null;
    let phase = '—';
    if (p.tradable && elapsed != null) {
      phase = elapsed >= SWEEP_SECS ? 'SWEPT / RESOLVING' : (elapsed >= ENTRY_CUTOFF_SECS ? 'NO NEW ENTRIES' : 'GRID ARMED');
    }
    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      eventTitle: p.eventTitle,
      windowEnd: p.windowEnd,
      elapsedSecs: elapsed != null ? Math.floor(elapsed) : null,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      phase,
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      sides: { Up: sideSummary(p, 'Up'), Down: sideSummary(p, 'Down') },
      equityCurve: p.equityCurve,
    };
  });

  const totalBankroll = round2(pairStates.reduce((s, p) => s + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((s, p) => s + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((s, p) => s + p.realizedPnl, 0));
  const totalUnrealized = round2(pairStates.reduce((s, p) => s + p.unrealizedPnl, 0));
  const totalWins = pairStates.reduce((s, p) => s + p.wins, 0);
  const totalLosses = pairStates.reduce((s, p) => s + p.losses, 0);
  const totalFeesPaid = round2(pairStates.reduce((s, p) => s + p.feesPaid, 0));
  const totalRebatesEarned = round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0));

  return {
    dryRun: DRY_RUN,
    tradingEnabled,
    pairs: pairList,
    totalCapital: TOTAL_CAPITAL,
    perPairCapital,
    totalBankroll,
    totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized,
    totalUnrealizedPnl: totalUnrealized,
    totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid,
    totalRebatesEarned,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      buyPrice: BUY_PRICE,
      entryShares: ENTRY_SHARES,
      tp1Price: TP1_PRICE,
      tp1Shares: TP1_SHARES,
      tp2Price: TP2_PRICE,
      tp2Shares: TP2_SHARES,
      crossTpPrice: CROSS_TP_PRICE,
      entryCutoffSecs: ENTRY_CUTOFF_SECS,
      sweepSecs: SWEEP_SECS,
      finalSellPrice: FINAL_SELL_PRICE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates,
    totalEquityCurve,
    logs: logs.slice(-120),
    trades: trades.slice(-100).reverse(),
  };
}

// ─────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────
let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) {
        lastPolyPriceFetch = now;
        await refreshPolyPrices();
      }
      for (const p of Object.values(pairs)) {
        try { await processPair(p); } catch (e) { log(`⚠️  ${p.symbol} tick error: ${e.message}`); }
      }
      emitFn('state', buildState());
    } catch (e) {
      log(`⚠️  Loop error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  Public controls
// ─────────────────────────────────────────
function setPairs(list) {
  const clean = (list || []).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!clean.length) return { ok: false, error: 'Empty pair list' };
  pairList = [...new Set(clean)];
  resetPairs();
  log(`⚙️  Pairs updated: ${pairList.join(', ')} | $${perPairCapital.toFixed(2)} per pair`);
  return { ok: true, pairs: pairList, perPairCapital };
}
function pauseTrading() {
  tradingEnabled = false;
  log('⏸️  Trading paused (open positions still managed for TP/SL/sweep/resolution)');
  return { ok: true };
}
function resumeTrading() {
  tradingEnabled = true;
  log('▶️  Trading resumed');
  return { ok: true };
}
function getStatus() { return { ok: true, ...buildState() }; }

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 5-Minute BTC Up/Down — Independent Cross-TP Straddle (Up & Down fully separate until a TP fires)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pair(s) (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Entry: buy ${ENTRY_SHARES}sh @ ${BUY_PRICE} immediately on both sides, single-shot (no re-entry)`);
  log(`⚙️  TP: ${TP1_SHARES}sh @ ${TP1_PRICE} + ${TP2_SHARES}sh @ ${TP2_PRICE} | No stop-loss`);
  log(`⚙️  Cross-TP: first TP fill on either side forces the OTHER side's remaining shares to a single TP @ ${CROSS_TP_PRICE}`);
  log(`⚙️  All buys and TPs are resting limit orders (maker, earn rebate) — no taker orders in this strategy`);
  log(`⚙️  At ${SWEEP_SECS}s: cancel unfilled resting orders, roll open positions into one @ ${FINAL_SELL_PRICE} sell per side | unfilled at close resolves to actual outcome`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
