'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET BTC 5-MINUTE UP/DOWN — DUAL-LEG 0.33 / 0.66 BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  BTC-only, single market. Completely replaces the old 0.96-breakout +
 *  recovery model with a two-leg entry:
 *
 *  PER 5-MINUTE WINDOW:
 *    1. LEG 1 (as soon as the window opens):
 *       Place a resting limit BUY on BOTH sides (Up and Down) at
 *       LEG1_PRICE (default 0.33) for LEG1_SHARES (default 100) each.
 *       Whichever side fills first is the "cheap side" — the instant it
 *       fills, the resting order on the OTHER side is cancelled. Only one
 *       side of leg 1 is ever held.
 *
 *       If NEITHER side ever fills before the window ends, both resting
 *       orders are cancelled and the bot takes no trade at all that
 *       window (leg 2 needs a defined cheap/expensive pair from leg 1).
 *
 *    2. WATCH (leg 2 arming):
 *       The bot waits until 3 minutes (LEG1_WATCH_SECS, default 180s)
 *       have elapsed since the window opened, observing the "expensive
 *       side" — the side OPPOSITE whichever one leg 1 filled on. (If leg 1
 *       fills after the 3-minute mark has already passed, leg-2 watching
 *       starts immediately at fill time instead of waiting further.)
 *
 *    3. LEG 2:
 *       From the 3-minute mark through window end, continuously monitor
 *       the expensive side's ask price. The instant it is above LEG2_PRICE
 *       (default 0.66), fire a single-shot limit BUY on the expensive side
 *       at LEG2_PRICE for LEG2_SHARES (default 166). This can fire at any
 *       point from 3:00 to window end — not just at the 3:00 mark itself.
 *       Only fires once per window, and only if leg 1 filled.
 *
 *  HOLD / RESOLUTION:
 *    Both legs (if filled) simply ride to window resolution — there is no
 *    stop-loss and no take-profit order for either leg. A winning share
 *    pays $1, a losing share pays $0, exactly as resolved by Polymarket /
 *    this bot's own resolution bookkeeping (same resolution determination
 *    is used for both legs since they sit on opposite outcomes of the same
 *    market).
 *
 *  EXECUTION:
 *    - Leg 1: two resting limit BUY orders placed at window open, priced
 *      exactly at LEG1_PRICE, on both outcomes. First fill wins; the
 *      other resting order is cancelled immediately.
 *    - Leg 2: single-shot limit BUY at LEG2_PRICE, fired the instant the
 *      expensive side's ask crosses above LEG2_PRICE. No retry/re-quote —
 *      if it's missed for that window, it's missed.
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
const LEG1_PRICE       = Number(process.env.LEG1_PRICE || 0.33);   // resting buy price, both sides, at window open
const LEG1_SHARES      = Number(process.env.LEG1_SHARES || 100);   // size per side for leg 1
const LEG1_WATCH_SECS  = Number(process.env.LEG1_WATCH_SECS || 180); // 3 minutes — earliest leg 2 can be armed
const LEG2_PRICE       = Number(process.env.LEG2_PRICE || 0.66);   // trigger + fill price for leg 2
const LEG2_SHARES      = Number(process.env.LEG2_SHARES || 166);   // size for leg 2 (expensive side)

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
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-btc-dualleg-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-btc-dualleg-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// The two order actions this bot places: a limit BUY (used for both leg 1's
// resting orders and leg 2's single-shot order), and a cancel (used to kill
// the losing side of leg 1 the instant the other side fills).
async function placeLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function cancelOrder(orderId) {
  if (!orderId) return null;
  if (!DRY_RUN && trader) {
    if (typeof trader.cancelOrder === 'function') return await trader.cancelOrder(orderId);
    log('⚠️  trader.cancelOrder() is not implemented in polymarket-trader.js — the losing side of leg 1 was NOT actually cancelled on-chain. Add a cancelOrder(orderId) method mirroring limitBuy.');
    return null;
  }
  return { ok: true };
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
    phase: 'leg1_open', // leg1_open | leg1_filled | watching_leg2 | leg2_filled | no_leg2 | no_fill | closed
    // leg 1 (both sides resting @ LEG1_PRICE until one fills)
    leg1Placed: false,
    leg1UpOrderId: null, leg1DownOrderId: null,
    leg1FilledSide: null,   // 'Up' | 'Down' | null
    expensiveSide: null,    // the side opposite leg1FilledSide, once known
    position1: null,        // { side, shares, entryPrice, cost, mode: 'leg1', openedAt }
    // leg 2 (resting limit @ LEG2_PRICE on the expensive side, armed once
    // price first crosses above LEG2_PRICE, filled only if it comes back down)
    leg2Armed: false,       // resting order has been placed
    leg2OrderId: null,
    leg2Done: false,        // true once we've either filled leg2 or given up trying this window
    position2: null,        // { side, shares, entryPrice, cost, mode: 'leg2', openedAt }
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
  p.phase = 'leg1_open';
  p.leg1Placed = false;
  p.leg1UpOrderId = null; p.leg1DownOrderId = null;
  p.leg1FilledSide = null;
  p.expensiveSide = null;
  p.position1 = null;
  p.leg2Armed = false;
  p.leg2OrderId = null;
  p.leg2Done = false;
  p.position2 = null;
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | leg1 will place resting buys on both sides @ ${LEG1_PRICE.toFixed(2)} for ${LEG1_SHARES}sh each`);
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
  if (p.position1) {
    const bid = p.position1.side === 'Up' ? p.upBid : p.downBid;
    v += p.position1.shares * (bid != null ? bid : p.position1.entryPrice);
  }
  if (p.position2) {
    const bid = p.position2.side === 'Up' ? p.upBid : p.downBid;
    v += p.position2.shares * (bid != null ? bid : p.position2.entryPrice);
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
//  Leg 1: resting limit buys on both sides @ LEG1_PRICE, first fill wins
// ─────────────────────────────────────────
async function placeLeg1Orders(p) {
  const upOrder = await placeLimitBuy(p.upTokenId, LEG1_PRICE, LEG1_SHARES);
  const downOrder = await placeLimitBuy(p.downTokenId, LEG1_PRICE, LEG1_SHARES);
  p.leg1UpOrderId = upOrder?.id || null;
  p.leg1DownOrderId = downOrder?.id || null;
  p.leg1Placed = true;
  p.phase = 'leg1_open';
  log(`🎯 ${p.symbol} LEG1 — placed resting limit buys on BOTH sides @ ${LEG1_PRICE.toFixed(2)} for ${LEG1_SHARES}sh each (Up + Down) — whichever fills first wins, the other gets cancelled`);
}

// A resting buy limit at LEG1_PRICE fills once the market's ask on that side
// drops to (or below) LEG1_PRICE — that's the fill proxy this bot uses to
// infer resting-order fills from the live price feed.
async function checkLeg1Fill(p) {
  let filledSide = null;
  if (p.upAsk != null && p.upAsk <= LEG1_PRICE) filledSide = 'Up';
  else if (p.downAsk != null && p.downAsk <= LEG1_PRICE) filledSide = 'Down';
  if (!filledSide) return;

  const expensiveSide = filledSide === 'Up' ? 'Down' : 'Up';
  const cancelId = filledSide === 'Up' ? p.leg1DownOrderId : p.leg1UpOrderId;
  await cancelOrder(cancelId);

  const shares = LEG1_SHARES, price = LEG1_PRICE, cost = round2(price * shares);
  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol} LEG1 fill detected on ${filledSide} but insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)}) — skipping the rest of this window`);
    p.leg1FilledSide = filledSide;
    p.leg2Done = true;
    p.phase = 'no_fill';
    return;
  }

  p.bankroll = round2(p.bankroll - cost);
  p.position1 = { side: filledSide, shares, entryPrice: price, cost, mode: 'leg1', openedAt: Date.now() };
  p.leg1FilledSide = filledSide;
  p.expensiveSide = expensiveSide;
  p.phase = 'leg1_filled';
  log(`✅ ${p.symbol} LEG1 FILLED — bought ${filledSide} (cheap side) ${shares}sh @ ${price.toFixed(2)} | cost=$${cost.toFixed(2)} | cancelled resting ${expensiveSide} order | now watching ${expensiveSide} (expensive side) for leg 2`);
  registerTrade(p, { side: 'BUY', outcome: filledSide, reason: 'LEG1-ENTRY', price, shares, cost, fee: 0 });
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Leg 2: resting limit buy on the expensive side @ LEG2_PRICE. Once armed
//  (>= LEG1_WATCH_SECS elapsed AND leg 1 filled), the bot watches the
//  expensive side's ask. The FIRST time it crosses above LEG2_PRICE, the
//  resting limit order is placed (armed) — same as a real limit order, this
//  does NOT fill immediately just because price is trading above 0.66; it
//  only fills once the ask actually comes back down to <= LEG2_PRICE. If
//  price keeps running up and never returns to 0.66 before window end, the
//  resting order is cancelled unfilled — no leg 2 trade that window.
// ─────────────────────────────────────────
async function tryEnterLeg2(p) {
  const side = p.expensiveSide;
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) return;

  // Step 1 — arm: place the resting order the first time price crosses above
  // LEG2_PRICE. This only happens once per window.
  if (!p.leg2Armed) {
    if (ask < LEG2_PRICE) return; // hasn't crossed yet, keep watching
    const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
    const order = await placeLimitBuy(tokenId, LEG2_PRICE, LEG2_SHARES);
    p.leg2OrderId = order?.id || null;
    p.leg2Armed = true;
    log(`🎯 ${p.symbol} LEG2 ARMED — ${side} (expensive side) crossed above ${LEG2_PRICE.toFixed(2)} (currently ${ask.toFixed(2)}) — placed resting limit buy @ ${LEG2_PRICE.toFixed(2)} for ${LEG2_SHARES}sh, waiting for price to come back down to fill`);
    // fall through — if ask happens to already be back at/below LEG2_PRICE
    // on this same tick, check for fill immediately below.
  }

  // Step 2 — confirm fill: the resting buy only actually fills once the ask
  // is at or below LEG2_PRICE (someone willing to sell at our resting bid).
  // A one-way move that never comes back means this never fills.
  if (ask > LEG2_PRICE) return; // still resting unfilled, keep waiting

  const shares = LEG2_SHARES, price = LEG2_PRICE, cost = round2(price * shares);
  if (cost > p.bankroll) {
    await cancelOrder(p.leg2OrderId);
    log(`⏭️  ${p.symbol} LEG2 would have filled but insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)}) — cancelled`);
    p.leg2Done = true;
    p.phase = 'no_leg2';
    return;
  }

  p.bankroll = round2(p.bankroll - cost);
  p.position2 = { side, shares, entryPrice: price, cost, mode: 'leg2', openedAt: Date.now() };
  p.leg2Done = true;
  p.phase = 'leg2_filled';
  log(`✅ ${p.symbol} LEG2 FILLED — bought ${side} (expensive side) ${shares}sh @ ${price.toFixed(2)} | cost=$${cost.toFixed(2)} | now holding both legs to resolution (no SL/TP)`);
  registerTrade(p, { side: 'BUY', outcome: side, reason: 'LEG2-ENTRY', price, shares, cost, fee: 0 });
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Window resolution — both legs (if filled) resolve off the same outcome
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

  // If leg 1 never filled, cancel both resting orders — no trade this window.
  if (p.leg1Placed && !p.leg1FilledSide) {
    await cancelOrder(p.leg1UpOrderId);
    await cancelOrder(p.leg1DownOrderId);
    log(`${p.symbol} window closed — LEG1 never filled (neither side reached ${LEG1_PRICE.toFixed(2)}) — no trade at all this window`);
  } else if (p.position1 && !p.position2) {
    if (p.leg2Armed) {
      await cancelOrder(p.leg2OrderId);
      log(`${p.symbol} window closing with only LEG1 filled — LEG2 was armed (${p.expensiveSide} crossed above ${LEG2_PRICE.toFixed(2)}) but price never came back down to fill it — resting order cancelled`);
    } else {
      log(`${p.symbol} window closing with only LEG1 filled — expensive side (${p.expensiveSide}) never crossed ${LEG2_PRICE.toFixed(2)}, so LEG2 was never armed`);
    }
  }

  const hasAnyPosition = !!(p.position1 || p.position2);
  const winnerSide = hasAnyPosition ? await determineWinningSide(p) : null;
  let windowProfit = 0;

  if (p.position1) {
    const pos = p.position1;
    const won = winnerSide === pos.side;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    windowProfit = round2(windowProfit + profit);
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION [LEG1] winner=${winnerSide ?? '?'} | held ${pos.side} ${pos.shares}sh | proceeds=$${proceeds.toFixed(2)} (no fee) | cost=$${pos.cost.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: winnerSide, reason: 'LEG1-RESOLUTION', price: won ? 1 : 0, shares: pos.shares, proceeds, profit });
    p.position1 = null;
  }
  if (p.position2) {
    const pos = p.position2;
    const won = winnerSide === pos.side;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    windowProfit = round2(windowProfit + profit);
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION [LEG2] winner=${winnerSide ?? '?'} | held ${pos.side} ${pos.shares}sh | proceeds=$${proceeds.toFixed(2)} (no fee) | cost=$${pos.cost.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: winnerSide, reason: 'LEG2-RESOLUTION', price: won ? 1 : 0, shares: pos.shares, proceeds, profit });
    p.position2 = null;
  }
  if (hasAnyPosition) {
    if (windowProfit > 0) p.wins++;
    else if (windowProfit < 0) p.losses++;
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

  // Step 1 — leg 1 orders go out immediately at window open.
  if (!p.leg1Placed) {
    await placeLeg1Orders(p);
    return;
  }

  // Step 2 — waiting for one side of leg 1 to fill.
  if (!p.leg1FilledSide) {
    p.phase = 'leg1_open';
    await checkLeg1Fill(p);
    return;
  }

  // Step 3 — leg 1 is filled. Leg 2 only arms once >= 3 minutes have
  // elapsed since window open (if leg 1 filled later than that, it's
  // already armed the moment it fills).
  if (elapsed < LEG1_WATCH_SECS) {
    p.phase = 'leg1_filled';
    return;
  }

  if (!p.leg2Done) {
    p.phase = 'watching_leg2';
    await tryEnterLeg2(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const markValue = pairMarkValue(pair);
  const heldValue = round2(markValue - pair.bankroll);
  const costBasis = round2((pair.position1?.cost || 0) + (pair.position2?.cost || 0));
  const unrealized = round2(heldValue - costBasis);
  const pairState = {
    symbol: pair.symbol, tradable: pair.tradable, slug: pair.slug, windowEnd: pair.windowEnd,
    secsToEnd: pair.windowEnd ? Math.max(0, Math.floor(pair.windowEnd - nowSec())) : null,
    secsToWatch: pair.windowStart ? Math.max(0, Math.floor(LEG1_WATCH_SECS - (nowSec() - pair.windowStart))) : null,
    phase: pair.phase,
    upAsk: pair.upAsk, upBid: pair.upBid, downAsk: pair.downAsk, downBid: pair.downBid,
    leg1: pair.position1, leg2: pair.position2,
    leg2Armed: pair.leg2Armed,
    expensiveSide: pair.expensiveSide,
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
      leg1Price: LEG1_PRICE, leg1Shares: LEG1_SHARES, leg1WatchSecs: LEG1_WATCH_SECS,
      leg2Price: LEG2_PRICE, leg2Shares: LEG2_SHARES,
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
  log(`🚀 BTC Dual-Leg 0.33/0.66 Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} capital | LEG1: resting buys both sides @ ${LEG1_PRICE.toFixed(2)} for ${LEG1_SHARES}sh each at window open, first fill wins & cancels the other | LEG2: after ${LEG1_WATCH_SECS}s (${(LEG1_WATCH_SECS/60).toFixed(1)}m), the instant the expensive side's ask first crosses above ${LEG2_PRICE.toFixed(2)} a resting limit buy is placed there @ ${LEG2_PRICE.toFixed(2)} for ${LEG2_SHARES}sh — it only actually fills if price comes back down to ${LEG2_PRICE.toFixed(2)} or below, otherwise it's cancelled unfilled at window end | no SL/TP on either leg — both ride to resolution`);
  log(`⚙️  if LEG1 never fills, no trade that window; if LEG1 fills but LEG2's trigger never hits, only LEG1 rides to resolution`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, pauseTrading, resumeTrading, setMode, getStatus, buildState };
