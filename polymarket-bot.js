'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — FIXED LADDER GRID (INDEPENDENT UP/DOWN)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Up and Down are traded as two completely independent ladders —
 *  neither side knows or cares what the other is doing. No cross-TP,
 *  no cross-side triggers of any kind.
 *
 *  Each side has a FIXED ladder of resting limit buys, placed the
 *  instant the window opens, at 0.05 price steps:
 *
 *      0.45 → TP 0.48        0.25 → TP 0.28        0.10 → TP 0.13
 *      0.40 → TP 0.43        0.20 → TP 0.23        0.05 → TP 0.08
 *      0.35 → TP 0.38        0.15 → TP 0.18
 *      0.30 → TP 0.33
 *
 *  (TP = entry + 0.03, always.)
 *
 *  Each rung is single-shot: ONE resting buy per rung per window.
 *  Once a rung's buy fills, a resting TP sell for that rung's shares
 *  goes up immediately. If it fills, that rung is done for the
 *  window — no re-arm, no re-entry at that price level.
 *
 *  SIZING: every rung risks a FIXED $50 notional, not fixed shares.
 *  shares = $50 / entry price. So a side can have up to 9 independent
 *  $50 positions live at once if price sweeps the whole ladder in a
 *  single window (up to $450 exposure per side).
 *
 *  NO STOP-LOSS of any kind. A filled rung rides its TP order (or
 *  window-close resolution) with no protective exit.
 *
 *  LADDER LIFETIME: all 9 rungs stay live (able to fill) for the
 *  entire window up until the 285s sweep mark. At the sweep, any
 *  STILL-UNFILLED resting buys are cancelled — no new fills after
 *  that. Rungs that already filled and are waiting on their TP are
 *  left completely alone at the sweep (no forced exit) — they ride
 *  all the way to window resolution, same as the no-SL philosophy.
 *
 *  CLOSE-OUT / RESOLUTION: at window end, any rungs still holding
 *  shares (filled buy, TP never hit) resolve against the real
 *  outcome — $1/share if that side won, $0 if it lost.
 *
 *  ORDER TYPES: every buy and every TP sell is a genuine resting
 *  LIMIT order (maker — earns a rebate on fill). There is no taker
 *  order anywhere in this strategy.
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

// ── Ladder config (identical on Up and Down, fully independent) ──
const LADDER_TOP     = Number(process.env.LADDER_TOP || 0.45);   // highest rung entry price
const LADDER_BOTTOM  = Number(process.env.LADDER_BOTTOM || 0.05); // lowest rung entry price
const LADDER_STEP    = Number(process.env.LADDER_STEP || 0.05);   // price step between rungs
const TP_OFFSET       = Number(process.env.TP_OFFSET || 0.03);     // TP = entry + this
const RUNG_NOTIONAL  = Number(process.env.RUNG_NOTIONAL || 50);   // fixed $ per rung, regardless of shares

const SWEEP_SECS = Number(process.env.SWEEP_SECS || 285); // ladder stays fully live until this point; unfilled buys cancelled here

// ── Fees & maker rebates (Polymarket Fee Structure V2, crypto category) ──
const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

// ── Build the fixed ladder levels once ──
function buildLadderLevels() {
  const levels = [];
  const topCents = Math.round(LADDER_TOP * 100);
  const botCents = Math.round(LADDER_BOTTOM * 100);
  const stepCents = Math.round(LADDER_STEP * 100);
  for (let c = topCents; c >= botCents; c -= stepCents) {
    const buyPrice = round2(c / 100);
    levels.push({ id: levels.length + 1, buyPrice, tpPrice: round2(buyPrice + TP_OFFSET) });
  }
  return levels;
}
const LADDER_LEVELS = buildLadderLevels();

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
    rungs: LADDER_LEVELS.map(lvl => ({
      id: lvl.id,
      buyPrice: lvl.buyPrice,
      tpPrice: lvl.tpPrice,
      buyOrderId: null,
      armed: true,           // resting buy still live (not yet filled/cancelled)
      filled: false,         // this rung's buy has filled — single-shot, no re-entry
      shares: 0,
      cost: 0,
      costPerShare: 0,
      tpOrderId: null,
      tpFilled: false,
      insufficientLogged: false,
    })),
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

  // fresh ladder state every window
  p.sweepDone = false;
  p.sides = { Up: freshSideState(), Down: freshSideState() };

  // place all 9 resting limit buys per side, immediately, simultaneously
  for (const side of ['Up', 'Down']) {
    const tokenId = side === 'Up' ? upId : downId;
    for (const rung of p.sides[side].rungs) {
      const shares = round2(RUNG_NOTIONAL / rung.buyPrice);
      try {
        const order = await placeLimitBuy(tokenId, rung.buyPrice, shares);
        rung.buyOrderId = order.id || order.orderId || null;
      } catch (e) {
        log(`⚠️  ${p.symbol} ${side} rung#${rung.id}: failed to place resting buy @ ${rung.buyPrice}: ${e.message}`);
      }
    }
  }

  const ladderTxt = LADDER_LEVELS.map(l => `${l.buyPrice.toFixed(2)}→${l.tpPrice.toFixed(2)}`).join(', ');
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | ladder armed both sides: ${ladderTxt} | $${RUNG_NOTIONAL}/rung | no SL`);
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
//  Equity tracking — real-time mark-to-market including unrealized P&L
// ─────────────────────────────────────────
function sideHeldShares(sideState) {
  return round2(sideState.rungs.reduce((s, r) => s + (r.filled && !r.tpFilled ? r.shares : 0), 0));
}
function sideHeldCost(sideState) {
  return round2(sideState.rungs.reduce((s, r) => s + (r.filled && !r.tpFilled ? r.cost : 0), 0));
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
//  Per-side: fill each ladder rung's resting buy once the ask reaches
//  that rung's price. Single-shot per rung — no re-entry once filled.
//  Ladder stays fully live until the sweep at SWEEP_SECS.
// ─────────────────────────────────────────
async function maybeFillSideBuys(p, side, elapsed) {
  const s = p.sides[side];
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  let anyFilled = false;

  for (const rung of s.rungs) {
    if (!rung.armed || rung.filled) continue;
    if (elapsed >= SWEEP_SECS) continue; // sweep handles cancellation
    if (ask == null || ask > rung.buyPrice) continue; // not reached yet

    const shares = round2(RUNG_NOTIONAL / rung.buyPrice);
    const price = rung.buyPrice; // limit buy fills at the resting limit price
    const entryRebate = makerRebate(shares, price);
    const cost = round2(price * shares - entryRebate);

    if (cost > p.bankroll) {
      if (!rung.insufficientLogged) {
        log(`⏭️  ${p.symbol} ${side} rung#${rung.id}@${rung.buyPrice.toFixed(2)}: skip fill — insufficient bankroll ($${p.bankroll.toFixed(2)}, need $${cost.toFixed(2)})`);
        rung.insufficientLogged = true;
      }
      continue;
    }

    p.bankroll = round2(p.bankroll - cost);
    p.rebatesEarned = round2(p.rebatesEarned + entryRebate);
    s.rebatesEarned = round2(s.rebatesEarned + entryRebate);

    rung.filled = true;
    rung.armed = false;
    rung.buyOrderId = null; // filled
    rung.shares = shares;
    rung.cost = cost;
    rung.costPerShare = round2(cost / shares);

    const order = await placeLimitSell(tokenId, rung.tpPrice, shares);
    rung.tpOrderId = order.id || order.orderId || null;

    log(`📥 ${p.symbol} ${side} rung#${rung.id}: BUY filled ${shares.toFixed(2)}sh @ ${price.toFixed(2)} (limit) | rebate=+$${entryRebate.toFixed(4)} | resting TP ${rung.tpPrice.toFixed(2)}`);
    registerTrade(p, { side: 'BUY', outcome: side, reason: `RUNG-${rung.id}`, price, shares, cost });
    anyFilled = true;
  }

  if (anyFilled) recordEquity(p);
}

// ─────────────────────────────────────────
//  Per-side: TP fills (limit/maker) per rung. Each rung closes
//  independently once the bid reaches its own TP price — no re-entry
//  once closed.
// ─────────────────────────────────────────
async function maybeFillSideTPs(p, side) {
  const s = p.sides[side];
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;
  let anyFilled = false;

  for (const rung of s.rungs) {
    if (!rung.filled || rung.tpFilled) continue;
    if (bid < rung.tpPrice) continue;

    const proceeds = round2(rung.tpPrice * rung.shares);
    const rebate = makerRebate(rung.shares, rung.tpPrice);
    const net = round2(proceeds + rebate);
    const profit = round2(net - rung.cost);

    p.bankroll = round2(p.bankroll + net);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    s.realizedPnl = round2(s.realizedPnl + profit);
    s.rebatesEarned = round2(s.rebatesEarned + rebate);
    if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }

    rung.tpFilled = true;
    rung.tpOrderId = null;

    log(`💰 ${p.symbol} ${side} rung#${rung.id}: TP filled ${rung.shares.toFixed(2)}sh @ ${rung.tpPrice.toFixed(2)} (limit) | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: `TP-${rung.id}`, price: rung.tpPrice, shares: rung.shares, profit, rebate });
    anyFilled = true;
  }

  if (anyFilled) recordEquity(p);
}

// ─────────────────────────────────────────
//  285s sweep: cancel any STILL-UNFILLED resting buys. Rungs that
//  already filled and are waiting on their TP are left completely
//  alone — they ride to window resolution (no forced exit, no SL).
// ─────────────────────────────────────────
async function maybeSweep(p, elapsed) {
  if (p.sweepDone || elapsed < SWEEP_SECS) return;
  p.sweepDone = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    let cancelledCount = 0;
    for (const rung of s.rungs) {
      if (rung.armed && !rung.filled) {
        if (rung.buyOrderId) await cancelOrder(rung.buyOrderId);
        rung.buyOrderId = null;
        rung.armed = false;
        cancelledCount++;
      }
    }
    const openRungs = s.rungs.filter(r => r.filled && !r.tpFilled).length;
    log(`🧹 ${p.symbol} ${side}: sweep @ ${SWEEP_SECS}s — cancelled ${cancelledCount} unfilled rung buy(s), ${openRungs} filled rung(s) left riding to resolution (no forced exit)`);
  }
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

  const heldShares = { Up: 0, Down: 0 };
  const heldCost = { Up: 0, Down: 0 };

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    for (const rung of s.rungs) {
      if (rung.armed && !rung.filled && rung.buyOrderId) {
        await cancelOrder(rung.buyOrderId);
        rung.buyOrderId = null;
        rung.armed = false;
      }
      if (rung.filled && !rung.tpFilled) {
        if (rung.tpOrderId) await cancelOrder(rung.tpOrderId);
        heldShares[side] = round2(heldShares[side] + rung.shares);
        heldCost[side] = round2(heldCost[side] + rung.cost);
        log(`🛑 ${p.symbol} ${side} rung#${rung.id}: unfilled TP cancelled at window close — resolving instead`);
      }
    }
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
    log(`${icon} ${p.symbol} RESOLUTION ${side} ${shares.toFixed(2)}sh cost=$${cost.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
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
    await maybeFillSideTPs(p, side);
    await maybeFillSideBuys(p, side, elapsed);
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
  const rungs = s.rungs.map(r => ({
    id: r.id,
    buyPrice: r.buyPrice,
    tpPrice: r.tpPrice,
    armed: r.armed,
    filled: r.filled,
    tpFilled: r.tpFilled,
    shares: r.shares,
  }));
  return {
    rungs,
    heldShares: sideHeldShares(s),
    heldCost: sideHeldCost(s),
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
      phase = elapsed >= SWEEP_SECS ? 'SWEPT / RESOLVING' : 'LADDER ARMED';
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
      ladderLevels: LADDER_LEVELS,
      tpOffset: TP_OFFSET,
      rungNotional: RUNG_NOTIONAL,
      stopLoss: 'none',
      sweepSecs: SWEEP_SECS,
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
  log('⏸️  Trading paused (open rungs still managed for TP/sweep/resolution)');
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
  const ladderTxt = LADDER_LEVELS.map(l => `${l.buyPrice.toFixed(2)}→${l.tpPrice.toFixed(2)}`).join(', ');
  log(`🚀 5-Minute BTC Up/Down — Fixed Ladder Grid (Up & Down fully independent, no cross-side triggers)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pair(s) (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Ladder (both sides, independent): ${ladderTxt} | $${RUNG_NOTIONAL} fixed notional per rung | No stop-loss`);
  log(`⚙️  Each rung single-shot: one resting buy, one resting TP @ entry+${TP_OFFSET.toFixed(2)}, no re-entry once filled`);
  log(`⚙️  All buys and TPs are resting limit orders (maker, earn rebate) — no taker orders in this strategy`);
  log(`⚙️  At ${SWEEP_SECS}s: cancel still-unfilled rung buys only | filled rungs ride untouched to window resolution (win $1/lose $0)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
