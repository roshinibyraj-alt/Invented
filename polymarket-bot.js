'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  MOMENTUM-CONFIRMED ADAPTIVE LADDER (MCAL) BOT
 *  Polymarket BTC/ETH Up/Down — 5-minute windows only
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  This is a from-scratch strategy (structure/plumbing borrowed from a
 *  reference bot, but the signal, entries, sizing, and exits are new).
 *  It does NOT blindly ladder all 4 sides every window. Instead:
 *
 *  1) SIGNAL — every ~2s, pull the live BTC/ETH spot price (Binance public
 *     ticker, no key needed) and track it against the price at window
 *     open. That gives a return-since-open. Normalize that return by
 *     recent realized volatility (rolling stdev of tick-to-tick % moves)
 *     to get a z-score, then squash it into a 0–1 confidence and a
 *     model-implied probability that "Up" wins the window:
 *
 *        modelProbUp = 0.5 + sign(ret) * confidence * MAX_MODEL_EDGE
 *
 *     This is a simple momentum-continuation model: crypto spot moves in
 *     the first part of a 5-minute window are weakly predictive of which
 *     side of that window closes on top, and Polymarket's Up/Down price
 *     often lags the spot tape by a beat or two, especially the further
 *     out the settlement is. This is a heuristic, not a guarantee.
 *
 *  2) ACTIVATION — a ladder (e.g. BTC-Up) only arms new resting buys when
 *     the model's edge over the market's current ask is above a threshold
 *     AND confidence is above a threshold. Weak/no-signal windows simply
 *     don't get traded on that side — unlike a static "always all 4
 *     ladders" approach, this bot can and often will sit out one or more
 *     sides per window entirely.
 *
 *  3) DYNAMIC RUNGS — instead of fixed 0.40/0.30/0.20 price levels, each
 *     active ladder gets 3 rungs computed from the *current* model
 *     probability for that side, scaled around it:
 *       - RIDE rung   : just under modelProb, no take-profit, rides to
 *                       resolution UNLESS the reversal-stop below fires
 *       - MID rung    : deeper discount, fixed TP back up toward modelProb
 *       - DEEP rung   : deepest discount, fixed TP further up
 *     Rungs are only (re)computed when a slot is idle and about to be
 *     armed — an open position keeps its original terms.
 *
 *  4) SIZING — confidence-weighted notional per trade (higher-conviction
 *     signals get bigger size, weak ones get smaller), subject to a hard
 *     cap on combined directional exposure across BOTH symbols (BTC-Up +
 *     ETH-Up share one "Up" exposure cap, same for "Down") since BTC and
 *     ETH often move together and stacking both is a correlated bet, not
 *     a diversified one.
 *
 *  5) EXITS — three mechanisms, all new vs. a "hold to resolution" or
 *     "fixed TP only" approach:
 *       a) Fixed TP on MID/DEEP rungs (maker resting sell), same idea as
 *          a classic grid bot.
 *       b) Time-decay TP tightening: in the final TIME_DECAY_SECS of a
 *          window, open TP targets are pulled in toward the current bid
 *          so profit gets locked in rather than held for a shrinking
 *          window with rising resolution risk.
 *       c) Reversal stop on the RIDE rung: if the momentum signal flips
 *          hard against a held side (opposing confidence crosses a high
 *          bar) with enough time left in the window to still act, the
 *          bot deliberately CROSSES THE SPREAD (pays taker fee, forfeits
 *          the maker rebate) to sell immediately at the current bid
 *          rather than ride a now-unfavored position to a likely $0.
 *          This is a conscious trade: give up a small rebate to avoid a
 *          much larger expected loss.
 *
 *  6) RE-ENTRY — the instant a rung frees up (TP fill, stop fill, or
 *     resolution), it re-checks activation/edge before re-arming, rather
 *     than unconditionally re-arming at the same stale price forever.
 *
 *  NONE OF THIS IS A GUARANTEE OF PROFIT. Binary crypto Up/Down markets
 *  are close to efficiently priced most of the time; this is a heuristic
 *  edge-seeking strategy with real-money risk. Start in DRY_RUN and watch
 *  the win rate / P&L before ever flipping to LIVE.
 *
 *  TRADER INTERFACE (LIVE mode only) — unchanged from the reference bot:
 *    trader.placeLimitBuy(tokenId, price, size)  -> { id, filled, avgPrice, filledShares }
 *    trader.placeLimitSell(tokenId, price, size) -> same shape
 *    trader.getOrder(orderId)                    -> { filled, avgPrice, filledShares }
 *    trader.cancelOrder(orderId)                 -> void
 * ═══════════════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA     = 'https://gamma-api.polymarket.com';
const DATA_API  = 'https://data-api.polymarket.com';
const BINANCE   = 'https://api.binance.com/api/v3/ticker/price';

const TICK_MS                 = 500;
const POLY_PRICE_REFRESH_MS   = 1000;
const SPOT_REFRESH_MS         = Number(process.env.SPOT_REFRESH_MS || 2000);
const REAL_ACCOUNT_REFRESH_MS = 5000;
const ORDER_POLL_MS           = 2000;
const TP_RETUNE_MS            = 5000; // how often to re-check time-decay TP tightening
const EARLY_CUTOFF_SECS       = Number(process.env.EARLY_CUTOFF_SECS || 3);
const SLUG_OFFSET_FALLBACKS_FACTORY = (windowSecs) => [0, -windowSecs, windowSecs];

const WINDOW_SECS = 300;
const SYMBOLS = ['BTC', 'ETH'];
const BINANCE_SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT' };

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters (all tunable via env) ──
const MIN_CONFIDENCE       = Number(process.env.MIN_CONFIDENCE       || 0.15); // signal strength floor to consider trading a side at all
const MIN_EDGE             = Number(process.env.MIN_EDGE             || 0.04); // modelProb - ask must clear this to arm a ladder
const MAX_MODEL_EDGE       = Number(process.env.MAX_MODEL_EDGE       || 0.35); // caps how far modelProb can move off 0.5
const VOL_Z_SCALE          = Number(process.env.VOL_Z_SCALE          || 1.5);  // divides ret/vol before clamping to confidence
const REVERSAL_CONFIDENCE  = Number(process.env.REVERSAL_CONFIDENCE  || 0.45); // opposing confidence needed to trigger a stop-exit
const TIME_DECAY_SECS      = Number(process.env.TIME_DECAY_SECS      || 90);   // last N seconds: tighten TPs
const MIN_EXIT_LEAD_SECS   = Number(process.env.MIN_EXIT_LEAD_SECS   || 15);   // don't bother stop-exiting this close to window end
const STARTUP_GRACE_SECS   = Number(process.env.STARTUP_GRACE_SECS  || 3);

const BASE_NOTIONAL        = Number(process.env.BASE_NOTIONAL       || 25);   // sizing baseline; scaled 0.4x-1.6x by confidence
const MIN_NOTIONAL         = Number(process.env.MIN_NOTIONAL        || 8);
const MAX_NOTIONAL         = Number(process.env.MAX_NOTIONAL        || 55);
const MAX_DIRECTIONAL_EXPOSURE = Number(process.env.MAX_DIRECTIONAL_EXPOSURE || 200); // combined BTC+ETH cap per side (Up / Down)

const RUNG_MID_GAP   = Number(process.env.RUNG_MID_GAP  || 0.10); // MID rung sits this far below RIDE rung
const RUNG_DEEP_GAP  = Number(process.env.RUNG_DEEP_GAP || 0.20); // DEEP rung sits this far below RIDE rung
const TP_GAP         = Number(process.env.TP_GAP        || 0.20); // MID/DEEP take-profit sits this far above their entry

const CRYPTO_TAKER_FEE_RATE = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const MAKER_REBATE_SHARE    = Number(process.env.MAKER_REBATE_SHARE    || 0.20);

const SPOT_HISTORY_MAX = 60; // ~2min of 2s samples

const LADDER_DEFS = [
  { key: 'BTC-Up',   symbol: 'BTC', side: 'Up' },
  { key: 'BTC-Down', symbol: 'BTC', side: 'Down' },
  { key: 'ETH-Up',   symbol: 'ETH', side: 'Up' },
  { key: 'ETH-Down', symbol: 'ETH', side: 'Down' },
];
const SLOT_KINDS = ['ride', 'mid', 'deep'];

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let bankroll = TOTAL_CAPITAL;
let realizedPnl = 0, rebatesEarned = 0, feesPaid = 0, wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];
let warnedNoTraderLimitMethods = false;

let realBalance = null, realPositions = [], realLastUpdated = null, realFetchError = null;

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-mcal-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function estimateMakerRebate(shares, price) {
  const feeEquivalent = shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price);
  return round5(feeEquivalent * MAKER_REBATE_SHARE);
}
function estimateTakerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price);
}

function describeOrderError(e) {
  const parts = [e?.message || String(e)];
  const extra = e?.response?.data ?? e?.data ?? e?.body ?? null;
  if (extra) { try { parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (_) {} }
  return parts.join(' | ');
}

function traderHasLimitMethods() {
  const ok = trader && typeof trader.placeLimitBuy === 'function' && typeof trader.placeLimitSell === 'function';
  if (!ok && !warnedNoTraderLimitMethods) {
    warnedNoTraderLimitMethods = true;
    log('❌ LIVE trading needs trader.placeLimitBuy / trader.placeLimitSell (and ideally getOrder / cancelOrder) on polymarket-trader.js — LIVE order actions will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}

async function placeRestingBuy(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethods()) return null;
    try { return await trader.placeLimitBuy(tokenId, price, shares); }
    catch (e) { log(`❌ placeLimitBuy failed: ${describeOrderError(e)}`); return null; }
  }
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: false };
}
// crossPrice: if set, this is an aggressive (taker) sell meant to fill immediately (stop-exit).
async function placeRestingSell(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethods()) return null;
    try { return await trader.placeLimitSell(tokenId, price, shares); }
    catch (e) { log(`❌ placeLimitSell failed: ${describeOrderError(e)}`); return null; }
  }
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: false };
}
async function cancelRestingOrder(orderId) {
  if (!orderId || orderId.startsWith('dry-')) return;
  if (!DRY_RUN && trader && typeof trader.cancelOrder === 'function') {
    try { await trader.cancelOrder(orderId); } catch (e) { log(`⚠️  cancelOrder failed: ${describeOrderError(e)}`); }
  }
}

// ─────────────────────────────────────────
//  Market state
// ─────────────────────────────────────────
function freshMarketSlot() {
  return { slug: null, eventTitle: null, conditionId: null, upTokenId: null, downTokenId: null, upAsk: null, upBid: null, downAsk: null, downBid: null };
}
function freshRungSlot(kind) {
  return {
    kind,                 // 'ride' | 'mid' | 'deep'
    level: null, tpTarget: null, effectiveTp: null,
    entryOrderId: null, entryPending: false,
    position: null,       // { shares, entryPrice, cost, tpPrice, tpOrderId, tpPending, closed, won, closedReason }
    reentries: 0,
  };
}
function freshLadder(def) {
  return {
    key: def.key, symbol: def.symbol, side: def.side,
    active: false, reason: 'no signal yet',
    signal: { modelProb: null, ask: null, edge: null, confidence: null },
    slots: Object.fromEntries(SLOT_KINDS.map(k => [k, freshRungSlot(k)])),
  };
}
function freshWindowState() {
  return {
    windowSecs: WINDOW_SECS, tradable: false,
    windowStart: null, windowEnd: null, resolvedThisWindow: true,
    markets: { BTC: freshMarketSlot(), ETH: freshMarketSlot() },
    ladders: Object.fromEntries(LADDER_DEFS.map(d => [d.key, freshLadder(d)])),
  };
}
let win = freshWindowState();
let skipUntilWindowStart = null;

// ── Spot-price momentum tracking (independent of window state — runs continuously) ──
const spot = {
  BTC: { history: [], windowOpenPrice: null, last: null },
  ETH: { history: [], windowOpenPrice: null, last: null },
};

async function refreshSpot() {
  for (const symbol of SYMBOLS) {
    try {
      const data = await getJSON(`${BINANCE}?symbol=${BINANCE_SYMBOL[symbol]}`);
      const price = parseFloat(data.price);
      if (!Number.isFinite(price)) continue;
      const s = spot[symbol];
      s.last = price;
      s.history.push({ t: Date.now(), price });
      if (s.history.length > SPOT_HISTORY_MAX) s.history.shift();
    } catch (e) { /* transient — keep last known price */ }
  }
}

function anchorWindowOpenSpot() {
  for (const symbol of SYMBOLS) {
    spot[symbol].windowOpenPrice = spot[symbol].last;
  }
}

// Momentum model: return-since-window-open, normalized by recent realized
// vol, squashed into confidence [0,1] and a signed model probability of Up.
function computeSignal(symbol) {
  const s = spot[symbol];
  const anchor = s.windowOpenPrice;
  if (anchor == null || s.last == null || s.history.length < 3) {
    return { ret: 0, vol: 0, z: 0, confidence: 0, side: null, modelProbUp: 0.5 };
  }
  const ret = (s.last - anchor) / anchor;

  // realized vol: stdev of tick-to-tick % changes over recent history
  const pct = [];
  for (let i = 1; i < s.history.length; i++) {
    const a = s.history[i - 1].price, b = s.history[i].price;
    if (a > 0) pct.push((b - a) / a);
  }
  let vol = 0;
  if (pct.length > 1) {
    const mean = pct.reduce((a, b) => a + b, 0) / pct.length;
    const variance = pct.reduce((a, b) => a + (b - mean) ** 2, 0) / pct.length;
    vol = Math.sqrt(variance);
  }
  // Expected stdev of a cumulative return over n ticks of a random walk with
  // per-tick stdev `vol` scales like vol*sqrt(n) — without this sqrt(n) term,
  // cumulative return vs. single-tick vol would look artificially extreme
  // and saturate confidence to 1 almost immediately, even on pure noise.
  const n = Math.max(1, pct.length);
  const denom = Math.max(vol * Math.sqrt(n) * VOL_Z_SCALE, 1e-6);
  const z = ret / denom;
  const confidence = clamp(Math.abs(z), 0, 1);
  const side = ret === 0 ? null : (ret > 0 ? 'Up' : 'Down');
  const signedConfidence = side === 'Up' ? confidence : (side === 'Down' ? -confidence : 0);
  const modelProbUp = clamp(0.5 + signedConfidence * MAX_MODEL_EDGE, 0.05, 0.95);
  return { ret, vol, z, confidence, side, modelProbUp };
}

// ─────────────────────────────────────────
//  Slug / window math (same plumbing as reference — not part of the strategy)
// ─────────────────────────────────────────
function currentWindowStart(windowSecs, tsSec = nowSec()) { return Math.floor(tsSec / windowSecs) * windowSecs; }
function slugFor(symbol, windowStartSec) { return `${symbol.toLowerCase()}-updown-5m-${windowStartSec}`; }
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
  for (const offset of SLUG_OFFSET_FALLBACKS_FACTORY(WINDOW_SECS)) {
    const ws = windowStart + offset;
    if (ws + WINDOW_SECS <= nowSec()) continue;
    const slug = slugFor(symbol, ws);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) return { event, windowStart: ws, slug };
    } catch (_) {}
  }
  return null;
}

async function loadWindow() {
  const ws = currentWindowStart(WINDOW_SECS);
  if (win.windowStart === ws && win.markets.BTC.upTokenId && win.markets.ETH.upTokenId) return;

  const [foundBtc, foundEth] = await Promise.all([fetchEventForWindow('BTC', ws), fetchEventForWindow('ETH', ws)]);
  if (!foundBtc || !foundEth) { win.tradable = false; return; }
  if (foundBtc.windowStart !== foundEth.windowStart) { win.tradable = false; return; }

  function slotFrom(found) {
    const market = found.event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || found.event.markets[0];
    const upId = tokenIdForSide(market, 'up');
    const downId = tokenIdForSide(market, 'down');
    if (!upId || !downId) return null;
    const slot = freshMarketSlot();
    slot.slug = found.slug; slot.eventTitle = found.event.title || found.event.slug;
    slot.conditionId = market.conditionId || null;
    slot.upTokenId = upId; slot.downTokenId = downId;
    return slot;
  }
  const btcSlot = slotFrom(foundBtc), ethSlot = slotFrom(foundEth);
  if (!btcSlot || !ethSlot) { log('⚠️  window loaded but Up/Down token ids missing'); win.tradable = false; return; }

  const fresh = freshWindowState();
  fresh.windowStart = foundBtc.windowStart;
  fresh.windowEnd = foundBtc.windowStart + WINDOW_SECS;
  fresh.markets.BTC = btcSlot; fresh.markets.ETH = ethSlot;
  fresh.tradable = true; fresh.resolvedThisWindow = false;
  win = fresh;

  anchorWindowOpenSpot();
  log(`🔭 [5m] window loaded: BTC=${btcSlot.slug} ETH=${ethSlot.slug} | ends ${new Date(win.windowEnd * 1000).toISOString().slice(11, 19)}Z | spot anchor BTC=${spot.BTC.windowOpenPrice ?? '—'} ETH=${spot.ETH.windowOpenPrice ?? '—'}`);

  // Nothing is armed yet here — arming is signal-driven and happens in tick()
  // once we've had a few seconds of spot samples since the window opened.
}

async function refreshPrices() {
  if (!win.tradable) return;
  for (const symbol of SYMBOLS) {
    const m = win.markets[symbol];
    try {
      const [upBook, downBook] = await Promise.all([
        getJSON(`https://clob.polymarket.com/book?token_id=${m.upTokenId}`).catch(() => null),
        getJSON(`https://clob.polymarket.com/book?token_id=${m.downTokenId}`).catch(() => null),
      ]);
      if (upBook) {
        const asks = upBook.asks || [], bids = upBook.bids || [];
        m.upAsk = asks.length ? parseFloat(asks[asks.length - 1].price) : m.upAsk;
        m.upBid = bids.length ? parseFloat(bids[bids.length - 1].price) : m.upBid;
      }
      if (downBook) {
        const asks = downBook.asks || [], bids = downBook.bids || [];
        m.downAsk = asks.length ? parseFloat(asks[asks.length - 1].price) : m.downAsk;
        m.downBid = bids.length ? parseFloat(bids[bids.length - 1].price) : m.downBid;
      }
    } catch (_) {}
  }
}

function currentAsk(ladder) {
  const m = win.markets[ladder.symbol];
  return ladder.side === 'Up' ? m.upAsk : m.downAsk;
}
function currentBid(ladder) {
  const m = win.markets[ladder.symbol];
  return ladder.side === 'Up' ? m.upBid : m.downBid;
}
function tokenIdFor(ladder) {
  const m = win.markets[ladder.symbol];
  return ladder.side === 'Up' ? m.upTokenId : m.downTokenId;
}

// ─────────────────────────────────────────
//  Exposure accounting — combined BTC+ETH cap per side (Up / Down)
// ─────────────────────────────────────────
function sideExposure(side) {
  let total = 0;
  for (const def of LADDER_DEFS) {
    if (def.side !== side) continue;
    const ladder = win.ladders[def.key];
    for (const kind of SLOT_KINDS) {
      const slot = ladder.slots[kind];
      if (slot.position && !slot.position.closed) total += slot.position.cost;
      // resting (unfilled) buys reserve capital too — count at their notional
      else if (slot.entryPending && slot.level != null) total += round2((slot.notionalReserved || 0));
    }
  }
  return round2(total);
}

function sizeForEntry(ladder, confidence, level) {
  const raw = clamp(BASE_NOTIONAL * (0.4 + 1.2 * confidence), MIN_NOTIONAL, MAX_NOTIONAL);
  const used = sideExposure(ladder.side);
  const room = MAX_DIRECTIONAL_EXPOSURE - used;
  if (room <= 0) return 0;
  const notional = Math.min(raw, room);
  if (notional < MIN_NOTIONAL * 0.5) return 0;
  return notional;
}

// ─────────────────────────────────────────
//  Signal → activation → dynamic rungs
// ─────────────────────────────────────────
function evaluateLadderSignal(ladder) {
  const ask = currentAsk(ladder);
  const sig = computeSignal(ladder.symbol);
  const modelProb = ladder.side === 'Up' ? sig.modelProbUp : round2(1 - sig.modelProbUp);
  const edge = ask != null ? round2(modelProb - ask) : null;
  const sideMatchesBias = sig.side === ladder.side;
  const confidence = sideMatchesBias ? sig.confidence : 0; // only count confidence when the signal agrees with this ladder's side
  ladder.signal = { modelProb: round2(modelProb), ask, edge, confidence: round2(confidence), rawSignalSide: sig.side, ret: sig.ret };

  const active = ask != null && confidence >= MIN_CONFIDENCE && edge != null && edge >= MIN_EDGE;
  ladder.active = active;
  ladder.reason = active ? 'signal favors this side' :
    (ask == null ? 'no market price yet' :
     !sideMatchesBias ? `momentum favors ${sig.side || 'neither side'}` :
     confidence < MIN_CONFIDENCE ? 'confidence too low' :
     'edge too thin');
  return { modelProb, ask, edge, confidence };
}

function computeRungsForLadder(ladder, modelProb, ask) {
  const buffer = 0.05;
  let ride = clamp(round2(Math.min(modelProb - buffer, ask - 0.01)), 0.05, 0.90);
  let mid  = clamp(round2(ride - RUNG_MID_GAP), 0.03, 0.88);
  let deep = clamp(round2(mid - (RUNG_DEEP_GAP - RUNG_MID_GAP)), 0.02, 0.85);
  const midTp  = clamp(round2(mid + TP_GAP), mid + 0.03, 0.97);
  const deepTp = clamp(round2(deep + TP_GAP), deep + 0.03, 0.96);
  return {
    ride: { level: ride, tp: null },
    mid:  { level: mid, tp: midTp },
    deep: { level: deep, tp: deepTp },
  };
}

async function maybeArmSlot(ladder, slot) {
  if (!tradingEnabled) return;
  if (slot.position || slot.entryPending) return; // only arm idle slots
  const { modelProb, ask, confidence } = evaluateLadderSignal(ladder);
  if (!ladder.active) return;

  const rungs = computeRungsForLadder(ladder, modelProb, ask);
  const def = rungs[slot.kind];
  if (!def || def.level == null || def.level <= 0 || def.level >= 0.98) return;
  if (def.level >= ask) return; // would cross the spread — not a resting/maker order

  const notional = sizeForEntry(ladder, confidence, def.level);
  if (notional <= 0) {
    ladder.reason = 'directional exposure cap reached';
    return;
  }
  const shares = round2(notional / def.level);
  const tokenId = tokenIdFor(ladder);
  if (!tokenId) return;

  const resp = await placeRestingBuy(tokenId, def.level, shares);
  if (!resp) return;
  slot.level = def.level;
  slot.tpTarget = def.tp;
  slot.effectiveTp = def.tp;
  slot.notionalReserved = notional;
  slot.entryOrderId = resp.id;
  slot.entryPending = true;
  log(`🔭 [${ladder.key}/${slot.kind}] armed resting buy @ ${def.level.toFixed(2)} for ${shares.toFixed(2)}sh ($${notional.toFixed(2)}) | modelProb=${modelProb.toFixed(2)} conf=${confidence.toFixed(2)} edge=${(modelProb - ask).toFixed(2)}${def.tp != null ? ` | TP ${def.tp.toFixed(2)}` : ' | rides to resolution (reversal-stop active)'}`);

  if (!DRY_RUN && resp.filled) {
    await onEntryFilled(ladder, slot, def.level, resp.filledShares || shares);
  }
}

async function onEntryFilled(ladder, slot, fillPrice, shares) {
  const cost = round2(shares * fillPrice);
  bankroll = round2(bankroll - cost);
  slot.entryPending = false;
  slot.reentries++;
  slot.position = { shares, entryPrice: fillPrice, cost, tpPrice: slot.tpTarget, tpOrderId: null, tpPending: false, closed: false, won: null, closedReason: null };
  registerTrade({ ladder: ladder.key, symbol: ladder.symbol, side: 'BUY', outcome: ladder.side, reason: 'ENTRY', price: fillPrice, shares, level: slot.level });
  log(`✅ [${ladder.key}/${slot.kind}] entry filled @ ${fillPrice.toFixed(2)} x${shares.toFixed(2)}sh (cost $${cost.toFixed(2)})`);

  if (slot.tpTarget != null) {
    const tokenId = tokenIdFor(ladder);
    const resp = await placeRestingSell(tokenId, slot.tpTarget, shares);
    if (resp) {
      slot.position.tpOrderId = resp.id;
      slot.position.tpPending = true;
      if (!DRY_RUN && resp.filled) await onExitFilled(ladder, slot, resp.avgPrice || slot.tpTarget, resp.filledShares || shares, 'TP');
    }
  }
  recordEquity();
}

async function onExitFilled(ladder, slot, fillPrice, filledShares, reason) {
  const pos = slot.position;
  if (!pos || pos.closed) return;
  const shares = filledShares > 0 ? filledShares : pos.shares;
  const proceeds = round2(shares * fillPrice);
  let rebate = 0, fee = 0;
  if (reason === 'STOP') fee = estimateTakerFee(shares, fillPrice);
  else rebate = estimateMakerRebate(shares, fillPrice);
  const profit = round2(proceeds - pos.cost + rebate - fee);

  bankroll = round2(bankroll + proceeds + rebate - fee);
  realizedPnl = round2(realizedPnl + profit);
  rebatesEarned = round2(rebatesEarned + rebate);
  feesPaid = round2(feesPaid + fee);
  if (profit >= 0) wins++; else losses++;
  pos.closed = true; pos.won = profit >= 0; pos.closedReason = reason; pos.tpPending = false;

  const icon = reason === 'STOP' ? '🛑' : '💰';
  log(`${icon} [${ladder.key}/${slot.kind}] ${reason} filled @ ${fillPrice.toFixed(2)} — pnl=$${profit.toFixed(2)}${rebate ? ` (+rebate $${rebate.toFixed(4)})` : ''}${fee ? ` (-fee $${fee.toFixed(4)})` : ''} | bankroll=$${bankroll.toFixed(2)}`);
  registerTrade({ ladder: ladder.key, symbol: ladder.symbol, side: 'SELL', outcome: ladder.side, reason, price: fillPrice, shares, profit, level: slot.level });

  slot.position = null;
  recordEquity();
  await maybeArmSlot(ladder, slot); // re-check activation/edge before re-arming — not unconditional
}

// Time-decay TP tightening: in the closing stretch of a window, pull open
// TP targets in toward the current bid so gains get locked rather than
// risked on a shrinking window.
async function retuneTakeProfits() {
  if (!win.tradable || win.windowEnd == null) return;
  const secsLeft = win.windowEnd - nowSec();
  if (secsLeft > TIME_DECAY_SECS || secsLeft <= 0) return;
  const decayFrac = clamp(secsLeft / TIME_DECAY_SECS, 0, 1); // shrinks toward 0 as window closes

  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const kind of SLOT_KINDS) {
      const slot = ladder.slots[kind];
      const pos = slot.position;
      if (!pos || pos.closed || !pos.tpPending || slot.tpTarget == null) continue;
      const bid = currentBid(ladder);
      if (bid == null) continue;
      const originalGap = slot.tpTarget - pos.entryPrice;
      const minGap = Math.max(0.02, originalGap * 0.25); // never tighten past a minimal profit
      const newGap = Math.max(minGap, originalGap * decayFrac);
      const newTp = round2(pos.entryPrice + newGap);
      if (newTp < slot.effectiveTp - 0.01) {
        await cancelRestingOrder(pos.tpOrderId);
        const tokenId = tokenIdFor(ladder);
        const resp = await placeRestingSell(tokenId, newTp, pos.shares);
        if (resp) {
          pos.tpOrderId = resp.id;
          slot.effectiveTp = newTp;
          log(`⏱️  [${ladder.key}/${slot.kind}] time-decay: TP tightened ${slot.tpTarget.toFixed(2)}→${newTp.toFixed(2)} (${secsLeft.toFixed(0)}s left)`);
          if (!DRY_RUN && resp.filled) await onExitFilled(ladder, slot, resp.avgPrice || newTp, resp.filledShares || pos.shares, 'TP');
        }
      }
    }
  }
}

// Reversal stop on RIDE-tier (no fixed TP) positions: if momentum flips hard
// against the held side, cross the spread and sell now rather than ride to
// a probable $0 at resolution.
async function checkReversalStops() {
  if (!win.tradable || win.windowEnd == null) return;
  const secsLeft = win.windowEnd - nowSec();
  if (secsLeft < MIN_EXIT_LEAD_SECS) return;

  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    const slot = ladder.slots.ride;
    const pos = slot.position;
    if (!pos || pos.closed || pos.tpPending) continue;
    const sig = computeSignal(ladder.symbol);
    const opposing = sig.side && sig.side !== ladder.side ? sig.confidence : 0;
    if (opposing >= REVERSAL_CONFIDENCE) {
      const bid = currentBid(ladder);
      if (bid == null || bid <= 0.01) continue;
      const tokenId = tokenIdFor(ladder);
      const resp = await placeRestingSell(tokenId, bid, pos.shares); // aggressive: prices at current bid, expected to cross/fill fast
      if (resp) {
        pos.tpOrderId = resp.id;
        pos.tpPending = true;
        log(`🛑 [${ladder.key}/ride] momentum reversal (opposing conf ${opposing.toFixed(2)}) — cutting position @ ~${bid.toFixed(2)}, forfeiting maker rebate`);
        if (DRY_RUN || resp.filled) await onExitFilled(ladder, slot, resp.avgPrice || bid, resp.filledShares || pos.shares, 'STOP');
      }
    }
  }
}

function registerTrade(t) {
  trades.push({ ...t, time: new Date().toISOString().slice(11, 19) });
  if (trades.length > 500) trades.shift();
}
function markValue() {
  let mv = bankroll;
  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const kind of SLOT_KINDS) {
      const pos = ladder.slots[kind].position;
      if (!pos || pos.closed) continue;
      const bid = currentBid(ladder);
      mv += pos.shares * (bid != null ? bid : pos.entryPrice);
    }
  }
  return round2(mv);
}
function recordEquity() {
  equityCurve.push({ t: Date.now(), equity: markValue() });
  if (equityCurve.length > 500) equityCurve.shift();
}

// DRY_RUN fill simulation: entry fills when ask crosses down to level;
// TP/stop fills when bid crosses up to the (possibly retuned) target.
function tickLadderDryRun(ladder) {
  const ask = currentAsk(ladder), bid = currentBid(ladder);
  for (const kind of SLOT_KINDS) {
    const slot = ladder.slots[kind];
    const pos = slot.position;
    if (pos && !pos.closed && pos.tpPending) {
      // Regular fixed/time-decay-tightened TP fills. Reversal stops on the
      // RIDE tier are handled separately in checkReversalStops(), which
      // closes the position directly rather than waiting for a bid cross.
      const target = slot.effectiveTp != null ? slot.effectiveTp : slot.tpTarget;
      if (bid != null && target != null && bid >= target) {
        onExitFilled(ladder, slot, target, pos.shares, 'TP').catch(e => log(`⚠️  exit fill error: ${e.message}`));
      }
      continue;
    }
    if (!pos && slot.entryPending && slot.level != null && ask != null && ask <= slot.level) {
      const shares = round2((slot.notionalReserved || 0) / slot.level);
      onEntryFilled(ladder, slot, slot.level, shares).catch(e => log(`⚠️  entry fill error: ${e.message}`));
    }
  }
}

// ─────────────────────────────────────────
//  LIVE order-fill polling
// ─────────────────────────────────────────
async function pollLiveOrders() {
  if (DRY_RUN || !trader || typeof trader.getOrder !== 'function') return;
  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const kind of SLOT_KINDS) {
      const slot = ladder.slots[kind];
      if (slot.entryPending && slot.entryOrderId) {
        try {
          const st = await trader.getOrder(slot.entryOrderId);
          if (st && st.filled) await onEntryFilled(ladder, slot, slot.level, st.filledShares || round2((slot.notionalReserved || 0) / slot.level));
        } catch (e) { log(`⚠️  getOrder (entry) failed: ${describeOrderError(e)}`); }
      }
      const pos = slot.position;
      if (pos && !pos.closed && pos.tpPending && pos.tpOrderId) {
        try {
          const st = await trader.getOrder(pos.tpOrderId);
          if (st && st.filled) await onExitFilled(ladder, slot, st.avgPrice || pos.tpPrice, st.filledShares || pos.shares, 'TP');
        } catch (e) { log(`⚠️  getOrder (tp) failed: ${describeOrderError(e)}`); }
      }
    }
  }
}

// ─────────────────────────────────────────
//  Window resolution
// ─────────────────────────────────────────
async function determineWinningSide(slug, conditionId, fallbackUpBid, fallbackDownBid) {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === conditionId) || (event.markets || [])[0];
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const winner = (outcomes[bestI] || '').trim();
      if (winner) return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
    }
  } catch (_) {}
  if (fallbackUpBid != null && fallbackDownBid != null) return fallbackUpBid >= fallbackDownBid ? 'Up' : 'Down';
  return null;
}

async function resolveWindow() {
  if (win.resolvedThisWindow) return;
  win.resolvedThisWindow = true;

  const winners = {};
  for (const symbol of SYMBOLS) {
    const m = win.markets[symbol];
    const anyOpenOrPending = LADDER_DEFS.filter(d => d.symbol === symbol).some(d => {
      const ladder = win.ladders[d.key];
      return SLOT_KINDS.some(k => { const s = ladder.slots[k]; return s.entryPending || (s.position && !s.position.closed); });
    });
    if (!anyOpenOrPending) continue;
    winners[symbol] = await determineWinningSide(m.slug, m.conditionId, m.upBid, m.downBid);
  }

  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    const winner = winners[def.symbol];
    for (const kind of SLOT_KINDS) {
      const slot = ladder.slots[kind];
      if (slot.entryPending) { await cancelRestingOrder(slot.entryOrderId); slot.entryPending = false; slot.entryOrderId = null; }
      const pos = slot.position;
      if (!pos || pos.closed) continue;
      if (pos.tpPending) await cancelRestingOrder(pos.tpOrderId);

      const won = winner === ladder.side;
      const proceeds = won ? round2(pos.shares * 1) : 0;
      const profit = round2(proceeds - pos.cost);
      bankroll = round2(bankroll + proceeds);
      realizedPnl = round2(realizedPnl + profit);
      if (won) wins++; else losses++;
      pos.closed = true; pos.won = won; pos.closedReason = 'RESOLUTION';
      const icon = won ? '💰' : '💥';
      log(`${icon} [${ladder.key}/${kind}] RESOLUTION ${pos.shares.toFixed(2)}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);
      registerTrade({ ladder: ladder.key, symbol: ladder.symbol, side: 'SELL', outcome: ladder.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit, level: slot.level });
    }
  }
  recordEquity();
}

// ─────────────────────────────────────────
//  Main tick
// ─────────────────────────────────────────
async function tick() {
  const ws = currentWindowStart(WINDOW_SECS);
  if (win.windowStart === null || ws !== win.windowStart) {
    if (win.windowStart !== null && !win.resolvedThisWindow) await resolveWindow();

    if (skipUntilWindowStart !== null) {
      if (ws <= skipUntilWindowStart) {
        win = freshWindowState();
        win.windowStart = ws; win.windowEnd = ws + WINDOW_SECS;
        win.tradable = false; win.resolvedThisWindow = true;
        return;
      }
      log('⏰ Next window boundary reached — resuming normal trading');
      skipUntilWindowStart = null;
    }
    await loadWindow();
  }
  if (!win.tradable) return;

  const elapsed = nowSec() - win.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !win.resolvedThisWindow) { await resolveWindow(); }
  if (win.resolvedThisWindow) return;

  // Always keep signal/activation fresh for the dashboard, even for idle ladders.
  for (const def of LADDER_DEFS) evaluateLadderSignal(win.ladders[def.key]);

  if (DRY_RUN) { for (const def of LADDER_DEFS) tickLadderDryRun(win.ladders[def.key]); }

  await checkReversalStops();

  if (!tradingEnabled) return;
  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const kind of SLOT_KINDS) await maybeArmSlot(ladder, ladder.slots[kind]);
  }
}

// ─────────────────────────────────────────
//  Real account state (live mode)
// ─────────────────────────────────────────
function tradingWalletAddress() {
  try { return trader?.getAddress ? trader.getAddress() : (trader?.address || null); } catch (_) { return null; }
}
async function refreshRealAccount() {
  if (DRY_RUN) { realBalance = null; realPositions = []; realFetchError = null; return; }
  const wallet = tradingWalletAddress();
  if (!wallet) { realFetchError = 'No trading wallet address available yet'; return; }
  try {
    const [balResp, posResp] = await Promise.all([
      getJSON(`${DATA_API}/balance?address=${wallet}`).catch(() => null),
      getJSON(`${DATA_API}/positions?user=${wallet}`).catch(() => []),
    ]);
    if (balResp && balResp.balance != null) realBalance = parseFloat(balResp.balance);
    if (Array.isArray(posResp)) {
      realPositions = posResp.map(p => ({
        title: p.title || p.slug, outcome: p.outcome, size: parseFloat(p.size || 0),
        avgPrice: p.avgPrice != null ? parseFloat(p.avgPrice) : null,
        curPrice: p.curPrice != null ? parseFloat(p.curPrice) : null,
        currentValue: p.currentValue != null ? parseFloat(p.currentValue) : null,
        cashPnl: p.cashPnl != null ? parseFloat(p.cashPnl) : null,
      }));
    }
    realFetchError = null; realLastUpdated = Date.now();
  } catch (e) { realFetchError = e.message; }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildLadderState(ladder) {
  return {
    key: ladder.key, symbol: ladder.symbol, side: ladder.side,
    ask: currentAsk(ladder), bid: currentBid(ladder),
    active: ladder.active, reason: ladder.reason, signal: ladder.signal,
    levels: SLOT_KINDS.map(kind => {
      const slot = ladder.slots[kind];
      const pos = slot.position;
      return {
        kind: slot.kind, level: slot.level, tpTarget: slot.tpTarget, effectiveTp: slot.effectiveTp,
        entryPending: slot.entryPending, reentries: slot.reentries,
        position: pos ? { shares: pos.shares, entryPrice: pos.entryPrice, cost: pos.cost, tpPrice: pos.tpPrice, tpPending: pos.tpPending, closed: pos.closed } : null,
      };
    }),
  };
}

function buildState() {
  const mv = markValue();
  let costBasis = 0;
  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const kind of SLOT_KINDS) { const pos = ladder.slots[kind].position; if (pos && !pos.closed) costBasis += pos.cost; }
  }
  costBasis = round2(costBasis);
  const held = round2(mv - bankroll);
  const unrealizedPnl = round2(held - costBasis);
  const secsToEnd = win.windowEnd ? Math.max(0, Math.floor(win.windowEnd - nowSec())) : null;

  return {
    dryRun: DRY_RUN, tradingEnabled, symbols: SYMBOLS,
    windowSecs: WINDOW_SECS, tradable: win.tradable, windowEnd: win.windowEnd, secsToEnd,
    markets: {
      BTC: { slug: win.markets.BTC.slug, upAsk: win.markets.BTC.upAsk, upBid: win.markets.BTC.upBid, downAsk: win.markets.BTC.downAsk, downBid: win.markets.BTC.downBid },
      ETH: { slug: win.markets.ETH.slug, upAsk: win.markets.ETH.upAsk, upBid: win.markets.ETH.upBid, downAsk: win.markets.ETH.downAsk, downBid: win.markets.ETH.downBid },
    },
    spot: { BTC: spot.BTC.last, ETH: spot.ETH.last, BTCOpen: spot.BTC.windowOpenPrice, ETHOpen: spot.ETH.windowOpenPrice },
    ladders: LADDER_DEFS.map(d => buildLadderState(win.ladders[d.key])),
    exposure: { Up: sideExposure('Up'), Down: sideExposure('Down'), cap: MAX_DIRECTIONAL_EXPOSURE },
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    realizedPnl, unrealizedPnl, rebatesEarned, feesPaid, wins, losses,
    totalPnl: round2(mv - TOTAL_CAPITAL),
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      minConfidence: MIN_CONFIDENCE, minEdge: MIN_EDGE, maxModelEdge: MAX_MODEL_EDGE,
      reversalConfidence: REVERSAL_CONFIDENCE, timeDecaySecs: TIME_DECAY_SECS,
      baseNotional: BASE_NOTIONAL, maxDirectionalExposure: MAX_DIRECTIONAL_EXPOSURE,
      makerRebateShare: MAKER_REBATE_SHARE, cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      orderType: 'resting-limit (+ taker stop-exit on hard reversal)',
    },
    equityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
    real: { enabled: !DRY_RUN, wallet: tradingWalletAddress(), balance: realBalance, positions: realPositions, lastUpdated: realLastUpdated, error: realFetchError },
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastPolyPriceFetch = 0, lastRealAccountFetch = 0, lastOrderPoll = 0, lastSpotFetch = 0, lastTpRetune = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastSpotFetch >= SPOT_REFRESH_MS) { lastSpotFetch = now; await refreshSpot(); }
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshPrices(); }
      if (now - lastRealAccountFetch >= REAL_ACCOUNT_REFRESH_MS) { lastRealAccountFetch = now; await refreshRealAccount(); }
      if (!DRY_RUN && now - lastOrderPoll >= ORDER_POLL_MS) { lastOrderPoll = now; await pollLiveOrders(); }
      if (now - lastTpRetune >= TP_RETUNE_MS) { lastTpRetune = now; await retuneTakeProfits(); }
      await tick();
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(_list) { return { ok: true, symbols: SYMBOLS, ladders: LADDER_DEFS.map(d => d.key) }; }
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (open positions/TPs/stops still managed; no new resting entries armed)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) {
    log(DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real resting limit orders');
    if (!DRY_RUN) refreshRealAccount().catch(() => {});
  }
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit; slog = slogFn;
  log('🚀 Momentum-Confirmed Adaptive Ladder Bot — BTC/ETH Up/Down, 5-minute windows only');
  log(`⚙️  $${TOTAL_CAPITAL} capital (shared) | base notional $${BASE_NOTIONAL} (0.4x-1.6x by confidence) | directional exposure cap $${MAX_DIRECTIONAL_EXPOSURE}/side`);
  log(`⚙️  Signal: Binance spot momentum since window-open, vol-normalized → confidence + model probability. Ladders only arm when edge ≥ ${MIN_EDGE} and confidence ≥ ${MIN_CONFIDENCE}`);
  log(`⚙️  Rungs are dynamic (RIDE/MID/DEEP scaled off live model probability), not fixed prices`);
  log(`⚙️  Exits: fixed TP on MID/DEEP, time-decay TP tightening in final ${TIME_DECAY_SECS}s, reversal stop-exit on RIDE tier if opposing confidence ≥ ${REVERSAL_CONFIDENCE}`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  await refreshSpot(); // warm up the spot feed before the first window loads

  const ws0 = currentWindowStart(WINDOW_SECS);
  const elapsed0 = nowSec() - ws0;
  if (elapsed0 > STARTUP_GRACE_SECS) {
    skipUntilWindowStart = ws0;
    log(`⏳ Started ${elapsed0.toFixed(0)}s into an in-progress ${WINDOW_SECS}s window — sitting this one out, will arm fresh at the next window boundary`);
  }

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
