'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — SINGLE-ENTRY FLIP-RECOVERY BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  Complete rewrite — the 4-level breakout pyramid is gone, no trace
 *  remains. New strategy, from scratch:
 *
 *  PER WINDOW:
 *    1. After SIDE_PICK_ELAPSED_SEC into the window, watch both Up and
 *       Down. Whichever side's ask first reaches ENTRY_PRICE (0.60) gets
 *       a genuine RESTING LIMIT BUY at 0.60, sized at BASE_SIZE_PCT
 *       (1.2%) of current bankroll — so the base size compounds up after
 *       every win instead of staying fixed. It's a passive maker order,
 *       not a taker cross. It only "fills" (in this
 *       simulation/paper model) once the ask actually trades back down
 *       to <= 0.60 — if price gaps straight through 0.60 without pausing
 *       there, the order sits unfilled until price revisits that level.
 *    2. Once filled, a resting TP limit sell is armed at 0.99 (maker).
 *       We now also watch the OPPOSITE side. If it reaches 0.60 too
 *       (meaning our side is now very likely losing, since Up+Down≈1),
 *       that's a FLIP trigger — capped at MAX_FLIPS_PER_WINDOW (1) per
 *       window:
 *         - Estimate the current position's loss (cost minus its shares
 *           marked at the current bid).
 *         - Flip size = ceil((carried cumulativeLoss + this loss estimate
 *           + PROFIT_TARGET $5) / (0.99 − 0.60)) shares, so that if the
 *           flip fills and later hits TP at 0.99, it recovers every
 *           dollar lost so far AND nets the flat $5 target.
 *         - That size is rested as a limit buy at 0.60 on the opposite
 *           side. Once THAT order is confirmed filled, the original
 *           losing position is immediately force-sold (a marketable
 *           taker sell at the current bid) to close it out.
 *    3. Only one flip per window. If that flip doesn't hit TP and instead
 *       loses at window resolution, its loss is added to cumulativeLoss
 *       and carried into the NEXT window's flip-sizing math — the bot
 *       keeps trying (fresh 10-share base entry each window, sized flip
 *       if triggered) until a position actually wins. Any win (TP or a
 *       correct resolution) resets cumulativeLoss and the flip-chain
 *       counter to zero.
 *    4. The flip chain is capped at MAX_FLIP_CHAIN (7) total flips across
 *       however many windows it takes. If 7 flips pass with no win, the
 *       bot force-resets cumulativeLoss and the chain counter to zero
 *       (logged distinctly from a real win) and starts clean next window
 *       — per explicit instruction, this is NOT a hard stop.
 *    5. No new base entry or flip fires inside the final
 *       ENTRY_CUTOFF_REMAINING_SEC seconds of a window (no runway left
 *       to manage it). Any position never TP'd rides to the real
 *       resolution, exactly as before.
 *
 *  FEES: entries (base + flip) are genuine resting maker orders now, so
 *  they earn the maker rebate on fill (no taker fee). TP is maker too.
 *  The force-sell that closes a position right after a flip fills is a
 *  marketable taker sell, so it pays the taker fee. Resolution settlement
 *  is always fee-free. (Polymarket Fee Structure V2, crypto category:
 *  taker fee = shares × 0.07 × price × (1-price), maker rebate = 20% of
 *  that same amount.)
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
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 500);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ── Single-entry flip-recovery parameters ──
const SIDE_PICK_ELAPSED_SEC = Number(process.env.SIDE_PICK_ELAPSED_SEC || 120); // wait this long into the window before watching for a side to pick
const ENTRY_PRICE = Number(process.env.ENTRY_PRICE || 0.60); // both base and flip entries rest here
const TP_PRICE = Number(process.env.TP_PRICE || 0.99);
const BASE_SIZE_PCT = Number(process.env.BASE_SIZE_PCT || 0.012); // base entry = this % of current bankroll — compounds after each win
const MIN_BASE_SHARES = Number(process.env.MIN_BASE_SHARES || 1);
const PROFIT_TARGET = Number(process.env.PROFIT_TARGET || 5); // flat $ target baked into every flip's sizing
const MAX_FLIPS_PER_WINDOW = Number(process.env.MAX_FLIPS_PER_WINDOW || 1);
const MAX_FLIP_CHAIN = Number(process.env.MAX_FLIP_CHAIN || 7); // total flips allowed across the whole carry-over chain before a forced reset
const ENTRY_CUTOFF_REMAINING_SEC = Number(process.env.ENTRY_CUTOFF_REMAINING_SEC || 15); // no NEW base/flip entries this close to window close

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
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-flip-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-flip-bot/1.0' },
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
async function cancelOrder(orderId) {
  if (!DRY_RUN && trader && orderId) {
    try { await trader.cancelOrder(orderId); }
    catch (e) { log(`⚠️  cancel failed: ${e.message}`); }
  }
}
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
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

    // per-window trade state (reset every new window)
    pickedSide: null,           // side of the current/most recent order this window
    baseOrder: null,            // { side, shares, orderId } — pending resting buy @ ENTRY_PRICE
    flipOrder: null,            // { side, shares, orderId, targetRecovery, lossEstimate } — pending resting flip buy
    position: null,             // { type:'base'|'flip', side, entryPrice, shares, cost, tpOrderId }
    flipsThisWindow: 0,
    resolvedThisWindow: true,

    // persistent recovery state — carries across windows, reset only on a win or forced 7-flip reset
    cumulativeLoss: 0,
    flipChainCount: 0,
    forcedResets: 0,

    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,
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

  // Reset per-window trade state only — cumulativeLoss / flipChainCount / bankroll / stats persist.
  p.pickedSide = null;
  p.baseOrder = null;
  p.flipOrder = null;
  p.position = null;
  p.flipsThisWindow = 0;

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
//  Side helpers
// ─────────────────────────────────────────
function oppositeSide(side) { return side === 'Up' ? 'Down' : 'Up'; }
function sideAsk(p, side) { return side === 'Up' ? p.upAsk : p.downAsk; }
function sideBid(p, side) { return side === 'Up' ? p.upBid : p.downBid; }
function sideTokenId(p, side) { return side === 'Up' ? p.upTokenId : p.downTokenId; }
function computeBaseShares(p) {
  const dollarSize = p.bankroll * BASE_SIZE_PCT;
  return Math.max(MIN_BASE_SHARES, Math.round(dollarSize / ENTRY_PRICE));
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function positionMarkValue(p) {
  if (!p.position) return 0;
  const bid = sideBid(p, p.position.side);
  const price = bid ?? p.position.entryPrice;
  return round2(p.position.shares * price);
}
function pairMarkValue(p) {
  return round2(p.bankroll + positionMarkValue(p));
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
//  Recovery bookkeeping
// ─────────────────────────────────────────
function resetRecovery(p, reason) {
  p.cumulativeLoss = 0;
  p.flipChainCount = 0;
  if (reason === 'forced') {
    p.forcedResets += 1;
    log(`♻️  ${p.symbol} FORCED RESET — ${MAX_FLIP_CHAIN} flips reached with no win. Recovery target & flip chain cleared (no win credited); back to a plain ${(BASE_SIZE_PCT*100).toFixed(1)}%-of-bankroll base next opportunity.`);
  } else {
    log(`🏁 ${p.symbol} recovery reset — win recorded, cumulative loss & flip chain cleared.`);
  }
}

// ─────────────────────────────────────────
//  Step 1: place the base entry
// ─────────────────────────────────────────
async function tryPlaceBaseOrder(p, elapsed, remaining) {
  if (p.pickedSide || p.baseOrder || p.position) return;
  if (elapsed < SIDE_PICK_ELAPSED_SEC || remaining < ENTRY_CUTOFF_REMAINING_SEC) return;

  let side = null;
  if (p.upAsk != null && p.upAsk >= ENTRY_PRICE) side = 'Up';
  else if (p.downAsk != null && p.downAsk >= ENTRY_PRICE) side = 'Down';
  if (!side) return;

  const shares = computeBaseShares(p);
  const tokenId = sideTokenId(p, side);
  const order = await placeLimitBuy(tokenId, ENTRY_PRICE, shares);
  p.pickedSide = side;
  p.baseOrder = { side, shares, orderId: order.id || order.orderId || null };
  log(`🔭 ${p.symbol} ${side} touched ${ENTRY_PRICE.toFixed(2)} — resting BASE limit buy ${shares}sh (${(BASE_SIZE_PCT*100).toFixed(1)}% of $${p.bankroll.toFixed(2)}) @ ${ENTRY_PRICE.toFixed(2)}`);
}

// ─────────────────────────────────────────
//  Step 2: check base order fill
// ─────────────────────────────────────────
async function checkBaseOrderFill(p) {
  if (!p.baseOrder) return;
  const ask = sideAsk(p, p.baseOrder.side);
  if (ask == null || ask > ENTRY_PRICE) return; // not touched yet, still resting

  const shares = p.baseOrder.shares;
  const cost = round2(shares * ENTRY_PRICE);
  const rebate = makerRebate(shares, ENTRY_PRICE);
  p.bankroll = round2(p.bankroll - cost + rebate);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);

  const tokenId = sideTokenId(p, p.baseOrder.side);
  const tpOrder = await placeLimitSell(tokenId, TP_PRICE, shares);
  p.position = { type: 'base', side: p.baseOrder.side, entryPrice: ENTRY_PRICE, shares, cost, tpOrderId: tpOrder.id || tpOrder.orderId || null };

  log(`✅ ${p.symbol} BASE filled ${shares}sh ${p.baseOrder.side} @ ${ENTRY_PRICE.toFixed(2)} | cost=$${cost.toFixed(2)} rebate=+$${rebate.toFixed(4)} | TP armed @ ${TP_PRICE}`);
  registerTrade(p, { side: 'BUY', outcome: p.baseOrder.side, reason: 'BASE', price: ENTRY_PRICE, shares, cost, rebate });
  p.baseOrder = null;
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Step 3: watch for a flip trigger and size it
// ─────────────────────────────────────────
async function tryTriggerFlip(p, remaining) {
  if (!p.position || p.flipOrder) return;
  if (p.flipsThisWindow >= MAX_FLIPS_PER_WINDOW) return;
  if (p.flipChainCount >= MAX_FLIP_CHAIN) return; // safety net; forced reset should already have cleared this
  if (remaining < ENTRY_CUTOFF_REMAINING_SEC) return;

  const oppSide = oppositeSide(p.position.side);
  const oppAsk = sideAsk(p, oppSide);
  if (oppAsk == null || oppAsk < ENTRY_PRICE) return;

  const posBid = sideBid(p, p.position.side);
  const markPrice = posBid != null ? posBid : p.position.entryPrice;
  const lossEstimate = Math.max(0, round2(p.position.cost - p.position.shares * markPrice));
  const target = round2(p.cumulativeLoss + lossEstimate + PROFIT_TARGET);

  let flipShares = Math.max(1, Math.ceil(target / (TP_PRICE - ENTRY_PRICE)));
  let cost = round2(flipShares * ENTRY_PRICE);

  if (cost > p.bankroll) {
    const affordable = Math.floor((p.bankroll * 0.98) / ENTRY_PRICE);
    if (affordable < 1) {
      log(`⚠️  ${p.symbol} flip trigger hit but bankroll $${p.bankroll.toFixed(2)} can't cover any shares — skipping flip, current position rides to resolution`);
      return;
    }
    log(`⚠️  ${p.symbol} flip sized ${flipShares}sh ($${cost.toFixed(2)}) exceeds bankroll $${p.bankroll.toFixed(2)} — capping to ${affordable}sh (full recovery target not covered)`);
    flipShares = affordable;
    cost = round2(flipShares * ENTRY_PRICE);
  }

  const tokenId = sideTokenId(p, oppSide);
  const order = await placeLimitBuy(tokenId, ENTRY_PRICE, flipShares);
  p.flipOrder = { side: oppSide, shares: flipShares, orderId: order.id || order.orderId || null, targetRecovery: target, lossEstimate };
  log(`🔄 ${p.symbol} FLIP triggered — ${oppSide} touched ${ENTRY_PRICE.toFixed(2)}. Resting flip limit buy ${flipShares}sh @ ${ENTRY_PRICE.toFixed(2)} (covers carried $${p.cumulativeLoss.toFixed(2)} + est. loss $${lossEstimate.toFixed(2)} + $${PROFIT_TARGET} target)`);
}

// ─────────────────────────────────────────
//  Step 4: flip fill → force-sell the old position, open the new one
// ─────────────────────────────────────────
async function checkFlipOrderFill(p) {
  if (!p.flipOrder) return;
  const ask = sideAsk(p, p.flipOrder.side);
  if (ask == null || ask > ENTRY_PRICE) return; // not touched yet, still resting

  // Confirmed filled — force-sell the previous position immediately (marketable/taker).
  const prevPos = p.position;
  const tokenId = sideTokenId(p, prevPos.side);
  const bid = sideBid(p, prevPos.side) ?? 0;
  await placeLimitSell(tokenId, bid, prevPos.shares); // marketable/taker — crosses the spread at the live bid
  const fee = takerFee(prevPos.shares, bid);
  const proceeds = round2(bid * prevPos.shares);
  const net = round2(proceeds - fee);
  p.bankroll = round2(p.bankroll + net);
  const lossOnPrev = round2(prevPos.cost - net);
  p.realizedPnl = round2(p.realizedPnl - lossOnPrev);
  p.feesPaid = round2(p.feesPaid + fee);
  await cancelOrder(prevPos.tpOrderId);

  log(`⚡ ${p.symbol} FORCE-SOLD prior ${prevPos.side} ${prevPos.shares}sh @ ${bid.toFixed(2)} | fee=-$${fee.toFixed(4)} | realized loss=$${lossOnPrev.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: prevPos.side, reason: 'FLIP_FORCE_SELL', price: bid, shares: prevPos.shares, profit: -lossOnPrev, fee });

  // Open the flip position.
  const shares = p.flipOrder.shares;
  const cost = round2(shares * ENTRY_PRICE);
  const rebate = makerRebate(shares, ENTRY_PRICE);
  p.bankroll = round2(p.bankroll - cost + rebate);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);

  const flipTokenId = sideTokenId(p, p.flipOrder.side);
  const tpOrder = await placeLimitSell(flipTokenId, TP_PRICE, shares);
  p.position = { type: 'flip', side: p.flipOrder.side, entryPrice: ENTRY_PRICE, shares, cost, tpOrderId: tpOrder.id || tpOrder.orderId || null };
  p.flipChainCount += 1;
  p.flipsThisWindow += 1;
  p.pickedSide = p.flipOrder.side;

  log(`✅ ${p.symbol} FLIP filled ${shares}sh ${p.flipOrder.side} @ ${ENTRY_PRICE.toFixed(2)} | cost=$${cost.toFixed(2)} rebate=+$${rebate.toFixed(4)} | TP armed @ ${TP_PRICE} | flip ${p.flipChainCount}/${MAX_FLIP_CHAIN} in chain`);
  registerTrade(p, { side: 'BUY', outcome: p.flipOrder.side, reason: 'FLIP', price: ENTRY_PRICE, shares, cost, rebate });
  p.flipOrder = null;
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Step 5: TP fill on whatever's currently open (base or flip)
// ─────────────────────────────────────────
async function checkTpFill(p) {
  if (!p.position) return;
  const bid = sideBid(p, p.position.side);
  if (bid == null || bid < TP_PRICE) return;

  const pos = p.position;
  const proceeds = round2(TP_PRICE * pos.shares);
  const rebate = makerRebate(pos.shares, TP_PRICE);
  const net = round2(proceeds + rebate);
  p.bankroll = round2(p.bankroll + net);
  const profit = round2(net - pos.cost);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  p.wins++;

  log(`💰 ${p.symbol} ${pos.type.toUpperCase()} TP filled ${pos.shares}sh ${pos.side} @ ${TP_PRICE} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: pos.side, reason: 'TP', price: TP_PRICE, shares: pos.shares, profit, rebate });
  resetRecovery(p, 'win');
  p.position = null;
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

  // Cancel any resting orders that never got touched this window.
  if (p.baseOrder) {
    log(`⏱️  ${p.symbol} BASE order never touched — cancelling`);
    await cancelOrder(p.baseOrder.orderId);
    p.baseOrder = null;
  }
  if (p.flipOrder) {
    log(`⏱️  ${p.symbol} FLIP order never touched — cancelling`);
    await cancelOrder(p.flipOrder.orderId);
    p.flipOrder = null;
  }

  if (!p.position) { recordEquity(p); return; }

  const winner = await determineWinningSide(p);
  const pos = p.position;
  const won = winner === pos.side;
  const proceeds = won ? round2(pos.shares * 1) : 0;
  const profit = round2(proceeds - pos.cost);
  p.bankroll = round2(p.bankroll + proceeds);
  p.realizedPnl = round2(p.realizedPnl + profit);

  if (won) {
    p.wins++;
    log(`💰 ${p.symbol} ${pos.type.toUpperCase()} RESOLUTION WIN ${pos.side} ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: pos.side, reason: 'RESOLUTION', price: 1, shares: pos.shares, profit });
    resetRecovery(p, 'win');
  } else {
    p.losses++;
    const loss = round2(pos.cost - proceeds);
    p.cumulativeLoss = round2(p.cumulativeLoss + loss);
    log(`💥 ${p.symbol} ${pos.type.toUpperCase()} RESOLUTION LOSS ${pos.side} ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} | pnl=$${profit.toFixed(2)} | carried loss now $${p.cumulativeLoss.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: pos.side, reason: 'RESOLUTION', price: 0, shares: pos.shares, profit });
    if (p.flipChainCount >= MAX_FLIP_CHAIN) resetRecovery(p, 'forced');
  }
  p.position = null;
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

  const elapsed = nowSec() - p.windowStart;
  const remaining = p.windowEnd - nowSec();

  if (tradingEnabled) {
    await tryPlaceBaseOrder(p, elapsed, remaining);
    await checkBaseOrderFill(p);
    await tryTriggerFlip(p, remaining);
    await checkFlipOrderFill(p);
    await checkTpFill(p);
  }

  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(p.position ? positionMarkValue(p) - p.position.cost : 0);
    const markValue = pairMarkValue(p);
    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      pickedSide: p.pickedSide,
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      cumulativeLoss: p.cumulativeLoss,
      flipChainCount: p.flipChainCount,
      maxFlipChain: MAX_FLIP_CHAIN,
      forcedResets: p.forcedResets,
      baseOrder: p.baseOrder ? { side: p.baseOrder.side, shares: p.baseOrder.shares } : null,
      flipOrder: p.flipOrder ? { side: p.flipOrder.side, shares: p.flipOrder.shares, targetRecovery: p.flipOrder.targetRecovery } : null,
      position: p.position ? { type: p.position.type, side: p.position.side, entryPrice: p.position.entryPrice, shares: p.position.shares, cost: p.position.cost } : null,
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
      sidePickElapsedSec: SIDE_PICK_ELAPSED_SEC,
      entryPrice: ENTRY_PRICE,
      tpPrice: TP_PRICE,
      baseSizePct: BASE_SIZE_PCT,
      profitTarget: PROFIT_TARGET,
      maxFlipsPerWindow: MAX_FLIPS_PER_WINDOW,
      maxFlipChain: MAX_FLIP_CHAIN,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates,
    totalEquityCurve,
    logs: logs.slice(-100),
    trades: trades.slice(-80).reverse(),
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
  log('⏸️  Trading paused (open positions/orders still managed for TP/flip/resolution)');
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
  log(`🚀 5-Minute Crypto Up/Down — Single-Entry Flip-Recovery Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  entry ${ENTRY_PRICE} (resting limit, base ${(BASE_SIZE_PCT*100).toFixed(1)}% of bankroll — compounds after each win) after ${SIDE_PICK_ELAPSED_SEC}s | TP@${TP_PRICE} | profit target $${PROFIT_TARGET}/win | ${MAX_FLIPS_PER_WINDOW} flip/window, ${MAX_FLIP_CHAIN} flips/chain before forced reset`);
  log(`⚙️  fees: base/flip entries + TP maker (rebate ${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}%) | force-sell on flip taker (crypto rate ${CRYPTO_TAKER_FEE_RATE})`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
