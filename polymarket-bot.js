'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — BTC SIGNAL + MARTINGALE RECOVERY
 * ═══════════════════════════════════════════════════════════════
 *
 *  Direction still comes entirely from real BTC (or other crypto) spot price
 *  action, fetched from Binance — the Polymarket token's own ask/bid is only
 *  used to know what price would actually be paid to enter, and to check the
 *  resting take-profit order.
 *
 *  SIGNAL (majority vote, 2-of-3 required):
 *    Spot price is compared against three references: this window's own open
 *    price, the most recently CLOSED 15-minute candle's close, and the most
 *    recently CLOSED 1-hour candle's close. 2 or 3 agreeing votes = a valid
 *    signal; a 1-1 split or missing data = no trade.
 *
 *  ENTRY: exactly ONE trade per window, at +15 seconds after the window
 *    opens. If a signal is valid at that moment, enter immediately as a
 *    marketable buy (limit priced at the current ask, so it fills now). No
 *    second checkpoint, no pyramiding — one call, one bet, per window.
 *
 *  SIZING — MARTINGALE RECOVERY (no cap):
 *    - Base case (last trade won, or this is the first trade): stake 1% of
 *      the CURRENT bankroll.
 *    - Recovery case (last trade lost): the outstanding cumulative loss is
 *      tracked in p.martingaleLoss. This window's stake is sized so that a
 *      win exactly recovers it, using THIS window's actual entry price:
 *        shares = martingaleLoss / (1 - entryPrice)
 *        stake  = shares * entryPrice
 *      A win resets p.martingaleLoss to 0 (back to 1% base next window). A
 *      loss adds this trade's full cost to p.martingaleLoss, so the next
 *      window's recovery target grows. THERE IS NO CAP — a losing streak,
 *      especially one where entries land at a high price (small 1-entryPrice
 *      denominator), can escalate the required stake very quickly. This is
 *      an explicit, accepted design choice, not an oversight.
 *
 *  EXIT: no stop-loss. A resting take-profit limit sell at 0.99 locks in a
 *    win early if the market is already near-certain; otherwise the position
 *    rides to actual window resolution (wins pay $1/share, losses pay $0).
 *
 *  FEES: entries are deliberately marketable (taker). The TP sell is a
 *    genuine resting maker order.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA    = 'https://gamma-api.polymarket.com';
const CLOB     = 'https://clob.polymarket.com';
const BINANCE  = 'https://api.binance.com/api/v3';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // force-resolve this many seconds BEFORE the nominal window end (298s)
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const CHECKPOINT_SECS = Number(process.env.CHECKPOINT_SECS || 15); // seconds after window open — the one entry point
const BASE_SIZE_PCT   = Number(process.env.BASE_SIZE_PCT || 0.01); // 1% of current bankroll, when not recovering
const TP_PRICE        = Number(process.env.TP_PRICE || 0.99);
const MIN_SHARES      = Number(process.env.MIN_SHARES || 5);

const BTC_PRICE_REFRESH_MS  = Number(process.env.BTC_PRICE_REFRESH_MS || 3000);
const BTC_CANDLE_REFRESH_MS = Number(process.env.BTC_CANDLE_REFRESH_MS || 20000);

const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let pairList = [...DEFAULT_PAIRS];
let perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
let pairs = {};
let lastPolyPriceFetch = 0;
let totalEquityCurve = [];
let cryptoRefs = {}; // per-symbol Binance reference data — see refreshCryptoRef

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-btc-signal-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-btc-signal-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// A marketable buy — priced at the current ask so it fills now. This is a
// timed, signal-driven entry, not a price-ladder one, so there's no reason
// to wait for a resting order to be hit.
async function placeMarketableBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
// A genuine resting (passive/maker) limit sell — the take-profit order,
// placed above the current market so it only fills if/when price actually
// gets there.
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
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}

// ─────────────────────────────────────────
//  BTC (or other crypto) spot price + candle reference data
// ─────────────────────────────────────────
function ensureRefs(symbol) {
  if (!cryptoRefs[symbol]) cryptoRefs[symbol] = { price: null, close15: null, close1h: null, lastPriceFetch: 0, lastCandleFetch: 0 };
  return cryptoRefs[symbol];
}

// Returns the close of the most recently CLOSED candle for the given
// interval — i.e. it explicitly skips the currently-forming candle, which
// Binance's klines endpoint always includes as the last row.
async function fetchClosedCandleClose(binanceSymbol, interval) {
  const data = await getJSON(`${BINANCE}/klines?symbol=${binanceSymbol}&interval=${interval}&limit=2`);
  const now = Date.now();
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][6] < now) return parseFloat(data[i][4]); // [6]=closeTime, [4]=close
  }
  return null;
}

async function refreshCryptoRef(symbol) {
  const r = ensureRefs(symbol);
  const now = Date.now();
  const binanceSymbol = `${symbol}USDT`;
  if (now - r.lastPriceFetch >= BTC_PRICE_REFRESH_MS) {
    r.lastPriceFetch = now;
    try {
      const d = await getJSON(`${BINANCE}/ticker/price?symbol=${binanceSymbol}`);
      r.price = parseFloat(d.price);
    } catch (e) { log(`⚠️  ${symbol} spot price fetch failed: ${e.message}`); }
  }
  if (now - r.lastCandleFetch >= BTC_CANDLE_REFRESH_MS) {
    r.lastCandleFetch = now;
    try {
      const [c15, c1h] = await Promise.all([
        fetchClosedCandleClose(binanceSymbol, '15m'),
        fetchClosedCandleClose(binanceSymbol, '1h'),
      ]);
      if (c15 != null) r.close15 = c15;
      if (c1h != null) r.close1h = c1h;
    } catch (e) { log(`⚠️  ${symbol} candle fetch failed: ${e.message}`); }
  }
}

// Majority vote (2-of-3) across window-open, 15m close, 1h close.
function computeSignal(symbol, windowOpenPrice) {
  const r = ensureRefs(symbol);
  if (r.price == null) return null;
  const refs = [windowOpenPrice, r.close15, r.close1h];
  let up = 0, down = 0, total = 0;
  for (const ref of refs) {
    if (ref == null) continue;
    total++;
    if (r.price > ref) up++;
    else if (r.price < ref) down++;
  }
  if (up >= 2 && up > down) return { side: 'Up', votes: up, total, spot: r.price };
  if (down >= 2 && down > up) return { side: 'Down', votes: down, total, spot: r.price };
  return null;
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshPairState(symbol) {
  return {
    symbol,
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    windowOpenPrice: null,       // BTC (or symbol) spot price recorded when this window loaded
    checkpointDone: false,
    entry: null,                 // at most one entry per window now — see attemptEntry
    martingaleLoss: 0,           // outstanding loss to recover — persists ACROSS windows until a win clears it
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
  for (const sym of pairList) pairs[sym] = freshPairState(sym);
  totalEquityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];
}
resetPairs();

// ─────────────────────────────────────────
//  Slug / window math (unchanged market-discovery plumbing)
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

  await refreshCryptoRef(p.symbol); // make sure we have a fresh spot price to record as this window's open
  const r = ensureRefs(p.symbol);

  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.slug = slug;
  p.eventTitle = event.title || event.slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;
  p.resolvedThisWindow = false;
  p.windowOpenPrice = r.price;
  p.checkpointDone = false;
  p.entry = null; // martingaleLoss is intentionally NOT reset here — it persists across windows until a win clears it
  log(`🔭 ${p.symbol} window loaded: ${slug} | open=${r.price ?? '?'} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z${p.martingaleLoss > 0 ? ` | recovering $${p.martingaleLoss.toFixed(2)}` : ''}`);
}

// ─────────────────────────────────────────
//  Polymarket price feed (unchanged plumbing)
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
      } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function entryMarkValue(p) {
  const e = p.entry;
  if (!e || e.closed) return 0;
  const bid = e.side === 'Up' ? p.upBid : p.downBid;
  return round2(e.shares * (bid ?? e.entryPrice));
}
function pairMarkValue(p) {
  return round2(p.bankroll + entryMarkValue(p));
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
//  Entry: single checkpoint, martingale-sized
// ─────────────────────────────────────────
async function attemptEntry(p, signal) {
  const tokenId = signal.side === 'Up' ? p.upTokenId : p.downTokenId;
  const ask = signal.side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) { log(`⏭️  ${p.symbol} checkpoint: no ${signal.side} ask available, skipping`); return; }

  let dollars, recovering = false;
  if (p.martingaleLoss > 0) {
    recovering = true;
    const denom = round2(1 - ask);
    if (denom <= 0.01) {
      // Ask is essentially 1.00 — no meaningful payout per share left to recover with, skip rather
      // than divide by near-zero and demand an absurd stake.
      log(`⏭️  ${p.symbol} checkpoint: recovering $${p.martingaleLoss.toFixed(2)} but ${signal.side} ask=${ask.toFixed(2)} leaves almost no payout room, skipping`);
      return;
    }
    const sharesNeeded = p.martingaleLoss / denom;
    dollars = round2(sharesNeeded * ask);
  } else {
    dollars = round2(p.bankroll * BASE_SIZE_PCT);
  }

  const shares = Math.max(round2(dollars / ask), MIN_SHARES);
  const notional = round2(ask * shares);
  const fee = takerFee(shares, ask); // deliberate marketable buy — timing matters more than price here
  const totalCost = round2(notional + fee);
  if (totalCost > p.bankroll) {
    log(`⏭️  ${p.symbol} checkpoint: skip entry — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${totalCost.toFixed(2)})`);
    return;
  }

  p.bankroll = round2(p.bankroll - totalCost);
  p.realizedPnl = round2(p.realizedPnl - fee);
  p.feesPaid = round2(p.feesPaid + fee);
  await placeMarketableBuy(tokenId, ask, shares);
  const tpOrder = await placeLimitSell(tokenId, TP_PRICE, shares); // resting — waits for near-certainty, doesn't chase it

  const entry = {
    side: signal.side, entryPrice: ask, shares, cost: totalCost,
    votes: signal.votes, total: signal.total, spot: signal.spot, recovering,
    tpPrice: TP_PRICE, tpOrderId: tpOrder.id || tpOrder.orderId || null, closed: false, openedAt: Date.now(),
  };
  p.entry = entry;
  recordEquity(p);
  const tag = recovering ? ` [RECOVERY of $${p.martingaleLoss.toFixed(2)}]` : '';
  log(`🎯 ${p.symbol} checkpoint ${signal.side} entry ${shares.toFixed(2)}sh @ ${ask.toFixed(2)} (signal ${signal.votes}/${signal.total}, spot=${signal.spot})${tag} | cost=$${totalCost.toFixed(2)} | fee=-$${fee.toFixed(4)} | TP @ ${TP_PRICE}`);
  registerTrade(p, { side: 'BUY', outcome: signal.side, price: ask, shares, cost: totalCost, fee, votes: signal.votes, total: signal.total, recovering });
}

async function maybeEnter(p) {
  const elapsed = nowSec() - p.windowStart;
  if (p.checkpointDone || elapsed < CHECKPOINT_SECS) return;
  p.checkpointDone = true;
  const signal = computeSignal(p.symbol, p.windowOpenPrice);
  if (signal) await attemptEntry(p, signal);
  else log(`${p.symbol} checkpoint: no majority signal, skipping${p.martingaleLoss > 0 ? ` (still carrying $${p.martingaleLoss.toFixed(2)} to recover)` : ''}`);
}

// Checks whether the entry's resting TP (0.99) has been hit. No stop-loss —
// if TP is never reached, the position simply rides to real resolution. A
// win clears the martingale recovery target; only resolution losses (see
// resolvePairWindow) add to it, since TP is by definition always a win.
async function processEntry(p) {
  const entry = p.entry;
  if (!entry || entry.closed) return;
  const bid = entry.side === 'Up' ? p.upBid : p.downBid;
  if (bid == null || bid < entry.tpPrice) return;

  const proceeds = round2(entry.tpPrice * entry.shares);
  const rebate = makerRebate(entry.shares, entry.tpPrice);
  const net = round2(proceeds + rebate);
  p.bankroll = round2(p.bankroll + net);
  const profit = round2(net - entry.cost);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);
  p.wins++;
  entry.closed = true;
  p.martingaleLoss = 0; // win — reset back to 1%-of-bankroll base next window
  log(`💰 ${p.symbol} ${entry.side} TP(${entry.tpPrice}) filled ${entry.shares.toFixed(2)}sh | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: entry.side, reason: 'TP', price: entry.tpPrice, shares: entry.shares, profit, rebate });
  entry.tpOrderId = null;
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
  } catch (_) {}
  if (p.upBid != null && p.downBid != null) return p.upBid >= p.downBid ? 'Up' : 'Down';
  return null;
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  const entry = p.entry;
  if (entry && !entry.closed) {
    const winner = await determineWinningSide(p);
    await cancelOrder(entry.tpOrderId);
    const won = winner === entry.side;
    const proceeds = won ? round2(entry.shares * 1) : 0;
    const profit = round2(proceeds - entry.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (won) {
      p.wins++;
      p.martingaleLoss = 0; // win — reset back to 1%-of-bankroll base next window
    } else {
      p.losses++;
      p.martingaleLoss = round2(p.martingaleLoss + entry.cost); // loss — grow the recovery target for next window
    }
    entry.closed = true;
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} ${entry.side} RESOLUTION ${entry.shares}sh entry=${entry.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}${!won ? ` | now recovering $${p.martingaleLoss.toFixed(2)}` : ''}`);
    registerTrade(p, { side: 'SELL', outcome: entry.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: entry.shares, profit });
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
  if (!p.tradable || !tradingEnabled) return;

  const elapsed = nowSec() - p.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
  if (p.resolvedThisWindow) return;

  await refreshCryptoRef(p.symbol);
  await maybeEnter(p);
  try { await processEntry(p); }
  catch (e) { log(`⚠️  ${p.symbol} entry error: ${e.message}`); }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(entryMarkValue(p) - (p.entry && !p.entry.closed ? p.entry.cost : 0));
    const markValue = pairMarkValue(p);
    const r = ensureRefs(p.symbol);
    return {
      symbol: p.symbol, tradable: p.tradable, slug: p.slug, windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      windowOpenPrice: p.windowOpenPrice, spotPrice: r.price, close15: r.close15, close1h: r.close1h,
      checkpointDone: p.checkpointDone, martingaleLoss: p.martingaleLoss,
      bankroll: p.bankroll, realizedPnl: p.realizedPnl, unrealizedPnl: unrealized, markValue,
      feesPaid: p.feesPaid, rebatesEarned: p.rebatesEarned, wins: p.wins, losses: p.losses,
      entry: p.entry ? {
        side: p.entry.side, entryPrice: p.entry.entryPrice, shares: p.entry.shares,
        cost: p.entry.cost, votes: p.entry.votes, total: p.entry.total, tpPrice: p.entry.tpPrice,
        closed: p.entry.closed, recovering: p.entry.recovering,
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
    dryRun: DRY_RUN, tradingEnabled, pairs: pairList,
    totalCapital: TOTAL_CAPITAL, perPairCapital, totalBankroll, totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized, totalUnrealizedPnl: totalUnrealized, totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid: round2(pairStates.reduce((s, p) => s + p.feesPaid, 0)),
    totalRebatesEarned: round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0)),
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      checkpointSecs: CHECKPOINT_SECS, baseSizePct: BASE_SIZE_PCT, tpPrice: TP_PRICE,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE, cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates, totalEquityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshPolyPrices(); }
      for (const p of Object.values(pairs)) { try { await processPair(p); } catch (e) { log(`⚠️  ${p.symbol} tick error: ${e.message}`); } }
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(list) {
  const clean = (list || []).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!clean.length) return { ok: false, error: 'Empty pair list' };
  pairList = [...new Set(clean)];
  resetPairs();
  log(`⚙️  Pairs updated: ${pairList.join(', ')} | $${perPairCapital.toFixed(2)} per pair`);
  return { ok: true, pairs: pairList, perPairCapital };
}
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (open positions still managed for TP/resolution)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 BTC Signal + Martingale Recovery Bot (majority vote: window-open / 15m close / 1h close)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  one entry per window at +${CHECKPOINT_SECS}s | base size ${(BASE_SIZE_PCT*100).toFixed(0)}% of current bankroll | on a loss, next window's stake is sized to recover it at that window's entry price (NO CAP) | TP @ ${TP_PRICE} | no SL — rides to resolution`);
  log(`⚙️  fees: entries are marketable (taker); TP sells are resting (maker, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price/candle data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
