'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET BTC 5-MINUTE UP/DOWN — DUAL LIMIT-ORDER PLAYBOOK
 * ═══════════════════════════════════════════════════════════════
 *
 *  Only BTC. Only the 5-minute Up/Down market. No candles, no signals,
 *  no streaks.
 *
 *  STRATEGY 1 (mean-reversion, per side, up to 2 attempts):
 *    - Window opens → resting limit buy @0.30 on Up and on Down
 *      separately. $50 notional each (shares = $50 / 0.30).
 *    - If a side fills: resting TP sell @0.70. If price falls to 0.10
 *      first, cancel the TP and exit immediately with a market sell
 *      (stop loss).
 *    - REARM RULE: if (and only if) that attempt closes via TP, the
 *      side gets exactly ONE more attempt — a fresh resting buy @0.30
 *      with the same TP/SL rules. If the first attempt closes via SL,
 *      or never fills at all, there is no rearm. Hard cap of 2 total
 *      attempts per side per window regardless of how the second one
 *      resolves.
 *
 *  STRATEGY 2 (momentum confirmation, per side, up to 2 attempts,
 *  each side fully independent of the other):
 *    - Up watches only Up's own ask; Down watches only Down's own ask.
 *      They are NEVER triggered together. The instant a side's own ask
 *      ticks to 0.60+, place a resting limit buy @0.60 for that side
 *      only. $100 notional (shares = $100 / 0.60).
 *    - If it fills: resting TP sell @0.90. If price falls to 0.20
 *      first, cancel the TP and exit immediately with a market sell
 *      (stop loss).
 *    - REARM RULE: identical to Strategy 1 — if (and only if) that
 *      attempt closes via TP, the side gets exactly ONE more attempt
 *      (a fresh resting buy @0.60, same TP/SL, no need to re-tick 0.60
 *      since it's already armed). SL or no-fill → no rearm. Hard cap
 *      of 2 total attempts per side per window.
 *
 *  ORDER TYPES: every ENTRY and every TP is a resting (GTC) limit
 *  order — a maker order. The only marketable/taker action anywhere
 *  in this bot is the stop-loss exit, which by definition needs to
 *  get out immediately rather than rest and hope.
 *
 *  FEES & REWARDS: per Polymarket's public docs, makers (resting limit
 *  orders) pay ZERO trading fees. Instead they can earn a Maker Rebate
 *  — a share (documented as roughly 15-25% for crypto markets) of the
 *  taker fee the counterparty paid — paid out whenever a resting order
 *  actually gets filled. This bot books an ESTIMATED rebate on every
 *  maker fill (entries and TP fills) using Polymarket's published fee
 *  formula (fee = shares × feeRate × price × (1-price), crypto
 *  feeRate = 0.07) times an assumed rebate share. Stop-loss market
 *  sells are taker actions — no rebate is booked for them, and (per
 *  instruction) no fee cost is booked either, so bookkeeping is
 *  slightly optimistic on SL exits versus a real live account.
 *  Polymarket's separate Liquidity Rewards Program (paid just for
 *  resting near the midpoint, whether filled or not) depends on
 *  real-time, cross-trader order-book competition data that isn't
 *  available via the public API, so it is NOT modeled here.
 *
 *  DRY_RUN is runtime-switchable (see setMode). In DRY_RUN, fills are
 *  simulated from observed ask/bid; in LIVE mode this uses the real
 *  trader (GTC resting orders, FOK market sells, polling, cancellation)
 *  via polymarket-trader.js.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const SYMBOL = 'BTC'; // hard-locked — this bot only ever trades BTC 5m

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2);
const WINDOW_SECS           = 300; // 5 minutes

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 1000);

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const STRAT1_BUY_PRICE   = Number(process.env.STRAT1_BUY_PRICE || 0.30);
const STRAT1_TP_PRICE    = Number(process.env.STRAT1_TP_PRICE  || 0.70);
const STRAT1_SL_PRICE    = Number(process.env.STRAT1_SL_PRICE  || 0.10);
const STRAT1_BET         = Number(process.env.STRAT1_BET       || 50);   // $ per side
const STRAT1_MAX_ATTEMPTS = Number(process.env.STRAT1_MAX_ATTEMPTS || 2); // rearm cap

const STRAT2_TRIGGER_PRICE = Number(process.env.STRAT2_TRIGGER_PRICE || 0.60);
const STRAT2_BUY_PRICE     = Number(process.env.STRAT2_BUY_PRICE     || 0.60);
const STRAT2_TP_PRICE      = Number(process.env.STRAT2_TP_PRICE      || 0.90);
const STRAT2_SL_PRICE      = Number(process.env.STRAT2_SL_PRICE      || 0.20);
const STRAT2_MAX_ATTEMPTS  = Number(process.env.STRAT2_MAX_ATTEMPTS  || 2);  // rearm cap
const STRAT2_BET           = Number(process.env.STRAT2_BET           || 100); // $ per side

// Used only to ESTIMATE the maker rebate (see header notes) — not a cost, an income estimate.
const CRYPTO_FEE_RATE_FOR_REBATE_CALC = Number(process.env.CRYPTO_FEE_RATE_FOR_REBATE_CALC || 0.07);
const MAKER_REBATE_SHARE = Number(process.env.MAKER_REBATE_SHARE || 0.20); // Polymarket docs: ~15-25% for crypto

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let bankroll = TOTAL_CAPITAL;
let realizedPnl = 0;
let rewardsEarned = 0;
let wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];
let windows = []; // flat list of 5m window trackers
let tokenPriceMap = {}; // tokenId -> { ask, bid }
let lastPolyPriceFetch = 0;

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-btc-5m-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-btc-5m-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// Estimated maker rebate for a resting-order fill (see header notes).
function makerReward(shares, price) {
  return round4(shares * CRYPTO_FEE_RATE_FOR_REBATE_CALC * price * (1 - price) * MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Order helpers — real trader in LIVE, simulated in DRY_RUN
// ─────────────────────────────────────────
async function placeRestingBuy(tokenId, price, size) {
  if (DRY_RUN) return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
  return await trader.placeGtcOrder(tokenId, 'BUY', price, size);
}
async function placeRestingSell(tokenId, price, size) {
  if (DRY_RUN) return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
  return await trader.placeGtcOrder(tokenId, 'SELL', price, size);
}
async function cancelOrderSafe(orderId) {
  if (DRY_RUN || !orderId) return;
  try { await trader.cancelOrder(orderId); } catch (e) { log(`⚠️  cancel failed for ${orderId}: ${e.message}`); }
}
// Immediate market sell — the one taker action in this bot, used only for stop losses.
async function marketSellNow(tokenId, shares) {
  if (DRY_RUN) {
    const bid = tokenPriceMap[tokenId]?.bid ?? tokenPriceMap[tokenId]?.ask ?? 0;
    return { id: `dry-mkt-sell-${Date.now()}`, isFilled: true, avgPrice: bid };
  }
  return await trader.placeFokSell(tokenId, shares);
}
// Poll a resting order's status (LIVE only — DRY_RUN fills are simulated from price directly)
async function checkOrderStatus(orderId) {
  if (DRY_RUN || !orderId) return { filled: false };
  try {
    const order = await trader.getOrder(orderId);
    if (!order) return { filled: false };
    const status = order.status || '';
    const matchStatus = (order.match_status || order.matchStatus || '').toLowerCase();
    const state = (order.state || '').toLowerCase();
    const filled = status === 'FILLED' || matchStatus === 'filled' || state === 'filled';
    const cancelled = status === 'CANCELLED' || matchStatus === 'cancelled';
    const avgPrice = parseFloat(order.avg_fill_price || order.price || '0') || null;
    return { filled, cancelled, avgPrice };
  } catch (_) { return { filled: false }; }
}

// ─────────────────────────────────────────
//  Market discovery — 5m BTC window (proven epoch-slug scheme)
// ─────────────────────────────────────────
function qOf(m) { return (m.question || m.groupItemTitle || m.title || '').toLowerCase(); }
function parseMarketTokens(m) {
  try {
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
    const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}
function tokenIdForSide(market, side) {
  const tokens = parseMarketTokens(market);
  const want = (side || '').trim().toLowerCase();
  const tok = tokens.find(t => (t.outcome || '').toLowerCase() === want);
  return tok?.token_id || null;
}
function pickMarket(event) {
  return (event.markets || []).find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || (event.markets || [])[0];
}
async function fetchEventForWindow(windowStart) {
  for (const offsetMult of [0, -1, 1]) {
    const ws = windowStart + offsetMult * WINDOW_SECS;
    const slug = `${SYMBOL.toLowerCase()}-updown-5m-${ws}`;
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) {
        return { event, market: pickMarket(event), slug };
      }
    } catch (_) {}
  }
  return null;
}

function windowStartFor(tsSec = nowSec()) { return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS; }

// ─────────────────────────────────────────
//  Window construction
// ─────────────────────────────────────────
function freshSideState() {
  return {
    state: 'idle', // idle -> resting -> filled -> tp_filled | sl_exit | holding_to_resolution | resolved | expired_unfilled
    orderId: null, tpOrderId: null,
    entryFillPrice: null, exitPrice: null, exitReason: null,
    shares: null, cost: null, pnl: null,
    attempt: 1, history: [],
    triggered: false, triggerPrice: null, // used by Strategy 2 — each side arms independently
  };
}
function buildWindow(windowStart) {
  return {
    id: `BTC-5m-${windowStart}`,
    windowStart, windowEnd: windowStart + WINDOW_SECS,
    slug: null, upTokenId: null, downTokenId: null,
    loaded: false, tradable: false,
    strat1: { up: freshSideState(), down: freshSideState() },
    strat2: { up: freshSideState(), down: freshSideState() },
    resolved: false, resolvedAt: null,
  };
}
async function tryLoadWindow(w) {
  const found = await fetchEventForWindow(w.windowStart);
  if (!found) return;
  const { market, slug } = found;
  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) return;
  w.slug = slug;
  w.upTokenId = upId;
  w.downTokenId = downId;
  w.loaded = true;
  w.tradable = true;
}

// ─────────────────────────────────────────
//  Price feed — both ask (BUY) and bid (SELL) for every tracked token
// ─────────────────────────────────────────
async function refreshAllPrices() {
  const tokenSet = new Set();
  for (const w of windows) {
    if (w.resolved || !w.loaded) continue;
    tokenSet.add(w.upTokenId);
    tokenSet.add(w.downTokenId);
  }
  if (!tokenSet.size) return;
  const requests = [];
  for (const tid of tokenSet) { requests.push({ token_id: tid, side: 'BUY' }); requests.push({ token_id: tid, side: 'SELL' }); }
  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const price = parseFloat(row.price);
        const side = (row.side || '').toUpperCase();
        if (!tid || !Number.isFinite(price)) continue;
        tokenPriceMap[tid] = tokenPriceMap[tid] || {};
        if (side === 'SELL') tokenPriceMap[tid].bid = price; else tokenPriceMap[tid].ask = price;
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (!val || typeof val !== 'object') continue;
        tokenPriceMap[tid] = tokenPriceMap[tid] || {};
        if (val.BUY != null) tokenPriceMap[tid].ask = parseFloat(val.BUY);
        if (val.buy != null) tokenPriceMap[tid].ask = parseFloat(val.buy);
        if (val.SELL != null) tokenPriceMap[tid].bid = parseFloat(val.SELL);
        if (val.sell != null) tokenPriceMap[tid].bid = parseFloat(val.sell);
      }
    }
  } catch (e) {
    for (const tid of tokenSet) {
      try {
        const [a, b] = await Promise.all([
          getJSON(`${CLOB}/price?token_id=${tid}&side=BUY`),
          getJSON(`${CLOB}/price?token_id=${tid}&side=SELL`),
        ]);
        tokenPriceMap[tid] = { ask: parseFloat(a.price || a.mid), bid: parseFloat(b.price || b.mid) };
      } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────
//  Equity / bookkeeping
// ─────────────────────────────────────────
function sideMarkValue(sideState, tokenId) {
  if (sideState.state !== 'filled' && sideState.state !== 'holding_to_resolution') return 0;
  const bid = tokenPriceMap[tokenId]?.bid;
  return round2(sideState.shares * (bid ?? sideState.entryFillPrice));
}
function markValue() {
  let held = 0;
  for (const w of windows) {
    if (w.resolved) continue;
    held += sideMarkValue(w.strat1.up, w.upTokenId) + sideMarkValue(w.strat1.down, w.downTokenId);
    held += sideMarkValue(w.strat2.up, w.upTokenId) + sideMarkValue(w.strat2.down, w.downTokenId);
  }
  return round2(bankroll + held);
}
function recordEquity() {
  equityCurve.push({ t: Date.now(), equity: markValue() });
  if (equityCurve.length > 500) equityCurve.shift();
}
function registerTrade(entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: SYMBOL, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Strategy 1 — resting 0.30 buy, TP 0.70, SL 0.10, rearm once after TP
// ─────────────────────────────────────────
async function processStrat1Side(w, sideName) {
  const s = w.strat1[sideName];
  const tokenId = sideName === 'up' ? w.upTokenId : w.downTokenId;
  const label = sideName === 'up' ? 'Up' : 'Down';
  const t = nowSec();
  const windowClosing = t >= w.windowEnd - EARLY_CUTOFF_SECS;

  if (s.state === 'idle') {
    if (windowClosing) { s.state = 'expired_unfilled'; return; }
    const shares = round2(STRAT1_BET / STRAT1_BUY_PRICE);
    const resp = await placeRestingBuy(tokenId, STRAT1_BUY_PRICE, shares);
    s.orderId = resp.id;
    s.shares = shares;
    s.state = 'resting';
    log(`📥 STRAT1 ${label} [${w.id}] attempt ${s.attempt}/${STRAT1_MAX_ATTEMPTS} — resting buy ${shares}sh @ ${STRAT1_BUY_PRICE} ($${STRAT1_BET})`);
    return;
  }

  if (s.state === 'resting') {
    let filled = false, fillPrice = STRAT1_BUY_PRICE;
    if (DRY_RUN) {
      const ask = tokenPriceMap[tokenId]?.ask;
      filled = ask != null && ask <= STRAT1_BUY_PRICE;
    } else {
      const st = await checkOrderStatus(s.orderId);
      if (st.cancelled) { s.state = 'expired_unfilled'; return; }
      filled = st.filled;
      if (st.avgPrice) fillPrice = st.avgPrice;
    }
    if (filled) {
      s.entryFillPrice = fillPrice;
      s.cost = round2(s.shares * fillPrice);
      const reward = makerReward(s.shares, fillPrice);
      bankroll = round2(bankroll - s.cost + reward);
      rewardsEarned = round2(rewardsEarned + reward);
      realizedPnl = round2(realizedPnl + reward);
      s.state = 'filled';
      recordEquity();
      log(`✅ STRAT1 ${label} [${w.id}] attempt ${s.attempt}/${STRAT1_MAX_ATTEMPTS} FILLED ${s.shares}sh @ ${fillPrice.toFixed(2)} | cost=$${s.cost.toFixed(2)} | reward≈+$${reward.toFixed(4)}`);
      registerTrade({ side: 'BUY', outcome: label, strategy: 1, reason: 'ENTRY', price: fillPrice, shares: s.shares, cost: s.cost, reward, attempt: s.attempt });
      return;
    }
    if (windowClosing) {
      await cancelOrderSafe(s.orderId);
      s.state = 'expired_unfilled';
      log(`⏹️  STRAT1 ${label} [${w.id}] attempt ${s.attempt}/${STRAT1_MAX_ATTEMPTS} window closing, unfilled resting order cancelled`);
    }
    return;
  }

  if (s.state === 'filled') {
    if (!s.tpOrderId) {
      const resp = await placeRestingSell(tokenId, STRAT1_TP_PRICE, s.shares);
      s.tpOrderId = resp.id;
      log(`🎯 STRAT1 ${label} [${w.id}] attempt ${s.attempt}/${STRAT1_MAX_ATTEMPTS} TP resting sell ${s.shares}sh @ ${STRAT1_TP_PRICE}`);
    }

    let tpFilled = false, tpPrice = STRAT1_TP_PRICE;
    if (DRY_RUN) {
      const bid = tokenPriceMap[tokenId]?.bid;
      tpFilled = bid != null && bid >= STRAT1_TP_PRICE;
    } else {
      const st = await checkOrderStatus(s.tpOrderId);
      tpFilled = st.filled;
      if (st.avgPrice) tpPrice = st.avgPrice;
    }
    if (tpFilled) {
      finalizeStrat1Exit(w, s, label, tpPrice, 'TP');
      return;
    }

    const bid = tokenPriceMap[tokenId]?.bid;
    if (bid != null && bid <= STRAT1_SL_PRICE) {
      await cancelOrderSafe(s.tpOrderId);
      const resp = await marketSellNow(tokenId, s.shares);
      const exitPrice = resp.avgPrice ?? bid;
      finalizeStrat1Exit(w, s, label, exitPrice, 'SL');
      return;
    }

    if (windowClosing) {
      await cancelOrderSafe(s.tpOrderId);
      s.state = 'holding_to_resolution';
      log(`⏳ STRAT1 ${label} [${w.id}] attempt ${s.attempt}/${STRAT1_MAX_ATTEMPTS} window closing, holding ${s.shares}sh to resolution`);
    }
  }
}

function finalizeStrat1Exit(w, s, label, exitPrice, reason) {
  const proceeds = round2(s.shares * exitPrice);
  const profit = round2(proceeds - s.cost);
  // TP is a maker fill (resting sell) -> rebate. SL is a taker market-sell -> no rebate, no fee.
  const reward = reason === 'TP' ? makerReward(s.shares, exitPrice) : 0;
  bankroll = round2(bankroll + proceeds + reward);
  realizedPnl = round2(realizedPnl + profit + reward);
  if (reward) rewardsEarned = round2(rewardsEarned + reward);
  if (profit >= 0) wins++; else losses++;

  s.state = reason === 'TP' ? 'tp_filled' : 'sl_exit';
  s.exitPrice = exitPrice;
  s.exitReason = reason;
  s.pnl = profit;
  s.history.push({ attempt: s.attempt, entryFillPrice: s.entryFillPrice, exitPrice, reason, pnl: profit });

  const icon = profit >= 0 ? '💰' : '💥';
  log(`${icon} STRAT1 ${label} [${w.id}] attempt ${s.attempt}/${STRAT1_MAX_ATTEMPTS} ${reason} exit ${s.shares}sh @ ${exitPrice.toFixed(2)} | pnl=$${profit.toFixed(2)}${reward ? ` | reward≈+$${reward.toFixed(4)}` : ''} | bankroll=$${bankroll.toFixed(2)}`);
  registerTrade({ side: 'SELL', outcome: label, strategy: 1, reason, price: exitPrice, shares: s.shares, profit, reward, attempt: s.attempt });

  if (reason === 'TP' && s.attempt < STRAT1_MAX_ATTEMPTS) {
    const nextAttempt = s.attempt + 1;
    const history = s.history;
    Object.assign(s, freshSideState());
    s.attempt = nextAttempt;
    s.history = history;
    log(`🔁 STRAT1 ${label} [${w.id}] rearming after TP — attempt ${nextAttempt}/${STRAT1_MAX_ATTEMPTS}`);
  }
  recordEquity();
}

// ─────────────────────────────────────────
//  Strategy 2 — EACH side arms independently: only Up's own price ticking to
//  0.60 places an Up buy; only Down's own price ticking to 0.60 places a
//  Down buy. They are never triggered together. TP 0.90, SL 0.20, rearms
//  once (max 2 attempts/side) if — and only if — the prior attempt closed
//  via TP.
// ─────────────────────────────────────────
async function processStrat2Side(w, sideName) {
  const s = w.strat2[sideName];
  const tokenId = sideName === 'up' ? w.upTokenId : w.downTokenId;
  const label = sideName === 'up' ? 'Up' : 'Down';
  const t = nowSec();
  const windowClosing = t >= w.windowEnd - EARLY_CUTOFF_SECS;

  if (!s.triggered) {
    if (windowClosing) return; // never ticked to 0.60 this window — nothing to do
    const ask = tokenPriceMap[tokenId]?.ask;
    if (ask == null || ask < STRAT2_TRIGGER_PRICE) return;
    s.triggered = true;
    s.triggerPrice = ask;
    log(`⚡ STRAT2 ${label} [${w.id}] triggered — ${label} ticked to ${ask.toFixed(2)}, placing resting buy @ ${STRAT2_BUY_PRICE}`);
  }

  if (s.state === 'idle') {
    if (windowClosing) { s.state = 'expired_unfilled'; return; }
    const shares = round2(STRAT2_BET / STRAT2_BUY_PRICE);
    const resp = await placeRestingBuy(tokenId, STRAT2_BUY_PRICE, shares);
    s.orderId = resp.id;
    s.shares = shares;
    s.state = 'resting';
    log(`📥 STRAT2 ${label} [${w.id}] attempt ${s.attempt}/${STRAT2_MAX_ATTEMPTS} — resting buy ${shares}sh @ ${STRAT2_BUY_PRICE} ($${STRAT2_BET})`);
    return;
  }

  if (s.state === 'resting') {
    let filled = false, fillPrice = STRAT2_BUY_PRICE;
    if (DRY_RUN) {
      const ask = tokenPriceMap[tokenId]?.ask;
      filled = ask != null && ask <= STRAT2_BUY_PRICE;
    } else {
      const st = await checkOrderStatus(s.orderId);
      if (st.cancelled) { s.state = 'expired_unfilled'; return; }
      filled = st.filled;
      if (st.avgPrice) fillPrice = st.avgPrice;
    }
    if (filled) {
      s.entryFillPrice = fillPrice;
      s.cost = round2(s.shares * fillPrice);
      const reward = makerReward(s.shares, fillPrice);
      bankroll = round2(bankroll - s.cost + reward);
      rewardsEarned = round2(rewardsEarned + reward);
      realizedPnl = round2(realizedPnl + reward);
      s.state = 'filled';
      recordEquity();
      log(`✅ STRAT2 ${label} [${w.id}] attempt ${s.attempt}/${STRAT2_MAX_ATTEMPTS} FILLED ${s.shares}sh @ ${fillPrice.toFixed(2)} | cost=$${s.cost.toFixed(2)} | reward≈+$${reward.toFixed(4)}`);
      registerTrade({ side: 'BUY', outcome: label, strategy: 2, reason: 'ENTRY', price: fillPrice, shares: s.shares, cost: s.cost, reward, attempt: s.attempt });
      return;
    }
    if (windowClosing) {
      await cancelOrderSafe(s.orderId);
      s.state = 'expired_unfilled';
      log(`⏹️  STRAT2 ${label} [${w.id}] attempt ${s.attempt}/${STRAT2_MAX_ATTEMPTS} window closing, unfilled resting order cancelled`);
    }
    return;
  }

  if (s.state === 'filled') {
    if (!s.tpOrderId) {
      const resp = await placeRestingSell(tokenId, STRAT2_TP_PRICE, s.shares);
      s.tpOrderId = resp.id;
      log(`🎯 STRAT2 ${label} [${w.id}] attempt ${s.attempt}/${STRAT2_MAX_ATTEMPTS} TP resting sell ${s.shares}sh @ ${STRAT2_TP_PRICE}`);
    }

    let tpFilled = false, tpPrice = STRAT2_TP_PRICE;
    if (DRY_RUN) {
      const bid = tokenPriceMap[tokenId]?.bid;
      tpFilled = bid != null && bid >= STRAT2_TP_PRICE;
    } else {
      const st = await checkOrderStatus(s.tpOrderId);
      tpFilled = st.filled;
      if (st.avgPrice) tpPrice = st.avgPrice;
    }
    if (tpFilled) {
      finalizeStrat2Exit(w, s, label, tpPrice, 'TP');
      return;
    }

    const bid = tokenPriceMap[tokenId]?.bid;
    if (bid != null && bid <= STRAT2_SL_PRICE) {
      await cancelOrderSafe(s.tpOrderId);
      const resp = await marketSellNow(tokenId, s.shares);
      const exitPrice = resp.avgPrice ?? bid;
      finalizeStrat2Exit(w, s, label, exitPrice, 'SL');
      return;
    }

    if (windowClosing) {
      await cancelOrderSafe(s.tpOrderId);
      s.state = 'holding_to_resolution';
      log(`⏳ STRAT2 ${label} [${w.id}] attempt ${s.attempt}/${STRAT2_MAX_ATTEMPTS} window closing, holding ${s.shares}sh to resolution`);
    }
  }
}

function finalizeStrat2Exit(w, s, label, exitPrice, reason) {
  const proceeds = round2(s.shares * exitPrice);
  const profit = round2(proceeds - s.cost);
  // TP is a maker fill (resting sell) -> rebate. SL is a taker market-sell -> no rebate, no fee.
  const reward = reason === 'TP' ? makerReward(s.shares, exitPrice) : 0;
  bankroll = round2(bankroll + proceeds + reward);
  realizedPnl = round2(realizedPnl + profit + reward);
  if (reward) rewardsEarned = round2(rewardsEarned + reward);
  if (profit >= 0) wins++; else losses++;

  s.state = reason === 'TP' ? 'tp_filled' : 'sl_exit';
  s.exitPrice = exitPrice;
  s.exitReason = reason;
  s.pnl = profit;
  s.history.push({ attempt: s.attempt, entryFillPrice: s.entryFillPrice, exitPrice, reason, pnl: profit });

  const icon = profit >= 0 ? '💰' : '💥';
  log(`${icon} STRAT2 ${label} [${w.id}] attempt ${s.attempt}/${STRAT2_MAX_ATTEMPTS} ${reason} exit ${s.shares}sh @ ${exitPrice.toFixed(2)} | pnl=$${profit.toFixed(2)}${reward ? ` | reward≈+$${reward.toFixed(4)}` : ''} | bankroll=$${bankroll.toFixed(2)}`);
  registerTrade({ side: 'SELL', outcome: label, strategy: 2, reason, price: exitPrice, shares: s.shares, profit, reward, attempt: s.attempt });

  if (reason === 'TP' && s.attempt < STRAT2_MAX_ATTEMPTS) {
    const nextAttempt = s.attempt + 1;
    const history = s.history;
    Object.assign(s, freshSideState());
    s.triggered = true; // already armed — rearm places a new order immediately, no need to re-tick 0.60
    s.attempt = nextAttempt;
    s.history = history;
    log(`🔁 STRAT2 ${label} [${w.id}] rearming after TP — attempt ${nextAttempt}/${STRAT2_MAX_ATTEMPTS}`);
  }
  recordEquity();
}
async function processStrat2(w) {
  await processStrat2Side(w, 'up');
  await processStrat2Side(w, 'down');
}

// ─────────────────────────────────────────
//  Resolution — for positions still open ("holding_to_resolution") when the window ends
// ─────────────────────────────────────────
async function determineWinningSide(w) {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(w.slug)}`);
    const market = pickMarket(event);
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const winner = (outcomes[bestI] || '').trim();
      if (winner) return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
    }
  } catch (_) {}
  const upBid = tokenPriceMap[w.upTokenId]?.bid, downBid = tokenPriceMap[w.downTokenId]?.bid;
  if (upBid != null && downBid != null) return upBid >= downBid ? 'Up' : 'Down';
  return null;
}
async function resolveHoldingPositions(w) {
  const winner = await determineWinningSide(w);
  for (const [strategyNum, bucket] of [[1, w.strat1], [2, w.strat2]]) {
    for (const [sideName, label] of [['up', 'Up'], ['down', 'Down']]) {
      const s = bucket[sideName];
      if (s.state !== 'holding_to_resolution') continue;
      const won = winner === label;
      const exitPrice = won ? 1 : 0;
      const proceeds = won ? round2(s.shares * 1) : 0;
      const profit = round2(proceeds - s.cost);
      bankroll = round2(bankroll + proceeds);
      realizedPnl = round2(realizedPnl + profit);
      if (profit >= 0) wins++; else losses++;
      s.state = 'resolved';
      s.exitPrice = exitPrice;
      s.exitReason = 'RESOLUTION';
      s.pnl = profit;
      const icon = won ? '💰' : '💥';
      log(`${icon} STRAT${strategyNum} ${label} [${w.id}] RESOLUTION ${s.shares}sh entry=${s.entryFillPrice?.toFixed(2)} exit=$${won ? '1.00' : '0.00'} | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);
      registerTrade({ side: 'SELL', outcome: label, strategy: strategyNum, reason: 'RESOLUTION', price: exitPrice, shares: s.shares, profit });
    }
  }
  recordEquity();
}

// ─────────────────────────────────────────
//  Main tick
// ─────────────────────────────────────────
async function ensureCurrentWindow() {
  const ws = windowStartFor();
  if (!windows.some(w => w.windowStart === ws)) {
    const w = buildWindow(ws);
    windows.push(w);
    log(`🪟 New window [${w.id}] ${new Date(ws * 1000).toISOString().slice(11, 19)}Z → ${new Date(w.windowEnd * 1000).toISOString().slice(11, 19)}Z`);
  }
}
async function processWindow(w) {
  if (!w.loaded) { await tryLoadWindow(w); if (!w.loaded) return; }
  if (!tradingEnabled) return;

  const t = nowSec();
  await processStrat1Side(w, 'up');
  await processStrat1Side(w, 'down');
  await processStrat2(w);

  if (t >= w.windowEnd - EARLY_CUTOFF_SECS && !w.resolved) {
    const anyHolding = [w.strat1.up, w.strat1.down, w.strat2.up, w.strat2.down].some(s => s.state === 'holding_to_resolution');
    if (anyHolding) await resolveHoldingPositions(w);
    w.resolved = true;
    w.resolvedAt = Date.now();
  }
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      await ensureCurrentWindow();
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshAllPrices(); }
      for (const w of windows) { if (!w.resolved) { try { await processWindow(w); } catch (e) { log(`⚠️  ${w.id} tick error: ${e.message}`); } } }
      const cutoffMs = Date.now() - 15 * 60 * 1000;
      windows = windows.filter(w => !w.resolved || w.resolvedAt > cutoffMs);
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function serializeSide(s, maxAttempts) {
  return {
    state: s.state, entryFillPrice: s.entryFillPrice, exitPrice: s.exitPrice,
    exitReason: s.exitReason, shares: s.shares, cost: s.cost, pnl: s.pnl,
    attempt: s.attempt, maxAttempts, history: s.history,
  };
}
function priceInfo(tokenId) {
  const p = tokenPriceMap[tokenId] || {};
  const ask = p.ask ?? null, bid = p.bid ?? null;
  const mid = (ask != null && bid != null) ? round2((ask + bid) / 2) : (ask ?? bid ?? null);
  return { ask, bid, mid };
}
function buildState() {
  const windowsOut = windows.map(w => ({
    id: w.id, windowStart: w.windowStart, windowEnd: w.windowEnd,
    secsToEnd: Math.max(0, Math.floor(w.windowEnd - nowSec())),
    tradable: w.tradable, resolved: w.resolved,
    upPrice: priceInfo(w.upTokenId), downPrice: priceInfo(w.downTokenId),
    strat1: { up: serializeSide(w.strat1.up, STRAT1_MAX_ATTEMPTS), down: serializeSide(w.strat1.down, STRAT1_MAX_ATTEMPTS) },
    strat2: {
      up: serializeSide(w.strat2.up, STRAT2_MAX_ATTEMPTS), down: serializeSide(w.strat2.down, STRAT2_MAX_ATTEMPTS),
    },
  })).sort((a, b) => b.windowStart - a.windowStart);

  const mv = markValue();
  return {
    dryRun: DRY_RUN, tradingEnabled, symbol: SYMBOL,
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    realizedPnl, unrealizedPnl: round2(mv - bankroll), totalPnl: round2(mv - TOTAL_CAPITAL),
    rewardsEarned, wins, losses,
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      strat1: { buyPrice: STRAT1_BUY_PRICE, tpPrice: STRAT1_TP_PRICE, slPrice: STRAT1_SL_PRICE, bet: STRAT1_BET, maxAttempts: STRAT1_MAX_ATTEMPTS },
      strat2: { triggerPrice: STRAT2_TRIGGER_PRICE, buyPrice: STRAT2_BUY_PRICE, tpPrice: STRAT2_TP_PRICE, slPrice: STRAT2_SL_PRICE, bet: STRAT2_BET, maxAttempts: STRAT2_MAX_ATTEMPTS },
    },
    windows: windowsOut,
    equityCurve,
    logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (existing positions still tracked for resolution bookkeeping)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }
function setPairs() { return { ok: true, pairs: [SYMBOL], note: 'This bot is BTC-only by design; pair selection has been removed.' }; }

function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) log(DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real orders');
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 BTC 5-Minute Dual Limit-Order Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} bookkeeping bankroll`);
  log(`⚙️  STRATEGY 1: resting buy @ ${STRAT1_BUY_PRICE} ($${STRAT1_BET}/side), TP @ ${STRAT1_TP_PRICE}, SL @ ${STRAT1_SL_PRICE}. Rearms once (max ${STRAT1_MAX_ATTEMPTS} attempts/side) if — and only if — the prior attempt closed via TP.`);
  log(`⚙️  STRATEGY 2: each side arms independently — Up only buys once Up's own price ticks to ${STRAT2_TRIGGER_PRICE}+, Down only buys once Down's own price ticks to ${STRAT2_TRIGGER_PRICE}+ (never triggered together). Resting buy @ ${STRAT2_BUY_PRICE} ($${STRAT2_BET}/side), TP @ ${STRAT2_TP_PRICE}, SL @ ${STRAT2_SL_PRICE}. Rearms once (max ${STRAT2_MAX_ATTEMPTS} attempts/side) if — and only if — the prior attempt closed via TP.`);
  log(`⚙️  All entries/TPs are resting (maker) limit orders — zero fees, estimated maker rebate booked as reward on each fill. Stop losses are immediate market sells (taker, no fee/rebate booked).`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
