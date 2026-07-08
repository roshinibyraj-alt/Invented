'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — MOMENTUM RE-ENTRY LADDER
 * ═══════════════════════════════════════════════════════════════
 *
 *  Up and Down are traded as two completely independent ladders —
 *  no cross-side logic of any kind.
 *
 *  This is a MOMENTUM/CONTINUATION ladder (the reverse of the old
 *  dip-buying grid): 9 fixed trigger levels, ascending, every $0.05
 *  from 0.53 to 0.93:
 *
 *      0.53 → TP 0.56        0.73 → TP 0.76        0.93 → TP 0.96
 *      0.58 → TP 0.61        0.78 → TP 0.81
 *      0.63 → TP 0.66        0.83 → TP 0.86
 *      0.68 → TP 0.71        0.88 → TP 0.91
 *
 *  (TP = actual entry price + 0.03, always.)
 *
 *  REALISTIC ORDER PLACEMENT: Polymarket won't usefully hold a
 *  resting order far from the live market. So instead of pre-
 *  placing all 9 orders at window open, each rung stays idle until
 *  price actually rises up into its trigger level. Only THEN does
 *  the bot place a single resting limit buy, priced ONE CENT BELOW
 *  the live ask at that moment (a realistic near-touch maker order,
 *  not a fixed grid price). That order then waits — like any real
 *  resting order — for the ask to actually dip back down to it.
 *  This also means a fresh entry can never fill in the same tick
 *  it's placed (price would have to immediately reverse a full
 *  cent), which kills the old "instant phantom fill" problem.
 *
 *  RE-ENTRY: once a rung's TP fills, that rung goes back to idle
 *  and can trigger a brand-new entry if price revisits its level —
 *  unlimited times per window, per rung.
 *
 *  HARD STOP-LOSS at 0.45 (absolute price, not relative to entry),
 *  shared across the whole side. If the bid drops to or through
 *  0.45, EVERY currently-open rung on that side is flattened at
 *  once (taker exit, guaranteed fill, pays taker fee — no rebate).
 *  Any still-pending (unfilled) resting orders on that side are
 *  cancelled at the same time, since they'd now be stale. The side
 *  is NOT disabled afterward — every rung goes back to idle and can
 *  re-arm and re-enter normally if price climbs back above 0.53.
 *
 *  SIZING: every entry is a FIXED 50 shares (not fixed dollars) —
 *  cost = 50 × entry price, so it varies with price level.
 *
 *  LADDER LIFETIME: rungs can trigger brand-new entries any time
 *  before the 285s sweep. At the sweep, any still-pending
 *  (unfilled) orders are cancelled — no new entries after that.
 *  Rungs already holding a position keep their TP (and the hard SL)
 *  live all the way to window resolution.
 *
 *  CLOSE-OUT: at window end, any rung still holding shares (filled,
 *  TP never hit, SL never hit) resolves against the real outcome —
 *  $1/share if that side won, $0 if it lost.
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

// ── Ladder config (identical on Up and Down, fully independent) ──
const LADDER_BOTTOM  = Number(process.env.LADDER_BOTTOM || 0.53);  // lowest trigger level
const LADDER_TOP     = Number(process.env.LADDER_TOP || 0.93);     // highest trigger level
const LADDER_STEP    = Number(process.env.LADDER_STEP || 0.05);    // step between rungs
const TP_OFFSET       = Number(process.env.TP_OFFSET || 0.03);      // TP = actual fill price + this
const BASE_SHARES    = Number(process.env.BASE_SHARES || 50);      // fixed shares per entry (not fixed $)
const ENTRY_OFFSET   = Number(process.env.ENTRY_OFFSET || 0.01);   // resting buy placed this far below live ask
const HARD_SL_PRICE  = Number(process.env.HARD_SL_PRICE || 0.45);  // absolute price — flattens whole side

const SWEEP_SECS = Number(process.env.SWEEP_SECS || 285); // no new entries triggered after this
const ENTRY_GRACE_SECS = Number(process.env.ENTRY_GRACE_SECS || 5); // ignore triggers in the first few seconds — book may still be thin/junk

// ── Fees & maker rebates (Polymarket Fee Structure V2, crypto category) ──
const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

// ── Build the fixed ladder trigger levels once ──
function buildLadderLevels() {
  const levels = [];
  const botC = Math.round(LADDER_BOTTOM * 100);
  const topC = Math.round(LADDER_TOP * 100);
  const stepC = Math.round(LADDER_STEP * 100);
  for (let c = botC; c <= topC; c += stepC) {
    levels.push({ id: levels.length + 1, triggerPrice: round2(c / 100) });
  }
  return levels;
}
const LADDER_LEVELS = buildLadderLevels();

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
async function placeMarketSell(tokenId, shares) {
  if (!DRY_RUN && trader) return await trader.marketSell(tokenId, shares);
  return { id: `dry-msell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
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
    rungs: LADDER_LEVELS.map(lvl => ({
      id: lvl.id,
      triggerPrice: lvl.triggerPrice,
      status: 'idle',            // 'idle' | 'pending' | 'holding'
      buyOrderId: null,
      pendingOrderPrice: null,   // the actual resting limit price once placed
      entryPrice: null,
      tpPrice: null,
      shares: 0,
      cost: 0,
      tpOrderId: null,
      fillsCount: 0,             // how many times this rung has completed a full buy→TP cycle
      insufficientLogged: false,
    })),
    entries: 0,
    tpHits: 0,
    slHits: 0,
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
        const market = event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];
        if (market && market.closed === true) continue; // never trade a market that's already settled
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

  // fresh ladder state every window — all rungs idle, nothing pre-placed
  p.sweepDone = false;
  p.sides = { Up: freshSideState(), Down: freshSideState() };

  const triggersTxt = LADDER_LEVELS.map(l => `${l.triggerPrice.toFixed(2)}→${round2(l.triggerPrice + TP_OFFSET).toFixed(2)}`).join(', ');
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | ladder triggers armed both sides: ${triggersTxt} | ${BASE_SHARES}sh/entry | hard SL ${HARD_SL_PRICE.toFixed(2)}`);
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
//  Equity tracking — real-time mark-to-market including unrealized P&L
// ─────────────────────────────────────────
function sideHeldShares(sideState) {
  return round2(sideState.rungs.reduce((s, r) => s + (r.status === 'holding' ? r.shares : 0), 0));
}
function sideHeldCost(sideState) {
  return round2(sideState.rungs.reduce((s, r) => s + (r.status === 'holding' ? r.cost : 0), 0));
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
//  Hard stop-loss: absolute price, shared by the whole side. If bid
//  drops to/through HARD_SL_PRICE, flatten every holding rung at
//  once (taker exit) and cancel any pending unfilled orders (stale).
//  Rungs go back to idle — NOT disabled — so they can re-arm and
//  re-enter normally if price recovers back above the ladder.
// ─────────────────────────────────────────
async function maybeHardStopLoss(p, side) {
  const s = p.sides[side];
  const bid = side === 'Up' ? p.upBid : p.downBid;
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  if (bid == null || bid > HARD_SL_PRICE) return;

  let flattenedAny = false;
  for (const rung of s.rungs) {
    if (rung.status === 'pending') {
      if (rung.buyOrderId) await cancelOrder(rung.buyOrderId);
      rung.status = 'idle';
      rung.buyOrderId = null;
      rung.pendingOrderPrice = null;
      continue;
    }
    if (rung.status !== 'holding') continue;

    if (rung.tpOrderId) await cancelOrder(rung.tpOrderId);
    const fee = takerFee(rung.shares, bid);
    const proceeds = round2(bid * rung.shares - fee);
    const profit = round2(proceeds - rung.cost);

    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.feesPaid = round2(p.feesPaid + fee);
    s.realizedPnl = round2(s.realizedPnl + profit);
    s.feesPaid = round2(s.feesPaid + fee);
    s.slHits++;
    if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }

    log(`🛑 ${p.symbol} ${side} rung#${rung.id}: HARD SL @ ${bid.toFixed(2)} (taker, fee=$${fee.toFixed(4)}) — sold ${rung.shares.toFixed(2)}sh entry ${rung.entryPrice.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: `SL-${rung.id}`, price: bid, shares: rung.shares, profit, fee });

    rung.status = 'idle';
    rung.tpOrderId = null;
    rung.entryPrice = null; rung.tpPrice = null;
    rung.shares = 0; rung.cost = 0;
    flattenedAny = true;
  }
  if (flattenedAny) recordEquity(p);
}

// ─────────────────────────────────────────
//  TP checks: any holding rung whose bid has reached its TP price
//  closes (maker sell, earns rebate) and goes back to idle — free to
//  trigger a brand new entry if price revisits its level.
// ─────────────────────────────────────────
async function maybeFillSideTPs(p, side) {
  const s = p.sides[side];
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;
  let anyFilled = false;

  for (const rung of s.rungs) {
    if (rung.status !== 'holding' || bid < rung.tpPrice) continue;

    const proceeds = round2(rung.tpPrice * rung.shares);
    const rebate = makerRebate(rung.shares, rung.tpPrice);
    const net = round2(proceeds + rebate);
    const profit = round2(net - rung.cost);

    p.bankroll = round2(p.bankroll + net);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    s.realizedPnl = round2(s.realizedPnl + profit);
    s.rebatesEarned = round2(s.rebatesEarned + rebate);
    s.tpHits++;
    if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }

    log(`💰 ${p.symbol} ${side} rung#${rung.id}: TP filled ${rung.shares.toFixed(2)}sh @ ${rung.tpPrice.toFixed(2)} (limit, entry ${rung.entryPrice.toFixed(2)}) | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)} | cycle #${rung.fillsCount + 1} on this rung`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: `TP-${rung.id}`, price: rung.tpPrice, shares: rung.shares, profit, rebate });

    rung.fillsCount++;
    rung.status = 'idle';
    rung.tpOrderId = null;
    rung.entryPrice = null; rung.tpPrice = null;
    rung.shares = 0; rung.cost = 0;
    anyFilled = true;
  }

  if (anyFilled) recordEquity(p);
}

// ─────────────────────────────────────────
//  Fill pending resting buys: a rung in 'pending' status has a
//  resting limit order sitting at pendingOrderPrice (= ask at the
//  moment it was triggered, minus ENTRY_OFFSET). It fills only when
//  the ask actually dips back down to or through that fixed price —
//  never in the same tick it was placed.
// ─────────────────────────────────────────
async function maybeFillPendingOrders(p, side) {
  const s = p.sides[side];
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  if (ask == null) return;
  let anyFilled = false;

  for (const rung of s.rungs) {
    if (rung.status !== 'pending') continue;
    if (ask > rung.pendingOrderPrice) continue;

    const shares = BASE_SHARES;
    const price = rung.pendingOrderPrice;
    const rebate = makerRebate(shares, price);
    const cost = round2(price * shares - rebate);

    if (cost > p.bankroll) {
      if (!rung.insufficientLogged) {
        log(`⏭️  ${p.symbol} ${side} rung#${rung.id}: skip fill — insufficient bankroll ($${p.bankroll.toFixed(2)}, need $${cost.toFixed(2)})`);
        rung.insufficientLogged = true;
      }
      continue;
    }

    p.bankroll = round2(p.bankroll - cost);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    s.rebatesEarned = round2(s.rebatesEarned + rebate);
    s.entries++;

    rung.status = 'holding';
    rung.buyOrderId = null;
    rung.entryPrice = price;
    rung.tpPrice = round2(price + TP_OFFSET);
    rung.shares = shares;
    rung.cost = cost;
    rung.insufficientLogged = false;

    const order = await placeLimitSell(tokenId, rung.tpPrice, shares);
    rung.tpOrderId = order.id || order.orderId || null;

    log(`📥 ${p.symbol} ${side} rung#${rung.id}: BUY filled ${shares.toFixed(2)}sh @ ${price.toFixed(2)} (resting limit) | rebate=+$${rebate.toFixed(4)} | resting TP ${rung.tpPrice.toFixed(2)}`);
    registerTrade(p, { side: 'BUY', outcome: side, reason: `ENTRY-${rung.id}`, price, shares, cost });
    anyFilled = true;
  }

  if (anyFilled) recordEquity(p);
}

// ─────────────────────────────────────────
//  Trigger new entries: an idle rung whose trigger level has been
//  reached (ask >= triggerPrice) gets a fresh resting buy PLACED
//  (not filled) at ask - ENTRY_OFFSET. Only before the sweep.
// ─────────────────────────────────────────
async function maybeTriggerNewEntries(p, side, elapsed) {
  if (elapsed < ENTRY_GRACE_SECS || elapsed >= SWEEP_SECS) return;
  const s = p.sides[side];
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  if (ask == null) return;

  for (const rung of s.rungs) {
    if (rung.status !== 'idle') continue;
    if (ask < rung.triggerPrice) continue;

    const orderPrice = round2(ask - ENTRY_OFFSET);
    try {
      const order = await placeLimitBuy(tokenId, orderPrice, BASE_SHARES);
      rung.buyOrderId = order.id || order.orderId || null;
      rung.pendingOrderPrice = orderPrice;
      rung.status = 'pending';
      log(`🎯 ${p.symbol} ${side} rung#${rung.id}: trigger ${rung.triggerPrice.toFixed(2)} reached (ask ${ask.toFixed(2)}) — resting buy placed @ ${orderPrice.toFixed(2)}`);
    } catch (e) {
      log(`⚠️  ${p.symbol} ${side} rung#${rung.id}: failed to place resting buy: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────
//  285s sweep: cancel any STILL-PENDING (unfilled) resting buys.
//  Rungs already holding a position keep their TP and hard SL live
//  all the way to window resolution — untouched by the sweep.
// ─────────────────────────────────────────
async function maybeSweep(p, elapsed) {
  if (p.sweepDone || elapsed < SWEEP_SECS) return;
  p.sweepDone = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    let cancelledCount = 0;
    for (const rung of s.rungs) {
      if (rung.status === 'pending') {
        if (rung.buyOrderId) await cancelOrder(rung.buyOrderId);
        rung.buyOrderId = null;
        rung.pendingOrderPrice = null;
        rung.status = 'idle';
        cancelledCount++;
      }
    }
    const holding = s.rungs.filter(r => r.status === 'holding').length;
    log(`🧹 ${p.symbol} ${side}: sweep @ ${SWEEP_SECS}s — cancelled ${cancelledCount} pending rung order(s), ${holding} holding rung(s) left riding to resolution (TP + hard SL still live)`);
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

  const heldShares = { Up: 0, Down: 0 };
  const heldCost = { Up: 0, Down: 0 };

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];
    for (const rung of s.rungs) {
      if (rung.status === 'pending' && rung.buyOrderId) {
        await cancelOrder(rung.buyOrderId);
        rung.buyOrderId = null;
        rung.status = 'idle';
      }
      if (rung.status === 'holding') {
        if (rung.tpOrderId) await cancelOrder(rung.tpOrderId);
        heldShares[side] = round2(heldShares[side] + rung.shares);
        heldCost[side] = round2(heldCost[side] + rung.cost);
        log(`🛑 ${p.symbol} ${side} rung#${rung.id}: unfilled TP cancelled at window close — resolving instead`);
      }
    }
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
    log(`${icon} ${p.symbol} RESOLUTION ${side} ${shares.toFixed(2)}sh cost=$${cost.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
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
    await maybeHardStopLoss(p, side);
    await maybeFillSideTPs(p, side);
    await maybeFillPendingOrders(p, side);
    await maybeTriggerNewEntries(p, side, elapsed);
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
  const rungs = s.rungs.map(r => ({
    id: r.id,
    triggerPrice: r.triggerPrice,
    status: r.status,
    pendingOrderPrice: r.pendingOrderPrice,
    entryPrice: r.entryPrice,
    tpPrice: r.tpPrice,
    shares: r.shares,
    fillsCount: r.fillsCount,
  }));
  return {
    rungs,
    heldShares: sideHeldShares(s),
    heldCost: sideHeldCost(s),
    entries: s.entries,
    tpHits: s.tpHits,
    slHits: s.slHits,
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
      phase = elapsed >= SWEEP_SECS ? 'SWEPT / RESOLVING' : (elapsed < ENTRY_GRACE_SECS ? 'GRACE PERIOD' : 'LADDER ARMED');
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
      ladderLevels: LADDER_LEVELS.map(l => ({ triggerPrice: l.triggerPrice, tpPrice: round2(l.triggerPrice + TP_OFFSET) })),
      tpOffset: TP_OFFSET,
      baseShares: BASE_SHARES,
      entryOffset: ENTRY_OFFSET,
      hardSlPrice: HARD_SL_PRICE,
      reEntry: true,
      sweepSecs: SWEEP_SECS,
      entryGraceSecs: ENTRY_GRACE_SECS,
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
  log('⏸️  Trading paused (open rungs still managed for TP/SL/sweep/resolution)');
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
  const triggersTxt = LADDER_LEVELS.map(l => `${l.triggerPrice.toFixed(2)}→${round2(l.triggerPrice + TP_OFFSET).toFixed(2)}`).join(', ');
  log(`🚀 5-Minute BTC Up/Down — Momentum Re-Entry Ladder (Up & Down fully independent)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pair(s) (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Ladder triggers (both sides, independent): ${triggersTxt} | ${BASE_SHARES} fixed shares per entry | hard SL @ ${HARD_SL_PRICE.toFixed(2)}`);
  log(`⚙️  Entries are dynamic: resting buy placed at (ask − ${ENTRY_OFFSET.toFixed(2)}) only once a rung's trigger is reached — never pre-placed`);
  log(`⚙️  Unlimited re-entry per rung: after TP, a rung goes idle and can trigger again if price revisits its level`);
  log(`⚙️  Hard SL @ ${HARD_SL_PRICE.toFixed(2)} flattens ALL open rungs on a side at once (taker exit) — side can still re-arm afterward if price recovers`);
  log(`⚙️  At ${SWEEP_SECS}s: cancel still-pending rung orders only | holding rungs ride untouched to resolution (TP + hard SL stay live)`);
  log(`⚙️  First ${ENTRY_GRACE_SECS}s of every window: no new triggers accepted (avoids trading against an empty/junk opening book)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
