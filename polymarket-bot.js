'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — BREAKOUT PYRAMID BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  The grid-ladder strategy (buy both sides low, TP+0.10, re-compound)
 *  was not profitable and has been removed completely — no trace of it
 *  remains. This is a different strategy from scratch: no market-making,
 *  no both-sides trading. It picks ONE side per window and pyramids into
 *  it as it keeps confirming strength.
 *
 *  PER WINDOW:
 *    1. Wait until 2 minutes (120s) into the window. From then on, watch
 *       both Up and Down. The first side whose price trades above 0.60
 *       gets picked for the rest of that window (Up and Down can't both
 *       be above 0.60 at once, since they sum to ~1 — so this is a clean,
 *       unambiguous pick). Once picked, the bot commits to that side for
 *       the rest of the window; it does not re-evaluate or switch sides.
 *    2. That side has 4 fixed price levels: 0.60 / 0.70 / 0.80 / 0.90.
 *       Size doubles at each level: 50 / 100 / 200 / 400 shares.
 *    3. IMPORTANT EXECUTION DETAIL: Polymarket has no native "buy stop"
 *       order (confirmed earlier in this project — it has no stop orders
 *       at all). "Buy more as price rises through each level" can only be
 *       done by actively watching price every tick and firing an
 *       aggressive/marketable (taker) buy the instant a level is crossed
 *       — a resting limit buy placed above the current price would just
 *       cross the spread and fill immediately at today's price, not wait
 *       for that level to actually be reached. So all 4 entries here are
 *       taker fills, priced at whatever the live ask is the moment the
 *       threshold is crossed (which can be past the nominal level if
 *       price gapped, e.g. a jump straight from 0.58 to 0.85 fires every
 *       level it passed on the same tick, each at that same live price —
 *       an honest consequence of tick-based polling, not a bug).
 *       Levels only fire in order — level N only arms once level N-1 has
 *       filled.
 *    4. Every filled level gets its own fixed SL (0.40) and fixed TP
 *       (0.99), independent of its entry price:
 *         - SL is also a taker order (same reason — no native stop),
 *           fired the instant the bid drops to/through 0.40. Same
 *           EXIT_SAFETY_BUFFER guard as before: no SL selling in the
 *           final seconds of the window, a forced sale into a thinning
 *           book that close to resolution is worse than just letting it
 *           resolve.
 *         - TP is a genuine resting (maker) limit sell at 0.99 — fee free
 *           plus rebate, since it's a passive order actually waiting to
 *           be hit.
 *         - Anything neither TP'd nor SL'd by window close rides to the
 *           real resolution result, exactly as before.
 *    5. One default I added that wasn't specified: no NEW level fires (or
 *       resting TP orders placed) inside the final ENTRY_CUTOFF_REMAINING
 *       seconds of the window, mirroring the same reasoning as the SL
 *       exit-safety buffer — an entry with no runway left to manage isn't
 *       worth taking. Flagged here since it's my addition, not yours;
 *       remove by setting ENTRY_CUTOFF_REMAINING_SEC to 0 if unwanted.
 *
 *  FEES: Polymarket Fee Structure V2 (crypto: taker fee = shares × 0.07 ×
 *  price × (1-price), maker rebate = that × 20%). All 4 entries and every
 *  SL here are taker (pay the fee); TP is maker (fee-free + rebate);
 *  resolution settlement is always fee-free.
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

// ── Breakout pyramid parameters ──
const SIDE_PICK_ELAPSED_SEC = Number(process.env.SIDE_PICK_ELAPSED_SEC || 120); // wait this long into the window before watching for a side to pick
const SIDE_PICK_THRESHOLD   = Number(process.env.SIDE_PICK_THRESHOLD || 0.60); // side is picked once its price trades above this
const LEVEL_PRICES  = (process.env.LEVEL_PRICES ? process.env.LEVEL_PRICES.split(',').map(Number) : [0.60, 0.70, 0.80, 0.90]);
const LEVEL_BASE_SHARES = Number(process.env.LEVEL_BASE_SHARES || 50); // doubles at every level: 50/100/200/400
const FIXED_SL_PRICE = Number(process.env.FIXED_SL_PRICE || 0.40);
const FIXED_TP_PRICE = Number(process.env.FIXED_TP_PRICE || 0.99);
const EXIT_SAFETY_BUFFER_SEC = Number(process.env.EXIT_SAFETY_BUFFER_SEC || 15); // no SL selling this close to window close
const ENTRY_CUTOFF_REMAINING_SEC = Number(process.env.ENTRY_CUTOFF_REMAINING_SEC || 15); // no NEW level fires this close to window close (added default, see header)
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
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-breakout-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-breakout-bot/1.0' },
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
//  Pair / level state
// ─────────────────────────────────────────
function freshLevel(index, triggerPrice) {
  return {
    index,                                   // 0-3
    triggerPrice,                            // 0.60 / 0.70 / 0.80 / 0.90
    shares: LEVEL_BASE_SHARES * Math.pow(2, index), // 50 / 100 / 200 / 400
    filled: false,
    position: null,       // { entryPrice, shares, cost, tpOrderId, openedAt }
    tpRestingOrderId: null,
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
    pickedSide: null,     // null | 'Up' | 'Down' — locked for the rest of the window once set
    levels: LEVEL_PRICES.map((p, i) => freshLevel(i, p)),
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
  p.pickedSide = null;
  p.levels = LEVEL_PRICES.map((pr, i) => freshLevel(i, pr));
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
function pairAskBid(p) {
  return p.pickedSide === 'Up' ? { ask: p.upAsk, bid: p.upBid } : { ask: p.downAsk, bid: p.downBid };
}
function levelMarkValue(p, level) {
  if (!level.position) return 0;
  const { bid } = pairAskBid(p);
  const price = bid ?? level.position.entryPrice;
  return round2(level.position.shares * price);
}
function pairMarkValue(p) {
  const held = p.levels.reduce((s, l) => s + levelMarkValue(p, l), 0);
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
//  Side selection
// ─────────────────────────────────────────
function maybePickSide(p, elapsed, remaining) {
  if (p.pickedSide || elapsed < SIDE_PICK_ELAPSED_SEC || remaining < ENTRY_CUTOFF_REMAINING_SEC) return;
  if (p.upAsk != null && p.upAsk > SIDE_PICK_THRESHOLD) {
    p.pickedSide = 'Up';
  } else if (p.downAsk != null && p.downAsk > SIDE_PICK_THRESHOLD) {
    p.pickedSide = 'Down';
  }
  if (p.pickedSide) {
    log(`🎯 ${p.symbol} picked ${p.pickedSide} (${(p.pickedSide === 'Up' ? p.upAsk : p.downAsk).toFixed(2)} > ${SIDE_PICK_THRESHOLD}) — arming 4-level pyramid`);
  }
}

// ─────────────────────────────────────────
//  Level entries — taker fills, fired reactively as price crosses each level
// ─────────────────────────────────────────
async function fireLevelEntry(p, level, execPrice) {
  const tokenId = p.pickedSide === 'Up' ? p.upTokenId : p.downTokenId;
  const cost = round2(execPrice * level.shares);
  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol} level${level.index} (${level.triggerPrice}): skip — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)})`);
    return;
  }
  const order = await placeLimitBuy(tokenId, execPrice, level.shares); // marketable/taker — see header note
  const fee = takerFee(level.shares, execPrice);
  p.bankroll = round2(p.bankroll - cost - fee);
  p.feesPaid = round2(p.feesPaid + fee);
  p.realizedPnl = round2(p.realizedPnl - fee); // fee is a realized cost the instant it's paid

  level.filled = true;
  level.position = { entryPrice: execPrice, shares: level.shares, cost, openedAt: Date.now() };
  recordEquity(p);
  log(`🎯 ${p.symbol} level${level.index} (trigger ${level.triggerPrice}) BUY ${level.shares}sh @ ${execPrice.toFixed(2)} | cost=$${cost.toFixed(2)} fee=-$${fee.toFixed(4)}`);
  registerTrade(p, { level: level.index, side: 'BUY', outcome: p.pickedSide, price: execPrice, shares: level.shares, cost, fee });

  // Rest a TP sell at the fixed target immediately.
  const tpOrder = await placeLimitSell(tokenId, FIXED_TP_PRICE, level.shares);
  level.tpRestingOrderId = tpOrder.id || tpOrder.orderId || null;
}

async function processLevels(p, remaining) {
  if (!p.pickedSide) return;
  const ask = p.pickedSide === 'Up' ? p.upAsk : p.downAsk;
  const bid = p.pickedSide === 'Up' ? p.upBid : p.downBid;

  // Fire levels in order — level N only arms once level N-1 has filled.
  // Cascades within the same tick if price gapped past multiple levels.
  if (ask != null && remaining >= ENTRY_CUTOFF_REMAINING_SEC) {
    for (const level of p.levels) {
      if (level.filled) continue;
      if (level.index > 0 && !p.levels[level.index - 1].filled) break; // must fill in order
      if (ask >= level.triggerPrice) {
        await fireLevelEntry(p, level, ask);
      } else {
        break; // this level (and anything above it) hasn't triggered yet
      }
    }
  }

  // Manage every filled level's SL / TP independently.
  if (bid == null) return;
  const tokenId = p.pickedSide === 'Up' ? p.upTokenId : p.downTokenId;
  for (const level of p.levels) {
    if (!level.filled || !level.position) continue;
    const pos = level.position;

    if (bid >= FIXED_TP_PRICE) {
      // Maker fill — our resting sell at FIXED_TP_PRICE actually got hit.
      const proceeds = round2(FIXED_TP_PRICE * pos.shares);
      const rebate = makerRebate(pos.shares, FIXED_TP_PRICE);
      const net = round2(proceeds + rebate);
      p.bankroll = round2(p.bankroll + net);
      const profit = round2(net - pos.cost);
      p.realizedPnl = round2(p.realizedPnl + profit);
      p.rebatesEarned = round2(p.rebatesEarned + rebate);
      p.wins++;
      log(`💰 ${p.symbol} level${level.index} TP filled ${pos.shares}sh @ ${FIXED_TP_PRICE} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { level: level.index, side: 'SELL', outcome: p.pickedSide, reason: 'TP', price: FIXED_TP_PRICE, shares: pos.shares, profit, rebate });
      level.position = null;
      level.tpRestingOrderId = null;
      recordEquity(p);
      continue;
    }

    if (bid <= FIXED_SL_PRICE && remaining > EXIT_SAFETY_BUFFER_SEC) {
      await cancelOrder(level.tpRestingOrderId); // pull the resting TP first
      const order = await placeLimitSell(tokenId, bid, pos.shares); // taker — see header note
      const fee = takerFee(pos.shares, bid);
      const proceeds = round2(bid * pos.shares);
      const net = round2(proceeds - fee);
      p.bankroll = round2(p.bankroll + net);
      const profit = round2(net - pos.cost);
      p.realizedPnl = round2(p.realizedPnl + profit);
      p.feesPaid = round2(p.feesPaid + fee);
      p.losses++;
      log(`💥 ${p.symbol} level${level.index} SL filled ${pos.shares}sh @ ${bid.toFixed(2)} | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { level: level.index, side: 'SELL', outcome: p.pickedSide, reason: 'SL', price: bid, shares: pos.shares, profit, fee });
      level.position = null;
      level.tpRestingOrderId = null;
      recordEquity(p);
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

  const openLevels = p.levels.filter(l => l.position);
  if (!openLevels.length) return;

  const winner = await determineWinningSide(p);
  for (const level of openLevels) {
    await cancelOrder(level.tpRestingOrderId);
    const pos = level.position;
    const won = winner === p.pickedSide;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (won) p.wins++; else p.losses++;
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} level${level.index} RESOLUTION ${p.pickedSide} ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { level: level.index, side: 'SELL', outcome: p.pickedSide, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
    level.position = null;
    level.tpRestingOrderId = null;
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

  const elapsed = nowSec() - p.windowStart;
  const remaining = p.windowEnd - nowSec();

  if (tradingEnabled) {
    maybePickSide(p, elapsed, remaining);
    await processLevels(p, remaining);
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
    const unrealized = round2(p.levels.reduce((s, l) => s + (l.position ? levelMarkValue(p, l) - l.position.cost : 0), 0));
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
      levels: p.levels.map(l => ({
        index: l.index,
        triggerPrice: l.triggerPrice,
        shares: l.shares,
        filled: l.filled,
        position: l.position ? { entryPrice: l.position.entryPrice, shares: l.position.shares, cost: l.position.cost } : null,
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
      sidePickThreshold: SIDE_PICK_THRESHOLD,
      levelPrices: LEVEL_PRICES,
      levelBaseShares: LEVEL_BASE_SHARES,
      fixedSlPrice: FIXED_SL_PRICE,
      fixedTpPrice: FIXED_TP_PRICE,
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
  log('⏸️  Trading paused (open positions still managed for SL/TP/resolution)');
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
  log(`🚀 5-Minute Crypto Up/Down — Breakout Pyramid Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  pick side >${SIDE_PICK_THRESHOLD} after ${SIDE_PICK_ELAPSED_SEC}s | levels ${LEVEL_PRICES.join('/')} @ shares ${LEVEL_PRICES.map((_,i)=>LEVEL_BASE_SHARES*Math.pow(2,i)).join('/')} | SL@${FIXED_SL_PRICE} TP@${FIXED_TP_PRICE}`);
  log(`⚙️  fees: entries+SL taker (crypto rate ${CRYPTO_TAKER_FEE_RATE}) | TP maker (0 fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
