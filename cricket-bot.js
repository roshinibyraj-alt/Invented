'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 5-MINUTE "LAST-SECOND FLIP" ENGINE — ONE SIDE, TWO TIMERS
 * ═══════════════════════════════════════════════════════════════
 *
 *  Only BTC's 5-minute Up/Down market trades. ETH and BTC's 15-min
 *  market are not touched.
 *
 *  ── ONE SHARED SIDE, NOT TWO INDEPENDENT LOOPS ──
 *  There is a single side (`engine.currentSide`, "up" or "down") for
 *  the whole bot. Both timers below always trade that same side —
 *  there is no separate per-loop side, no independent flip logic,
 *  no adaptive sizing, no dip-threshold trigger. Only the interval
 *  and share size from the two original configs survive:
 *    - Timer A: fires every LOOP_A_INTERVAL_MS, buys LOOP_A_BASE_SHARES.
 *    - Timer B: fires every LOOP_B_INTERVAL_MS, buys LOOP_B_BASE_SHARES.
 *  Every fire is a flat-size resting GTC limit buy at the live ask on
 *  the shared side — no dip check, no skip logic.
 *
 *  ── SIDE DETERMINATION: LAST SECOND OF THE WINDOW ──
 *  Once, in the final second before a window closes (closeAt - 1000ms
 *  up to closeAt), the bot reads live prices and treats whichever side
 *  is currently ahead (higher bid/ask) as the "determined" side. That
 *  becomes engine.currentSide for the NEXT window. This is a live-price
 *  read, not the official resolution — it's what decides which way
 *  to trade next, before the market has technically closed.
 *
 *  Official/high-confidence/fallback resolution (below) still runs
 *  separately, after close, purely to settle P&L accurately. It does
 *  not drive the side switch — the last-second read does.
 *
 *  ── ORDER TYPE: RESTING GTC LIMIT (MAKER), NOT FOK ──
 *  Every entry is a GTC limit order at the ask price observed at fire
 *  time. It rests until price trades back down through that level
 *  (fills as maker) or the window closes (expires unfilled).
 *
 *  FILL CONFIRMATION: every tick, every resting order is checked
 *  against the freshest live ask on its side. Once price has crossed
 *  down to or through the order's limit price:
 *    - LIVE: trader.reconcileToken(tokenId) confirms the real fill.
 *    - DEMO: the crossing itself is treated as the fill.
 *
 *  FEES / REBATES: 0% maker fee on every fill. Filled orders earn an
 *  estimated Maker Rebate per Polymarket's published Crypto-category
 *  model: fee_equivalent = shares × 0.07 × price × (1-price); estimated
 *  rebate = fee_equivalent × 20%. Tracked separately from trading P&L.
 *  Source: docs.polymarket.com/market-makers/maker-rebates
 *
 *  RESOLUTION (for settlement only): three tiers, fastest wins:
 *    1. Official — Polymarket Gamma's `closed` + `outcomePrices`.
 *    2. High-confidence live price — either side crossing HIGH_CONF_PRICE
 *       (default 0.90) is treated as the de-facto winner immediately.
 *    3. Live-price fallback — if neither resolves within
 *       RESOLUTION_FALLBACK_MS after close, use whichever side has the
 *       higher live price.
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

// How close to window-close we take the live-price read that decides
// next window's side (a 1000ms window ending exactly at close).
const SIDE_DECISION_WINDOW_MS = Number(process.env.SIDE_DECISION_WINDOW_MS || 1000);

// ── Timer A: fires every LOOP_A_INTERVAL_MS, flat LOOP_A_BASE_SHARES.
const LOOP_A_INTERVAL_MS = Number(process.env.DIP_UP_INTERVAL_MS || 20000);
const LOOP_A_BASE_SHARES = Number(process.env.DIP_UP_SHARES || 10);

// ── Timer B: fires every LOOP_B_INTERVAL_MS, flat LOOP_B_BASE_SHARES.
const LOOP_B_INTERVAL_MS = Number(process.env.DIP_DOWN_INTERVAL_MS || 40000);
const LOOP_B_BASE_SHARES = Number(process.env.DIP_DOWN_SHARES || 20);

// Starting side for the very first window, before any last-second read exists.
const START_SIDE = (process.env.DIP_START_SIDE || 'up').toLowerCase() === 'down' ? 'down' : 'up';

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
// de-facto winner immediately instead of waiting for RESOLUTION_FALLBACK_MS. (Settlement only.)
const HIGH_CONF_PRICE = Number(process.env.RESOLUTION_HIGH_CONF_PRICE || 0.90);

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function estimateMakerRebate(shares, price) {
  if (MAKER_REBATE_SHARE <= 0) return 0;
  const feeEquivalent = shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price);
  return round4(feeEquivalent * MAKER_REBATE_SHARE);
}
function sgn2(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
const otherSide = (s) => (s === 'up' ? 'down' : 'up');

let emitFn = () => {};
let slog = () => {};
let trader = null;
let warnedNoRestingMethod = false;
let tradeSeq = 0;

// Loop identity (interval + share size only) lives at the engine level.
// The SIDE lives at the engine level too, but as a single shared value —
// not per-loop.
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
  currentSide: START_SIDE,
  loops: {
    A: { id: 'A', label: 'Loop A', intervalMs: LOOP_A_INTERVAL_MS, baseShares: LOOP_A_BASE_SHARES },
    B: { id: 'B', label: 'Loop B', intervalMs: LOOP_B_INTERVAL_MS, baseShares: LOOP_B_BASE_SHARES },
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

// Live-price "who's ahead right now" read — used both for the
// last-second side decision and as one tier of settlement resolution.
function leadingSide(leg) {
  const upP = markPrice(leg, 'up');
  const downP = markPrice(leg, 'down');
  if (upP == null && downP == null) return null;
  if (upP == null) return 'down';
  if (downP == null) return 'up';
  return upP >= downP ? 'up' : 'down';
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
    const winner = leadingSide(leg);
    if (winner) {
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
//  Trade — one 5-minute window. Side is locked in for the whole
//  window from engine.currentSide the moment the window opens, and
//  both timers (A and B) trade that same side throughout.
// ─────────────────────────────────────────
function freshWatch() {
  return { lastFireTs: null };
}
function freshLoopState() {
  return { watch: freshWatch(), orders: [], positions: [] };
}
function freshTrade(windowTs) {
  return {
    asset: ASSET_KEY, label: ASSET_LABEL, windowTs,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    leg: freshLeg(windowTs),
    state: 'discovering', // discovering -> trading -> pending-resolution -> resolved
    side: engine.currentSide, // shared by both timers this window
    sideDecided: false, // whether the last-second side read has fired yet
    loops: { A: freshLoopState(), B: freshLoopState() },
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

// Fires a flat-size buy on the trade's shared side every intervalMs —
// no dip check, no threshold, no adaptive sizing.
async function evaluateLoop(trade, loopId, now) {
  const cfg = engine.loops[loopId];
  const ls = trade.loops[loopId];
  const side = trade.side;
  const ask = side === 'up' ? trade.leg.upAsk : trade.leg.downAsk;
  if (ask == null) return;

  const watch = ls.watch;
  if (watch.lastFireTs == null) {
    // Start the clock at window open; first fire happens one interval later.
    watch.lastFireTs = now;
    return;
  }
  if (now - watch.lastFireTs < cfg.intervalMs) return;
  watch.lastFireTs = now;

  await fireEntry(trade, loopId, side, cfg.baseShares);
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
//  Last-second side decision — once per window, in the final
//  SIDE_DECISION_WINDOW_MS before close, read live prices and lock in
//  whichever side is ahead as engine.currentSide for the NEXT window.
// ─────────────────────────────────────────
function maybeDecideNextSide(trade, now) {
  if (trade.sideDecided) return;
  if (now < trade.closeAt - SIDE_DECISION_WINDOW_MS) return;
  if (now >= trade.closeAt) return; // missed the window this tick; settlement will still happen normally

  const decided = leadingSide(trade.leg);
  trade.sideDecided = true;
  if (!decided) {
    log(`⚠️  [${trade.label} ${trade.leg.slug}] last-second side read had no price data — keeping ${engine.currentSide.toUpperCase()} for next window`);
    return;
  }
  const prev = engine.currentSide;
  engine.currentSide = decided;
  if (decided !== prev) {
    log(`🔀 [${trade.label} ${trade.leg.slug}] last-second read: ${decided.toUpperCase()} ahead — switching to ${decided.toUpperCase()} for next window`);
  } else {
    log(`✅ [${trade.label} ${trade.leg.slug}] last-second read: ${decided.toUpperCase()} still ahead — staying on ${decided.toUpperCase()} for next window`);
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
//  Settlement — every filled position from both timers settles against
//  the single window winner. Side switching is NOT decided here
//  (that already happened in the last-second read) — this is P&L only.
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
    }
    perLoop[loopId] = {
      side: trade.side,
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
    tradedSide: trade.side,
    loopA: perLoop.A, loopB: perLoop.B,
    combinedPnl, combinedRebate: round4(perLoop.A.rebate + perLoop.B.rebate), resolvedAt: Date.now(),
  });
  if (engine.history.length > 300) engine.history.pop();

  log(`🏆 [${trade.label} ${leg.slug}] window resolved — traded ${trade.side.toUpperCase()}, winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — Loop A ${perLoop.A.fills} fill(s) [${sgn2(perLoop.A.pnl)}] + Loop B ${perLoop.B.fills} fill(s) [${sgn2(perLoop.B.pnl)}] = ${sgn2(combinedPnl)} | bankroll=$${engine.bankroll.toFixed(2)}`);
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

  if (!trade || trade.windowTs !== windowTs) {
    if (trade) {
      // Safety net: if the last-second window never got a price tick
      // (e.g. a stall), decide now so the next window still has a side.
      maybeDecideNextSide(trade, trade.closeAt);
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
    log(`🆕 [BTC] new 5m window t=${windowTs} — discovering market… trading ${trade.side.toUpperCase()} (Loop A every ${LOOP_A_INTERVAL_MS / 1000}s ${LOOP_A_BASE_SHARES}sh, Loop B every ${LOOP_B_INTERVAL_MS / 1000}s ${LOOP_B_BASE_SHARES}sh)`);
  }

  if (!trade.leg.discovered && now - trade.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
    trade.leg.lastDiscoveryAttempt = now;
    await discoverLeg(trade.leg);
    if (trade.leg.discovered) trade.state = 'trading';
  }

  if (trade.state === 'trading') {
    if (engine.tradingEnabled && now < trade.closeAt) {
      await evaluateLoop(trade, 'A', now);
      await evaluateLoop(trade, 'B', now);
    }
    maybeDecideNextSide(trade, now);
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
  const nextFireInMs = watch.lastFireTs == null ? null : Math.max(0, intervalMs - (Date.now() - watch.lastFireTs));
  return { nextFireInMs };
}
function loopStateSummary(trade, loopId) {
  const cfg = engine.loops[loopId];
  const ls = trade.loops[loopId];
  return {
    id: loopId, label: cfg.label, side: trade.side, // mirrored from trade.side — kept for dashboard compatibility
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
    side: trade.side,
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
    currentSide: engine.currentSide,
    current: { btc: tradeSummary(engine.current.btc) },
    pendingResolutionCount: engine.pending.length,
    pending: engine.pending.map(tradeSummary),
    history: engine.history.slice(0, 60),
    trades: engine.trades.slice(-100).slice().reverse(),
    equityCurve: engine.equityCurve,
    logs: engine.logs.slice(-80),
    windowSeconds: WINDOW_SECONDS,
    makerFeeRate: MAKER_FEE_RATE, makerRebateShare: MAKER_REBATE_SHARE,
    // loopStats kept for dashboard compatibility — no adaptive sizing anymore,
    // so multiplier is always 1 and win-rate/ROI are not tracked per-loop.
    maxFillsPerWindow: null,
    loopStats: {
      A: { n: 0, winRate: null, roi: null, multiplier: 1, baseShares: LOOP_A_BASE_SHARES, intervalMs: LOOP_A_INTERVAL_MS, label: engine.loops.A.label },
      B: { n: 0, winRate: null, roi: null, multiplier: 1, baseShares: LOOP_B_BASE_SHARES, intervalMs: LOOP_B_INTERVAL_MS, label: engine.loops.B.label },
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
  slog('[hedgebot] 🪙 BTC 5-Minute Last-Second-Flip Engine (single shared side, two flat-size interval timers) — fully automatic');
  slog(`[hedgebot] ⚙️  Timer A: every ${LOOP_A_INTERVAL_MS / 1000}s, flat ${LOOP_A_BASE_SHARES}sh. Timer B: every ${LOOP_B_INTERVAL_MS / 1000}s, flat ${LOOP_B_BASE_SHARES}sh. Both always trade the same side.`);
  slog(`[hedgebot] ⚙️  Side switch: once per window, in the final ${SIDE_DECISION_WINDOW_MS}ms before close, live price decides which side leads — that side is used for the next window. Starting side: ${engine.currentSide.toUpperCase()}.`);
  slog(`[hedgebot] ⚙️  All orders are GTC resting limits (maker, 0% fee), not FOK — fills are confirmed once live price trades through the order's price.`);
  slog(`[hedgebot] ⚙️  Est. Maker Rebate: Crypto category pays back ${(MAKER_REBATE_SHARE * 100).toFixed(0)}% of shares×${CRYPTO_TAKER_FEE_RATE}×price×(1-price) per fill — tracked separately from trading P&L.`);
  slog(`[hedgebot] ⚙️  Resolution (settlement only): official Gamma > high-confidence live price (>=${HIGH_CONF_PRICE}) > ${Math.round(RESOLUTION_FALLBACK_MS / 1000)}s live-price fallback.`);
  slog(`[hedgebot] ⚙️  Starting bankroll $${STARTING_CAPITAL} | never joins a window it starts mid-way through`);
  if (LOOP_A_BASE_SHARES < MIN_ORDER_SHARES || LOOP_B_BASE_SHARES < MIN_ORDER_SHARES) {
    slog(`[hedgebot] ⚠️  Timer base shares below Polymarket's ${MIN_ORDER_SHARES}sh minimum order size — those orders would be rejected. Raise them.`);
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
