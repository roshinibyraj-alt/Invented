'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — INDEPENDENT DIP-LADDER BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  Complete rewrite — no external BTC price signal anymore. This strategy
 *  makes no directional call at all. It just tries to buy dips on BOTH
 *  Up and Down independently, using only Polymarket's own ask prices.
 *
 *  QUOTING — every 10 seconds, both sides, fully independent:
 *    Starting at t=10s and every QUOTE_INTERVAL_SECS (10s) after that, up
 *    until QUOTE_STOP_SECS (200s), the bot places ONE NEW resting limit buy
 *    on Up AND one on Down, each priced QUOTE_OFFSET (0.01) BELOW that
 *    side's current ask at that exact moment. Previous unfilled orders are
 *    NOT cancelled or replaced — they're simply left resting, so over the
 *    200 seconds a genuine ladder builds up on each side, trailing wherever
 *    price has been. If price never dips down to a given rung, that order
 *    just sits until the window ends and expires with the market on its own
 *    (Polymarket's own expiry — no cost, nothing the bot needs to manage).
 *
 *  FILLS — genuinely passive, confirmed only by price walking to the level:
 *    Every tick, every still-open resting order (on either side) is checked
 *    against that side's current ask. It's only counted as filled once ask
 *    <= that order's quoted price — i.e. price actually had to walk down to
 *    meet it. This is a REAL passive limit order, unlike earlier versions
 *    that quoted above the ask for a guaranteed-but-marketable fill. Since
 *    Up and Down are independent here (no shared bookkeeping dependency
 *    like the rebalance version had), there's no risk in letting fills stay
 *    uncertain — a missed or late fill on one side doesn't corrupt any
 *    calculation on the other.
 *
 *  SIZING — time-and-price tiered, flips after the halfway point:
 *    Before t=100s:
 *      - quoted-from price < 0.50 → 20 shares
 *      - quoted-from price >= 0.50 → 10 shares
 *    At/after t=100s, the rule INVERTS:
 *      - quoted-from price >= 0.50 → 20 shares
 *      - quoted-from price < 0.50 → 10 shares
 *    ("quoted-from price" = the ask at the moment that specific quote was
 *    placed, not the fill price — sizing is decided once, at quote time.)
 *
 *  EXIT: none. No TP, no SL. Whatever fills accumulate on each side just
 *    ride to actual window resolution — a separate, independent auto-claim
 *    script handles real redemption. This bot's own bookkeeping still
 *    simulates resolution (via the public Gamma API) purely to keep the
 *    dashboard's P&L/win-rate figures meaningful.
 *
 *  FEES: every fill here is a genuine passive/maker fill (ask walked down
 *    to meet a resting order that never crossed the spread), so every fill
 *    earns the maker rebate — the opposite of the "quote above ask" designs
 *    used earlier, which paid taker fees for reliability. This design
 *    trades fill certainty for fee-earning, since Up/Down independence
 *    means there's no bookkeeping reason to need certainty.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable (see setMode) — dashboard has
 *    a one-click toggle plus an independent pause button.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // force-resolve this many seconds BEFORE the nominal window end (298s)
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // runtime-switchable — see setMode
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const QUOTE_INTERVAL_SECS = Number(process.env.QUOTE_INTERVAL_SECS || 10); // requote cadence, both sides
const QUOTE_STOP_SECS     = Number(process.env.QUOTE_STOP_SECS || 200);   // stop placing NEW quotes after this
const QUOTE_OFFSET        = Number(process.env.QUOTE_OFFSET || 0.01);     // below current ask
const SHARES_TIER_HIGH    = Number(process.env.SHARES_TIER_HIGH || 20);
const SHARES_TIER_LOW     = Number(process.env.SHARES_TIER_LOW || 10);
const SIZE_FLIP_SECS      = Number(process.env.SIZE_FLIP_SECS || 100); // when the price/size tiering inverts
const MIN_SHARES          = Number(process.env.MIN_SHARES || 1);

const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

// Generate the quote checkpoints: 10, 20, 30, ... up to QUOTE_STOP_SECS.
const QUOTE_CHECKPOINTS_SECS = [];
for (let t = QUOTE_INTERVAL_SECS; t <= QUOTE_STOP_SECS; t += QUOTE_INTERVAL_SECS) QUOTE_CHECKPOINTS_SECS.push(t);

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

// A genuine resting (passive/maker) limit buy — priced BELOW the current
// ask, so it does not cross the spread. It may or may not ever fill.
async function placeRestingBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// Time-and-price tiered sizing — the rule INVERTS after SIZE_FLIP_SECS.
// "price" here is the ask at the moment the quote is placed, not the fill.
function sharesForQuote(price, elapsedSecs) {
  const cheap = price < 0.50;
  if (elapsedSecs < SIZE_FLIP_SECS) {
    return cheap ? SHARES_TIER_HIGH : SHARES_TIER_LOW;
  }
  return cheap ? SHARES_TIER_LOW : SHARES_TIER_HIGH;
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshPairState(symbol) {
  return {
    symbol,
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    quotesDone: 0,                              // how many QUOTE_CHECKPOINTS_SECS have fired this window
    pendingOrders: { Up: [], Down: [] },        // resting, not-yet-filled orders per side
    netShares: { Up: 0, Down: 0 },               // cumulative FILLED shares this window, per side
    netCost: { Up: 0, Down: 0 },                 // cumulative $ spent (net of rebate) on filled shares, per side
    windowClosed: false,
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
  p.quotesDone = 0;
  p.pendingOrders = { Up: [], Down: [] };
  p.netShares = { Up: 0, Down: 0 };
  p.netCost = { Up: 0, Down: 0 };
  p.windowClosed = false;
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z`);
}

// ─────────────────────────────────────────
//  Polymarket price feed (unchanged plumbing)
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
function pairMarkValue(p) {
  if (p.windowClosed || (p.netShares.Up === 0 && p.netShares.Down === 0)) return round2(p.bankroll);
  const upVal = round2(p.netShares.Up * (p.upBid ?? (p.netCost.Up && p.netShares.Up ? p.netCost.Up / p.netShares.Up : 0)));
  const downVal = round2(p.netShares.Down * (p.downBid ?? (p.netCost.Down && p.netShares.Down ? p.netCost.Down / p.netShares.Down : 0)));
  return round2(p.bankroll + upVal + downVal);
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
//  Quoting: independent per-side dip ladder
// ─────────────────────────────────────────

// Places one new resting buy on the given side, priced QUOTE_OFFSET below
// that side's current ask. Does NOT touch any previously placed order on
// this side — the ladder simply accumulates.
async function placeDipQuote(p, side, elapsedSecs) {
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) { log(`⏭️  ${p.symbol} ${side}: no ask available, skipping this quote`); return; }
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  const quotePrice = round2(Math.max(0.01, ask - QUOTE_OFFSET));
  const shares = Math.max(sharesForQuote(ask, elapsedSecs), MIN_SHARES);

  const order = await placeRestingBuy(tokenId, quotePrice, shares);
  p.pendingOrders[side].push({ price: quotePrice, shares, orderId: order.id || order.orderId || null, placedAt: Date.now() });
  log(`📌 ${p.symbol} ${side} resting buy ${shares}sh @ ${quotePrice.toFixed(2)} (ask=${ask.toFixed(2)}) — waiting for price to walk down to it`);
}

async function maybeQuoteBothSides(p) {
  const elapsed = nowSec() - p.windowStart;
  while (p.quotesDone < QUOTE_CHECKPOINTS_SECS.length && elapsed >= QUOTE_CHECKPOINTS_SECS[p.quotesDone]) {
    await placeDipQuote(p, 'Up', elapsed);
    await placeDipQuote(p, 'Down', elapsed);
    p.quotesDone++;
  }
}

// Checks every still-resting order on one side against the current ask —
// only counts as filled once ask <= the order's quoted price (a genuine
// passive fill, not inferred/guessed at any other time).
async function checkFills(p, side) {
  if (!p.pendingOrders[side].length) return;
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) return;

  const stillPending = [];
  for (const order of p.pendingOrders[side]) {
    if (ask > order.price) { stillPending.push(order); continue; }

    // Filled: price walked down to (or through) this resting order's price.
    const rebate = makerRebate(order.shares, order.price);
    const cost = round2(order.price * order.shares - rebate);
    if (cost > p.bankroll) {
      log(`⏭️  ${p.symbol} ${side} @ ${order.price.toFixed(2)}: would have filled but bankroll is insufficient ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)}) — dropping this order`);
      continue;
    }
    p.bankroll = round2(p.bankroll - cost);
    p.realizedPnl = round2(p.realizedPnl + rebate);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    p.netShares[side] = round2(p.netShares[side] + order.shares);
    p.netCost[side] = round2(p.netCost[side] + cost);
    recordEquity(p);
    log(`💰 ${p.symbol} ${side} FILLED ${order.shares}sh @ ${order.price.toFixed(2)} | cost=$${cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | net now Up=${p.netShares.Up.toFixed(2)}sh/Down=${p.netShares.Down.toFixed(2)}sh`);
    registerTrade(p, { side: 'BUY', outcome: side, reason: 'dip fill', price: order.price, shares: order.shares, cost, rebate });
  }
  p.pendingOrders[side] = stillPending;
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

  const hasPosition = p.netShares.Up > 0 || p.netShares.Down > 0;
  let winner = null;
  if (hasPosition) winner = await determineWinningSide(p);

  if (hasPosition) {
    const winShares = winner === 'Up' ? p.netShares.Up : (winner === 'Down' ? p.netShares.Down : 0);
    const proceeds = round2(winShares * 1);
    const totalCost = round2(p.netCost.Up + p.netCost.Down);
    const profit = round2(proceeds - totalCost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (profit > 0) p.wins++; else p.losses++;
    const icon = profit > 0 ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION winner=${winner ?? '?'} | held Up=${p.netShares.Up.toFixed(2)}sh/Down=${p.netShares.Down.toFixed(2)}sh | proceeds=$${proceeds.toFixed(2)} | totalCost=$${totalCost.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)} (dashboard bookkeeping only — real redemption is via the separate claim script)`);
    registerTrade(p, { side: 'SELL', outcome: winner, reason: 'RESOLUTION', upShares: p.netShares.Up, downShares: p.netShares.Down, proceeds, profit });
  }
  // Any still-resting orders never touched cash — Polymarket expires them with the market.
  p.pendingOrders = { Up: [], Down: [] };
  p.windowClosed = true;
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

  const elapsed = nowSec() - p.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
  if (p.resolvedThisWindow) return;

  // New quotes only inside the active quoting phase (0-200s)...
  if (elapsed <= QUOTE_STOP_SECS) {
    await maybeQuoteBothSides(p);
  }
  // ...but fill-checking runs the WHOLE window, since resting orders placed
  // earlier can still be walked down to and filled during the quiet phase.
  await checkFills(p, 'Up');
  await checkFills(p, 'Down');
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const markValue = pairMarkValue(p);
    const totalCost = round2(p.netCost.Up + p.netCost.Down);
    const heldValue = round2(markValue - p.bankroll);
    const unrealized = round2(heldValue - totalCost);
    return {
      symbol: p.symbol, tradable: p.tradable, slug: p.slug, windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      quotesDone: p.quotesDone, quotesTotal: QUOTE_CHECKPOINTS_SECS.length,
      pendingUp: p.pendingOrders.Up.length, pendingDown: p.pendingOrders.Down.length,
      bankroll: p.bankroll, realizedPnl: p.realizedPnl, unrealizedPnl: unrealized, markValue,
      feesPaid: p.feesPaid, rebatesEarned: p.rebatesEarned, wins: p.wins, losses: p.losses,
      netShares: p.netShares, netCost: p.netCost,
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
    config: {
      quoteIntervalSecs: QUOTE_INTERVAL_SECS, quoteStopSecs: QUOTE_STOP_SECS, quoteOffset: QUOTE_OFFSET,
      sharesTierHigh: SHARES_TIER_HIGH, sharesTierLow: SHARES_TIER_LOW, sizeFlipSecs: SIZE_FLIP_SECS,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE, cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
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
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (existing positions still tracked for resolution bookkeeping)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

// Runtime live/demo switch — DRY_RUN is no longer fixed at startup. Existing
// open positions/resting orders are left alone; only NEW orders placed after
// the switch use the new mode.
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
  log(`🚀 Independent Dip-Ladder Bot (no directional signal — Up and Down quoted independently)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  quoting: every ${QUOTE_INTERVAL_SECS}s from t=${QUOTE_INTERVAL_SECS}s to t=${QUOTE_STOP_SECS}s (${QUOTE_CHECKPOINTS_SECS.length} checkpoints) | resting buy at ask-${QUOTE_OFFSET} on BOTH sides each time, never cancelled/replaced`);
  log(`⚙️  sizing: before ${SIZE_FLIP_SECS}s → ${SHARES_TIER_HIGH}sh if price<0.50 else ${SHARES_TIER_LOW}sh | at/after ${SIZE_FLIP_SECS}s → inverted (${SHARES_TIER_HIGH}sh if price>=0.50 else ${SHARES_TIER_LOW}sh)`);
  log(`⚙️  fills: genuinely passive — only confirmed once ask walks down to the resting order's price | no TP/SL, rides to resolution, external claim script handles redemption`);
  log(`⚙️  fees: every fill is a maker fill (+${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate) — no marketable orders in this design`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
