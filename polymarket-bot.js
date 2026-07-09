'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — DUAL-SIDE BREAKOUT-RETEST LADDER
 * ═══════════════════════════════════════════════════════════════
 *
 *  Every order in this strategy is a genuine LIMIT order — nothing crosses
 *  the spread to chase a price. That constraint shapes the whole design:
 *
 *  PER WINDOW, per side (Up and Down each get their own full ladder,
 *  fully independent):
 *    - 9 fixed grid prices, spaced 0.10 apart, from 0.10 up to 0.90.
 *    - BREAK: as price rises and trades through a grid for the first time
 *      this window (including via a gap — if price jumps from 0.38 to 0.53
 *      in one tick, both 0.40 and 0.50 count as broken), the bot places a
 *      genuine resting limit BUY at that grid's own price. A window that
 *      simply opens above some grids does NOT break them — only a real
 *      crossing during this window counts.
 *    - RETEST: a resting limit buy below the current price does not fill
 *      immediately — it just sits on the book. It only actually matches
 *      once the ask comes back down to (or through) that price, i.e. once
 *      price retests the level it just broke. This is deliberate: buying
 *      a confirmed retest is more robust than chasing the initial spike,
 *      which can be a fakeout. If price never retests a broken grid before
 *      the window ends, that resting buy is simply cancelled — no cost.
 *    - SIZING: dollars committed scale UP with grid price — a retest fill
 *      at 0.80 commits ~4x the capital of one at 0.20, since a higher grid
 *      represents more confirmed conviction.
 *    - TP: entry + 0.05, placed as a genuine resting limit sell above the
 *      market — also a passive order, waiting to be hit on continuation.
 *    - SL: entry - 0.06. This is the one order in the design that's priced
 *      to be immediately marketable (at the current bid) rather than
 *      passive — a stop needs to fire the moment it's triggered, not wait
 *      around for a bounce back up to its price. It's still a limit order
 *      technically, just an aggressive one.
 *    - Each level is one-shot per window: once broken, retested, filled,
 *      and closed (TP or SL), it does not re-arm. Next window every level
 *      resets fresh (unbroken) on both sides.
 *
 *  WINDOW CLOSE: any broken-but-never-retested resting buy is cancelled —
 *  it never touched cash, so no P&L impact. Any filled level still waiting
 *  on TP/SL rides to actual resolution as a last resort; its resting TP
 *  order is cancelled first (settlement is automatic on-chain redemption).
 *
 *  FEES: grid buys (on retest) and TP sells are genuine resting maker
 *  orders and earn the 20% maker rebate. The SL exit is the one
 *  deliberately marketable/taker order in this design.
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

// A genuine resting (passive/maker) limit buy — placed at the grid's own
// price once that grid has been broken through, then left on the book to
// wait for a retest. It only actually matches later, when the market ask
// comes back down to this price (see confirmFillsIfRetested).
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
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}

// ─────────────────────────────────────────
//  Pair / level state
// ─────────────────────────────────────────
function freshLevels() {
  const levels = [];
  for (const side of ['Up', 'Down']) {
    for (const price of LEVEL_PRICES) {
      levels.push({ side, price, broken: false, buyOrderId: null, filled: false, position: null, tpOrderId: null });
      // broken: price has traded through this grid at least once this window, and a genuine
      //   resting limit buy has been placed AT the grid's own price, waiting for a retest.
      // filled: that resting buy has actually been matched (ask retraced back down to/through it).
      // position, when set, also carries slPrice (entry - SL_OFFSET). The SL exit is a limit
      //   order too, but priced to be immediately marketable (see processLevel) rather than a
      //   passive rest-and-wait order, since a stop needs to fire promptly once triggered.
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
    lastUpAsk: null, lastDownAsk: null, // baseline for detecting genuine upward crossings (incl. gaps) — see maybeBreakLevels
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

// Places the resting buy the moment a grid is broken through. Sizing is
// keyed off the grid's own price (not a market price, since we don't have
// one yet for this order — it hasn't filled).
async function breakLevel(p, level) {
  const tokenId = level.side === 'Up' ? p.upTokenId : p.downTokenId;
  const dollars = dollarsForLevel(level.price);
  const shares = Math.max(round2(dollars / level.price), MIN_SHARES);
  level.broken = true;
  level.shares = shares;
  const order = await placeLimitBuy(tokenId, level.price, shares);
  level.buyOrderId = order.id || order.orderId || null;
  log(`📌 ${p.symbol} ${level.side}@${level.price.toFixed(2)} grid broken — resting buy placed, waiting for retest (${shares.toFixed(2)}sh)`);
}

// Detects which levels have genuinely been broken through since the last
// tick — including gaps, where a single tick jumps over several grids at
// once. Every broken grid gets its own resting limit buy placed at its own
// price; whether that buy is EVER hit is a separate question, checked each
// tick in confirmFillIfRetested. A window that simply opens above some
// grids does NOT break them — only a real crossing during this window does.
async function maybeBreakLevels(p, side) {
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) return;
  const lastKey = side === 'Up' ? 'lastUpAsk' : 'lastDownAsk';
  const prevAsk = p[lastKey];
  p[lastKey] = ask; // always advance the baseline for next tick

  if (prevAsk == null) return; // first observation this window — nothing to compare against yet
  if (ask <= prevAsk) return;  // this ladder only cares about upward crossings

  const candidates = p.levels
    .filter(l => l.side === side && !l.broken && l.price > prevAsk && l.price <= ask)
    .sort((a, b) => a.price - b.price);
  for (const level of candidates) {
    await breakLevel(p, level);
  }
}

// Confirms a resting buy actually got matched: the ask has to have come back
// down to (or through) the grid's own price. This is the "retest" — buying
// strength, but only once it's been confirmed by a pullback to the level
// that was broken, not by chasing the spike itself.
async function confirmFillIfRetested(p, level) {
  if (!level.broken || level.filled) return;
  const ask = level.side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null || ask > level.price) return; // hasn't come back down to retest yet

  const shares = level.shares;
  const cost = round2(level.price * shares);
  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol} ${level.side}@${level.price.toFixed(2)}: skip fill — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)})`);
    level.filled = true; // don't keep retrying an unaffordable level all window
    return;
  }
  const rebate = makerRebate(shares, level.price); // genuine passive match — this is maker side
  p.bankroll = round2(p.bankroll - cost + rebate);
  p.realizedPnl = round2(p.realizedPnl + rebate);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  level.filled = true;
  const tokenId = level.side === 'Up' ? p.upTokenId : p.downTokenId;
  const tpPrice = round2(Math.min(level.price + TP_OFFSET, 0.99));
  const slPrice = round2(Math.max(level.price - SL_OFFSET, 0.01));
  level.position = { entryPrice: level.price, shares, cost, tpPrice, slPrice, openedAt: Date.now() };
  const tpOrder = await placeLimitSell(tokenId, tpPrice, shares); // resting above market — genuine maker order
  level.tpOrderId = tpOrder.id || tpOrder.orderId || null;
  recordEquity(p);
  log(`🎯 ${p.symbol} ${level.side}@${level.price.toFixed(2)} retest confirmed — BUY filled ${shares.toFixed(2)}sh | cost=$${cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP @ ${tpPrice.toFixed(2)} | SL @ ${slPrice.toFixed(2)}`);
  registerTrade(p, { side: 'BUY', outcome: level.side, level: level.price, price: level.price, shares, cost, rebate });
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
  p.lastUpAsk = null;
  p.lastDownAsk = null; // fresh baseline — nothing has been "crossed" yet this window
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
  if (!level.filled) {
    await confirmFillIfRetested(p, level);
    return;
  }
  if (!level.position) return;
  const bid = level.side === 'Up' ? p.upBid : p.downBid;
  const pos = level.position;

  // Stop-loss: priced to be immediately marketable (at the current bid) so it
  // actually executes now rather than waiting to be hit — unlike the entry
  // and TP orders, which are genuinely passive and wait for a retest/rally.
  if (bid != null && bid <= pos.slPrice) {
    await cancelOrder(level.tpOrderId); // pull the resting TP, we're exiting via SL instead
    const exitPrice = bid;
    const fee = takerFee(pos.shares, exitPrice);
    const net = round2(exitPrice * pos.shares - fee);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.feesPaid = round2(p.feesPaid + fee);
    p.losses++;
    log(`🧯 ${p.symbol} ${level.side}@${level.price.toFixed(2)} SL hit ${pos.shares.toFixed(2)}sh @ ${exitPrice.toFixed(2)} | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: level.side, level: level.price, reason: 'SL', price: exitPrice, shares: pos.shares, profit, fee });
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
    if (level.broken && !level.filled && level.buyOrderId) {
      await cancelOrder(level.buyOrderId); // never touched cash — no P&L impact, just an unfilled resting order
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

  await maybeBreakLevels(p, 'Up');
  await maybeBreakLevels(p, 'Down');

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
        side: l.side, price: l.price, broken: l.broken, filled: l.filled,
        position: l.position ? { entryPrice: l.position.entryPrice, shares: l.position.shares, cost: l.position.cost, tpPrice: l.position.tpPrice, slPrice: l.position.slPrice } : null,
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
    config: { levelPrices: LEVEL_PRICES, gridDollarsBase: GRID_DOLLARS_BASE, tpOffset: TP_OFFSET, slOffset: SL_OFFSET, cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE, cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE },
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
  log(`🚀 Dual-Side Breakout-Retest Ladder Bot (limit orders only — no crossing the spread except SL)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  ladder: ${LEVEL_PRICES.join('/')} ($ scales up to $${GRID_DOLLARS_BASE} with price, both sides, one-shot per window) | resting buy placed at grid price on break, fills only on retest | TP entry+${TP_OFFSET} (resting) | SL entry-${SL_OFFSET} (marketable)`);
  log(`⚙️  fees: grid buys + TP sells are maker (+${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate); SL exits are the one deliberate taker order`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
