'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 5-MINUTE LADDER ENGINE — INDEPENDENT UP / DOWN RUNG LADDERS
 * ═══════════════════════════════════════════════════════════════
 *
 *  Only BTC's 5-minute Up/Down market trades. ETH and BTC's 15-min
 *  market are not touched.
 *
 *  ── STRATEGY ──
 *  UP and DOWN each run their own independent 4-rung ladder — there
 *  is no shared side, no timers, no dip logic, no switching. At the
 *  moment a window opens, both ladders place all 4 of their resting
 *  limit buy orders immediately:
 *
 *      Rung   Entry   Take-profit   Shares
 *      1      0.45    0.85          50
 *      2      0.35    0.75          73
 *      3      0.25    0.65          118
 *      4      0.15    0.55          232
 *
 *  Shares are sized so that entry_price × take_profit_price × shares
 *  is constant across all 4 rungs (probability-weighted by entry
 *  price, payout-weighted by take-profit price) — rung 1's 50 shares
 *  at 0.45×0.85 sets that constant; the other three rungs solve for
 *  it. Since deeper rungs are less likely to fill and need a bigger
 *  move to reach their take-profit, they carry more shares.
 *
 *  ── ORDER LIFECYCLE PER RUNG ──
 *  1. Entry: resting GTC limit buy at the rung's entry price.
 *  2. On fill: a resting GTC limit sell is placed at that rung's
 *     take-profit price for the filled shares.
 *  3. If the take-profit sell fills before window close: profit is
 *     realized immediately (proceeds − cost), rung closed.
 *  4. If the window closes with the entry filled but take-profit not
 *     hit: the take-profit order is cancelled and the position rides
 *     to window resolution instead — pays $1/share if that rung's
 *     side wins, $0 if it loses.
 *  5. Any entry order still unfilled at window close is cancelled.
 *
 *  UP's 4 rungs and DOWN's 4 rungs are entirely independent of each
 *  other — one side filling, TP'ing, or missing has no effect on the
 *  other side's rungs.
 *
 *  ── ORDER TYPE: RESTING GTC LIMIT (MAKER), NOT FOK ──
 *  Every entry and take-profit order is a GTC limit order. It rests
 *  until price trades through its level (fills as maker) or gets
 *  cancelled at window close.
 *
 *  FILL CONFIRMATION: every tick, every resting order is checked
 *  against the freshest live price on its side. Buys fill when the
 *  ask trades down to/through the limit; take-profit sells fill when
 *  the bid trades up to/through the limit.
 *    - LIVE: trader.reconcileToken(tokenId) confirms the real fill.
 *    - DEMO: the crossing itself is treated as the fill.
 *
 *  FEES / REBATES: 0% maker fee on every fill. Filled entries earn an
 *  estimated Maker Rebate per Polymarket's published Crypto-category
 *  model: fee_equivalent = shares × 0.07 × price × (1-price); estimated
 *  rebate = fee_equivalent × 20%. Tracked separately from trading P&L.
 *  Source: docs.polymarket.com/market-makers/maker-rebates
 *
 *  RESOLUTION (only for rungs still open — entry filled, no TP — at
 *  window close): three tiers, fastest wins:
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
 *    trader.placeLimitOrder(tokenId, 'BUY'|'SELL', price, size) -> { id, isFilled, avgPrice, raw }   [GTC]
 *    trader.reconcileToken(tokenId)                             -> { filledShares, avgPrice, orderId } | null
 *    trader.cancelOrder(orderId)                                 -> optional, best-effort at window close
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

// ── Ladder rungs — identical set used independently on both UP and DOWN.
const LADDER_BASE_SHARES = Number(process.env.LADDER_BASE_SHARES || 50);
const RUNG_DEFS = [
  { id: 1, price: 0.45, tp: 0.85 },
  { id: 2, price: 0.35, tp: 0.75 },
  { id: 3, price: 0.25, tp: 0.65 },
  { id: 4, price: 0.15, tp: 0.55 },
];
// Size each rung so entry_price × tp_price × shares stays constant —
// rung 1 (base) fixes the constant at LADDER_BASE_SHARES.
const EV_CONSTANT = LADDER_BASE_SHARES * RUNG_DEFS[0].price * RUNG_DEFS[0].tp;
const RUNGS = RUNG_DEFS.map(r => ({
  ...r,
  shares: r.id === 1 ? LADDER_BASE_SHARES : Math.round(EV_CONSTANT / (r.price * r.tp)),
}));
const RUNG_IDS = RUNGS.map(r => r.id);

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
// de-facto winner immediately instead of waiting for RESOLUTION_FALLBACK_MS. (Only affects rungs
// still open at window close — filled entry, no take-profit hit.)
const HIGH_CONF_PRICE = Number(process.env.RESOLUTION_HIGH_CONF_PRICE || 0.90);

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function estimateMakerRebate(shares, price) {
  if (MAKER_REBATE_SHARE <= 0) return 0;
  const feeEquivalent = shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price);
  return round4(feeEquivalent * MAKER_REBATE_SHARE);
}
function sgn2(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
const SIDES = ['up', 'down'];

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
function traderHasRestingOrderMethods() {
  const ok = trader && typeof trader.placeLimitOrder === 'function';
  if (!ok && !warnedNoRestingMethod) {
    warnedNoRestingMethod = true;
    slog('[hedgebot] ❌ LIVE trading needs trader.placeLimitOrder(tokenId, side, price, size) [GTC] on polymarket-trader.js — LIVE order placement will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}

async function placeRestingLimitOrder(tokenId, orderSide, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasRestingOrderMethods()) return null;
    try {
      const resp = await trader.placeLimitOrder(tokenId, orderSide, price, shares);
      return {
        id: resp?.id || null,
        filledNow: !!resp?.isFilled,
        avgPrice: resp?.avgPrice || price,
        filledShares: resp?.isFilled ? shares : 0,
      };
    } catch (e) {
      log(`❌ placeRestingLimitOrder(${orderSide}) failed: ${describeOrderError(e)}`);
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
//  Trade — one 5-minute window. Each side (up/down) has its own
//  independent set of 4 ladder rungs.
// ─────────────────────────────────────────
function freshRungState(rungDef) {
  return {
    id: rungDef.id, entryPrice: rungDef.price, tpPrice: rungDef.tp, shares: rungDef.shares,
    entryOrder: null,      // { id, placedAt } while resting unfilled
    entryPlaced: false,    // whether we've attempted to place it this window
    position: null,        // set once entry fills: { shares, cost, rebate, entryPrice, ts, orderId }
    tpOrder: null,         // { id, placedAt } while TP resting unfilled
    closed: false,         // true once TP fills or resolution has paid this rung out
    exitMethod: null,      // 'take-profit' | 'resolution'
    pnl: null,
  };
}
function freshSideState() {
  return { rungs: RUNGS.map(freshRungState) };
}
function freshTrade(windowTs) {
  return {
    asset: ASSET_KEY, label: ASSET_LABEL, windowTs,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    leg: freshLeg(windowTs),
    state: 'discovering', // discovering -> trading -> pending-resolution -> resolved
    sides: { up: freshSideState(), down: freshSideState() },
    combinedPnl: null,
    settled: false,
  };
}

function tokenIdFor(leg, side) { return side === 'up' ? leg.upTokenId : leg.downTokenId; }

// Place all 8 entry orders (4 rungs × 2 sides) once, as soon as the leg
// is discovered and prices are available.
async function placeLadderEntries(trade) {
  const leg = trade.leg;
  for (const side of SIDES) {
    const tokenId = tokenIdFor(leg, side);
    if (!tokenId) continue;
    const ss = trade.sides[side];
    for (const rung of ss.rungs) {
      if (rung.entryPlaced) continue;
      rung.entryPlaced = true;
      const resp = await placeRestingLimitOrder(tokenId, 'BUY', rung.entryPrice, rung.shares);
      if (!resp) { log(`❌ [${trade.label} ${leg.slug}] ${side.toUpperCase()} rung${rung.id} entry order failed to place`); continue; }

      if (resp.filledNow && resp.filledShares > 0) {
        confirmEntryFill(trade, side, rung, { id: resp.id, side, tokenId, limitPrice: rung.entryPrice, shares: rung.shares }, resp.avgPrice, resp.filledShares);
        continue;
      }
      rung.entryOrder = { id: resp.id, tokenId, limitPrice: rung.entryPrice, shares: rung.shares, placedAt: Date.now() };
      log(`🧾 [${trade.label} ${leg.slug}] ${side.toUpperCase()} rung${rung.id} entry placed (GTC, maker) — ${rung.shares}sh @${rung.entryPrice.toFixed(2)} → TP ${rung.tpPrice.toFixed(2)}`);
    }
  }
}

function confirmEntryFill(trade, side, rung, order, avgPrice, filledShares) {
  const cost = round2(filledShares * avgPrice);
  const rebate = estimateMakerRebate(filledShares, avgPrice);
  rung.position = { shares: filledShares, cost, rebate, entryPrice: avgPrice, ts: Date.now(), orderId: order.id };
  rung.entryOrder = null;

  engine.bankroll = round2(engine.bankroll - cost + rebate);
  engine.estimatedRebates = round2(engine.estimatedRebates + rebate);

  registerTrade({ slug: trade.leg.slug, asset: trade.asset, step: `${side.toUpperCase()} rung${rung.id} entry fill`, side, price: avgPrice, shares: filledShares, cost, rebate });
  log(`✅ [${trade.label} ${trade.leg.slug}] ${side.toUpperCase()} rung${rung.id} entry FILLED — ${filledShares}sh @${avgPrice.toFixed(3)} ($${cost.toFixed(2)}, est. rebate +$${rebate.toFixed(4)}) | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

async function placeTakeProfitOrder(trade, side, rung) {
  const leg = trade.leg;
  const tokenId = tokenIdFor(leg, side);
  const pos = rung.position;
  if (!tokenId || !pos) return;

  const resp = await placeRestingLimitOrder(tokenId, 'SELL', rung.tpPrice, pos.shares);
  if (!resp) { log(`❌ [${trade.label} ${leg.slug}] ${side.toUpperCase()} rung${rung.id} take-profit order failed to place`); return; }

  if (resp.filledNow && resp.filledShares > 0) {
    confirmTakeProfitFill(trade, side, rung, resp.avgPrice);
    return;
  }
  rung.tpOrder = { id: resp.id, tokenId, limitPrice: rung.tpPrice, shares: pos.shares, placedAt: Date.now() };
  log(`🎯 [${trade.label} ${leg.slug}] ${side.toUpperCase()} rung${rung.id} take-profit resting — ${pos.shares}sh @${rung.tpPrice.toFixed(2)}`);
}

function confirmTakeProfitFill(trade, side, rung, exitPrice) {
  const pos = rung.position;
  const proceeds = round2(pos.shares * exitPrice);
  const pnl = round2(proceeds - pos.cost);

  engine.bankroll = round2(engine.bankroll + proceeds);
  engine.realizedPnl = round2(engine.realizedPnl + pnl);
  if (pnl >= 0) engine.wins++; else engine.losses++;

  rung.closed = true;
  rung.exitMethod = 'take-profit';
  rung.pnl = pnl;
  rung.tpOrder = null;

  registerTrade({ slug: trade.leg.slug, asset: trade.asset, step: `${side.toUpperCase()} rung${rung.id} take-profit fill`, side, price: exitPrice, shares: pos.shares, pnl });
  log(`💰 [${trade.label} ${trade.leg.slug}] ${side.toUpperCase()} rung${rung.id} TAKE-PROFIT FILLED — ${pos.shares}sh @${exitPrice.toFixed(3)} — ${sgn2(pnl)} | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();
}

// Checks every resting entry order (fills when ask trades down to/through
// limit) and every resting TP order (fills when bid trades up to/through
// limit), across both sides' rungs.
async function checkLadderOrders(trade) {
  const leg = trade.leg;
  for (const side of SIDES) {
    const ask = side === 'up' ? leg.upAsk : leg.downAsk;
    const bid = side === 'up' ? leg.upBid : leg.downBid;
    for (const rung of trade.sides[side].rungs) {
      // Entry fill check
      if (rung.entryOrder && ask != null) {
        const order = rung.entryOrder;
        const crossed = ask <= order.limitPrice + 1e-9;
        if (crossed) {
          if (DRY_RUN) {
            confirmEntryFill(trade, side, rung, order, order.limitPrice, order.shares);
            await placeTakeProfitOrder(trade, side, rung);
          } else if (trader && typeof trader.reconcileToken === 'function') {
            try {
              const rec = await trader.reconcileToken(order.tokenId);
              if (rec && rec.filledShares > 0) {
                confirmEntryFill(trade, side, rung, order, rec.avgPrice || order.limitPrice, rec.filledShares);
                await placeTakeProfitOrder(trade, side, rung);
              }
            } catch (e) {
              log(`⚠️  reconcileToken(${order.tokenId}) failed: ${e.message}`);
            }
          }
        }
      }
      // Take-profit fill check
      if (rung.tpOrder && bid != null) {
        const order = rung.tpOrder;
        const crossed = bid >= order.limitPrice - 1e-9;
        if (crossed) {
          if (DRY_RUN) {
            confirmTakeProfitFill(trade, side, rung, order.limitPrice);
          } else if (trader && typeof trader.reconcileToken === 'function') {
            try {
              const rec = await trader.reconcileToken(order.tokenId);
              if (rec && rec.filledShares > 0) {
                confirmTakeProfitFill(trade, side, rung, rec.avgPrice || order.limitPrice);
              }
            } catch (e) {
              log(`⚠️  reconcileToken(${order.tokenId}) failed: ${e.message}`);
            }
          }
        }
      }
    }
  }
}

// At window close: cancel unfilled entry orders outright (never filled,
// nothing to resolve). Cancel unfilled TP orders too, but the underlying
// position (if entry filled) rides forward to resolution.
async function expireLadderOrders(trade) {
  for (const side of SIDES) {
    for (const rung of trade.sides[side].rungs) {
      if (rung.entryOrder) {
        log(`⌛ [${trade.label} ${trade.leg.slug}] ${side.toUpperCase()} rung${rung.id} entry expired unfilled — ${rung.entryOrder.shares}sh @${rung.entryOrder.limitPrice.toFixed(2)}`);
        await cancelRestingOrder(rung.entryOrder.id);
        rung.entryOrder = null;
      }
      if (rung.tpOrder) {
        log(`⌛ [${trade.label} ${trade.leg.slug}] ${side.toUpperCase()} rung${rung.id} take-profit unfilled at window close — carrying position to resolution`);
        await cancelRestingOrder(rung.tpOrder.id);
        rung.tpOrder = null;
      }
    }
  }
}

function openRungs(trade) {
  const out = [];
  for (const side of SIDES) {
    for (const rung of trade.sides[side].rungs) {
      if (rung.position && !rung.closed) out.push({ side, rung });
    }
  }
  return out;
}
function hasAnyPosition(trade) {
  for (const side of SIDES) {
    for (const rung of trade.sides[side].rungs) {
      if (rung.position) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────
//  Unrealized P&L helpers (open rungs only — entry filled, not yet
//  closed by take-profit or resolution)
// ─────────────────────────────────────────
function unrealizedForTrade(trade) {
  if (!trade || !trade.leg || trade.leg.resolved) return 0;
  return round2(openRungs(trade).reduce((sum, { side, rung }) => {
    const mp = markPrice(trade.leg, side);
    const mark = mp != null ? mp : (rung.position.cost / rung.position.shares);
    return sum + (rung.position.shares * mark - rung.position.cost);
  }, 0));
}
function openCostForTrade(trade) {
  if (!trade) return 0;
  return round2(openRungs(trade).reduce((s, { rung }) => s + rung.position.cost, 0));
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
//  Settlement — pays out any rung that got its entry filled but never
//  hit take-profit: $1/share if that rung's side won, $0 if it lost.
//  Take-profit exits were already realized live and are untouched here.
// ─────────────────────────────────────────
function settleTrade(trade) {
  const leg = trade.leg;
  let resolutionPnl = 0;
  const perSide = { up: { fills: 0, shares: 0, pnl: 0, tpPnl: 0 }, down: { fills: 0, shares: 0, pnl: 0, tpPnl: 0 } };

  for (const side of SIDES) {
    for (const rung of trade.sides[side].rungs) {
      if (!rung.position) continue;
      perSide[side].fills++;
      perSide[side].shares += rung.position.shares;
      if (rung.exitMethod === 'take-profit') {
        perSide[side].tpPnl = round2(perSide[side].tpPnl + rung.pnl);
        continue;
      }
      // Still open at window close — settle by resolution.
      const win = side === leg.winner;
      const payout = win ? round2(rung.position.shares * 1) : 0;
      const pnl = round2(payout - rung.position.cost);
      engine.bankroll = round2(engine.bankroll + payout);
      resolutionPnl = round2(resolutionPnl + pnl);
      rung.closed = true;
      rung.exitMethod = 'resolution';
      rung.pnl = pnl;
      perSide[side].pnl = round2(perSide[side].pnl + pnl);
      if (pnl >= 0) engine.wins++; else engine.losses++;
    }
  }

  const tpPnl = round2(perSide.up.tpPnl + perSide.down.tpPnl);
  const combinedPnl = round2(resolutionPnl + tpPnl);

  trade.combinedPnl = combinedPnl;
  trade.state = 'resolved';
  trade.settled = true;
  engine.realizedPnl = round2(engine.realizedPnl + resolutionPnl); // TP pnl was already added to realizedPnl at fill time

  registerTrade({ slug: leg.slug, asset: trade.asset, step: 'window resolution', side: leg.winner, price: 1, shares: perSide.up.shares + perSide.down.shares, pnl: resolutionPnl });

  engine.history.unshift({
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, slug: leg.slug,
    winner: leg.winner, resolutionMethod: leg.resolutionMethod,
    up: perSide.up, down: perSide.down,
    combinedPnl, resolvedAt: Date.now(),
  });
  if (engine.history.length > 300) engine.history.pop();

  log(`🏆 [${trade.label} ${leg.slug}] window resolved — winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — UP ${perSide.up.fills} fill(s) [${sgn2(round2(perSide.up.pnl + perSide.up.tpPnl))}] + DOWN ${perSide.down.fills} fill(s) [${sgn2(round2(perSide.down.pnl + perSide.down.tpPnl))}] = ${sgn2(combinedPnl)} | bankroll=$${engine.bankroll.toFixed(2)}`);
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
      await expireLadderOrders(trade);
      if (hasAnyPosition(trade) && !trade.settled) {
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
    log(`🆕 [BTC] new 5m window t=${windowTs} — discovering market… ladder ready on both sides (4 rungs each: ${RUNGS.map(r => `${r.price.toFixed(2)}→${r.tp.toFixed(2)}/${r.shares}sh`).join(', ')})`);
  }

  if (!trade.leg.discovered && now - trade.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
    trade.leg.lastDiscoveryAttempt = now;
    await discoverLeg(trade.leg);
    if (trade.leg.discovered) trade.state = 'trading';
  }

  if (trade.state === 'trading') {
    if (engine.tradingEnabled && now < trade.closeAt) {
      await placeLadderEntries(trade);
      await checkLadderOrders(trade);
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
function rungSummary(rung) {
  return {
    id: rung.id, entryPrice: rung.entryPrice, tpPrice: rung.tpPrice, shares: rung.shares,
    entryPending: !!rung.entryOrder, entryFilled: !!rung.position,
    tpPending: !!rung.tpOrder, closed: rung.closed, exitMethod: rung.exitMethod, pnl: rung.pnl,
  };
}
function sideSummary(trade, side) {
  const ss = trade.sides[side];
  return {
    side,
    rungs: ss.rungs.map(rungSummary),
    filledCount: ss.rungs.filter(r => r.position).length,
    closedCount: ss.rungs.filter(r => r.closed).length,
    realizedPnl: round2(ss.rungs.reduce((s, r) => s + (r.pnl || 0), 0)),
  };
}
function tradeSummary(trade) {
  if (!trade) return null;
  return {
    asset: trade.asset, label: trade.label, windowTs: trade.windowTs, closeAt: trade.closeAt, state: trade.state,
    leg: legSummary(trade.leg),
    sides: { up: sideSummary(trade, 'up'), down: sideSummary(trade, 'down') },
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
    rungs: RUNGS,
  };
}
function getStatus() { return buildState(); }

function pauseTrading() {
  engine.tradingEnabled = false;
  log('⏸️  Trading paused — no new ladder orders will be placed; already-resting orders and open positions still tracked to fill/resolution, window discovery/rollover keeps running');
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
  slog('[hedgebot] 🪙 BTC 5-Minute Ladder Engine (independent UP/DOWN, 4-rung buy-ladder + take-profit) — fully automatic');
  slog(`[hedgebot] ⚙️  Rungs (both sides, independent): ${RUNGS.map(r => `#${r.id} entry ${r.price.toFixed(2)} → TP ${r.tp.toFixed(2)} (${r.shares}sh)`).join(' | ')}`);
  slog(`[hedgebot] ⚙️  Sizing: entry_price × tp_price × shares held constant across rungs, anchored at rung 1 = ${LADDER_BASE_SHARES}sh.`);
  slog(`[hedgebot] ⚙️  All orders are GTC resting limits (maker, 0% fee), not FOK. Entry fills trigger an immediate take-profit sell at that rung's TP price; if TP doesn't hit by window close, the position settles at resolution instead.`);
  slog(`[hedgebot] ⚙️  Est. Maker Rebate: Crypto category pays back ${(MAKER_REBATE_SHARE * 100).toFixed(0)}% of shares×${CRYPTO_TAKER_FEE_RATE}×price×(1-price) per entry fill — tracked separately from trading P&L.`);
  slog(`[hedgebot] ⚙️  Resolution (only for rungs still open at close): official Gamma > high-confidence live price (>=${HIGH_CONF_PRICE}) > ${Math.round(RESOLUTION_FALLBACK_MS / 1000)}s live-price fallback.`);
  slog(`[hedgebot] ⚙️  Starting bankroll $${STARTING_CAPITAL} | never joins a window it starts mid-way through`);
  if (RUNGS.some(r => r.shares < MIN_ORDER_SHARES)) {
    slog(`[hedgebot] ⚠️  A rung's share size is below Polymarket's ${MIN_ORDER_SHARES}sh minimum order size — that order would be rejected.`);
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
