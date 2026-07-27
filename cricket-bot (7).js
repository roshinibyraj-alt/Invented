'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 5-MINUTE "PRICE-DIP" RESTING-LIMIT (MAKER) ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 *  Only BTC's 5-minute Up/Down market trades. ETH and BTC's 15-min
 *  market are not touched at all.
 *
 *  Up and Down are two fully independent trigger loops running against
 *  the SAME 5-minute window's order book:
 *
 *   UP SIDE   — every 20 seconds, compare the current Up ask to the Up
 *               ask price recorded ~20 seconds earlier. If it has
 *               dropped by 0.05 or more, place a limit buy on UP at
 *               the current Up ask, base size 10 shares.
 *
 *   DOWN SIDE — mirrors the Up logic, but on its own 40-second clock,
 *               comparing the current Down ask to the Down ask from
 *               ~40 seconds earlier, base size 20 shares.
 *
 *  Both loops run for the entire life of every 5-minute window — not a
 *  once-per-window decision. Every check that meets the drop condition
 *  places another order (subject to the per-window fill cap below).
 *
 *  ── ORDER TYPE: RESTING GTC LIMIT (MAKER), NOT FOK ──
 *  Every entry is placed as a GTC limit order at the ask price observed
 *  at trigger time — it is NOT sent as fill-or-kill. Because prices are
 *  sampled on a rolling 20s/40s interval, by the time the order reaches
 *  the book the live ask has often already moved away from the price we
 *  quoted, so the order rests below the touch instead of matching
 *  instantly. It sits on the book until either (a) price later trades
 *  back down through that level, filling it as a maker order at its own
 *  resting price, or (b) the window closes, at which point any
 *  still-unfilled order is treated as expired.
 *
 *  FILL CONFIRMATION: every tick, every resting order is checked against
 *  the freshest live ask on its side. Once the live ask has crossed down
 *  to or through the order's limit price ("price went through the order
 *  price"), that's treated as the fill signal:
 *    - LIVE mode: trader.reconcileToken(tokenId) is polled to get the
 *      real fill confirmation (filledShares/avgPrice) from the exchange
 *      before the position is recorded — a crossed quote is a trigger to
 *      check, not proof of fill by itself.
 *    - DEMO mode: the crossing itself is treated as the fill, at the
 *      order's own limit price (accounting is against real book data,
 *      execution is simulated).
 *
 *  FEES / REBATES: maker orders pay Polymarket's Crypto-category maker
 *  fee rate of 0% — there is no fee on any fill here. Because they add
 *  liquidity, filled orders also earn an estimated Maker Rebate. Per
 *  Polymarket's published Crypto-category rebate model:
 *    fee_equivalent = shares × 0.07 × price × (1 - price)
 *    estimated rebate = fee_equivalent × 20%   (Crypto's rebate share —
 *      the lowest of any category; most others pay 25%)
 *  Replaying a real ~4.7hr / 343-fill session under this model vs. the
 *  old FOK-taker model turned +$55.02 net into +$123.81 net — removing
 *  the fee and adding the rebate roughly doubled realized P&L on
 *  identical entries. Source: docs.polymarket.com/market-makers/maker-rebates
 *
 *  ── POST-ANALYSIS TUNING (added after reviewing a live demo session) ──
 *  A 56-window / 343-fill sample showed UP entries losing money at
 *  every drop-size bucket tested (-$144.59 total) while DOWN entries
 *  were consistently profitable (+$199.61 total), asks below ~0.08 had
 *  a ~5% win rate, and windows with 6-8 stacked same-side fills carried
 *  outsized risk. Rather than hardcoding "DOWN good, UP bad" — which
 *  could flip if BTC's trend reverses — three general-purpose safeguards
 *  were added:
 *    1. ADAPTIVE SIZING — each side's order size scales with its own
 *       trailing ROI (last ADAPTIVE_LOOKBACK settled fills), so a side
 *       that's actually working gets sized up (to ADAPTIVE_MAX_MULT×)
 *       and one that's actually losing gets sized down (to
 *       ADAPTIVE_MIN_MULT×), automatically, in either direction.
 *    2. MIN_ENTRY_PRICE — skips firing when the ask is below this floor
 *       (default 0.08), where fills are overwhelmingly longshots that
 *       just keep falling rather than genuine mean-reversion.
 *    3. MAX_FILLS_PER_WINDOW — caps how many resting+filled orders one
 *       side can accumulate in a single window, so a real trend can't
 *       get averaged into 6-8 times before the window closes.
 *  A fourth addition, rolling per-side win-rate/ROI/multiplier, is
 *  exposed in buildState() for the dashboard so this can be watched
 *  live instead of inferred from logs after the fact.
 *
 *  RESOLUTION: unchanged, three tiers, fastest available wins:
 *    1. Official — Polymarket Gamma's `closed` + `outcomePrices`.
 *    2. High-confidence live price — either side crossing HIGH_CONF_PRICE
 *       (default 0.90) is treated as the de-facto winner immediately.
 *    3. Live-price fallback — if neither resolves within
 *       RESOLUTION_FALLBACK_MS after close, use whichever side has the
 *       higher live price.
 *  Every filled position in that window (both Up and Down, however many
 *  fired) settles against the same single winner; the window's combined
 *  P&L is the sum of every filled position's individual P&L (rebates
 *  are tracked separately, not folded into combinedPnl).
 *
 *  STARTUP: if started mid-window, waits for the next fresh 5-minute
 *  boundary before opening any trade — never joins a window partway
 *  through.
 *
 *  TRADER INTERFACE (assumed — adjust method names in this file if your
 *  polymarket-trader.js differs):
 *    trader.placeLimitOrder(tokenId, side, price, size) -> { id, isFilled, avgPrice, raw }   [GTC]
 *    trader.reconcileToken(tokenId)                     -> { filledShares, avgPrice, orderId } | null
 *    trader.cancelOrder(orderId)                         -> optional, best-effort at window close
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS             = 500;
const PRICE_REFRESH_MS    = 1000;
const DISCOVERY_RETRY_MS  = 2000;
const RESOLUTION_POLL_MS  = 3000;
const RESOLUTION_FALLBACK_MS = Number(process.env.RESOLUTION_FALLBACK_MS || 60000);

const WINDOW_SECONDS = 300; // 5-minute window duration
const SLUG_PREFIX = 'btc-updown-5m-';
const ASSET_KEY = 'btc';
const ASSET_LABEL = 'BTC';

// ── Up-side trigger: every 20s, buy UP if the Up ask dropped >=0.05
//    since the previous 20s check.
const UP_CHECK_INTERVAL_MS = Number(process.env.DIP_UP_INTERVAL_MS || 20000);
const UP_DROP_THRESHOLD    = Number(process.env.DIP_UP_DROP || 0.05);
const UP_BASE_SHARES       = Number(process.env.DIP_UP_SHARES || 10);

// ── Down-side trigger: mirrors Up, but every 40s and sized at 20 shares.
const DOWN_CHECK_INTERVAL_MS = Number(process.env.DIP_DOWN_INTERVAL_MS || 40000);
const DOWN_DROP_THRESHOLD    = Number(process.env.DIP_DOWN_DROP || 0.05);
const DOWN_BASE_SHARES       = Number(process.env.DIP_DOWN_SHARES || 20);

// ── Post-analysis safeguards (see header comment) ──
// Skip firing when the ask is below this — historically a ~5% win-rate zone.
const MIN_ENTRY_PRICE = Number(process.env.DIP_MIN_ENTRY_PRICE || 0.08);
// Cap on resting+filled orders one side can hold in a single window.
const MAX_FILLS_PER_WINDOW = Number(process.env.DIP_MAX_FILLS_PER_WINDOW || 4);
// Adaptive per-side sizing off trailing ROI.
const ADAPTIVE_SIZING_ENABLED = (process.env.DIP_ADAPTIVE_SIZING || 'true').toLowerCase() === 'true';
const ADAPTIVE_LOOKBACK  = Number(process.env.DIP_ADAPTIVE_LOOKBACK || 20);
const ADAPTIVE_MIN_SAMPLE = Number(process.env.DIP_ADAPTIVE_MIN_SAMPLE || 5); // stay neutral (1x) until this many settled fills exist
const ADAPTIVE_MIN_MULT  = Number(process.env.DIP_ADAPTIVE_MIN_MULT || 0.5);
const ADAPTIVE_MAX_MULT  = Number(process.env.DIP_ADAPTIVE_MAX_MULT || 1.5);

// Polymarket's live minimum order size on these crypto Up/Down markets
// (confirmed via Gamma: orderMinSize: 5) — any order under this is rejected.
const MIN_ORDER_SHARES = Number(process.env.HEDGE_MIN_ORDER_SHARES || 5);

let DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const STARTING_CAPITAL = Number(process.env.HEDGE_CAPITAL || 2000);

// ── Fees / Maker Rebates (Polymarket Crypto category, per published docs) ──
// Makers pay 0% — every fill here is a maker fill, so no fee is ever
// charged. The taker-fee rate below is NOT charged to us; it's only used
// as an input to the rebate formula (the rebate pool is funded by taker
// fees, and a maker's rebate is computed off the same fee-equivalent
// curve). MAKER_REBATE_SHARE is Crypto's cut of that pool (20% — the
// lowest of any category; most others pay 25%).
const MAKER_FEE_RATE        = 0;
const CRYPTO_TAKER_FEE_RATE = Number(process.env.HEDGE_TAKER_FEE_RATE || 0.07);
const MAKER_REBATE_SHARE    = Number(process.env.HEDGE_MAKER_REBATE_SHARE || 0.20);

const MAX_PENDING_RESOLUTIONS = 40;

// If price crosses this threshold (or its complement) in the live book, treat that side as the
// de-facto winner immediately instead of waiting for RESOLUTION_FALLBACK_MS.
const HIGH_CONF_PRICE = Number(process.env.RESOLUTION_HIGH_CONF_PRICE || 0.90);

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
// Polymarket's own fee-curve formula, applied at the 20% Crypto maker-
// rebate share to estimate what a filled maker order earns back.
function estimateMakerRebate(shares, price) {
  if (MAKER_REBATE_SHARE <= 0) return 0;
  const feeEquivalent = shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price);
  return round4(feeEquivalent * MAKER_REBATE_SHARE);
}
function sgn2(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

let emitFn = () => {};
let slog = () => {};
let trader = null;
let warnedNoRestingMethod = false;
let tradeSeq = 0;

const engine = {
  tradingEnabled: true,
  bankroll: STARTING_CAPITAL,
  capital: STARTING_CAPITAL,
  realizedPnl: 0,
  estimatedRebates: 0,
  wins: 0, losses: 0,
  current: { btc: null }, // active window trade, not yet closed out
  pending: [],            // windows whose 5-min period has closed, awaiting resolution
  history: [],            // resolved windows, most recent first
  logs: [],
  trades: [],
  equityCurve: [{ t: Date.now(), equity: STARTING_CAPITAL }],
  lastPriceFetch: 0,
  lastResolutionPoll: 0,
  waitingForBoundary: true,
  boundaryWindowTs: null,
  // Rolling per-side settled-fill history for adaptive sizing (oldest first, capped at ADAPTIVE_LOOKBACK).
  sideStats: { up: [], down: [] },
};

// ─────────────────────────────────────────
//  Logging / bookkeeping
// ─────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  engine.logs.push(line);
  if (engine.logs.length > 500) engine.logs.shift();
  slog(`[hedgebot] ${line}`);
}
function registerTrade(t) {
  const trade = { seq: ++tradeSeq, time: new Date().toISOString().slice(11, 19), ...t };
  engine.trades.push(trade);
  if (engine.trades.length > 300) engine.trades.shift();
}
function recordEquity() {
  engine.equityCurve.push({ t: Date.now(), equity: round2(engine.bankroll + openPositionsMTM()) });
  if (engine.equityCurve.length > 1000) engine.equityCurve.shift();
}

// ─────────────────────────────────────────
//  Adaptive sizing — scales each side's order size by its own trailing
//  ROI over the last ADAPTIVE_LOOKBACK settled fills. Neutral (1x) until
//  ADAPTIVE_MIN_SAMPLE fills exist, then clamped to
//  [ADAPTIVE_MIN_MULT, ADAPTIVE_MAX_MULT]. Self-corrects in either
//  direction — it does not assume either side has a permanent edge.
// ─────────────────────────────────────────
function recordSideResult(side, pnl, cost, win) {
  const hist = engine.sideStats[side];
  hist.push({ pnl, cost, win });
  if (hist.length > ADAPTIVE_LOOKBACK) hist.shift();
}
function sideRollingStats(side) {
  const hist = engine.sideStats[side];
  if (!hist.length) return { n: 0, winRate: null, roi: null, multiplier: 1 };
  const totalCost = hist.reduce((s, h) => s + h.cost, 0);
  const totalPnl = hist.reduce((s, h) => s + h.pnl, 0);
  const winRate = hist.filter(h => h.win).length / hist.length;
  const roi = totalCost > 0 ? totalPnl / totalCost : 0;
  const multiplier = (ADAPTIVE_SIZING_ENABLED && hist.length >= ADAPTIVE_MIN_SAMPLE)
    ? clamp(round2(1 + roi), ADAPTIVE_MIN_MULT, ADAPTIVE_MAX_MULT)
    : 1;
  return { n: hist.length, winRate: round2(winRate), roi: round4(roi), multiplier };
}
function sideMultiplier(side) { return sideRollingStats(side).multiplier; }

// ─────────────────────────────────────────
//  HTTP / order helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-hedgebot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
function describeOrderError(e) {
  const parts = [e?.message || String(e)];
  const extra = e?.response?.data ?? e?.data ?? e?.body ?? null;
  if (extra) { try { parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (_) {} }
  return parts.join(' | ');
}
function traderHasRestingOrderMethods() {
  const ok = trader && typeof trader.placeLimitOrder === 'function';
  if (!ok && !warnedNoRestingMethod) {
    warnedNoRestingMethod = true;
    slog('[hedgebot] ❌ LIVE trading needs trader.placeLimitOrder(tokenId, side, price, size) [GTC] on polymarket-trader.js — LIVE order placement will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}

// Places a resting GTC limit buy at exactly the quoted price — no book-
// walking, no slippage margin, since this is a passive maker order, not
// a marketable taker sweep. Returns filledNow=true only in the rare case
// the exchange reports an instant match at placement (e.g. the market
// ticked down right as the order landed); otherwise the order is left
// resting and fill confirmation happens later via checkPendingOrders().
async function placeRestingLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasRestingOrderMethods()) return null;
    try {
      const resp = await trader.placeLimitOrder(tokenId, 'BUY', price, shares);
      return {
        id: resp?.id || null,
        filledNow: !!resp?.isFilled,
        avgPrice: resp?.avgPrice || price,
        filledShares: resp?.isFilled ? shares : 0,
      };
    } catch (e) {
      log(`❌ placeRestingLimitBuy failed: ${describeOrderError(e)}`);
      return null;
    }
  }
  // DEMO: also modeled as resting, not instantly filled — fill
  // confirmation follows the same "price crossed through" path as LIVE.
  return { id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filledNow: false, avgPrice: price, filledShares: 0 };
}

let warnedNoCancelMethod = false;
// Best-effort cancel of a still-resting order at window close. Not fatal
// if the trader class doesn't support it — Polymarket force-cancels
// resting orders on a closed market on its own either way.
async function cancelRestingOrder(orderId) {
  if (DRY_RUN || !orderId) return;
  if (!trader || typeof trader.cancelOrder !== 'function') {
    if (!warnedNoCancelMethod) { warnedNoCancelMethod = true; slog('[hedgebot] ⚠️  trader.cancelOrder not implemented — expired resting orders will just be left for Polymarket to auto-cancel at market close.'); }
    return;
  }
  try { await trader.cancelOrder(orderId); } catch (e) { log(`⚠️  cancelRestingOrder(${orderId}) failed: ${e.message}`); }
}

function parseMarketTokens(mk) {
  try {
    const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
    const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}

// ─────────────────────────────────────────
//  Leg — the one BTC 5-min Up/Down market for a given window.
// ─────────────────────────────────────────
function freshLeg(windowTs) {
  return {
    slug: `${SLUG_PREFIX}${windowTs}`,
    windowTs, windowSeconds: WINDOW_SECONDS,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    conditionId: null, upTokenId: null, downTokenId: null,
    upAsk: null, downAsk: null, upBid: null, downBid: null,
    discovered: false,
    lastDiscoveryAttempt: 0,
    highConfSide: null, highConfPrice: null,
    highConfCandidateSide: null, highConfCandidateCount: 0,
    resolved: false, winner: null, resolutionMethod: null,
  };
}

async function discoverLeg(leg) {
  try {
    const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(leg.slug)}`);
    const event = Array.isArray(events) ? events[0] : null;
    if (!event) return;
    const mk = (event.markets || [])[0];
    if (!mk) return;
    const tokens = parseMarketTokens(mk);
    const up = tokens.find(t => /up/i.test(t.outcome));
    const down = tokens.find(t => /down/i.test(t.outcome));
    if (!up || !down || !up.token_id || !down.token_id) return;
    leg.conditionId = mk.conditionId || null;
    leg.upTokenId = up.token_id;
    leg.downTokenId = down.token_id;
    leg.discovered = true;
    log(`🎯 leg discovered ${leg.slug} — Up ${String(up.token_id).slice(0, 10)}… / Down ${String(down.token_id).slice(0, 10)}…`);
  } catch (e) {
    log(`⚠️  discoverLeg(${leg.slug}) failed: ${e.message}`);
  }
}

async function refreshLegPrices(leg) {
  if (!leg.upTokenId || !leg.downTokenId) return;
  try {
    const [upAsk, upBid, downAsk, downBid] = await Promise.all([
      getJSON(`${CLOB}/price?token_id=${leg.upTokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${leg.upTokenId}&side=SELL`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${leg.downTokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${leg.downTokenId}&side=SELL`).catch(() => null),
    ]);
    if (upAsk?.price != null) leg.upAsk = parseFloat(upAsk.price);
    if (upBid?.price != null) leg.upBid = parseFloat(upBid.price);
    if (downAsk?.price != null) leg.downAsk = parseFloat(downAsk.price);
    if (downBid?.price != null) leg.downBid = parseFloat(downBid.price);
  } catch (_) {}
}

function markPrice(leg, side) {
  const bid = side === 'up' ? leg.upBid : leg.downBid;
  const ask = side === 'up' ? leg.upAsk : leg.downAsk;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return null;
}

function updateHighConfidence(leg) {
  if (leg.highConfSide) return;
  // Never evaluate high-confidence before the window has actually closed —
  // a mid-window price spike is normal noise, not a result.
  if (Date.now() < leg.closeAt) return;
  const upP = leg.upBid != null ? leg.upBid : leg.upAsk;
  const downP = leg.downBid != null ? leg.downBid : leg.downAsk;
  let candidate = null, candidatePrice = null;
  if (upP != null && upP >= HIGH_CONF_PRICE) { candidate = 'up'; candidatePrice = upP; }
  else if (downP != null && downP >= HIGH_CONF_PRICE) { candidate = 'down'; candidatePrice = downP; }
  if (!candidate) { leg.highConfCandidateSide = null; leg.highConfCandidateCount = 0; return; }
  // Require the same side to read >=HIGH_CONF_PRICE on two separate post-close
  // checks before locking it in, so a single noisy/stale tick can't decide it.
  if (leg.highConfCandidateSide === candidate) {
    leg.highConfCandidateCount = (leg.highConfCandidateCount || 0) + 1;
  } else {
    leg.highConfCandidateSide = candidate;
    leg.highConfCandidateCount = 1;
  }
  if (leg.highConfCandidateCount >= 2) {
    leg.highConfSide = candidate;
    leg.highConfPrice = candidatePrice;
  }
}

// Three-tier resolution for the leg. Returns true once resolved.
async function resolveLegAttempt(leg) {
  if (leg.resolved) return true;
  try {
    let mk = null;
    if (leg.conditionId) {
      const arr = await getJSON(`${GAMMA}/markets?condition_ids=${encodeURIComponent(leg.conditionId)}`);
      mk = Array.isArray(arr) ? arr[0] : null;
    }
    if (!mk) {
      const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(leg.slug)}`);
      const event = Array.isArray(events) ? events[0] : null;
      mk = event ? (event.markets || [])[0] : null;
    }
    if (mk && mk.closed === true && mk.outcomePrices) {
      const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : mk.outcomePrices;
      const tokens = parseMarketTokens(mk);
      const upIdx = tokens.findIndex(t => String(t.token_id) === String(leg.upTokenId));
      const downIdx = tokens.findIndex(t => String(t.token_id) === String(leg.downTokenId));
      if (upIdx >= 0 && downIdx >= 0 && prices[upIdx] != null) {
        leg.resolved = true;
        leg.winner = parseFloat(prices[upIdx]) >= 0.5 ? 'up' : 'down';
        leg.resolutionMethod = 'official';
        log(`🏁 [${leg.slug}] resolved OFFICIAL — winner ${leg.winner.toUpperCase()}`);
        return true;
      }
    }
  } catch (e) {
    log(`⚠️  resolveLegAttempt(${leg.slug}) failed: ${e.message}`);
  }

  updateHighConfidence(leg);
  if (leg.highConfSide) {
    leg.resolved = true;
    leg.winner = leg.highConfSide;
    leg.resolutionMethod = 'high-confidence-price';
    log(`⚡ [${leg.slug}] resolved HIGH-CONFIDENCE (${leg.highConfPrice.toFixed(3)}) — winner ${leg.winner.toUpperCase()}`);
    return true;
  }

  if (Date.now() - leg.closeAt >= RESOLUTION_FALLBACK_MS) {
    const upPrice = markPrice(leg, 'up');
    const downPrice = markPrice(leg, 'down');
    if (upPrice != null || downPrice != null) {
      let winner;
      if (upPrice != null && downPrice != null) winner = upPrice >= downPrice ? 'up' : 'down';
      else if (upPrice != null) winner = upPrice >= 0.5 ? 'up' : 'down';
      else winner = downPrice >= 0.5 ? 'down' : 'up';
      leg.resolved = true;
      leg.winner = winner;
      leg.resolutionMethod = 'price-fallback';
      log(`⌛ [${leg.slug}] resolved PRICE-FALLBACK — winner ${winner.toUpperCase()}`);
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────
//  Trade — one 5-minute window, holding two independent trigger
//  loops (Up @20s / Down @40s). Each can place resting limit orders
//  over the window's life, up to MAX_FILLS_PER_WINDOW per side; each
//  order sits in *Orders until it's filled (moves to *Positions) or
//  expires unfilled at window close.
// ─────────────────────────────────────────
function freshWatch() {
  return { lastCheckTs: null, prevAsk: null, checks: 0 };
}
function freshTrade(windowTs) {
  return {
    asset: ASSET_KEY, label: ASSET_LABEL, windowTs,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    leg: freshLeg(windowTs),
    state: 'discovering', // discovering -> trading -> pending-resolution -> resolved
    upOrders: [], downOrders: [],       // resting, unfilled
    upPositions: [], downPositions: [], // confirmed fills
    upWatch: freshWatch(),
    downWatch: freshWatch(),
    combinedPnl: null,
    settled: false,
  };
}

// Records a confirmed fill (from either an instant match at placement or
// a later crossing) as a position: debits cost, credits the estimated
// maker rebate immediately (real payouts are pooled/daily; crediting at
// fill time is this engine's approximation for live P&L tracking).
function confirmFill(trade, order, avgPrice, filledShares) {
  const cost = round2(filledShares * avgPrice);
  const rebate = estimateMakerRebate(filledShares, avgPrice);
  const position = { side: order.side, shares: filledShares, entryPrice: avgPrice, cost, rebate, filled: true, pnl: null, ts: Date.now(), orderId: order.id };

  engine.bankroll = round2(engine.bankroll - cost + rebate);
  engine.estimatedRebates = round2(engine.estimatedRebates + rebate);
  (order.side === 'up' ? trade.upPositions : trade.downPositions).push(position);

  registerTrade({ slug: trade.leg.slug, asset: trade.asset, step: order.side.toUpperCase() + ' maker fill', side: order.side, price: avgPrice, shares: filledShares, cost, rebate });
  log(`✅ [${trade.label} ${trade.leg.slug}] ${order.side.toUpperCase()} resting order FILLED — ${filledShares}sh @${avgPrice.toFixed(3)} ($${cost.toFixed(2)}, est. rebate +$${rebate.toFixed(4)}) | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

// Fires one resting limit-buy attempt on the given side.
async function fireEntry(trade, side, shares) {
  const leg = trade.leg;
  const price = side === 'up' ? leg.upAsk : leg.downAsk;
  const tokenId = side === 'up' ? leg.upTokenId : leg.downTokenId;
  if (price == null || tokenId == null) return;

  const resp = await placeRestingLimitBuy(tokenId, price, shares);
  if (!resp) { log(`❌ [${trade.label} ${leg.slug}] ${side.toUpperCase()} resting limit order failed to place`); return; }

  const order = { id: resp.id, side, tokenId, limitPrice: price, shares, placedAt: Date.now() };

  if (resp.filledNow && resp.filledShares > 0) {
    confirmFill(trade, order, resp.avgPrice, resp.filledShares);
    return;
  }

  (side === 'up' ? trade.upOrders : trade.downOrders).push(order);
  log(`🧾 [${trade.label} ${leg.slug}] ${side.toUpperCase()} resting limit buy placed (GTC, maker) — ${shares}sh @${price.toFixed(3)} — watching for fill`);
}

// Evaluates one side's rolling-interval dip check. First call after a
// window starts trading just seeds the baseline (nothing to compare
// against yet); every call after that, once intervalMs has elapsed since
// the last check, compares current ask to the ask recorded at that last
// check and fires if it dropped by >=dropThreshold — subject to the
// minimum-entry-price floor, the per-window fill cap, and adaptive sizing.
async function evaluateWatch(trade, watch, side, intervalMs, dropThreshold, baseShares, now) {
  const leg = trade.leg;
  const currentAsk = side === 'up' ? leg.upAsk : leg.downAsk;
  if (currentAsk == null) return;

  if (watch.lastCheckTs == null) {
    watch.lastCheckTs = now;
    watch.prevAsk = currentAsk;
    return;
  }
  if (now - watch.lastCheckTs < intervalMs) return;

  const prevAsk = watch.prevAsk;
  watch.lastCheckTs = now;
  watch.prevAsk = currentAsk;
  watch.checks++;
  if (prevAsk == null) return;

  const drop = round4(prevAsk - currentAsk);
  if (drop < dropThreshold) return;

  const label = `[${trade.label} ${leg.slug}] ${side.toUpperCase()}`;

  if (currentAsk < MIN_ENTRY_PRICE) {
    log(`🚫 ${label} dip trigger skipped — ask ${currentAsk.toFixed(3)} is below the $${MIN_ENTRY_PRICE.toFixed(2)} minimum entry floor (historically a poor win-rate zone)`);
    return;
  }

  const committed = (side === 'up' ? trade.upOrders.length + trade.upPositions.length : trade.downOrders.length + trade.downPositions.length);
  if (committed >= MAX_FILLS_PER_WINDOW) {
    log(`🚫 ${label} dip trigger skipped — already at the ${MAX_FILLS_PER_WINDOW}-order cap for this side this window`);
    return;
  }

  const mult = sideMultiplier(side);
  const shares = Math.max(MIN_ORDER_SHARES, Math.round(baseShares * mult));

  log(`📉 ${label} ask dropped ${drop.toFixed(3)} (${prevAsk.toFixed(3)} → ${currentAsk.toFixed(3)}) — firing ${shares}sh resting limit buy (base ${baseShares}sh × ${mult.toFixed(2)} adaptive)`);
  await fireEntry(trade, side, shares);
}

// Checks every still-resting order against the freshest live ask. Once
// price has traded down to or through an order's limit price, that's the
// fill signal — confirmed via trader.reconcileToken() in LIVE mode (a
// crossed quote is a trigger to check, not proof of fill by itself), or
// treated as the fill directly in DEMO mode.
async function checkPendingOrders(trade) {
  const leg = trade.leg;
  for (const list of [trade.upOrders, trade.downOrders]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const order = list[i];
      const currentAsk = order.side === 'up' ? leg.upAsk : leg.downAsk;
      if (currentAsk == null) continue;
      const crossed = currentAsk <= order.limitPrice + 1e-9;
      if (!crossed) continue;

      if (DRY_RUN) {
        confirmFill(trade, order, order.limitPrice, order.shares);
        list.splice(i, 1);
        continue;
      }

      if (!trader || typeof trader.reconcileToken !== 'function') continue; // nothing to confirm against; leave resting
      try {
        const rec = await trader.reconcileToken(order.tokenId);
        if (rec && rec.filledShares > 0) {
          confirmFill(trade, order, rec.avgPrice || order.limitPrice, rec.filledShares);
          list.splice(i, 1);
        }
        // else: quote crossed but the exchange hasn't confirmed a fill
        // yet — leave it resting and re-check next tick.
      } catch (e) {
        log(`⚠️  reconcileToken(${order.tokenId}) failed: ${e.message}`);
      }
    }
  }
}

// Best-effort expiry of anything still resting when a window ends —
// nothing to settle for these, they never became positions.
async function expireOpenOrders(trade) {
  for (const list of [trade.upOrders, trade.downOrders]) {
    for (const order of list) {
      log(`⌛ [${trade.label} ${trade.leg.slug}] ${order.side.toUpperCase()} resting order expired unfilled at window close — ${order.shares}sh @${order.limitPrice.toFixed(3)}`);
      await cancelRestingOrder(order.id);
    }
    list.length = 0;
  }
}

// ─────────────────────────────────────────
//  Unrealized P&L helpers
// ─────────────────────────────────────────
function unrealizedForPositions(leg, positions) {
  if (!leg || leg.resolved) return 0;
  return round2(positions.reduce((sum, p) => {
    if (!p.filled) return sum;
    const mp = markPrice(leg, p.side);
    const mark = mp != null ? mp : (p.cost / p.shares);
    return sum + (p.shares * mark - p.cost);
  }, 0));
}
function unrealizedForTrade(trade) {
  if (!trade) return 0;
  if (trade.state !== 'discovering' && trade.state !== 'trading' && trade.state !== 'pending-resolution') return 0;
  return round2(unrealizedForPositions(trade.leg, trade.upPositions) + unrealizedForPositions(trade.leg, trade.downPositions));
}
function openCostForTrade(trade) {
  if (!trade) return 0;
  const sum = positions => positions.reduce((s, p) => s + (p.filled ? p.cost : 0), 0);
  return round2(sum(trade.upPositions) + sum(trade.downPositions));
}
function allTrackedTrades() {
  const list = [...engine.pending];
  if (engine.current.btc) list.push(engine.current.btc);
  return list;
}
function totalUnrealizedPnl() {
  return round2(allTrackedTrades().reduce((sum, t) => sum + unrealizedForTrade(t), 0));
}
function openPositionsMTM() {
  return round2(allTrackedTrades().reduce((sum, t) => sum + openCostForTrade(t) + unrealizedForTrade(t), 0));
}

// ─────────────────────────────────────────
//  Settlement — every filled position (both sides, however many fired)
//  settles against the single window winner. Rebates were already
//  credited at fill time, so only the win/loss payout happens here.
//  Each settled position also feeds the rolling per-side stats used by
//  adaptive sizing.
// ─────────────────────────────────────────
function settleTrade(trade) {
  const leg = trade.leg;
  let combinedPnl = 0;
  const settleSide = (positions) => {
    for (const p of positions) {
      if (!p.filled) { p.pnl = 0; continue; }
      const win = p.side === leg.winner;
      const payout = win ? round2(p.shares * 1) : 0;
      p.pnl = round2(payout - p.cost); // no fee — maker fee rate is 0
      engine.bankroll = round2(engine.bankroll + payout);
      combinedPnl = round2(combinedPnl + p.pnl);
      recordSideResult(p.side, p.pnl, p.cost, win);
    }
  };
  settleSide(trade.upPositions);
  settleSide(trade.downPositions);

  trade.combinedPnl = combinedPnl;
  trade.state = 'resolved';
  trade.settled = true;
  engine.realizedPnl = round2(engine.realizedPnl + combinedPnl);
  if (combinedPnl >= 0) engine.wins++; else engine.losses++;

  const upShares = trade.upPositions.reduce((s, p) => s + p.shares, 0);
  const downShares = trade.downPositions.reduce((s, p) => s + p.shares, 0);
  const upPnl = round2(trade.upPositions.reduce((s, p) => s + (p.pnl || 0), 0));
  const downPnl = round2(trade.downPositions.reduce((s, p) => s + (p.pnl || 0), 0));
  const upRebate = round4(trade.upPositions.reduce((s, p) => s + (p.rebate || 0), 0));
  const downRebate = round4(trade.downPositions.reduce((s, p) => s + (p.rebate || 0), 0));

  registerTrade({ slug: leg.slug, asset: trade.asset, step: 'window resolution', side: leg.winner, price: 1, shares: upShares + downShares, pnl: combinedPnl });

  engine.history.unshift({
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, slug: leg.slug,
    winner: leg.winner, resolutionMethod: leg.resolutionMethod,
    upFills: trade.upPositions.length, downFills: trade.downPositions.length,
    upShares, downShares, upPnl, downPnl, upRebate, downRebate,
    combinedPnl, combinedRebate: round4(upRebate + downRebate), resolvedAt: Date.now(),
  });
  if (engine.history.length > 300) engine.history.pop();

  log(`🏆 [${trade.label} ${leg.slug}] window resolved — winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — ${trade.upPositions.length} UP fill(s) [${sgn2(upPnl)}] + ${trade.downPositions.length} DOWN fill(s) [${sgn2(downPnl)}] = ${sgn2(combinedPnl)} | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

// ─────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────
function currentWindowTs(nowSec) { return Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS; }

async function tickBtc(now) {
  const nowSec = Math.floor(now / 1000);
  const windowTs = currentWindowTs(nowSec);
  let trade = engine.current.btc;

  // Roll over to a fresh 5-minute window.
  if (!trade || trade.windowTs !== windowTs) {
    if (trade) {
      await expireOpenOrders(trade);
      if ((trade.upPositions.length || trade.downPositions.length) && !trade.settled) {
        trade.state = 'pending-resolution';
        engine.pending.push(trade);
        if (engine.pending.length > MAX_PENDING_RESOLUTIONS) {
          const dropped = engine.pending.shift();
          log(`⚠️  dropped stale pending window ${dropped.leg.slug} from the resolution queue (too many pending)`);
        }
      }
    }
    if (windowTs < engine.boundaryWindowTs) return; // haven't reached the first fresh boundary yet
    trade = freshTrade(windowTs);
    engine.current.btc = trade;
    log(`🆕 [BTC] new 5m window t=${windowTs} — discovering market…`);
  }

  // Discover the market for this window.
  if (!trade.leg.discovered && now - trade.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
    trade.leg.lastDiscoveryAttempt = now;
    await discoverLeg(trade.leg);
    if (trade.leg.discovered) trade.state = 'trading';
  }

  if (trade.state === 'trading') {
    // Run both independent dip-check loops while the window is still open.
    if (engine.tradingEnabled && now < trade.closeAt) {
      await evaluateWatch(trade, trade.upWatch, 'up', UP_CHECK_INTERVAL_MS, UP_DROP_THRESHOLD, UP_BASE_SHARES, now);
      await evaluateWatch(trade, trade.downWatch, 'down', DOWN_CHECK_INTERVAL_MS, DOWN_DROP_THRESHOLD, DOWN_BASE_SHARES, now);
    }
    // Fill confirmation runs regardless of tradingEnabled/closeAt — a
    // resting order already placed still needs to be watched for fills.
    await checkPendingOrders(trade);
  }
}

async function mainLoop() {
  while (true) {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);

      if (engine.waitingForBoundary) {
        if (engine.boundaryWindowTs == null) {
          engine.boundaryWindowTs = currentWindowTs(nowSec) + WINDOW_SECONDS;
          log(`⏳ started mid-window — waiting for next fresh 5-minute boundary (t=${engine.boundaryWindowTs}) before trading begins`);
        }
        if (nowSec >= engine.boundaryWindowTs) {
          engine.waitingForBoundary = false;
          log('🚦 new 5-minute boundary reached — trading starts now');
        }
      }

      if (!engine.waitingForBoundary) await tickBtc(now);

      if (now - engine.lastPriceFetch >= PRICE_REFRESH_MS) {
        engine.lastPriceFetch = now;
        const legs = allTrackedTrades().map(t => t.leg);
        await Promise.all(legs.map(refreshLegPrices));
        // NOTE: high-confidence evaluation intentionally does NOT happen here.
        // It only runs inside resolveLegAttempt (post-close, via the pending
        // resolution poll below) so it can never lock in a winner based on a
        // price read while the window is still open and trading.
      }

      if (engine.pending.length && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
        engine.lastResolutionPoll = now;
        const stillPending = [];
        for (const trade of engine.pending) {
          if (!trade.leg.resolved) await resolveLegAttempt(trade.leg);
          if (trade.leg.resolved && !trade.settled) settleTrade(trade);
          if (!trade.settled) stillPending.push(trade);
        }
        engine.pending = stillPending;
      }

      emitFn('hedgeState', buildState());
    } catch (e) {
      slog(`[hedgebot] ⚠️  Loop error: ${e.message}`);
    }
    await new Promise(res => setTimeout(res, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  UI state / controls
// ─────────────────────────────────────────
function legSummary(leg) {
  if (!leg) return null;
  return {
    slug: leg.slug, windowTs: leg.windowTs, closeAt: leg.closeAt,
    discovered: leg.discovered, upAsk: leg.upAsk, downAsk: leg.downAsk, upBid: leg.upBid, downBid: leg.downBid,
    highConfSide: leg.highConfSide, highConfPrice: leg.highConfPrice,
    resolved: leg.resolved, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
  };
}
function watchSummary(watch, intervalMs) {
  if (!watch) return null;
  const nextCheckInMs = watch.lastCheckTs == null ? null : Math.max(0, intervalMs - (Date.now() - watch.lastCheckTs));
  return { prevAsk: watch.prevAsk, checks: watch.checks, nextCheckInMs };
}
function tradeSummary(trade) {
  if (!trade) return null;
  return {
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, closeAt: trade.closeAt, state: trade.state,
    leg: legSummary(trade.leg),
    upWatch: watchSummary(trade.upWatch, UP_CHECK_INTERVAL_MS),
    downWatch: watchSummary(trade.downWatch, DOWN_CHECK_INTERVAL_MS),
    upOrders: trade.upOrders, downOrders: trade.downOrders,
    upPositions: trade.upPositions, downPositions: trade.downPositions,
    combinedPnl: trade.combinedPnl,
    unrealizedPnl: unrealizedForTrade(trade),
    upFillsUsed: trade.upOrders.length + trade.upPositions.length,
    downFillsUsed: trade.downOrders.length + trade.downPositions.length,
  };
}

function buildState() {
  const unrealizedPnl = totalUnrealizedPnl();
  const equity = round2(engine.bankroll + openPositionsMTM());
  return {
    dryRun: DRY_RUN,
    tradingEnabled: engine.tradingEnabled,
    waitingForBoundary: engine.waitingForBoundary,
    bankroll: engine.bankroll, capital: engine.capital,
    realizedPnl: engine.realizedPnl, unrealizedPnl, equity,
    estimatedRebates: engine.estimatedRebates,
    wins: engine.wins, losses: engine.losses,
    current: { btc: tradeSummary(engine.current.btc) },
    pendingResolutionCount: engine.pending.length,
    pending: engine.pending.map(tradeSummary),
    history: engine.history.slice(0, 60),
    trades: engine.trades.slice(-100).slice().reverse(),
    equityCurve: engine.equityCurve,
    logs: engine.logs.slice(-80),
    windowSeconds: WINDOW_SECONDS,
    upIntervalMs: UP_CHECK_INTERVAL_MS, upDropThreshold: UP_DROP_THRESHOLD, upBaseShares: UP_BASE_SHARES,
    downIntervalMs: DOWN_CHECK_INTERVAL_MS, downDropThreshold: DOWN_DROP_THRESHOLD, downBaseShares: DOWN_BASE_SHARES,
    makerFeeRate: MAKER_FEE_RATE, makerRebateShare: MAKER_REBATE_SHARE,
    minEntryPrice: MIN_ENTRY_PRICE, maxFillsPerWindow: MAX_FILLS_PER_WINDOW,
    adaptiveSizingEnabled: ADAPTIVE_SIZING_ENABLED,
    sideStats: {
      up: { ...sideRollingStats('up'), baseShares: UP_BASE_SHARES },
      down: { ...sideRollingStats('down'), baseShares: DOWN_BASE_SHARES },
    },
  };
}
function getStatus() { return buildState(); }

function pauseTrading() {
  engine.tradingEnabled = false;
  log('⏸️  Trading paused — no new resting orders will be placed; already-resting orders and open positions still tracked to fill/resolution, window discovery/rollover keeps running');
  return { ok: true };
}
function resumeTrading() {
  engine.tradingEnabled = true;
  log('▶️  Trading resumed');
  return { ok: true };
}
function setMode(live) {
  DRY_RUN = !live;
  log(`⚙️  Switched to ${live ? '🔴 LIVE' : '⚠️  DEMO'} mode`);
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  slog('[hedgebot] 🪙 BTC 5-Minute Price-Dip Engine (resting maker limit orders) — fully automatic');
  slog(`[hedgebot] ⚙️  UP: every ${UP_CHECK_INTERVAL_MS / 1000}s, place a resting limit buy UP at the current ask if it dropped >=${UP_DROP_THRESHOLD} vs the previous check. Base size ${UP_BASE_SHARES}sh, adaptively scaled.`);
  slog(`[hedgebot] ⚙️  DOWN: every ${DOWN_CHECK_INTERVAL_MS / 1000}s, place a resting limit buy DOWN at the current ask if it dropped >=${DOWN_DROP_THRESHOLD} vs the previous check. Base size ${DOWN_BASE_SHARES}sh, adaptively scaled. Independent of UP.`);
  slog(`[hedgebot] ⚙️  All orders are GTC resting limits (maker, 0% fee), not FOK — fills are confirmed once live price trades through the order's price.`);
  slog(`[hedgebot] ⚙️  Est. Maker Rebate: Crypto category pays back ${(MAKER_REBATE_SHARE * 100).toFixed(0)}% of shares×${CRYPTO_TAKER_FEE_RATE}×price×(1-price) per fill, per Polymarket's published fee-curve model — tracked separately from trading P&L.`);
  slog(`[hedgebot] ⚙️  Safeguards: min entry price $${MIN_ENTRY_PRICE.toFixed(2)} | max ${MAX_FILLS_PER_WINDOW} resting+filled orders per side per window | adaptive sizing ${ADAPTIVE_SIZING_ENABLED ? `ON (${ADAPTIVE_MIN_MULT}x-${ADAPTIVE_MAX_MULT}x off trailing ${ADAPTIVE_LOOKBACK}-fill ROI, neutral until ${ADAPTIVE_MIN_SAMPLE} fills)` : 'OFF'}.`);
  slog(`[hedgebot] ⚙️  Resolution: official Gamma > high-confidence live price (>=${HIGH_CONF_PRICE}) > ${Math.round(RESOLUTION_FALLBACK_MS / 1000)}s live-price fallback.`);
  slog(`[hedgebot] ⚙️  Starting bankroll $${STARTING_CAPITAL} | never joins a window it starts mid-way through`);
  if (UP_BASE_SHARES < MIN_ORDER_SHARES || DOWN_BASE_SHARES < MIN_ORDER_SHARES) {
    slog(`[hedgebot] ⚠️  UP_BASE_SHARES/DOWN_BASE_SHARES below Polymarket's ${MIN_ORDER_SHARES}sh minimum order size — those orders would be rejected. Raise them.`);
  }
  slog(`[hedgebot] ${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => slog(`[hedgebot] ❌ Fatal: ${e.message}`));
}

module.exports = {
  init,
  pauseTrading, resumeTrading,
  setMode,
  getStatus, buildState,
};
