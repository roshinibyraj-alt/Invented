'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC + ETH 15-MIN / 5-MIN CORRELATED HEDGE ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 *  Replaces the old rung/martingale strategy entirely. For EACH asset
 *  independently, every 15-minute Up/Down window gets ONE combined
 *  trade: a primary leg on the 15-min market, hedged by an offsetting
 *  leg on the LAST 5-minute segment inside that same 15-min window
 *  (minutes 10-15 — the only 5-min window that closes at the exact
 *  same instant as the 15-min window, so it's the most correlated
 *  hedge available). Both legs are entered TOGETHER, at the moment
 *  the last 5-min segment opens (10 minutes into the 15-min window).
 *
 *  THE 4 STEPS, EVERY TIME A COMBINED TRADE IS ENTERED:
 *
 *  1. READ BEST PRICES — pull live best ask for Up and Down on both
 *     the 15-min market and the last 5-min market.
 *
 *  2. CHECK DIVERGENCE / CORRELATION — compare the implied probability
 *     of the hedge side between the two markets:
 *       divergence = |15m_hedge_side_ask - 5m_hedge_side_ask|
 *       correlationFactor = clamp(1 - divergence, CORR_FLOOR, CORR_CEIL)
 *     Small divergence (markets agree) -> correlationFactor near 1
 *     (full hedge). Large divergence (markets disagree) -> smaller
 *     hedge, because the two windows are behaving less like the same
 *     bet right now.
 *
 *  3. SIZE OFF LIVE ASK — primary leg is a fixed base size. Hedge leg
 *     is sized to commit the same dollar amount that's actually at
 *     risk on the primary leg:
 *       amountAtRisk    = primaryShares * primaryEntryPrice   (= cost
 *                          basis = what you lose if primary resolves
 *                          to zero)
 *       rawHedgeShares  = amountAtRisk / hedgeSideAsk
 *       hedgeShares     = rawHedgeShares * correlationFactor
 *     This is a dollar-matched hedge, not a payout-matched one — it
 *     commits comparable capital to the offsetting bet, scaled down
 *     when the live data says the two markets are diverging.
 *
 *  4. ENTER BOTH LEGS TOGETHER — primary buy on the 15-min market and
 *     hedge buy on the 5-min market are placed as one combined trade,
 *     at the same tick.
 *
 *  WHY THE LAST 5-MIN SEGMENT: 15-min windows are aligned to 900s
 *  epoch boundaries; 5-min windows to 300s boundaries. Since 900 is
 *  divisible by 300, the 5-min window starting 600s into a 15-min
 *  window closes at EXACTLY the same instant as the 15-min window.
 *  Earlier segments (0-5, 5-10) don't share that closing instant and
 *  aren't used.
 *
 *  IMPORTANT CAVEAT: the two markets reference different opening
 *  prices (15-min window open vs. last-5-min segment open), so even
 *  though they close simultaneously, they are NOT the same bet — this
 *  is a correlated hedge, not a perfect one. correlationFactor is the
 *  live proxy for how tightly they're tracking right now.
 *
 *  ENTRY STYLE: both legs are bought at the current best ask (taker
 *  fills, not resting maker orders) so both legs can be guaranteed to
 *  enter together at the same instant. Taker fees apply per
 *  HEDGE_TAKER_FEE_RATE (default 0; set to Polymarket's published
 *  crypto-category taker rate if you want realistic fee modeling).
 *
 *  RESOLUTION: each leg resolves independently, three tiers, fastest
 *  available wins:
 *    1. Official — Polymarket Gamma's `closed` + `outcomePrices`.
 *    2. High-confidence live price — either side crossing HIGH_CONF_PRICE
 *       (default 0.90) is treated as the de-facto winner immediately.
 *    3. Live-price fallback — if neither resolves within
 *       RESOLUTION_FALLBACK_MS after close, use whichever side has the
 *       higher live price.
 *  Combined trade P&L = primary leg P&L + hedge leg P&L, recorded once
 *  BOTH legs have resolved.
 *
 *  STARTUP: if started mid-window, waits for the next fresh 15-minute
 *  boundary before opening any trade — never joins a window partway
 *  through.
 *
 *  TRADER INTERFACE:
 *    trader.placeLimitBuy(tokenId, price, size) -> { id, filled, avgPrice, filledShares }
 *    trader.getOrder(orderId)                   -> { filled, avgPrice, filledShares }
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS             = 500;
const PRICE_REFRESH_MS    = 1000;
const DISCOVERY_RETRY_MS  = 2000;
const RESOLUTION_POLL_MS  = 3000;
const RESOLUTION_FALLBACK_MS = Number(process.env.HEDGE_RESOLUTION_FALLBACK_MS || 60000);

const FIFTEEN_SECONDS = 900; // 15-minute window duration
const FIVE_SECONDS    = 300; // 5-minute window duration
// How far into the 15-min window the hedge leg's 5-min segment opens
// (and where the combined trade is entered). 600s = the 10:00 mark,
// i.e. the LAST 5-minute segment of the 15-minute window.
const HEDGE_ENTRY_OFFSET_SECONDS = 600;

const ASSETS = [
  { key: 'btc', label: 'BTC', slugPrefix15: 'btc-updown-15m-', slugPrefix5: 'btc-updown-5m-' },
  { key: 'eth', label: 'ETH', slugPrefix15: 'eth-updown-15m-', slugPrefix5: 'eth-updown-5m-' },
];

const PRIMARY_SHARES = Number(process.env.HEDGE_PRIMARY_SHARES || 100);
// Correlation-factor bounds (Step 2). Floor keeps the hedge from
// vanishing entirely when the two markets disagree a lot; ceiling caps
// it at a full 1:1 dollar-matched hedge when they fully agree.
const CORR_FLOOR = Number(process.env.HEDGE_CORR_FLOOR || 0.3);
const CORR_CEIL  = Number(process.env.HEDGE_CORR_CEIL || 1.0);

let DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const STARTING_CAPITAL = Number(process.env.HEDGE_CAPITAL || 2000);
// Both legs are taker fills (bought at the live ask) — set this to
// Polymarket's published crypto-category taker rate if you want
// realistic fee modeling; 0 by default for clean demo P&L.
const TAKER_FEE_RATE = Number(process.env.HEDGE_TAKER_FEE_RATE || 0);
const MAX_PENDING_RESOLUTIONS = 40;

// If price crosses this threshold (or its complement) in the live book, treat that side as the
// de-facto winner immediately instead of waiting for RESOLUTION_FALLBACK_MS.
const HIGH_CONF_PRICE = Number(process.env.RESOLUTION_HIGH_CONF_PRICE || 0.90);

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function estimateFee(shares, price) {
  if (TAKER_FEE_RATE <= 0) return 0;
  return round2(shares * TAKER_FEE_RATE * price * (1 - price));
}

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
  current: { btc: null, eth: null }, // active HedgeTrade per asset, not yet closed out
  pending: [],                        // trades whose windows have closed, awaiting leg resolution
  history: [],                        // resolved combined trades, most recent first
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
function traderHasLimitMethod() {
  const ok = trader && typeof trader.placeLimitBuy === 'function';
  if (!ok && !warnedNoLimitMethod) {
    warnedNoLimitMethod = true;
    slog('[hedgebot] ❌ LIVE trading needs trader.placeLimitBuy on polymarket-trader.js — LIVE order placement will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}
// Buys at the current live ask (marketable / taker) so both legs of a combined
// trade fill together at the same instant, instead of resting and waiting.
async function placeTakerBuy(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethod()) return null;
    try { return await trader.placeLimitBuy(tokenId, price, shares); }
    catch (e) { log(`❌ placeLimitBuy failed: ${describeOrderError(e)}`); return null; }
  }
  return { id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: true, avgPrice: price, filledShares: shares };
}

function parseMarketTokens(mk) {
  try {
    const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
    const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}

// ─────────────────────────────────────────
//  Leg — one binary market (either the 15-min market or the last
//  5-min segment inside it). Both use identical discovery / price /
//  resolution logic, just different slugs and window durations.
// ─────────────────────────────────────────
function freshLeg(slugPrefix, windowTs, windowSeconds) {
  return {
    slug: `${slugPrefix}${windowTs}`,
    windowTs, windowSeconds,
    closeAt: (windowTs + windowSeconds) * 1000,
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
  // Critical: never evaluate high-confidence before the window has actually
  // closed. A mid-window price spike to >=HIGH_CONF_PRICE is normal noise,
  // not a result — evaluating it early and freezing it was the bug that let
  // a stale, pre-close reading get declared the winner even after price
  // moved back the other way by the real close.
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

// Three-tier resolution for a single leg. Returns true once resolved.
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
//  Combined trade — primary (15m) + hedge (last 5m segment)
// ─────────────────────────────────────────
function freshPosition() {
  return { side: null, shares: 0, entryPrice: null, cost: 0, fee: 0, filled: false, pnl: null };
}
function freshTrade(assetDef, windowTs) {
  return {
    asset: assetDef.key, label: assetDef.label, windowTs,
    closeAt: (windowTs + FIFTEEN_SECONDS) * 1000,
    fifteen: freshLeg(assetDef.slugPrefix15, windowTs, FIFTEEN_SECONDS),
    five: null, // created once we reach the hedge-entry offset
    state: 'discovering-fifteen', // discovering-fifteen -> awaiting-hedge-window -> discovering-five -> entered -> pending-resolution -> resolved | skipped
    primary: freshPosition(),
    hedge: freshPosition(),
    divergence: null,
    correlationFactor: null,
    combinedPnl: null,
    createdAt: Date.now(),
  };
}

function affordable(shares, price) { return round2(shares * price) <= engine.bankroll; }

// Steps 1-4: read prices, compute divergence/correlation, size, enter both legs together.
async function executeCombinedEntry(trade) {
  const f = trade.fifteen, v = trade.five;
  if (f.upAsk == null || f.downAsk == null || v.upAsk == null || v.downAsk == null) return; // Step 1 not satisfied yet

  // Step 1: best asks already sitting on f/v from refreshLegPrices().
  const primarySide = f.upAsk >= f.downAsk ? 'up' : 'down'; // market-favored side after first 10 minutes
  const hedgeSide = primarySide === 'up' ? 'down' : 'up';
  const primaryPrice = primarySide === 'up' ? f.upAsk : f.downAsk;
  const primaryTokenId = primarySide === 'up' ? f.upTokenId : f.downTokenId;
  const hedgePriceRaw = hedgeSide === 'up' ? v.upAsk : v.downAsk;
  const hedgeTokenId = hedgeSide === 'up' ? v.upTokenId : v.downTokenId;

  // Floor the hedge price at Polymarket's minimum tick (0.01) so a stale/zero
  // quote can't blow up amountAtRisk / hedgePrice into an unbounded share
  // count. At extreme entries (primary >= ~0.90) the hedge side is naturally
  // very cheap, which already makes hedgeShares large (a cheap, high-multiple
  // hedge is expected) — this floor only stops a genuine 0/near-0 quote from
  // producing an literally unbounded order.
  const MIN_HEDGE_PRICE = 0.01;
  if (hedgePriceRaw < MIN_HEDGE_PRICE) {
    trade.state = 'skipped';
    log(`⛔ [${trade.label} ${f.slug}] skipped — hedge side ask ${hedgePriceRaw} is below the ${MIN_HEDGE_PRICE} floor (stale/illiquid quote), refusing to size off it`);
    return;
  }
  const hedgePrice = hedgePriceRaw;

  // Step 2: divergence between the two markets' pricing of the hedge side, and the
  // live correlation factor derived from it.
  const fifteenHedgeProb = hedgeSide === 'up' ? f.upAsk : f.downAsk;
  const fiveHedgeProb = hedgeSide === 'up' ? v.upAsk : v.downAsk;
  const divergence = round4(Math.abs(fifteenHedgeProb - fiveHedgeProb));
  const correlationFactor = round4(clamp(1 - divergence, CORR_FLOOR, CORR_CEIL));

  if (!affordable(PRIMARY_SHARES, primaryPrice)) {
    trade.state = 'skipped';
    log(`⛔ [${trade.label} ${f.slug}] skipped — insufficient bankroll for primary leg (${PRIMARY_SHARES}sh @ ${primaryPrice.toFixed(3)})`);
    return;
  }

  // Step 3: size.
  const amountAtRisk = round2(PRIMARY_SHARES * primaryPrice); // cost basis = max loss if primary resolves to zero
  const rawHedgeShares = amountAtRisk / hedgePrice;
  const hedgeShares = round2(rawHedgeShares * correlationFactor);

  if (!affordable(hedgeShares, hedgePrice)) {
    trade.state = 'skipped';
    log(`⛔ [${trade.label} ${f.slug}] skipped — insufficient bankroll for hedge leg (${hedgeShares}sh @ ${hedgePrice.toFixed(3)})`);
    return;
  }

  // Step 4: enter both legs together.
  const primaryResp = await placeTakerBuy(primaryTokenId, primaryPrice, PRIMARY_SHARES);
  const hedgeResp = await placeTakerBuy(hedgeTokenId, hedgePrice, hedgeShares);
  if (!primaryResp?.filled || !hedgeResp?.filled) {
    log(`⚠️  [${trade.label} ${f.slug}] combined entry incomplete — primary filled=${!!primaryResp?.filled}, hedge filled=${!!hedgeResp?.filled}`);
  }

  const pFillPrice = primaryResp?.avgPrice ?? primaryPrice;
  const pShares = primaryResp?.filledShares ?? PRIMARY_SHARES;
  const pCost = round2(pShares * pFillPrice);
  const pFee = estimateFee(pShares, pFillPrice);

  const hFillPrice = hedgeResp?.avgPrice ?? hedgePrice;
  const hShares = hedgeResp?.filledShares ?? hedgeShares;
  const hCost = round2(hShares * hFillPrice);
  const hFee = estimateFee(hShares, hFillPrice);

  engine.bankroll = round2(engine.bankroll - pCost - pFee - hCost - hFee);
  engine.feesPaid = round2(engine.feesPaid + pFee + hFee);

  trade.primary = { side: primarySide, shares: pShares, entryPrice: pFillPrice, cost: pCost, fee: pFee, filled: true, pnl: null };
  trade.hedge = { side: hedgeSide, shares: hShares, entryPrice: hFillPrice, cost: hCost, fee: hFee, filled: true, pnl: null };
  trade.divergence = divergence;
  trade.correlationFactor = correlationFactor;
  trade.state = 'entered';

  registerTrade({ slug: f.slug, asset: trade.asset, step: '15m PRIMARY entry', side: primarySide, price: pFillPrice, shares: pShares, cost: pCost, fee: pFee });
  registerTrade({ slug: v.slug, asset: trade.asset, step: '5m HEDGE entry', side: hedgeSide, price: hFillPrice, shares: hShares, cost: hCost, fee: hFee });

  log(`✅ [${trade.label} ${f.slug}] combined trade entered — PRIMARY ${pShares}sh ${primarySide.toUpperCase()} @${pFillPrice.toFixed(3)} ($${pCost.toFixed(2)}) | HEDGE ${hShares}sh ${hedgeSide.toUpperCase()} @${hFillPrice.toFixed(3)} ($${hCost.toFixed(2)}) | divergence=${divergence.toFixed(4)} correlation=${correlationFactor.toFixed(2)} | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

function resolveTradeIfReady(trade) {
  if (!trade.fifteen.resolved || !trade.five.resolved) return false;
  if (trade.state !== 'entered' && trade.state !== 'pending-resolution') return true; // was skipped, nothing to settle

  const primaryPayout = trade.primary.side === trade.fifteen.winner ? round2(trade.primary.shares * 1) : 0;
  const primaryPnl = round2(primaryPayout - trade.primary.cost - trade.primary.fee);
  trade.primary.pnl = primaryPnl;

  const hedgePayout = trade.hedge.side === trade.five.winner ? round2(trade.hedge.shares * 1) : 0;
  const hedgePnl = round2(hedgePayout - trade.hedge.cost - trade.hedge.fee);
  trade.hedge.pnl = hedgePnl;

  const combinedPnl = round2(primaryPnl + hedgePnl);
  trade.combinedPnl = combinedPnl;
  trade.state = 'resolved';

  engine.bankroll = round2(engine.bankroll + primaryPayout + hedgePayout);
  engine.realizedPnl = round2(engine.realizedPnl + combinedPnl);
  if (combinedPnl >= 0) engine.wins++; else engine.losses++;

  registerTrade({ slug: trade.fifteen.slug, asset: trade.asset, step: '15m PRIMARY resolution', side: trade.primary.side, price: 1, shares: trade.primary.shares, pnl: primaryPnl });
  registerTrade({ slug: trade.five.slug, asset: trade.asset, step: '5m HEDGE resolution', side: trade.hedge.side, price: 1, shares: trade.hedge.shares, pnl: hedgePnl });

  engine.history.unshift({
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs,
    fifteenSlug: trade.fifteen.slug, fiveSlug: trade.five.slug,
    primarySide: trade.primary.side, primaryShares: trade.primary.shares, primaryEntry: trade.primary.entryPrice, primaryWinner: trade.fifteen.winner, primaryPnl,
    hedgeSide: trade.hedge.side, hedgeShares: trade.hedge.shares, hedgeEntry: trade.hedge.entryPrice, hedgeWinner: trade.five.winner, hedgePnl,
    divergence: trade.divergence, correlationFactor: trade.correlationFactor,
    combinedPnl, resolvedAt: Date.now(),
  });
  if (engine.history.length > 300) engine.history.pop();

  log(`🏆 [${trade.label} ${trade.fifteen.slug}] combined trade resolved — primary ${sgn2(primaryPnl)} + hedge ${sgn2(hedgePnl)} = ${sgn2(combinedPnl)} | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
  return true;
}
function sgn2(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }

// ─────────────────────────────────────────
//  Unrealized P&L helpers
// ─────────────────────────────────────────
function unrealizedForLeg(leg, position) {
  if (!leg || leg.resolved || !position.filled || position.shares <= 0) return 0;
  const mp = markPrice(leg, position.side);
  const mark = mp != null ? mp : (position.cost / position.shares);
  return round2(position.shares * mark - position.cost);
}
function unrealizedForTrade(trade) {
  if (trade.state !== 'entered' && trade.state !== 'pending-resolution') return 0;
  return round2(unrealizedForLeg(trade.fifteen, trade.primary) + unrealizedForLeg(trade.five, trade.hedge));
}
function openCostForTrade(trade) {
  if (trade.state !== 'entered' && trade.state !== 'pending-resolution') return 0;
  return round2(trade.primary.cost + trade.hedge.cost);
}
function allTrackedTrades() {
  const list = [...engine.pending];
  if (engine.current.btc) list.push(engine.current.btc);
  if (engine.current.eth) list.push(engine.current.eth);
  return list;
}
function totalUnrealizedPnl() {
  return round2(allTrackedTrades().reduce((sum, t) => sum + unrealizedForTrade(t), 0));
}
function openPositionsMTM() {
  return round2(allTrackedTrades().reduce((sum, t) => sum + openCostForTrade(t) + unrealizedForTrade(t), 0));
}

// ─────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────
function currentFifteenWindowTs(nowSec) { return Math.floor(nowSec / FIFTEEN_SECONDS) * FIFTEEN_SECONDS; }

async function tickAsset(assetDef, now) {
  const nowSec = Math.floor(now / 1000);
  const windowTs = currentFifteenWindowTs(nowSec);
  let trade = engine.current[assetDef.key];

  // Roll over to a fresh 15-minute window.
  if (!trade || trade.windowTs !== windowTs) {
    if (trade && (trade.state === 'entered' || trade.state === 'pending-resolution')) {
      trade.state = 'pending-resolution';
      engine.pending.push(trade);
      if (engine.pending.length > MAX_PENDING_RESOLUTIONS) {
        const dropped = engine.pending.shift();
        log(`⚠️  dropped stale pending trade ${dropped.fifteen.slug} from the resolution queue (too many pending)`);
      }
    }
    if (windowTs < engine.boundaryWindowTs) return; // haven't reached the first fresh boundary yet
    trade = freshTrade(assetDef, windowTs);
    engine.current[assetDef.key] = trade;
    log(`🆕 [${assetDef.label}] new 15m window t=${windowTs} — discovering primary market…`);
  }

  // Discover the 15-min (primary) market.
  if (!trade.fifteen.discovered && now - trade.fifteen.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
    trade.fifteen.lastDiscoveryAttempt = now;
    await discoverLeg(trade.fifteen);
  }

  // Once we're at the 10-minute mark, create + discover the hedge (last 5-min segment) market.
  const hedgeWindowTs = windowTs + HEDGE_ENTRY_OFFSET_SECONDS;
  if (!trade.five && nowSec >= hedgeWindowTs) {
    trade.five = freshLeg(assetDef.slugPrefix5, hedgeWindowTs, FIVE_SECONDS);
    trade.state = 'discovering-five';
    log(`🕐 [${assetDef.label}] entering hedge window — discovering last-5m segment market ${trade.five.slug}…`);
  }
  if (trade.five && !trade.five.discovered && now - trade.five.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
    trade.five.lastDiscoveryAttempt = now;
    await discoverLeg(trade.five);
  }

  // Once both legs are discovered and priced, enter the combined trade.
  if (trade.five && trade.fifteen.discovered && trade.five.discovered && trade.state !== 'entered' && trade.state !== 'skipped' && engine.tradingEnabled) {
    await refreshLegPrices(trade.fifteen);
    await refreshLegPrices(trade.five);
    await executeCombinedEntry(trade);
  }
}

async function mainLoop() {
  while (true) {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);

      if (engine.waitingForBoundary) {
        if (engine.boundaryWindowTs == null) {
          engine.boundaryWindowTs = currentFifteenWindowTs(nowSec) + FIFTEEN_SECONDS;
          log(`⏳ started mid-window — waiting for next fresh 15-minute boundary (t=${engine.boundaryWindowTs}) before trading begins`);
        }
        if (nowSec >= engine.boundaryWindowTs) {
          engine.waitingForBoundary = false;
          log('🚦 new 15-minute boundary reached — trading starts now');
        }
      }

      if (!engine.waitingForBoundary) {
        for (const assetDef of ASSETS) await tickAsset(assetDef, now);
      }

      if (now - engine.lastPriceFetch >= PRICE_REFRESH_MS) {
        engine.lastPriceFetch = now;
        const legs = [];
        for (const t of allTrackedTrades()) { legs.push(t.fifteen); if (t.five) legs.push(t.five); }
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
          if (!trade.fifteen.resolved) await resolveLegAttempt(trade.fifteen);
          if (!trade.five) trade.five = { resolved: true, winner: null }; // never reached hedge entry — nothing to resolve there
          else if (!trade.five.resolved) await resolveLegAttempt(trade.five);
          const done = resolveTradeIfReady(trade);
          if (!done) stillPending.push(trade);
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
function tradeSummary(trade) {
  if (!trade) return null;
  return {
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, closeAt: trade.closeAt, state: trade.state,
    fifteen: legSummary(trade.fifteen), five: legSummary(trade.five),
    primary: trade.primary, hedge: trade.hedge,
    divergence: trade.divergence, correlationFactor: trade.correlationFactor,
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
    current: { btc: tradeSummary(engine.current.btc), eth: tradeSummary(engine.current.eth) },
    pendingResolutionCount: engine.pending.length,
    pending: engine.pending.map(tradeSummary),
    history: engine.history.slice(0, 60),
    trades: engine.trades.slice(-100).slice().reverse(),
    equityCurve: engine.equityCurve,
    logs: engine.logs.slice(-80),
    primaryShares: PRIMARY_SHARES,
    corrFloor: CORR_FLOOR, corrCeil: CORR_CEIL,
    fifteenSeconds: FIFTEEN_SECONDS, fiveSeconds: FIVE_SECONDS, hedgeEntryOffsetSeconds: HEDGE_ENTRY_OFFSET_SECONDS,
  };
}
function getStatus() { return buildState(); }

function pauseTrading() {
  engine.tradingEnabled = false;
  log('⏸️  Trading paused — no new combined trades will be entered; open positions still tracked to resolution, window discovery/rollover keeps running');
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
  slog('[hedgebot] 🪙 BTC + ETH 15m/5m Correlated Hedge Engine — fully automatic');
  slog(`[hedgebot] ⚙️  Each 15-min window: buy ${PRIMARY_SHARES}sh of the market-favored side at the 10-minute mark, hedged by the opposite side on the last 5-min segment. Hedge size = (primary cost at risk / hedge ask) × live correlation factor (clamped ${CORR_FLOOR}-${CORR_CEIL}, derived from price divergence between the two markets).`);
  slog(`[hedgebot] ⚙️  Resolution: official Gamma > high-confidence live price (>=${HIGH_CONF_PRICE}) > ${Math.round(RESOLUTION_FALLBACK_MS / 1000)}s live-price fallback — each leg resolves independently, combined P&L booked once both are done.`);
  slog(`[hedgebot] ⚙️  Starting bankroll $${STARTING_CAPITAL} (shared across BTC+ETH) | taker fee rate ${TAKER_FEE_RATE} | never enters a window it joins mid-way through`);
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
