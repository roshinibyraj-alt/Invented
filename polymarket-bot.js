'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — BTC PRICE-ACTION SIGNAL BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  This throws out the whole grid/ladder approach. It no longer watches the
 *  Polymarket Up/Down token's own price at all for its trading DECISION —
 *  it only uses the token's ask/bid to know what price it would actually pay
 *  to enter, and to check whether the resting take-profit order has been hit.
 *  The actual direction call comes entirely from real BTC (or other crypto)
 *  spot price action, fetched from Binance.
 *
 *  SIGNAL (majority vote, 2-of-3 required):
 *    Three reference points are compared against the current spot price:
 *      1. This window's own open price (the actual settlement reference —
 *         Up wins if spot is above this at window close, Down if below).
 *      2. The close of the most recently CLOSED 15-minute candle.
 *      3. The close of the most recently CLOSED 1-hour candle.
 *    Spot above a reference = an "Up" vote, below = a "Down" vote. 2 or 3
 *    votes agreeing = a valid signal. A 1-1 split (or all references still
 *    loading) = no trade.
 *
 *  ENTRIES (two checkpoints per window):
 *    - Checkpoint 1, shortly after the window opens: if a signal is valid,
 *      open position 1 in that direction.
 *    - Checkpoint 2, mid-window: check the signal again. If checkpoint 1
 *      already holds a position and the signal still agrees, add position 2
 *      (pyramiding conviction — the same call reconfirmed by more data by
 *      this point in the window). If the signal has flipped, position 2 is
 *      skipped rather than opening something that fights position 1. If
 *      checkpoint 1 had no signal, checkpoint 2 can still be the first
 *      (and only) entry.
 *
 *  EXECUTION — aggressive limit, escalating to market (NEW):
 *    A checkpoint firing no longer places one marketable buy. Instead:
 *      1. Quote a genuine (non-crossing) limit buy just inside the current
 *         ask — as aggressive as possible while still resting, so it has
 *         the best realistic chance of a passive/maker fill.
 *      2. Wait up to 2 seconds. If the ask comes down to meet that quote,
 *         it's filled — at the maker rebate, not the taker fee.
 *      3. If not filled after 2s, cancel and re-quote at a fresh aggressive
 *         price against the current market. Repeat up to 5 total attempts
 *         (~10 seconds).
 *      4. If the 5th attempt still hasn't filled, give up on saving the fee
 *         and place a genuine marketable buy at the current ask — a
 *         guaranteed fill, paying the taker fee, because getting the
 *         position on is more important than the fee at that point.
 *    This trades a small, bounded timing delay (at most ~10s) for a real
 *    chance of avoiding the taker fee on each entry, while still guaranteeing
 *    the position is eventually taken.
 *
 *  SIZING (scales with signal strength):
 *    - 2-of-3 agreement → base size.
 *    - 3-of-3 agreement → larger size (roughly 2x base).
 *    Each entry is sized independently using the strength observed AT THAT
 *    checkpoint, so position 2 can be a different size than position 1.
 *
 *  EXIT: no stop-loss. Each entry gets a resting take-profit limit sell at
 *    0.99 — if the market is already near-certain of the outcome before the
 *    window ends, lock in the win rather than wait out settlement/oracle
 *    latency. If 0.99 is never reached, the position simply rides to actual
 *    window resolution: wins pay $1/share, losses pay $0.
 *
 *  FEES: entries now try to be maker (passive/aggressive-limit) first, and
 *    only fall back to taker if 5 requote attempts fail to fill. The TP
 *    sell is always a genuine resting maker order.
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
const CHECKPOINT_1_SECS = Number(process.env.CHECKPOINT_1_SECS || 15);  // seconds after window open
const CHECKPOINT_2_SECS = Number(process.env.CHECKPOINT_2_SECS || 150); // seconds after window open (mid-window)
const SHARES_BASE   = Number(process.env.SHARES_BASE || 100);   // fixed share count, 2-of-3 agreement — cost varies with price, not the other way round
const SHARES_STRONG = Number(process.env.SHARES_STRONG || 200); // fixed share count, 3-of-3 agreement
const TP_PRICE    = Number(process.env.TP_PRICE || 0.99);
const MIN_SHARES  = Number(process.env.MIN_SHARES || 5);
// Aggressive-limit-then-escalate execution: quote just inside the ask, wait,
// re-quote against the moving market, and only cross the spread for real
// (market fill) if every attempt fails to fill passively.
const REQUOTE_INTERVAL_MS = Number(process.env.REQUOTE_INTERVAL_MS || 2000);
const MAX_QUOTE_ATTEMPTS  = Number(process.env.MAX_QUOTE_ATTEMPTS || 5);
const AGGRESSIVE_TICK     = Number(process.env.AGGRESSIVE_TICK || 0.01); // how close to the ask we quote without crossing it

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

// A marketable buy — priced at the current ask so it fills now. Used only
// as the final escalation after passive requoting has failed 5 times.
async function placeMarketableBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
// A genuine resting (passive/maker) limit buy — the same underlying call,
// just priced below the current ask so it doesn't cross the spread. Used
// for the aggressive-quote attempts; it may or may not fill.
async function placeLimitBuy(tokenId, price, shares) {
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
// Fixed SHARE count by signal strength — cost follows from whatever the
// current ask is, rather than sizing to a target dollar amount.
function sharesForSignal(signal) {
  return signal.votes >= 3 ? SHARES_STRONG : SHARES_BASE;
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
    checkpoint1Done: false, checkpoint2Done: false,
    entries: [],                // up to 2 per window — see finalizeEntry
    pendingEntries: [],         // in-flight aggressive-quote attempts — see startEntryAttempt/processPendingEntries
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
  p.checkpoint1Done = false;
  p.checkpoint2Done = false;
  p.entries = [];
  p.pendingEntries = [];
  log(`🔭 ${p.symbol} window loaded: ${slug} | open=${r.price ?? '?'} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z`);
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
function entryMarkValue(p, entry) {
  if (entry.closed) return 0;
  const bid = entry.side === 'Up' ? p.upBid : p.downBid;
  return round2(entry.shares * (bid ?? entry.entryPrice));
}
function pairMarkValue(p) {
  const held = p.entries.reduce((s, e) => s + entryMarkValue(p, e), 0);
  return round2(p.bankroll + held);
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
//  Entries: checkpoint-driven, signal-based, aggressive-limit → escalate
// ─────────────────────────────────────────

// Quotes as close to the current ask as possible without crossing it — the
// most aggressive price that's still a genuine passive/maker order.
function computeAggressivePrice(ask, bid) {
  const floor = bid != null ? bid : 0.01;
  return round2(Math.max(floor, round2(ask - AGGRESSIVE_TICK)));
}

// Kicks off an entry attempt: places the first aggressive resting quote.
// The rest of the attempt (checking for a fill, re-quoting, escalating to a
// market order) happens in processPendingEntries on later ticks.
async function startEntryAttempt(p, checkpointNum, signal) {
  const tokenId = signal.side === 'Up' ? p.upTokenId : p.downTokenId;
  const ask = signal.side === 'Up' ? p.upAsk : p.downAsk;
  const bid = signal.side === 'Up' ? p.upBid : p.downBid;
  if (ask == null) { log(`⏭️  ${p.symbol} checkpoint${checkpointNum}: no ${signal.side} ask available, skipping`); return; }

  const shares = Math.max(sharesForSignal(signal), MIN_SHARES); // fixed share count — cost follows from price, not the reverse
  const quotePrice = computeAggressivePrice(ask, bid);
  const order = await placeLimitBuy(tokenId, quotePrice, shares);
  p.pendingEntries.push({
    checkpointNum, side: signal.side, shares, votes: signal.votes, total: signal.total, spot: signal.spot,
    attempt: 1, quotePrice, orderId: order.id || order.orderId || null, quotedAt: Date.now(),
  });
  log(`📌 ${p.symbol} checkpoint${checkpointNum} ${signal.side} quote #1 ${shares.toFixed(2)}sh @ ${quotePrice.toFixed(2)} (ask=${ask.toFixed(2)}, signal ${signal.votes}/${signal.total}) — resting, will re-quote every ${(REQUOTE_INTERVAL_MS/1000).toFixed(0)}s`);
}

// Turns a filled quote (or an escalated market fill) into a real open
// position: deducts cost, applies fee or rebate depending on how it filled,
// places the resting TP sell, and records the trade.
async function finalizeEntry(p, pe, fillPrice, isMaker) {
  const tokenId = pe.side === 'Up' ? p.upTokenId : p.downTokenId;
  const notional = round2(fillPrice * pe.shares);
  let totalCost, fee = 0, rebate = 0;
  if (isMaker) {
    rebate = makerRebate(pe.shares, fillPrice);
    totalCost = round2(notional - rebate);
  } else {
    fee = takerFee(pe.shares, fillPrice);
    totalCost = round2(notional + fee);
  }
  if (totalCost > p.bankroll) {
    log(`⏭️  ${p.symbol} checkpoint${pe.checkpointNum}: skip entry — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${totalCost.toFixed(2)})`);
    return;
  }

  p.bankroll = round2(p.bankroll - totalCost);
  if (isMaker) { p.realizedPnl = round2(p.realizedPnl + rebate); p.rebatesEarned = round2(p.rebatesEarned + rebate); }
  else { p.realizedPnl = round2(p.realizedPnl - fee); p.feesPaid = round2(p.feesPaid + fee); }

  const tpOrder = await placeLimitSell(tokenId, TP_PRICE, pe.shares); // resting — waits for near-certainty, doesn't chase it
  const entry = {
    checkpoint: pe.checkpointNum, side: pe.side, entryPrice: fillPrice, shares: pe.shares, cost: totalCost,
    votes: pe.votes, total: pe.total, spot: pe.spot, filledVia: isMaker ? 'passive' : 'market', attempts: pe.attempt,
    tpPrice: TP_PRICE, tpOrderId: tpOrder.id || tpOrder.orderId || null, closed: false, openedAt: Date.now(),
  };
  p.entries.push(entry);
  recordEquity(p);
  const feeTag = isMaker ? `rebate=+$${rebate.toFixed(4)}` : `fee=-$${fee.toFixed(4)}`;
  const viaTag = isMaker ? `passive fill (attempt ${pe.attempt})` : `ESCALATED TO MARKET after ${pe.attempt} failed quotes`;
  log(`🎯 ${p.symbol} checkpoint${pe.checkpointNum} ${pe.side} entry ${pe.shares.toFixed(2)}sh @ ${fillPrice.toFixed(2)} — ${viaTag} | cost=$${totalCost.toFixed(2)} | ${feeTag} | TP @ ${TP_PRICE}`);
  registerTrade(p, { side: 'BUY', outcome: pe.side, checkpoint: pe.checkpointNum, price: fillPrice, shares: pe.shares, cost: totalCost, fee, rebate, votes: pe.votes, total: pe.total, filledVia: entry.filledVia });
}

// Drives every in-flight quote forward: checks for a passive fill, and on
// the 2-second mark either re-quotes (attempts 1-4) or escalates to a
// guaranteed market fill (after attempt 5 fails).
async function processPendingEntries(p) {
  if (!p.pendingEntries.length) return;
  const stillPending = [];
  for (const pe of p.pendingEntries) {
    const ask = pe.side === 'Up' ? p.upAsk : p.downAsk;
    const bid = pe.side === 'Up' ? p.upBid : p.downBid;

    // A passive fill: the ask has come down to (or through) our resting quote.
    if (ask != null && ask <= pe.quotePrice) {
      await finalizeEntry(p, pe, pe.quotePrice, true);
      continue;
    }

    const waited = Date.now() - pe.quotedAt;
    if (waited < REQUOTE_INTERVAL_MS) { stillPending.push(pe); continue; }

    // 2 seconds passed with no fill — cancel this quote first.
    await cancelOrder(pe.orderId);

    if (pe.attempt >= MAX_QUOTE_ATTEMPTS) {
      if (ask == null) {
        log(`⏭️  ${p.symbol} checkpoint${pe.checkpointNum}: ${pe.side} exhausted ${MAX_QUOTE_ATTEMPTS} quote attempts and no ask is available to escalate to market — dropping this entry`);
        continue;
      }
      await finalizeEntry(p, pe, ask, false); // guaranteed fill — timing wins over fee now
      continue;
    }

    if (ask == null) { pe.quotedAt = Date.now(); stillPending.push(pe); continue; } // nothing to requote against yet, just keep waiting

    const tokenId = pe.side === 'Up' ? p.upTokenId : p.downTokenId;
    const newPrice = computeAggressivePrice(ask, bid);
    const order = await placeLimitBuy(tokenId, newPrice, pe.shares);
    pe.attempt += 1;
    pe.quotePrice = newPrice;
    pe.orderId = order.id || order.orderId || null;
    pe.quotedAt = Date.now();
    log(`🔁 ${p.symbol} checkpoint${pe.checkpointNum} ${pe.side} quote #${pe.attempt} ${pe.shares.toFixed(2)}sh @ ${newPrice.toFixed(2)} (ask=${ask.toFixed(2)}) — no fill yet, re-quoting`);
    stillPending.push(pe);
  }
  p.pendingEntries = stillPending;
}

async function maybeEnterAtCheckpoints(p) {
  const elapsed = nowSec() - p.windowStart;

  if (!p.checkpoint1Done && elapsed >= CHECKPOINT_1_SECS) {
    p.checkpoint1Done = true;
    const signal = computeSignal(p.symbol, p.windowOpenPrice);
    if (signal) await startEntryAttempt(p, 1, signal);
    else log(`${p.symbol} checkpoint1: no majority signal, skipping`);
  }

  if (!p.checkpoint2Done && elapsed >= CHECKPOINT_2_SECS) {
    p.checkpoint2Done = true;
    const signal = computeSignal(p.symbol, p.windowOpenPrice);
    const existing = p.entries.find(e => e.checkpoint === 1) || p.pendingEntries.find(pe => pe.checkpointNum === 1);
    if (!signal) {
      log(`${p.symbol} checkpoint2: no majority signal, skipping`);
    } else if (existing && existing.side !== signal.side) {
      log(`${p.symbol} checkpoint2: signal flipped to ${signal.side} (holding/quoting ${existing.side} from checkpoint1) — skipping to avoid conflicting positions`);
    } else {
      await startEntryAttempt(p, 2, signal);
    }
  }
}

// Checks whether an entry's resting TP (0.99) has been hit. No stop-loss —
// if TP is never reached, the position simply rides to real resolution.
async function processEntry(p, entry) {
  if (entry.closed) return;
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
  log(`💰 ${p.symbol} checkpoint${entry.checkpoint} ${entry.side} TP(${entry.tpPrice}) filled ${entry.shares.toFixed(2)}sh | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: entry.side, checkpoint: entry.checkpoint, reason: 'TP', price: entry.tpPrice, shares: entry.shares, profit, rebate });
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

  // Safety net: any quote still in flight (shouldn't normally happen — worst
  // case is ~10s of attempts, far inside the window) never touched cash, so
  // just cancel it.
  for (const pe of p.pendingEntries) await cancelOrder(pe.orderId);
  p.pendingEntries = [];

  const hasOpenEntry = p.entries.some(e => !e.closed);
  let winner = null;
  if (hasOpenEntry) winner = await determineWinningSide(p);

  for (const entry of p.entries) {
    if (entry.closed) continue;
    await cancelOrder(entry.tpOrderId);
    const won = winner === entry.side;
    const proceeds = won ? round2(entry.shares * 1) : 0;
    const profit = round2(proceeds - entry.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (won) p.wins++; else p.losses++;
    entry.closed = true;
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} checkpoint${entry.checkpoint} ${entry.side} RESOLUTION ${entry.shares}sh entry=${entry.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: entry.side, checkpoint: entry.checkpoint, reason: 'RESOLUTION', price: won ? 1 : 0, shares: entry.shares, profit });
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
  await maybeEnterAtCheckpoints(p);
  await processPendingEntries(p);

  for (const entry of p.entries) {
    try { await processEntry(p, entry); }
    catch (e) { log(`⚠️  ${p.symbol} checkpoint${entry.checkpoint} entry error: ${e.message}`); }
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(p.entries.reduce((s, e) => s + (entryMarkValue(p, e) - (e.closed ? 0 : e.cost)), 0));
    const markValue = pairMarkValue(p);
    const r = ensureRefs(p.symbol);
    return {
      symbol: p.symbol, tradable: p.tradable, slug: p.slug, windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      windowOpenPrice: p.windowOpenPrice, spotPrice: r.price, close15: r.close15, close1h: r.close1h,
      checkpoint1Done: p.checkpoint1Done, checkpoint2Done: p.checkpoint2Done,
      bankroll: p.bankroll, realizedPnl: p.realizedPnl, unrealizedPnl: unrealized, markValue,
      feesPaid: p.feesPaid, rebatesEarned: p.rebatesEarned, wins: p.wins, losses: p.losses,
      entries: p.entries.map(e => ({
        checkpoint: e.checkpoint, side: e.side, entryPrice: e.entryPrice, shares: e.shares,
        cost: e.cost, votes: e.votes, total: e.total, tpPrice: e.tpPrice, closed: e.closed,
        filledVia: e.filledVia, attempts: e.attempts,
      })),
      pendingEntries: p.pendingEntries.map(pe => ({
        checkpoint: pe.checkpointNum, side: pe.side, shares: pe.shares, quotePrice: pe.quotePrice, attempt: pe.attempt,
      })),
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
      checkpoint1Secs: CHECKPOINT_1_SECS, checkpoint2Secs: CHECKPOINT_2_SECS,
      sharesBase: SHARES_BASE, sharesStrong: SHARES_STRONG, tpPrice: TP_PRICE,
      requoteIntervalMs: REQUOTE_INTERVAL_MS, maxQuoteAttempts: MAX_QUOTE_ATTEMPTS, aggressiveTick: AGGRESSIVE_TICK,
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
  log(`🚀 BTC Price-Action Signal Bot (majority vote: window-open / 15m close / 1h close)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  checkpoints: +${CHECKPOINT_1_SECS}s and +${CHECKPOINT_2_SECS}s into each window | size ${SHARES_BASE}sh (2-of-3) / ${SHARES_STRONG}sh (3-of-3) — fixed share count, cost follows the ask | TP @ ${TP_PRICE} | no SL — rides to resolution`);
  log(`⚙️  execution: quote aggressively ${AGGRESSIVE_TICK} inside the ask, re-quote every ${(REQUOTE_INTERVAL_MS/1000).toFixed(0)}s up to ${MAX_QUOTE_ATTEMPTS} attempts, then escalate to a guaranteed market fill`);
  log(`⚙️  fees: passive/re-quoted fills earn the maker rebate (+${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}%); only the final escalated fill (if all ${MAX_QUOTE_ATTEMPTS} quotes miss) pays the taker fee`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price/candle data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
