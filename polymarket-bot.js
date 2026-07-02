'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — MAKER MERGE-ARB BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  MARKETS: same deterministic 5-minute BTC/ETH/SOL Up/Down events as
 *  before — "<asset>-updown-5m-<unixWindowStart>". "Up" pays $1 if the
 *  asset's close price >= its open ("Price to Beat"), else "Down" pays $1.
 *
 *  STRATEGY (completely replaces the old momentum/z-score/TP-SL logic):
 *  This is a merge-arbitrage / two-sided market-making strategy, not a
 *  directional bet. Every 10 seconds, while inside the trading window,
 *  the bot rests TWO limit buy orders simultaneously:
 *    - BUY 50 Up shares   @ (mid of Up book)   - 0.04
 *    - BUY 50 Down shares @ (mid of Down book) - 0.04
 *  Both are genuine maker orders sitting inside the spread — they do not
 *  cross, so they may or may not fill. The bot polls every 500ms to see
 *  if either side has traded down into its resting price.
 *
 *  THE EDGE — MERGE: Polymarket's CTF contract lets you burn 1 Up share
 *  + 1 Down share for the SAME condition and redeem exactly $1 of
 *  collateral, at any time before resolution, via mergePositions() —
 *  regardless of where the market is currently pricing either side. So
 *  whenever this bot ends up holding equal Up and Down share counts, it
 *  merges them immediately for a guaranteed $1/pair, locking in the gap
 *  between what was paid for the pair and $1 with zero exposure to which
 *  side actually wins. See the accompanying deep-dive on how merge works.
 *
 *  ORDER LIFECYCLE PER 10s CYCLE:
 *    - t+0s:  place both limit orders (Up + Down, 50 shares each)
 *    - polled every 500ms from placement onward; either leg can fill any
 *      time and simply keeps resting on the book if it doesn't
 *    - every 10s a NEW cycle fires regardless of whether earlier cycles
 *      have filled yet — cycles stack independently, so several pairs of
 *      resting orders can be open on the book at once
 *    - at 280s of elapsed window time, ANY leg (from any cycle) still
 *      unfilled is cancelled in one sweep — this is the only cancellation
 *      point, there is no per-cycle timeout
 *    - unfilled orders never touch the bankroll — capital is only ever
 *      debited at the moment a leg actually fills (see fillLeg())
 *
 *  FILTERS / GATES:
 *    - Only trade while BOTH the Up ask and the Down ask are inside
 *      [0.25, 0.75] — refuse to quote a lopsided/near-resolved book.
 *    - Only start NEW cycles during the first 4 minutes (240s) of the
 *      5-minute window — the last 60s is left clean for wind-down.
 *
 *  LEFTOVER SHARES (unequal fills — e.g. Up filled but Down didn't):
 *    - These sit unmerged, accumulating across cycles, and get merged
 *      the moment the opposite side catches up to an equal count.
 *    - Anything still unmatched once the 4-minute mark passes gets a
 *      resting limit SELL at 0.99 (still a maker order). If that never
 *      fills before window close, it simply rides to Polymarket's own
 *      on-chain resolution/redemption — same as holding a normal
 *      position to expiry.
 *
 *  FEES (Polymarket Fee Structure V2, crypto category —
 *  https://docs.polymarket.com/trading/fees, https://help.polymarket.com):
 *  fee = shares × 0.07 × price × (1-price) — charged ONLY to takers, zero
 *  at the extremes (near $0.01/$0.99), peaking (~1.8% of notional) at
 *  $0.50, symmetric around $0.50. Makers pay $0 and additionally earn a
 *  20% rebate (crypto category's share) of the fee value their filled
 *  liquidity generated. Every order this strategy places is a passive
 *  resting order below/above the current market, so in practice it should
 *  always land on the zero-fee + rebate side of that split — there is no
 *  intentional taker leg anywhere in this strategy. Merging itself is
 *  entirely fee-free on-chain (Polygon gas only, not modeled here).
 *
 *  CAPITAL: $2000 demo capital split evenly across configured pairs
 *  (BTC/ETH/SOL by default) into independent bankrolls.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const BINANCE = 'https://api.binance.com';

// ── Timing ──
const TICK_MS             = 500;    // main decision loop — also our fill-check cadence
const SPOT_REFRESH_MS     = 1000;   // Binance price poll
const POLY_PRICE_REFRESH_MS = 1000; // CLOB price poll
const WINDOW_SECS         = 300;    // 5 minutes
const RESOLUTION_BUFFER_S = 8;      // wait this long past window close before finalizing outcome
const SLUG_OFFSET_FALLBACKS = [0, -300, 300]; // handle brief indexing lag around the boundary

// ── Env / config ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC,ETH,SOL')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ── Strategy config (merge-arb) ──
const ORDER_SHARES           = Number(process.env.ORDER_SHARES || 50);   // fixed shares per leg, per cycle
const ORDER_PRICE_OFFSET     = Number(process.env.ORDER_PRICE_OFFSET || 0.04); // below mid, both sides
const CYCLE_INTERVAL_SECS    = Number(process.env.CYCLE_INTERVAL_SECS || 10);  // new order-pair every N seconds
const CANCEL_AT_ELAPSED_SECS = Number(process.env.CANCEL_AT_ELAPSED_SECS || 280); // single global sweep: cancel ALL still-pending legs once window elapsed reaches this
const TRADE_CUTOFF_SECS      = Number(process.env.TRADE_CUTOFF_SECS || 240);   // stop starting new cycles after 4 min
const PRICE_BAND_MIN         = Number(process.env.PRICE_BAND_MIN || 0.25);
const PRICE_BAND_MAX         = Number(process.env.PRICE_BAND_MAX || 0.75);
const LATE_SELL_PRICE        = Number(process.env.LATE_SELL_PRICE || 0.99);
const MIN_SHARES             = Number(process.env.MIN_SHARES || 5); // Polymarket order minimum
const EQUITY_POINTS_PER_PAIR = Number(process.env.EQUITY_POINTS_PER_PAIR || 300);
const EQUITY_POINTS_TOTAL    = Number(process.env.EQUITY_POINTS_TOTAL || 500);

// ── Fees & maker rebates (Polymarket Fee Structure V2, crypto category) ──
// fee = shares × feeRate × price × (1-price). Only TAKER fills pay this;
// makers always pay zero. This strategy never intentionally takes, so
// these functions exist mainly for the (rare) case a fill crosses the
// spread unexpectedly, and for the maker-rebate calc on every real fill.
const CRYPTO_TAKER_FEE_RATE  = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

const BINANCE_SYMBOL = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT',
  DOGE: 'DOGEUSDT', BNB: 'BNBUSDT', LTC: 'LTCUSDT', ADA: 'ADAUSDT',
  AVAX: 'AVAXUSDT', LINK: 'LINKUSDT', MATIC: 'MATICUSDT', POL: 'POLUSDT',
};

// ── State ──
let emitFn   = () => {};
let slog     = () => {};
let trader   = null;
let startTime = Date.now();
let logs     = [];
let trades   = [];
let tradingEnabled = true;
let pairList = [...DEFAULT_PAIRS];
let perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
let pairs = {}; // symbol -> pair state
let lastSpotFetch = 0;
let lastPolyPriceFetch = 0;
let totalEquityCurve = []; // [{t(ms), equity}] portfolio-wide, sampled on every entry/exit

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
function round4(n) { return Math.round(n * 10000) / 10000; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }
function nowSec() { return Date.now() / 1000; }

// ─────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-5m-bot/2.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-5m-bot/2.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshPairState(symbol) {
  return {
    symbol,
    binanceSymbol: BINANCE_SYMBOL[symbol] || `${symbol}USDT`,
    tradable: false,
    windowStart: null,
    windowEnd: null,
    slug: null,
    eventTitle: null,
    conditionId: null,
    upTokenId: null,
    downTokenId: null,
    spotBuffer: [],
    openSpot: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,

    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,

    // unmatched (unmerged) share inventory, with running cost basis
    pUp: 0, pUpCost: 0,
    pDown: 0, pDownCost: 0,

    mergesCount: 0,
    mergedShares: 0,
    resolutionWins: 0,
    resolutionLosses: 0,

    cycles: [],           // active order-pair cycles: {id, placedAt, placedAtElapsed, up:{...}, down:{...}} — cancelled only by the global sweep at CANCEL_AT_ELAPSED_SECS
    lastCycleBucket: -1,  // which 10s bucket (elapsed/CYCLE_INTERVAL_SECS) last spawned a cycle
    lateSell: { up: null, down: null }, // resting 0.99 sell orders placed after the 4-min cutoff

    resolvedThisWindow: true,
    lastResult: null,
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

function qOf(m) {
  return (m.question || m.groupItemTitle || m.title || '').toLowerCase();
}

function parseMarketTokens(m) {
  try {
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
    const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) {
    return [];
  }
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
    } catch (_) {
      // not indexed yet / doesn't exist — try next offset
    }
  }
  return null;
}

async function loadPairWindow(p) {
  const ws = currentWindowStart();
  if (p.windowStart === ws && p.upTokenId) return; // already loaded & current

  const found = await fetchEventForWindow(p.symbol, ws);
  if (!found) {
    p.tradable = false;
    return; // will retry next tick
  }
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

  const isNewWindow = p.windowStart !== windowStart;

  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.slug = slug;
  p.eventTitle = event.title || event.slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;

  if (isNewWindow) {
    p.resolvedThisWindow = false;
    p.spotBuffer = [];
    p.openSpot = null;

    // fresh window — clear all strategy bookkeeping (resolvePairWindow
    // already should have zeroed these, this is a defensive reset)
    p.cycles = [];
    p.lastCycleBucket = -1;
    p.pUp = 0; p.pUpCost = 0;
    p.pDown = 0; p.pDownCost = 0;
    p.lateSell = { up: null, down: null };

    log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z`);
  }
}

// ─────────────────────────────────────────
//  Spot price feed (Binance REST — public, no auth)
// ─────────────────────────────────────────
async function refreshSpotPrices() {
  const symbols = [...new Set(Object.values(pairs).map(p => p.binanceSymbol))];
  if (!symbols.length) return;
  try {
    const qs = encodeURIComponent(JSON.stringify(symbols));
    const data = await getJSON(`${BINANCE}/api/v3/ticker/price?symbols=${qs}`);
    const now = Date.now();
    const bySymbol = {};
    for (const row of data) bySymbol[row.symbol] = parseFloat(row.price);
    for (const p of Object.values(pairs)) {
      const price = bySymbol[p.binanceSymbol];
      if (!price || !Number.isFinite(price)) continue;
      p.spotBuffer.push({ t: now, price });
      const cutoff = now - 90_000;
      while (p.spotBuffer.length && p.spotBuffer[0].t < cutoff) p.spotBuffer.shift();
      if (p.openSpot === null && p.windowStart !== null) p.openSpot = price;
    }
  } catch (e) {
    log(`⚠️  Spot price refresh failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────
//  Polymarket CLOB price feed
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
// Wraps the on-chain CTF mergePositions() call (burns 1 Up + 1 Down per
// unit, mints 1 collateral unit each). Falls back to a no-op with a
// warning if the trader module doesn't implement it yet — the bot's own
// bankroll/PnL accounting still reflects the merge either way, but in
// LIVE mode you need this wired to an actual mergePositions() call
// (see /mnt/skills or trader.js) for the shares to really be redeemed.
async function mergePositions(p, shares) {
  if (!DRY_RUN && trader) {
    if (typeof trader.mergePositions === 'function') {
      try { return await trader.mergePositions(p.conditionId, shares); }
      catch (e) { log(`⚠️  ${p.symbol}: on-chain mergePositions() call failed: ${e.message}`); }
    } else {
      log(`⚠️  ${p.symbol}: trader.mergePositions() not implemented — merge accounted internally only, no on-chain call made`);
    }
  }
}

// ─────────────────────────────────────────
//  Fees & maker rebates — Polymarket Fee Structure V2 (crypto)
// ─────────────────────────────────────────
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Mark-to-market / equity
// ─────────────────────────────────────────
function pairMarkValue(p) {
  const upMark = (p.upBid ?? (p.pUp > 0 ? p.pUpCost / p.pUp : 0));
  const downMark = (p.downBid ?? (p.pDown > 0 ? p.pDownCost / p.pDown : 0));
  return round2(p.bankroll + p.pUp * upMark + p.pDown * downMark);
}
function pushGlobalEquity() {
  const total = round2(Object.values(pairs).reduce((s, p) => s + pairMarkValue(p), 0));
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > EQUITY_POINTS_TOTAL) totalEquityCurve.shift();
}
function recordEquity(p) {
  p.equityCurve.push({ t: Date.now(), equity: pairMarkValue(p) });
  if (p.equityCurve.length > EQUITY_POINTS_PER_PAIR) p.equityCurve.shift();
  pushGlobalEquity();
}

function registerTrade(p, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: p.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Filters / pricing
// ─────────────────────────────────────────
function priceBandOk(p) {
  return p.upAsk != null && p.downAsk != null &&
    p.upAsk >= PRICE_BAND_MIN && p.upAsk <= PRICE_BAND_MAX &&
    p.downAsk >= PRICE_BAND_MIN && p.downAsk <= PRICE_BAND_MAX;
}
function computeLimitPrice(ask, bid) {
  if (ask == null) return null;
  const mid = bid != null ? (ask + bid) / 2 : ask;
  return clamp(round2(mid - ORDER_PRICE_OFFSET), 0.01, 0.99);
}

// ─────────────────────────────────────────
//  Cycle engine — place / poll / cancel the two-sided limit orders
// ─────────────────────────────────────────
async function maybeStartCycle(p, elapsed) {
  if (!tradingEnabled) return;
  if (elapsed < 0 || elapsed >= TRADE_CUTOFF_SECS) return;

  const bucket = Math.floor(elapsed / CYCLE_INTERVAL_SECS);
  if (bucket === p.lastCycleBucket) return; // this 10s slot already fired
  p.lastCycleBucket = bucket;

  if (!priceBandOk(p)) {
    log(`⏭️  ${p.symbol}: skip cycle @${Math.floor(elapsed)}s — price outside 0.25-0.75 (up=${p.upAsk} down=${p.downAsk})`);
    return;
  }

  const upLimit = computeLimitPrice(p.upAsk, p.upBid);
  const downLimit = computeLimitPrice(p.downAsk, p.downBid);
  if (upLimit == null || downLimit == null) return;

  const notionalNeeded = round2((upLimit + downLimit) * ORDER_SHARES);
  if (notionalNeeded > p.bankroll) {
    log(`⏭️  ${p.symbol}: skip cycle — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${notionalNeeded.toFixed(2)} needed)`);
    return;
  }

  const upOrder = await placeLimitBuy(p.upTokenId, upLimit, ORDER_SHARES);
  const downOrder = await placeLimitBuy(p.downTokenId, downLimit, ORDER_SHARES);
  const now = Date.now();

  p.cycles.push({
    id: `${p.symbol}-${now}`,
    placedAt: now,
    placedAtElapsed: elapsed,
    up: { orderId: upOrder.id || upOrder.orderId || null, limitPrice: upLimit, shares: ORDER_SHARES, status: 'pending' },
    down: { orderId: downOrder.id || downOrder.orderId || null, limitPrice: downLimit, shares: ORDER_SHARES, status: 'pending' },
  });

  log(`📌 ${p.symbol} cycle @${Math.floor(elapsed)}s → Up ${ORDER_SHARES}sh@${upLimit.toFixed(2)} | Down ${ORDER_SHARES}sh@${downLimit.toFixed(2)} | rests until ${CANCEL_AT_ELAPSED_SECS}s global sweep (no capital held while unfilled)`);
}

async function fillLeg(p, cycle, legName) {
  const leg = cycle[legName];
  const notional = round2(leg.limitPrice * leg.shares);
  if (notional > p.bankroll) { leg.status = 'skipped'; return; }

  const rebate = makerRebate(leg.shares, leg.limitPrice);
  p.bankroll = round2(p.bankroll - notional + rebate);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  p.realizedPnl = round2(p.realizedPnl + rebate); // rebate is realized income regardless of eventual outcome
  leg.status = 'filled';

  const label = legName === 'up' ? 'Up' : 'Down';
  if (legName === 'up') { p.pUp = round2(p.pUp + leg.shares); p.pUpCost = round2(p.pUpCost + notional); }
  else { p.pDown = round2(p.pDown + leg.shares); p.pDownCost = round2(p.pDownCost + notional); }

  log(`✅ ${p.symbol} FILL ${label} ${leg.shares}sh@${leg.limitPrice.toFixed(2)} | cost=$${notional.toFixed(2)} rebate=+$${rebate.toFixed(4)} | held Up=${p.pUp} Down=${p.pDown}`);
  registerTrade(p, { side: 'BUY', outcome: label, price: leg.limitPrice, shares: leg.shares, cost: notional, rebate });
}

async function processCycles(p, elapsed) {
  const globalCancel = elapsed >= CANCEL_AT_ELAPSED_SECS;
  for (const cycle of p.cycles) {
    for (const legName of ['up', 'down']) {
      const leg = cycle[legName];
      if (leg.status !== 'pending') continue;
      const ask = legName === 'up' ? p.upAsk : p.downAsk;

      if (ask != null && ask <= leg.limitPrice) {
        await fillLeg(p, cycle, legName);
      } else if (globalCancel) {
        await cancelOrder(leg.orderId);
        leg.status = 'cancelled';
        log(`🚫 ${p.symbol} cancel ${legName === 'up' ? 'Up' : 'Down'}@${leg.limitPrice.toFixed(2)} — unfilled at ${CANCEL_AT_ELAPSED_SECS}s sweep (no capital was held for it)`);
      }
    }
  }
  // drop cycles where both legs have resolved (filled/cancelled/skipped)
  p.cycles = p.cycles.filter(c => c.up.status === 'pending' || c.down.status === 'pending');
}

// ─────────────────────────────────────────
//  Merge engine — the core edge. See deep-dive: burns 1 Up + 1 Down for
//  $1 of collateral, unconditionally, any time before resolution.
// ─────────────────────────────────────────
function attemptMerges(p) {
  while (p.pUp > 0 && p.pDown > 0) {
    const amt = round2(Math.min(p.pUp, p.pDown));
    if (amt <= 0) break;

    const upCostShare = p.pUp > 0 ? round2((p.pUpCost / p.pUp) * amt) : 0;
    const downCostShare = p.pDown > 0 ? round2((p.pDownCost / p.pDown) * amt) : 0;
    const totalCost = round2(upCostShare + downCostShare);
    const proceeds = round2(amt * 1); // mergePositions() redeems exactly $1 per Up+Down unit
    const profit = round2(proceeds - totalCost);

    p.pUp = round2(p.pUp - amt);
    p.pUpCost = round2(p.pUpCost - upCostShare);
    p.pDown = round2(p.pDown - amt);
    p.pDownCost = round2(p.pDownCost - downCostShare);

    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.mergesCount++;
    p.mergedShares = round2(p.mergedShares + amt);

    mergePositions(p, amt); // fire-and-forget on-chain call in LIVE mode

    log(`🔀 ${p.symbol} MERGE ${amt}sh Up+Down → $${proceeds.toFixed(2)} | cost=$${totalCost.toFixed(2)} pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'MERGE', outcome: 'Up+Down', price: 1, shares: amt, profit });
    recordEquity(p);
  }
}

// ─────────────────────────────────────────
//  Post-4-minute wind-down: rest a 0.99 sell on any leftover single-side
//  inventory; anything that doesn't fill just rides to resolution.
// ─────────────────────────────────────────
async function manageLateWindow(p, elapsed) {
  if (elapsed < TRADE_CUTOFF_SECS) return;

  for (const side of ['up', 'down']) {
    const heldKey = side === 'up' ? 'pUp' : 'pDown';
    const costKey = side === 'up' ? 'pUpCost' : 'pDownCost';
    const tokenId = side === 'up' ? p.upTokenId : p.downTokenId;
    const bid = side === 'up' ? p.upBid : p.downBid;
    const label = side === 'up' ? 'Up' : 'Down';
    let late = p.lateSell[side];

    if (!late && p[heldKey] > 0) {
      const shares = p[heldKey];
      const order = await placeLimitSell(tokenId, LATE_SELL_PRICE, shares);
      p.lateSell[side] = { orderId: order.id || order.orderId || null, shares, price: LATE_SELL_PRICE };
      log(`🏁 ${p.symbol} 4-min cutoff — resting ${label} sell ${shares}sh@${LATE_SELL_PRICE} (falls back to resolution if unfilled)`);
      continue;
    }

    late = p.lateSell[side];
    if (late && bid != null && bid >= late.price) {
      const proceeds = round2(late.price * late.shares);
      const rebate = makerRebate(late.shares, late.price);
      const costBasis = p[costKey];
      const profit = round2(proceeds + rebate - costBasis);

      p.bankroll = round2(p.bankroll + proceeds + rebate);
      p.realizedPnl = round2(p.realizedPnl + profit);
      p.rebatesEarned = round2(p.rebatesEarned + rebate);
      p[heldKey] = 0; p[costKey] = 0;
      p.lateSell[side] = null;

      log(`💰 ${p.symbol} late sell ${label} filled ${late.shares}sh@${late.price} | rebate=+$${rebate.toFixed(4)} pnl=$${profit.toFixed(2)}`);
      registerTrade(p, { side: 'SELL', outcome: label, price: late.price, shares: late.shares, profit, rebate });
      recordEquity(p);
    }
  }
}

// ─────────────────────────────────────────
//  Resolution — anything never merged and never sold at 0.99 settles via
//  Polymarket's own on-chain outcome (heuristic fallback: live spot vs
//  window-open spot, same rule the market itself resolves by).
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

  const lastSpot = p.spotBuffer.length ? p.spotBuffer[p.spotBuffer.length - 1].price : null;
  if (lastSpot === null || p.openSpot === null) return null;
  return lastSpot >= p.openSpot ? 'Up' : 'Down';
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  // cancel any still-open cycle legs and late-sell orders before settling
  for (const cycle of p.cycles) {
    if (cycle.up.status === 'pending') { await cancelOrder(cycle.up.orderId); cycle.up.status = 'cancelled'; }
    if (cycle.down.status === 'pending') { await cancelOrder(cycle.down.orderId); cycle.down.status = 'cancelled'; }
  }
  p.cycles = [];
  for (const side of ['up', 'down']) {
    const late = p.lateSell[side];
    if (late) { await cancelOrder(late.orderId); p.lateSell[side] = null; }
  }

  if (p.pUp <= 0 && p.pDown <= 0) return;

  const winner = await determineWinningSide(p);
  if (winner === null) {
    log(`⚠️  ${p.symbol}: could not determine outcome — leftover Up=${p.pUp} Down=${p.pDown} left tracked at last mark`);
    return;
  }

  if (p.pUp > 0) {
    const won = winner === 'Up';
    const proceeds = won ? round2(p.pUp * 1) : 0;
    const profit = round2(proceeds - p.pUpCost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (won) p.resolutionWins++; else p.resolutionLosses++;
    log(`${won ? '💰' : '💥'} ${p.symbol} RESOLUTION Up ${p.pUp}sh → ${won ? 'WIN' : 'LOSS'} | pnl=$${profit.toFixed(2)}`);
    registerTrade(p, { side: 'RESOLVE', outcome: 'Up', price: won ? 1 : 0, shares: p.pUp, profit });
    p.pUp = 0; p.pUpCost = 0;
  }
  if (p.pDown > 0) {
    const won = winner === 'Down';
    const proceeds = won ? round2(p.pDown * 1) : 0;
    const profit = round2(proceeds - p.pDownCost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (won) p.resolutionWins++; else p.resolutionLosses++;
    log(`${won ? '💰' : '💥'} ${p.symbol} RESOLUTION Down ${p.pDown}sh → ${won ? 'WIN' : 'LOSS'} | pnl=$${profit.toFixed(2)}`);
    registerTrade(p, { side: 'RESOLVE', outcome: 'Down', price: won ? 1 : 0, shares: p.pDown, profit });
    p.pDown = 0; p.pDownCost = 0;
  }
  recordEquity(p);
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

  const elapsed = nowSec() - p.windowStart;
  const remaining = p.windowEnd - nowSec();

  await processCycles(p, elapsed); // poll fills every tick (500ms); cancel sweep only once elapsed >= CANCEL_AT_ELAPSED_SECS
  attemptMerges(p);            // merge any matched Up+Down inventory immediately
  await maybeStartCycle(p, elapsed); // spawn a new order-pair every 10s, only in first 4 min
  await manageLateWindow(p, elapsed); // past 4 min: rest 0.99 sells on leftovers

  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const spot = p.spotBuffer.length ? p.spotBuffer[p.spotBuffer.length - 1].price : null;
    const markValue = pairMarkValue(p);
    const unrealized = round2(markValue - p.bankroll - 0); // inventory mark above cash

    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      openSpot: p.openSpot,
      spot,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      mergesCount: p.mergesCount,
      mergedShares: p.mergedShares,
      resolutionWins: p.resolutionWins,
      resolutionLosses: p.resolutionLosses,
      lastResult: p.lastResult,
      inventory: { pUp: p.pUp, pDown: p.pDown },
      openCycles: p.cycles.map(c => ({
        upStatus: c.up.status, upPrice: c.up.limitPrice,
        downStatus: c.down.status, downPrice: c.down.limitPrice,
        placedAtElapsed: Math.floor(c.placedAtElapsed ?? 0),
        secsToSweep: p.windowStart != null ? Math.max(0, Math.round(CANCEL_AT_ELAPSED_SECS - (nowSec() - p.windowStart))) : null,
      })),
      lateSell: {
        up: p.lateSell.up ? { shares: p.lateSell.up.shares, price: p.lateSell.up.price } : null,
        down: p.lateSell.down ? { shares: p.lateSell.down.shares, price: p.lateSell.down.price } : null,
      },
      equityCurve: p.equityCurve,
    };
  });

  const totalBankroll = round2(pairStates.reduce((s, p) => s + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((s, p) => s + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((s, p) => s + p.realizedPnl, 0));
  const totalUnrealized = round2(pairStates.reduce((s, p) => s + p.unrealizedPnl, 0));
  const totalMerges = pairStates.reduce((s, p) => s + p.mergesCount, 0);
  const totalMergedShares = round2(pairStates.reduce((s, p) => s + p.mergedShares, 0));
  const totalFeesPaid = round2(pairStates.reduce((s, p) => s + p.feesPaid, 0));
  const totalRebatesEarned = round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0));
  const totalResWins = pairStates.reduce((s, p) => s + p.resolutionWins, 0);
  const totalResLosses = pairStates.reduce((s, p) => s + p.resolutionLosses, 0);

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
    totalMerges,
    totalMergedShares,
    totalResolutionWins: totalResWins,
    totalResolutionLosses: totalResLosses,
    totalFeesPaid,
    totalRebatesEarned,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      orderShares: ORDER_SHARES,
      orderPriceOffset: ORDER_PRICE_OFFSET,
      cycleIntervalSecs: CYCLE_INTERVAL_SECS,
      cancelAtElapsedSecs: CANCEL_AT_ELAPSED_SECS,
      tradeCutoffSecs: TRADE_CUTOFF_SECS,
      priceBandMin: PRICE_BAND_MIN,
      priceBandMax: PRICE_BAND_MAX,
      lateSellPrice: LATE_SELL_PRICE,
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
      if (now - lastSpotFetch >= SPOT_REFRESH_MS) {
        lastSpotFetch = now;
        await refreshSpotPrices();
      }
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
  log('⏸️  Trading paused (no new cycles — open orders/inventory still managed for cancel/merge/resolution)');
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
  log(`🚀 5-Minute Crypto Up/Down Merge-Arb Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  ${ORDER_SHARES}sh Up + ${ORDER_SHARES}sh Down every ${CYCLE_INTERVAL_SECS}s @ mid-${ORDER_PRICE_OFFSET} | rests until global cancel sweep @ ${CANCEL_AT_ELAPSED_SECS}s (no capital held while unfilled) | band [${PRICE_BAND_MIN}-${PRICE_BAND_MAX}] | new cycles stop @ ${TRADE_CUTOFF_SECS}s | late sell @ ${LATE_SELL_PRICE}`);
  log(`⚙️  fees: maker legs 0 fee +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate (crypto taker rate ${CRYPTO_TAKER_FEE_RATE}) | merge is fee-free on-chain`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  await refreshSpotPrices();
  lastSpotFetch = Date.now();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
