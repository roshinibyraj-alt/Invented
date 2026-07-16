'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET BTC 5-MINUTE UP/DOWN — DUAL LIMIT-ORDER PLAYBOOK
 * ═══════════════════════════════════════════════════════════════
 *
 *  Only BTC. Only the 5-minute Up/Down market. No candles, no signals,
 *  no streaks — none of the prior hourly/15m/5m reversal logic remains.
 *
 *  Two independent strategies run every 5-minute window. EVERY order,
 *  on both sides of every strategy, is a RESTING GTC limit order — no
 *  market orders, no FOK immediate orders, anywhere in this bot. That
 *  means every fill is a maker fill.
 *
 *  STRATEGY 1 (mean-reversion entries, one-shot per side):
 *    - The instant a window opens, place a RESTING limit buy at 0.30
 *      for Up, and a separate resting limit buy at 0.30 for Down.
 *      $50 notional each (shares = $50 / 0.30).
 *    - If a side fills: place a resting TP limit sell at 0.70. If the
 *      TP never fills by window end, the position rides to actual
 *      market resolution (no stop loss — this bot carries no stop
 *      loss conditions anywhere).
 *    - If a side never fills by window end, its resting order is
 *      cancelled. No retry, no repeat — one attempt per side per window.
 *
 *  STRATEGY 2 (momentum-confirmation entries, one-shot per window):
 *    - Watches both sides all window. The instant EITHER side's ask
 *      ticks to 0.70 or higher, place a RESTING limit buy at 0.70 for
 *      BOTH Up and Down. $100 notional each. No FOK/immediate entry.
 *    - No stop loss, no take-profit — once filled, a side rides to
 *      actual market resolution. Unfilled resting orders are cancelled
 *      at window close.
 *    - Fires once per window, even if 0.70 is touched again later.
 *
 *  Sizing is always a fixed dollar amount per side (not per-share).
 *  No compounding, no bankroll-based scaling.
 *
 *  FEES & REWARDS: because every order here is a resting maker order,
 *  Polymarket charges $0 in trading fees. Instead, each maker fill earns
 *  a share of the taker's fee back as a daily reward (Polymarket's Maker
 *  Rebates Program — ~20% of the matched taker fee in Crypto markets,
 *  paid in pUSD/USDC). This bot models and tracks that reward on every
 *  fill instead of subtracting a fee.
 *
 *  DRY_RUN is runtime-switchable (see setMode). In DRY_RUN, order fills
 *  are simulated from observed ask/bid prices; in LIVE mode, this uses
 *  the real trader (GTC resting orders, polling, cancellation) via
 *  polymarket-trader.js.
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
// No stop-loss parameters anywhere: all positions either take profit via a
// resting TP order (Strategy 1) or ride to actual market resolution.
const STRAT1_BUY_PRICE = Number(process.env.STRAT1_BUY_PRICE || 0.30);
const STRAT1_TP_PRICE  = Number(process.env.STRAT1_TP_PRICE  || 0.70);
const STRAT1_BET       = Number(process.env.STRAT1_BET       || 50);   // $ per side

const STRAT2_TRIGGER_PRICE = Number(process.env.STRAT2_TRIGGER_PRICE || 0.70);
const STRAT2_BUY_PRICE     = Number(process.env.STRAT2_BUY_PRICE     || 0.70);
const STRAT2_BET           = Number(process.env.STRAT2_BET           || 100); // $ per side

// Polymarket Crypto-category taker fee rate, used only to MODEL the maker
// reward we earn (we never pay this — we're always the maker/resting side).
const CRYPTO_TAKER_FEE_RATE = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
// Polymarket's Maker Rebates Program pays makers back a share of the taker
// fee matched against their fill. As of mid-2026 that share is ~20% for
// Crypto markets (25% in most other categories). Paid daily in pUSD/USDC.
const MAKER_REBATE_SHARE = Number(process.env.MAKER_REBATE_SHARE || 0.20);

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

// Models the maker reward earned on a fill: Polymarket pays makers back a
// share (MAKER_REBATE_SHARE) of the taker fee matched against their resting
// order. We never pay this fee ourselves — we're always the resting side.
function makerReward(shares, price) {
  return round4(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Order helpers — real trader in LIVE, simulated in DRY_RUN
//  Every order this bot places is a RESTING GTC limit order. No market
//  orders, no FOK immediate orders — that's what keeps every fill a maker
//  fill (zero fees, reward-eligible).
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
//  Market discovery — 5m BTC window (same epoch-slug scheme already proven to work)
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
    state: 'idle', // idle -> resting -> filled -> tp_filled | holding_to_resolution | resolved | expired_unfilled
    orderId: null, tpOrderId: null,
    entryFillPrice: null, exitPrice: null, exitReason: null,
    shares: null, cost: null, pnl: null, reward: 0,
  };
}
function buildWindow(windowStart) {
  return {
    id: `BTC-5m-${windowStart}`,
    windowStart, windowEnd: windowStart + WINDOW_SECS,
    slug: null, upTokenId: null, downTokenId: null,
    loaded: false, tradable: false,
    strat1: { up: freshSideState(), down: freshSideState() },
    strat2: { triggered: false, triggerSide: null, triggerPrice: null, up: freshSideState(), down: freshSideState() },
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
//  Strategy 1 — resting 0.30 buy, TP 0.70, SL 0.10, one-shot per side
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
    log(`📥 STRAT1 ${label} [${w.id}] resting buy ${shares}sh @ ${STRAT1_BUY_PRICE} ($${STRAT1_BET})`);
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
      s.reward = round2((s.reward || 0) + reward);
      s.state = 'filled';
      recordEquity();
      log(`✅ STRAT1 ${label} [${w.id}] FILLED ${s.shares}sh @ ${fillPrice.toFixed(2)} | cost=$${s.cost.toFixed(2)} | reward=$${reward.toFixed(4)}`);
      registerTrade({ side: 'BUY', outcome: label, strategy: 1, reason: 'ENTRY', price: fillPrice, shares: s.shares, cost: s.cost, reward });
      return;
    }
    if (windowClosing) {
      await cancelOrderSafe(s.orderId);
      s.state = 'expired_unfilled';
      log(`⏹️  STRAT1 ${label} [${w.id}] window closing, unfilled resting order cancelled`);
    }
    return;
  }

  if (s.state === 'filled') {
    if (!s.tpOrderId) {
      const resp = await placeRestingSell(tokenId, STRAT1_TP_PRICE, s.shares);
      s.tpOrderId = resp.id;
      log(`🎯 STRAT1 ${label} [${w.id}] TP resting sell ${s.shares}sh @ ${STRAT1_TP_PRICE}`);
    }

    // Check TP fill
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
      finalizeSideExit(w, s, label, 1, tpPrice);
      return;
    }

    // No stop loss — if TP doesn't fill by window end, hold to resolution.
    if (windowClosing) {
      await cancelOrderSafe(s.tpOrderId);
      s.state = 'holding_to_resolution';
      log(`⏳ STRAT1 ${label} [${w.id}] window closing, holding ${s.shares}sh to resolution`);
    }
  }
}

// ─────────────────────────────────────────
//  Strategy 2 — reactive resting buy-both on momentum tick @ 0.70,
//  no stop loss, no take profit. Once triggered, a resting limit buy is
//  placed on both sides (never a market/FOK order) and any fill rides to
//  actual market resolution.
// ─────────────────────────────────────────
async function processStrat2(w) {
  const t = nowSec();
  const windowClosing = t >= w.windowEnd - EARLY_CUTOFF_SECS;

  if (!w.strat2.triggered) {
    if (windowClosing) return;
    const upAsk = tokenPriceMap[w.upTokenId]?.ask;
    const downAsk = tokenPriceMap[w.downTokenId]?.ask;
    let triggerSide = null, triggerPrice = null;
    if (upAsk != null && upAsk >= STRAT2_TRIGGER_PRICE) { triggerSide = 'Up'; triggerPrice = upAsk; }
    else if (downAsk != null && downAsk >= STRAT2_TRIGGER_PRICE) { triggerSide = 'Down'; triggerPrice = downAsk; }
    if (!triggerSide) return;

    w.strat2.triggered = true;
    w.strat2.triggerSide = triggerSide;
    w.strat2.triggerPrice = triggerPrice;
    log(`⚡ STRAT2 [${w.id}] trigger: ${triggerSide} ticked to ${triggerPrice.toFixed(2)} — placing resting buys @ ${STRAT2_BUY_PRICE} on both sides`);

    for (const [sideName, tokenId, label] of [['up', w.upTokenId, 'Up'], ['down', w.downTokenId, 'Down']]) {
      const s = w.strat2[sideName];
      const shares = round2(STRAT2_BET / STRAT2_BUY_PRICE);
      const resp = await placeRestingBuy(tokenId, STRAT2_BUY_PRICE, shares);
      s.orderId = resp.id;
      s.shares = shares;
      s.state = 'resting';
      log(`📥 STRAT2 ${label} [${w.id}] resting buy ${shares}sh @ ${STRAT2_BUY_PRICE} ($${STRAT2_BET})`);
    }
    return;
  }

  // Already triggered — watch resting orders for fills, or hold filled
  // positions to resolution (no TP, no SL, by design).
  for (const [sideName, tokenId, label] of [['up', w.upTokenId, 'Up'], ['down', w.downTokenId, 'Down']]) {
    const s = w.strat2[sideName];

    if (s.state === 'resting') {
      let filled = false, fillPrice = STRAT2_BUY_PRICE;
      if (DRY_RUN) {
        const ask = tokenPriceMap[tokenId]?.ask;
        filled = ask != null && ask <= STRAT2_BUY_PRICE;
      } else {
        const st = await checkOrderStatus(s.orderId);
        if (st.cancelled) { s.state = 'expired_unfilled'; continue; }
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
        s.reward = round2((s.reward || 0) + reward);
        s.state = 'filled';
        recordEquity();
        log(`✅ STRAT2 ${label} [${w.id}] FILLED ${s.shares}sh @ ${fillPrice.toFixed(2)} | cost=$${s.cost.toFixed(2)} | reward=$${reward.toFixed(4)}`);
        registerTrade({ side: 'BUY', outcome: label, strategy: 2, reason: 'ENTRY', price: fillPrice, shares: s.shares, cost: s.cost, reward });
      } else if (windowClosing) {
        await cancelOrderSafe(s.orderId);
        s.state = 'expired_unfilled';
        log(`⏹️  STRAT2 ${label} [${w.id}] window closing, unfilled resting order cancelled`);
      }
      continue;
    }

    if (s.state === 'filled' && windowClosing) {
      s.state = 'holding_to_resolution';
      log(`⏳ STRAT2 ${label} [${w.id}] window closing, holding ${s.shares}sh to resolution (no TP/SL by design)`);
    }
  }
}

// Only called for Strategy 1's TP exit — there is no stop loss anywhere in
// this bot. The TP sell is itself a resting limit order, so it's a maker
// fill too and earns a reward on top of the proceeds.
function finalizeSideExit(w, s, label, strategyNum, exitPrice) {
  const proceeds = round2(s.shares * exitPrice);
  const reward = makerReward(s.shares, exitPrice);
  const profit = round2(proceeds - s.cost + reward);
  bankroll = round2(bankroll + proceeds + reward);
  realizedPnl = round2(realizedPnl + profit);
  rewardsEarned = round2(rewardsEarned + reward);
  s.reward = round2((s.reward || 0) + reward);
  if (profit >= 0) wins++; else losses++;
  s.state = 'tp_filled';
  s.exitPrice = exitPrice;
  s.exitReason = 'TP';
  s.pnl = profit;
  recordEquity();
  const icon = profit >= 0 ? '💰' : '💥';
  log(`${icon} STRAT${strategyNum} ${label} [${w.id}] TP exit ${s.shares}sh @ ${exitPrice.toFixed(2)} | pnl=$${profit.toFixed(2)} | reward=$${reward.toFixed(4)} | bankroll=$${bankroll.toFixed(2)}`);
  registerTrade({ side: 'SELL', outcome: label, strategy: strategyNum, reason: 'TP', price: exitPrice, shares: s.shares, profit, reward });
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
function serializeSide(s) {
  return {
    state: s.state, entryFillPrice: s.entryFillPrice, exitPrice: s.exitPrice,
    exitReason: s.exitReason, shares: s.shares, cost: s.cost, pnl: s.pnl, reward: s.reward || 0,
  };
}

// Picks the window the dashboard should show live prices for: the one
// currently inside its 5-minute trading window, falling back to the most
// recently loaded tradable window.
function getActiveWindow() {
  const t = nowSec();
  let active = windows.find(w => w.tradable && !w.resolved && t >= w.windowStart && t < w.windowEnd);
  if (!active) active = windows.filter(w => w.tradable).sort((a, b) => b.windowStart - a.windowStart)[0];
  return active || null;
}
function buildState() {
  const windowsOut = windows.map(w => ({
    id: w.id, windowStart: w.windowStart, windowEnd: w.windowEnd,
    secsToEnd: Math.max(0, Math.floor(w.windowEnd - nowSec())),
    tradable: w.tradable, resolved: w.resolved,
    strat1: { up: serializeSide(w.strat1.up), down: serializeSide(w.strat1.down) },
    strat2: {
      triggered: w.strat2.triggered, triggerSide: w.strat2.triggerSide, triggerPrice: w.strat2.triggerPrice,
      up: serializeSide(w.strat2.up), down: serializeSide(w.strat2.down),
    },
  })).sort((a, b) => b.windowStart - a.windowStart);

  const mv = markValue();

  const active = getActiveWindow();
  let livePrices = null;
  if (active) {
    const up = tokenPriceMap[active.upTokenId] || {};
    const down = tokenPriceMap[active.downTokenId] || {};
    const mid = (a, b) => (a != null && b != null) ? round4((a + b) / 2) : (a ?? b ?? null);
    livePrices = {
      windowId: active.id,
      secsToEnd: Math.max(0, Math.floor(active.windowEnd - nowSec())),
      up: { ask: up.ask ?? null, bid: up.bid ?? null, mid: mid(up.ask, up.bid) },
      down: { ask: down.ask ?? null, bid: down.bid ?? null, mid: mid(down.ask, down.bid) },
    };
  }

  return {
    dryRun: DRY_RUN, tradingEnabled, symbol: SYMBOL,
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    realizedPnl, unrealizedPnl: round2(mv - bankroll), totalPnl: round2(mv - TOTAL_CAPITAL),
    rewardsEarned, wins, losses,
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      strat1: { buyPrice: STRAT1_BUY_PRICE, tpPrice: STRAT1_TP_PRICE, bet: STRAT1_BET },
      strat2: { triggerPrice: STRAT2_TRIGGER_PRICE, buyPrice: STRAT2_BUY_PRICE, bet: STRAT2_BET },
    },
    livePrices,
    windows: windowsOut,
    equityCurve, totalEquityCurve: equityCurve,
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
  log(`⚙️  STRATEGY 1: resting buy both sides @ ${STRAT1_BUY_PRICE} ($${STRAT1_BET}/side), TP @ ${STRAT1_TP_PRICE}. No stop loss — unfilled TP rides to resolution. One-shot per side.`);
  log(`⚙️  STRATEGY 2: on either side ticking to ${STRAT2_TRIGGER_PRICE}+, resting buy both sides @ ${STRAT2_BUY_PRICE} ($${STRAT2_BET}/side). No stop loss, no TP — rides to resolution. One-shot per window.`);
  log(`⚙️  All orders are resting GTC limit orders (maker-only). $0 trading fees — every fill earns a maker reward (~${(MAKER_REBATE_SHARE * 100).toFixed(0)}% of the matched taker fee) instead.`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
