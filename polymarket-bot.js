'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — PARALLEL GRID LADDER BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  MARKETS: same deterministic 5-minute "<asset>-updown-5m-<windowStart>"
 *  events as before (e.g. btc-updown-5m-1782897900). Each has an Up token
 *  and a Down token; Up pays $1 at close if price is >= the window's open
 *  price, Down pays $1 otherwise.
 *
 *  STRATEGY (completely replaces the old momentum/z-score signal engine —
 *  there is no directional bet here at all, no Binance price feed, no
 *  entry filters. It is a pure grid / market-making ladder that profits
 *  from Up and Down oscillating, run identically and independently on
 *  both sides at once):
 *
 *  When a window loads, the bot reads each side's current best ask as
 *  that side's anchor price (P0) and places TWO resting buy orders per
 *  side, 0.05 apart, each targeting +0.10 above its own entry:
 *    Unit 1: buy @ (P0 - 0.05), TP @ (P0 + 0.05)
 *    Unit 2: buy @ (P0 - 0.10), TP @ P0
 *  Down mirrors Up exactly, off Down's own current ask. That's 4
 *  independent units per pair: Up-1, Up-2, Down-1, Down-2.
 *
 *  Each unit starts with UNIT_BASE_SHARES (50) shares and then runs
 *  forever (until window close) as its own self-funding loop:
 *    - Buy fills (maker, resting order actually gets hit) → the TP sell
 *      for that same size is what we're now resting for.
 *    - TP fills (maker, resting sell actually gets hit) → immediately
 *      re-quote a new buy 0.05 below that TP price, sized with the FULL
 *      proceeds of the trade just closed (original capital + profit) —
 *      each unit compounds only its own winnings, never touching the
 *      other 3 units or the shared bankroll beyond its own trades.
 *    - If a resting BUY never fills and the market's ask runs 0.15 away
 *      from it, the order is stale (won't realistically fill soon) — it
 *      gets cancelled and re-quoted at (current ask - 0.05), same size,
 *      no capital lost since nothing filled.
 *
 *  Every order in this strategy is a genuine resting (maker) order — the
 *  initial buys, the TP sells, and the re-quotes after a stale cancel are
 *  all passive limit orders that must be crossed by someone else to fill.
 *  That means, per Polymarket's real fee schedule, EVERY fill here is fee
 *  free and earns the maker rebate — there is no taker/market order
 *  anywhere in this strategy (confirmed: no stop-loss either, per design;
 *  a filled position that never reaches TP simply rides to resolution).
 *
 *  WINDOW CLOSE: any still-resting (unfilled) buy order is cancelled.
 *  Any unit currently holding a filled position that never reached its TP
 *  rides to resolution (wins $1 or $0 based on the real market outcome,
 *  fee-free settlement, same as before). The next window starts every
 *  unit fresh again at UNIT_BASE_SHARES, re-anchored to that window's own
 *  opening price — compounding is scoped within a single window's ladder
 *  cycles, not carried across windows.
 *
 *  FEES: unchanged Polymarket Fee Structure V2 math (crypto: taker fee =
 *  shares × 0.07 × price × (1-price), maker rebate = that × 20%) — this
 *  strategy just never triggers the taker side of it, since nothing here
 *  is an aggressive order.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Timing ──
const TICK_MS                = 500;    // main decision loop
const POLY_PRICE_REFRESH_MS  = 1000;   // CLOB price poll
const WINDOW_SECS            = 300;    // 5 minutes
const RESOLUTION_BUFFER_S    = 8;      // wait this long past window close before finalizing outcome
const SLUG_OFFSET_FALLBACKS  = [0, -300, 300]; // handle brief indexing lag around the boundary

// ── Env / config ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ── Grid ladder parameters ──
const UNIT_BASE_SHARES     = Number(process.env.UNIT_BASE_SHARES || 50); // starting size for every unit, every window
const GRID_STEP            = Number(process.env.GRID_STEP || 0.05);      // spacing between the 2 units, and the re-quote offset
const UNIT_TP_OFFSET       = Number(process.env.UNIT_TP_OFFSET || 0.10); // every unit's TP = its own buy price + this
const PRICE_JUMP_THRESHOLD = Number(process.env.PRICE_JUMP_THRESHOLD || 0.15); // cancel & re-quote a stale resting buy past this distance
const MIN_SHARES           = Number(process.env.MIN_SHARES || 5); // Polymarket order minimum

// ── Fees & maker rebates (Polymarket Fee Structure V2, crypto category) ──
// fee = shares × feeRate × price × (1-price), taker-only. This strategy
// never places a taker order, but the math is kept in case a future
// change (or a position ridden to resolution — which is still fee-free,
// it's settlement not a trade) needs it.
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
let pairs = {}; // symbol -> pair state
let lastPolyPriceFetch = 0;
let totalEquityCurve = [];

// ─────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ─────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-grid-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-grid-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Order helpers (real trader calls, gated by DRY_RUN)
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
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Pair / unit state
// ─────────────────────────────────────────
function freshUnit(side, label, rung) {
  return {
    side,               // 'Up' | 'Down'
    label,              // 'Up-1', 'Up-2', 'Down-1', 'Down-2'
    rung,               // 1 or 2 — only used for initial placement
    restingOrder: null, // { price, shares, tpPrice, orderId, placedAt }
    position: null,     // { entryPrice, shares, cost, tpPrice, orderId, openedAt }
    cyclesCompleted: 0,
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
    unitsInitialized: false,
    units: [
      freshUnit('Up', 'Up-1', 1),
      freshUnit('Up', 'Up-2', 2),
      freshUnit('Down', 'Down-1', 1),
      freshUnit('Down', 'Down-2', 2),
    ],
    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,
    resolvedThisWindow: true, // true until a window is actually loaded
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
//  Slug / window math (unchanged from prior versions)
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) {
  return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS;
}
function slugFor(symbol, windowStartSec) {
  return `${symbol.toLowerCase()}-updown-5m-${windowStartSec}`;
}
function qOf(m) {
  return (m.question || m.groupItemTitle || m.title || '').toLowerCase();
}
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
    } catch (_) { /* not indexed yet / doesn't exist — try next offset */ }
  }
  return null;
}

async function loadPairWindow(p) {
  const ws = currentWindowStart();
  if (p.windowStart === ws && p.upTokenId) return; // already loaded & current

  const found = await fetchEventForWindow(p.symbol, ws);
  if (!found) { p.tradable = false; return; }
  const { event, windowStart, slug } = found;
  const market = event.markets.find(m => {
    const q = qOf(m);
    return q.includes('up') || q.includes('down');
  }) || event.markets[0];

  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) {
    log(`⚠️  ${p.symbol}: window loaded but Up/Down token ids missing — outcomes=${market.outcomes}`);
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
  p.unitsInitialized = false;
  p.upAsk = p.upBid = p.downAsk = p.downBid = null; // force a fresh price read before anchoring the ladder
  p.units = [
    freshUnit('Up', 'Up-1', 1),
    freshUnit('Up', 'Up-2', 2),
    freshUnit('Down', 'Down-1', 1),
    freshUnit('Down', 'Down-2', 2),
  ];
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z`);
}

// ─────────────────────────────────────────
//  Polymarket CLOB price feed (unchanged pattern)
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
      if (p.upTokenId === tid) {
        if (side === 'BUY') p.upAsk = price; else if (side === 'SELL') p.upBid = price;
      } else if (p.downTokenId === tid) {
        if (side === 'BUY') p.downAsk = price; else if (side === 'SELL') p.downBid = price;
      }
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
      } catch (_) { /* leave stale values, try again next tick */ }
    }
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function unitMarkValue(p, unit) {
  if (!unit.position) return 0;
  const price = unit.side === 'Up' ? (p.upBid ?? unit.position.entryPrice) : (p.downBid ?? unit.position.entryPrice);
  return round2(unit.position.shares * price);
}
function pairMarkValue(p) {
  const heldValue = p.units.reduce((s, u) => s + unitMarkValue(p, u), 0);
  return round2(p.bankroll + heldValue);
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

// ─────────────────────────────────────────
//  Grid ladder — initial placement
// ─────────────────────────────────────────
async function placeUnitBuy(p, unit, price, shares) {
  const tokenId = unit.side === 'Up' ? p.upTokenId : p.downTokenId;
  const order = await placeLimitBuy(tokenId, price, shares);
  unit.restingOrder = {
    price,
    shares,
    tpPrice: round2(price + UNIT_TP_OFFSET),
    orderId: order.id || order.orderId || null,
    placedAt: Date.now(),
  };
}

async function initializeUnitsForWindow(p) {
  if (p.upAsk == null || p.downAsk == null) return; // wait for a real price to anchor off
  for (const unit of p.units) {
    const anchor = unit.side === 'Up' ? p.upAsk : p.downAsk;
    const price = round2(anchor - unit.rung * GRID_STEP);
    await placeUnitBuy(p, unit, Math.max(price, 0.01), UNIT_BASE_SHARES);
  }
  p.unitsInitialized = true;
  log(`📐 ${p.symbol} grid ladder placed: Up-1 @ ${p.units[0].restingOrder.price.toFixed(2)} | Up-2 @ ${p.units[1].restingOrder.price.toFixed(2)} | Down-1 @ ${p.units[2].restingOrder.price.toFixed(2)} | Down-2 @ ${p.units[3].restingOrder.price.toFixed(2)} (${UNIT_BASE_SHARES}sh each)`);
}

// ─────────────────────────────────────────
//  Grid ladder — per-tick unit processing
// ─────────────────────────────────────────
async function fillUnitBuy(p, unit) {
  const ro = unit.restingOrder;
  const notional = round2(ro.price * ro.shares);
  const rebate = makerRebate(ro.shares, ro.price);
  p.bankroll = round2(p.bankroll - notional + rebate);
  p.realizedPnl = round2(p.realizedPnl + rebate); // rebate is realized income regardless of trade outcome
  p.rebatesEarned = round2(p.rebatesEarned + rebate);

  unit.position = {
    entryPrice: ro.price,
    shares: ro.shares,
    cost: notional,
    tpPrice: ro.tpPrice,
    orderId: ro.orderId,
    openedAt: Date.now(),
  };
  unit.restingOrder = null;
  recordEquity(p);
  log(`🎯 ${p.symbol} ${unit.label} BUY filled ${ro.shares}sh @ ${ro.price.toFixed(2)} | cost=$${notional.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP@${ro.tpPrice.toFixed(2)}`);
  registerTrade(p, { unit: unit.label, side: 'BUY', outcome: unit.side, price: ro.price, shares: ro.shares, cost: notional, rebate });
}

async function fillUnitTP(p, unit) {
  const pos = unit.position;
  const proceeds = round2(pos.tpPrice * pos.shares);
  const rebate = makerRebate(pos.shares, pos.tpPrice);
  const net = round2(proceeds + rebate);
  p.bankroll = round2(p.bankroll + net);
  const profit = round2(net - pos.cost);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  if (profit >= 0) p.wins++; else p.losses++;
  unit.cyclesCompleted++;

  log(`💰 ${p.symbol} ${unit.label} TP filled ${pos.shares}sh @ ${pos.tpPrice.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { unit: unit.label, side: 'SELL', outcome: unit.side, reason: 'TP', price: pos.tpPrice, shares: pos.shares, profit, rebate });

  // Re-quote immediately: full proceeds (original capital + profit) fund
  // the next rung, 0.05 below this TP price.
  const newPrice = Math.max(round2(pos.tpPrice - GRID_STEP), 0.01);
  let newShares = round2(net / newPrice);
  if (newShares < MIN_SHARES) newShares = MIN_SHARES;
  unit.position = null;
  await placeUnitBuy(p, unit, newPrice, newShares);
  recordEquity(p);
  log(`📌 ${p.symbol} ${unit.label} re-quoted BUY ${newShares}sh @ ${newPrice.toFixed(2)} (compounded from $${net.toFixed(2)} proceeds) | TP@${unit.restingOrder.tpPrice.toFixed(2)}`);
}

async function requoteStaleUnit(p, unit, currentAsk) {
  const ro = unit.restingOrder;
  await cancelOrder(ro.orderId);
  const newPrice = Math.max(round2(currentAsk - GRID_STEP), 0.01);
  log(`♻️  ${p.symbol} ${unit.label} stale buy @ ${ro.price.toFixed(2)} (ask ran to ${currentAsk.toFixed(2)}) — cancelled, re-quoting @ ${newPrice.toFixed(2)}`);
  await placeUnitBuy(p, unit, newPrice, ro.shares);
}

async function processUnit(p, unit) {
  const ask = unit.side === 'Up' ? p.upAsk : p.downAsk;
  const bid = unit.side === 'Up' ? p.upBid : p.downBid;

  if (unit.restingOrder) {
    if (ask != null && ask <= unit.restingOrder.price) {
      await fillUnitBuy(p, unit);
      return;
    }
    if (ask != null && (ask - unit.restingOrder.price) >= PRICE_JUMP_THRESHOLD) {
      await requoteStaleUnit(p, unit, ask);
      return;
    }
    return;
  }

  if (unit.position) {
    if (bid != null && bid >= unit.position.tpPrice) {
      await fillUnitTP(p, unit);
    }
    return; // no SL — rides to resolution if TP never hits before window close
  }

  // Defensive fallback: a unit should always have either a resting order
  // or a position once initialized. If neither (shouldn't normally
  // happen), re-anchor it fresh off the current ask.
  if (ask != null) {
    const price = Math.max(round2(ask - GRID_STEP), 0.01);
    log(`⚠️  ${p.symbol} ${unit.label} was idle — re-anchoring @ ${price.toFixed(2)}`);
    await placeUnitBuy(p, unit, price, UNIT_BASE_SHARES);
  }
}

function registerTrade(p, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: p.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
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
  } catch (_) { /* fall through to heuristic */ }

  // Fallback heuristic if Gamma hasn't indexed the resolution yet: the
  // side whose token price is closer to 1 has settled as the winner.
  if (p.upBid != null && p.downBid != null) {
    return p.upBid >= p.downBid ? 'Up' : 'Down';
  }
  return null;
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  const hasOpenPosition = p.units.some(u => u.position);
  const hasRestingOrder = p.units.some(u => u.restingOrder);
  let winner = null;
  if (hasOpenPosition) winner = await determineWinningSide(p);

  for (const unit of p.units) {
    if (unit.restingOrder) {
      await cancelOrder(unit.restingOrder.orderId);
      log(`🛑 ${p.symbol} ${unit.label}: cancelled unfilled buy @ ${unit.restingOrder.price.toFixed(2)} — window closed`);
      unit.restingOrder = null;
    }
    if (unit.position) {
      const pos = unit.position;
      const won = winner === unit.side;
      const proceeds = won ? round2(pos.shares * 1) : 0; // settlement — no fee either way
      const profit = round2(proceeds - pos.cost);
      p.bankroll = round2(p.bankroll + proceeds);
      p.realizedPnl = round2(p.realizedPnl + profit);
      if (profit >= 0) p.wins++; else p.losses++;
      const icon = won ? '💰' : '💥';
      log(`${icon} ${p.symbol} ${unit.label} RESOLUTION ${unit.side} ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { unit: unit.label, side: 'SELL', outcome: unit.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
      unit.position = null;
    }
  }
  if (hasOpenPosition || hasRestingOrder) recordEquity(p);
}

// ─────────────────────────────────────────
//  Main per-pair tick
// ─────────────────────────────────────────
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) {
      await resolvePairWindow(p);
    }
    await loadPairWindow(p);
  }
  if (!p.tradable) return;

  if (!p.unitsInitialized) {
    await initializeUnitsForWindow(p);
    if (!p.unitsInitialized) return; // still waiting on a first price read
  }

  if (tradingEnabled) {
    for (const unit of p.units) {
      try { await processUnit(p, unit); }
      catch (e) { log(`⚠️  ${p.symbol} ${unit.label} error: ${e.message}`); }
    }
  }

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(p.units.reduce((s, u) => s + (u.position ? unitMarkValue(p, u) - u.position.cost : 0), 0));
    const markValue = pairMarkValue(p);
    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      units: p.units.map(u => ({
        label: u.label,
        side: u.side,
        cyclesCompleted: u.cyclesCompleted,
        restingOrder: u.restingOrder ? { price: u.restingOrder.price, shares: u.restingOrder.shares, tpPrice: u.restingOrder.tpPrice } : null,
        position: u.position ? { entryPrice: u.position.entryPrice, shares: u.position.shares, cost: u.position.cost, tpPrice: u.position.tpPrice } : null,
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
      unitBaseShares: UNIT_BASE_SHARES,
      gridStep: GRID_STEP,
      unitTpOffset: UNIT_TP_OFFSET,
      priceJumpThreshold: PRICE_JUMP_THRESHOLD,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates,
    totalEquityCurve,
    logs: logs.slice(-100),
    trades: trades.slice(-80).reverse(),
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
//  Public controls (dashboard)
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
  log('⏸️  Trading paused (resting orders and open positions still managed for TP/resolution)');
  return { ok: true };
}
function resumeTrading() {
  tradingEnabled = true;
  log('▶️  Trading resumed');
  return { ok: true };
}
function getStatus() {
  return { ok: true, ...buildState() };
}

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 5-Minute Crypto Up/Down — Parallel Grid Ladder Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  grid: ${UNIT_BASE_SHARES}sh/unit, ${GRID_STEP} step, TP+${UNIT_TP_OFFSET}, re-quote past ${PRICE_JUMP_THRESHOLD} jump, no SL (rides to resolution)`);
  log(`⚙️  fees: all orders maker (0 fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate) — no taker orders in this strategy`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
