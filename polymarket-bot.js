'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET BTC 5-MINUTE UP/DOWN — INDEPENDENT DUAL-SIDE
 *  RESTING-BUY BOT WITH PER-SIDE MARTINGALE RECOVERY
 * ═══════════════════════════════════════════════════════════════
 *
 *  BTC-only, single market. One entry mechanic (no leg 2):
 *
 *  PER 5-MINUTE WINDOW:
 *    At window open, place a resting limit BUY on Up AND a resting
 *    limit BUY on Down, both at ORDER_PRICE (default 0.33). Unlike the
 *    old dual-leg model, the two orders are completely INDEPENDENT —
 *    one filling does NOT cancel the other. Each side rests until it
 *    either fills (its ask drops to <= ORDER_PRICE) or the window ends
 *    (in which case that side's unfilled resting order is simply
 *    cancelled — no trade on that side this window).
 *
 *    It's possible for a window to produce: no fills, an Up fill only,
 *    a Down fill only, or fills on BOTH sides.
 *
 *  SIZING — PER-SIDE MARTINGALE RECOVERY:
 *    Up and Down each carry their OWN independent recovery state,
 *    since they are independent bet streams:
 *      - Normally trade BASE_SHARES.
 *      - After 2 CONSECUTIVE LOSSES on that side, the size DOUBLES for
 *        the next trade on that side (3rd trade = 2x).
 *      - The doubled size stays in effect until the cumulative P&L of
 *        that side's streak (starting from the first of the 2 losses)
 *        returns to breakeven or better — i.e. the losses are fully
 *        recovered — at which point size resets to BASE_SHARES.
 *      - If the doubled size keeps losing, every further 2 CONSECUTIVE
 *        losses doubles it again (2x -> 4x -> 8x -> ...) until it
 *        recovers.
 *      - A win while still in recovery (but not enough to fully clear
 *        the streak P&L) resets the *consecutive*-loss counter but
 *        keeps the current multiplier in place until full recovery.
 *
 *    This recovery state is PER SIDE and PERSISTS ACROSS WINDOWS (it is
 *    not part of the per-window state that gets reset every 5 minutes).
 *
 *  HOLD / RESOLUTION:
 *    Any filled position(s) simply ride to window resolution — there is
 *    no stop-loss and no take-profit. A winning share pays $1, a losing
 *    share pays $0.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable via setMode(), independent
 *    of the pause/resume toggle.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // force-resolve this many seconds BEFORE the nominal window end
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];
const SYMBOL                = 'BTC'; // single-market bot

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // runtime-switchable — see setMode
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const ORDER_PRICE  = Number(process.env.ORDER_PRICE || process.env.LEG1_PRICE || 0.33);   // resting buy price, both sides, at window open
const BASE_SHARES  = Number(process.env.BASE_SHARES || process.env.LEG1_SHARES || 100);   // base size per side before any recovery doubling

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let totalEquityCurve = [];

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-btc-indep-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-btc-indep-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function placeLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function cancelOrder(orderId) {
  if (!orderId) return null;
  if (!DRY_RUN && trader) {
    if (typeof trader.cancelOrder === 'function') return await trader.cancelOrder(orderId);
    log('⚠️  trader.cancelOrder() is not implemented in polymarket-trader.js — an unfilled resting order was NOT actually cancelled on-chain. Add a cancelOrder(orderId) method mirroring limitBuy.');
    return null;
  }
  return { ok: true };
}

// ─────────────────────────────────────────
//  Per-side martingale recovery state — PERSISTS ACROSS WINDOWS
// ─────────────────────────────────────────
function freshRecoverySide() {
  return {
    multiplier: 1,     // current size multiplier (1, 2, 4, 8, ...)
    lossStreak: 0,      // consecutive losses within the current streak
    streakPnl: 0,        // cumulative pnl since the streak began (0 while flat)
  };
}
let recovery = { Up: freshRecoverySide(), Down: freshRecoverySide() };

function currentShares(side) {
  return round2(BASE_SHARES * recovery[side].multiplier);
}

// Applies a resolved trade's profit to that side's recovery state and
// returns a short description of what happened, for logging.
function applyRecoveryResult(side, profit) {
  const r = recovery[side];
  const wasMultiplier = r.multiplier;
  let note;

  if (r.multiplier === 1 && r.lossStreak === 0) {
    // Flat — no active streak yet.
    if (profit < 0) {
      r.lossStreak = 1;
      r.streakPnl = profit;
      note = `loss #1 of streak (streakPnl=$${r.streakPnl.toFixed(2)}) — size stays base`;
    } else {
      note = 'win at base size — no streak';
    }
  } else if (r.multiplier === 1 && r.lossStreak === 1) {
    // One prior loss, still base size — this is the 2nd trade of a possible streak.
    r.streakPnl = round2(r.streakPnl + profit);
    if (profit < 0) {
      r.lossStreak = 2;
      r.multiplier = 2;
      note = `2nd consecutive loss (streakPnl=$${r.streakPnl.toFixed(2)}) — DOUBLING to ${currentShares(side)}sh for next trade`;
    } else {
      r.lossStreak = 0;
      r.streakPnl = 0;
      note = 'win on 2nd trade — streak cleared, back to base';
    }
  } else {
    // Actively recovering (multiplier > 1).
    r.streakPnl = round2(r.streakPnl + profit);
    if (r.streakPnl >= 0) {
      r.multiplier = 1;
      r.lossStreak = 0;
      r.streakPnl = 0;
      note = `RECOVERED — streak pnl back to $0+ — size reset to base (${currentShares(side)}sh)`;
    } else if (profit < 0) {
      r.lossStreak += 1;
      if (r.lossStreak % 2 === 0) {
        r.multiplier *= 2;
        note = `${r.lossStreak} consecutive losses in recovery (streakPnl=$${r.streakPnl.toFixed(2)}) — DOUBLING AGAIN to ${currentShares(side)}sh`;
      } else {
        note = `loss in recovery (streakPnl=$${r.streakPnl.toFixed(2)}) — size stays ${currentShares(side)}sh, one more consecutive loss will double again`;
      }
    } else {
      r.lossStreak = 0;
      note = `win in recovery but not fully cleared (streakPnl=$${r.streakPnl.toFixed(2)}) — size stays ${currentShares(side)}sh, consecutive counter reset`;
    }
  }

  if (r.multiplier !== wasMultiplier || note) {
    log(`🎲 ${side} recovery — ${note}`);
  }
  return note;
}

// ─────────────────────────────────────────
//  Market state (single BTC pair)
// ─────────────────────────────────────────
function freshPairState() {
  return {
    symbol: SYMBOL,
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    phase: 'open', // open | partial | filled | no_fill | closed
    ordersPlaced: false,
    upOrderId: null, downOrderId: null,
    upFilled: false, downFilled: false,
    positionUp: null,   // { side, shares, entryPrice, cost, openedAt }
    positionDown: null, // { side, shares, entryPrice, cost, openedAt }
    resolvedThisWindow: true,
    bankroll: TOTAL_CAPITAL,
    realizedPnl: 0,
    feesPaid: 0,
    wins: 0, losses: 0,
    equityCurve: [{ t: Date.now(), equity: TOTAL_CAPITAL }],
  };
}
let pair = freshPairState();

// ─────────────────────────────────────────
//  Slug / window math (unchanged market-discovery plumbing)
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) { return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS; }
function slugFor(symbol, windowStartSec) { return `${symbol.toLowerCase()}-updown-5m-${windowStartSec}`; }
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
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) return { event, windowStart: ws, slug };
    } catch (_) {}
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
  if (!upId || !downId) { log(`⚠️  ${p.symbol}: window loaded but Up/Down token ids missing`); p.tradable = false; return; }

  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.slug = slug;
  p.eventTitle = event.title || event.slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;
  p.resolvedThisWindow = false;
  p.phase = 'open';
  p.ordersPlaced = false;
  p.upOrderId = null; p.downOrderId = null;
  p.upFilled = false; p.downFilled = false;
  p.positionUp = null; p.positionDown = null;
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | placing independent resting buys — Up ${currentShares('Up')}sh @ ${ORDER_PRICE.toFixed(2)}, Down ${currentShares('Down')}sh @ ${ORDER_PRICE.toFixed(2)}`);
}

// ─────────────────────────────────────────
//  Polymarket price feed (unchanged plumbing, single pair)
// ─────────────────────────────────────────
async function refreshPolyPrices() {
  if (!pair.tradable || !pair.upTokenId || !pair.downTokenId) return;
  const requests = [
    { token_id: pair.upTokenId, side: 'BUY' },
    { token_id: pair.upTokenId, side: 'SELL' },
    { token_id: pair.downTokenId, side: 'BUY' },
    { token_id: pair.downTokenId, side: 'SELL' },
  ];
  function applyPolyPrice(tid, side, price) {
    if (!Number.isFinite(price)) return;
    if (pair.upTokenId === tid) { if (side === 'BUY') pair.upAsk = price; else if (side === 'SELL') pair.upBid = price; }
    else if (pair.downTokenId === tid) { if (side === 'BUY') pair.downAsk = price; else if (side === 'SELL') pair.downBid = price; }
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
    try {
      const [upAsk, upBid, downAsk, downBid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${pair.upTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${pair.upTokenId}&side=SELL`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${pair.downTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${pair.downTokenId}&side=SELL`).catch(() => null),
      ]);
      if (upAsk) pair.upAsk = parseFloat(upAsk.price || upAsk.mid || pair.upAsk);
      if (upBid) pair.upBid = parseFloat(upBid.price || upBid.mid || pair.upBid);
      if (downAsk) pair.downAsk = parseFloat(downAsk.price || downAsk.mid || pair.downAsk);
      if (downBid) pair.downBid = parseFloat(downBid.price || downBid.mid || pair.downBid);
    } catch (_) {}
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function pairMarkValue(p) {
  let v = p.bankroll;
  if (p.positionUp) {
    v += p.positionUp.shares * (p.upBid != null ? p.upBid : p.positionUp.entryPrice);
  }
  if (p.positionDown) {
    v += p.positionDown.shares * (p.downBid != null ? p.downBid : p.positionDown.entryPrice);
  }
  return round2(v);
}
function pushGlobalEquity() {
  const total = pairMarkValue(pair);
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
//  Order placement — independent resting buys on both sides
// ─────────────────────────────────────────
async function placeOpenOrders(p) {
  const upShares = currentShares('Up');
  const downShares = currentShares('Down');
  const upOrder = await placeLimitBuy(p.upTokenId, ORDER_PRICE, upShares);
  const downOrder = await placeLimitBuy(p.downTokenId, ORDER_PRICE, downShares);
  p.upOrderId = upOrder?.id || null;
  p.downOrderId = downOrder?.id || null;
  p.ordersPlaced = true;
  p.phase = 'open';
  log(`🎯 ${p.symbol} — placed INDEPENDENT resting limit buys @ ${ORDER_PRICE.toFixed(2)}: Up ${upShares}sh (mult=${recovery.Up.multiplier}x) | Down ${downShares}sh (mult=${recovery.Down.multiplier}x) — either, both, or neither may fill`);
}

// A resting buy limit at ORDER_PRICE fills once the market's ask on that
// side drops to (or below) ORDER_PRICE — used as the fill proxy from the
// live price feed. Up and Down are checked and filled fully independently.
async function checkFills(p) {
  if (!p.upFilled && p.upAsk != null && p.upAsk <= ORDER_PRICE) {
    await tryFillSide(p, 'Up');
  }
  if (!p.downFilled && p.downAsk != null && p.downAsk <= ORDER_PRICE) {
    await tryFillSide(p, 'Down');
  }
  updatePhase(p);
}

async function tryFillSide(p, side) {
  const shares = currentShares(side);
  const price = ORDER_PRICE;
  const cost = round2(price * shares);

  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol} ${side} fill detected but insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)}) — skipping ${side} this window`);
    if (side === 'Up') p.upFilled = true; else p.downFilled = true;
    return;
  }

  p.bankroll = round2(p.bankroll - cost);
  const position = { side, shares, entryPrice: price, cost, openedAt: Date.now() };
  if (side === 'Up') { p.positionUp = position; p.upFilled = true; }
  else { p.positionDown = position; p.downFilled = true; }

  log(`✅ ${p.symbol} ${side} FILLED — bought ${shares}sh @ ${price.toFixed(2)} | cost=$${cost.toFixed(2)} (mult=${recovery[side].multiplier}x)`);
  registerTrade(p, { side: 'BUY', outcome: side, reason: `${side.toUpperCase()}-ENTRY`, price, shares, cost, fee: 0 });
  recordEquity(p);
}

function updatePhase(p) {
  if (p.positionUp && p.positionDown) p.phase = 'filled';
  else if (p.positionUp || p.positionDown) p.phase = 'partial';
  else p.phase = 'open';
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
  } catch (_) {}
  if (p.upBid != null && p.downBid != null) return p.upBid >= p.downBid ? 'Up' : 'Down';
  return null;
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  // Cancel any unfilled resting orders.
  if (p.ordersPlaced && !p.upFilled) {
    await cancelOrder(p.upOrderId);
    log(`${p.symbol} window closed — Up never filled (never reached ${ORDER_PRICE.toFixed(2)}) — no Up trade this window`);
  }
  if (p.ordersPlaced && !p.downFilled) {
    await cancelOrder(p.downOrderId);
    log(`${p.symbol} window closed — Down never filled (never reached ${ORDER_PRICE.toFixed(2)}) — no Down trade this window`);
  }

  const hasAnyPosition = !!(p.positionUp || p.positionDown);
  const winnerSide = hasAnyPosition ? await determineWinningSide(p) : null;
  let windowProfit = 0;

  if (p.positionUp) {
    const pos = p.positionUp;
    const won = winnerSide === pos.side;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    windowProfit = round2(windowProfit + profit);
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION [UP] winner=${winnerSide ?? '?'} | held Up ${pos.shares}sh | proceeds=$${proceeds.toFixed(2)} | cost=$${pos.cost.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: pos.side, winner: winnerSide, reason: 'UP-RESOLUTION', price: won ? 1 : 0, shares: pos.shares, proceeds, profit });
    if (won) p.wins++; else p.losses++;
    applyRecoveryResult('Up', profit);
    p.positionUp = null;
  }
  if (p.positionDown) {
    const pos = p.positionDown;
    const won = winnerSide === pos.side;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    windowProfit = round2(windowProfit + profit);
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION [DOWN] winner=${winnerSide ?? '?'} | held Down ${pos.shares}sh | proceeds=$${proceeds.toFixed(2)} | cost=$${pos.cost.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: pos.side, winner: winnerSide, reason: 'DOWN-RESOLUTION', price: won ? 1 : 0, shares: pos.shares, proceeds, profit });
    if (won) p.wins++; else p.losses++;
    applyRecoveryResult('Down', profit);
    p.positionDown = null;
  }
  p.phase = 'closed';
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Main per-window tick
// ─────────────────────────────────────────
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable || !tradingEnabled) return;

  const elapsed = nowSec() - p.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
  if (p.resolvedThisWindow) return;

  // Step 1 — independent resting orders go out immediately at window open.
  if (!p.ordersPlaced) {
    await placeOpenOrders(p);
    return;
  }

  // Step 2 — check both sides independently for fills, every tick.
  if (!p.upFilled || !p.downFilled) {
    await checkFills(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const markValue = pairMarkValue(pair);
  const heldValue = round2(markValue - pair.bankroll);
  const costBasis = round2((pair.positionUp?.cost || 0) + (pair.positionDown?.cost || 0));
  const unrealized = round2(heldValue - costBasis);
  const pairState = {
    symbol: pair.symbol, tradable: pair.tradable, slug: pair.slug, windowEnd: pair.windowEnd,
    secsToEnd: pair.windowEnd ? Math.max(0, Math.floor(pair.windowEnd - nowSec())) : null,
    phase: pair.phase,
    upAsk: pair.upAsk, upBid: pair.upBid, downAsk: pair.downAsk, downBid: pair.downBid,
    positionUp: pair.positionUp, positionDown: pair.positionDown,
    upFilled: pair.upFilled, downFilled: pair.downFilled,
    bankroll: pair.bankroll, realizedPnl: pair.realizedPnl, unrealizedPnl: unrealized, markValue,
    feesPaid: pair.feesPaid, wins: pair.wins, losses: pair.losses,
    equityCurve: pair.equityCurve,
  };
  const totalWins = pair.wins, totalLosses = pair.losses;
  return {
    dryRun: DRY_RUN, tradingEnabled,
    totalCapital: TOTAL_CAPITAL, totalBankroll: pair.bankroll, totalMarkValue: markValue,
    totalRealizedPnl: pair.realizedPnl, totalUnrealizedPnl: unrealized, totalPnl: round2(markValue - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid: pair.feesPaid,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      orderPrice: ORDER_PRICE, baseShares: BASE_SHARES,
    },
    recovery: {
      Up: { ...recovery.Up, currentShares: currentShares('Up') },
      Down: { ...recovery.Down, currentShares: currentShares('Down') },
    },
    pairState, totalEquityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastPolyPriceFetch = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshPolyPrices(); }
      try { await processPair(pair); } catch (e) { log(`⚠️  ${pair.symbol} tick error: ${e.message}`); }
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (existing positions still tracked for resolution bookkeeping)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

// Runtime live/demo switch — DRY_RUN is no longer fixed at startup. An
// existing open position is left alone (still tracked for bookkeeping);
// only NEW orders placed after the switch use the new mode.
function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) {
    log(DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real orders');
  }
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 BTC Independent Dual-Side Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} capital | resting buys @ ${ORDER_PRICE.toFixed(2)} on Up AND Down independently at window open (no leg2, fills don't cancel each other) | base size ${BASE_SHARES}sh/side | per-side martingale: 2 consecutive losses -> double size on 3rd trade, stays doubled (doubling further every 2 more consecutive losses) until that side's streak P&L recovers to breakeven, then resets to base | no SL/TP — rides to resolution`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, pauseTrading, resumeTrading, setMode, getStatus, buildState };
