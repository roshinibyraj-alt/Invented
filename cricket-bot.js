'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 5-MINUTE "PRICE-DIP" LIMIT ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 *  Replaces the old 15m/5m correlated hedge strategy entirely. Only
 *  BTC's 5-minute Up/Down market trades now — ETH and BTC's 15-min
 *  market are no longer touched at all.
 *
 *  Up and Down are two fully independent trigger loops running against
 *  the SAME 5-minute window's order book:
 *
 *   UP SIDE   — every 20 seconds, compare the current Up ask to the Up
 *               ask price recorded ~20 seconds earlier. If it has
 *               dropped by 0.05 or more, fire a limit buy on UP at the
 *               current Up ask, size 10 shares.
 *
 *   DOWN SIDE — mirrors the Up logic exactly, but on its own 40-second
 *               clock (comparing the current Down ask to the Down ask
 *               from ~40 seconds earlier), and sized at 20 shares.
 *
 *  Both loops run continuously for the entire life of every 5-minute
 *  window — this is not a once-per-window decision. If price keeps
 *  dipping by >=0.05 on every check, a new order fires on every check,
 *  with no cap.
 *
 *  SAMPLING NOTE: the "previous" price for each side is a rolling
 *  baseline reset every time a check fires (not clock-aligned to
 *  :00/:20/:40) — the first price read after a window starts trading
 *  seeds the baseline with no comparison, then every following check
 *  compares against whatever was seen at the last check.
 *
 *  ORDER TYPE: every entry is a limit-priced FOK (fill-or-kill) order
 *  placed at the live ask, exactly like the old engine's entries — it
 *  either fills immediately at (at worst) that price, or is killed
 *  outright with nothing left resting on the book. No stop-loss, no
 *  entry-price filter, no correlation/hedge sizing — this strategy is
 *  pure entry-trigger logic. Positions ride to window resolution.
 *
 *  RESOLUTION: unchanged from the old engine, three tiers, fastest
 *  available wins:
 *    1. Official — Polymarket Gamma's `closed` + `outcomePrices`.
 *    2. High-confidence live price — either side crossing HIGH_CONF_PRICE
 *       (default 0.90) is treated as the de-facto winner immediately.
 *    3. Live-price fallback — if neither resolves within
 *       RESOLUTION_FALLBACK_MS after close, use whichever side has the
 *       higher live price.
 *  Every filled position in that window (both Up and Down fills, however
 *  many fired) settles against the same single winner, and the window's
 *  combined P&L is the sum of every position's individual P&L.
 *
 *  STARTUP: if started mid-window, waits for the next fresh 5-minute
 *  boundary before opening any trade — never joins a window partway
 *  through.
 *
 *  TRADER INTERFACE:
 *    trader.placeFokLimitOrder(tokenId, side, price, size) -> { id, isFilled, avgPrice, raw }
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
const UP_SHARES            = Number(process.env.DIP_UP_SHARES || 10);

// ── Down-side trigger: mirrors Up, but every 40s and sized at 20 shares.
const DOWN_CHECK_INTERVAL_MS = Number(process.env.DIP_DOWN_INTERVAL_MS || 40000);
const DOWN_DROP_THRESHOLD    = Number(process.env.DIP_DOWN_DROP || 0.05);
const DOWN_SHARES            = Number(process.env.DIP_DOWN_SHARES || 20);

// Polymarket's live minimum order size on these crypto Up/Down markets
// (confirmed via Gamma: orderMinSize: 5) — any order under this is rejected.
const MIN_ORDER_SHARES = Number(process.env.HEDGE_MIN_ORDER_SHARES || 5);

let DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const STARTING_CAPITAL = Number(process.env.HEDGE_CAPITAL || 2000);
// Every fill is a taker fill (crosses the spread to guarantee a fill via
// FOK), so this applies to every fill. Polymarket's published
// crypto-category taker fee rate.
const TAKER_FEE_RATE = Number(process.env.HEDGE_TAKER_FEE_RATE || 0.07);
const MAX_PENDING_RESOLUTIONS = 40;

// If price crosses this threshold (or its complement) in the live book, treat that side as the
// de-facto winner immediately instead of waiting for RESOLUTION_FALLBACK_MS.
const HIGH_CONF_PRICE = Number(process.env.RESOLUTION_HIGH_CONF_PRICE || 0.90);

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function estimateFee(shares, price) {
  if (TAKER_FEE_RATE <= 0) return 0;
  return round2(shares * TAKER_FEE_RATE * price * (1 - price));
}
function sgn2(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }

let emitFn = () => {};
let slog = () => {};
let trader = null;
let warnedNoLimitMethod = false;
let tradeSeq = 0;

const engine = {
  tradingEnabled: true,
  bankroll: STARTING_CAPITAL,
  capital: STARTING_CAPITAL,
  realizedPnl: 0,
  feesPaid: 0,
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

// Walks the real live order book to find the minimum price that covers the
// requested share size right now, plus a small fixed safety margin purely
// to survive the latency gap between reading the book and the order
// actually landing. Falls back to quotedPrice + margin if the book fetch
// fails, so a transient API hiccup doesn't block trading entirely.
const BOOK_WALK_SAFETY_MARGIN = Number(process.env.HEDGE_BOOK_WALK_SAFETY_MARGIN || 0.01);
async function computeFillPrice(tokenId, shares) {
  try {
    const book = await getJSON(`${CLOB}/book?token_id=${tokenId}`);
    const asks = (book?.asks || [])
      .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .filter(a => a.price > 0 && a.size > 0)
      .sort((a, b) => a.price - b.price); // best (lowest) ask first
    let remaining = shares;
    let worstPriceNeeded = null;
    for (const level of asks) {
      worstPriceNeeded = level.price;
      remaining -= level.size;
      if (remaining <= 0) break;
    }
    if (worstPriceNeeded == null) return null; // empty book, nothing to walk
    const withMargin = round2(worstPriceNeeded + BOOK_WALK_SAFETY_MARGIN);
    return { price: Math.min(0.99, withMargin), depthCovered: remaining <= 0 };
  } catch (e) {
    return null; // caller falls back to quoted-price-based pricing
  }
}
function traderHasOrderMethods() {
  const ok = trader && typeof trader.placeFokLimitOrder === 'function';
  if (!ok && !warnedNoLimitMethod) {
    warnedNoLimitMethod = true;
    slog('[hedgebot] ❌ LIVE trading needs trader.placeFokLimitOrder on polymarket-trader.js — LIVE order placement will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}
// Limit-priced FOK buy, priced off a live order-book walk (computeFillPrice).
// FOK is atomic — it either fully fills immediately or is killed outright,
// nothing left resting on the book afterward.
async function placeFokLimitBuy(tokenId, quotedPrice, shares) {
  if (!DRY_RUN) {
    if (!traderHasOrderMethods()) return null;
    const walked = await computeFillPrice(tokenId, shares);
    const limitPrice = walked ? walked.price : Math.min(0.99, round2(quotedPrice + BOOK_WALK_SAFETY_MARGIN));
    try {
      const resp = await trader.placeFokLimitOrder(tokenId, 'BUY', limitPrice, shares);
      if (resp?.isFilled) {
        return { id: resp.id, filled: true, avgPrice: resp.avgPrice || limitPrice, filledShares: shares };
      }
      log(`◻️  order for ${String(tokenId).slice(0, 10)}… not filled (FOK, limit ${limitPrice}, book-walked: ${!!walked}) — no trade, nothing to clean up`);
      return { id: resp?.id || null, filled: false, avgPrice: limitPrice, filledShares: 0 };
    } catch (e) {
      log(`❌ placeFokLimitBuy failed: ${describeOrderError(e)}`);
      return null;
    }
  }
  return { id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: true, avgPrice: quotedPrice, filledShares: shares };
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
//  loops (Up @20s / Down @40s) that can each fire any number of
//  limit-buy fills over the window's life.
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
    upPositions: [],
    downPositions: [],
    upWatch: freshWatch(),
    downWatch: freshWatch(),
    combinedPnl: null,
    settled: false,
  };
}

// Fires one limit-buy fill attempt on the given side.
async function fireEntry(trade, side, shares) {
  const leg = trade.leg;
  const price = side === 'up' ? leg.upAsk : leg.downAsk;
  const tokenId = side === 'up' ? leg.upTokenId : leg.downTokenId;
  if (price == null || tokenId == null) return;

  const resp = await placeFokLimitBuy(tokenId, price, shares);
  const filled = !!(resp?.filled && resp.filledShares > 0);
  const fillShares = filled ? resp.filledShares : 0;
  const fillPrice = filled ? resp.avgPrice : price;
  const cost = round2(fillShares * fillPrice);
  const fee = estimateFee(fillShares, fillPrice);

  const position = { side, shares: fillShares, entryPrice: fillPrice, cost, fee, filled, pnl: null, ts: Date.now() };

  if (!filled) {
    log(`◻️  [${trade.label} ${leg.slug}] ${side.toUpperCase()} dip-buy NOT filled (FOK @${price.toFixed(3)}, ${shares}sh requested)`);
    return;
  }

  engine.bankroll = round2(engine.bankroll - cost - fee);
  engine.feesPaid = round2(engine.feesPaid + fee);
  (side === 'up' ? trade.upPositions : trade.downPositions).push(position);
  registerTrade({ slug: leg.slug, asset: trade.asset, step: side.toUpperCase() + ' dip-buy', side, price: fillPrice, shares: fillShares, cost, fee });
  log(`🎯 [${trade.label} ${leg.slug}] ${side.toUpperCase()} dip-buy filled — ${fillShares}sh @${fillPrice.toFixed(3)} ($${cost.toFixed(2)}${fee ? ' +$' + fee.toFixed(4) + ' fee' : ''}) | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

// Evaluates one side's rolling-interval dip check. First call after a
// window starts trading just seeds the baseline (nothing to compare
// against yet); every call after that, once intervalMs has elapsed since
// the last check, compares current ask to the ask recorded at that last
// check and fires if it dropped by >=dropThreshold.
async function evaluateWatch(trade, watch, side, intervalMs, dropThreshold, shares, now) {
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
  if (drop >= dropThreshold) {
    log(`📉 [${trade.label} ${leg.slug}] ${side.toUpperCase()} ask dropped ${drop.toFixed(3)} (${prevAsk.toFixed(3)} → ${currentAsk.toFixed(3)}) — firing ${shares}sh dip-buy`);
    await fireEntry(trade, side, shares);
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
//  settles against the single window winner.
// ─────────────────────────────────────────
function settleTrade(trade) {
  const leg = trade.leg;
  let combinedPnl = 0;
  const settleSide = (positions) => {
    for (const p of positions) {
      if (!p.filled) { p.pnl = 0; continue; }
      const payout = p.side === leg.winner ? round2(p.shares * 1) : 0;
      p.pnl = round2(payout - p.cost - p.fee);
      engine.bankroll = round2(engine.bankroll + payout);
      combinedPnl = round2(combinedPnl + p.pnl);
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

  registerTrade({ slug: leg.slug, asset: trade.asset, step: 'window resolution', side: leg.winner, price: 1, shares: upShares + downShares, pnl: combinedPnl });

  engine.history.unshift({
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, slug: leg.slug,
    winner: leg.winner, resolutionMethod: leg.resolutionMethod,
    upFills: trade.upPositions.length, downFills: trade.downPositions.length,
    upShares, downShares, upPnl, downPnl,
    combinedPnl, resolvedAt: Date.now(),
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
    if (trade && (trade.upPositions.length || trade.downPositions.length) && !trade.settled) {
      trade.state = 'pending-resolution';
      engine.pending.push(trade);
      if (engine.pending.length > MAX_PENDING_RESOLUTIONS) {
        const dropped = engine.pending.shift();
        log(`⚠️  dropped stale pending window ${dropped.leg.slug} from the resolution queue (too many pending)`);
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

  // Run both independent dip-check loops while the window is still open.
  if (trade.state === 'trading' && engine.tradingEnabled && now < trade.closeAt) {
    await evaluateWatch(trade, trade.upWatch, 'up', UP_CHECK_INTERVAL_MS, UP_DROP_THRESHOLD, UP_SHARES, now);
    await evaluateWatch(trade, trade.downWatch, 'down', DOWN_CHECK_INTERVAL_MS, DOWN_DROP_THRESHOLD, DOWN_SHARES, now);
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
    upPositions: trade.upPositions, downPositions: trade.downPositions,
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
    feesPaid: engine.feesPaid,
    wins: engine.wins, losses: engine.losses,
    current: { btc: tradeSummary(engine.current.btc) },
    pendingResolutionCount: engine.pending.length,
    pending: engine.pending.map(tradeSummary),
    history: engine.history.slice(0, 60),
    trades: engine.trades.slice(-100).slice().reverse(),
    equityCurve: engine.equityCurve,
    logs: engine.logs.slice(-80),
    windowSeconds: WINDOW_SECONDS,
    upIntervalMs: UP_CHECK_INTERVAL_MS, upDropThreshold: UP_DROP_THRESHOLD, upShares: UP_SHARES,
    downIntervalMs: DOWN_CHECK_INTERVAL_MS, downDropThreshold: DOWN_DROP_THRESHOLD, downShares: DOWN_SHARES,
  };
}
function getStatus() { return buildState(); }

function pauseTrading() {
  engine.tradingEnabled = false;
  log('⏸️  Trading paused — no new dip-buys will be entered; open positions still tracked to resolution, window discovery/rollover keeps running');
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
  slog('[hedgebot] 🪙 BTC 5-Minute Price-Dip Engine — fully automatic');
  slog(`[hedgebot] ⚙️  UP: every ${UP_CHECK_INTERVAL_MS / 1000}s, buy ${UP_SHARES}sh UP at the current ask if it dropped >=${UP_DROP_THRESHOLD} vs the previous check.`);
  slog(`[hedgebot] ⚙️  DOWN: every ${DOWN_CHECK_INTERVAL_MS / 1000}s, buy ${DOWN_SHARES}sh DOWN at the current ask if it dropped >=${DOWN_DROP_THRESHOLD} vs the previous check. Independent of UP.`);
  slog(`[hedgebot] ⚙️  Resolution: official Gamma > high-confidence live price (>=${HIGH_CONF_PRICE}) > ${Math.round(RESOLUTION_FALLBACK_MS / 1000)}s live-price fallback.`);
  slog(`[hedgebot] ⚙️  Starting bankroll $${STARTING_CAPITAL} | taker fee rate ${TAKER_FEE_RATE} | never joins a window it starts mid-way through`);
  if (UP_SHARES < MIN_ORDER_SHARES || DOWN_SHARES < MIN_ORDER_SHARES) {
    slog(`[hedgebot] ⚠️  UP_SHARES/DOWN_SHARES below Polymarket's ${MIN_ORDER_SHARES}sh minimum order size — those orders would be rejected. Raise them.`);
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
