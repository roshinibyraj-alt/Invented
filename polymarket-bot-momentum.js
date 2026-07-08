'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — DUAL-SIDE MOMENTUM BREAKOUT LADDER
 * ═══════════════════════════════════════════════════════════════
 *
 *  This is a deliberate logical REVERSAL of the prior "dip ladder"
 *  strategy, which bought weakness (price falling) with no stop-loss
 *  and lost consistently. Every point below is the mirror image of
 *  that design, run identically and independently on Up and Down.
 *
 *  PER WINDOW, per side (Up and Down each get their own full ladder,
 *  fully independent):
 *    - 9 fixed price levels, spaced 0.10 apart, from 0.10 up to 0.90:
 *      0.10 / 0.20 / 0.30 / 0.40 / 0.50 / 0.60 / 0.70 / 0.80 / 0.90.
 *    - REVERSED ACTIVATION: instead of arming levels as price falls
 *      into them, levels arm as price RISES through them — buying
 *      strength/confirmation instead of buying weakness. Whenever
 *      price reaches level L, the ladder activates L plus the next 2
 *      levels ABOVE it (3 total) — e.g. price reaching 0.60 activates
 *      0.60/0.70/0.80. The active set only ever grows; already-armed
 *      levels are never cancelled just because price moved past them.
 *    - REVERSED SIZING: instead of fixed dollars (biggest share count
 *      on the cheapest, least-confirmed levels), dollars committed
 *      SCALE UP with price: dollars(level) = GRID_DOLLARS_BASE *
 *      (price / LADDER_TOP). A fill at 0.80 commits ~4x the capital of
 *      a fill at 0.20. The logic: the higher the price, the more the
 *      market has already confirmed that direction, so more conviction
 *      capital goes there — the opposite of loading up on longshots.
 *    - TP is still a relative offset, entry + 0.05, since this is a
 *      trend-continuation bet and a further push up is still the win
 *      condition (a fill at 0.60 targets 0.65).
 *    - NEW — STOP LOSS: each position also gets a stop at entry - 0.06
 *      (SL_OFFSET). If the "breakout" fails and price reverses back
 *      down through the stop, the position is sold at a small, bounded
 *      loss instead of riding unmanaged to zero. This is the single
 *      biggest structural reversal versus the prior bot.
 *    - Each level is one-shot per window: once filled (and exited via
 *      TP or SL), it does NOT re-arm this window. Next window every
 *      level resets fresh (unactivated) on both sides.
 *
 *  WINDOW CLOSE: any activated-but-unfilled resting buy is cancelled —
 *  no capital was ever committed to it, so no P&L impact. Any filled
 *  level still waiting on TP/SL rides to resolution as a last resort;
 *  its resting TP/SL orders are cancelled first (settlement is
 *  automatic on-chain redemption, not a market order).
 *
 *  FEES: ladder buys and TP sells are genuine resting maker orders and
 *  earn the 20% maker rebate. The new stop-loss sell is the one
 *  deliberately AGGRESSIVE (taker) order in this design — cutting a
 *  losing position needs to execute promptly rather than hope for a
 *  passive fill, so it pays the taker fee per Polymarket Fee Structure
 *  V2 in exchange for actually getting out.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const RESOLUTION_BUFFER_S   = 8;  // no longer used for triggering resolution (see EARLY_CUTOFF_SECS) — left defined in case anything else needs it
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // force-resolve this many seconds BEFORE the nominal window end (298s), so nothing carries into the next window
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function round2(n) { return Math.round(n * 100) / 100; }

// ── Dual-side momentum breakout ladder parameters ──
const LADDER_TOP    = Number(process.env.LADDER_TOP || 0.90);   // highest buy level
const LADDER_BOTTOM = Number(process.env.LADDER_BOTTOM || 0.10); // lowest buy level
const LADDER_STEP   = Number(process.env.LADDER_STEP || 0.10);
const GRID_DOLLARS_BASE = Number(process.env.GRID_DOLLARS_BASE || 50); // $ at the TOP level; scales down proportionally for lower levels
const TP_OFFSET     = Number(process.env.TP_OFFSET || 0.05);    // relative to each level's own entry price
const SL_OFFSET      = Number(process.env.SL_OFFSET || 0.06);   // NEW: stop-loss offset below entry — the core reversal vs. the old no-SL design
const ACTIVATE_LOOKAHEAD = Number(process.env.ACTIVATE_LOOKAHEAD || 3); // current level + this many ABOVE get activated as price rises
const MIN_SHARES = Number(process.env.MIN_SHARES || 5);

function buildLevelPrices() {
  const levels = [];
  for (let p = LADDER_BOTTOM; p <= LADDER_TOP + 1e-9; p = round2(p + LADDER_STEP)) levels.push(round2(p));
  return levels;
}
const LEVEL_PRICES = buildLevelPrices(); // [0.10, 0.20, ..., 0.90], ascending

// Dollars committed at a given level: scales UP with price/confidence,
// the mirror of the old bot's flat-dollar (biggest-shares-on-longshots) sizing.
function dollarsForLevel(price) {
  return round2(GRID_DOLLARS_BASE * (price / LADDER_TOP));
}

const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
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
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-dip-ladder-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-dip-ladder-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

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
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Pair / level state
// ─────────────────────────────────────────
function freshLevels() {
  const levels = [];
  for (const side of ['Up', 'Down']) {
    for (const price of LEVEL_PRICES) {
      levels.push({ side, price, activated: false, orderId: null, filled: false, position: null, tpOrderId: null });
      // position, when set, also carries slPrice (entry - SL_OFFSET); no separate resting SL order is
      // placed on the book (SL is monitored and fired as an aggressive sell — see processLevel).
    }
  }
  return levels;
}

function freshPairState(symbol) {
  return {
    symbol,
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    levels: freshLevels(),
    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,
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

// Activates (places a resting buy for) whichever levels newly come into
// range on a given side: the highest level at-or-below current ask (the
// rung price has just climbed through), plus the next ACTIVATE_LOOKAHEAD-1
// levels ABOVE it — arming the ladder ahead of continued upward momentum.
// Already-activated levels are skipped — the active set only ever grows.
async function maybeActivateLevels(p, side) {
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) return;

  // LEVEL_PRICES is ascending. Find the highest level already reached (<= ask);
  // that's the frontier rung just confirmed by price. Fall back to the floor
  // if price hasn't reached even the lowest level yet.
  let frontierIdx = -1;
  for (let i = 0; i < LEVEL_PRICES.length; i++) if (LEVEL_PRICES[i] <= ask) frontierIdx = i;
  if (frontierIdx === -1) frontierIdx = 0; // price below the whole ladder — nothing confirmed yet, watch the floor

  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  for (let i = frontierIdx; i < Math.min(frontierIdx + ACTIVATE_LOOKAHEAD, LEVEL_PRICES.length); i++) {
    const price = LEVEL_PRICES[i];
    const level = p.levels.find(l => l.side === side && l.price === price);
    if (!level || level.activated) continue;

    const dollars = dollarsForLevel(price);
    const shares = Math.max(round2(dollars / price), MIN_SHARES);
    const order = await placeLimitBuy(tokenId, price, shares);
    level.activated = true;
    level.shares = shares;
    level.orderId = order.id || order.orderId || null;
    log(`📌 ${p.symbol} ${side}@${price.toFixed(2)} activated: resting buy ${shares.toFixed(2)}sh (~$${dollars.toFixed(2)})`);
  }
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
  p.levels = freshLevels();
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z`);
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
      } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function levelMarkValue(p, level) {
  if (!level.position) return 0;
  const bid = level.side === 'Up' ? p.upBid : p.downBid;
  return round2(level.position.shares * (bid ?? level.position.entryPrice));
}
function pairMarkValue(p) {
  const held = p.levels.reduce((s, l) => s + levelMarkValue(p, l), 0);
  return round2(p.bankroll + held);
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
//  Per-level tick processing
// ─────────────────────────────────────────
async function processLevel(p, level) {
  if (!level.activated) return; // no resting order exists yet — nothing to check
  const ask = level.side === 'Up' ? p.upAsk : p.downAsk;
  const bid = level.side === 'Up' ? p.upBid : p.downBid;

  if (!level.filled) {
    // REVERSED: the old ladder filled once price fell TO or BELOW the level
    // (buying weakness). This one fills once price has risen TO or ABOVE the
    // level (buying confirmed strength) — so it triggers on ask >= price.
    if (ask == null || ask < level.price) return; // breakout hasn't been confirmed yet
    const shares = level.shares;
    const cost = round2(level.price * shares);
    if (cost > p.bankroll) {
      log(`⏭️  ${p.symbol} ${level.side}@${level.price}: skip fill — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)})`);
      level.filled = true; // don't keep retrying an unaffordable level all window
      return;
    }
    const rebate = makerRebate(shares, level.price);
    p.bankroll = round2(p.bankroll - cost + rebate);
    p.realizedPnl = round2(p.realizedPnl + rebate);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    level.filled = true;
    const tpPrice = round2(Math.min(level.price + TP_OFFSET, 0.99));
    const slPrice = round2(Math.max(level.price - SL_OFFSET, 0.01)); // NEW: bounded downside, unlike the old no-SL design
    level.position = { entryPrice: level.price, shares, cost, tpPrice, slPrice, openedAt: Date.now() };

    const tokenId = level.side === 'Up' ? p.upTokenId : p.downTokenId;
    const tpOrder = await placeLimitSell(tokenId, tpPrice, shares);
    level.tpOrderId = tpOrder.id || tpOrder.orderId || null;
    recordEquity(p);
    log(`🎯 ${p.symbol} ${level.side}@${level.price.toFixed(2)} BUY filled ${shares.toFixed(2)}sh | cost=$${cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP @ ${tpPrice.toFixed(2)} | SL @ ${slPrice.toFixed(2)}`);
    registerTrade(p, { side: 'BUY', outcome: level.side, level: level.price, price: level.price, shares, cost, rebate });
    return;
  }

  if (level.position) {
    const pos = level.position;

    // Stop-loss check first: if price has reversed back down through the
    // stop, exit now at the bid (an aggressive/taker sell — see header note)
    // rather than let the position ride unmanaged toward zero.
    if (bid != null && bid <= pos.slPrice) {
      await cancelOrder(level.tpOrderId); // pull the resting TP, we're exiting via SL instead
      const exitPrice = bid;
      const proceeds = round2(exitPrice * pos.shares);
      const net = proceeds; // taker order — no maker rebate, and this strategy accepts the taker fee here deliberately
      p.bankroll = round2(p.bankroll + net);
      const profit = round2(net - pos.cost);
      p.realizedPnl = round2(p.realizedPnl + profit);
      p.losses++;
      log(`🧯 ${p.symbol} ${level.side}@${level.price.toFixed(2)} SL hit ${pos.shares.toFixed(2)}sh @ ${exitPrice.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { side: 'SELL', outcome: level.side, level: level.price, reason: 'SL', price: exitPrice, shares: pos.shares, profit });
      level.position = null; // one-shot — this level does not re-arm this window
      level.tpOrderId = null;
      recordEquity(p);
      return;
    }

    if (bid == null || bid < pos.tpPrice) return;
    const proceeds = round2(pos.tpPrice * pos.shares);
    const rebate = makerRebate(pos.shares, pos.tpPrice);
    const net = round2(proceeds + rebate);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    p.wins++;
    log(`💰 ${p.symbol} ${level.side}@${level.price.toFixed(2)} TP filled ${pos.shares.toFixed(2)}sh @ ${pos.tpPrice.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: level.side, level: level.price, reason: 'TP', price: pos.tpPrice, shares: pos.shares, profit, rebate });
    level.position = null; // one-shot — this level does not re-arm this window
    level.tpOrderId = null;
    recordEquity(p);
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
  } catch (_) {}
  if (p.upBid != null && p.downBid != null) return p.upBid >= p.downBid ? 'Up' : 'Down';
  return null;
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  const hasOpenPosition = p.levels.some(l => l.position);
  let winner = null;
  if (hasOpenPosition) winner = await determineWinningSide(p);

  for (const level of p.levels) {
    if (!level.filled && level.orderId) {
      await cancelOrder(level.orderId); // never touched cash, no P&L impact
    }
    if (level.position) {
      await cancelOrder(level.tpOrderId);
      const pos = level.position;
      const won = winner === level.side;
      const proceeds = won ? round2(pos.shares * 1) : 0;
      const profit = round2(proceeds - pos.cost);
      p.bankroll = round2(p.bankroll + proceeds);
      p.realizedPnl = round2(p.realizedPnl + profit);
      if (won) p.wins++; else p.losses++;
      const icon = won ? '💰' : '💥';
      log(`${icon} ${p.symbol} ${level.side}@${level.price.toFixed(2)} RESOLUTION ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { side: 'SELL', outcome: level.side, level: level.price, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
      level.position = null;
    }
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
  if (!p.tradable || !tradingEnabled) return;

  // Hard cutoff: finish and clear everything at WINDOW_SECS - EARLY_CUTOFF_SECS
  // (298s by default) instead of waiting for the boundary-crossing detection,
  // which depends on real time actually ticking into the next window AND that
  // window's market already being indexed — a gap where the old ladder's
  // state could still be sitting there when the new window starts loading.
  // Once resolved, nothing further runs for this pair until the next window
  // actually loads — a cancelled/closed level must not get re-processed and
  // re-armed in the couple of seconds still left on the clock.
  const elapsed = nowSec() - p.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
  if (p.resolvedThisWindow) return;

  await maybeActivateLevels(p, 'Up');
  await maybeActivateLevels(p, 'Down');

  for (const level of p.levels) {
    try { await processLevel(p, level); }
    catch (e) { log(`⚠️  ${p.symbol} ${level.side}@${level.price} error: ${e.message}`); }
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(p.levels.reduce((s, l) => s + (l.position ? levelMarkValue(p, l) - l.position.cost : 0), 0));
    const markValue = pairMarkValue(p);
    return {
      symbol: p.symbol, tradable: p.tradable, slug: p.slug, windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      bankroll: p.bankroll, realizedPnl: p.realizedPnl, unrealizedPnl: unrealized, markValue,
      feesPaid: p.feesPaid, rebatesEarned: p.rebatesEarned, wins: p.wins, losses: p.losses,
      levels: p.levels.map(l => ({
        side: l.side, price: l.price, activated: l.activated, filled: l.filled, shares: l.shares || null,
        position: l.position ? { entryPrice: l.position.entryPrice, shares: l.position.shares, cost: l.position.cost, tpPrice: l.position.tpPrice } : null,
      })),
      equityCurve: p.equityCurve,
    };
  });
  const totalBankroll = round2(pairStates.reduce((s, p) => s + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((s, p) => s + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((s, p) => s + p.realizedPnl, 0));
  const totalUnrealized = round2(pairStates.reduce((s, p) => s + p.unrealizedPnl, 0));
  const totalWins = pairStates.reduce((s, p) => s + p.wins, 0);
  const totalLosses = pairStates.reduce((s, p) => s + p.losses, 0);
  return {
    dryRun: DRY_RUN, tradingEnabled, pairs: pairList,
    totalCapital: TOTAL_CAPITAL, perPairCapital, totalBankroll, totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized, totalUnrealizedPnl: totalUnrealized, totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid: round2(pairStates.reduce((s, p) => s + p.feesPaid, 0)),
    totalRebatesEarned: round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0)),
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: { levelPrices: LEVEL_PRICES, gridDollarsBase: GRID_DOLLARS_BASE, tpOffset: TP_OFFSET, slOffset: SL_OFFSET, activateLookahead: ACTIVATE_LOOKAHEAD, cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE, cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE },
    pairStates, totalEquityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshPolyPrices(); }
      for (const p of Object.values(pairs)) { try { await processPair(p); } catch (e) { log(`⚠️  ${p.symbol} tick error: ${e.message}`); } }
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(list) {
  const clean = (list || []).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!clean.length) return { ok: false, error: 'Empty pair list' };
  pairList = [...new Set(clean)];
  resetPairs();
  log(`⚙️  Pairs updated: ${pairList.join(', ')} | $${perPairCapital.toFixed(2)} per pair`);
  return { ok: true, pairs: pairList, perPairCapital };
}
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (open positions still managed for TP/resolution)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Dual-Side Momentum Breakout Ladder Bot (reversal of the dip-ladder strategy)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  ladder: ${LEVEL_PRICES.join('/')} ($ scales up to $${GRID_DOLLARS_BASE} with price, both sides, one-shot per window) | activates ${ACTIVATE_LOOKAHEAD} levels ahead as price rises | TP entry+${TP_OFFSET} | SL entry-${SL_OFFSET}`);
  log(`⚙️  fees: ladder buys + TP sells are maker (+${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate); SL exits are a deliberate taker order to guarantee the cut`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
