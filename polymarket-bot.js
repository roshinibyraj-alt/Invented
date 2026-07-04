'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — MEAN-REVERSION FADE BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  Replaces the two-phase ladder strategy entirely. New idea, from scratch:
 *
 *  WHY MEAN REVERSION HERE: the Up/Down price is really a running estimate
 *  of P(BTC ends above/below the window's open price), constantly re-anchored
 *  as real BTC prints come in. That re-anchoring is genuine information and
 *  shouldn't be "faded" — but on top of it there's short-term order-flow
 *  noise: a single aggressive order can push a side's price away from its
 *  own recent local average for a few seconds before it partially snaps
 *  back, well before the next real BTC tick actually justifies the move.
 *  That snap-back is what this bot tries to capture — NOT a bet that BTC
 *  itself mean-reverts, just that the *market's reaction* often overshoots
 *  its own short-term trend for a few seconds.
 *
 *  PER WINDOW:
 *
 *  1. ROLLING REFERENCE: every SAMPLE_INTERVAL_S seconds, sample each side's
 *     mid price into a rolling buffer (ROLL_WINDOW_SAMPLES deep). Compute a
 *     rolling mean + stdev per side. Needs MIN_WARMUP_SAMPLES before trading
 *     starts — no signal on a window that just opened.
 *
 *  2. ENTRY SIGNAL (z-score fade): z = (mid - rollingMean) / rollingStdev.
 *     If z <= -Z_ENTRY_THRESHOLD, that side has dropped unusually far below
 *     its own recent average — rest a maker BUY a bit further below current
 *     mid (ENTRY_DISCOUNT), so it only fills if the dip genuinely continues
 *     down to meet it. Each fire opens an independent trade (not merged into
 *     one aggregate position) — multiple trades can be open on the same side
 *     at once, each with its own entry/target/stop/deadline. A per-side
 *     cooldown (COOLDOWN_AFTER_ENTRY_S) stops the same wobble from spawning
 *     a stack of near-identical trades, and MAX_CONCURRENT_TRADES caps total
 *     exposure. No new entries in the last ENTRY_CUTOFF_S of the window —
 *     too little time left for a reversion trade to play out safely.
 *
 *  3. SIZING (own formula): shares = BASE_SHARES × zMultiplier × timeFactor
 *     × compounding, clamped to [MIN_SHARES, MAX_SHARES].
 *       - zMultiplier: stronger deviations size up, capped at MAX_Z_MULT.
 *       - timeFactor: 1.0 early in the window, decays toward 0.5 by
 *         ENTRY_CUTOFF_S — later trades get less time to work, so less size.
 *       - compounding: 1 + (realizedPnl / startingCapital), same idea as
 *         before, persists across windows.
 *
 *  4. TIME-DECAYING EXITS (own idea, the heart of the request): every trade
 *     gets its OWN take-profit, stop-loss, and deadline, all computed from
 *     how much window time was left when it opened:
 *       - tpGain  = MIN_TP_GAIN  + (BASE_TP_GAIN  - MIN_TP_GAIN)  × timeFrac
 *       - slDist  = MIN_SL_DIST  + (BASE_SL_DIST  - MIN_SL_DIST)  × timeFrac
 *       - holdSecs= MIN_HOLD_S   + (BASE_HOLD_S   - MIN_HOLD_S)   × timeFrac
 *     where timeFrac = 1 at window open, 0 at ENTRY_CUTOFF_S. Early trades
 *     get a bigger target, more room, and more patience; late trades get a
 *     small quick target, a tight stop, and a short leash — because a late
 *     wobble that doesn't snap back FAST is more likely real trend than noise.
 *     TP is a genuine resting maker sell (earns rebate). A stop-loss breach
 *     or a timeout both force an immediate taker exit at the live bid — the
 *     reversion thesis is time-sensitive, so once it's invalidated there's
 *     no benefit to waiting for a better maker price.
 *
 *  5. WINDOW CLOSE: any trade that's still open (never hit TP/SL/timeout)
 *     gets a last-chance taker exit at the live bid if one's available,
 *     otherwise settles at actual Polymarket resolution ($1 win / $0 loss).
 *     Any resting entry order that never filled is simply cancelled.
 *
 *  FEES: every entry and every TP is a genuine resting maker order (rebate).
 *  Stop-loss and timeout exits are real taker orders (small fee) — the price
 *  of needing a guaranteed, immediate exit.
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

// ── Rolling reference / signal ──
const SAMPLE_INTERVAL_S   = Number(process.env.SAMPLE_INTERVAL_S || 5);   // how often we sample into the rolling buffer
const ROLL_WINDOW_SAMPLES = Number(process.env.ROLL_WINDOW_SAMPLES || 12); // 12 x 5s = 60s rolling reference
const MIN_WARMUP_SAMPLES  = Number(process.env.MIN_WARMUP_SAMPLES || 6);   // need >=30s of data before trading
const MIN_STD_FLOOR       = Number(process.env.MIN_STD_FLOOR || 0.02);     // avoid a hyper-reactive z on a dead-flat price
const Z_ENTRY_THRESHOLD   = Number(process.env.Z_ENTRY_THRESHOLD || 1.3);
const MAX_Z_MULT          = Number(process.env.MAX_Z_MULT || 2.5);

// ── Entry mechanics ──
const ENTRY_DISCOUNT          = Number(process.env.ENTRY_DISCOUNT || 0.03); // rest this far below current mid
const ENTRY_CUTOFF_S          = Number(process.env.ENTRY_CUTOFF_S || 240);  // no new entries after this
const COOLDOWN_AFTER_ENTRY_S  = Number(process.env.COOLDOWN_AFTER_ENTRY_S || 20); // per-side cooldown between entries
const MAX_CONCURRENT_TRADES   = Number(process.env.MAX_CONCURRENT_TRADES || 4);   // total open+resting trades per pair
const MAX_CONCURRENT_PER_SIDE = Number(process.env.MAX_CONCURRENT_PER_SIDE || 2);

// ── Sizing ──
const BASE_SHARES = Number(process.env.BASE_SHARES || 12);
const MIN_SHARES  = Number(process.env.MIN_SHARES || 2);
const MAX_SHARES  = Number(process.env.MAX_SHARES || 60);

// ── Time-decaying exit targets (all scaled by timeFrac = how early in the entry window the trade opened) ──
const BASE_TP_GAIN = Number(process.env.BASE_TP_GAIN || 0.20); // early-window target above entry
const MIN_TP_GAIN  = Number(process.env.MIN_TP_GAIN || 0.12);  // late-window floor target
const BASE_SL_DIST = Number(process.env.BASE_SL_DIST || 0.08); // early-window stop distance below entry
const MIN_SL_DIST  = Number(process.env.MIN_SL_DIST || 0.10);  // late-window floor stop distance
const BASE_HOLD_S  = Number(process.env.BASE_HOLD_S || 90);    // early-window patience
const MIN_HOLD_S   = Number(process.env.MIN_HOLD_S || 20);     // late-window patience
const TP_PRICE_CAP = Number(process.env.TP_PRICE_CAP || 0.97); // never rest a TP above this

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
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function nowSec() { return Date.now() / 1000; }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-meanrev-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-meanrev-bot/1.0' },
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
function freshPairState(symbol, carry = {}) {
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

    // persists across windows (compounding basis)
    startingCapital: carry.startingCapital ?? perPairCapital,
    bankroll: carry.bankroll ?? perPairCapital,
    realizedPnl: carry.realizedPnl ?? 0,
    feesPaid: carry.feesPaid ?? 0,
    rebatesEarned: carry.rebatesEarned ?? 0,
    wins: carry.wins ?? 0, losses: carry.losses ?? 0,

    // reset every window
    history: { Up: [], Down: [] },      // rolling {t, mid} samples
    lastSampleElapsed: -Infinity,
    lastEntryElapsed: { Up: -Infinity, Down: -Infinity },
    tradeSeq: 0,
    tradeList: [],                       // this window's trades (resting/open/closed)
    resolvedThisWindow: true,
    equityCurve: carry.equityCurve ?? [{ t: Date.now(), equity: perPairCapital }],
  };
}

function resetPairs() {
  perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
  pairs = {};
  for (const sym of pairList) pairs[sym] = freshPairState(sym, {});
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

  // fresh-per-window state (compounding fields deliberately NOT reset)
  p.history = { Up: [], Down: [] };
  p.lastSampleElapsed = -Infinity;
  p.lastEntryElapsed = { Up: -Infinity, Down: -Infinity };
  p.tradeSeq = 0;
  p.tradeList = [];

  const mult = round2(1 + (p.realizedPnl / p.startingCapital));
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | compounding x${mult} (realizedPnl $${p.realizedPnl.toFixed(2)})`);
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
function midPrice(ask, bid) {
  if (ask != null && bid != null) return round2((ask + bid) / 2);
  if (ask != null) return round2(ask);
  if (bid != null) return round2(bid);
  return null;
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function openTradesMarkValue(p) {
  let v = 0;
  for (const t of p.tradeList) {
    if (t.state !== 'open') continue;
    const bid = t.side === 'Up' ? p.upBid : p.downBid;
    const price = bid ?? (t.cost / t.shares);
    v += t.shares * price;
  }
  return round2(v);
}
function pairMarkValue(p) {
  return round2(p.bankroll + openTradesMarkValue(p));
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
//  Rolling reference + z-score signal
// ─────────────────────────────────────────
function updateHistory(p, elapsed) {
  if (elapsed - p.lastSampleElapsed < SAMPLE_INTERVAL_S) return;
  p.lastSampleElapsed = elapsed;
  const upMid = midPrice(p.upAsk, p.upBid);
  const downMid = midPrice(p.downAsk, p.downBid);
  if (upMid != null) {
    p.history.Up.push(upMid);
    if (p.history.Up.length > ROLL_WINDOW_SAMPLES) p.history.Up.shift();
  }
  if (downMid != null) {
    p.history.Down.push(downMid);
    if (p.history.Down.length > ROLL_WINDOW_SAMPLES) p.history.Down.shift();
  }
}
function meanStd(arr) {
  const n = arr.length;
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const variance = arr.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
  return { mean, std: Math.sqrt(variance) };
}
function zScore(p, side) {
  const hist = p.history[side];
  if (hist.length < MIN_WARMUP_SAMPLES) return null;
  const mid = side === 'Up' ? midPrice(p.upAsk, p.upBid) : midPrice(p.downAsk, p.downBid);
  if (mid == null) return null;
  const { mean, std } = meanStd(hist);
  const denom = Math.max(std, MIN_STD_FLOOR);
  return { z: round2((mid - mean) / denom), mean: round2(mean), mid };
}

// ─────────────────────────────────────────
//  Trade counting helpers
// ─────────────────────────────────────────
function activeTradeCount(p, side) {
  return p.tradeList.filter(t => (t.state === 'resting' || t.state === 'open') && (!side || t.side === side)).length;
}

// ─────────────────────────────────────────
//  Compounding
// ─────────────────────────────────────────
function compoundingMultiplier(p) {
  return Math.max(0.1, 1 + (p.realizedPnl / p.startingCapital));
}

// ─────────────────────────────────────────
//  Entry: look for a fresh fade signal and open a new trade
// ─────────────────────────────────────────
async function maybeEnterTrades(p, elapsed) {
  if (elapsed >= ENTRY_CUTOFF_S) return;
  if (activeTradeCount(p) >= MAX_CONCURRENT_TRADES) return;

  for (const side of ['Up', 'Down']) {
    if (activeTradeCount(p, side) >= MAX_CONCURRENT_PER_SIDE) continue;
    if (elapsed - p.lastEntryElapsed[side] < COOLDOWN_AFTER_ENTRY_S) continue;

    const sig = zScore(p, side);
    if (!sig || sig.z > -Z_ENTRY_THRESHOLD) continue; // only fade a drop below the side's own recent average

    const timeFrac = clamp(1 - elapsed / ENTRY_CUTOFF_S, 0, 1);
    const zMultiplier = clamp(Math.abs(sig.z) / Z_ENTRY_THRESHOLD, 1, MAX_Z_MULT);
    const sizeTimeMult = 0.5 + 0.5 * timeFrac;
    const shares = clamp(round2(BASE_SHARES * zMultiplier * sizeTimeMult * compoundingMultiplier(p)), MIN_SHARES, MAX_SHARES);

    const entryPrice = Math.max(0.01, round2(sig.mid - ENTRY_DISCOUNT));
    const cost = round2(entryPrice * shares);
    if (cost > p.bankroll) {
      log(`⏭️  ${p.symbol} ${side} fade signal (z=${sig.z}) skipped — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)})`);
      p.lastEntryElapsed[side] = elapsed;
      continue;
    }

    const tpGain = MIN_TP_GAIN + (BASE_TP_GAIN - MIN_TP_GAIN) * timeFrac;
    const slDist = MIN_SL_DIST + (BASE_SL_DIST - MIN_SL_DIST) * timeFrac;
    const holdS  = MIN_HOLD_S + (BASE_HOLD_S - MIN_HOLD_S) * timeFrac;
    const tpPrice = Math.min(TP_PRICE_CAP, round2(entryPrice + tpGain));
    const slPrice = Math.max(0.01, round2(entryPrice - slDist));

    const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
    const order = await placeLimitBuy(tokenId, entryPrice, shares);
    p.tradeSeq++;
    p.lastEntryElapsed[side] = elapsed;
    p.tradeList.push({
      id: p.tradeSeq, side, shares, cost, entryPrice,
      tpPrice, slPrice, holdS,
      state: 'resting', orderId: order.id || order.orderId || null,
      tpOrderId: null, tpState: 'none',
      openedAtElapsed: null, closeReason: null,
    });
    log(`🌀 ${p.symbol} #${p.tradeSeq} FADE ${side}: z=${sig.z} (avg ${sig.mean}) → resting buy ${shares}sh @ ${entryPrice.toFixed(2)} | TP ${tpPrice.toFixed(2)} / SL ${slPrice.toFixed(2)} / hold ${Math.round(holdS)}s`);
  }
}

// ─────────────────────────────────────────
//  Entry fill check
// ─────────────────────────────────────────
async function checkEntryFills(p, elapsed) {
  for (const t of p.tradeList) {
    if (t.state !== 'resting') continue;
    const ask = t.side === 'Up' ? p.upAsk : p.downAsk;
    if (ask == null || ask > t.entryPrice) continue;

    const rebate = makerRebate(t.shares, t.entryPrice);
    p.bankroll = round2(p.bankroll - t.cost + rebate);
    p.realizedPnl = round2(p.realizedPnl + rebate);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    t.state = 'open';
    t.openedAtElapsed = elapsed;

    const tokenId = t.side === 'Up' ? p.upTokenId : p.downTokenId;
    const tpOrder = await placeLimitSell(tokenId, t.tpPrice, t.shares);
    t.tpOrderId = tpOrder.id || tpOrder.orderId || null;
    t.tpState = 'resting';

    recordEquity(p);
    log(`🎯 ${p.symbol} #${t.id} FADE BUY filled ${t.shares}sh @ ${t.entryPrice.toFixed(2)} on ${t.side} | cost=$${t.cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP resting @ ${t.tpPrice.toFixed(2)}`);
    registerTrade(p, { side: 'BUY', outcome: t.side, reason: 'FADE_ENTRY', price: t.entryPrice, shares: t.shares, cost: t.cost, rebate });
  }
}

// ─────────────────────────────────────────
//  TP fill check (maker)
// ─────────────────────────────────────────
async function checkTpFills(p) {
  for (const t of p.tradeList) {
    if (t.state !== 'open' || t.tpState !== 'resting') continue;
    const bid = t.side === 'Up' ? p.upBid : p.downBid;
    if (bid == null || bid < t.tpPrice) continue;

    const proceeds = round2(t.tpPrice * t.shares);
    const rebate = makerRebate(t.shares, t.tpPrice);
    const net = round2(proceeds + rebate);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - t.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    if (profit >= 0) p.wins++; else p.losses++;
    t.state = 'closed'; t.tpState = 'filled'; t.closeReason = 'tp';

    log(`💰 ${p.symbol} #${t.id} TP filled ${t.shares}sh @ ${t.tpPrice.toFixed(2)} on ${t.side} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: t.side, reason: 'TP', price: t.tpPrice, shares: t.shares, profit, rebate });
    recordEquity(p);
  }
}

// ─────────────────────────────────────────
//  Stop-loss + timeout (both force an immediate taker exit — the reversion
//  thesis is time-sensitive, so once invalidated there's no benefit waiting)
// ─────────────────────────────────────────
async function forceCloseTaker(p, t, bid, closeReason) {
  if (t.tpState === 'resting') await cancelOrder(t.tpOrderId);
  const tokenId = t.side === 'Up' ? p.upTokenId : p.downTokenId;
  await placeLimitSell(tokenId, bid, t.shares); // marketable at the live bid — fills as taker

  const proceeds = round2(bid * t.shares);
  const fee = takerFee(t.shares, bid);
  const net = round2(proceeds - fee);
  p.bankroll = round2(p.bankroll + net);
  const profit = round2(net - t.cost);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.feesPaid = round2(p.feesPaid + fee);
  if (profit >= 0) p.wins++; else p.losses++;
  t.state = 'closed'; t.tpState = 'filled'; t.closeReason = closeReason;

  const icon = closeReason === 'sl' ? '🧯' : '⏱️';
  log(`${icon} ${p.symbol} #${t.id} ${closeReason.toUpperCase()} ${t.side} ${t.shares}sh sold @ ${bid.toFixed(2)} (taker) | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: t.side, reason: closeReason.toUpperCase(), price: bid, shares: t.shares, profit, fee });
  recordEquity(p);
}
async function checkStopAndTimeout(p, elapsed) {
  for (const t of p.tradeList) {
    if (t.state !== 'open' || t.tpState === 'filled') continue;
    const bid = t.side === 'Up' ? p.upBid : p.downBid;
    if (bid == null) continue;

    if (bid <= t.slPrice) { await forceCloseTaker(p, t, bid, 'sl'); continue; }
    if (elapsed - t.openedAtElapsed >= t.holdS) { await forceCloseTaker(p, t, bid, 'timeout'); continue; }
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

  let winner = null;
  for (const t of p.tradeList) {
    if (t.state === 'resting') {
      await cancelOrder(t.orderId);
      log(`🛑 ${p.symbol} #${t.id}: unfilled fade buy ${t.shares}sh @ ${t.entryPrice.toFixed(2)} on ${t.side} cancelled at window close`);
      t.state = 'closed'; t.closeReason = 'cancelled';
      continue;
    }
    if (t.state !== 'open') continue;

    const bid = t.side === 'Up' ? p.upBid : p.downBid;
    if (bid != null) {
      // Last-chance taker exit rather than riding all the way to a possible $0.
      await forceCloseTaker(p, t, bid, 'window_close');
      continue;
    }

    // No live price at all — settle by actual resolution.
    if (t.tpState === 'resting') await cancelOrder(t.tpOrderId);
    if (winner === null) winner = await determineWinningSide(p);
    const won = winner === t.side;
    const proceeds = won ? round2(t.shares * 1) : 0;
    const profit = round2(proceeds - t.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (won) p.wins++; else p.losses++;
    t.state = 'closed'; t.closeReason = 'resolution';
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} #${t.id} RESOLUTION ${t.side} ${t.shares}sh cost=$${t.cost.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: t.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: t.shares, profit });
  }

  const closed = p.tradeList.filter(t => t.state === 'closed' && t.closeReason !== 'cancelled');
  const byReason = closed.reduce((acc, t) => { acc[t.closeReason] = (acc[t.closeReason] || 0) + 1; return acc; }, {});
  log(`📊 ${p.symbol} window summary: ${closed.length} trades closed | ${JSON.stringify(byReason)} | wins=${p.wins} losses=${p.losses}`);
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
  updateHistory(p, elapsed);

  await checkEntryFills(p, elapsed);          // 1) did a resting fade-buy get hit?
  if (tradingEnabled) await maybeEnterTrades(p, elapsed); // 2) any fresh fade signal to act on?
  await checkTpFills(p);                      // 3) did a resting TP get hit?
  await checkStopAndTimeout(p, elapsed);      // 4) stop-loss breach or per-trade timeout?

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
    const markValue = pairMarkValue(p);
    const unrealized = round2(openTradesMarkValue(p) -
      p.tradeList.filter(t => t.state === 'open').reduce((s, t) => s + t.cost, 0));
    const upSig = p.tradable ? zScore(p, 'Up') : null;
    const downSig = p.tradable ? zScore(p, 'Down') : null;
    const openTrades = p.tradeList.filter(t => t.state === 'open').map(t => ({
      id: t.id, side: t.side, shares: t.shares, entryPrice: t.entryPrice,
      tpPrice: t.tpPrice, slPrice: t.slPrice,
      secsLeftToHold: Math.max(0, Math.round(t.holdS - ((nowSec() - p.windowStart) - t.openedAtElapsed))),
      tpState: t.tpState,
    }));
    const restingEntries = p.tradeList.filter(t => t.state === 'resting').map(t => ({
      id: t.id, side: t.side, shares: t.shares, entryPrice: t.entryPrice,
    }));

    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      upZ: upSig ? upSig.z : null,
      downZ: downSig ? downSig.z : null,
      sampleCount: p.history.Up.length,
      compoundMultiplier: round2(compoundingMultiplier(p)),
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      openTrades,
      restingEntries,
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
      sampleIntervalS: SAMPLE_INTERVAL_S,
      rollWindowSamples: ROLL_WINDOW_SAMPLES,
      zEntryThreshold: Z_ENTRY_THRESHOLD,
      entryDiscount: ENTRY_DISCOUNT,
      entryCutoffS: ENTRY_CUTOFF_S,
      baseShares: BASE_SHARES,
      baseTpGain: BASE_TP_GAIN, minTpGain: MIN_TP_GAIN,
      baseSlDist: BASE_SL_DIST, minSlDist: MIN_SL_DIST,
      baseHoldS: BASE_HOLD_S, minHoldS: MIN_HOLD_S,
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
  log('⏸️  Trading paused (open trades still managed for TP/SL/timeout/resolution; no new entries)');
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
  log(`🚀 5-Minute BTC Up/Down — Mean-Reversion Fade Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Signal: z-score fade vs rolling ${ROLL_WINDOW_SAMPLES}x${SAMPLE_INTERVAL_S}s mean, entry when z<=-${Z_ENTRY_THRESHOLD} (needs ${MIN_WARMUP_SAMPLES} samples warmup), no new entries after t=${ENTRY_CUTOFF_S}s`);
  log(`⚙️  Sizing: base ${BASE_SHARES}sh × signal strength (up to ${MAX_Z_MULT}x) × time-decay × compounding, clamped [${MIN_SHARES},${MAX_SHARES}]`);
  log(`⚙️  Time-decaying exits: TP gain ${BASE_TP_GAIN}→${MIN_TP_GAIN}, SL dist ${BASE_SL_DIST}→${MIN_SL_DIST}, hold time ${BASE_HOLD_S}s→${MIN_HOLD_S}s as entry approaches t=${ENTRY_CUTOFF_S}s`);
  log(`⚙️  TP = resting maker sell (rebate). SL breach & timeout = immediate taker exit at live bid.`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
