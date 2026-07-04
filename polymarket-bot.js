'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — CHASE/FADE SIGNAL RESEARCH BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  PURPOSE: this is a deliberate reverse-engineering experiment, not a
 *  strategy meant to be profitable as shipped. The baseline behavior
 *  (REVERSE_SIGNAL=false) is built around a specific, plausible bad habit
 *  — momentum-chasing — that we already have real evidence hurts on this
 *  project: when DOGE logs were analyzed earlier, entries sized at high
 *  confidence (chasing the biggest, most "confirmed" recent moves) won
 *  only 43% of the time, while low-confidence entries won 57%. Buying
 *  into a spike after it's already happened tends to buy near a local
 *  top right before a fixed-sum market (Up+Down ≈ 1) reverts.
 *
 *  BASELINE (REVERSE_SIGNAL=false) — "chase": detect whichever side's
 *  price just moved up the hardest over the last SPIKE_LOOKBACK_SECS
 *  seconds (a "spike"), then buy INTO that side — the expensive, already-
 *  moved one. Hypothesis: negative edge.
 *
 *  REVERSED (REVERSE_SIGNAL=true) — "fade": exact same spike detection,
 *  but buy the OPPOSITE side — the cheap one that didn't just move.
 *  Hypothesis: if the baseline's edge is real and negative, flipping the
 *  direction should flip the sign of the edge too.
 *
 *  Everything else is held constant between the two modes on purpose —
 *  same detection window/threshold, same symmetric TP/SL, same sizing —
 *  so direction is the only variable being tested. Run one mode for a
 *  session, flip REVERSE_SIGNAL, run again, and compare the logs.
 *
 *  One trade per window (whichever side spikes first), to keep the
 *  comparison clean rather than averaging multiple trades together.
 *
 *  FEES: entries are aggressive taker fills (chasing/fading a move that
 *  just happened means crossing the spread on purpose — waiting for a
 *  passive fill would defeat the point of reacting to a spike). TP is a
 *  genuine resting maker sell. SL is taker, same no-native-stop-order
 *  reasoning as every other version in this project. Resolution is
 *  always fee-free settlement.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const RESOLUTION_BUFFER_S   = 8;
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ── The experiment toggle ──
const REVERSE_SIGNAL = (process.env.REVERSE_SIGNAL || 'false').toLowerCase() === 'true';

// ── Spike detection (identical in both modes — only the trade direction differs) ──
const SPIKE_LOOKBACK_SECS = Number(process.env.SPIKE_LOOKBACK_SECS || 20);
const SPIKE_THRESHOLD     = Number(process.env.SPIKE_THRESHOLD || 0.05);
const TP_OFFSET = Number(process.env.TP_OFFSET || 0.10);
const SL_OFFSET = Number(process.env.SL_OFFSET || 0.10);
const EXIT_SAFETY_BUFFER_SEC = Number(process.env.EXIT_SAFETY_BUFFER_SEC || 15);
const TRADE_SHARES = Number(process.env.TRADE_SHARES || 20); // flat size — deliberately not compounding, keeps the two modes directly comparable
const MIN_SHARES = Number(process.env.MIN_SHARES || 5);

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

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-chasefade-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-chasefade-bot/1.0' },
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
function takerFee(shares, price) { return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price)); }
function makerRebate(shares, price) { return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE); }

function freshPairState(symbol) {
  return {
    symbol,
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    priceBuffer: [], // [{t(ms), upAsk, downAsk}] — self-referential, no external spot feed needed
    entryDone: false,
    position: null, // { side, mode:'chase'|'fade', spikeSide, entryPrice, shares, cost, tpPrice, slPrice, tpOrderId, openedAt }
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
  p.eventTitle = event.title || event.slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;
  p.resolvedThisWindow = false;
  p.entryDone = false;
  p.priceBuffer = [];
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | mode=${REVERSE_SIGNAL ? 'FADE' : 'CHASE'}`);
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
  const now = Date.now();
  for (const p of Object.values(pairs)) {
    if (!p.tradable || p.upAsk == null || p.downAsk == null) continue;
    p.priceBuffer.push({ t: now, upAsk: p.upAsk, downAsk: p.downAsk });
    const cutoff = now - (SPIKE_LOOKBACK_SECS + 10) * 1000;
    while (p.priceBuffer.length && p.priceBuffer[0].t < cutoff) p.priceBuffer.shift();
  }
}

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

// ─────────────────────────────────────────
//  Spike detection — identical in both modes
// ─────────────────────────────────────────
function detectSpike(p) {
  const buf = p.priceBuffer;
  if (buf.length < 3) return null;
  const now = buf[buf.length - 1];
  const cutoffT = Date.now() - SPIKE_LOOKBACK_SECS * 1000;
  let ref = buf[0];
  for (const pt of buf) { if (pt.t <= cutoffT) ref = pt; else break; }

  const upMove = round4(now.upAsk - ref.upAsk);
  const downMove = round4(now.downAsk - ref.downAsk);

  if (upMove >= SPIKE_THRESHOLD && upMove > downMove) return { spikeSide: 'Up', move: upMove };
  if (downMove >= SPIKE_THRESHOLD && downMove > upMove) return { spikeSide: 'Down', move: downMove };
  return null;
}

// ─────────────────────────────────────────
//  Entry — one trade per window, direction set by REVERSE_SIGNAL
// ─────────────────────────────────────────
async function maybeEnter(p) {
  if (p.entryDone || p.position) return;
  const spike = detectSpike(p);
  if (!spike) return;

  const mode = REVERSE_SIGNAL ? 'fade' : 'chase';
  const tradeSide = REVERSE_SIGNAL
    ? (spike.spikeSide === 'Up' ? 'Down' : 'Up') // fade: buy the side that DIDN'T spike
    : spike.spikeSide;                            // chase: buy the side that DID spike

  const ask = tradeSide === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) return;

  const cost = round2(ask * TRADE_SHARES);
  if (cost > p.bankroll) {
    log(`⏭️  ${p.symbol}: skip entry — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${cost.toFixed(2)})`);
    p.entryDone = true;
    return;
  }

  const tokenId = tradeSide === 'Up' ? p.upTokenId : p.downTokenId;
  const order = await placeLimitBuy(tokenId, ask, TRADE_SHARES); // taker — reacting to a move that already happened
  const fee = takerFee(TRADE_SHARES, ask);
  p.bankroll = round2(p.bankroll - cost - fee);
  p.feesPaid = round2(p.feesPaid + fee);
  p.realizedPnl = round2(p.realizedPnl - fee);

  p.position = {
    side: tradeSide, mode, spikeSide: spike.spikeSide,
    entryPrice: ask, shares: TRADE_SHARES, cost,
    tpPrice: Math.min(round2(ask + TP_OFFSET), 0.99),
    slPrice: Math.max(round2(ask - SL_OFFSET), 0.01),
    tpOrderId: null,
    openedAt: Date.now(),
  };
  p.entryDone = true;

  const tpOrder = await placeLimitSell(tokenId, p.position.tpPrice, TRADE_SHARES);
  p.position.tpOrderId = tpOrder.id || tpOrder.orderId || null;
  recordEquity(p);
  log(`🎯 ${p.symbol} [${mode.toUpperCase()}] spike detected on ${spike.spikeSide} (+${spike.move}) → bought ${tradeSide} ${TRADE_SHARES}sh @ ${ask.toFixed(2)} | cost=$${cost.toFixed(2)} fee=-$${fee.toFixed(4)} | TP@${p.position.tpPrice.toFixed(2)} SL@${p.position.slPrice.toFixed(2)}`);
  registerTrade(p, { mode, side: 'BUY', outcome: tradeSide, spikeSide: spike.spikeSide, price: ask, shares: TRADE_SHARES, cost, fee });
}

async function manageOpenPosition(p, remaining) {
  const pos = p.position;
  if (!pos) return;
  const bid = pos.side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;

  if (bid >= pos.tpPrice) {
    const proceeds = round2(pos.tpPrice * pos.shares);
    const rebate = makerRebate(pos.shares, pos.tpPrice);
    const net = round2(proceeds + rebate);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    p.wins++;
    log(`💰 ${p.symbol} [${pos.mode.toUpperCase()}] TP filled ${pos.shares}sh @ ${pos.tpPrice.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { mode: pos.mode, side: 'SELL', outcome: pos.side, reason: 'TP', price: pos.tpPrice, shares: pos.shares, profit, rebate });
    p.position = null;
    recordEquity(p);
    return;
  }
  if (bid <= pos.slPrice && remaining > EXIT_SAFETY_BUFFER_SEC) {
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
    p.losses++;
    log(`💥 ${p.symbol} [${pos.mode.toUpperCase()}] SL filled ${pos.shares}sh @ ${bid.toFixed(2)} | fee=-$${fee.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { mode: pos.mode, side: 'SELL', outcome: pos.side, reason: 'SL', price: bid, shares: pos.shares, profit, fee });
    p.position = null;
    recordEquity(p);
  }
}

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
  if (won) p.wins++; else p.losses++;
  const icon = won ? '💰' : '💥';
  log(`${icon} ${p.symbol} [${pos.mode.toUpperCase()}] RESOLUTION ${pos.side} ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { mode: pos.mode, side: 'SELL', outcome: pos.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
  p.position = null;
  recordEquity(p);
}

async function processPair(p) {
  const ws = currentWindowStart();
  if (p.windowStart === null || ws !== p.windowStart) {
    if (p.windowStart !== null && !p.resolvedThisWindow) await resolvePairWindow(p);
    await loadPairWindow(p);
  }
  if (!p.tradable || !tradingEnabled) return;

  const remaining = p.windowEnd - nowSec();
  if (p.position) await manageOpenPosition(p, remaining);
  else await maybeEnter(p);

  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) await resolvePairWindow(p);
}

function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const unrealized = round2(p.position ? positionMarkValue(p) - p.position.cost : 0);
    const markValue = pairMarkValue(p);
    return {
      symbol: p.symbol, tradable: p.tradable, slug: p.slug, windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      bankroll: p.bankroll, realizedPnl: p.realizedPnl, unrealizedPnl: unrealized, markValue,
      feesPaid: p.feesPaid, rebatesEarned: p.rebatesEarned, wins: p.wins, losses: p.losses,
      position: p.position ? { side: p.position.side, mode: p.position.mode, spikeSide: p.position.spikeSide, entryPrice: p.position.entryPrice, shares: p.position.shares, cost: p.position.cost, tpPrice: p.position.tpPrice, slPrice: p.position.slPrice } : null,
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
    dryRun: DRY_RUN, tradingEnabled, pairs: pairList, mode: REVERSE_SIGNAL ? 'FADE' : 'CHASE',
    totalCapital: TOTAL_CAPITAL, perPairCapital, totalBankroll, totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized, totalUnrealizedPnl: totalUnrealized, totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses, totalFeesPaid: round2(pairStates.reduce((s, p) => s + p.feesPaid, 0)),
    totalRebatesEarned: round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0)),
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: { reverseSignal: REVERSE_SIGNAL, spikeLookbackSecs: SPIKE_LOOKBACK_SECS, spikeThreshold: SPIKE_THRESHOLD, tpOffset: TP_OFFSET, slOffset: SL_OFFSET, tradeShares: TRADE_SHARES },
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
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Chase/Fade Signal Research Bot — MODE: ${REVERSE_SIGNAL ? 'FADE (reversed — buy the side that did NOT spike)' : 'CHASE (baseline — buy the side that DID spike)'}`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  spike: ≥${SPIKE_THRESHOLD} move over ${SPIKE_LOOKBACK_SECS}s | ${TRADE_SHARES}sh flat size | TP+${TP_OFFSET} SL-${SL_OFFSET} | one trade per window`);
  log(`⚙️  fees: entry+SL taker (crypto rate ${CRYPTO_TAKER_FEE_RATE}) | TP maker (0 fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);
  log(`🔬 To run the opposite mode for comparison: set REVERSE_SIGNAL=${REVERSE_SIGNAL ? 'false' : 'true'} and redeploy.`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
