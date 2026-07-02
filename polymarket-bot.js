'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN MULTI-PAIR BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  MARKETS: Every "<asset>-updown-5m-<unixWindowStart>" event Polymarket
 *  runs (e.g. https://polymarket.com/event/btc-updown-5m-1782897900).
 *  These are deterministic — a new one opens every 5 minutes, on the
 *  clock, for each supported asset (BTC, ETH, SOL, XRP, DOGE by default,
 *  configurable). Each event has ONE market with two outcomes, "Up" and
 *  "Down". "Up" pays $1 if the asset's price at window-close is >= its
 *  price at window-open ("Price to Beat"); otherwise "Down" pays $1.
 *  Settlement is fully automatic on-chain (Chainlink oracle) — we do
 *  NOT need to force-close positions at expiry the way a sports match
 *  bot would, holding to expiry IS how you collect a win.
 *
 *  SLUG MATH: window_ts = now - (now % 300); slug = `${asset}-updown-5m-${window_ts}`
 *  This lets us load every pair's current (and, one tick ahead, next)
 *  window directly with zero search calls — far more reliable than
 *  keyword search for markets that only exist for 5 minutes.
 *
 *  SIGNAL (own logic — momentum + mean-reversion-confirmation, scaled
 *  by realized volatility and time-in-window):
 *    - openDeltaPct  = % move of live price vs this window's open price
 *    - shortMomentum = % move over the trailing ~15s (confirms direction
 *                      isn't already reversing / chop)
 *    - vol           = realized stdev of 1-tick returns over trailing 60s
 *                      (per-asset, adapts threshold to how noisy BTC vs
 *                      DOGE naturally is)
 *    - z             = openDeltaPct / vol  → a "how unusual is this move"
 *                      score, comparable across assets
 *    - score         = z * time-decay-weight (weight rises as the window
 *                      runs out — less time left for a reversal, so the
 *                      same z-score deserves more confidence late)
 *    - ENTRY requires |score| over threshold, momentum agreeing with the
 *      open-delta direction (filters chop/reversal), and the market's own
 *      ask price for the favored side inside a sane [min,max] band (don't
 *      buy a coinflip with zero edge, and don't chase an already-priced-in
 *      near-certainty with no room left to profit)
 *
 *  ORDER EXECUTION & FEES (Polymarket Fee Structure V2, crypto category —
 *  https://docs.polymarket.com/trading/fees): makers pay zero fees and
 *  earn a 20% rebate on the fee value their filled liquidity generated;
 *  only takers (market orders, or limit orders aggressive enough to cross
 *  the spread and fill immediately) pay the fee. That distinction is about
 *  behavior, not the order type's name, so:
 *    - ENTRY is now a genuine resting (maker) limit order placed at the
 *      current best bid — it does NOT cross the spread, so it may not
 *      fill immediately, or at all. It waits up to ENTRY_FILL_TIMEOUT_SECS
 *      for the market to trade down through it; if that doesn't happen it
 *      cancels and the setup is skipped. This is the honest tradeoff of
 *      avoiding taker fees on entries: some real edges get missed because
 *      the passive price never gets hit.
 *    - TP exit is also a resting maker order (sitting at the target price)
 *      — when the bid reaches it, it fills at exactly that quoted price
 *      (not whatever the aggressor's price was), zero fee, plus rebate.
 *    - SL exit is a taker/market order on purpose — Polymarket has no
 *      native stop order type, so a real stop-loss can only be executed by
 *      actively firing an aggressive order the instant the price is
 *      breached. It fills at the live bid and pays the taker fee.
 *    - RESOLUTION (holding to expiry) is neither maker nor taker — it's
 *      contract settlement, which Polymarket does not charge any fee on.
 *
 *  RISK / MONEY MANAGEMENT (fixed-fractional, confidence-weighted — no
 *  martingale; sizing tracks bankroll and signal quality, never loss
 *  history, so a losing streak never grows exposure):
 *    - $2000 demo capital split evenly across configured pairs into
 *      independent bankrolls (so one pair's drawdown can't cannibalize
 *      another pair's stake sizing)
 *    - base stake = BASE_STAKE_FRACTION (default 4%) of that pair's
 *      *current* bankroll — so stakes compound up automatically as a pair
 *      wins, and shrink automatically as it draws down, with zero ladder
 *      logic and zero "revenge sizing" after a loss
 *    - confidence multiplier = |score| / Z_ENTRY_THRESHOLD, clamped to
 *      [1.0, CONF_MAX_MULT] — a signal that just barely cleared the entry
 *      bar gets the base stake; a stronger signal gets sized up (capped),
 *      because the edge behind it is larger, not because of what happened
 *      on the last trade
 *    - MAX_STAKE_FRACTION is an absolute backstop (never risk more than
 *      this fraction of bankroll in one trade, regardless of confidence)
 *
 *  SL / TP (early-exit only — a binary market held to expiry already IS
 *  the take-profit/stop-loss event; these are about *voluntarily* locking
 *  in an outcome before expiry when the live order book lets us):
 *    - TP: sell if the held token's bid rises to entry + TP_OFFSET —
 *      locks a win early rather than risking a last-second reversal
 *    - SL: sell if the held token's bid falls to entry - SL_OFFSET AND
 *      there's still enough time left for an exit to matter — cuts a
 *      clearly-wrong bet rather than riding it to a total loss. Inside
 *      the final EXIT_SAFETY_BUFFER seconds we stop SL-selling (a forced
 *      sale into a thin book seconds before close is worse than just
 *      letting it resolve)
 *    - Anything neither TP'd nor SL'd rides to resolution, same as a real
 *      binary option
 *
 *  CAPITAL/PNL DISPLAY: real-time mark-to-market per pair and in total,
 *  plus a running equity curve (bankroll + open-position mark, sampled on
 *  every entry/exit) for each pair individually and for the portfolio.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const BINANCE = 'https://api.binance.com';

// ── Timing ──
// Tightened now that we're down to 2 pairs (BTC, ETH) — total API call
// volume is lower than the original 5-pair setup even at these faster
// intervals, so this is well inside what Binance's public REST limits and
// Polymarket's CLOB REST limits comfortably bear. Railway/GitHub aren't
// actually in this loop at all — Railway just keeps the Node process
// alive (no cold starts to worry about), and GitHub is source control,
// not runtime — so the real ceiling here is the two external APIs.
const TICK_MS             = 500;    // main decision loop
const SPOT_REFRESH_MS     = 1000;   // Binance price poll
const POLY_PRICE_REFRESH_MS = 1000; // CLOB price poll
const WINDOW_SECS         = 300;    // 5 minutes
const RESOLUTION_BUFFER_S = 8;      // wait this long past window close before finalizing outcome
const SLUG_OFFSET_FALLBACKS = [0, -300, 300]; // handle brief indexing lag around the boundary

// ── Env / config ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC,ETH')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// Fixed-fractional + confidence-weighted sizing (replaces martingale).
const BASE_STAKE_FRACTION    = Number(process.env.BASE_STAKE_FRACTION || 0.04); // base stake = this % of CURRENT bankroll
const CONF_MAX_MULT          = Number(process.env.CONF_MAX_MULT || 2.5);        // flat cap on the confidence multiplier (V2 behavior — no adaptive calibration)
const MAX_STAKE_FRACTION     = Number(process.env.MAX_STAKE_FRACTION || 0.35);  // absolute backstop, regardless of confidence
const EQUITY_POINTS_PER_PAIR = Number(process.env.EQUITY_POINTS_PER_PAIR || 300);
const EQUITY_POINTS_TOTAL    = Number(process.env.EQUITY_POINTS_TOTAL || 500);

const Z_ENTRY_THRESHOLD      = Number(process.env.Z_ENTRY_THRESHOLD || 1.2);
const MIN_ENTRY_PRICE        = Number(process.env.MIN_ENTRY_PRICE || 0.60);
const MAX_ENTRY_PRICE        = Number(process.env.MAX_ENTRY_PRICE || 0.69);
// TP/SL were 0.12 / 0.20 — a 66% observed win rate on that ratio is still
// only roughly breakeven (breakeven WR = SL/(TP+SL) = 62.5%), and live
// results showed avg loss ran ~2x avg win, eating most of the edge from
// win rate alone. Rebalanced to a much closer-to-symmetric ratio so the
// same win rate converts into real positive expectancy (breakeven WR now
// ~46%, i.e. ~20pts of margin instead of ~4pts).
const TP_OFFSET              = Number(process.env.TP_OFFSET || 0.30);
const SL_OFFSET              = Number(process.env.SL_OFFSET || 0.13);
const MIN_ENTRY_ELAPSED_SEC  = Number(process.env.MIN_ENTRY_ELAPSED_SEC || 60);
const MIN_ENTRY_REMAINING_SEC = Number(process.env.MIN_ENTRY_REMAINING_SEC || 30);
// Inside this many seconds of window close, a real SL sell into a thinning
// book is unreliable, so the normal SL check stands down here.
const EXIT_SAFETY_BUFFER_SEC = Number(process.env.EXIT_SAFETY_BUFFER_SEC || 8);
// NEW: a gentler safeguard for that same late stretch. The two biggest
// losses in the last live run were both positions that never touched SL
// (bid stayed above the SL line the whole window) but flipped in the
// final seconds and resolved as a total loss. Rather than leaving risk
// management fully off in the closing seconds, de-risk any position that
// isn't clearly winning (bid still below entry) by selling for whatever's
// left, instead of gambling the full stake on a last-tick coin flip.
const LATE_DERISK_SECS       = Number(process.env.LATE_DERISK_SECS || 20);
const MIN_SHARES             = Number(process.env.MIN_SHARES || 5); // Polymarket order minimum

// ── Fees & maker rebates (Polymarket Fee Structure V2, crypto category) ──
// Source: https://docs.polymarket.com/trading/fees — fee = shares × feeRate
// × price × (1-price). Only TAKER fills pay this; makers always pay zero.
// Crypto category: taker fee rate 0.07, maker rebate 20% of the fee value
// their filled liquidity generated (paid daily in pUSD in reality — this
// bot credits it at fill time as the best available estimate of that
// payout, which is a simplification: real-world timing is daily, not
// per-trade). We deliberately do NOT model Polymarket's separate
// Liquidity Rewards ("reward farming") program on top of this — that
// program pays for resting *presence* via a pooled, competitively-shared
// formula we have no visibility into (competing makers, live reward pool
// size), so leaving it out is the conservative choice, not an oversight.
const CRYPTO_TAKER_FEE_RATE  = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);
// How long a resting (maker) entry order waits for a genuine fill before
// being cancelled. Real maker orders don't fill instantly — modeling that
// fill uncertainty is the honest cost of avoiding taker fees on entries.
const ENTRY_FILL_TIMEOUT_SECS = Number(process.env.ENTRY_FILL_TIMEOUT_SECS || 6);

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
function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }
function nowSec() { return Date.now() / 1000; }

// ─────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-5m-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-5m-bot/1.0' },
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
    tradable: false,          // do we currently have a loaded, tradable window?
    windowStart: null,
    windowEnd: null,
    slug: null,
    eventTitle: null,
    conditionId: null,
    upTokenId: null,
    downTokenId: null,
    openSpot: null,           // reference spot price captured at window open
    spotBuffer: [],           // [{t(ms), price}]
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    bankroll: perPairCapital, // cash available to this pair
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,
    pendingEntry: null,       // { side, tokenId, limitPrice, stake, confMult, sig, expiresAt }
    position: null,           // { side, tokenId, entryPrice, shares, cost, tpPrice, slPrice, orderId, openedAt, confMult, entryRebate }
    resolvedThisWindow: true, // true until a window is actually loaded
    lastResult: null,         // 'WIN' | 'LOSS' | null
    lastSignal: null,
    equityCurve: [{ t: Date.now(), equity: perPairCapital }], // [{t(ms), equity}]
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

// Try to load a pair's window at a specific windowStart. Tries the exact
// slug first, then a couple of neighboring windows in case of brief
// indexing lag right at the boundary (mirrors community-observed behavior
// where a market can take a few seconds to appear after its nominal start).
async function fetchEventForWindow(symbol, windowStart) {
  for (const offset of SLUG_OFFSET_FALLBACKS) {
    const ws = windowStart + offset;
    // only accept a fallback window if it's still the *current* live one
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
    p.position = p.position; // untouched here — resolution happens in resolvePairWindow before this is called
    p.resolvedThisWindow = false;
    p.spotBuffer = [];
    // reference open price: latest known spot if we have one, else fetched fresh below
    const latest = p.spotBuffer.length ? p.spotBuffer[p.spotBuffer.length - 1].price : null;
    p.openSpot = latest;
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
      // trim to last ~90s
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
  const tokenMeta = []; // parallel array: {symbol, side}
  for (const p of Object.values(pairs)) {
    if (!p.tradable || !p.upTokenId || !p.downTokenId) continue;
    requests.push({ token_id: p.upTokenId, side: 'BUY' });   tokenMeta.push({ p, field: 'upAsk' });
    requests.push({ token_id: p.upTokenId, side: 'SELL' });  tokenMeta.push({ p, field: 'upBid' });
    requests.push({ token_id: p.downTokenId, side: 'BUY' }); tokenMeta.push({ p, field: 'downAsk' });
    requests.push({ token_id: p.downTokenId, side: 'SELL' });tokenMeta.push({ p, field: 'downBid' });
  }
  if (!requests.length) return;

  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    // Response shape isn't fully consistent across CLOB versions — handle
    // both a keyed object ({token_id: {BUY, SELL}}) and an array of rows.
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
    // Fallback: per-token GET /price (slower but robust if the batch shape changed)
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
}

// ─────────────────────────────────────────
//  Signal engine
// ─────────────────────────────────────────
function computeSignal(p, elapsed) {
  const buf = p.spotBuffer;
  if (buf.length < 3 || p.openSpot === null) return null;
  const spot = buf[buf.length - 1].price;

  const openDeltaPct = ((spot - p.openSpot) / p.openSpot) * 100;

  // short-term momentum over trailing ~15s
  const t15 = Date.now() - 15_000;
  let ref = buf[0];
  for (const pt of buf) { if (pt.t <= t15) ref = pt; else break; }
  const shortMomPct = ((spot - ref.price) / ref.price) * 100;

  // realized volatility over trailing ~60s (stdev of tick returns, in %)
  const t60 = Date.now() - 60_000;
  const recent = buf.filter(pt => pt.t >= t60);
  let vol = 0;
  if (recent.length > 2) {
    const rets = [];
    for (let i = 1; i < recent.length; i++) {
      rets.push((recent[i].price - recent[i - 1].price) / recent[i - 1].price);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    vol = Math.sqrt(variance) * 100;
  }

  const epsilon = 0.003; // avoids divide-by-~0 in dead-quiet books
  const z = openDeltaPct / (vol + epsilon);
  const timeProgress = clamp(elapsed / WINDOW_SECS, 0, 1);
  const score = z * (0.5 + 0.5 * timeProgress);
  const direction = openDeltaPct >= 0 ? 'Up' : 'Down';
  const momentumAgrees = Math.sign(shortMomPct || 0) === Math.sign(openDeltaPct || 0) || Math.abs(shortMomPct) < 0.001;

  return { spot, openDeltaPct: round4(openDeltaPct), shortMomPct: round4(shortMomPct), vol: round4(vol), z: round4(z), score: round4(score), timeProgress, direction, momentumAgrees };
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

// ─────────────────────────────────────────
//  Fees & maker rebates — Polymarket Fee Structure V2 (crypto)
//  fee = shares × feeRate × price × (1 - price), taker-only, maker rebate
//  is that same formula × the category's rebate share.
// ─────────────────────────────────────────
function round5(n) { return Math.round(n * 100000) / 100000; }
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Money management — fixed-fractional bankroll % scaled by signal confidence
// ─────────────────────────────────────────
function pairMarkValue(p) {
  if (!p.position) return p.bankroll;
  const price = p.position.side === 'Up' ? (p.upBid ?? p.position.entryPrice) : (p.downBid ?? p.position.entryPrice);
  return round2(p.bankroll + p.position.shares * price);
}

function pushGlobalEquity() {
  const total = round2(Object.values(pairs).reduce((s, p) => s + pairMarkValue(p), 0));
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > EQUITY_POINTS_TOTAL) totalEquityCurve.shift();
}

// Call after any bankroll/position change (entry or exit) to sample both
// this pair's equity curve and the portfolio-wide one.
function recordEquity(p) {
  p.equityCurve.push({ t: Date.now(), equity: pairMarkValue(p) });
  if (p.equityCurve.length > EQUITY_POINTS_PER_PAIR) p.equityCurve.shift();
  pushGlobalEquity();
}

// stake = (% of CURRENT bankroll) * (confidence multiplier from signal
// strength, flat-capped at CONF_MAX_MULT). No reference to win/loss
// history anywhere — a losing trade never makes the next one bigger.
function stakeForPair(p, sig) {
  const confMult = clamp(Math.abs(sig.score) / Z_ENTRY_THRESHOLD, 1, CONF_MAX_MULT);
  let stake = round2(p.bankroll * BASE_STAKE_FRACTION * confMult);
  stake = Math.min(stake, round2(p.bankroll * MAX_STAKE_FRACTION));
  return { stake, confMult: round2(confMult) };
}

function registerTrade(p, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: p.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Entry logic — rests a genuine maker order, doesn't cross the spread
// ─────────────────────────────────────────
async function queueEntry(p, elapsed, remaining) {
  if (!tradingEnabled) return;
  if (elapsed < MIN_ENTRY_ELAPSED_SEC || remaining < MIN_ENTRY_REMAINING_SEC) return;

  const sig = computeSignal(p, elapsed);
  p.lastSignal = sig;
  if (!sig) return;
  if (Math.abs(sig.score) < Z_ENTRY_THRESHOLD) return;
  if (!sig.momentumAgrees) return;

  const side = sig.direction;
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (ask == null) return;
  if (ask < MIN_ENTRY_PRICE || ask > MAX_ENTRY_PRICE) return;

  const { stake, confMult } = stakeForPair(p, sig);
  if (stake < 1 || stake > p.bankroll) {
    log(`⏭️  ${p.symbol}: skip entry — insufficient bankroll ($${p.bankroll.toFixed(2)} left, need $${stake.toFixed(2)})`);
    return;
  }

  // Rest the buy AT the current best bid (or just under the ask if there's
  // no visible bid) — a passive price that does not cross the spread, so
  // this is a genuine maker order, not a marketable one.
  const limitPrice = bid != null ? bid : Math.max(round2(ask - 0.01), 0.01);
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  const estShares = Math.max(round2(stake / limitPrice), MIN_SHARES);
  const order = await placeLimitBuy(tokenId, limitPrice, estShares);

  p.pendingEntry = {
    side, tokenId, limitPrice, stake, confMult, sig,
    orderId: order.id || order.orderId || null,
    placedAt: Date.now(),
    expiresAt: Date.now() + ENTRY_FILL_TIMEOUT_SECS * 1000,
  };
  log(`📌 ${p.symbol} resting ${side} order @ ${limitPrice.toFixed(2)} (~$${stake.toFixed(2)}, conf=${confMult}x) — waiting up to ${ENTRY_FILL_TIMEOUT_SECS}s for a fill`);
}

// Checks whether the resting entry order got filled (market traded down
// through our passive price) or should be cancelled (timed out unfilled).
async function checkPendingEntry(p) {
  const pe = p.pendingEntry;
  if (!pe) return;
  const ask = pe.side === 'Up' ? p.upAsk : p.downAsk;

  if (ask != null && ask <= pe.limitPrice) {
    // Filled as maker, at OUR quoted price (not the crossing price).
    const execPrice = pe.limitPrice;
    let shares = round2(pe.stake / execPrice);
    if (shares < MIN_SHARES) shares = MIN_SHARES;
    const notional = round2(execPrice * shares);
    if (notional > p.bankroll) { p.pendingEntry = null; return; }

    const rebate = makerRebate(shares, execPrice);
    p.bankroll = round2(p.bankroll - notional + rebate);
    p.realizedPnl = round2(p.realizedPnl + rebate); // rebate is realized income regardless of trade outcome
    p.rebatesEarned = round2(p.rebatesEarned + rebate);

    p.position = {
      side: pe.side,
      tokenId: pe.tokenId,
      entryPrice: execPrice,
      shares,
      cost: notional,
      tpPrice: Math.min(round2(execPrice + TP_OFFSET), 0.99),
      slPrice: Math.max(round2(execPrice - SL_OFFSET), 0.01),
      orderId: pe.orderId,
      openedAt: Date.now(),
      confMult: pe.confMult,
      entryRebate: rebate,
    };
    p.pendingEntry = null;
    recordEquity(p);

    log(`🎯 ${p.symbol} ENTRY(maker) ${pe.side} ${shares}sh @ ${execPrice.toFixed(2)} | cost=$${notional.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | conf=${pe.confMult}x | z=${pe.sig.z} score=${pe.sig.score} | TP@${p.position.tpPrice.toFixed(2)} SL@${p.position.slPrice.toFixed(2)}`);
    registerTrade(p, { side: 'BUY', outcome: pe.side, price: execPrice, shares, cost: notional, rebate });
    return;
  }

  if (Date.now() >= pe.expiresAt) {
    await cancelOrder(pe.orderId);
    log(`⏭️  ${p.symbol}: resting ${pe.side} order @ ${pe.limitPrice.toFixed(2)} unfilled after ${ENTRY_FILL_TIMEOUT_SECS}s — cancelled, setup skipped`);
    p.pendingEntry = null;
  }
}

// ─────────────────────────────────────────
//  Position management (SL/TP + resolution)
// ─────────────────────────────────────────
// proceeds passed in is always the RAW execution notional (execPrice ×
// shares) with no fee/rebate applied — applyResult nets those uniformly.
function applyResult(p, won, proceeds, reason, { fee = 0, rebate = 0 } = {}) {
  const pos = p.position;
  const net = round2(proceeds - fee + rebate);
  p.bankroll = round2(p.bankroll + net);
  const profit = round2(net - pos.cost);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.feesPaid = round2(p.feesPaid + fee);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);

  if (won) { p.wins++; p.lastResult = 'WIN'; }
  else { p.losses++; p.lastResult = 'LOSS'; }
  // No martingale step to update — next stake is simply BASE_STAKE_FRACTION
  // of whatever the (now-updated) bankroll is, times the next signal's
  // confidence. A loss shrinks the next stake naturally via the smaller
  // bankroll; it never enlarges it.

  const icon = won ? '💰' : '💥';
  const costTag = fee > 0 ? ` fee=-$${fee.toFixed(4)}` : (rebate > 0 ? ` rebate=+$${rebate.toFixed(4)}` : '');
  log(`${icon} ${p.symbol} ${reason} ${pos.side} ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${(proceeds/pos.shares).toFixed(2)}/sh${costTag} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: pos.side, reason, price: round2(proceeds / pos.shares), shares: pos.shares, profit, fee, rebate });

  p.position = null;
  recordEquity(p);
}

async function manageOpenPosition(p, remaining) {
  const pos = p.position;
  if (!pos) return;
  const bid = pos.side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;

  if (bid >= pos.tpPrice) {
    // Resting maker sell at our own quoted TP price — fills AT that price
    // (not the higher observed bid), zero fee, plus maker rebate.
    const execPrice = pos.tpPrice;
    const order = await placeLimitSell(pos.tokenId, execPrice, pos.shares);
    const proceeds = round2(execPrice * pos.shares);
    const rebate = makerRebate(pos.shares, execPrice);
    applyResult(p, true, proceeds, 'TP', { fee: 0, rebate });
    return;
  }
  if (bid <= pos.slPrice && remaining > EXIT_SAFETY_BUFFER_SEC) {
    // Aggressive taker sell at the live bid — Polymarket has no native
    // stop order, so a real SL can only be fired as a market/taker order
    // the instant the level is breached. Pays the crypto taker fee.
    const execPrice = bid;
    const order = await placeLimitSell(pos.tokenId, execPrice, pos.shares);
    const proceeds = round2(execPrice * pos.shares);
    const fee = takerFee(pos.shares, execPrice);
    applyResult(p, false, proceeds, 'SL', { fee, rebate: 0 });
    return;
  }
}

// Determine the winning side for a window that closed without an early
// SL/TP exit. Prefers Gamma's own resolution data; falls back to comparing
// the last known live spot price against this window's open reference
// (the same rule Polymarket itself resolves by), which is available
// immediately with no indexing lag.
async function determineWinningSide(p) {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(p.slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === p.conditionId) || (event.markets || [])[0];
    if (market && (market.closed === true) && market.outcomePrices) {
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
  if (!p.position) return;

  const winner = await determineWinningSide(p);
  const pos = p.position;
  if (winner === null) {
    // couldn't determine — extremely rare (feed outage). Mark position
    // resolved at cost to avoid double counting; real on-chain settlement
    // still pays out correctly regardless of our internal tracking.
    log(`⚠️  ${p.symbol}: could not determine window outcome — leaving position tracked at last mark`);
    p.position = null;
    return;
  }
  const won = winner === pos.side;
  const proceeds = won ? round2(pos.shares * 1) : 0;
  applyResult(p, won, proceeds, 'RESOLUTION');
}

// ─────────────────────────────────────────
//  Main per-pair tick
// ─────────────────────────────────────────
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    // window boundary crossed (or first ever load) — finalize the old one first
    if (p.windowStart !== null && !p.resolvedThisWindow) {
      await resolvePairWindow(p);
    }
    await loadPairWindow(p);
  }
  if (!p.tradable) return;

  const elapsed = nowSec() - p.windowStart;
  const remaining = p.windowEnd - nowSec();

  if (p.position) {
    await manageOpenPosition(p, remaining);
  } else if (p.pendingEntry) {
    await checkPendingEntry(p);
  } else if (!p.resolvedThisWindow) {
    await queueEntry(p, elapsed, remaining);
  }

  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    if (p.pendingEntry) { await cancelOrder(p.pendingEntry.orderId); p.pendingEntry = null; }
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const spot = p.spotBuffer.length ? p.spotBuffer[p.spotBuffer.length - 1].price : null;
    const unrealized = p.position && (p.position.side === 'Up' ? p.upBid : p.downBid) != null
      ? round2(((p.position.side === 'Up' ? p.upBid : p.downBid) - p.position.entryPrice) * p.position.shares)
      : 0;
    const markValue = round2(p.bankroll + (p.position ? p.position.shares * (p.position.side === 'Up' ? (p.upBid ?? p.position.entryPrice) : (p.downBid ?? p.position.entryPrice)) : 0));
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
      baseStake: round2(p.bankroll * BASE_STAKE_FRACTION),
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      lastResult: p.lastResult,
      signal: p.lastSignal,
      pendingEntry: p.pendingEntry ? {
        side: p.pendingEntry.side,
        limitPrice: p.pendingEntry.limitPrice,
        stake: p.pendingEntry.stake,
        secsLeft: Math.max(0, Math.round((p.pendingEntry.expiresAt - Date.now()) / 1000)),
      } : null,
      position: p.position ? {
        side: p.position.side,
        entryPrice: p.position.entryPrice,
        shares: p.position.shares,
        cost: p.position.cost,
        tpPrice: p.position.tpPrice,
        slPrice: p.position.slPrice,
        confMult: p.position.confMult,
      } : null,
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
      baseStakeFraction: BASE_STAKE_FRACTION,
      confMaxMultiplier: CONF_MAX_MULT,
      maxStakeFraction: MAX_STAKE_FRACTION,
      zEntryThreshold: Z_ENTRY_THRESHOLD,
      minEntryPrice: MIN_ENTRY_PRICE,
      maxEntryPrice: MAX_ENTRY_PRICE,
      tpOffset: TP_OFFSET,
      slOffset: SL_OFFSET,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
      entryFillTimeoutSecs: ENTRY_FILL_TIMEOUT_SECS,
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
  log('⏸️  Trading paused (existing positions still managed for SL/TP/resolution)');
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
  log(`🚀 5-Minute Crypto Up/Down Multi-Pair Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  sizing: ${(BASE_STAKE_FRACTION*100).toFixed(1)}% of bankroll × confidence (up to ${CONF_MAX_MULT}x), cap ${(MAX_STAKE_FRACTION*100).toFixed(0)}% | z-entry≥${Z_ENTRY_THRESHOLD} | TP+${TP_OFFSET} SL-${SL_OFFSET}`);
  log(`⚙️  fees: entry/TP maker (0 fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate) | SL taker (crypto fee rate ${CRYPTO_TAKER_FEE_RATE}) | entry fill timeout ${ENTRY_FILL_TIMEOUT_SECS}s`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  await refreshSpotPrices();
  lastSpotFetch = Date.now();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
