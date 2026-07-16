'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 15-MINUTE BTC UP/DOWN — INDEPENDENT LADDER STRATEGY
 * ═══════════════════════════════════════════════════════════════
 *
 *  Complete rewrite — replaces the old two-strategy (S1/S2) design.
 *  Up and Down each run their OWN independent ladder — they never
 *  interact, both just pull from the same bankroll.
 *
 *  TRADEABLE BAND: a side's ladder only ever quotes prices inside
 *    [LADDER_MIN, LADDER_MAX] = [0.15, 0.85]. Anything computed outside
 *    that band is clamped to the nearest edge.
 *
 *  ENTRY: whenever a side's ladder has no resting order and no open
 *    position, it posts a resting limit buy for LADDER_SHARES shares:
 *      - First entry of the window: price = current ask - 0.10.
 *      - Every entry after a completed cycle (re-entry): price = that
 *        cycle's exit price - 0.10 — NOT the live price. This is what
 *        makes it a ladder: each rung is anchored to the last rung's
 *        realized exit, not to whatever the market is doing right now.
 *
 *  TRAILING TP: once a position's peak price reaches entry + 0.20, a
 *    trailing stop arms and trails 0.10 behind the peak from then on.
 *    Exiting there is a marketable sell (guaranteed execution). If the
 *    +0.20 arm level is never reached before the window ends, the
 *    position simply rides to actual resolution ($1 or $0).
 *
 *  RE-ENTRY: the moment a cycle closes via the trailing stop, the next
 *    rung's entry price is set to (exit price - 0.10) and a new resting
 *    buy is posted immediately (subject to the tradeable band clamp).
 *    A single window can cycle through many rungs if price is choppy.
 *
 *  FILL SEMANTICS: a limit buy at price P fills the moment the current
 *    ask is AT OR BELOW P, at that REAL current ask — never worse than P.
 *
 *  RESOLUTION: any position still open when the window ends (trailing
 *    stop never triggered) rides to actual window resolution — this
 *    bot's own bookkeeping simulates that via the public Gamma API
 *    purely to keep the dashboard's P&L figures meaningful. A separate,
 *    independent auto-claim script handles real redemption.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable (see setMode) — dashboard
 *    has a one-click toggle plus an independent pause button.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 900;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2);
const SLUG_OFFSET_FALLBACKS = [0, -900, 900];
const SYMBOL = 'BTC'; // this bot only ever trades BTC, per spec

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // runtime-switchable — see setMode
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Ladder strategy parameters ──
const LADDER_MIN            = Number(process.env.LADDER_MIN || 0.15);   // tradeable band floor
const LADDER_MAX            = Number(process.env.LADDER_MAX || 0.85);   // tradeable band ceiling
const LADDER_ENTRY_OFFSET   = Number(process.env.LADDER_ENTRY_OFFSET || 0.10);   // entry = reference price - this
const LADDER_TP_ARM         = Number(process.env.LADDER_TP_ARM || 0.20);         // profit needed above entry to arm the trailing stop
const LADDER_TP_TRAIL       = Number(process.env.LADDER_TP_TRAIL || 0.10);       // once armed, stop trails this far behind the peak
const LADDER_REENTRY_OFFSET = Number(process.env.LADDER_REENTRY_OFFSET || 0.10); // next rung's entry = this cycle's exit price - this
const LADDER_SHARES         = Number(process.env.LADDER_SHARES || 50);           // fixed shares per rung, every entry
const LADDER_ENTRY_DELAY_SECS = Number(process.env.LADDER_ENTRY_DELAY_SECS || 5); // wait this long after a window goes live before the first entry — lets the price feed settle on the new window's tokens

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

const MIN_SHARES = Number(process.env.MIN_SHARES || 1);
const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let bankroll = TOTAL_CAPITAL;
let realizedPnl = 0, feesPaid = 0, rebatesEarned = 0, wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];

let state = freshMarketState();

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-two-strategy-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-two-strategy-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// Genuine resting (passive) limit buy — fills only when ask walks down to
// meet it (or below). Used for every ladder rung's entry.
async function placeRestingBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
// A deliberately marketable sell — priced at the current bid so it fills
// now. Used for the ladder's trailing-stop exit, since a stop needs to
// actually execute rather than wait passively.
async function placeMarketableSell(tokenId, price, shares) {
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
//  Market state (single BTC market only)
// ─────────────────────────────────────────
function freshMarketState() {
  return {
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    resolvedThisWindow: true,
    ladder: {
      Up: {
        order: null,          // resting entry order, pre-fill: {price, shares, orderId}
        position: null,       // open position: {shares, entryPrice, cost, peak, armed, closed}
        nextEntryPrice: null, // null = derive first entry from live price; otherwise = last cycle's exit - 0.10
        cycles: 0, cyclePnl: 0,
      },
      Down: {
        order: null,
        position: null,
        nextEntryPrice: null,
        cycles: 0, cyclePnl: 0,
      },
    },
  };
}

// ─────────────────────────────────────────
//  Slug / window math (unchanged market-discovery plumbing)
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) { return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS; }
function slugFor(windowStartSec) { return `${SYMBOL.toLowerCase()}-updown-15m-${windowStartSec}`; }
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
async function fetchEventForWindow(windowStart) {
  for (const offset of SLUG_OFFSET_FALLBACKS) {
    const ws = windowStart + offset;
    if (ws + WINDOW_SECS <= nowSec()) continue;
    const slug = slugFor(ws);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) return { event, windowStart: ws, slug };
    } catch (_) {}
  }
  return null;
}

async function loadWindow() {
  const ws = currentWindowStart();
  if (state.windowStart === ws && state.upTokenId) return;
  const found = await fetchEventForWindow(ws);
  if (!found) { state.tradable = false; return; }
  const { event, windowStart, slug } = found;
  const market = event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];
  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) { log(`⚠️  window loaded but Up/Down token ids missing`); state.tradable = false; return; }

  const fresh = freshMarketState();
  fresh.windowStart = windowStart;
  fresh.windowEnd = windowStart + WINDOW_SECS;
  fresh.slug = slug;
  fresh.eventTitle = event.title || event.slug;
  fresh.conditionId = market.conditionId || null;
  fresh.upTokenId = upId;
  fresh.downTokenId = downId;
  fresh.tradable = true;
  fresh.resolvedThisWindow = false;
  // Do NOT carry over upAsk/upBid/downAsk/downBid from the previous window —
  // those prices belong to the OLD token IDs (often near 0/1 as that market
  // just resolved) and must never be reused for the new tokens. Leaving
  // these null forces s1PlaceEntries/s2CheckTrigger to wait for a genuine
  // fresh quote on the new tokenIds before anything can trade.
  state = fresh;
  log(`🔭 BTC window loaded: ${slug} | ends ${new Date(state.windowEnd * 1000).toISOString().slice(11,19)}Z`);
  await refreshPolyPrices(); // fetch real quotes for the new tokens immediately, don't wait for the 1s poll cycle
}

// ─────────────────────────────────────────
//  Polymarket price feed (unchanged plumbing, single-market version)
// ─────────────────────────────────────────
async function refreshPolyPrices() {
  if (!state.tradable || !state.upTokenId || !state.downTokenId) return;
  const requests = [
    { token_id: state.upTokenId, side: 'BUY' }, { token_id: state.upTokenId, side: 'SELL' },
    { token_id: state.downTokenId, side: 'BUY' }, { token_id: state.downTokenId, side: 'SELL' },
  ];
  function apply(tid, side, price) {
    if (!Number.isFinite(price)) return;
    if (tid === state.upTokenId) { if (side === 'BUY') state.upAsk = price; else state.upBid = price; }
    else if (tid === state.downTokenId) { if (side === 'BUY') state.downAsk = price; else state.downBid = price; }
  }
  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const side = (row.side || '').toUpperCase();
        const price = parseFloat(row.price);
        if (tid && Number.isFinite(price)) apply(tid, side, price);
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (val && typeof val === 'object') {
          if (val.BUY != null) apply(tid, 'BUY', parseFloat(val.BUY));
          if (val.SELL != null) apply(tid, 'SELL', parseFloat(val.SELL));
          if (val.buy != null) apply(tid, 'BUY', parseFloat(val.buy));
          if (val.sell != null) apply(tid, 'SELL', parseFloat(val.sell));
        }
      }
    }
  } catch (e) {
    try {
      const [upAsk, upBid, downAsk, downBid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${state.upTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${state.upTokenId}&side=SELL`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${state.downTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${state.downTokenId}&side=SELL`).catch(() => null),
      ]);
      if (upAsk) state.upAsk = parseFloat(upAsk.price || upAsk.mid || state.upAsk);
      if (upBid) state.upBid = parseFloat(upBid.price || upBid.mid || state.upBid);
      if (downAsk) state.downAsk = parseFloat(downAsk.price || downAsk.mid || state.downAsk);
      if (downBid) state.downBid = parseFloat(downBid.price || downBid.mid || state.downBid);
    } catch (_) {}
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function markValue() {
  let held = 0;
  for (const side of ['Up', 'Down']) {
    const pos = state.ladder[side].position;
    if (pos && !pos.closed) held += pos.shares * ((side === 'Up' ? state.upBid : state.downBid) ?? pos.entryPrice);
  }
  return round2(bankroll + held);
}
function recordEquity() {
  equityCurve.push({ t: Date.now(), equity: markValue() });
  if (equityCurve.length > 500) equityCurve.shift();
}
function registerTrade(entry) {
  trades.push({ time: new Date().toISOString().slice(11, 19), symbol: SYMBOL, ...entry });
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Ladder strategy — Up and Down each run their own independent ladder
// ─────────────────────────────────────────

// Post a new rung's resting entry buy, if this side currently has neither
// an order nor an open position.
async function ladderPlaceEntry(side, elapsed) {
  const L = state.ladder[side];
  if (L.order || L.position) return; // already have a rung working
  if (elapsed < LADDER_ENTRY_DELAY_SECS) return; // let the price feed settle on this window's tokens first

  let raw;
  if (L.nextEntryPrice != null) {
    raw = L.nextEntryPrice; // re-entry: anchored to the last cycle's exit, NOT the live price
  } else {
    const ask = side === 'Up' ? state.upAsk : state.downAsk;
    if (ask == null) return; // wait for valid price data before the window's first entry
    raw = ask - LADDER_ENTRY_OFFSET;
  }
  const price = round2(clamp(raw, LADDER_MIN, LADDER_MAX));
  const tokenId = side === 'Up' ? state.upTokenId : state.downTokenId;
  const order = await placeRestingBuy(tokenId, price, LADDER_SHARES);
  L.order = { price, shares: LADDER_SHARES, orderId: order.id || order.orderId || null };
  log(`📌 Ladder ${side} rung placed: resting buy ${LADDER_SHARES}sh @ ${price.toFixed(2)}${L.nextEntryPrice != null ? ' (re-entry)' : ' (first entry)'}`);
}

// Fill the resting entry order once this side's own ask walks down to (or
// is already at/below) its ceiling — never at a price worse than that ceiling.
async function ladderCheckFill(side) {
  const L = state.ladder[side];
  if (!L.order || L.position) return;
  const ask = side === 'Up' ? state.upAsk : state.downAsk;
  if (ask == null || ask > L.order.price) return;

  const fillPrice = ask;
  const rebate = makerRebate(L.order.shares, fillPrice);
  const cost = round2(fillPrice * L.order.shares - rebate);
  if (cost > bankroll) { log(`⏭️  Ladder ${side}: would fill but bankroll insufficient, dropping rung`); L.order = null; return; }

  bankroll = round2(bankroll - cost);
  realizedPnl = round2(realizedPnl + rebate);
  rebatesEarned = round2(rebatesEarned + rebate);
  L.position = { shares: L.order.shares, entryPrice: fillPrice, cost, peak: fillPrice, armed: false, closed: false };
  L.order = null;
  recordEquity();
  log(`💰 Ladder ${side} FILLED ${L.position.shares}sh @ ${fillPrice.toFixed(2)} | cost=$${cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | arms trailing stop at ${round2(fillPrice + LADDER_TP_ARM).toFixed(2)}, then trails ${LADDER_TP_TRAIL} behind peak`);
  registerTrade({ strategy: 'Ladder', side: 'BUY', outcome: side, price: fillPrice, shares: L.position.shares, cost, rebate });
}

// Track the peak, arm the trailing stop once +0.20 profit is reached, then
// trail 0.10 behind the peak and exit (marketable) if price falls to that
// level. On exit, immediately queue the next rung's re-entry price.
async function ladderManagePosition(side) {
  const L = state.ladder[side];
  const pos = L.position;
  if (!pos || pos.closed) return;
  const bid = side === 'Up' ? state.upBid : state.downBid;
  if (bid == null) return;

  if (bid > pos.peak) pos.peak = bid;
  if (!pos.armed && pos.peak >= pos.entryPrice + LADDER_TP_ARM) {
    pos.armed = true;
    log(`🎯 Ladder ${side} trailing stop ARMED @ peak ${pos.peak.toFixed(2)} — now trailing ${LADDER_TP_TRAIL} behind peak`);
  }
  if (!pos.armed) return;

  const stopPrice = round2(pos.peak - LADDER_TP_TRAIL);
  if (bid > stopPrice) return; // still above the trailing stop

  const tokenId = side === 'Up' ? state.upTokenId : state.downTokenId;
  await placeMarketableSell(tokenId, bid, pos.shares);
  const fee = takerFee(pos.shares, bid);
  const proceeds = round2(bid * pos.shares - fee);
  bankroll = round2(bankroll + proceeds);
  const profit = round2(proceeds - pos.cost);
  realizedPnl = round2(realizedPnl + profit);
  feesPaid = round2(feesPaid + fee);
  if (profit >= 0) wins++; else losses++;
  pos.closed = true;
  L.cycles++;
  L.cyclePnl = round2(L.cyclePnl + profit);
  L.nextEntryPrice = round2(clamp(bid - LADDER_REENTRY_OFFSET, LADDER_MIN, LADDER_MAX));
  log(`🏁 Ladder ${side} cycle #${L.cycles} closed @ ${bid.toFixed(2)} (peak ${pos.peak.toFixed(2)}) | ${pos.shares}sh | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)} | next rung @ ${L.nextEntryPrice.toFixed(2)}`);
  registerTrade({ strategy: 'Ladder', side: 'SELL', outcome: side, reason: 'TRAIL', price: bid, shares: pos.shares, profit });
  recordEquity();
  L.position = null; // clear so the next tick's ladderPlaceEntry posts the next rung
}

// ─────────────────────────────────────────
//  Window resolution
// ─────────────────────────────────────────
async function determineWinningSide() {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(state.slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === state.conditionId) || (event.markets || [])[0];
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const winner = (outcomes[bestI] || '').trim();
      if (winner) return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
    }
  } catch (_) {}
  if (state.upBid != null && state.downBid != null) return state.upBid >= state.downBid ? 'Up' : 'Down';
  return null;
}

async function resolveWindow() {
  if (state.resolvedThisWindow) return;
  state.resolvedThisWindow = true;

  const anyOpen = ['Up', 'Down'].some(s => state.ladder[s].position && !state.ladder[s].position.closed);
  let winner = null;
  if (anyOpen) winner = await determineWinningSide();

  // Cancel any still-resting entry order that never filled — it should not
  // carry over or linger once the window is done.
  for (const side of ['Up', 'Down']) {
    const L = state.ladder[side];
    if (L.order) { await cancelOrder(L.order.orderId); L.order = null; }
  }

  for (const side of ['Up', 'Down']) {
    const pos = state.ladder[side].position;
    if (!pos || pos.closed) continue;
    const won = winner === side;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    bankroll = round2(bankroll + proceeds);
    realizedPnl = round2(realizedPnl + profit);
    if (won) wins++; else losses++;
    pos.closed = true;
    const icon = won ? '💰' : '💥';
    log(`${icon} Ladder ${side} RESOLUTION ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)} (dashboard bookkeeping only — real redemption is via the separate claim script)`);
    registerTrade({ strategy: 'Ladder', side: 'SELL', outcome: side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
  }
  recordEquity();
}

// ─────────────────────────────────────────
//  Main tick
// ─────────────────────────────────────────
async function tick() {
  const ws = currentWindowStart();
  if (state.windowStart === null || ws !== state.windowStart) {
    if (state.windowStart !== null && !state.resolvedThisWindow) await resolveWindow();
    await loadWindow();
  }
  if (!state.tradable || !tradingEnabled) return;

  const elapsed = nowSec() - state.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !state.resolvedThisWindow) {
    await resolveWindow();
  }
  if (state.resolvedThisWindow) return;

  for (const side of ['Up', 'Down']) {
    await ladderPlaceEntry(side, elapsed);
    await ladderCheckFill(side);
    await ladderManagePosition(side);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const mv = markValue();
  const held = round2(mv - bankroll);
  const costBasis = round2(
    ['Up','Down'].reduce((s, side) => {
      const p = state.ladder[side].position;
      return s + (p && !p.closed ? p.cost : 0);
    }, 0)
  );
  const unrealizedPnl = round2(held - costBasis);
  return {
    dryRun: DRY_RUN, tradingEnabled, symbol: SYMBOL,
    tradable: state.tradable, slug: state.slug, windowEnd: state.windowEnd,
    secsToEnd: state.windowEnd ? Math.max(0, Math.floor(state.windowEnd - nowSec())) : null,
    upAsk: state.upAsk, upBid: state.upBid, downAsk: state.downAsk, downBid: state.downBid,
    ladder: {
      Up: state.ladder.Up,
      Down: state.ladder.Down,
    },
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    // capital == starting capital + realized P&L + unrealized P&L, i.e. the
    // real-time account value — recomputed fresh every tick, never cached.
    capital: mv,
    realizedPnl, unrealizedPnl, feesPaid, rebatesEarned, wins, losses,
    totalPnl: round2(mv - TOTAL_CAPITAL),
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      ladderMin: LADDER_MIN, ladderMax: LADDER_MAX, ladderEntryOffset: LADDER_ENTRY_OFFSET,
      ladderTpArm: LADDER_TP_ARM, ladderTpTrail: LADDER_TP_TRAIL, ladderReentryOffset: LADDER_REENTRY_OFFSET,
      ladderShares: LADDER_SHARES,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE, cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    equityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
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
      await tick();
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(_list) {
  // This bot only ever trades BTC — retained as a no-op for API compatibility with the dashboard.
  return { ok: true, pairs: [SYMBOL], perPairCapital: TOTAL_CAPITAL };
}
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (existing positions still tracked for resolution bookkeeping)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

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
  log(`🚀 Independent Ladder Bot — BTC 15-minute windows only`);
  log(`⚙️  $${TOTAL_CAPITAL} capital`);
  log(`⚙️  Ladder: Up and Down each run their OWN independent ladder, band [${LADDER_MIN}, ${LADDER_MAX}] | entry = reference - ${LADDER_ENTRY_OFFSET}, ${LADDER_SHARES}sh fixed per rung | trailing stop arms at +${LADDER_TP_ARM} profit, then trails ${LADDER_TP_TRAIL} behind peak | on exit, next rung re-enters at (exit - ${LADDER_REENTRY_OFFSET}) | unarmed positions ride to resolution | waits ${LADDER_ENTRY_DELAY_SECS}s after window start before the first entry`);
  log(`⚙️  fill semantics: limit fills at the real current ask when ask<=ceiling, never worse than the ceiling price`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
