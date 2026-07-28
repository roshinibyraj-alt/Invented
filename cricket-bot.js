'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 5-MINUTE MOMENTUM BUCKET ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 *  Only BTC's 5-minute Up/Down market trades. ETH and BTC's 15-min
 *  market are not touched.
 *
 *  ── STRATEGY ──
 *  Two independent capital buckets: UP_BUCKET and DOWN_BUCKET, each
 *  starting at $1000.
 *
 *  Whichever side won the PREVIOUS window is "active" for the NEXT
 *  window — its bucket trades, the other bucket is paused (no bet
 *  placed from it at all that window). This is a pure momentum /
 *  streak-following approach: keep betting the side that just won.
 *
 *  SIZING: the active bucket's *current* balance ÷ 10 is the dollar
 *  wager for that window. This is recalculated every window from
 *  whatever the bucket's live balance is — not a fixed dollar amount.
 *
 *  EXECUTION: a single market/taker buy, placed immediately at the
 *  current ask price for the active side, sized to the wager amount
 *  (wager ÷ ask price = shares). No resting orders, no take-profit,
 *  no rungs — one shot per window, held to resolution.
 *
 *  SETTLEMENT:
 *    - WIN  (active side wins again): the wagered capital + the
 *      profit from this trade (i.e. the full $1/share payout) moves
 *      OUT of the active bucket and INTO the opposite bucket. The
 *      winning bucket keeps shrinking (by exporting its winnings)
 *      while the paused bucket grows, until the streak breaks.
 *    - LOSS (active side loses): the wager is simply gone. The active
 *      bucket's balance drops by the wager amount; nothing moves to
 *      the other bucket.
 *  Either way, whichever side actually won this window becomes the
 *  active side for the next window.
 *
 *  BOOTSTRAP: the very first tracked window has no prior winner, so
 *  no bet is placed at all — the bot just watches it resolve, and
 *  starts betting from the following window onward.
 *
 *  RESOLUTION (unchanged plumbing): three tiers, fastest wins:
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
 *    trader.placeLimitOrder(tokenId, 'BUY'|'SELL', price, size) -> { id, isFilled, avgPrice, raw }
 *    trader.reconcileToken(tokenId)                             -> { filledShares, avgPrice, orderId } | null
 *    trader.cancelOrder(orderId)                                -> optional, best-effort
 *
 *  NOTE: placeLimitOrder is priced right at the current ask to emulate
 *  an immediate taker fill (this strategy wants market/taker execution,
 *  not resting maker orders). If your trader library exposes a real
 *  market/FOK order method, swap it in for stricter semantics.
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

// ── Two-bucket momentum strategy config ──
const BUCKET_STARTING_CAPITAL = Number(process.env.HEDGE_BUCKET_CAPITAL || 1000);
const BUCKET_DIVISOR = Number(process.env.HEDGE_BUCKET_DIVISOR || 10);

// Polymarket's live minimum order size on these crypto Up/Down markets
// (confirmed via Gamma: orderMinSize: 5) — any order under this is rejected.
const MIN_ORDER_SHARES = Number(process.env.HEDGE_MIN_ORDER_SHARES || 5);

let DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const MAX_PENDING_RESOLUTIONS = 40;

// If price crosses this threshold (or its complement) in the live book, treat that side as the
// de-facto winner immediately instead of waiting for RESOLUTION_FALLBACK_MS.
const HIGH_CONF_PRICE = Number(process.env.RESOLUTION_HIGH_CONF_PRICE || 0.90);

function round2(n) { return Math.round(n * 100) / 100; }
function sgn2(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
const SIDES = ['up', 'down'];
function oppositeSide(side) { return side === 'up' ? 'down' : 'up'; }

let emitFn = () => {};
let slog = () => {};
let trader = null;
let warnedNoRestingMethod = false;
let tradeSeq = 0;

const engine = {
  tradingEnabled: true,
  buckets: { up: BUCKET_STARTING_CAPITAL, down: BUCKET_STARTING_CAPITAL },
  lastWinner: null, // side that won the most recently settled window — determines next window's active side. null = bootstrap, no bet yet.
  realizedPnl: 0,
  wins: 0, losses: 0,
  current: { btc: null },
  pending: [],
  history: [],
  logs: [],
  trades: [],
  equityCurve: [{ t: Date.now(), equity: BUCKET_STARTING_CAPITAL * 2 }],
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
  engine.equityCurve.push({ t: Date.now(), equity: round2(bankrollTotal() + openPositionsMTM()) });
  if (engine.equityCurve.length > 1000) engine.equityCurve.shift();
}
function bankrollTotal() { return round2(engine.buckets.up + engine.buckets.down); }

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
    slog('[hedgebot] ❌ LIVE trading needs trader.placeLimitOrder(tokenId, side, price, size) on polymarket-trader.js — LIVE order placement will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}

let warnedNoCancelMethod = false;
async function cancelRestingOrder(orderId) {
  if (DRY_RUN || !orderId) return;
  if (!trader || typeof trader.cancelOrder !== 'function') {
    if (!warnedNoCancelMethod) { warnedNoCancelMethod = true; slog('[hedgebot] ⚠️  trader.cancelOrder not implemented — any non-immediate order will just be left for Polymarket to handle.'); }
    return;
  }
  try { await trader.cancelOrder(orderId); } catch (e) { log(`⚠️  cancelRestingOrder(${orderId}) failed: ${e.message}`); }
}

// Places a single marketable buy priced at the current ask, meant to fill
// immediately as a taker. Not a resting order — if it doesn't fill right
// away in LIVE mode, it's cancelled rather than left resting on the book.
async function placeTakerBuy(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasRestingOrderMethods()) return null;
    try {
      const resp = await trader.placeLimitOrder(tokenId, 'BUY', price, shares);
      if (resp?.isFilled) {
        return { id: resp.id || null, filledNow: true, avgPrice: resp.avgPrice || price, filledShares: shares };
      }
      if (resp?.id) await cancelRestingOrder(resp.id);
      return { id: null, filledNow: false, avgPrice: price, filledShares: 0 };
    } catch (e) {
      log(`❌ placeTakerBuy(${tokenId}) failed: ${describeOrderError(e)}`);
      return null;
    }
  }
  return { id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filledNow: true, avgPrice: price, filledShares: shares };
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
//  (Market-data plumbing — unchanged by strategy.)
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

// FAST PATH: resolves a window the instant it closes, using the live price
// already cached from the last ~1s of refreshLegPrices polling (i.e. the
// final couple of seconds before window end) — no waiting on Polymarket's
// official settlement or a multi-poll high-confidence streak. This is what
// lets the NEXT window's active bucket be picked correctly, synchronously,
// before that next window is even created — see tickBtc.
async function attemptFastResolution(leg) {
  if (leg.resolved) return true;
  if (!leg.upTokenId || !leg.downTokenId) return false; // never discovered — nothing to sample
  await refreshLegPrices(leg); // one last refresh right at close for the freshest possible read
  const upP = markPrice(leg, 'up');
  const downP = markPrice(leg, 'down');
  if (upP == null && downP == null) return false;
  leg.resolved = true;
  leg.winner = (upP != null ? upP : 0) >= (downP != null ? downP : 0) ? 'up' : 'down';
  leg.resolutionMethod = 'final-price';
  log(`⚡ [${leg.slug}] resolved FINAL-PRICE at window close (up ${upP != null ? upP.toFixed(3) : '—'} / down ${downP != null ? downP.toFixed(3) : '—'}) — winner ${leg.winner.toUpperCase()}`);
  return true;
}

// SLOW PATH (fallback only): used for the rare case a window couldn't be
// fast-resolved at close (e.g. market discovery never completed in time).
// Kept as a safety net via the async pending-resolution queue.
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
//  Trade — one 5-minute window. At most one bet: the active bucket's
//  side, sized at bucket-balance ÷ BUCKET_DIVISOR, bought immediately
//  at the current ask and held to resolution.
// ─────────────────────────────────────────
function tokenIdFor(leg, side) { return side === 'up' ? leg.upTokenId : leg.downTokenId; }

function freshTrade(windowTs) {
  return {
    asset: ASSET_KEY, label: ASSET_LABEL, windowTs,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    leg: freshLeg(windowTs),
    state: 'discovering', // discovering -> trading -> pending-resolution -> resolved
    activeSide: engine.lastWinner, // side whose bucket is active this window; null = bootstrap, no bet
    betPlaced: false,   // true once we've attempted (successfully or terminally) to place this window's bet
    skipReason: null,   // set if activeSide is set but we never got a fill (no price, bucket too small, etc.)
    position: null,     // { shares, cost, entryPrice, ts } once filled
    pnl: null,          // realized pnl once resolved (null if no bet was placed)
    settled: false,
  };
}

// Attempts the window's single bet, once the active side's ask price is
// available. Retries each tick until either it fills, the bucket/shares
// come back too small to trade, or the window closes.
async function placeBucketBet(trade) {
  if (trade.betPlaced || !trade.activeSide) return;
  const leg = trade.leg;
  const side = trade.activeSide;
  const tokenId = tokenIdFor(leg, side);
  const ask = side === 'up' ? leg.upAsk : leg.downAsk;
  if (!tokenId || ask == null) return; // wait for price to become available

  const bucketBalance = engine.buckets[side];
  const wagerDollars = round2(bucketBalance / BUCKET_DIVISOR);
  if (wagerDollars <= 0) {
    trade.betPlaced = true;
    trade.skipReason = 'bucket empty';
    log(`⚠️  [${trade.label} ${leg.slug}] ${side.toUpperCase()} bucket is $0 — no bet this window`);
    return;
  }

  const shares = round2(wagerDollars / ask);
  if (shares < MIN_ORDER_SHARES) {
    trade.betPlaced = true;
    trade.skipReason = 'below-min-shares';
    log(`⚠️  [${trade.label} ${leg.slug}] ${side.toUpperCase()} wager $${wagerDollars.toFixed(2)} @${ask.toFixed(3)} = ${shares.toFixed(2)}sh, below Polymarket's ${MIN_ORDER_SHARES}sh minimum — no bet this window`);
    return;
  }

  const resp = await placeTakerBuy(tokenId, ask, shares);
  if (!resp) { log(`❌ [${trade.label} ${leg.slug}] ${side.toUpperCase()} bucket bet failed to place — will retry`); return; }
  if (!resp.filledNow) { log(`⌛ [${trade.label} ${leg.slug}] ${side.toUpperCase()} bucket bet didn't fill immediately — will retry`); return; }

  trade.betPlaced = true;
  const avgPrice = resp.avgPrice || ask;
  const filledShares = resp.filledShares || shares;
  const cost = round2(filledShares * avgPrice);

  trade.position = { shares: filledShares, cost, entryPrice: avgPrice, ts: Date.now() };
  engine.buckets[side] = round2(engine.buckets[side] - cost);

  registerTrade({ slug: leg.slug, asset: trade.asset, step: `${side.toUpperCase()} bucket bet`, side, price: avgPrice, shares: filledShares, cost });
  log(`✅ [${trade.label} ${leg.slug}] ${side.toUpperCase()} bucket bet placed — ${filledShares.toFixed(2)}sh @${avgPrice.toFixed(3)} ($${cost.toFixed(2)}) | ${side} bucket now $${engine.buckets[side].toFixed(2)} (${oppositeSide(side)} bucket paused at $${engine.buckets[oppositeSide(side)].toFixed(2)})`);
  recordEquity();
}

// ─────────────────────────────────────────
//  Unrealized P&L helpers (the one open position, if any, on a trade
//  that's placed a bet but isn't resolved yet)
// ─────────────────────────────────────────
function unrealizedForTrade(trade) {
  if (!trade || !trade.position || trade.settled || (trade.leg && trade.leg.resolved)) return 0;
  const mp = markPrice(trade.leg, trade.activeSide);
  const mark = mp != null ? mp : (trade.position.cost / trade.position.shares);
  return round2(trade.position.shares * mark - trade.position.cost);
}
function openCostForTrade(trade) { return trade && trade.position ? trade.position.cost : 0; }
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
//  Settlement
// ─────────────────────────────────────────
function settleTrade(trade) {
  const leg = trade.leg;

  // Whoever actually won becomes the active side for the *next* window,
  // regardless of whether we had a bet placed this window.
  engine.lastWinner = leg.winner;

  if (!trade.activeSide || !trade.position) {
    trade.state = 'resolved';
    trade.settled = true;
    trade.pnl = 0;
    const reason = !trade.activeSide ? 'bootstrap window — no prior winner yet' : `no bet placed (${trade.skipReason || 'no fill'})`;
    registerTrade({ slug: leg.slug, asset: trade.asset, step: 'window resolution (no bet)', side: leg.winner, price: null, shares: 0, pnl: 0 });
    engine.history.unshift({
      asset: trade.asset, label: trade.label, windowTs: trade.windowTs, slug: leg.slug,
      winner: leg.winner, resolutionMethod: leg.resolutionMethod,
      activeSide: trade.activeSide, betPlaced: false, win: null, wager: 0, shares: 0, pnl: 0,
      bucketsAfter: { up: engine.buckets.up, down: engine.buckets.down },
      resolvedAt: Date.now(),
    });
    if (engine.history.length > 300) engine.history.pop();
    log(`🏁 [${trade.label} ${leg.slug}] resolved — winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — ${reason} | ${leg.winner.toUpperCase()} bucket now active next window`);
    recordEquity();
    return;
  }

  const side = trade.activeSide;
  const win = side === leg.winner;
  const payout = win ? round2(trade.position.shares * 1) : 0;
  const pnl = round2(payout - trade.position.cost);

  if (win) {
    const opp = oppositeSide(side);
    engine.buckets[opp] = round2(engine.buckets[opp] + payout);
  }
  // Loss: the wager is already gone from the active bucket (debited at bet time) — nothing else happens.

  engine.realizedPnl = round2(engine.realizedPnl + pnl);
  if (win) engine.wins++; else engine.losses++;

  trade.pnl = pnl;
  trade.state = 'resolved';
  trade.settled = true;

  registerTrade({ slug: leg.slug, asset: trade.asset, step: 'window resolution', side: leg.winner, price: 1, shares: trade.position.shares, pnl });

  engine.history.unshift({
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, slug: leg.slug,
    winner: leg.winner, resolutionMethod: leg.resolutionMethod,
    activeSide: side, betPlaced: true, win, wager: trade.position.cost, shares: trade.position.shares, entryPrice: trade.position.entryPrice, pnl,
    bucketsAfter: { up: engine.buckets.up, down: engine.buckets.down },
    resolvedAt: Date.now(),
  });
  if (engine.history.length > 300) engine.history.pop();

  log(`🏆 [${trade.label} ${leg.slug}] resolved — winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — our ${side.toUpperCase()} bet ${win ? 'WON' : 'LOST'} ${sgn2(pnl)} | UP bucket $${engine.buckets.up.toFixed(2)} / DOWN bucket $${engine.buckets.down.toFixed(2)}`);
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
    if (trade && !trade.settled) {
      // Try to resolve THIS window right now, using the live price from the
      // last couple of seconds before close — this must happen BEFORE the
      // next window is created below, or the next window's active bucket
      // will be picked using a stale (one-window-old) winner.
      if (!trade.leg.resolved) await attemptFastResolution(trade.leg);
      if (trade.leg.resolved && !trade.settled) {
        settleTrade(trade); // updates engine.lastWinner synchronously, in time for freshTrade() below
      } else {
        // Fast path had no price to sample (e.g. market discovery never completed in
        // time) — fall back to the async official/high-confidence/price-fallback queue.
        // Note: in this rare case the *next* window may still start one window stale,
        // since we can't know the winner yet.
        if (trade.activeSide && !trade.position) {
          log(`⚠️  [${trade.label} ${trade.leg.slug}] window closed with ${trade.activeSide.toUpperCase()} bucket active but no bet got filled — bucket unaffected`);
        }
        log(`⚠️  [${trade.label} ${trade.leg.slug}] couldn't fast-resolve at close (no price sample) — falling back to slower resolution; next window's active side may lag by one window this time`);
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
    const activeMsg = trade.activeSide
      ? `${trade.activeSide.toUpperCase()} bucket ACTIVE ($${engine.buckets[trade.activeSide].toFixed(2)} → wager $${(engine.buckets[trade.activeSide] / BUCKET_DIVISOR).toFixed(2)}), ${oppositeSide(trade.activeSide).toUpperCase()} bucket paused at $${engine.buckets[oppositeSide(trade.activeSide)].toFixed(2)}`
      : 'no prior winner yet — bootstrap window, no bet will be placed';
    log(`🆕 [BTC] new 5m window t=${windowTs} — discovering market… ${activeMsg}`);
  }

  if (!trade.leg.discovered && now - trade.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
    trade.leg.lastDiscoveryAttempt = now;
    await discoverLeg(trade.leg);
    if (trade.leg.discovered) trade.state = 'trading';
  }

  if (trade.state === 'trading') {
    if (engine.tradingEnabled && now < trade.closeAt && trade.activeSide && !trade.betPlaced) {
      await placeBucketBet(trade);
    }
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
function tradeSummary(trade) {
  if (!trade) return null;
  return {
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, closeAt: trade.closeAt, state: trade.state,
    leg: legSummary(trade.leg),
    activeSide: trade.activeSide,
    betPlaced: trade.betPlaced,
    skipReason: trade.skipReason,
    position: trade.position ? { shares: trade.position.shares, cost: trade.position.cost, entryPrice: trade.position.entryPrice } : null,
    pnl: trade.pnl,
    unrealizedPnl: unrealizedForTrade(trade),
  };
}

function buildState() {
  const unrealizedPnl = totalUnrealizedPnl();
  const bankroll = bankrollTotal();
  const equity = round2(bankroll + openPositionsMTM());
  return {
    dryRun: DRY_RUN,
    tradingEnabled: engine.tradingEnabled,
    waitingForBoundary: engine.waitingForBoundary,
    buckets: { up: engine.buckets.up, down: engine.buckets.down },
    bucketStartingCapital: BUCKET_STARTING_CAPITAL,
    bucketDivisor: BUCKET_DIVISOR,
    lastWinner: engine.lastWinner,
    bankroll, realizedPnl: engine.realizedPnl, unrealizedPnl, equity,
    wins: engine.wins, losses: engine.losses,
    current: { btc: tradeSummary(engine.current.btc) },
    pendingResolutionCount: engine.pending.length,
    pending: engine.pending.map(tradeSummary),
    history: engine.history.slice(0, 60),
    trades: engine.trades.slice(-100).slice().reverse(),
    equityCurve: engine.equityCurve,
    logs: engine.logs.slice(-80),
    windowSeconds: WINDOW_SECONDS,
  };
}
function getStatus() { return buildState(); }

function pauseTrading() {
  engine.tradingEnabled = false;
  log('⏸️  Trading paused — no new bucket bets will be placed; any already-filled position still tracked to resolution, window discovery/rollover keeps running');
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
  slog('[hedgebot] 🪙 BTC 5-Minute Momentum Bucket Engine — fully automatic');
  slog(`[hedgebot] ⚙️  Two buckets, $${BUCKET_STARTING_CAPITAL} each: UP and DOWN. Whichever side won the previous window is active next window; the other bucket is paused.`);
  slog(`[hedgebot] ⚙️  Sizing: active bucket's live balance ÷ ${BUCKET_DIVISOR} = this window's wager. Single market/taker buy at the current ask, held to resolution — no rungs, no take-profit.`);
  slog(`[hedgebot] ⚙️  On a win: wager + profit (full payout) moves OUT of the active bucket INTO the opposite bucket. On a loss: the wager is simply gone from the active bucket.`);
  slog(`[hedgebot] ⚙️  Bootstrap: the first tracked window has no prior winner, so no bet is placed — betting starts from the following window.`);
  slog(`[hedgebot] ⚙️  Resolution: the live price right at window close (last couple of seconds) determines the winner immediately, so the next window's active bucket is never stale. Official Gamma / high-confidence / ${Math.round(RESOLUTION_FALLBACK_MS / 1000)}s price-fallback are kept only as a safety net for the rare case a market wasn't discovered in time.`);
  slog(`[hedgebot] ⚙️  Starting capital $${BUCKET_STARTING_CAPITAL * 2} total ($${BUCKET_STARTING_CAPITAL} per bucket) | never joins a window it starts mid-way through`);
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
