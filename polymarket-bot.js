'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — DUAL-SIDE DIP LADDER BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  Every prior strategy (chase/fade research, flip recovery, breakout
 *  pyramid, grid ladder, the original momentum bot) has been removed
 *  completely. This is a different strategy from scratch, run
 *  identically and independently on Up and Down at the same time.
 *
 *  PER WINDOW, per side (Up and Down each get their own full ladder,
 *  fully independent):
 *    - 9 fixed price levels, spaced 0.10 apart, from 0.90 down to 0.10:
 *      0.90 / 0.80 / 0.70 / 0.60 / 0.50 / 0.40 / 0.30 / 0.20 / 0.10.
 *    - UNLIKE a static ladder, levels are NOT all placed at window open.
 *      Instead each level only gets a resting (maker) buy order placed
 *      once it's "activated": whenever price sits at level L, the ladder
 *      activates L plus the next 2 levels below it (3 total) — e.g.
 *      price at 0.80 activates 0.80/0.70/0.60. As price keeps falling
 *      and new levels come into range, MORE levels activate — the active
 *      set only ever grows, already-activated resting orders are never
 *      cancelled just because price moved past them. Near the bottom of
 *      the ladder fewer than 3 new levels may be left to activate (down
 *      to just the 0.10 floor), so the count naturally varies.
 *    - Sizing is FIXED DOLLARS, not fixed shares: $50 committed per
 *      level regardless of price, so share count varies by level
 *      (e.g. $50/0.80 ≈ 62.5sh vs $50/0.10 = 500sh — deeper levels get
 *      more shares for the same capital).
 *    - TP is a relative offset now, not one shared fixed price: each
 *      level's own entry + 0.05 (a fill at 0.60 targets 0.65; a fill at
 *      0.10 targets 0.15).
 *    - Each level is one-shot per window: once filled, it does NOT
 *      re-arm or get bought again this window. Next window every level
 *      resets fresh (unactivated) on both sides.
 *    - NO STOP LOSS (explicitly confirmed, unchanged from before) — a
 *      filled position that never reaches its TP simply rides to the
 *      real window resolution, winning $1 or losing to $0.
 *
 *  WINDOW CLOSE: any activated-but-unfilled resting buy is cancelled —
 *  no capital was ever committed to it, so no P&L impact. Any filled
 *  level still waiting on its TP rides to resolution; that resting TP
 *  order is cancelled first (settlement is automatic on-chain
 *  redemption, not a market order).
 *
 *  FEES: every order in this strategy is a genuine resting maker order —
 *  every activated ladder buy AND every TP sell. With no SL and no other
 *  forced/aggressive exit anywhere in the design, this strategy never
 *  places a single taker order. Per Polymarket Fee Structure V2, that
 *  means it never pays a trading fee at all — only ever earns the 20%
 *  maker rebate on fills, or settles resolution fee-free.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const RESOLUTION_BUFFER_S   = 8;
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function round2(n) { return Math.round(n * 100) / 100; }

// ── Dual-side dip ladder parameters ──
const LADDER_TOP    = Number(process.env.LADDER_TOP || 0.90);   // highest buy level
const LADDER_BOTTOM = Number(process.env.LADDER_BOTTOM || 0.10); // lowest buy level
const LADDER_STEP   = Number(process.env.LADDER_STEP || 0.10);
const GRID_DOLLARS  = Number(process.env.GRID_DOLLARS || 50);   // fixed $ per level, every level, both sides — shares vary by price
const TP_OFFSET     = Number(process.env.TP_OFFSET || 0.05);    // relative to each level's own entry price
const ACTIVATE_LOOKAHEAD = Number(process.env.ACTIVATE_LOOKAHEAD || 3); // current level + this many below get activated
const MIN_SHARES = Number(process.env.MIN_SHARES || 5);

function buildLevelPrices() {
  const levels = [];
  for (let p = LADDER_TOP; p >= LADDER_BOTTOM - 1e-9; p = round2(p - LADDER_STEP)) levels.push(round2(p));
  return levels;
}
const LEVEL_PRICES = buildLevelPrices(); // [0.90, 0.80, ..., 0.10], descending

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
// range on a given side: the highest level at-or-below current ask, plus
// the next ACTIVATE_LOOKAHEAD-1 levels below it. Already-activated levels
// are skipped — the active set only ever grows.
async function maybeActivateLevels(p, side) {
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) return;

  let frontierIdx = LEVEL_PRICES.findIndex(lv => lv <= ask);
  if (frontierIdx === -1) frontierIdx = LEVEL_PRICES.length - 1; // price below the whole ladder — just the floor level

  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  for (let i = frontierIdx; i < Math.min(frontierIdx + ACTIVATE_LOOKAHEAD, LEVEL_PRICES.length); i++) {
    const price = LEVEL_PRICES[i];
    const level = p.levels.find(l => l.side === side && l.price === price);
    if (!level || level.activated) continue;

    const shares = Math.max(round2(GRID_DOLLARS / price), MIN_SHARES);
    const order = await placeLimitBuy(tokenId, price, shares);
    level.activated = true;
    level.shares = shares;
    level.orderId = order.id || order.orderId || null;
    log(`📌 ${p.symbol} ${side}@${price.toFixed(2)} activated: resting buy ${shares.toFixed(2)}sh (~$${GRID_DOLLARS})`);
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
    if (ask == null || ask > level.price) return; // resting buy hasn't been reached yet
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
    const tpPrice = round2(level.price + TP_OFFSET);
    level.position = { entryPrice: level.price, shares, cost, tpPrice, openedAt: Date.now() };

    const tokenId = level.side === 'Up' ? p.upTokenId : p.downTokenId;
    const tpOrder = await placeLimitSell(tokenId, tpPrice, shares);
    level.tpOrderId = tpOrder.id || tpOrder.orderId || null;
    recordEquity(p);
    log(`🎯 ${p.symbol} ${level.side}@${level.price.toFixed(2)} BUY filled ${shares.toFixed(2)}sh | cost=$${cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP resting @ ${tpPrice.toFixed(2)}`);
    registerTrade(p, { side: 'BUY', outcome: level.side, level: level.price, price: level.price, shares, cost, rebate });
    return;
  }

  if (level.position) {
    if (bid == null || bid < level.position.tpPrice) return;
    const pos = level.position;
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

  await maybeActivateLevels(p, 'Up');
  await maybeActivateLevels(p, 'Down');

  for (const level of p.levels) {
    try { await processLevel(p, level); }
    catch (e) { log(`⚠️  ${p.symbol} ${level.side}@${level.price} error: ${e.message}`); }
  }

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) await resolvePairWindow(p);
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
    config: { levelPrices: LEVEL_PRICES, gridDollars: GRID_DOLLARS, tpOffset: TP_OFFSET, activateLookahead: ACTIVATE_LOOKAHEAD, cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE, cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE },
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
  log(`🚀 Dual-Side Dip Ladder Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  ladder: ${LEVEL_PRICES.join('/')} ($${GRID_DOLLARS}/level regardless of shares, both sides, one-shot per window) | activates ${ACTIVATE_LOOKAHEAD} levels ahead as price falls | TP entry+${TP_OFFSET} | no SL — rides to resolution`);
  log(`⚙️  fees: every order is maker (0 fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate) — no taker orders exist in this strategy`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
