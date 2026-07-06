'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — TICKER + COUNTER-BET SCALPER
 * ═══════════════════════════════════════════════════════════════
 *
 *  Up and Down each independently run the SAME pattern:
 *
 *  TICKER (every BUY_TICK_INTERVAL_SECS = 10s), per side:
 *    - If the side's current mid price is inside the entry zone
 *      (ENTRY_ZONE_MIN–ENTRY_ZONE_MAX, i.e. 0.20–0.80), place a new
 *      maker limit BUY at (mid − BUY_OFFSET). Outside the zone, skip
 *      this tick (still counts as fired, tries again next tick).
 *    - Fires every 10s regardless of any earlier orders' status —
 *      orders can stack/overlap freely.
 *    - Always sized FIXED_SHARES.
 *
 *  EXPIRY: any resting buy (ticker- or counter-bet-placed) that
 *  hasn't filled within CANCEL_TIMEOUT_SECS (8s) of being placed is
 *  cancelled.
 *
 *  FILL → COUNTER-BET: the instant ANY buy fills (ticker-origin or
 *  counter-bet-origin), two things happen:
 *    1. A TP sell is rested at (entry price + TP_OFFSET) for that
 *       fill — TPs are always allowed, even past the entry cutoff.
 *    2. If still before FLATTEN_SECS, a counter-bet buy is
 *       immediately placed on the OPPOSITE side at (that side's mid
 *       − BUY_OFFSET), same entry-zone check, same 8s expiry rule.
 *       Because both sides run the identical pattern, a counter-bet
 *       that itself fills triggers a counter-bet back — this can
 *       ping-pong between sides.
 *
 *  AT 200s (FLATTEN_SECS) — HARD STOP: no more trades at all this
 *  window, on either side. Every resting buy (ticker or counter) and
 *  every resting TP is cancelled, and any shares still held are
 *  cashed out immediately at the current bid (a real taker sell,
 *  crossing the book, not a resting maker order) so the pair goes
 *  flat right away and stays flat for the rest of the window. Runs
 *  once per window; nothing further happens until the next window
 *  loads. This fires well before ENTRY_CUTOFF_SECS/SWEEP_SECS below,
 *  which are effectively no-ops now since there's nothing left for
 *  them to act on by the time they'd run.
 *
 *  AT 280s (ENTRY_CUTOFF_SECS): no more NEW buy placements (neither
 *  ticker nor counter-bet) on either side. Existing resting orders
 *  and open TPs are left alone until 285s.
 *
 *  AT 285s (SWEEP_SECS), per side: cancel that side's still-unfilled
 *  resting buys and every still-unfilled TP, then — if that side is
 *  left holding any shares — roll them into ONE aggregate maker
 *  limit SELL at 0.99 for the combined size.
 *
 *  RESOLUTION: if the 0.99 sell (or anything else) still hasn't
 *  filled by RESOLUTION_BUFFER_S (8s) after window end, whatever
 *  shares remain resolve against Polymarket's actual outcome.
 *
 *  FEES: every ticker/counter buy and every TP sell are genuine maker
 *  orders (fee-free + rebate, Fee Structure V2). The FLATTEN_SECS
 *  cash-out is the one exception — it crosses the book on purpose to
 *  guarantee an immediate flat, so it pays the taker fee.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Timing ──
const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const RESOLUTION_BUFFER_S   = 8;
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

// ── Env / config ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ── Ticker + counter-bet strategy parameters ──
const BUY_OFFSET             = Number(process.env.BUY_OFFSET || 0.05);   // entry = current mid - this
const TP_OFFSET              = Number(process.env.TP_OFFSET || 0.05);    // TP = entry + this
const BUY_TICK_INTERVAL_SECS = Number(process.env.BUY_TICK_INTERVAL_SECS || 10); // new ticker buy every N seconds, per side
const CANCEL_TIMEOUT_SECS    = Number(process.env.CANCEL_TIMEOUT_SECS || 8);     // cancel any resting buy unfilled this long
const ENTRY_ZONE_MIN         = Number(process.env.ENTRY_ZONE_MIN || 0.20);
const ENTRY_ZONE_MAX         = Number(process.env.ENTRY_ZONE_MAX || 0.80);
const ENTRY_CUTOFF_SECS      = Number(process.env.ENTRY_CUTOFF_SECS || 280);     // no new buys (ticker or counter) after this
const SWEEP_SECS             = Number(process.env.SWEEP_SECS || 285);           // cancel unfilled + rest final sell
const FINAL_SELL_PRICE       = Number(process.env.FINAL_SELL_PRICE || 0.99);
const FIXED_SHARES           = Number(process.env.FIXED_SHARES || 50);

// Hard stop, earlier than ENTRY_CUTOFF_SECS/SWEEP_SECS: at this many seconds
// elapsed, ALL trading stops for the window — no more ticker or counter-bet
// buys — and any resting buys/TPs are cancelled and any held shares are
// cashed out immediately (taker sell at current bid) so the book goes flat
// and stays flat until the next window loads.
const FLATTEN_SECS           = Number(process.env.FLATTEN_SECS || 200);

// ── Fees & maker rebates (Polymarket Fee Structure V2, crypto category) ──
const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

// ── State ──
let emitFn    = () => {};
let slog      = () => {};
let trader    = null;
let startTime = Date.now();
let logs      = [];
let trades    = [];
let tradingEnabled = true;
let pairList = [...DEFAULT_PAIRS];
let perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
let pairs = {};
let lastPolyPriceFetch = 0;
let totalEquityCurve = [];

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}
function round2(n) { return Math.round(n * 100) / 100; }
function nowSec() { return Date.now() / 1000; }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-counterbet-scalper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-counterbet-scalper/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Order helpers
// ─────────────────────────────────────────
async function placeLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function placeLimitSell(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitSell(tokenId, shares, price);
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function placeMarketSell(tokenId, price, shares) {
  // Used only by the FLATTEN_SECS cash-out: crosses the book at the current
  // bid to close immediately (taker), rather than resting above it like a TP.
  if (!DRY_RUN && trader) return await trader.limitSell(tokenId, shares, price);
  return { id: `dry-flatten-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function cancelOrder(orderId) {
  if (!DRY_RUN && trader && orderId) {
    try { await trader.cancelOrder(orderId); }
    catch (e) { log(`⚠️  cancel failed: ${e.message}`); }
  }
}
function takerFee(shares, price) {
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshSideState() {
  return {
    buyOrders: [],        // { orderId, price, shares, cost, kind:'TICKER'|'COUNTER', placedAt } (RESTING only)
    positions: [],         // { entryPrice, shares, cost, exit: { kind:'TP'|'FINAL', price, orderId, status }, openedAt }
    buyTicksFired: 0,
    wins: 0, losses: 0,
    realizedPnl: 0,
    rebatesEarned: 0,
  };
}

function freshPairState(symbol) {
  return {
    symbol,
    tradable: false,
    windowStart: null,
    windowEnd: null,
    slug: null,
    eventTitle: null,
    conditionId: null,
    upTokenId: null,
    downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,

    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,

    // per-window trading state (reset in loadPairWindow)
    flattenDone: false,
    sweepDone: false,
    sides: { Up: freshSideState(), Down: freshSideState() },

    resolvedThisWindow: true,
    equityCurve: [{ t: Date.now(), equity: perPairCapital }],
  };
}

function resetPairs() {
  perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
  pairs = {};
  for (const sym of pairList) pairs[sym] = freshPairState(sym);
  totalEquityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];
}
resetPairs();

// ─────────────────────────────────────────
//  Slug / window math
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) {
  return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS;
}
function slugFor(symbol, windowStartSec) {
  return `${symbol.toLowerCase()}-updown-5m-${windowStartSec}`;
}
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
async function fetchEventForWindow(symbol, windowStart) {
  for (const offset of SLUG_OFFSET_FALLBACKS) {
    const ws = windowStart + offset;
    if (ws + WINDOW_SECS <= nowSec()) continue;
    const slug = slugFor(symbol, ws);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) {
        return { event, windowStart: ws, slug };
      }
    } catch (_) { /* not indexed yet */ }
  }
  return null;
}

async function loadPairWindow(p) {
  const ws = currentWindowStart();
  if (p.windowStart === ws && p.upTokenId) return;

  const found = await fetchEventForWindow(p.symbol, ws);
  if (!found) { p.tradable = false; return; }
  const { event, windowStart, slug } = found;
  const market = event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];

  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) {
    log(`⚠️  ${p.symbol}: window loaded but Up/Down token ids missing`);
    p.tradable = false;
    return;
  }

  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.slug = slug;
  p.eventTitle = event.title || event.slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;
  p.resolvedThisWindow = false;

  // reset per-window trading state
  p.flattenDone = false;
  p.sweepDone = false;
  p.sides = { Up: freshSideState(), Down: freshSideState() };

  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z`);
}

// ─────────────────────────────────────────
//  Price feed
// ─────────────────────────────────────────
async function refreshPolyPrices() {
  const requests = [];
  for (const p of Object.values(pairs)) {
    if (!p.tradable || !p.upTokenId || !p.downTokenId) continue;
    requests.push({ token_id: p.upTokenId, side: 'BUY' });
    requests.push({ token_id: p.upTokenId, side: 'SELL' });
    requests.push({ token_id: p.downTokenId, side: 'BUY' });
    requests.push({ token_id: p.downTokenId, side: 'SELL' });
  }
  if (!requests.length) return;

  function applyPolyPrice(tid, side, price) {
    if (!Number.isFinite(price)) return;
    for (const p of Object.values(pairs)) {
      if (p.upTokenId === tid) { if (side === 'BUY') p.upAsk = price; else if (side === 'SELL') p.upBid = price; }
      else if (p.downTokenId === tid) { if (side === 'BUY') p.downAsk = price; else if (side === 'SELL') p.downBid = price; }
    }
  }

  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const side = (row.side || '').toUpperCase();
        const price = parseFloat(row.price);
        if (!tid || !Number.isFinite(price)) continue;
        applyPolyPrice(tid, side, price);
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (val && typeof val === 'object') {
          if (val.BUY != null) applyPolyPrice(tid, 'BUY', parseFloat(val.BUY));
          if (val.SELL != null) applyPolyPrice(tid, 'SELL', parseFloat(val.SELL));
          if (val.buy != null) applyPolyPrice(tid, 'BUY', parseFloat(val.buy));
          if (val.sell != null) applyPolyPrice(tid, 'SELL', parseFloat(val.sell));
        }
      }
    }
  } catch (e) {
    for (const p of Object.values(pairs)) {
      if (!p.tradable) continue;
      try {
        const [upAsk, upBid, downAsk, downBid] = await Promise.all([
          getJSON(`${CLOB}/price?token_id=${p.upTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${p.upTokenId}&side=SELL`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${p.downTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${p.downTokenId}&side=SELL`).catch(() => null),
        ]);
        if (upAsk) p.upAsk = parseFloat(upAsk.price || upAsk.mid || p.upAsk);
        if (upBid) p.upBid = parseFloat(upBid.price || upBid.mid || p.upBid);
        if (downAsk) p.downAsk = parseFloat(downAsk.price || downAsk.mid || p.downAsk);
        if (downBid) p.downBid = parseFloat(downBid.price || downBid.mid || p.downBid);
      } catch (_) { /* stale values, retry next tick */ }
    }
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function sideHeldShares(sideState) {
  return sideState.positions.reduce((s, pos) => s + pos.shares, 0);
}
function sideHeldCost(sideState) {
  return sideState.positions.reduce((s, pos) => s + pos.cost, 0);
}
function sideRestingBuyCost(sideState) {
  return round2(sideState.buyOrders.reduce((s, o) => s + o.cost, 0));
}
function positionsMarkValue(p) {
  let total = 0;
  for (const side of ['Up', 'Down']) {
    const shares = sideHeldShares(p.sides[side]);
    if (shares <= 0) continue;
    const bid = side === 'Up' ? p.upBid : p.downBid;
    const cost = sideHeldCost(p.sides[side]);
    const price = bid ?? (cost / shares);
    total += shares * price;
  }
  return round2(total);
}
function pairMarkValue(p) {
  return round2(p.bankroll + positionsMarkValue(p));
}
function pushGlobalEquity() {
  const total = round2(Object.values(pairs).reduce((s, p) => s + pairMarkValue(p), 0));
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > 500) totalEquityCurve.shift();
}
function recordEquity(p) {
  p.equityCurve.push({ t: Date.now(), equity: pairMarkValue(p) });
  if (p.equityCurve.length > 300) p.equityCurve.shift();
  pushGlobalEquity();
}
function registerTrade(p, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: p.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Buy placement (ticker-origin or counter-bet-origin — same mechanics)
// ─────────────────────────────────────────
function midPrice(ask, bid) {
  if (ask != null && bid != null) return round2((ask + bid) / 2);
  if (ask != null) return round2(ask);
  if (bid != null) return round2(bid);
  return null;
}
function reservedCashFor(p) {
  return round2(sideRestingBuyCost(p.sides.Up) + sideRestingBuyCost(p.sides.Down));
}

async function placeBuyOrder(p, side, elapsed, kind) {
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  const mid = midPrice(ask, bid);
  if (mid == null) {
    log(`⏭️  ${p.symbol} ${side}: ${kind} buy skipped — no quotes yet`);
    return;
  }
  if (mid < ENTRY_ZONE_MIN || mid > ENTRY_ZONE_MAX) {
    log(`⏭️  ${p.symbol} ${side}: ${kind} buy skipped — mid ${mid.toFixed(2)} outside entry zone [${ENTRY_ZONE_MIN.toFixed(2)}-${ENTRY_ZONE_MAX.toFixed(2)}]`);
    return;
  }

  const shares = FIXED_SHARES;
  const price = round2(Math.max(0.01, mid - BUY_OFFSET));
  const cost = round2(price * shares);

  if (round2(reservedCashFor(p) + cost) > p.bankroll) {
    log(`⏭️  ${p.symbol} ${side}: skip ${kind} buy — insufficient bankroll ($${p.bankroll.toFixed(2)}, need $${cost.toFixed(2)})`);
    return;
  }

  const s = p.sides[side];
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  const order = await placeLimitBuy(tokenId, price, shares);
  s.buyOrders.push({
    orderId: order.id || order.orderId || null,
    price, shares, cost, kind,
    placedAt: Date.now(),
  });
  const tag = kind === 'COUNTER' ? '🔁 COUNTER-BET' : '📥 TICKER';
  log(`${tag} ${p.symbol} ${side}: resting BUY ${shares}sh @ ${price.toFixed(2)} (mid ${mid.toFixed(2)} − ${BUY_OFFSET})`);
}

async function maybeFireBuyTick(p, side, elapsed) {
  if (elapsed >= FLATTEN_SECS) return;
  const s = p.sides[side];
  const nextAt = s.buyTicksFired * BUY_TICK_INTERVAL_SECS;
  if (elapsed < nextAt) return;
  s.buyTicksFired++;
  await placeBuyOrder(p, side, elapsed, 'TICKER');
}

function oppositeSide(side) { return side === 'Up' ? 'Down' : 'Up'; }

// ─────────────────────────────────────────
//  Buy fill / expiry checking. A fill: opens TP + (if before cutoff)
//  fires a counter-bet on the opposite side. An expiry (unfilled for
//  CANCEL_TIMEOUT_SECS): cancels the order, no further action.
// ─────────────────────────────────────────
async function checkBuyFillsAndExpiry(p, side, elapsed) {
  const s = p.sides[side];
  if (!s.buyOrders.length) return;
  const ask = side === 'Up' ? p.upAsk : p.downAsk;

  const stillResting = [];
  for (const order of s.buyOrders) {
    const filled = ask != null && ask <= order.price;
    if (filled) {
      const rebate = makerRebate(order.shares, order.price);
      p.bankroll = round2(p.bankroll - order.cost + rebate);
      p.realizedPnl = round2(p.realizedPnl + rebate);
      p.rebatesEarned = round2(p.rebatesEarned + rebate);
      s.realizedPnl = round2(s.realizedPnl + rebate);
      s.rebatesEarned = round2(s.rebatesEarned + rebate);

      const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
      const tpPrice = round2(order.price + TP_OFFSET);
      const tpOrder = await placeLimitSell(tokenId, tpPrice, order.shares);
      s.positions.push({
        entryPrice: order.price, shares: order.shares, cost: order.cost,
        exit: { kind: 'TP', price: tpPrice, orderId: tpOrder.id || tpOrder.orderId || null, status: 'resting' },
        openedAt: Date.now(),
      });

      log(`🎯 ${p.symbol} ${side} ${order.kind} BUY filled ${order.shares}sh @ ${order.price.toFixed(2)} | cost=$${order.cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP resting @ ${tpPrice.toFixed(2)}`);
      registerTrade(p, { side: 'BUY', outcome: side, reason: `ENTRY-${order.kind}`, price: order.price, shares: order.shares, cost: order.cost, rebate });
      recordEquity(p);

      if (elapsed < FLATTEN_SECS) {
        await placeBuyOrder(p, oppositeSide(side), elapsed, 'COUNTER');
      }
      continue; // filled order dropped, not pushed back
    }

    const ageSecs = (Date.now() - order.placedAt) / 1000;
    if (ageSecs >= CANCEL_TIMEOUT_SECS) {
      await cancelOrder(order.orderId);
      log(`🛑 ${p.symbol} ${side}: ${order.kind} buy ${order.shares}sh @ ${order.price.toFixed(2)} unfilled after ${CANCEL_TIMEOUT_SECS}s — cancelled`);
      continue; // expired, dropped
    }

    stillResting.push(order);
  }
  s.buyOrders = stillResting;
}

// ─────────────────────────────────────────
//  Exit-order fill checking (TP or the 285s FINAL 0.99 sell)
// ─────────────────────────────────────────
async function checkExitFills(p, side) {
  const s = p.sides[side];
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;

  const stillOpen = [];
  for (const pos of s.positions) {
    if (pos.exit.status !== 'resting' || bid < pos.exit.price) { stillOpen.push(pos); continue; }

    const proceeds = round2(pos.exit.price * pos.shares);
    const rebate = makerRebate(pos.shares, pos.exit.price);
    const net = round2(proceeds + rebate);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    s.realizedPnl = round2(s.realizedPnl + profit);
    s.rebatesEarned = round2(s.rebatesEarned + rebate);
    if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }
    pos.exit.status = 'filled';

    const icon = pos.exit.kind === 'TP' ? '💰' : '✅';
    log(`${icon} ${p.symbol} ${side} ${pos.exit.kind} filled ${pos.shares}sh @ ${pos.exit.price.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}) | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: pos.exit.kind, price: pos.exit.price, shares: pos.shares, profit, rebate });
    recordEquity(p);
    // filled position dropped — not pushed back into stillOpen
  }
  s.positions = stillOpen;
}

// ─────────────────────────────────────────
//  FLATTEN_SECS hard stop (default 200s): no more trades this window at all —
//  cancel every resting buy and every resting TP, and cash out any held
//  shares immediately (taker sell at current bid) so the pair is flat and
//  stays flat until the next window loads. Runs once per window.
// ─────────────────────────────────────────
async function maybeFlatten(p, elapsed) {
  if (p.flattenDone || elapsed < FLATTEN_SECS) return;
  p.flattenDone = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];

    if (s.buyOrders.length) {
      for (const order of s.buyOrders) {
        await cancelOrder(order.orderId);
        log(`🛑 ${p.symbol} ${side}: unfilled ${order.kind} buy ${order.shares}sh @ ${order.price.toFixed(2)} cancelled — FLATTEN at ${FLATTEN_SECS}s`);
      }
      s.buyOrders = [];
    }

    if (!s.positions.length) continue;

    const bid = side === 'Up' ? p.upBid : p.downBid;
    const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;

    for (const pos of s.positions) {
      if (pos.exit.status === 'resting') await cancelOrder(pos.exit.orderId);

      const haveQuote = bid != null;
      const exitPrice = haveQuote ? bid : round2(pos.cost / pos.shares);
      if (!haveQuote) {
        log(`⚠️  ${p.symbol} ${side}: no live bid at FLATTEN — closing ${pos.shares}sh at cost basis ${exitPrice.toFixed(2)} (breakeven)`);
      } else {
        await placeMarketSell(tokenId, exitPrice, pos.shares);
      }

      const proceeds = round2(exitPrice * pos.shares);
      const fee = haveQuote ? takerFee(pos.shares, exitPrice) : 0;
      const net = round2(proceeds - fee);
      p.bankroll = round2(p.bankroll + net);
      const profit = round2(net - pos.cost);
      p.realizedPnl = round2(p.realizedPnl + profit);
      p.feesPaid = round2(p.feesPaid + fee);
      s.realizedPnl = round2(s.realizedPnl + profit);
      if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }

      log(`🏳️  ${p.symbol} ${side}: FLATTEN cashed out ${pos.shares}sh @ ${exitPrice.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}) | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { side: 'SELL', outcome: side, reason: 'FLATTEN', price: exitPrice, shares: pos.shares, profit, fee });
    }
    s.positions = [];
  }

  recordEquity(p);
  log(`🏳️  ${p.symbol}: FLATTENED at ${FLATTEN_SECS}s — no more trades this window, flat until next window`);
}

// ─────────────────────────────────────────
//  285s sweep: cancel unfilled buys + unfilled TPs, roll remainder into 0.99 sell
// ─────────────────────────────────────────
async function maybeSweep(p, elapsed) {
  if (p.sweepDone || elapsed < SWEEP_SECS) return;
  p.sweepDone = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];

    if (s.buyOrders.length) {
      for (const order of s.buyOrders) {
        await cancelOrder(order.orderId);
        log(`🛑 ${p.symbol} ${side}: unfilled ${order.kind} buy ${order.shares}sh @ ${order.price.toFixed(2)} cancelled at ${SWEEP_SECS}s`);
      }
      s.buyOrders = [];
    }

    let sweepShares = 0, sweepCost = 0;
    const kept = [];
    for (const pos of s.positions) {
      if (pos.exit.status === 'resting') {
        await cancelOrder(pos.exit.orderId);
        sweepShares += pos.shares;
        sweepCost = round2(sweepCost + pos.cost);
      } else {
        kept.push(pos); // already filled/closed, shouldn't normally happen here
      }
    }
    s.positions = kept;

    if (sweepShares > 0) {
      const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
      const order = await placeLimitSell(tokenId, FINAL_SELL_PRICE, sweepShares);
      s.positions.push({
        entryPrice: round2(sweepCost / sweepShares), shares: sweepShares, cost: sweepCost,
        exit: { kind: 'FINAL', price: FINAL_SELL_PRICE, orderId: order.id || order.orderId || null, status: 'resting' },
        openedAt: Date.now(),
      });
      log(`🎯 ${p.symbol} ${side}: cancelled ${sweepShares}sh of pending TPs, resting FINAL SELL @ ${FINAL_SELL_PRICE} for combined ${sweepShares}sh`);
    }
  }
}

// ─────────────────────────────────────────
//  Window resolution
// ─────────────────────────────────────────
async function determineWinningSide(p) {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(p.slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === p.conditionId) || (event.markets || [])[0];
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const winner = (outcomes[bestI] || '').trim();
      if (winner) return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
    }
  } catch (_) { /* fall through */ }
  if (p.upBid != null && p.downBid != null) return p.upBid >= p.downBid ? 'Up' : 'Down';
  return null;
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    for (const order of s.buyOrders) {
      await cancelOrder(order.orderId);
      log(`🛑 ${p.symbol} ${side}: unfilled ${order.kind} buy ${order.shares}sh cancelled at window close`);
    }
    s.buyOrders = [];
    for (const pos of s.positions) {
      if (pos.exit.status === 'resting') {
        await cancelOrder(pos.exit.orderId);
        log(`🛑 ${p.symbol} ${side}: unfilled ${pos.exit.kind} cancelled at window close — resolving instead`);
      }
    }
  }

  const anyPosition = ['Up', 'Down'].some(s => sideHeldShares(p.sides[s]) > 0);
  if (!anyPosition) return;

  const winner = await determineWinningSide(p);
  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    const shares = sideHeldShares(s);
    if (shares <= 0) continue;
    const cost = sideHeldCost(s);
    const won = winner === side;
    const proceeds = won ? round2(shares * 1) : 0;
    const profit = round2(proceeds - cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    s.realizedPnl = round2(s.realizedPnl + profit);
    if (won) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION ${side} ${shares}sh cost=$${cost.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: 'RESOLUTION', price: won ? 1 : 0, shares, profit });
    s.positions = [];
  }
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Main per-pair tick
// ─────────────────────────────────────────
async function processPair(p) {
  // Give the old window's FINAL sell up to RESOLUTION_BUFFER_S extra seconds
  // to fill before we force-resolve and roll over to the next window. This
  // must run BEFORE the rollover check below, otherwise ws !== p.windowStart
  // fires the instant the clock crosses the boundary and resolves the window
  // immediately, starving the buffer down to 0s.
  if (p.windowStart !== null && !p.resolvedThisWindow) {
    const remainingOld = p.windowEnd - nowSec();
    if (remainingOld <= -RESOLUTION_BUFFER_S) {
      await resolvePairWindow(p);
    }
  }

  const ws = currentWindowStart();
  if (p.windowStart === null || (ws !== p.windowStart && p.resolvedThisWindow)) {
    await loadPairWindow(p);
  }
  if (!p.tradable) return;
  if (!tradingEnabled) return;

  const elapsed = nowSec() - p.windowStart;

  for (const side of ['Up', 'Down']) {
    await checkBuyFillsAndExpiry(p, side, elapsed);
    await checkExitFills(p, side);
    await maybeFireBuyTick(p, side, elapsed);
  }

  await maybeFlatten(p, elapsed);
  await maybeSweep(p, elapsed);
}

// ─────────────────────────────────────────
//  UI state — full detail per side for dashboard observation
// ─────────────────────────────────────────
const MAX_TICKS = Math.max(1, Math.ceil(FLATTEN_SECS / BUY_TICK_INTERVAL_SECS));

function sideSummary(p, side, elapsed) {
  const s = p.sides[side];
  const restingBuys = s.buyOrders
    .slice()
    .sort((a, b) => a.placedAt - b.placedAt)
    .map(o => ({
      price: o.price, shares: o.shares, cost: o.cost, kind: o.kind,
      ageSecs: Math.floor((Date.now() - o.placedAt) / 1000),
      expiresInSecs: Math.max(0, Math.round(CANCEL_TIMEOUT_SECS - (Date.now() - o.placedAt) / 1000)),
    }));
  const openTps = s.positions
    .filter(pos => pos.exit.status === 'resting' && pos.exit.kind === 'TP')
    .map(pos => ({ entryPrice: pos.entryPrice, shares: pos.shares, tpPrice: pos.exit.price }));
  const openFinals = s.positions
    .filter(pos => pos.exit.status === 'resting' && pos.exit.kind === 'FINAL')
    .map(pos => ({ shares: pos.shares, price: pos.exit.price }));

  const entriesOpen = elapsed != null && elapsed < FLATTEN_SECS;
  const nextTickInSecs = entriesOpen
    ? Math.max(0, Math.round((s.buyTicksFired * BUY_TICK_INTERVAL_SECS) - elapsed))
    : null;

  return {
    restingBuys,
    restingBuyCount: restingBuys.length,
    restingBuyCost: sideRestingBuyCost(s),
    heldShares: sideHeldShares(s),
    heldCost: sideHeldCost(s),
    openTps,
    openFinals,
    buyTicksFired: s.buyTicksFired,
    maxTicks: MAX_TICKS,
    nextTickInSecs,
    wins: s.wins,
    losses: s.losses,
    realizedPnl: s.realizedPnl,
    rebatesEarned: s.rebatesEarned,
  };
}

function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(positionsMarkValue(p) - (sideHeldCost(p.sides.Up) + sideHeldCost(p.sides.Down)));
    const markValue = pairMarkValue(p);
    const elapsed = p.windowStart != null ? Math.max(0, nowSec() - p.windowStart) : null;
    let phase = '—';
    if (p.tradable && elapsed != null) {
      phase = elapsed >= SWEEP_SECS ? 'SWEPT / RESOLVING'
        : elapsed >= FLATTEN_SECS ? 'FLAT'
        : elapsed >= ENTRY_CUTOFF_SECS ? 'NO NEW ENTRIES'
        : 'ENTRIES OPEN';
    }
    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      eventTitle: p.eventTitle,
      windowEnd: p.windowEnd,
      elapsedSecs: elapsed != null ? Math.floor(elapsed) : null,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      phase,
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      sides: { Up: sideSummary(p, 'Up', elapsed), Down: sideSummary(p, 'Down', elapsed) },
      equityCurve: p.equityCurve,
    };
  });

  const totalBankroll = round2(pairStates.reduce((s, p) => s + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((s, p) => s + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((s, p) => s + p.realizedPnl, 0));
  const totalUnrealized = round2(pairStates.reduce((s, p) => s + p.unrealizedPnl, 0));
  const totalWins = pairStates.reduce((s, p) => s + p.wins, 0);
  const totalLosses = pairStates.reduce((s, p) => s + p.losses, 0);
  const totalFeesPaid = round2(pairStates.reduce((s, p) => s + p.feesPaid, 0));
  const totalRebatesEarned = round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0));

  return {
    dryRun: DRY_RUN,
    tradingEnabled,
    pairs: pairList,
    totalCapital: TOTAL_CAPITAL,
    perPairCapital,
    totalBankroll,
    totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized,
    totalUnrealizedPnl: totalUnrealized,
    totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid,
    totalRebatesEarned,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      buyOffset: BUY_OFFSET,
      tpOffset: TP_OFFSET,
      buyTickIntervalSecs: BUY_TICK_INTERVAL_SECS,
      cancelTimeoutSecs: CANCEL_TIMEOUT_SECS,
      entryZoneMin: ENTRY_ZONE_MIN,
      entryZoneMax: ENTRY_ZONE_MAX,
      entryCutoffSecs: ENTRY_CUTOFF_SECS,
      sweepSecs: SWEEP_SECS,
      finalSellPrice: FINAL_SELL_PRICE,
      fixedShares: FIXED_SHARES,
      flattenSecs: FLATTEN_SECS,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates,
    totalEquityCurve,
    logs: logs.slice(-120),
    trades: trades.slice(-100).reverse(),
  };
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
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) {
        lastPolyPriceFetch = now;
        await refreshPolyPrices();
      }
      for (const p of Object.values(pairs)) {
        try { await processPair(p); } catch (e) { log(`⚠️  ${p.symbol} tick error: ${e.message}`); }
      }
      emitFn('state', buildState());
    } catch (e) {
      log(`⚠️  Loop error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  Public controls
// ─────────────────────────────────────────
function setPairs(list) {
  const clean = (list || []).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!clean.length) return { ok: false, error: 'Empty pair list' };
  pairList = [...new Set(clean)];
  resetPairs();
  log(`⚙️  Pairs updated: ${pairList.join(', ')} | $${perPairCapital.toFixed(2)} per pair`);
  return { ok: true, pairs: pairList, perPairCapital };
}
function pauseTrading() {
  tradingEnabled = false;
  log('⏸️  Trading paused (open/pending orders still managed for fills/TP/resolution)');
  return { ok: true };
}
function resumeTrading() {
  tradingEnabled = true;
  log('▶️  Trading resumed');
  return { ok: true };
}
function getStatus() { return { ok: true, ...buildState() }; }

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 5-Minute BTC Up/Down — Ticker + Counter-Bet Scalper`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pair(s) (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Each side independently, every ${BUY_TICK_INTERVAL_SECS}s: new buy @ mid − ${BUY_OFFSET}, ${FIXED_SHARES}sh, only if mid in [${ENTRY_ZONE_MIN}-${ENTRY_ZONE_MAX}]`);
  log(`⚙️  Unfilled buys cancelled after ${CANCEL_TIMEOUT_SECS}s | any fill rests a TP @ entry + ${TP_OFFSET} and fires a counter-bet on the opposite side`);
  log(`⚙️  No new entries after ${ENTRY_CUTOFF_SECS}s | at ${SWEEP_SECS}s: cancel unfilled buys/TPs, roll remainder into one @ ${FINAL_SELL_PRICE} sell per side`);
  log(`⚙️  HARD STOP at ${FLATTEN_SECS}s: no more trades this window — cancel all resting buys/TPs and cash out any held shares immediately, flat until next window`);
  log(`⚙️  Unfilled ${FINAL_SELL_PRICE} sell at window close → resolves to actual outcome`);
  log(`⚙️  fees: all buys + TP + final sell are maker (0 fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate) | no taker orders in this strategy`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
