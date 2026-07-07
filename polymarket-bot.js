'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — INDEPENDENT DIP-BUY GRID
 * ═══════════════════════════════════════════════════════════════
 *
 *  Up and Down are traded as two completely independent grids —
 *  neither side knows or cares what the other is doing.
 *
 *  Each side runs TWO fixed-price levels:
 *    Level A: buy @ 0.35 → TP @ 0.65
 *    Level B: buy @ 0.25 → TP @ 0.75
 *
 *  HARD STOP-LOSS: 0.10, shared by every open position on a side.
 *  If the bid ever trades down to 0.10, every open position on that
 *  side is closed immediately (market/taker) — this is the only
 *  non-limit order type in the whole bot.
 *
 *  RE-ENTRY: after a level's TP fills, that level re-arms and its
 *  resting buy order goes back up — but only ONCE (max 2 fires per
 *  level per window: the original entry + 1 re-entry). A level that
 *  gets stopped out via the hard SL does NOT re-arm — re-entry is
 *  earned by winning, not by losing. Everything resets fresh each
 *  new 5-minute window.
 *
 *  ORDER TYPES: every buy and every TP sell is a genuine resting
 *  LIMIT order (maker — earns a rebate on fill). The hard SL is the
 *  only order that crosses the spread (taker) — it has to, since a
 *  stop needs to guarantee the exit rather than wait for a fill.
 *
 *  CLOSE-OUT: at SWEEP_SECS (285s) any still-unfilled resting buys
 *  are cancelled, and any open positions still waiting on their TP
 *  are rolled into one maker sell @ 0.99 per side. Anything left
 *  unfilled at window end resolves against the real outcome.
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

// ── Grid levels (fixed absolute prices, identical on Up and Down) ──
const LEVELS = [
  { id: 'A', buyPrice: Number(process.env.LEVEL_A_BUY || 0.35), tpPrice: Number(process.env.LEVEL_A_TP || 0.65) },
  { id: 'B', buyPrice: Number(process.env.LEVEL_B_BUY || 0.25), tpPrice: Number(process.env.LEVEL_B_TP || 0.75) },
];
const HARD_SL_PRICE       = Number(process.env.HARD_SL_PRICE || 0.10); // shared hard stop, all positions on a side
const MAX_ENTRIES_PER_LEVEL = Number(process.env.MAX_ENTRIES_PER_LEVEL || 2); // original + 1 re-entry
const BASE_SHARES         = Number(process.env.BASE_SHARES || 30); // fixed size per fill

const ENTRY_CUTOFF_SECS = Number(process.env.ENTRY_CUTOFF_SECS || 280); // stop arming/filling new entries after this
const SWEEP_SECS        = Number(process.env.SWEEP_SECS || 285);
const FINAL_SELL_PRICE  = Number(process.env.FINAL_SELL_PRICE || 0.99);

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
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-grid-scalper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-grid-scalper/1.0' },
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
async function marketSell(tokenId, shares) {
  // Only order type in the bot that is NOT a limit order — the hard SL
  // needs to guarantee the exit, so it crosses the spread (taker).
  if (!DRY_RUN && trader) return await trader.marketSell(tokenId, shares);
  return { id: `dry-marketsell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
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
function freshLevelState(level) {
  return {
    id: level.id,
    buyPrice: level.buyPrice,
    tpPrice: level.tpPrice,
    armed: true,       // eligible to fill a fresh buy right now
    entriesFired: 0,   // count of fills this window (max MAX_ENTRIES_PER_LEVEL)
    position: null,    // { entryPrice, shares, cost, tpOrderId, openedAt } | null
  };
}
function freshSideState() {
  return {
    levels: LEVELS.map(freshLevelState),
    wins: 0, losses: 0,
    realizedPnl: 0,
    rebatesEarned: 0,
    feesPaid: 0,
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

  // fresh grid every window
  p.sweepDone = false;
  p.sides = { Up: freshSideState(), Down: freshSideState() };

  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | grid armed: A(${LEVELS[0].buyPrice}→${LEVELS[0].tpPrice}) B(${LEVELS[1].buyPrice}→${LEVELS[1].tpPrice}) | hard SL ${HARD_SL_PRICE}`);
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
  return sideState.levels.reduce((s, lv) => s + (lv.position ? lv.position.shares : 0), 0);
}
function sideHeldCost(sideState) {
  return sideState.levels.reduce((s, lv) => s + (lv.position ? lv.position.cost : 0), 0);
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
//  Per-level: fill the resting buy once ask reaches the level price
// ─────────────────────────────────────────
async function maybeFillLevelBuy(p, side, level, elapsed) {
  if (!level.armed || level.position) return;
  if (level.entriesFired >= MAX_ENTRIES_PER_LEVEL) return;
  if (elapsed >= ENTRY_CUTOFF_SECS) return;

  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null || ask > level.buyPrice) return; // resting limit buy not reached yet

  const shares = BASE_SHARES;
  const price = level.buyPrice; // limit buy fills at the resting limit price
  const entryRebate = makerRebate(shares, price); // maker fill — earns a rebate
  const cost = round2(price * shares - entryRebate);

  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol} ${side} L${level.id}: skip fill — insufficient bankroll ($${p.bankroll.toFixed(2)}, need $${cost.toFixed(2)})`);
    return;
  }

  const s = p.sides[side];
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;

  p.bankroll = round2(p.bankroll - cost);
  p.rebatesEarned = round2(p.rebatesEarned + entryRebate);
  s.rebatesEarned = round2(s.rebatesEarned + entryRebate);
  level.entriesFired++;
  level.armed = false;

  await placeLimitBuy(tokenId, price, shares);
  const tpOrder = await placeLimitSell(tokenId, level.tpPrice, shares);
  level.position = {
    entryPrice: price, shares, cost,
    tpOrderId: tpOrder.id || tpOrder.orderId || null,
    openedAt: Date.now(),
  };

  log(`📥 ${p.symbol} ${side} L${level.id}: BUY filled ${shares}sh @ ${price.toFixed(2)} (limit) | rebate=+$${entryRebate.toFixed(4)} | resting TP @ ${level.tpPrice.toFixed(2)} | fire ${level.entriesFired}/${MAX_ENTRIES_PER_LEVEL}`);
  registerTrade(p, { side: 'BUY', outcome: side, reason: `ENTRY-${level.id}`, price, shares, cost });
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Per-level: TP fill (limit/maker) — closes the position and re-arms
//  the level (up to MAX_ENTRIES_PER_LEVEL) for another cycle.
// ─────────────────────────────────────────
async function maybeFillLevelTP(p, side, level) {
  if (!level.position) return;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null || bid < level.tpPrice) return;

  const pos = level.position;
  const proceeds = round2(level.tpPrice * pos.shares);
  const rebate = makerRebate(pos.shares, level.tpPrice);
  const net = round2(proceeds + rebate);
  const profit = round2(net - pos.cost);

  const s = p.sides[side];
  p.bankroll = round2(p.bankroll + net);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  s.realizedPnl = round2(s.realizedPnl + profit);
  s.rebatesEarned = round2(s.rebatesEarned + rebate);
  p.wins++; s.wins++;

  log(`💰 ${p.symbol} ${side} L${level.id}: TP filled ${pos.shares}sh @ ${level.tpPrice.toFixed(2)} (limit) | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: side, reason: `TP-${level.id}`, price: level.tpPrice, shares: pos.shares, profit, rebate });

  level.position = null;
  if (level.entriesFired < MAX_ENTRIES_PER_LEVEL) {
    level.armed = true; // re-entry earned by winning
    log(`🔁 ${p.symbol} ${side} L${level.id}: re-armed for re-entry (${level.entriesFired}/${MAX_ENTRIES_PER_LEVEL} used)`);
  } else {
    log(`🔒 ${p.symbol} ${side} L${level.id}: max entries reached — done for this window`);
  }
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Hard SL — shared by every open position on a side. Market/taker
//  fill; does NOT re-arm the level (re-entry is earned by TP, not SL).
// ─────────────────────────────────────────
async function maybeHardStopSide(p, side) {
  const s = p.sides[side];
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null || bid > HARD_SL_PRICE) return;

  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  for (const level of s.levels) {
    if (!level.position) continue;
    const pos = level.position;

    await cancelOrder(pos.tpOrderId);
    await marketSell(tokenId, pos.shares); // only non-limit order in the bot
    const fee = takerFee(pos.shares, bid);
    const net = round2(bid * pos.shares - fee);
    const profit = round2(net - pos.cost);

    p.bankroll = round2(p.bankroll + net);
    p.feesPaid = round2(p.feesPaid + fee);
    p.realizedPnl = round2(p.realizedPnl + profit);
    s.feesPaid = round2(s.feesPaid + fee);
    s.realizedPnl = round2(s.realizedPnl + profit);
    p.losses++; s.losses++;

    log(`🛑 ${p.symbol} ${side} L${level.id}: HARD SL @ ${bid.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}, trigger ${HARD_SL_PRICE.toFixed(2)}) | ${pos.shares}sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: `SL-${level.id}`, price: bid, shares: pos.shares, profit, fee });

    level.position = null;
    level.armed = false; // no re-entry after a loss
    log(`🔒 ${p.symbol} ${side} L${level.id}: stopped out — no re-entry this window`);
  }
  recordEquity(p);
}

// ─────────────────────────────────────────
//  285s sweep: cancel unfilled resting buys/TPs, roll open positions
//  into one maker sell @ 0.99 per side.
// ─────────────────────────────────────────
async function maybeSweep(p, elapsed) {
  if (p.sweepDone || elapsed < SWEEP_SECS) return;
  p.sweepDone = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    let sweepShares = 0, sweepCost = 0;

    for (const level of s.levels) {
      level.armed = false; // no more new entries this window
      if (level.position) {
        await cancelOrder(level.position.tpOrderId);
        sweepShares += level.position.shares;
        sweepCost = round2(sweepCost + level.position.cost);
        level.position = null;
      }
    }

    if (sweepShares > 0) {
      const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
      const order = await placeLimitSell(tokenId, FINAL_SELL_PRICE, sweepShares);
      s.sweepPosition = {
        entryPrice: round2(sweepCost / sweepShares), shares: sweepShares, cost: sweepCost,
        tpOrderId: order.id || order.orderId || null, status: 'resting',
      };
      log(`🎯 ${p.symbol} ${side}: cancelled resting orders, FINAL SELL @ ${FINAL_SELL_PRICE} resting for ${sweepShares}sh`);
    }
  }
}

async function checkSweepFill(p, side) {
  const s = p.sides[side];
  if (!s.sweepPosition || s.sweepPosition.status !== 'resting') return;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null || bid < FINAL_SELL_PRICE) return;

  const pos = s.sweepPosition;
  const proceeds = round2(FINAL_SELL_PRICE * pos.shares);
  const rebate = makerRebate(pos.shares, FINAL_SELL_PRICE);
  const net = round2(proceeds + rebate);
  const profit = round2(net - pos.cost);

  p.bankroll = round2(p.bankroll + net);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  s.realizedPnl = round2(s.realizedPnl + profit);
  s.rebatesEarned = round2(s.rebatesEarned + rebate);
  if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }

  log(`💰 ${p.symbol} ${side}: FINAL SELL filled ${pos.shares}sh @ ${FINAL_SELL_PRICE} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: side, reason: 'FINAL', price: FINAL_SELL_PRICE, shares: pos.shares, profit, rebate });
  s.sweepPosition = null;
  recordEquity(p);
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
    for (const level of s.levels) {
      if (level.position) {
        await cancelOrder(level.position.tpOrderId);
        log(`🛑 ${p.symbol} ${side} L${level.id}: unfilled TP cancelled at window close — resolving instead`);
      }
    }
    if (s.sweepPosition && s.sweepPosition.status === 'resting') {
      await cancelOrder(s.sweepPosition.tpOrderId);
      log(`🛑 ${p.symbol} ${side}: unfilled FINAL SELL cancelled at window close — resolving instead`);
    }
  }

  const heldShares = { Up: 0, Down: 0 };
  const heldCost = { Up: 0, Down: 0 };
  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    for (const level of s.levels) {
      if (level.position) { heldShares[side] += level.position.shares; heldCost[side] = round2(heldCost[side] + level.position.cost); level.position = null; }
    }
    if (s.sweepPosition) { heldShares[side] += s.sweepPosition.shares; heldCost[side] = round2(heldCost[side] + s.sweepPosition.cost); s.sweepPosition = null; }
  }

  if (heldShares.Up <= 0 && heldShares.Down <= 0) return;

  const winner = await determineWinningSide(p);
  for (const side of ['Up', 'Down']) {
    const shares = heldShares[side];
    if (shares <= 0) continue;
    const s = p.sides[side];
    const cost = heldCost[side];
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
  }
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Main per-pair tick
// ─────────────────────────────────────────
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable) return;
  if (!tradingEnabled) return;

  const elapsed = nowSec() - p.windowStart;

  for (const side of ['Up', 'Down']) {
    await maybeHardStopSide(p, side); // check hard SL first — it overrides everything
    const s = p.sides[side];
    for (const level of s.levels) {
      await maybeFillLevelTP(p, side, level);
      await maybeFillLevelBuy(p, side, level, elapsed);
    }
    await checkSweepFill(p, side);
  }

  await maybeSweep(p, elapsed);

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function sideSummary(p, side) {
  const s = p.sides[side];
  const levels = s.levels.map(lv => ({
    id: lv.id, buyPrice: lv.buyPrice, tpPrice: lv.tpPrice,
    armed: lv.armed, entriesFired: lv.entriesFired, maxEntries: MAX_ENTRIES_PER_LEVEL,
    position: lv.position ? { entryPrice: lv.position.entryPrice, shares: lv.position.shares, cost: lv.position.cost } : null,
  }));
  return {
    levels,
    heldShares: sideHeldShares(s) + (s.sweepPosition ? s.sweepPosition.shares : 0),
    heldCost: sideHeldCost(s) + (s.sweepPosition ? s.sweepPosition.cost : 0),
    wins: s.wins,
    losses: s.losses,
    realizedPnl: s.realizedPnl,
    rebatesEarned: s.rebatesEarned,
    feesPaid: s.feesPaid,
  };
}

function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(positionsMarkValue(p) - (sideHeldCost(p.sides.Up) + sideHeldCost(p.sides.Down)));
    const markValue = pairMarkValue(p);
    const elapsed = p.windowStart != null ? Math.max(0, nowSec() - p.windowStart) : null;
    let phase = '—';
    if (p.tradable && elapsed != null) {
      phase = elapsed >= SWEEP_SECS ? 'SWEPT / RESOLVING' : (elapsed >= ENTRY_CUTOFF_SECS ? 'NO NEW ENTRIES' : 'GRID ARMED');
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
      sides: { Up: sideSummary(p, 'Up'), Down: sideSummary(p, 'Down') },
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
      levels: LEVELS,
      hardSlPrice: HARD_SL_PRICE,
      maxEntriesPerLevel: MAX_ENTRIES_PER_LEVEL,
      baseShares: BASE_SHARES,
      entryCutoffSecs: ENTRY_CUTOFF_SECS,
      sweepSecs: SWEEP_SECS,
      finalSellPrice: FINAL_SELL_PRICE,
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
  log('⏸️  Trading paused (open positions still managed for TP/SL/sweep/resolution)');
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
  log(`🚀 5-Minute BTC Up/Down — Independent Dip-Buy Grid (Up & Down fully separate)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pair(s) (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Level A: buy @ ${LEVELS[0].buyPrice} → TP @ ${LEVELS[0].tpPrice} | Level B: buy @ ${LEVELS[1].buyPrice} → TP @ ${LEVELS[1].tpPrice} | ${BASE_SHARES}sh per fill`);
  log(`⚙️  Hard SL @ ${HARD_SL_PRICE} — shared stop for every open position on a side, market/taker exit (only non-limit order in the bot)`);
  log(`⚙️  Re-entry: up to ${MAX_ENTRIES_PER_LEVEL - 1} re-entry after a TP hit re-arms the level; a stop-out does NOT re-arm`);
  log(`⚙️  All buys and TPs are resting limit orders (maker, earn rebate); only the hard SL crosses the spread`);
  log(`⚙️  At ${SWEEP_SECS}s: cancel unfilled resting orders, roll open positions into one @ ${FINAL_SELL_PRICE} sell per side | unfilled at close resolves to actual outcome`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
