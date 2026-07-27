'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 5-MINUTE "PRICE-DIP" ENGINE — WINNER-CHASING LOOPS
 * ═══════════════════════════════════════════════════════════════
 *
 *  Only BTC's 5-minute Up/Down market trades. ETH and BTC's 15-min
 *  market are not touched at all.
 *
 *  ── TWO INDEPENDENT LOOPS, DYNAMIC SIDE ──
 *  There are two permanent trigger configs — Loop A (20s interval,
 *  10sh base size, 0.05 drop threshold) and Loop B (40s interval, 20sh
 *  base size, 0.05 drop threshold). These configs never change. What
 *  changes is which side of the market each loop is currently pointed
 *  at ("up" or "down") — that's tracked as the loop's currentSide and
 *  can flip between windows.
 *
 *  Loop A starts on UP, Loop B starts on DOWN (matching the original
 *  fixed assignment). After every window resolves, each loop
 *  independently checks: did MY current side match the window's
 *  winner?
 *    - Matched (won)   → keep trading the same side next window.
 *    - Didn't match     → flip to the side that just won, for the
 *      (lost)             next window.
 *  "Loss" is decided purely by side-vs-winner, regardless of whether
 *  the loop actually had any fills that window.
 *
 *  Because there's only one winner per window, a loop sitting on the
 *  losing side always flips to match the winner — so in practice both
 *  loops tend to converge onto whichever side is currently winning,
 *  and flip together once that side eventually loses. They still
 *  decide independently (each runs its own check); it's the binary
 *  outcome that pulls them toward agreement over time.
 *
 *  Everything else about a loop travels with it across a flip, not
 *  reset: its 20-fill rolling ROI history, its adaptive size
 *  multiplier, its own watch/timer state. A loop's history is its own
 *  running record regardless of which side produced each fill.
 *
 *  ── ORDER TYPE: RESTING GTC LIMIT (MAKER), NOT FOK ──
 *  Every entry is placed as a GTC limit order at the ask price observed
 *  at trigger time — not fill-or-kill. It rests on the book until
 *  either price trades back down through that level (fills as a maker
 *  at its own resting price) or the window closes (expires unfilled).
 *
 *  FILL CONFIRMATION: every tick, every resting order is checked
 *  against the freshest live ask on its side. Once price has crossed
 *  down to or through the order's limit price, that's the fill signal:
 *    - LIVE: trader.reconcileToken(tokenId) confirms the real fill.
 *    - DEMO: the crossing itself is treated as the fill.
 *
 *  FEES / REBATES: 0% maker fee on every fill. Filled orders earn an
 *  estimated Maker Rebate per Polymarket's published Crypto-category
 *  model: fee_equivalent = shares × 0.07 × price × (1-price); estimated
 *  rebate = fee_equivalent × 20%. Tracked separately from trading P&L.
 *  Source: docs.polymarket.com/market-makers/maker-rebates
 *
 *  ── SAFEGUARDS (added after reviewing a live demo session) ──
 *    1. ADAPTIVE SIZING — each loop's order size scales with its own
 *       trailing ROI (last ADAPTIVE_LOOKBACK settled fills, neutral 1x
 *       until ADAPTIVE_MIN_SAMPLE fills exist), clamped to
 *       [ADAPTIVE_MIN_MULT, ADAPTIVE_MAX_MULT].
 *    2. MIN_ENTRY_PRICE — skips firing when the ask is below this floor
 *       (default 0.08) — historically a ~5% win-rate zone.
 *    3. MAX_FILLS_PER_WINDOW — caps how many resting+filled orders one
 *       loop can accumulate in a single window.
 *  Rolling per-loop win-rate/ROI/multiplier/current-side are exposed in
 *  buildState() for the dashboard.
 *
 *  RESOLUTION: unchanged, three tiers, fastest available wins:
 *    1. Official — Polymarket Gamma's `closed` + `outcomePrices`.
 *    2. High-confidence live price — either side crossing HIGH_CONF_PRICE
 *       (default 0.90) is treated as the de-facto winner immediately.
 *    3. Live-price fallback — if neither resolves within
 *       RESOLUTION_FALLBACK_MS after close, use whichever side has the
 *       higher live price.
 *  Every filled position from both loops settles against the same
 *  single winner; the window's combined P&L is the sum of every filled
 *  position's individual P&L (rebates tracked separately).
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

// ── Loop A: every 20s, buy the currently-assigned side if its ask
//    dropped >=0.05 since the previous 20s check. Starts on UP.
const LOOP_A_INTERVAL_MS = Number(process.env.DIP_UP_INTERVAL_MS || 20000);
const LOOP_A_DROP        = Number(process.env.DIP_UP_DROP || 0.05);
const LOOP_A_BASE_SHARES = Number(process.env.DIP_UP_SHARES || 10);
const LOOP_A_START_SIDE  = 'up';

// ── Loop B: mirrors Loop A, but every 40s, base 20 shares. Starts on DOWN.
const LOOP_B_INTERVAL_MS = Number(process.env.DIP_DOWN_INTERVAL_MS || 40000);
const LOOP_B_DROP        = Number(process.env.DIP_DOWN_DROP || 0.05);
const LOOP_B_BASE_SHARES = Number(process.env.DIP_DOWN_SHARES || 20);
const LOOP_B_START_SIDE  = 'down';

// ── Post-analysis safeguards ──
const MIN_ENTRY_PRICE = Number(process.env.DIP_MIN_ENTRY_PRICE || 0.08);
const MAX_FILLS_PER_WINDOW = Number(process.env.DIP_MAX_FILLS_PER_WINDOW || 4);
const ADAPTIVE_SIZING_ENABLED = (process.env.DIP_ADAPTIVE_SIZING || 'true').toLowerCase() === 'true';
const ADAPTIVE_LOOKBACK   = Number(process.env.DIP_ADAPTIVE_LOOKBACK || 20);
const ADAPTIVE_MIN_SAMPLE = Number(process.env.DIP_ADAPTIVE_MIN_SAMPLE || 5);
const ADAPTIVE_MIN_MULT   = Number(process.env.DIP_ADAPTIVE_MIN_MULT || 0.5);
const ADAPTIVE_MAX_MULT   = Number(process.env.DIP_ADAPTIVE_MAX_MULT || 1.5);

// Polymarket's live minimum order size on these crypto Up/Down markets
// (confirmed via Gamma: orderMinSize: 5) — any order under this is rejected.
const MIN_ORDER_SHARES = Number(process.env.HEDGE_MIN_ORDER_SHARES || 5);

let DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const STARTING_CAPITAL = Number(process.env.HEDGE_CAPITAL || 2000);

// ── Fees / Maker Rebates (Polymarket Crypto category, per published docs) ──
const MAKER_FEE_RATE        = 0;
const CRYPTO_TAKER_FEE_RATE = Number(process.env.HEDGE_TAKER_FEE_RATE || 0.07);
const MAKER_REBATE_SHARE    = Number(process.env.HEDGE_MAKER_REBATE_SHARE || 0.20);

const MAX_PENDING_RESOLUTIONS = 40;

// If price crosses this threshold (or its complement) in the live book, treat that side as the
// de-facto winner immediately instead of waiting for RESOLUTION_FALLBACK_MS.
const HIGH_CONF_PRICE = Number(process.env.RESOLUTION_HIGH_CONF_PRICE || 0.90);

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function estimateMakerRebate(shares, price) {
  if (MAKER_REBATE_SHARE <= 0) return 0;
  const feeEquivalent = shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price);
  return round4(feeEquivalent * MAKER_REBATE_SHARE);
}
function sgn2(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
const otherSide = (s) => (s === 'up' ? 'down' : 'up');

let emitFn = () => {};
let slog = () => {};
let trader = null;
let warnedNoRestingMethod = false;
let tradeSeq = 0;

// Loop identity/state lives at the engine level — it persists across
// window boundaries (unlike per-window trade state), since a loop's
// currentSide and rolling history are exactly what's supposed to carry
// through a flip.
const engine = {
  tradingEnabled: true,
  bankroll: STARTING_CAPITAL,
  capital: STARTING_CAPITAL,
  realizedPnl: 0,
  estimatedRebates: 0,
  wins: 0, losses: 0,
  current: { btc: null },
  pending: [],
  history: [],
  logs: [],
  trades: [],
  equityCurve: [{ t: Date.now(), equity: STARTING_CAPITAL }],
  lastPriceFetch: 0,
  lastResolutionPoll: 0,
  waitingForBoundary: true,
  boundaryWindowTs: null,
  loops: {
    A: { id: 'A', label: 'Loop A', intervalMs: LOOP_A_INTERVAL_MS, dropThreshold: LOOP_A_DROP, baseShares: LOOP_A_BASE_SHARES, currentSide: LOOP_A_START_SIDE, history: [] },
    B: { id: 'B', label: 'Loop B', intervalMs: LOOP_B_INTERVAL_MS, dropThreshold: LOOP_B_DROP, baseShares: LOOP_B_BASE_SHARES, currentSide: LOOP_B_START_SIDE, history: [] },
  },
};
const LOOP_IDS = ['A', 'B'];

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
//  Adaptive sizing — per LOOP, not per side. A loop's rolling history
//  belongs to it regardless of which side produced each fill, so it
//  carries straight through a side-flip.
// ─────────────────────────────────────────
function recordLoopResult(loopId, pnl, cost, win) {
  const hist = engine.loops[loopId].history;
  hist.push({ pnl, cost, win });
  if (hist.length > ADAPTIVE_LOOKBACK) hist.shift();
}
function loopRollingStats(loopId) {
  const hist = engine.loops[loopId].history;
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
function loopMultiplier(loopId) { return loopRollingStats(loopId).multiplier; }

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
  return { id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filledNow: false, avgPrice: price, filledShares: 0 };
}

let warnedNoCancelMethod = false;
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
  if (Date.now() < leg.closeAt) return;
  const upP = leg.upBid != null ? leg.upBid : leg.upAsk;
  const downP = leg.downBid != null ? leg.downBid : leg.downAsk;
  let candidate = null, candidatePrice = null;
  if (upP != null && upP >= HIGH_CONF_PRICE) { candidate = 'up'; candidatePrice = upP; }
  else if (downP != null && downP >= HIGH_CONF_PRICE) { candidate = 'down'; candidatePrice = downP; }
  if (!candidate) { leg.highConfCandidateSide = null; leg.highConfCandidateCount = 0; return; }
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
//  Trade — one 5-minute window, holding both loops' per-window state.
//  Each loop's SIDE for this window is locked in from
//  engine.loops[id].currentSide at the moment the window opens.
// ─────────────────────────────────────────
function freshWatch() {
  return { lastCheckTs: null, prevAsk: null, checks: 0 };
}
function freshLoopState(loopId) {
  return { side: engine.loops[loopId].currentSide, watch: freshWatch(), orders: [], positions: [] };
}
function freshTrade(windowTs) {
  return {
    asset: ASSET_KEY, label: ASSET_LABEL, windowTs,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    leg: freshLeg(windowTs),
    state: 'discovering', // discovering -> trading -> pending-resolution -> resolved
    loops: { A: freshLoopState('A'), B: freshLoopState('B') },
    combinedPnl: null,
    settled: false,
  };
}

function confirmFill(trade, loopId, order, avgPrice, filledShares) {
  const cost = round2(filledShares * avgPrice);
  const rebate = estimateMakerRebate(filledShares, avgPrice);
  const position = { side: order.side, loopId, shares: filledShares, entryPrice: avgPrice, cost, rebate, filled: true, pnl: null, ts: Date.now(), orderId: order.id };

  engine.bankroll = round2(engine.bankroll - cost + rebate);
  engine.estimatedRebates = round2(engine.estimatedRebates + rebate);
  trade.loops[loopId].positions.push(position);

  const loopLabel = engine.loops[loopId].label;
  registerTrade({ slug: trade.leg.slug, asset: trade.asset, step: `${loopLabel} ${order.side.toUpperCase()} maker fill`, side: order.side, price: avgPrice, shares: filledShares, cost, rebate });
  log(`✅ [${trade.label} ${trade.leg.slug}] ${loopLabel} (${order.side.toUpperCase()}) resting order FILLED — ${filledShares}sh @${avgPrice.toFixed(3)} ($${cost.toFixed(2)}, est. rebate +$${rebate.toFixed(4)}) | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

async function fireEntry(trade, loopId, side, shares) {
  const leg = trade.leg;
  const price = side === 'up' ? leg.upAsk : leg.downAsk;
  const tokenId = side === 'up' ? leg.upTokenId : leg.downTokenId;
  if (price == null || tokenId == null) return;

  const resp = await placeRestingLimitBuy(tokenId, price, shares);
  const loopLabel = engine.loops[loopId].label;
  if (!resp) { log(`❌ [${trade.label} ${leg.slug}] ${loopLabel} (${side.toUpperCase()}) resting limit order failed to place`); return; }

  const order = { id: resp.id, side, loopId, tokenId, limitPrice: price, shares, placedAt: Date.now() };

  if (resp.filledNow && resp.filledShares > 0) {
    confirmFill(trade, loopId, order, resp.avgPrice, resp.filledShares);
    return;
  }

  trade.loops[loopId].orders.push(order);
  log(`🧾 [${trade.label} ${leg.slug}] ${loopLabel} (${side.toUpperCase()}) resting limit buy placed (GTC, maker) — ${shares}sh @${price.toFixed(3)} — watching for fill`);
}

// Evaluates one loop's rolling-interval dip check against whichever side
// it's currently assigned to for this window.
async function evaluateWatch(trade, loopId, now) {
  const cfg = engine.loops[loopId];
  const ls = trade.loops[loopId];
  const leg = trade.leg;
  const side = ls.side;
  const currentAsk = side === 'up' ? leg.upAsk : leg.downAsk;
  if (currentAsk == null) return;

  const watch = ls.watch;
  if (watch.lastCheckTs == null) {
    watch.lastCheckTs = now;
    watch.prevAsk = currentAsk;
    return;
  }
  if (now - watch.lastCheckTs < cfg.intervalMs) return;

  const prevAsk = watch.prevAsk;
  watch.lastCheckTs = now;
  watch.prevAsk = currentAsk;
  watch.checks++;
  if (prevAsk == null) return;

  const drop = round4(prevAsk - currentAsk);
  if (drop < cfg.dropThreshold) return;

  const label = `[${trade.label} ${leg.slug}] ${cfg.label} (${side.toUpperCase()})`;

  if (currentAsk < MIN_ENTRY_PRICE) {
    log(`🚫 ${label} dip trigger skipped — ask ${currentAsk.toFixed(3)} is below the $${MIN_ENTRY_PRICE.toFixed(2)} minimum entry floor`);
    return;
  }

  const committed = ls.orders.length + ls.positions.length;
  if (committed >= MAX_FILLS_PER_WINDOW) {
    log(`🚫 ${label} dip trigger skipped — already at the ${MAX_FILLS_PER_WINDOW}-order cap for this loop this window`);
    return;
  }

  const mult = loopMultiplier(loopId);
  const shares = Math.max(MIN_ORDER_SHARES, Math.round(cfg.baseShares * mult));

  log(`📉 ${label} ask dropped ${drop.toFixed(3)} (${prevAsk.toFixed(3)} → ${currentAsk.toFixed(3)}) — firing ${shares}sh resting limit buy (base ${cfg.baseShares}sh × ${mult.toFixed(2)} adaptive)`);
  await fireEntry(trade, loopId, side, shares);
}

async function checkPendingOrders(trade) {
  const leg = trade.leg;
  for (const loopId of LOOP_IDS) {
    const list = trade.loops[loopId].orders;
    for (let i = list.length - 1; i >= 0; i--) {
      const order = list[i];
      const currentAsk = order.side === 'up' ? leg.upAsk : leg.downAsk;
      if (currentAsk == null) continue;
      const crossed = currentAsk <= order.limitPrice + 1e-9;
      if (!crossed) continue;

      if (DRY_RUN) {
        confirmFill(trade, loopId, order, order.limitPrice, order.shares);
        list.splice(i, 1);
        continue;
      }

      if (!trader || typeof trader.reconcileToken !== 'function') continue;
      try {
        const rec = await trader.reconcileToken(order.tokenId);
        if (rec && rec.filledShares > 0) {
          confirmFill(trade, loopId, order, rec.avgPrice || order.limitPrice, rec.filledShares);
          list.splice(i, 1);
        }
      } catch (e) {
        log(`⚠️  reconcileToken(${order.tokenId}) failed: ${e.message}`);
      }
    }
  }
}

async function expireOpenOrders(trade) {
  for (const loopId of LOOP_IDS) {
    const list = trade.loops[loopId].orders;
    for (const order of list) {
      log(`⌛ [${trade.label} ${trade.leg.slug}] ${engine.loops[loopId].label} (${order.side.toUpperCase()}) resting order expired unfilled at window close — ${order.shares}sh @${order.limitPrice.toFixed(3)}`);
      await cancelRestingOrder(order.id);
    }
    list.length = 0;
  }
}

// ─────────────────────────────────────────
//  Unrealized P&L helpers
// ─────────────────────────────────────────
function allPositions(trade) { return [...trade.loops.A.positions, ...trade.loops.B.positions]; }
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
  return unrealizedForPositions(trade.leg, allPositions(trade));
}
function openCostForTrade(trade) {
  if (!trade) return 0;
  return round2(allPositions(trade).reduce((s, p) => s + (p.filled ? p.cost : 0), 0));
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
//  Settlement — every filled position from both loops settles against
//  the single window winner. Then each loop independently decides
//  whether to flip sides for the next window.
// ─────────────────────────────────────────
function settleTrade(trade) {
  const leg = trade.leg;
  let combinedPnl = 0;
  const perLoop = {};

  for (const loopId of LOOP_IDS) {
    const ls = trade.loops[loopId];
    let loopPnl = 0, loopRebate = 0;
    for (const p of ls.positions) {
      if (!p.filled) { p.pnl = 0; continue; }
      const win = p.side === leg.winner;
      const payout = win ? round2(p.shares * 1) : 0;
      p.pnl = round2(payout - p.cost); // no fee — maker fee rate is 0
      engine.bankroll = round2(engine.bankroll + payout);
      combinedPnl = round2(combinedPnl + p.pnl);
      loopPnl = round2(loopPnl + p.pnl);
      loopRebate = round4(loopRebate + (p.rebate || 0));
      recordLoopResult(loopId, p.pnl, p.cost, win);
    }
    perLoop[loopId] = {
      side: ls.side,
      fills: ls.positions.length,
      shares: ls.positions.reduce((s, p) => s + p.shares, 0),
      pnl: loopPnl,
      rebate: loopRebate,
    };
  }

  trade.combinedPnl = combinedPnl;
  trade.state = 'resolved';
  trade.settled = true;
  engine.realizedPnl = round2(engine.realizedPnl + combinedPnl);
  if (combinedPnl >= 0) engine.wins++; else engine.losses++;

  registerTrade({ slug: leg.slug, asset: trade.asset, step: 'window resolution', side: leg.winner, price: 1, shares: perLoop.A.shares + perLoop.B.shares, pnl: combinedPnl });

  engine.history.unshift({
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, slug: leg.slug,
    winner: leg.winner, resolutionMethod: leg.resolutionMethod,
    loopA: perLoop.A, loopB: perLoop.B,
    combinedPnl, combinedRebate: round4(perLoop.A.rebate + perLoop.B.rebate), resolvedAt: Date.now(),
  });
  if (engine.history.length > 300) engine.history.pop();

  log(`🏆 [${trade.label} ${leg.slug}] window resolved — winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — Loop A(${perLoop.A.side.toUpperCase()}) ${perLoop.A.fills} fill(s) [${sgn2(perLoop.A.pnl)}] + Loop B(${perLoop.B.side.toUpperCase()}) ${perLoop.B.fills} fill(s) [${sgn2(perLoop.B.pnl)}] = ${sgn2(combinedPnl)} | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();

  // Each loop independently decides whether to flip for the next window.
  for (const loopId of LOOP_IDS) {
    const cfg = engine.loops[loopId];
    const tradedSide = trade.loops[loopId].side;
    if (tradedSide !== leg.winner) {
      log(`🔀 ${cfg.label} was trading ${tradedSide.toUpperCase()} — lost — switching to ${leg.winner.toUpperCase()} for the next window`);
      cfg.currentSide = leg.winner;
    } else {
      log(`✅ ${cfg.label} was trading ${tradedSide.toUpperCase()} — won — staying on ${tradedSide.toUpperCase()} for the next window`);
    }
  }
}

// ─────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────
function currentWindowTs(nowSec) { return Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS; }

async function tickBtc(now) {
  const nowSec = Math.floor(now / 1000);
  const windowTs = currentWindowTs(nowSec);
  let trade = engine.current.btc;

  if (!trade || trade.windowTs !== windowTs) {
    if (trade) {
      await expireOpenOrders(trade);
      if (allPositions(trade).length && !trade.settled) {
        trade.state = 'pending-resolution';
        engine.pending.push(trade);
        if (engine.pending.length > MAX_PENDING_RESOLUTIONS) {
          const dropped = engine.pending.shift();
          log(`⚠️  dropped stale pending window ${dropped.leg.slug} from the resolution queue (too many pending)`);
        }
      }
    }
    if (windowTs < engine.boundaryWindowTs) return;
    trade = freshTrade(windowTs);
    engine.current.btc = trade;
    log(`🆕 [BTC] new 5m window t=${windowTs} — discovering market… (Loop A → ${engine.loops.A.currentSide.toUpperCase()}, Loop B → ${engine.loops.B.currentSide.toUpperCase()})`);
  }

  if (!trade.leg.discovered && now - trade.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
    trade.leg.lastDiscoveryAttempt = now;
    await discoverLeg(trade.leg);
    if (trade.leg.discovered) trade.state = 'trading';
  }

  if (trade.state === 'trading') {
    if (engine.tradingEnabled && now < trade.closeAt) {
      await evaluateWatch(trade, 'A', now);
      await evaluateWatch(trade, 'B', now);
    }
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
function loopStateSummary(trade, loopId) {
  const cfg = engine.loops[loopId];
  const ls = trade.loops[loopId];
  return {
    id: loopId, label: cfg.label, side: ls.side,
    watch: watchSummary(ls.watch, cfg.intervalMs),
    orders: ls.orders, positions: ls.positions,
    fillsUsed: ls.orders.length + ls.positions.length,
    pnl: ls.positions.length ? round2(ls.positions.reduce((s, p) => s + (p.pnl || 0), 0)) : null,
  };
}
function tradeSummary(trade) {
  if (!trade) return null;
  return {
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, closeAt: trade.closeAt, state: trade.state,
    leg: legSummary(trade.leg),
    loops: { A: loopStateSummary(trade, 'A'), B: loopStateSummary(trade, 'B') },
    combinedPnl: trade.combinedPnl,
    unrealizedPnl: unrealizedForTrade(trade),
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
    makerFeeRate: MAKER_FEE_RATE, makerRebateShare: MAKER_REBATE_SHARE,
    minEntryPrice: MIN_ENTRY_PRICE, maxFillsPerWindow: MAX_FILLS_PER_WINDOW,
    adaptiveSizingEnabled: ADAPTIVE_SIZING_ENABLED,
    loopStats: {
      A: { ...loopRollingStats('A'), baseShares: LOOP_A_BASE_SHARES, intervalMs: LOOP_A_INTERVAL_MS, dropThreshold: LOOP_A_DROP, currentSide: engine.loops.A.currentSide, label: engine.loops.A.label },
      B: { ...loopRollingStats('B'), baseShares: LOOP_B_BASE_SHARES, intervalMs: LOOP_B_INTERVAL_MS, dropThreshold: LOOP_B_DROP, currentSide: engine.loops.B.currentSide, label: engine.loops.B.label },
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
  slog('[hedgebot] 🪙 BTC 5-Minute Price-Dip Engine (winner-chasing loops, resting maker limit orders) — fully automatic');
  slog(`[hedgebot] ⚙️  Loop A: every ${LOOP_A_INTERVAL_MS / 1000}s, base ${LOOP_A_BASE_SHARES}sh, starts on UP. Loop B: every ${LOOP_B_INTERVAL_MS / 1000}s, base ${LOOP_B_BASE_SHARES}sh, starts on DOWN.`);
  slog(`[hedgebot] ⚙️  Each loop independently flips to whichever side just won, whenever its own current side loses a window — otherwise stays put. Rolling ROI/multiplier history travels with the loop through a flip.`);
  slog(`[hedgebot] ⚙️  All orders are GTC resting limits (maker, 0% fee), not FOK — fills are confirmed once live price trades through the order's price.`);
  slog(`[hedgebot] ⚙️  Est. Maker Rebate: Crypto category pays back ${(MAKER_REBATE_SHARE * 100).toFixed(0)}% of shares×${CRYPTO_TAKER_FEE_RATE}×price×(1-price) per fill — tracked separately from trading P&L.`);
  slog(`[hedgebot] ⚙️  Safeguards: min entry price $${MIN_ENTRY_PRICE.toFixed(2)} | max ${MAX_FILLS_PER_WINDOW} resting+filled orders per loop per window | adaptive sizing ${ADAPTIVE_SIZING_ENABLED ? `ON (${ADAPTIVE_MIN_MULT}x-${ADAPTIVE_MAX_MULT}x off trailing ${ADAPTIVE_LOOKBACK}-fill ROI, neutral until ${ADAPTIVE_MIN_SAMPLE} fills)` : 'OFF'}.`);
  slog(`[hedgebot] ⚙️  Resolution: official Gamma > high-confidence live price (>=${HIGH_CONF_PRICE}) > ${Math.round(RESOLUTION_FALLBACK_MS / 1000)}s live-price fallback.`);
  slog(`[hedgebot] ⚙️  Starting bankroll $${STARTING_CAPITAL} | never joins a window it starts mid-way through`);
  if (LOOP_A_BASE_SHARES < MIN_ORDER_SHARES || LOOP_B_BASE_SHARES < MIN_ORDER_SHARES) {
    slog(`[hedgebot] ⚠️  Loop base shares below Polymarket's ${MIN_ORDER_SHARES}sh minimum order size — those orders would be rejected. Raise them.`);
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
