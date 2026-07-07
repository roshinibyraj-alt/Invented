'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — OVERREACTION FADE + TIME-DECAY SCALPER
 * ═══════════════════════════════════════════════════════════════
 *
 *  CORE IDEA — "time decay":
 *    Every window lasts WINDOW_SECS (300s). decay = elapsed / 300,
 *    a value that grows from 0 (window just opened) to 1 (window
 *    about to close). The less time remains, the higher the decay.
 *
 *  SIGNAL — "overreaction fade":
 *    Each side's mid price is sampled continuously. If a side spikes
 *    to >= SPIKE_THRESHOLD (0.70) within the last SPIKE_LOOKBACK_SECS
 *    (60s) — i.e. it moved there FAST — that is treated as an
 *    overreaction (too much conviction, too early, priced in too
 *    fast). The bot fades it: it buys the OPPOSITE side, which is
 *    sitting at roughly (1 - spike price) ≈ 0.30, betting on mean
 *    reversion back toward 0.50.
 *
 *  SIZING BY DECAY:
 *    Bigger decay (later in the window, closer to close) => bigger
 *    position size. shares = BASE_SHARES * (1 + DECAY_SIZE_MULT * decay),
 *    capped at MAX_SHARES_CAP.
 *
 *  TP / SL BY DECAY:
 *    Early in the window (low decay) there's lots of time left for
 *    the reversion to play out, so TP/SL sit wide. Late in the window
 *    (high decay) there's little time left, so TP/SL are pulled in
 *    tight — offset(decay) = BASE - (BASE - MIN) * decay.
 *
 *  TRADE CAP:
 *    At most MAX_TRADES_PER_WINDOW (5) new fade entries per pair,
 *    per window, across both sides combined.
 *
 *  EXITS:
 *    - TP: resting maker limit sell at entry + tpOffset(decay).
 *    - SL: monitored every tick; if bid <= entry - slOffset(decay),
 *      immediately sell at the current bid (taker) to cut the loss.
 *
 *  CLOSE-OUT:
 *    No new entries after ENTRY_CUTOFF_SECS (280s). At SWEEP_SECS
 *    (285s): cancel any still-resting TPs and roll all remaining
 *    held shares per side into one aggregate maker sell @ 0.99.
 *    Anything still unfilled at window end resolves against the
 *    actual Polymarket outcome.
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

// ── Overreaction-fade signal ──
const SPIKE_LOOKBACK_SECS = Number(process.env.SPIKE_LOOKBACK_SECS || 60);   // "in 1 minute"
const SPIKE_THRESHOLD     = Number(process.env.SPIKE_THRESHOLD || 0.70);     // side price that counts as "overreacted"
const SPIKE_RESET_MARGIN  = Number(process.env.SPIKE_RESET_MARGIN || 0.10);  // must fall back below (threshold - margin) to re-arm
const MAX_TRADES_PER_WINDOW = Number(process.env.MAX_TRADES_PER_WINDOW || 5);
const ENTRY_CUTOFF_SECS   = Number(process.env.ENTRY_CUTOFF_SECS || 280);    // no new fade entries after this
const SWEEP_SECS          = Number(process.env.SWEEP_SECS || 285);          // cancel resting TPs, roll into final sell
const FINAL_SELL_PRICE    = Number(process.env.FINAL_SELL_PRICE || 0.99);

// ── Time-decay position sizing ──
const BASE_SHARES      = Number(process.env.BASE_SHARES || 40);   // size at decay = 0 (window just opened)
const DECAY_SIZE_MULT  = Number(process.env.DECAY_SIZE_MULT || 1.5); // extra size fraction added at decay = 1
const MAX_SHARES_CAP   = Number(process.env.MAX_SHARES_CAP || 150);

// ── Time-decay TP / SL (tighten as decay grows) ──
const BASE_TP_OFFSET = Number(process.env.BASE_TP_OFFSET || 0.12); // TP distance at decay = 0
const MIN_TP_OFFSET  = Number(process.env.MIN_TP_OFFSET || 0.04);  // TP distance at decay = 1
const BASE_SL_OFFSET = Number(process.env.BASE_SL_OFFSET || 0.10); // SL distance at decay = 0
const MIN_SL_OFFSET  = Number(process.env.MIN_SL_OFFSET || 0.03);  // SL distance at decay = 1

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
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-decay-fade-scalper/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-decay-fade-scalper/1.0' },
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
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Time-decay helpers
// ─────────────────────────────────────────
function decayFactor(elapsed) { return clamp(elapsed / WINDOW_SECS, 0, 1); }
function sharesForDecay(decay) {
  const raw = BASE_SHARES * (1 + DECAY_SIZE_MULT * decay);
  return Math.min(MAX_SHARES_CAP, round2(raw));
}
function tpOffsetForDecay(decay) { return round2(BASE_TP_OFFSET - (BASE_TP_OFFSET - MIN_TP_OFFSET) * decay); }
function slOffsetForDecay(decay) { return round2(BASE_SL_OFFSET - (BASE_SL_OFFSET - MIN_SL_OFFSET) * decay); }

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshSideState() {
  return {
    priceHistory: [],   // [{ t: ms, price: mid }] pruned to SPIKE_LOOKBACK_SECS
    armed: true,        // true = eligible to fire a fresh spike signal
    positions: [],      // { entryPrice, shares, cost, slPrice, decay, exit:{kind:'TP'|'FINAL', price, orderId, status}, openedAt }
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

    // per-window trading state (reset in loadPairWindow)
    sweepDone: false,
    tradesThisWindow: 0,
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
  p.sweepDone = false;
  p.tradesThisWindow = 0;
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

function midPrice(ask, bid) {
  if (ask != null && bid != null) return round2((ask + bid) / 2);
  if (ask != null) return round2(ask);
  if (bid != null) return round2(bid);
  return null;
}
function oppositeSide(side) { return side === 'Up' ? 'Down' : 'Up'; }

// ─────────────────────────────────────────
//  Spike (overreaction) tracking
// ─────────────────────────────────────────
function recordPriceHistory(p, side) {
  const s = p.sides[side];
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  const mid = midPrice(ask, bid);
  if (mid == null) return;
  const now = Date.now();
  s.priceHistory.push({ t: now, price: mid });
  const cutoff = now - SPIKE_LOOKBACK_SECS * 1000;
  while (s.priceHistory.length > 1 && s.priceHistory[0].t < cutoff) s.priceHistory.shift();
}

// ─────────────────────────────────────────
//  Fade entry — buys the OPPOSITE side of a detected overreaction,
//  sized and TP/SL'd by time decay.
// ─────────────────────────────────────────
async function fireFadeEntry(p, spikedSide, spikeMid, elapsed) {
  const fadeSide = oppositeSide(spikedSide);
  const ask = fadeSide === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) {
    log(`⏭️  ${p.symbol}: ${spikedSide} overreacted to ${spikeMid.toFixed(2)} but no quote on ${fadeSide} yet — skipped fade`);
    return;
  }

  const decay = decayFactor(elapsed);
  const shares = sharesForDecay(decay);
  const price = round2(ask); // cross the spread — this is a time-sensitive reversion play, not a passive maker order
  const cost = round2(price * shares);
  const fee = takerFee(shares, price);
  const totalCost = round2(cost + fee);

  if (totalCost > p.bankroll) {
    log(`⏭️  ${p.symbol} ${fadeSide}: skip fade entry — insufficient bankroll ($${p.bankroll.toFixed(2)}, need $${totalCost.toFixed(2)})`);
    return;
  }

  const tpOffset = tpOffsetForDecay(decay);
  const slOffset = slOffsetForDecay(decay);
  const tpPrice = round2(clamp(price + tpOffset, 0.01, 0.99));
  const slPrice = round2(clamp(price - slOffset, 0.01, 0.99));

  const s = p.sides[fadeSide];
  const tokenId = fadeSide === 'Up' ? p.upTokenId : p.downTokenId;

  p.bankroll = round2(p.bankroll - totalCost);
  p.feesPaid = round2(p.feesPaid + fee);
  s.feesPaid = round2(s.feesPaid + fee);
  p.tradesThisWindow++;

  const tpOrder = await placeLimitSell(tokenId, tpPrice, shares);
  s.positions.push({
    entryPrice: price, shares, cost: totalCost, slPrice, decay,
    exit: { kind: 'TP', price: tpPrice, orderId: tpOrder.id || tpOrder.orderId || null, status: 'resting' },
    openedAt: Date.now(),
  });

  log(`⚡ ${p.symbol} ${spikedSide} overreacted to ${spikeMid.toFixed(2)} in <${SPIKE_LOOKBACK_SECS}s — FADE buy ${fadeSide} ${shares}sh @ ${price.toFixed(2)} | decay=${decay.toFixed(2)} | TP ${tpPrice.toFixed(2)} / SL ${slPrice.toFixed(2)} | trade ${p.tradesThisWindow}/${MAX_TRADES_PER_WINDOW}`);
  registerTrade(p, { side: 'BUY', outcome: fadeSide, reason: 'FADE-ENTRY', price, shares, cost: totalCost, fee });
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Spike detection — runs per side; a spike on `side` fades into the
//  opposite side. Re-arms only once price falls back below
//  (threshold - reset margin), so one overreaction fires once.
// ─────────────────────────────────────────
async function maybeDetectOverreactionAndFade(p, side, elapsed) {
  const s = p.sides[side];
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  const mid = midPrice(ask, bid);
  if (mid == null) return;

  if (!s.armed && mid < SPIKE_THRESHOLD - SPIKE_RESET_MARGIN) {
    s.armed = true; // reset — a fresh spike on this side can fire again
  }

  if (!s.armed) return;
  if (mid < SPIKE_THRESHOLD) return;
  if (elapsed >= ENTRY_CUTOFF_SECS) return;
  if (p.tradesThisWindow >= MAX_TRADES_PER_WINDOW) return;

  // Confirm this is a FAST move: the oldest sample still inside the
  // lookback window must have been below the threshold, proving the
  // crossing happened within the last SPIKE_LOOKBACK_SECS, not just
  // a price that's been sitting high for a while.
  const oldest = s.priceHistory[0];
  if (!oldest || oldest.price >= SPIKE_THRESHOLD) return;

  s.armed = false; // consume this signal
  await fireFadeEntry(p, side, mid, elapsed);
}

// ─────────────────────────────────────────
//  Position exit checking — TP (resting maker) or SL (immediate,
//  triggered once the bid falls through the decay-scaled stop level).
// ─────────────────────────────────────────
async function checkPositionExits(p, side) {
  const s = p.sides[side];
  if (!s.positions.length) return;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;

  const stillOpen = [];
  for (const pos of s.positions) {
    if (pos.exit.status !== 'resting') { stillOpen.push(pos); continue; }

    if (pos.exit.kind === 'TP' && bid <= pos.slPrice) {
      // Stop-loss breached before TP — cancel the resting TP and exit now (taker)
      await cancelOrder(pos.exit.orderId);
      const proceeds = round2(bid * pos.shares);
      const fee = takerFee(pos.shares, bid);
      const net = round2(proceeds - fee);
      p.bankroll = round2(p.bankroll + net);
      p.feesPaid = round2(p.feesPaid + fee);
      const profit = round2(net - pos.cost);
      p.realizedPnl = round2(p.realizedPnl + profit);
      s.realizedPnl = round2(s.realizedPnl + profit);
      s.feesPaid = round2(s.feesPaid + fee);
      if (profit >= 0) { p.wins++; s.wins++; } else { p.losses++; s.losses++; }
      pos.exit.status = 'filled';

      log(`🛑 ${p.symbol} ${side} SL hit @ ${bid.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}, stop ${pos.slPrice.toFixed(2)}) | ${pos.shares}sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { side: 'SELL', outcome: side, reason: 'SL', price: bid, shares: pos.shares, profit, fee });
      recordEquity(p);
      continue; // closed, dropped
    }

    if (pos.exit.kind === 'TP' && bid >= pos.exit.price) {
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

      log(`💰 ${p.symbol} ${side} TP filled ${pos.shares}sh @ ${pos.exit.price.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}) | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { side: 'SELL', outcome: side, reason: 'TP', price: pos.exit.price, shares: pos.shares, profit, rebate });
      recordEquity(p);
      continue; // closed, dropped
    }

    stillOpen.push(pos);
  }
  s.positions = stillOpen;
}

// ─────────────────────────────────────────
//  285s sweep: cancel unfilled TPs, roll remainder into 0.99 sell
// ─────────────────────────────────────────
async function maybeSweep(p, elapsed) {
  if (p.sweepDone || elapsed < SWEEP_SECS) return;
  p.sweepDone = true;

  for (const side of ['Up', 'Down']) {
    const s = p.sides[side];

    let sweepShares = 0, sweepCost = 0;
    const kept = [];
    for (const pos of s.positions) {
      if (pos.exit.status === 'resting') {
        await cancelOrder(pos.exit.orderId);
        sweepShares += pos.shares;
        sweepCost = round2(sweepCost + pos.cost);
      } else {
        kept.push(pos);
      }
    }
    s.positions = kept;

    if (sweepShares > 0) {
      const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
      const order = await placeLimitSell(tokenId, FINAL_SELL_PRICE, sweepShares);
      s.positions.push({
        entryPrice: round2(sweepCost / sweepShares), shares: sweepShares, cost: sweepCost, slPrice: 0, decay: 1,
        exit: { kind: 'FINAL', price: FINAL_SELL_PRICE, orderId: order.id || order.orderId || null, status: 'resting' },
        openedAt: Date.now(),
      });
      log(`🎯 ${p.symbol} ${side}: cancelled pending TPs, resting FINAL SELL @ ${FINAL_SELL_PRICE} for combined ${sweepShares}sh`);
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
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable) return;
  if (!tradingEnabled) return;

  const elapsed = nowSec() - p.windowStart;

  for (const side of ['Up', 'Down']) recordPriceHistory(p, side);
  for (const side of ['Up', 'Down']) await checkPositionExits(p, side);
  for (const side of ['Up', 'Down']) await maybeDetectOverreactionAndFade(p, side, elapsed);

  await maybeSweep(p, elapsed);

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state — full detail per side for dashboard observation
// ─────────────────────────────────────────
function sideSummary(p, side, elapsed) {
  const s = p.sides[side];
  const openPositions = s.positions
    .filter(pos => pos.exit.status === 'resting')
    .map(pos => ({
      entryPrice: pos.entryPrice, shares: pos.shares, cost: pos.cost,
      tpPrice: pos.exit.kind === 'TP' ? pos.exit.price : null,
      slPrice: pos.slPrice || null,
      kind: pos.exit.kind,
      decay: pos.decay,
    }));

  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  const mid = midPrice(ask, bid);

  return {
    openPositions,
    heldShares: sideHeldShares(s),
    heldCost: sideHeldCost(s),
    armed: s.armed,
    mid,
    spikeThreshold: SPIKE_THRESHOLD,
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
    const decay = elapsed != null ? decayFactor(elapsed) : null;
    let phase = '—';
    if (p.tradable && elapsed != null) {
      phase = elapsed >= SWEEP_SECS ? 'SWEPT / RESOLVING' : (elapsed >= ENTRY_CUTOFF_SECS ? 'NO NEW ENTRIES' : 'ENTRIES OPEN');
    }
    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      eventTitle: p.eventTitle,
      windowEnd: p.windowEnd,
      elapsedSecs: elapsed != null ? Math.floor(elapsed) : null,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      decay,
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
      tradesThisWindow: p.tradesThisWindow,
      maxTradesPerWindow: MAX_TRADES_PER_WINDOW,
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
      spikeLookbackSecs: SPIKE_LOOKBACK_SECS,
      spikeThreshold: SPIKE_THRESHOLD,
      spikeResetMargin: SPIKE_RESET_MARGIN,
      maxTradesPerWindow: MAX_TRADES_PER_WINDOW,
      baseShares: BASE_SHARES,
      decaySizeMult: DECAY_SIZE_MULT,
      maxSharesCap: MAX_SHARES_CAP,
      baseTpOffset: BASE_TP_OFFSET,
      minTpOffset: MIN_TP_OFFSET,
      baseSlOffset: BASE_SL_OFFSET,
      minSlOffset: MIN_SL_OFFSET,
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
  log(`🚀 5-Minute BTC Up/Down — Overreaction Fade + Time-Decay Scalper`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pair(s) (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Signal: a side reaching >= ${SPIKE_THRESHOLD} within ${SPIKE_LOOKBACK_SECS}s = overreaction → fade by buying the opposite side`);
  log(`⚙️  Sizing by time decay: ${BASE_SHARES}sh at window-open, scaling up to ${Math.min(MAX_SHARES_CAP, Math.round(BASE_SHARES*(1+DECAY_SIZE_MULT)))}sh near window close`);
  log(`⚙️  TP/SL tighten with decay: TP ${BASE_TP_OFFSET}→${MIN_TP_OFFSET}, SL ${BASE_SL_OFFSET}→${MIN_SL_OFFSET} (wide early, tight late)`);
  log(`⚙️  Max ${MAX_TRADES_PER_WINDOW} new fade entries per pair per window | no new entries after ${ENTRY_CUTOFF_SECS}s`);
  log(`⚙️  At ${SWEEP_SECS}s: cancel unfilled TPs, roll remainder into one @ ${FINAL_SELL_PRICE} sell per side`);
  log(`⚙️  Unfilled ${FINAL_SELL_PRICE} sell at window close → resolves to actual outcome`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
