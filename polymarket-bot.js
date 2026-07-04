'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — VOLATILITY-MODEL EDGE BOT
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  THE MARKET
 *  Every 5 minutes Polymarket opens a fresh "<SYM> Up or Down" market per
 *  crypto pair (slug: `<sym>-updown-5m-<unix_window_start>`), e.g.
 *  https://polymarket.com/event/btc-updown-5m-1782897900. It resolves Up
 *  if the reference price is higher at the close of the window than at
 *  the open, Down otherwise. Up + Down prices always sum to ~$1 — it's a
 *  binary option on a 5-minute return. Polymarket's true resolution
 *  reference is a low-latency Chainlink price stream that isn't publicly
 *  queryable without a paid/HMAC-signed feed, so this bot uses live spot
 *  prices from Binance (primary) / Coinbase (fallback) as a close public
 *  proxy for "the price to beat" and for the current price.
 *
 *  WHY NOT TRADE THE POLYMARKET PRICE ITSELF (lesson from earlier testing)
 *  A prior version of this project tested "chase the side whose own
 *  Polymarket price just spiked" and found it lost money (43% win rate) —
 *  because the market's own price is reflexive: by the time it has moved,
 *  the move is already paid for. Fading that same reflexive spike did
 *  better, confirming the self-referential price is a bad edge source
 *  either way you look at only it.
 *
 *  THIS BOT'S EDGE: an independent fair-value model
 *  Treat each Up/Down market as a binary option on a driftless Brownian
 *  motion of the underlying crypto price. Given:
 *    O  = spot price at window open (proxy for "price to beat")
 *    S  = current spot price
 *    σ  = realized volatility of the pair (stdev of 1-minute log returns,
 *         from a rolling 1-hour lookback, refreshed every minute)
 *    T  = seconds remaining in the window
 *  the model probability that price finishes above O is:
 *    P(Up) = Φ( ln(S/O) / (σ_per_sec · √T) )
 *  (standard result for P(driftless GBM ends above a level) — for a
 *  5-minute horizon, ignoring risk-free drift is a fine approximation).
 *
 *  We compare this model probability to Polymarket's own implied price
 *  (which IS a probability, since these are $1-payout binary shares) and
 *  only trade when the model disagrees with the market by more than a
 *  minimum edge, after accounting for spread and fees. This means the
 *  bot is testing a real, falsifiable thesis (crypto spot momentum info
 *  not yet reflected in the Polymarket order book) rather than pattern-
 *  matching the derivative's own noise.
 *
 *  FILTERS ON TOP OF THE EDGE
 *   - Don't enter in the first MIN_ENTRY_ELAPSED_SECS of a window (too
 *     little post-open price action to trust the vol estimate).
 *   - Don't open new risk in the last LATE_ENTRY_CUTOFF_SECS (no time to
 *     manage the trade).
 *   - Skip if the quoted spread is too wide (illiquid, can't get a fair
 *     fill) or if price is at an extreme (<6¢ / >90¢ — poor risk/reward
 *     and fee drag dominates at the edges).
 *   - One trade per pair per window (keeps risk & bookkeeping simple and
 *     avoids compounding a single bad read into multiple entries).
 *
 *  SIZING: fractional Kelly
 *  For a binary bet costing `price` with model win probability `q`, the
 *  Kelly-optimal bankroll fraction is f* = (q - price) / (1 - price). We
 *  size at a fraction of Kelly (KELLY_MULTIPLIER, default 0.30) and cap
 *  at MAX_RISK_PCT_PER_TRADE of that pair's bankroll — full Kelly is far
 *  too aggressive for a noisy, mis-estimated probability model.
 *
 *  EXITS: layered TP/SL
 *   1. Price take-profit — resting maker sell (genuine 0-fee + rebate).
 *   2. Price stop-loss — taker sell if it moves hard against us.
 *   3. Model-invalidation stop — if live model probability for our side
 *      falls below MODEL_INVALIDATION_PROB, the real-world thesis broke
 *      down; exit even if the price hasn't hit the SL yet.
 *   4. Model take-profit — if model probability gets very high AND we're
 *      already ahead on price, lock the gain rather than hold for a
 *      symmetric TP that may not arrive before resolution.
 *   5. Safety buffer — inside the last EXIT_SAFETY_BUFFER_SEC we stop
 *      trying to exit (thin book near resolution) and just let the
 *      position resolve for $1/$0.
 *
 *  RISK MANAGEMENT
 *   - Daily loss limit (% of total capital) auto-pauses all trading.
 *   - Per-pair consecutive-loss cooldown pauses just that pair for a
 *     while, in case its regime (liquidity, vol regime) has changed.
 *
 *  PAIRS: "use every 5-minute pair available"
 *  Rather than hardcode which symbols currently have a live 5m market,
 *  we scan a broad candidate list every window boundary via the Gamma
 *  API. Symbols without a live market just sit "untradable" (one cheap
 *  lookup every 5 minutes) — whichever ones Polymarket actually has open
 *  light up automatically.
 * ═══════════════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA             = 'https://gamma-api.polymarket.com';
const CLOB               = 'https://clob.polymarket.com';
const BINANCE            = 'https://api.binance.com';
const COINBASE_SPOT      = 'https://api.coinbase.com';
const COINBASE_EXCHANGE  = 'https://api.exchange.coinbase.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const SPOT_PRICE_REFRESH_MS = Number(process.env.SPOT_PRICE_REFRESH_MS || 2000);
const VOL_REFRESH_MS        = Number(process.env.VOL_REFRESH_MS || 60000);
const WINDOW_SECS           = 300;
const RESOLUTION_BUFFER_S   = 8;
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

// Broad candidate list — anything without a live 5m market just stays
// "untradable" at near-zero cost. Override with CRYPTO_PAIRS env if you
// want a fixed subset instead of auto-discovery across all of these.
const DEFAULT_CANDIDATES = 'BTC,ETH,SOL,XRP,DOGE,LTC,BNB,LINK,AVAX,ADA';
const RAW_PAIRS = (process.env.CRYPTO_PAIRS || DEFAULT_CANDIDATES)
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// Symbol → external spot-price source mapping. A symbol with no mapping
// has no independent fair-value model, so it's excluded up front.
const BINANCE_MAP = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT',
  LTC: 'LTCUSDT', BNB: 'BNBUSDT', LINK: 'LINKUSDT', AVAX: 'AVAXUSDT', ADA: 'ADAUSDT',
  MATIC: 'MATICUSDT', ARB: 'ARBUSDT', SUI: 'SUIUSDT', APT: 'APTUSDT',
};
const COINBASE_MAP = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD',
  LTC: 'LTC-USD', LINK: 'LINK-USD', AVAX: 'AVAX-USD', ADA: 'ADA-USD',
  MATIC: 'MATIC-USD', ARB: 'ARB-USD', SUI: 'SUI-USD', APT: 'APT-USD',
};
function eligibleSymbol(sym) { return !!BINANCE_MAP[sym]; }

// ── Strategy parameters (all overridable via env) ──
const MIN_ENTRY_ELAPSED_SECS  = Number(process.env.MIN_ENTRY_ELAPSED_SECS || 40);
const LATE_ENTRY_CUTOFF_SECS  = Number(process.env.LATE_ENTRY_CUTOFF_SECS || 25);
const EXIT_SAFETY_BUFFER_SEC  = Number(process.env.EXIT_SAFETY_BUFFER_SEC || 12);
const EDGE_THRESHOLD          = Number(process.env.EDGE_THRESHOLD || 0.06);
const MIN_ENTRY_PRICE         = Number(process.env.MIN_ENTRY_PRICE || 0.06);
const MAX_ENTRY_PRICE         = Number(process.env.MAX_ENTRY_PRICE || 0.90);
const MAX_SPREAD              = Number(process.env.MAX_SPREAD || 0.08);
const VOL_LOOKBACK_CANDLES    = Number(process.env.VOL_LOOKBACK_CANDLES || 60);
const MIN_SIGMA_PER_MIN       = Number(process.env.MIN_SIGMA_PER_MIN || 0.0004);
const MODEL_INVALIDATION_PROB = Number(process.env.MODEL_INVALIDATION_PROB || 0.40);
const MODEL_TAKEPROFIT_PROB   = Number(process.env.MODEL_TAKEPROFIT_PROB || 0.94);
const TP_OFFSET                = Number(process.env.TP_OFFSET || 0.15);
const SL_OFFSET                = Number(process.env.SL_OFFSET || 0.09);
const KELLY_MULTIPLIER         = Number(process.env.KELLY_MULTIPLIER || 0.30);
const MAX_RISK_PCT_PER_TRADE   = Number(process.env.MAX_RISK_PCT_PER_TRADE || 0.06);
const MIN_TRADE_USD            = Number(process.env.MIN_TRADE_USD || 2);
const MIN_SHARES               = Number(process.env.MIN_SHARES || 5);
const MAX_SHARES_PER_TRADE     = Number(process.env.MAX_SHARES_PER_TRADE || 500);
const DAILY_LOSS_LIMIT_PCT     = Number(process.env.DAILY_LOSS_LIMIT_PCT || 0.20);
const CONSECUTIVE_LOSS_LIMIT   = Number(process.env.CONSECUTIVE_LOSS_LIMIT || 3);
const LOSS_COOLDOWN_MS         = Number(process.env.LOSS_COOLDOWN_MS || 15 * 60 * 1000);
const MAX_CONCURRENT_POSITIONS = Number(process.env.MAX_CONCURRENT_POSITIONS || 0); // 0 = unlimited

const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

// ── Module state ──
let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let pairList = RAW_PAIRS.filter(eligibleSymbol);
let perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
let pairs = {};
let spotPrices = {};   // { SYMBOL: latestSpotPrice }
let sigmaMap = {};     // { SYMBOL: stdev of 1m log returns }
let lastPolyPriceFetch = 0;
let totalEquityCurve = [];
let dailyPnl = 0;
let dailyDayStart = currentUtcDayStart();
let dailyLimitHit = false;

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function nowSec() { return Date.now() / 1000; }
function currentUtcDayStart() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-vol-edge-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-vol-edge-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

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
function takerFee(shares, price) { return Math.round(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * 100000) / 100000; }
function makerRebate(shares, price) { return Math.round(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE * 100000) / 100000; }

// ─────────────────────────────────────────
//  Per-pair state
// ─────────────────────────────────────────
function freshPairState(symbol) {
  return {
    symbol,
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    openSpotPrice: null,
    entryDone: false,
    position: null,       // { side, entryPrice, shares, cost, entryModelProb, openSpot, tpPrice, slPrice, tpOrderId, openedAt }
    liveModelProb: null,
    bankroll: perPairCapital,
    realizedPnl: 0, feesPaid: 0, rebatesEarned: 0,
    wins: 0, losses: 0, consecutiveLosses: 0, cooldownUntil: 0,
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
//  Gamma / CLOB market discovery & pricing
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) { return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS; }
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
  for (const offset of SLUG_OFFSET_FALLBACKS) {
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
async function loadPairWindow(p) {
  const ws = currentWindowStart();
  if (p.windowStart === ws && p.upTokenId) return;
  const found = await fetchEventForWindow(p.symbol, ws);
  if (!found) { p.tradable = false; return; }
  const { event, windowStart, slug } = found;
  const market = event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];
  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) { log(`⚠️  ${p.symbol}: window loaded but Up/Down token ids missing`); p.tradable = false; return; }

  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.slug = slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;
  p.resolvedThisWindow = false;
  p.entryDone = false;
  p.openSpotPrice = null;
  p.liveModelProb = null;
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11, 19)}Z`);
}

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
      } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────
//  External spot price + volatility (Binance primary, Coinbase fallback)
// ─────────────────────────────────────────
async function fetchBinanceSpotBatch(symbols) {
  const list = symbols.map(s => BINANCE_MAP[s]).filter(Boolean);
  if (!list.length) return {};
  const url = `${BINANCE}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(list))}`;
  const data = await getJSON(url);
  const rev = {}; for (const [k, v] of Object.entries(BINANCE_MAP)) rev[v] = k;
  const out = {};
  for (const row of data) { const sym = rev[row.symbol]; if (sym) out[sym] = parseFloat(row.price); }
  return out;
}
async function fetchCoinbaseSpotOne(symbol) {
  const pair = COINBASE_MAP[symbol];
  if (!pair) return null;
  const data = await getJSON(`${COINBASE_SPOT}/v2/prices/${pair}/spot`);
  const amt = parseFloat(data?.data?.amount);
  return Number.isFinite(amt) ? amt : null;
}
async function refreshSpotPrices(symbols) {
  try {
    const batch = await fetchBinanceSpotBatch(symbols);
    for (const [sym, px] of Object.entries(batch)) if (Number.isFinite(px)) spotPrices[sym] = px;
  } catch (e) {
    log(`⚠️  Binance spot fetch failed (${e.message}) — falling back to Coinbase`);
  }
  const missing = symbols.filter(s => !Number.isFinite(spotPrices[s]) && COINBASE_MAP[s]);
  for (const sym of missing) {
    try { const px = await fetchCoinbaseSpotOne(sym); if (px) spotPrices[sym] = px; } catch (_) {}
  }
}
async function fetchKlinesBinance(symbol) {
  const bsym = BINANCE_MAP[symbol];
  if (!bsym) return null;
  const data = await getJSON(`${BINANCE}/api/v3/klines?symbol=${bsym}&interval=1m&limit=${VOL_LOOKBACK_CANDLES}`);
  return data.map(row => parseFloat(row[4]));
}
async function fetchKlinesCoinbase(symbol) {
  const pair = COINBASE_MAP[symbol];
  if (!pair) return null;
  const data = await getJSON(`${COINBASE_EXCHANGE}/products/${pair}/candles?granularity=60`);
  return data.slice(0, VOL_LOOKBACK_CANDLES).reverse().map(row => row[4]);
}
function stdev(arr) {
  const n = arr.length; if (n < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return Math.sqrt(variance);
}
function sigmaFromCloses(closes) {
  if (!closes || closes.length < 5) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  return rets.length >= 4 ? stdev(rets) : null;
}
async function refreshVolatility(symbol) {
  try {
    const s = sigmaFromCloses(await fetchKlinesBinance(symbol));
    if (s != null) { sigmaMap[symbol] = Math.max(s, MIN_SIGMA_PER_MIN); return; }
  } catch (_) {}
  try {
    const s = sigmaFromCloses(await fetchKlinesCoinbase(symbol));
    if (s != null) sigmaMap[symbol] = Math.max(s, MIN_SIGMA_PER_MIN);
  } catch (_) {}
}

// ─────────────────────────────────────────
//  Fair-value model: driftless Brownian bridge → P(finish above open)
// ─────────────────────────────────────────
function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, pc = 0.3275911;
  const t = 1 / (1 + pc * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCDF(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function modelProbUp(openPx, curPx, sigmaPerMin, secsRemaining) {
  if (!openPx || !curPx || !sigmaPerMin || secsRemaining == null) return 0.5;
  if (secsRemaining <= 0) return curPx >= openPx ? 0.999 : 0.001;
  const sigmaPerSec = sigmaPerMin / Math.sqrt(60);
  const sigmaT = sigmaPerSec * Math.sqrt(secsRemaining);
  if (sigmaT < 1e-6) return curPx >= openPx ? 0.999 : 0.001;
  const z = Math.log(curPx / openPx) / sigmaT;
  return Math.min(0.999, Math.max(0.001, normalCDF(z)));
}

// ─────────────────────────────────────────
//  Bookkeeping helpers
// ─────────────────────────────────────────
function positionMarkValue(p) {
  if (!p.position) return 0;
  const bid = p.position.side === 'Up' ? p.upBid : p.downBid;
  return round2(p.position.shares * (bid ?? p.position.entryPrice));
}
function pairMarkValue(p) { return round2(p.bankroll + positionMarkValue(p)); }
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
function checkDailyReset() {
  const ds = currentUtcDayStart();
  if (ds !== dailyDayStart) { dailyDayStart = ds; dailyPnl = 0; dailyLimitHit = false; log('🌅 New UTC day — daily loss counter reset'); }
}
function addDailyPnl(x) {
  dailyPnl = round2(dailyPnl + x);
  if (!dailyLimitHit && dailyPnl <= -Math.abs(DAILY_LOSS_LIMIT_PCT * TOTAL_CAPITAL)) {
    dailyLimitHit = true; tradingEnabled = false;
    log(`🛑 Daily loss limit hit ($${dailyPnl.toFixed(2)}) — trading auto-paused. Resume manually or wait for next UTC day.`);
  }
}
function countOpenPositions() { return Object.values(pairs).filter(p => p.position).length; }

// ─────────────────────────────────────────
//  Entry — model edge vs Polymarket implied price
// ─────────────────────────────────────────
function pairSpread(p, side) {
  if (side === 'Up') return (p.upAsk != null && p.upBid != null) ? round4(p.upAsk - p.upBid) : Infinity;
  return (p.downAsk != null && p.downBid != null) ? round4(p.downAsk - p.downBid) : Infinity;
}
function kellySize(edge, price, bankroll) {
  if (edge <= 0 || price <= 0 || price >= 1) return 0;
  const fStar = edge / (1 - price);
  const frac = Math.max(0, Math.min(1, fStar * KELLY_MULTIPLIER));
  const cappedFrac = Math.min(frac, MAX_RISK_PCT_PER_TRADE);
  return round2(bankroll * cappedFrac);
}

async function maybeEnter(p) {
  if (p.position || p.entryDone) return;
  if (!tradingEnabled || dailyLimitHit) return;
  if (Date.now() < p.cooldownUntil) return;
  if (MAX_CONCURRENT_POSITIONS > 0 && countOpenPositions() >= MAX_CONCURRENT_POSITIONS) return;
  if (p.openSpotPrice == null || spotPrices[p.symbol] == null || sigmaMap[p.symbol] == null) return;

  const remaining = p.windowEnd - nowSec();
  const elapsed = WINDOW_SECS - remaining;
  if (elapsed < MIN_ENTRY_ELAPSED_SECS) return;
  if (remaining < LATE_ENTRY_CUTOFF_SECS) { p.entryDone = true; return; }
  if (p.upAsk == null || p.downAsk == null) return;

  const cur = spotPrices[p.symbol];
  const sigma = sigmaMap[p.symbol];
  const qUp = modelProbUp(p.openSpotPrice, cur, sigma, remaining);
  const qDown = 1 - qUp;
  p.liveModelProb = null;

  const edgeUp = round4(qUp - p.upAsk);
  const edgeDown = round4(qDown - p.downAsk);

  let side = null, ask = null, edge = null, q = null;
  if (edgeUp >= EDGE_THRESHOLD && edgeUp >= edgeDown) { side = 'Up'; ask = p.upAsk; edge = edgeUp; q = qUp; }
  else if (edgeDown >= EDGE_THRESHOLD) { side = 'Down'; ask = p.downAsk; edge = edgeDown; q = qDown; }
  if (!side) return;
  if (ask < MIN_ENTRY_PRICE || ask > MAX_ENTRY_PRICE) return;
  if (pairSpread(p, side) > MAX_SPREAD) return;

  const targetCost = Math.max(MIN_TRADE_USD, kellySize(edge, ask, p.bankroll));
  let shares = round2(targetCost / ask);
  shares = Math.max(MIN_SHARES, Math.min(MAX_SHARES_PER_TRADE, shares));
  const cost = round2(ask * shares);
  if (cost < 1 || cost > p.bankroll) return; // below marketable min or insufficient bankroll — retry next tick

  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  await placeLimitBuy(tokenId, ask, shares);
  const fee = takerFee(shares, ask);
  p.bankroll = round2(p.bankroll - cost - fee);
  p.feesPaid = round2(p.feesPaid + fee);
  p.realizedPnl = round2(p.realizedPnl - fee);
  addDailyPnl(-fee);

  p.position = {
    side, entryPrice: ask, shares, cost,
    entryModelProb: q, openSpot: p.openSpotPrice,
    tpPrice: Math.min(round2(ask + TP_OFFSET), 0.98),
    slPrice: Math.max(round2(ask - SL_OFFSET), 0.02),
    tpOrderId: null, openedAt: Date.now(),
  };
  p.entryDone = true;

  const tpOrder = await placeLimitSell(tokenId, p.position.tpPrice, shares);
  p.position.tpOrderId = tpOrder.id || tpOrder.orderId || null;
  recordEquity(p);
  log(`🎯 ${p.symbol} edge=${(edge * 100).toFixed(1)}% model=${(q * 100).toFixed(1)}% ask=${ask.toFixed(2)} → bought ${side} ${shares}sh | cost=$${cost.toFixed(2)} | TP@${p.position.tpPrice.toFixed(2)} SL@${p.position.slPrice.toFixed(2)}`);
  registerTrade(p, { side: 'BUY', outcome: side, price: ask, shares, cost, fee, modelProb: q, edge });
}

// ─────────────────────────────────────────
//  Position management — layered exits
// ─────────────────────────────────────────
async function closeAtLoss(p, pos, bid, reason) {
  const fee = takerFee(pos.shares, bid);
  const proceeds = round2(bid * pos.shares);
  const net = round2(proceeds - fee);
  p.bankroll = round2(p.bankroll + net);
  const profit = round2(net - pos.cost);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.feesPaid = round2(p.feesPaid + fee);
  p.losses++; p.consecutiveLosses++;
  addDailyPnl(profit);
  if (p.consecutiveLosses >= CONSECUTIVE_LOSS_LIMIT) {
    p.cooldownUntil = Date.now() + LOSS_COOLDOWN_MS;
    log(`🧯 ${p.symbol} ${p.consecutiveLosses} losses in a row — cooling down ${Math.round(LOSS_COOLDOWN_MS / 60000)}m`);
  }
  log(`💥 ${p.symbol} ${reason} ${pos.shares}sh @ ${bid.toFixed(2)} | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: pos.side, reason, price: bid, shares: pos.shares, profit, fee });
  p.position = null;
  recordEquity(p);
}

async function manageOpenPosition(p, remaining) {
  const pos = p.position;
  if (!pos) return;
  const bid = pos.side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;
  if (remaining <= EXIT_SAFETY_BUFFER_SEC) return; // too close to resolution — ride it out, resolvePairWindow settles it

  if (bid >= pos.tpPrice) {
    const rebate = makerRebate(pos.shares, pos.tpPrice);
    const proceeds = round2(pos.tpPrice * pos.shares);
    const net = round2(proceeds + rebate);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    p.wins++; p.consecutiveLosses = 0;
    addDailyPnl(profit);
    log(`💰 ${p.symbol} TP filled ${pos.shares}sh @ ${pos.tpPrice.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: pos.side, reason: 'TP', price: pos.tpPrice, shares: pos.shares, profit, rebate });
    p.position = null; recordEquity(p);
    return;
  }

  if (bid <= pos.slPrice) {
    const tokenId = pos.side === 'Up' ? p.upTokenId : p.downTokenId;
    await cancelOrder(pos.tpOrderId);
    await placeLimitSell(tokenId, bid, pos.shares);
    await closeAtLoss(p, pos, bid, 'SL');
    return;
  }

  const cur = spotPrices[p.symbol];
  const sigma = sigmaMap[p.symbol];
  if (cur == null || sigma == null) return;
  const qUp = modelProbUp(pos.openSpot, cur, sigma, remaining);
  const qSide = pos.side === 'Up' ? qUp : 1 - qUp;
  p.liveModelProb = qSide;

  if (qSide < MODEL_INVALIDATION_PROB) {
    const tokenId = pos.side === 'Up' ? p.upTokenId : p.downTokenId;
    await cancelOrder(pos.tpOrderId);
    await placeLimitSell(tokenId, bid, pos.shares);
    await closeAtLoss(p, pos, bid, 'MODEL_INVALIDATED');
    return;
  }

  if (qSide > MODEL_TAKEPROFIT_PROB && bid > pos.entryPrice * 1.05) {
    const tokenId = pos.side === 'Up' ? p.upTokenId : p.downTokenId;
    await cancelOrder(pos.tpOrderId);
    await placeLimitSell(tokenId, bid, pos.shares);
    const fee = takerFee(pos.shares, bid);
    const proceeds = round2(bid * pos.shares);
    const net = round2(proceeds - fee);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.feesPaid = round2(p.feesPaid + fee);
    p.wins++; p.consecutiveLosses = 0;
    addDailyPnl(profit);
    log(`✅ ${p.symbol} early model-TP (${(qSide * 100).toFixed(1)}%) ${pos.shares}sh @ ${bid.toFixed(2)} | pnl=$${profit.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: pos.side, reason: 'MODEL_TP', price: bid, shares: pos.shares, profit, fee });
    p.position = null; recordEquity(p);
  }
}

// ─────────────────────────────────────────
//  Resolution
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
  } catch (_) {}
  if (p.upBid != null && p.downBid != null) return p.upBid >= p.downBid ? 'Up' : 'Down';
  return null;
}
async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;
  const pos = p.position;
  if (!pos) return;
  await cancelOrder(pos.tpOrderId);
  const winner = await determineWinningSide(p);
  const won = winner === pos.side;
  const proceeds = won ? round2(pos.shares * 1) : 0;
  const profit = round2(proceeds - pos.cost);
  p.bankroll = round2(p.bankroll + proceeds);
  p.realizedPnl = round2(p.realizedPnl + profit);
  if (won) { p.wins++; p.consecutiveLosses = 0; }
  else {
    p.losses++; p.consecutiveLosses++;
    if (p.consecutiveLosses >= CONSECUTIVE_LOSS_LIMIT) {
      p.cooldownUntil = Date.now() + LOSS_COOLDOWN_MS;
      log(`🧯 ${p.symbol} ${p.consecutiveLosses} losses in a row — cooling down ${Math.round(LOSS_COOLDOWN_MS / 60000)}m`);
    }
  }
  addDailyPnl(profit);
  const icon = won ? '💰' : '💥';
  log(`${icon} ${p.symbol} RESOLUTION ${pos.side} ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: pos.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
  p.position = null;
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Per-tick pair processing
// ─────────────────────────────────────────
async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable) return;

  const remaining = p.windowEnd - nowSec();

  if (p.openSpotPrice == null && spotPrices[p.symbol] != null) {
    p.openSpotPrice = spotPrices[p.symbol];
    log(`🔭 ${p.symbol} window ${p.slug} open spot ≈ $${p.openSpotPrice} (proxy for price-to-beat)`);
  }

  if (p.position) await manageOpenPosition(p, remaining);
  else if (tradingEnabled && !dailyLimitHit) await maybeEnter(p);

  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) await resolvePairWindow(p);
}

// ─────────────────────────────────────────
//  Dashboard state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(p.position ? positionMarkValue(p) - p.position.cost : 0);
    const markValue = pairMarkValue(p);
    const cur = spotPrices[p.symbol] ?? null;
    const sigma = sigmaMap[p.symbol] ?? null;
    const remaining = p.windowEnd ? Math.max(0, p.windowEnd - nowSec()) : null;
    let qUp = null;
    if (p.openSpotPrice != null && cur != null && sigma != null && remaining != null) {
      qUp = round4(modelProbUp(p.openSpotPrice, cur, sigma, remaining));
    }
    return {
      symbol: p.symbol, tradable: p.tradable, slug: p.slug, windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      openSpotPrice: p.openSpotPrice, spotPrice: cur, sigmaPerMin: sigma,
      modelProbUp: qUp, modelProbDown: qUp != null ? round4(1 - qUp) : null,
      cooldownSecs: p.cooldownUntil > Date.now() ? Math.ceil((p.cooldownUntil - Date.now()) / 1000) : 0,
      bankroll: p.bankroll, realizedPnl: p.realizedPnl, unrealizedPnl: unrealized, markValue,
      feesPaid: p.feesPaid, rebatesEarned: p.rebatesEarned, wins: p.wins, losses: p.losses,
      consecutiveLosses: p.consecutiveLosses,
      position: p.position ? {
        side: p.position.side, entryPrice: p.position.entryPrice, shares: p.position.shares, cost: p.position.cost,
        tpPrice: p.position.tpPrice, slPrice: p.position.slPrice,
        entryModelProb: p.position.entryModelProb, liveModelProb: p.liveModelProb,
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
  return {
    dryRun: DRY_RUN, tradingEnabled, dailyLimitHit, dailyPnl,
    pairs: pairList, strategy: 'Volatility-Model Edge (σ-edge)',
    totalCapital: TOTAL_CAPITAL, perPairCapital, totalBankroll, totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized, totalUnrealizedPnl: totalUnrealized, totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses, totalFeesPaid: round2(pairStates.reduce((s, p) => s + p.feesPaid, 0)),
    totalRebatesEarned: round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0)),
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      edgeThreshold: EDGE_THRESHOLD, minEntryElapsedSecs: MIN_ENTRY_ELAPSED_SECS, lateEntryCutoffSecs: LATE_ENTRY_CUTOFF_SECS,
      tpOffset: TP_OFFSET, slOffset: SL_OFFSET, kellyMultiplier: KELLY_MULTIPLIER, maxRiskPct: MAX_RISK_PCT_PER_TRADE,
      dailyLossLimitPct: DAILY_LOSS_LIMIT_PCT, consecutiveLossLimit: CONSECUTIVE_LOSS_LIMIT,
      modelInvalidationProb: MODEL_INVALIDATION_PROB, modelTakeProfitProb: MODEL_TAKEPROFIT_PROB,
    },
    pairStates, totalEquityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

// ─────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────
let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastSpot = 0;
  const lastVolAt = {};
  while (true) {
    try {
      checkDailyReset();
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshPolyPrices(); }
      const activeSymbols = Object.values(pairs).filter(p => p.tradable).map(p => p.symbol);
      const spotSymbols = activeSymbols.length ? activeSymbols : pairList;
      if (now - lastSpot >= SPOT_PRICE_REFRESH_MS) { lastSpot = now; await refreshSpotPrices(spotSymbols); }
      for (const sym of pairList) {
        if (!lastVolAt[sym] || now - lastVolAt[sym] >= VOL_REFRESH_MS) {
          lastVolAt[sym] = now;
          refreshVolatility(sym).catch(() => {});
        }
      }
      for (const p of Object.values(pairs)) {
        try { await processPair(p); } catch (e) { log(`⚠️  ${p.symbol} tick error: ${e.message}`); }
      }
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(list) {
  const clean = (list || []).map(s => s.trim().toUpperCase()).filter(Boolean).filter(eligibleSymbol);
  if (!clean.length) return { ok: false, error: 'No eligible symbols — each pair needs a Binance/Coinbase spot mapping for the volatility model' };
  pairList = [...new Set(clean)];
  resetPairs();
  log(`⚙️  Pairs updated: ${pairList.join(', ')} | $${perPairCapital.toFixed(2)} per pair`);
  return { ok: true, pairs: pairList, perPairCapital };
}
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; dailyLimitHit = false; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log('🚀 Volatility-Model Edge Bot — pricing each 5m Up/Down market as a binary option against a Brownian-bridge fair-value model driven by real exchange spot prices (Binance primary, Coinbase fallback), independent of Polymarket\'s own reflexive price.');
  log(`⚙️  $${TOTAL_CAPITAL} capital across ${pairList.length} candidate pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair — pairs with no live 5m market simply stay idle`);
  log(`⚙️  entry: edge≥${EDGE_THRESHOLD}, price∈[${MIN_ENTRY_PRICE},${MAX_ENTRY_PRICE}], spread≤${MAX_SPREAD}, elapsed≥${MIN_ENTRY_ELAPSED_SECS}s, remaining≥${LATE_ENTRY_CUTOFF_SECS}s, 1 trade/pair/window`);
  log(`⚙️  sizing: fractional Kelly ×${KELLY_MULTIPLIER}, capped ${(MAX_RISK_PCT_PER_TRADE * 100).toFixed(0)}% bankroll/trade`);
  log(`⚙️  exits: price TP+${TP_OFFSET}/SL-${SL_OFFSET}, model-invalidation stop <${MODEL_INVALIDATION_PROB}, model take-profit >${MODEL_TAKEPROFIT_PROB}, safety buffer ${EXIT_SAFETY_BUFFER_SEC}s`);
  log(`⚙️  risk: daily loss limit ${(DAILY_LOSS_LIMIT_PCT * 100).toFixed(0)}% of capital | ${CONSECUTIVE_LOSS_LIMIT}-loss cooldown/pair (${Math.round(LOSS_COOLDOWN_MS / 60000)}m)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
