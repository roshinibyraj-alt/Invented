'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC + ETH 5-MINUTE RUNG MARTINGALE ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 *  Trades Polymarket's BTC and ETH "Up or Down" 5-minute markets.
 *  For EACH asset independently, the instant a window's market goes
 *  live, the engine places SIX resting limit BUY orders (not
 *  aggressive/crossing-the-spread — real resting limit orders):
 *
 *      Rung 0.10:  buy Up @ 0.10   +   buy Down @ 0.10
 *      Rung 0.20:  buy Up @ 0.20   +   buy Down @ 0.20
 *      Rung 0.33:  buy Up @ 0.33   +   buy Down @ 0.33
 *
 *  Each rung is fully independent of the other rungs, and BTC/ETH
 *  are independent of each other — 6 separate martingale tracks:
 *  BTC-0.10, BTC-0.20, BTC-0.33, ETH-0.10, ETH-0.20, ETH-0.33.
 *
 *  FILL / CANCEL: the instant one side of a rung fills, the engine
 *  cancels the still-resting order on the OTHER side of that SAME
 *  rung (e.g. BTC-Up-0.10 fills -> cancel BTC-Down-0.10). The filled
 *  position is held to settlement — no take-profit, no stop-loss.
 *  If neither side of a rung fills before the window closes, both
 *  orders are cancelled and no win/loss is recorded for that rung
 *  that window.
 *
 *  MARTINGALE (per rung, per asset, independent counters, compounding):
 *    Rung 0.10: every additional 7 consecutive losses -> double shares again
 *               (loss 7 -> x2, loss 14 -> x4, loss 21 -> x8, ...).
 *    Rung 0.20: every additional 4 consecutive losses -> double shares again.
 *    Rung 0.33: every additional 2 consecutive losses -> double shares again.
 *    Any win -> counter and share size reset to BASE_SHARES.
 *    Uncapped — doubling can compound indefinitely.
 *
 *  RESOLUTION: three tiers, fastest available wins:
 *    1. Official — Polymarket Gamma's `closed` + `outcomePrices` fields.
 *    2. High-confidence live price — if either side's live price crosses
 *       HIGH_CONF_PRICE (default 0.90), that side is treated as the
 *       de-facto winner immediately, without waiting on official
 *       confirmation. Checked continuously while trading and on every
 *       resolution poll afterward, so this usually resolves within
 *       seconds of the window closing (these 5-min crypto markets
 *       almost always trade to a near-certain extreme well before close).
 *    3. Live-price fallback — if neither of the above has resolved the
 *       window within RESOLUTION_FALLBACK_MS after close, use whichever
 *       side has the higher live price.
 *
 *  BTC and ETH windows for the same 5-minute slot resolve
 *  INDEPENDENTLY of each other.
 *
 *  STARTUP: if the bot is started mid-window, it will NOT jump into
 *  that window partway through — it waits for the next fresh
 *  5-minute boundary before placing any orders.
 *
 *  FEES: resting limit orders are treated as maker fills — $0 fee by
 *  default (RUNG_MAKER_FEE_RATE env var to override).
 *
 *  MAKER REBATES (estimated only): Polymarket's Maker Rebates Program pays
 *  makers a share of taker fees, settled daily on-chain in USDC — it is
 *  NOT reflected in the CLOB position P&L and can't be fetched via public
 *  API, so the dashboard shows an UPPER-BOUND estimate per fill using the
 *  Crypto category's published formula (fee_equivalent = shares * 0.07 *
 *  price * (1-price), rebate = fee_equivalent * 20%), assuming your order
 *  was the only maker liquidity taken. Real payouts are likely lower.
 *
 *  TRADER INTERFACE:
 *    trader.placeLimitBuy(tokenId, price, size) -> { id, filled, avgPrice, filledShares }
 *    trader.getOrder(orderId)                   -> { filled, avgPrice, filledShares }
 *    trader.cancelOrder(orderId)                -> (optional, needed for LIVE cancels)
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS             = 500;
const PRICE_REFRESH_MS    = 1000;
const DISCOVERY_RETRY_MS  = 2000;
const RESOLUTION_POLL_MS  = 3000;
const RESOLUTION_FALLBACK_MS = Number(process.env.BTC5M_RESOLUTION_FALLBACK_MS || 60000);
const WINDOW_SECONDS      = 300; // 5 minutes

const ASSETS = [
  { key: 'btc', label: 'BTC', slugPrefix: 'btc-updown-5m-' },
  { key: 'eth', label: 'ETH', slugPrefix: 'eth-updown-5m-' },
];

// The three independent rungs. lossThreshold = how many consecutive losses
// it takes to double the share size again (compounding every N further losses).
const RUNGS = [
  { key: 'r10', price: 0.10, label: '0.10', lossThreshold: 7 },
  { key: 'r20', price: 0.20, label: '0.20', lossThreshold: 4 },
  { key: 'r33', price: 0.33, label: '0.33', lossThreshold: 2 },
];

const BASE_SHARES = Number(process.env.RUNG_BASE_SHARES || 100);

let DRY_RUN = (process.env.BTC5M_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const STARTING_CAPITAL = Number(process.env.BTC5M_CAPITAL || 2000);
// Resting limit orders are maker fills by default -> $0 fee unless overridden.
const MAKER_FEE_RATE = Number(process.env.RUNG_MAKER_FEE_RATE || 0);
const MAX_PENDING_RESOLUTIONS = 40;

// Polymarket Maker Rebates Program (docs.polymarket.com/market-makers/maker-rebates) —
// BTC/ETH 5-minute markets fall under the "Crypto" category:
//   taker fee rate = 0.07, maker fee rate = 0 (makers pay nothing — matches MAKER_FEE_RATE default),
//   maker rebate share = 20% of the crypto category's taker-fee pool, distributed "fee-curve weighted":
//     fee_equivalent = shares * feeRate * price * (1 - price)
//     your_rebate    = (your_fee_equivalent / total_fee_equivalent_in_that_market) * rebate_pool
// We can't see the market-wide pool or other makers' volume via public endpoints, so we track
// an UPPER-BOUND estimate: fee_equivalent * rebate_share, i.e. "what you'd earn if your resting
// liquidity were the only maker liquidity taken in that market." Real payouts (paid daily in USDC
// on-chain) will be <= this estimate, often well below it in markets with competing makers.
const REBATE_FEE_RATE = Number(process.env.RUNG_REBATE_FEE_RATE || 0.07);   // Crypto category taker-fee rate
const REBATE_SHARE     = Number(process.env.RUNG_REBATE_SHARE || 0.20);     // Crypto category maker-rebate share
// If price crosses this threshold (or its complement) in the live book, treat that side as the
// de-facto winner immediately instead of waiting for RESOLUTION_FALLBACK_MS — these 5-min crypto
// up/down markets almost always trade to a near-certain extreme well before official close.
const HIGH_CONF_PRICE = Number(process.env.RESOLUTION_HIGH_CONF_PRICE || 0.90);

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function estimateFee(shares, price) {
  if (MAKER_FEE_RATE <= 0) return 0;
  return round2(shares * MAKER_FEE_RATE * price * (1 - price));
}
// Upper-bound estimate of the maker rebate earned on a single fill. See note above — real
// on-chain payout depends on total maker volume in that market and may be lower.
function estimateRebate(shares, price) {
  const feeEquivalent = shares * REBATE_FEE_RATE * price * (1 - price);
  return round4(feeEquivalent * REBATE_SHARE);
}

let emitFn = () => {};
let slog = () => {};
let trader = null;
let warnedNoLimitMethod = false;
let warnedNoCancelMethod = false;
let tradeSeq = 0;

function freshRungState() {
  const s = {};
  for (const r of RUNGS) s[r.key] = { consecutiveLosses: 0, currentShares: BASE_SHARES, doubleCount: 0 };
  return s;
}
function freshRebateState() {
  const s = {};
  for (const r of RUNGS) s[r.key] = 0;
  return s;
}

const engine = {
  tradingEnabled: true,
  bankroll: STARTING_CAPITAL,
  capital: STARTING_CAPITAL,
  realizedPnl: 0,
  feesPaid: 0,
  wins: 0, losses: 0,
  cycle: null,
  pending: [],
  history: [],   // resolved rung outcomes, most recent first
  logs: [],
  trades: [],
  equityCurve: [{ t: Date.now(), equity: STARTING_CAPITAL }],
  lastPriceFetch: 0,
  lastResolutionPoll: 0,
  waitingForBoundary: true,
  boundaryWindowTs: null,
  rungState: { btc: freshRungState(), eth: freshRungState() }, // martingale state, persists across windows
  estimatedRebateUsd: 0,   // upper-bound estimate, accrues on every maker fill (see estimateRebate)
  rebateByRung: { btc: freshRebateState(), eth: freshRebateState() },
};

// ─────────────────────────────────────────
//  Logging / bookkeeping
// ─────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  engine.logs.push(line);
  if (engine.logs.length > 500) engine.logs.shift();
  slog(`[rungbot] ${line}`);
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
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-rungbot/1.0' } });
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
    slog('[rungbot] ❌ LIVE trading needs trader.placeLimitBuy (and ideally getOrder/cancelOrder) on polymarket-trader.js — LIVE order placement will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}
async function placeRestingLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethod()) return null;
    try { return await trader.placeLimitBuy(tokenId, price, shares); }
    catch (e) { log(`❌ placeLimitBuy failed: ${describeOrderError(e)}`); return null; }
  }
  // DRY_RUN: simulate a resting order — it does NOT fill immediately here;
  // checkRungFills() decides fills tick-by-tick once the live ask reaches price.
  return { id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: false, avgPrice: price, filledShares: shares };
}
async function cancelResting(orderId) {
  if (!orderId) return;
  if (!DRY_RUN) {
    if (trader && typeof trader.cancelOrder === 'function') {
      try { await trader.cancelOrder(orderId); }
      catch (e) { log(`⚠️  cancelOrder(${orderId}) failed: ${describeOrderError(e)}`); }
    } else if (!warnedNoCancelMethod) {
      warnedNoCancelMethod = true;
      slog('[rungbot] ❌ trader.cancelOrder is not implemented on polymarket-trader.js — resting opposite-side limit orders will NOT be cancelled on-exchange in LIVE mode (they are marked cancelled internally and ignored, but may still be live on the book). Please add trader.cancelOrder(orderId).');
    }
  }
}

function parseMarketTokens(mk) {
  try {
    const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
    const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}

// ─────────────────────────────────────────
//  Window lifecycle
// ─────────────────────────────────────────
function currentWindowTs(nowSec) { return Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS; }

function freshRungLeg(price) {
  return { orderId: null, placed: false, filled: false, cancelled: false, price, shares: 0, fillPrice: null, cost: 0, fee: 0, rebate: 0 };
}
function freshRungPosition(rungDef) {
  return {
    key: rungDef.key, price: rungDef.price, label: rungDef.label,
    shares: null,          // size snapshotted from rungState at order-placement time
    status: 'idle',        // idle -> armed -> filled | closed
    filledSide: null,
    up: freshRungLeg(rungDef.price),
    down: freshRungLeg(rungDef.price),
    resolved: false,
    pnl: null,
  };
}
function freshAssetWindow(assetDef, windowTs) {
  const rungs = {};
  for (const r of RUNGS) rungs[r.key] = freshRungPosition(r);
  return {
    asset: assetDef.key,
    label: assetDef.label,
    windowTs,
    slug: `${assetDef.slugPrefix}${windowTs}`,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    status: 'discovering', // 'discovering' | 'trading' | 'resolved'
    conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, downAsk: null, upBid: null, downBid: null,
    rungs,
    ordersPlaced: false,
    lastDiscoveryAttempt: 0,
    createdAt: Date.now(),
    highConfSide: null,   // set once either side's live price crosses HIGH_CONF_PRICE
    highConfPrice: null,
    highConfAt: null,
  };
}

function freshCycle(windowTs) {
  return {
    windowTs,
    closeAt: (windowTs + WINDOW_SECONDS) * 1000,
    assets: {
      btc: freshAssetWindow(ASSETS[0], windowTs),
      eth: freshAssetWindow(ASSETS[1], windowTs),
    },
    createdAt: Date.now(),
  };
}

async function discoverAssetWindow(aw) {
  try {
    const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(aw.slug)}`);
    const event = Array.isArray(events) ? events[0] : null;
    if (!event) return;
    const mk = (event.markets || [])[0];
    if (!mk) return;
    const tokens = parseMarketTokens(mk);
    const up = tokens.find(t => /up/i.test(t.outcome));
    const down = tokens.find(t => /down/i.test(t.outcome));
    if (!up || !down || !up.token_id || !down.token_id) return;
    aw.conditionId = mk.conditionId || null;
    aw.upTokenId = up.token_id;
    aw.downTokenId = down.token_id;
    aw.status = 'trading';
    log(`🎯 ${aw.label} window ${aw.slug} discovered — Up ${String(up.token_id).slice(0, 10)}… / Down ${String(down.token_id).slice(0, 10)}…`);
  } catch (e) {
    log(`⚠️  discoverAssetWindow(${aw.slug}) failed: ${e.message}`);
  }
}

async function refreshAssetPrices(aw) {
  if (!aw.upTokenId || !aw.downTokenId) return;
  try {
    const [upAsk, upBid, downAsk, downBid] = await Promise.all([
      getJSON(`${CLOB}/price?token_id=${aw.upTokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${aw.upTokenId}&side=SELL`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${aw.downTokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${aw.downTokenId}&side=SELL`).catch(() => null),
    ]);
    if (upAsk?.price != null) aw.upAsk = parseFloat(upAsk.price);
    if (upBid?.price != null) aw.upBid = parseFloat(upBid.price);
    if (downAsk?.price != null) aw.downAsk = parseFloat(downAsk.price);
    if (downBid?.price != null) aw.downBid = parseFloat(downBid.price);
  } catch (_) {}
}

function affordable(shares, price) { return round2(shares * price) <= engine.bankroll; }

// If either side's live price has crossed HIGH_CONF_PRICE (default 0.90), lock in that side as
// the de-facto winner so resolution doesn't have to wait for RESOLUTION_FALLBACK_MS. Once set,
// a side is "sticky" for this window — it won't be un-set by a later price wobble.
function updateHighConfidence(aw) {
  if (aw.highConfSide) return;
  const upP = aw.upBid != null ? aw.upBid : aw.upAsk;
  const downP = aw.downBid != null ? aw.downBid : aw.downAsk;
  if (upP != null && upP >= HIGH_CONF_PRICE) {
    aw.highConfSide = 'up'; aw.highConfPrice = upP; aw.highConfAt = Date.now();
  } else if (downP != null && downP >= HIGH_CONF_PRICE) {
    aw.highConfSide = 'down'; aw.highConfPrice = downP; aw.highConfAt = Date.now();
  }
}

// ─────────────────────────────────────────
//  Rung order placement / fill / cancel
// ─────────────────────────────────────────
async function placeRungOrders(aw) {
  if (aw.ordersPlaced || !aw.upTokenId || !aw.downTokenId) return;
  aw.ordersPlaced = true;
  for (const r of RUNGS) {
    const rp = aw.rungs[r.key];
    const sizeState = engine.rungState[aw.asset][r.key];
    const shares = sizeState.currentShares;
    rp.shares = shares;
    rp.up.shares = shares;
    rp.down.shares = shares;

    const upResp = await placeRestingLimitBuy(aw.upTokenId, r.price, shares);
    rp.up.orderId = upResp ? upResp.id : null;
    rp.up.placed = !!upResp;

    const downResp = await placeRestingLimitBuy(aw.downTokenId, r.price, shares);
    rp.down.orderId = downResp ? downResp.id : null;
    rp.down.placed = !!downResp;

    rp.status = 'armed';
    log(`📌 [${aw.slug}] ${r.label} rung armed — resting buy ${shares}sh UP@${r.price.toFixed(2)} + ${shares}sh DOWN@${r.price.toFixed(2)} (consec.losses=${sizeState.consecutiveLosses})`);

    // an immediately-marketable LIVE order can come back already filled
    if (upResp && upResp.filled) await onRungFill(aw, r, 'up', upResp.avgPrice || r.price, upResp.filledShares || shares);
    if (downResp && downResp.filled && aw.rungs[r.key].status !== 'filled') await onRungFill(aw, r, 'down', downResp.avgPrice || r.price, downResp.filledShares || shares);
  }
}

async function onRungFill(aw, rungDef, side, fillPrice, filledShares) {
  const rp = aw.rungs[rungDef.key];
  const leg = rp[side];
  if (leg.filled || leg.cancelled) return; // already handled

  if (DRY_RUN && !affordable(filledShares, fillPrice)) {
    log(`⚠️  [${aw.slug}] ${rungDef.label} rung ${side.toUpperCase()}: insufficient bankroll ($${engine.bankroll.toFixed(2)}) to simulate fill — skipping this fill`);
    return;
  }

  const fee = estimateFee(filledShares, fillPrice);
  const cost = round2(filledShares * fillPrice);
  const rebate = estimateRebate(filledShares, fillPrice);
  engine.bankroll = round2(engine.bankroll - cost - fee);
  engine.feesPaid = round2(engine.feesPaid + fee);
  engine.estimatedRebateUsd = round4(engine.estimatedRebateUsd + rebate);
  engine.rebateByRung[aw.asset][rungDef.key] = round4(engine.rebateByRung[aw.asset][rungDef.key] + rebate);

  leg.filled = true;
  leg.fillPrice = fillPrice;
  leg.cost = cost;
  leg.fee = fee;
  leg.shares = filledShares;
  leg.rebate = rebate;

  registerTrade({ slug: aw.slug, asset: aw.asset, step: `${rungDef.label} rung fill`, side, price: fillPrice, shares: filledShares, cost, fee, rebate });

  if (rp.status === 'filled') {
    // rare race: both sides filled essentially simultaneously — keep both positions,
    // they'll net out at resolution (one wins, one loses).
    log(`⚠️  [${aw.slug}] ${rungDef.label} rung: ${side.toUpperCase()} ALSO filled after ${rp.filledSide.toUpperCase()} (race) — keeping both positions, no cancel needed`);
    recordEquity();
    return;
  }

  rp.status = 'filled';
  rp.filledSide = side;
  log(`✅ [${aw.slug}] ${rungDef.label} rung: ${side.toUpperCase()} filled ${filledShares}sh @ ${fillPrice.toFixed(2)} ($${cost.toFixed(2)}+$${fee.toFixed(4)} fee, ~$${rebate.toFixed(4)} est. rebate) — cancelling opposite side | bankroll=$${engine.bankroll.toFixed(2)}`);
  recordEquity();

  const otherSide = side === 'up' ? 'down' : 'up';
  const other = rp[otherSide];
  if (!other.filled && !other.cancelled && other.orderId) {
    await cancelResting(other.orderId);
    other.cancelled = true;
    log(`🚫 [${aw.slug}] ${rungDef.label} rung: cancelled ${otherSide.toUpperCase()} resting order (opposite side of filled ${side.toUpperCase()})`);
  }
}

// Called every tick while a window is trading — checks all armed rungs for fills.
async function checkRungFills(aw) {
  if (aw.status !== 'trading' || !aw.ordersPlaced) return;
  for (const r of RUNGS) {
    const rp = aw.rungs[r.key];
    if (rp.status !== 'armed') continue;

    if (!rp.up.filled && !rp.up.cancelled) {
      if (DRY_RUN) {
        if (aw.upAsk != null && aw.upAsk <= r.price) await onRungFill(aw, r, 'up', r.price, rp.up.shares);
      } else if (rp.up.orderId) {
        try {
          const st = await trader.getOrder(rp.up.orderId);
          if (st && st.filled) await onRungFill(aw, r, 'up', st.avgPrice || r.price, st.filledShares || rp.up.shares);
        } catch (_) {}
      }
    }
    if (rp.status === 'filled') continue;

    if (!rp.down.filled && !rp.down.cancelled) {
      if (DRY_RUN) {
        if (aw.downAsk != null && aw.downAsk <= r.price) await onRungFill(aw, r, 'down', r.price, rp.down.shares);
      } else if (rp.down.orderId) {
        try {
          const st = await trader.getOrder(rp.down.orderId);
          if (st && st.filled) await onRungFill(aw, r, 'down', st.avgPrice || r.price, st.filledShares || rp.down.shares);
        } catch (_) {}
      }
    }
  }
}

// Called when a window rolls over — any rung that never filled gets both
// resting orders cancelled; no win/loss recorded for it.
async function closeUnfilledRungs(aw) {
  for (const r of RUNGS) {
    const rp = aw.rungs[r.key];
    if (rp.status !== 'armed') continue;
    for (const side of ['up', 'down']) {
      const leg = rp[side];
      if (!leg.filled && !leg.cancelled && leg.orderId) {
        await cancelResting(leg.orderId);
        leg.cancelled = true;
      }
    }
    rp.status = 'closed';
    log(`⌛ [${aw.slug}] ${r.label} rung: window closed with neither side filled — both orders cancelled, no trade`);
  }
}

// ─────────────────────────────────────────
//  Mark-to-market (unrealized P&L)
// ─────────────────────────────────────────
function markPrice(aw, side) {
  const bid = side === 'up' ? aw.upBid : aw.downBid;
  const ask = side === 'up' ? aw.upAsk : aw.downAsk;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return null;
}
function unrealizedForRung(aw, rp) {
  if (rp.resolved) return 0;
  let u = 0;
  for (const side of ['up', 'down']) {
    const leg = rp[side];
    if (!leg.filled || leg.shares <= 0) continue;
    const mp = markPrice(aw, side);
    const mark = mp != null ? mp : (leg.cost / leg.shares);
    u += round2(leg.shares * mark - leg.cost);
  }
  return u;
}
function unrealizedForAssetWindow(aw) {
  if (aw.status === 'resolved') return 0;
  let u = 0;
  for (const r of RUNGS) u += unrealizedForRung(aw, aw.rungs[r.key]);
  return round2(u);
}
function openCostForAssetWindow(aw) {
  if (aw.status === 'resolved') return 0;
  let c = 0;
  for (const r of RUNGS) {
    const rp = aw.rungs[r.key];
    if (rp.resolved) continue;
    for (const side of ['up', 'down']) if (rp[side].filled) c += rp[side].cost;
  }
  return round2(c);
}
function allTrackedAssetWindows() {
  const list = [...engine.pending];
  if (engine.cycle) list.push(engine.cycle.assets.btc, engine.cycle.assets.eth);
  return list;
}
function totalUnrealizedPnl() {
  return round2(allTrackedAssetWindows().reduce((sum, aw) => sum + unrealizedForAssetWindow(aw), 0));
}
function openPositionsMTM() {
  return round2(allTrackedAssetWindows().reduce((sum, aw) => sum + openCostForAssetWindow(aw) + unrealizedForAssetWindow(aw), 0));
}

// ─────────────────────────────────────────
//  Resolution (background queue — never blocks live monitoring)
// ─────────────────────────────────────────
function assetHasAnyFilledRung(aw) {
  return RUNGS.some(r => aw.rungs[r.key].status === 'filled' || aw.rungs[r.key].filledSide);
}

async function checkAssetResolution(aw) {
  try {
    let mk = null;
    if (aw.conditionId) {
      const arr = await getJSON(`${GAMMA}/markets?condition_ids=${encodeURIComponent(aw.conditionId)}`);
      mk = Array.isArray(arr) ? arr[0] : null;
    }
    if (!mk) {
      const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(aw.slug)}`);
      const event = Array.isArray(events) ? events[0] : null;
      mk = event ? (event.markets || [])[0] : null;
    }
    if (mk && mk.closed === true && mk.outcomePrices) {
      const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : mk.outcomePrices;
      const tokens = parseMarketTokens(mk);
      const upIdx = tokens.findIndex(t => String(t.token_id) === String(aw.upTokenId));
      const downIdx = tokens.findIndex(t => String(t.token_id) === String(aw.downTokenId));
      if (upIdx >= 0 && downIdx >= 0 && prices[upIdx] != null) {
        resolveAssetWindow(aw, parseFloat(prices[upIdx]) >= 0.5 ? 'up' : 'down', 'official');
        return true;
      }
    }
  } catch (e) {
    log(`⚠️  checkAssetResolution(${aw.slug}) failed: ${e.message}`);
  }

  // Fast path: don't wait for the 60s fallback if the market has already traded to a
  // near-certain extreme (>= HIGH_CONF_PRICE on either side). Checked every resolution poll
  // (every RESOLUTION_POLL_MS), so this typically resolves within a few seconds of window close.
  updateHighConfidence(aw);
  if (aw.highConfSide) {
    log(`⚡ [${aw.slug}] live price hit ${aw.highConfPrice.toFixed(3)} on ${aw.highConfSide.toUpperCase()} (>= ${HIGH_CONF_PRICE}) — resolving now instead of waiting for the ${Math.round(RESOLUTION_FALLBACK_MS / 1000)}s fallback`);
    resolveAssetWindow(aw, aw.highConfSide, 'high-confidence-price');
    return true;
  }

  if (Date.now() - aw.closeAt >= RESOLUTION_FALLBACK_MS) {
    const upPrice = markPrice(aw, 'up');
    const downPrice = markPrice(aw, 'down');
    if (upPrice != null || downPrice != null) {
      let winningSide;
      if (upPrice != null && downPrice != null) winningSide = upPrice >= downPrice ? 'up' : 'down';
      else if (upPrice != null) winningSide = upPrice >= 0.5 ? 'up' : 'down';
      else winningSide = downPrice >= 0.5 ? 'down' : 'up';
      log(`⌛ [${aw.slug}] Gamma hasn't confirmed official resolution ${Math.round((Date.now() - aw.closeAt) / 1000)}s after close — resolving from last live price instead (up=${upPrice != null ? upPrice.toFixed(3) : '?'}, down=${downPrice != null ? downPrice.toFixed(3) : '?'})`);
      resolveAssetWindow(aw, winningSide, 'price-fallback');
      return true;
    }
  }
  return false;
}

function resolveAssetWindow(aw, winningSide, method) {
  aw.status = 'resolved';

  for (const r of RUNGS) {
    const rp = aw.rungs[r.key];
    if (rp.status !== 'filled' || rp.resolved) continue;

    const legs = ['up', 'down'].filter(side => rp[side].filled).map(side => ({ side, leg: rp[side] }));
    if (!legs.length) { rp.resolved = true; continue; }

    let totalPayout = 0, totalCost = 0, totalFee = 0;
    for (const { side, leg } of legs) {
      const payout = side === winningSide ? round2(leg.shares * 1) : 0;
      totalPayout += payout; totalCost += leg.cost; totalFee += leg.fee;
    }
    totalPayout = round2(totalPayout); totalCost = round2(totalCost); totalFee = round2(totalFee);
    const pnl = round2(totalPayout - totalCost);

    engine.bankroll = round2(engine.bankroll + totalPayout);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);
    rp.resolved = true;
    rp.pnl = pnl;

    const rState = engine.rungState[aw.asset][r.key];
    const isWin = legs.length === 1 ? legs[0].side === winningSide : pnl >= 0;
    const boughtSideLabel = legs.map(l => l.side).join('+').toUpperCase();

    if (isWin) {
      engine.wins++;
      rState.consecutiveLosses = 0;
      rState.currentShares = BASE_SHARES;
      rState.doubleCount = 0;
      log(`🏆 [${aw.slug}] ${aw.label}-${r.label} rung WIN — held ${boughtSideLabel}, winner ${winningSide.toUpperCase()} | payout $${totalPayout.toFixed(2)} pnl $${pnl.toFixed(2)} | counter reset → next size ${BASE_SHARES}sh`);
    } else {
      engine.losses++;
      rState.consecutiveLosses++;
      // Compounding: every additional lossThreshold consecutive losses doubles
      // the size again (loss 7 -> x2, loss 14 -> x4, loss 21 -> x8, ...). Uncapped.
      if (rState.consecutiveLosses % r.lossThreshold === 0) {
        rState.currentShares = round2(rState.currentShares * 2);
        rState.doubleCount++;
        log(`📉 [${aw.slug}] ${aw.label}-${r.label} rung LOSS #${rState.consecutiveLosses} (multiple of ${r.lossThreshold}) — DOUBLING AGAIN → ${rState.currentShares}sh (x${Math.pow(2, rState.doubleCount)} base) | pnl $${pnl.toFixed(2)}`);
      } else {
        log(`📉 [${aw.slug}] ${aw.label}-${r.label} rung LOSS #${rState.consecutiveLosses} — size stays ${rState.currentShares}sh | pnl $${pnl.toFixed(2)}`);
      }
    }

    registerTrade({ slug: aw.slug, asset: aw.asset, step: `${r.label} rung RESOLUTION`, side: boughtSideLabel, shares: legs.reduce((s, l) => s + l.leg.shares, 0), price: 1, pnl });

    engine.history.unshift({
      slug: aw.slug, asset: aw.asset, label: aw.label, windowTs: aw.windowTs,
      rung: r.label, boughtSide: boughtSideLabel, winningSide,
      shares: legs.reduce((s, l) => s + l.leg.shares, 0),
      cost: totalCost, fee: totalFee, payout: totalPayout, pnl,
      consecutiveLossesAfter: rState.consecutiveLosses, currentSharesAfter: rState.currentShares,
      resolutionMethod: method, resolvedAt: Date.now(),
    });
    if (engine.history.length > 300) engine.history.pop();
  }

  const methodTag = method === 'high-confidence-price' ? `⚡ HIGH-CONFIDENCE PRICE (>=${HIGH_CONF_PRICE})`
    : method === 'price-fallback' ? '📡 LIVE-PRICE FALLBACK'
    : '✅ OFFICIAL';
  log(`🏁 [${aw.slug}] ${aw.label} window resolved (${methodTag}) — winner ${winningSide.toUpperCase()} | bankroll $${engine.bankroll.toFixed(2)}`);
  recordEquity();
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
      const nowSec = Math.floor(now / 1000);
      const windowTs = currentWindowTs(nowSec);

      if (engine.waitingForBoundary) {
        if (engine.boundaryWindowTs === null) {
          engine.boundaryWindowTs = windowTs;
          const remaining = WINDOW_SECONDS - (nowSec - windowTs);
          log(`⏳ started mid-window — will NOT trade the in-progress window (ends in ${remaining}s); waiting for the next fresh 5-minute boundary`);
        }
        if (windowTs === engine.boundaryWindowTs) {
          emitFn('btc5mState', buildState());
          await new Promise(res => setTimeout(res, TICK_MS));
          continue;
        }
        engine.waitingForBoundary = false;
        log('🚦 new window boundary reached — trading starts now');
      }

      if (!engine.cycle || engine.cycle.windowTs !== windowTs) {
        if (engine.cycle) {
          for (const assetDef of ASSETS) {
            const aw = engine.cycle.assets[assetDef.key];
            await closeUnfilledRungs(aw);
            if (aw.status === 'resolved' || !assetHasAnyFilledRung(aw)) continue;
            updateHighConfidence(aw);
            if (aw.highConfSide) {
              log(`⚡ [${aw.slug}] live price already at ${aw.highConfPrice.toFixed(3)} on ${aw.highConfSide.toUpperCase()} at window close — resolving immediately instead of queueing`);
              resolveAssetWindow(aw, aw.highConfSide, 'high-confidence-price');
              continue;
            }
            engine.pending.push(aw);
            if (engine.pending.length > MAX_PENDING_RESOLUTIONS) {
              const dropped = engine.pending.shift();
              log(`⚠️  dropped stale pending window ${dropped.slug} from the resolution queue (too many pending)`);
            }
          }
        }
        engine.cycle = freshCycle(windowTs);
        log(`🆕 new window t=${windowTs} — discovering BTC + ETH markets…`);
      }

      const cycle = engine.cycle;
      for (const assetDef of ASSETS) {
        const aw = cycle.assets[assetDef.key];
        if (aw.status === 'discovering' && now - aw.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
          aw.lastDiscoveryAttempt = now;
          await discoverAssetWindow(aw);
        }
        if (aw.status === 'trading' && !aw.ordersPlaced && engine.tradingEnabled) {
          await placeRungOrders(aw);
        }
      }
      if (now - engine.lastPriceFetch >= PRICE_REFRESH_MS) {
        engine.lastPriceFetch = now;
        const toRefresh = [cycle.assets.btc, cycle.assets.eth, ...engine.pending];
        await Promise.all(toRefresh.map(aw => refreshAssetPrices(aw)));
        toRefresh.forEach(updateHighConfidence);
      }

      if (engine.tradingEnabled) {
        await checkRungFills(cycle.assets.btc);
        await checkRungFills(cycle.assets.eth);
      }

      if (engine.pending.length && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
        engine.lastResolutionPoll = now;
        const stillPending = [];
        for (const aw of engine.pending) {
          const done = await checkAssetResolution(aw);
          if (!done) stillPending.push(aw);
        }
        engine.pending = stillPending;
      }

      emitFn('btc5mState', buildState());
    } catch (e) {
      slog(`[rungbot] ⚠️  Loop error: ${e.message}`);
    }
    await new Promise(res => setTimeout(res, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  UI state / controls
// ─────────────────────────────────────────
function rungSummary(aw, rungDef) {
  const rp = aw.rungs[rungDef.key];
  const rState = engine.rungState[aw.asset][rungDef.key];
  return {
    key: rungDef.key, label: rungDef.label, price: rungDef.price,
    status: rp.status, filledSide: rp.filledSide, resolved: rp.resolved, pnl: rp.pnl,
    orderShares: rp.shares,
    up: { placed: rp.up.placed, filled: rp.up.filled, cancelled: rp.up.cancelled, price: rp.up.price, shares: rp.up.shares, fillPrice: rp.up.fillPrice, rebate: rp.up.rebate },
    down: { placed: rp.down.placed, filled: rp.down.filled, cancelled: rp.down.cancelled, price: rp.down.price, shares: rp.down.shares, fillPrice: rp.down.fillPrice, rebate: rp.down.rebate },
    martingale: { consecutiveLosses: rState.consecutiveLosses, currentShares: rState.currentShares, doubleCount: rState.doubleCount, lossThreshold: rungDef.lossThreshold },
    estimatedRebate: engine.rebateByRung[aw.asset][rungDef.key],
  };
}
function assetSummary(aw) {
  return {
    asset: aw.asset, label: aw.label, slug: aw.slug, windowTs: aw.windowTs, closeAt: aw.closeAt, status: aw.status,
    upAsk: aw.upAsk, downAsk: aw.downAsk, upBid: aw.upBid, downBid: aw.downBid,
    rungs: RUNGS.map(r => rungSummary(aw, r)),
    unrealizedPnl: unrealizedForAssetWindow(aw),
    highConfSide: aw.highConfSide, highConfPrice: aw.highConfPrice,
  };
}

function buildState() {
  const cycle = engine.cycle;
  const unrealizedPnl = totalUnrealizedPnl();
  const equity = round2(engine.bankroll + openPositionsMTM());
  return {
    dryRun: DRY_RUN,
    tradingEnabled: engine.tradingEnabled,
    waitingForBoundary: engine.waitingForBoundary,
    bankroll: engine.bankroll, capital: engine.capital,
    realizedPnl: engine.realizedPnl, unrealizedPnl, equity,
    feesPaid: engine.feesPaid,
    estimatedRebateUsd: engine.estimatedRebateUsd,
    rebateByRung: engine.rebateByRung,
    rebateNote: `Upper-bound estimate (Crypto category: ${REBATE_FEE_RATE} fee rate × ${REBATE_SHARE * 100}% maker share, assumes your resting order is the only maker liquidity taken) — real on-chain USDC payout, settled daily, is likely lower where other makers are competing in the same market.`,
    wins: engine.wins, losses: engine.losses,
    window: cycle ? {
      windowTs: cycle.windowTs, closeAt: cycle.closeAt,
      elapsedSec: Math.max(0, Math.min(WINDOW_SECONDS, Math.floor(Date.now() / 1000) - cycle.windowTs)),
      assets: { btc: assetSummary(cycle.assets.btc), eth: assetSummary(cycle.assets.eth) },
    } : null,
    pendingResolutionCount: engine.pending.length,
    pending: engine.pending.map(assetSummary),
    history: engine.history.slice(0, 60),
    trades: engine.trades.slice(-100).slice().reverse(),
    equityCurve: engine.equityCurve,
    logs: engine.logs.slice(-80),
    rungs: RUNGS.map(r => ({ key: r.key, label: r.label, price: r.price, lossThreshold: r.lossThreshold })),
    baseShares: BASE_SHARES,
    windowSeconds: WINDOW_SECONDS,
  };
}
function getStatus() { return buildState(); }

function pauseTrading() {
  engine.tradingEnabled = false;
  log('⏸️  Trading paused — no new rung orders will be placed; open positions still tracked to resolution, window discovery/rollover keeps running');
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
  slog('[rungbot] 🪙 BTC + ETH 5-Minute Rung Martingale Engine — fully automatic');
  slog(`[rungbot] ⚙️  Each window: 6 resting limit buys per asset — Up+Down @ 0.10/0.20/0.33, ${BASE_SHARES}sh each. First side of a rung to fill cancels the opposite side of that rung; position held to settlement.`);
  slog('[rungbot] ⚙️  Martingale (independent per rung per asset, compounding): 0.10 rung doubles every 7 consecutive losses, 0.20 rung every 4, 0.33 rung every 2 — keeps doubling every additional threshold hit, uncapped. Any win resets to base size.');
  slog(`[rungbot] ⚙️  Resolution: official Gamma > high-confidence live price (>=${HIGH_CONF_PRICE}, resolves within seconds) > ${Math.round(RESOLUTION_FALLBACK_MS / 1000)}s live-price fallback.`);
  slog(`[rungbot] ⚙️  Tracking an UPPER-BOUND estimated maker rebate per fill (Crypto category: fee rate ${REBATE_FEE_RATE}, maker share ${REBATE_SHARE * 100}%) — real on-chain USDC payouts settle daily and may be lower.`);
  slog(`[rungbot] ⚙️  Starting bankroll $${STARTING_CAPITAL} (shared across BTC+ETH) | maker fee rate ${MAKER_FEE_RATE} | never trades a window it joins mid-way through`);
  slog(`[rungbot] ${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => slog(`[rungbot] ❌ Fatal: ${e.message}`));
}

module.exports = {
  init,
  pauseTrading, resumeTrading,
  setMode,
  getStatus, buildState,
};
