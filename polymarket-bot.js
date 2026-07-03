'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — FLIP RECOVERY BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  The breakout-pyramid strategy (4 fixed levels, doubling size) has been
 *  removed completely. This is a single-position, flip-on-reversal,
 *  recovery-sized martingale — a different strategy from scratch.
 *
 *  PER WINDOW, one "chain" runs at most (no new independent entries once
 *  the chain has started, even if there's time left after it resolves):
 *
 *  1. ENTRY: watch both Up and Down from window open. Whichever side
 *     first trades at/above 0.60 gets a resting (maker) limit buy AT
 *     0.60. Size = BASE_SHARES (10) if there's no carried recovery
 *     deficit, or the recovery formula (below) if there is one.
 *
 *  2. FLIP: while holding that position, if the OPPOSITE side also
 *     trades at/above 0.60 (only possible while our side has fallen,
 *     since Up+Down ≈ 1), that arms a flip:
 *       - estimatedLoss = max(0, currentPosition.cost − currentBid × shares)
 *       - flipShares = ceil((deficit + estimatedLoss + 5) / (0.99 − 0.60))
 *       - rest a new maker limit buy on the opposite side at 0.60, sized
 *         flipShares
 *     The OLD position is NOT touched yet — it keeps its resting TP@0.99
 *     order live. Only once the flip order is CONFIRMED FILLED does the
 *     bot force-sell the old position immediately, as an aggressive taker
 *     order at the live bid — that realized figure (not the estimate) is
 *     what actually updates the running deficit.
 *     Max 2 flips per window. Once used, the current (up to 3rd) position
 *     just rides to TP or to actual resolution — no more flipping.
 *
 *  3. DEFICIT LEDGER (one running number per pair, persists across
 *     windows): grows by the exact realized loss whenever a position
 *     closes red (force-sold in a flip, or resolves to $0 at window
 *     close). Resets to zero the instant ANY position closes green (TP
 *     hit, or resolves to $1) — full reset regardless of how deep it was.
 *     If the 2-flip cap is hit and that final position still loses, the
 *     deficit carries into next window's first entry, which then sizes
 *     off the recovery formula (deficit + 0 + 5) / 0.39 instead of the
 *     10-share base.
 *
 *  Two things assumed, not specified, confirmed with the user beforehand:
 *   - No elapsed-time wait — watches for the 0.60 entry from window open.
 *   - No separate stop-loss anywhere in this design — the only exits from
 *     a red position are a flip or riding all the way to resolution.
 *
 *  FEES (Polymarket Fee Structure V2, crypto: taker fee = shares × 0.07 ×
 *  price × (1-price), maker rebate = that × 20%): every resting buy
 *  (initial entry AND flip entries) and every TP are genuine maker orders
 *  — fee-free plus rebate. The force-sell of an old position during a
 *  flip is the only taker order in this strategy, so it's the only place
 *  a fee applies. Resolution settlement is always fee-free.
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

// ── Flip recovery parameters ──
const ENTRY_TRIGGER_PRICE = Number(process.env.ENTRY_TRIGGER_PRICE || 0.60); // every entry (initial or flip) happens at this price
const FIXED_TP_PRICE      = Number(process.env.FIXED_TP_PRICE || 0.99);
const BASE_SHARES         = Number(process.env.BASE_SHARES || 10);
const FLIP_TARGET_PROFIT  = Number(process.env.FLIP_TARGET_PROFIT || 5); // flat $ profit target baked into every recovery sizing
const MAX_FLIPS_PER_WINDOW = Number(process.env.MAX_FLIPS_PER_WINDOW || 2);
function r2(n) { return Math.round(n * 100) / 100; }
const PROFIT_PER_SHARE = r2(FIXED_TP_PRICE - ENTRY_TRIGGER_PRICE); // 0.39 — recovery formula denominator
const MIN_SHARES = Number(process.env.MIN_SHARES || 5);

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
function freshPairState(symbol, carryDeficit = 0) {
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
    deficit: carryDeficit,     // persists across windows, only reset by resetPairs() or a win
    flipsUsed: 0,               // resets every window
    entryDone: false,           // resets every window — true once this window's chain has started
    currentPosition: null,      // { side, state:'resting'|'filled', entryPrice, shares, cost, tpPrice, orderId, tpOrderId, openedAt }
    pendingFlip: null,          // { side, price, shares, orderId, placedAt }
    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,
    resolvedThisWindow: true,
    equityCurve: [{ t: Date.now(), equity: perPairCapital }],
  };
}

function resetPairs() {
  perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
  pairs = {};
  for (const sym of pairList) pairs[sym] = freshPairState(sym, 0);
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
  p.flipsUsed = 0;
  p.entryDone = false;
  p.currentPosition = null;
  p.pendingFlip = null;
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | carried deficit=$${p.deficit.toFixed(2)}`);
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
function positionMarkValue(p, pos) {
  if (!pos || pos.state !== 'filled') return 0;
  const bid = pos.side === 'Up' ? p.upBid : p.downBid;
  const price = bid ?? pos.entryPrice;
  return round2(pos.shares * price);
}
function pairMarkValue(p) {
  return round2(p.bankroll + positionMarkValue(p, p.currentPosition));
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

function recoveryShares(deficit, estimatedLoss) {
  const shares = Math.ceil((deficit + estimatedLoss + FLIP_TARGET_PROFIT) / PROFIT_PER_SHARE);
  return Math.max(shares, MIN_SHARES);
}

// ─────────────────────────────────────────
//  Entry (initial, per window)
// ─────────────────────────────────────────
async function maybeEnter(p) {
  if (p.entryDone) return;
  let side = null;
  if (p.upAsk != null && p.upAsk >= ENTRY_TRIGGER_PRICE) side = 'Up';
  else if (p.downAsk != null && p.downAsk >= ENTRY_TRIGGER_PRICE) side = 'Down';
  if (!side) return;

  const shares = p.deficit > 0 ? recoveryShares(p.deficit, 0) : BASE_SHARES;
  const cost = round2(ENTRY_TRIGGER_PRICE * shares);
  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol}: skip entry — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)} for ${shares}sh)`);
    p.entryDone = true; // don't retry every tick this window against an unaffordable size
    return;
  }

  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  const order = await placeLimitBuy(tokenId, ENTRY_TRIGGER_PRICE, shares);
  p.currentPosition = {
    side, state: 'resting',
    entryPrice: ENTRY_TRIGGER_PRICE, shares, cost,
    tpPrice: FIXED_TP_PRICE,
    orderId: order.id || order.orderId || null,
    tpOrderId: null,
    openedAt: Date.now(),
  };
  p.entryDone = true;
  const tag = p.deficit > 0 ? ` (recovery: deficit=$${p.deficit.toFixed(2)})` : ' (base)';
  log(`📌 ${p.symbol} entry armed: resting buy ${shares}sh @ ${ENTRY_TRIGGER_PRICE} on ${side}${tag}`);
}

// ─────────────────────────────────────────
//  Resting-order fill check (shared by initial entry and flip orders)
// ─────────────────────────────────────────
async function fillIfCrossed(p) {
  const pos = p.currentPosition;
  if (!pos || pos.state !== 'resting') return;
  const ask = pos.side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null || ask > pos.entryPrice) return; // only fills once ask trades down to/through our resting bid

  const rebate = makerRebate(pos.shares, pos.entryPrice);
  p.bankroll = round2(p.bankroll - pos.cost + rebate);
  p.realizedPnl = round2(p.realizedPnl + rebate);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  pos.state = 'filled';

  const tokenId = pos.side === 'Up' ? p.upTokenId : p.downTokenId;
  const tpOrder = await placeLimitSell(tokenId, FIXED_TP_PRICE, pos.shares);
  pos.tpOrderId = tpOrder.id || tpOrder.orderId || null;
  recordEquity(p);
  log(`🎯 ${p.symbol} BUY filled ${pos.shares}sh @ ${pos.entryPrice.toFixed(2)} on ${pos.side} | cost=$${pos.cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP resting @ ${FIXED_TP_PRICE}`);
  registerTrade(p, { side: 'BUY', outcome: pos.side, price: pos.entryPrice, shares: pos.shares, cost: pos.cost, rebate });
}

// ─────────────────────────────────────────
//  TP fill check (maker) — position closes green, deficit resets
// ─────────────────────────────────────────
async function checkTp(p) {
  const pos = p.currentPosition;
  if (!pos || pos.state !== 'filled') return;
  const bid = pos.side === 'Up' ? p.upBid : p.downBid;
  if (bid == null || bid < FIXED_TP_PRICE) return;

  const proceeds = round2(FIXED_TP_PRICE * pos.shares);
  const rebate = makerRebate(pos.shares, FIXED_TP_PRICE);
  const net = round2(proceeds + rebate);
  p.bankroll = round2(p.bankroll + net);
  const profit = round2(net - pos.cost);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  p.wins++;
  p.deficit = 0; // any win fully clears the recovery ledger

  log(`💰 ${p.symbol} TP filled ${pos.shares}sh @ ${FIXED_TP_PRICE} on ${pos.side} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)} | deficit reset to $0`);
  registerTrade(p, { side: 'SELL', outcome: pos.side, reason: 'TP', price: FIXED_TP_PRICE, shares: pos.shares, profit, rebate });
  p.currentPosition = null;
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Flip trigger — opposite side crosses 0.60 while holding a filled position
// ─────────────────────────────────────────
async function maybeArmFlip(p) {
  const pos = p.currentPosition;
  if (!pos || pos.state !== 'filled' || p.pendingFlip) return;
  if (p.flipsUsed >= MAX_FLIPS_PER_WINDOW) return;

  const oppositeSide = pos.side === 'Up' ? 'Down' : 'Up';
  const oppositeAsk = oppositeSide === 'Up' ? p.upAsk : p.downAsk;
  if (oppositeAsk == null || oppositeAsk < ENTRY_TRIGGER_PRICE) return;

  const currentBid = pos.side === 'Up' ? p.upBid : p.downBid;
  const estimatedLoss = currentBid != null ? Math.max(0, round2(pos.cost - currentBid * pos.shares)) : 0;
  const shares = recoveryShares(p.deficit, estimatedLoss);
  const cost = round2(ENTRY_TRIGGER_PRICE * shares);
  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol}: skip flip — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)} for ${shares}sh)`);
    return;
  }

  const tokenId = oppositeSide === 'Up' ? p.upTokenId : p.downTokenId;
  const order = await placeLimitBuy(tokenId, ENTRY_TRIGGER_PRICE, shares);
  p.pendingFlip = {
    side: oppositeSide, price: ENTRY_TRIGGER_PRICE, shares, cost,
    orderId: order.id || order.orderId || null,
    placedAt: Date.now(),
  };
  log(`🔀 ${p.symbol} flip #${p.flipsUsed + 1} armed: resting buy ${shares}sh @ ${ENTRY_TRIGGER_PRICE} on ${oppositeSide} (est. old-position loss $${estimatedLoss.toFixed(2)}, deficit $${p.deficit.toFixed(2)}, target +$${FLIP_TARGET_PROFIT})`);
}

// ─────────────────────────────────────────
//  Flip confirmation — fill the new side, force-sell the old one
// ─────────────────────────────────────────
async function checkFlipFill(p) {
  const pf = p.pendingFlip;
  if (!pf) return;
  const ask = pf.side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null || ask > pf.price) return; // not filled yet

  // 1) The flip order is confirmed filled (maker).
  const rebate = makerRebate(pf.shares, pf.price);
  p.bankroll = round2(p.bankroll - pf.cost + rebate);
  p.realizedPnl = round2(p.realizedPnl + rebate);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  log(`🔀 ${p.symbol} flip filled ${pf.shares}sh @ ${pf.price.toFixed(2)} on ${pf.side} | rebate=+$${rebate.toFixed(4)}`);
  registerTrade(p, { side: 'BUY', outcome: pf.side, reason: 'FLIP', price: pf.price, shares: pf.shares, cost: pf.cost, rebate });

  // 2) Force-sell the OLD position immediately — taker, at the live bid.
  const old = p.currentPosition;
  if (old && old.state === 'filled') {
    await cancelOrder(old.tpOrderId);
    const oldTokenId = old.side === 'Up' ? p.upTokenId : p.downTokenId;
    const oldBid = (old.side === 'Up' ? p.upBid : p.downBid) ?? old.entryPrice;
    await placeLimitSell(oldTokenId, oldBid, old.shares);
    const fee = takerFee(old.shares, oldBid);
    const proceeds = round2(oldBid * old.shares);
    const net = round2(proceeds - fee);
    p.bankroll = round2(p.bankroll + net);
    const oldProfit = round2(net - old.cost);
    p.realizedPnl = round2(p.realizedPnl + oldProfit);
    p.feesPaid = round2(p.feesPaid + fee);
    if (oldProfit >= 0) { p.wins++; p.deficit = 0; }
    else { p.losses++; p.deficit = round2(p.deficit + (old.cost - net)); }
    log(`💥 ${p.symbol} force-sold old ${old.side} position ${old.shares}sh @ ${oldBid.toFixed(2)} | fee=-$${fee.toFixed(4)} | pnl=$${oldProfit.toFixed(2)} | deficit now $${p.deficit.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: old.side, reason: 'FLIP_FORCE_SELL', price: oldBid, shares: old.shares, profit: oldProfit, fee });
  } else if (old && old.state === 'resting') {
    // Edge case: the original order never actually filled before the
    // opposite side triggered a flip — nothing to sell, just drop it.
    await cancelOrder(old.orderId);
    log(`🛑 ${p.symbol}: old ${old.side} order never filled — cancelled instead of force-sold`);
  }

  // 3) The flipped-to side becomes the new current position; rest its TP.
  const tokenId = pf.side === 'Up' ? p.upTokenId : p.downTokenId;
  const tpOrder = await placeLimitSell(tokenId, FIXED_TP_PRICE, pf.shares);
  p.currentPosition = {
    side: pf.side, state: 'filled',
    entryPrice: pf.price, shares: pf.shares, cost: pf.cost,
    tpPrice: FIXED_TP_PRICE,
    orderId: pf.orderId,
    tpOrderId: tpOrder.id || tpOrder.orderId || null,
    openedAt: Date.now(),
  };
  p.pendingFlip = null;
  p.flipsUsed++;
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

  // Cancel a pending flip that never confirmed — no P&L impact.
  if (p.pendingFlip) {
    await cancelOrder(p.pendingFlip.orderId);
    log(`🛑 ${p.symbol}: pending flip on ${p.pendingFlip.side} never filled — cancelled at window close`);
    p.pendingFlip = null;
  }

  const pos = p.currentPosition;
  if (pos && pos.state === 'resting') {
    await cancelOrder(pos.orderId);
    log(`🛑 ${p.symbol}: entry order never filled — cancelled at window close`);
    p.currentPosition = null;
  } else if (pos && pos.state === 'filled') {
    await cancelOrder(pos.tpOrderId);
    const winner = await determineWinningSide(p);
    const won = winner === pos.side;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (won) { p.wins++; p.deficit = 0; }
    else { p.losses++; p.deficit = round2(p.deficit + pos.cost); }
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION ${pos.side} ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)} | deficit now $${p.deficit.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: pos.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
    p.currentPosition = null;
    recordEquity(p);
  }
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

  await checkFlipFill(p);       // 1) did a pending flip just get confirmed?
  await maybeArmFlip(p);        // 2) does the opposite side now warrant a new flip?
  await fillIfCrossed(p);       // 3) did our resting entry/flip buy get hit?
  await checkTp(p);             // 4) did our resting TP get hit?
  if (!p.currentPosition && !p.pendingFlip) await maybeEnter(p); // 5) start this window's chain

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(p.currentPosition && p.currentPosition.state === 'filled'
      ? positionMarkValue(p, p.currentPosition) - p.currentPosition.cost : 0);
    const markValue = pairMarkValue(p);
    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      deficit: p.deficit,
      flipsUsed: p.flipsUsed,
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      currentPosition: p.currentPosition ? {
        side: p.currentPosition.side,
        state: p.currentPosition.state,
        entryPrice: p.currentPosition.entryPrice,
        shares: p.currentPosition.shares,
        cost: p.currentPosition.cost,
      } : null,
      pendingFlip: p.pendingFlip ? {
        side: p.pendingFlip.side,
        price: p.pendingFlip.price,
        shares: p.pendingFlip.shares,
      } : null,
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
  const totalDeficit = round2(pairStates.reduce((s, p) => s + p.deficit, 0));

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
    totalDeficit,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      entryTriggerPrice: ENTRY_TRIGGER_PRICE,
      fixedTpPrice: FIXED_TP_PRICE,
      baseShares: BASE_SHARES,
      flipTargetProfit: FLIP_TARGET_PROFIT,
      maxFlipsPerWindow: MAX_FLIPS_PER_WINDOW,
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
  log('⏸️  Trading paused (open/pending positions still managed for TP/flip-confirm/resolution)');
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
  log(`🚀 5-Minute Crypto Up/Down — Flip Recovery Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  entry/flip trigger @${ENTRY_TRIGGER_PRICE} | base ${BASE_SHARES}sh | TP@${FIXED_TP_PRICE} | max ${MAX_FLIPS_PER_WINDOW} flips/window | recovery = ceil((deficit+loss+$${FLIP_TARGET_PROFIT})/${PROFIT_PER_SHARE})`);
  log(`⚙️  fees: entries+TP maker (0 fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate) | flip force-sell taker (crypto rate ${CRYPTO_TAKER_FEE_RATE})`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
