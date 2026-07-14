'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — PURE MARTINGALE STREAK BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  Complete rewrite. No signals, no external price data for the DECISION —
 *  Polymarket's own ask is only used to know what price to quote at when
 *  placing the order, never to decide direction. Direction and size are
 *  purely a function of the bot's own last result.
 *
 *  ENTRY: exactly ONE entry per window, at t=150s (mid-window). No earlier
 *    checkpoint, no second entry.
 *
 *  DIRECTION — win stays, loss flips:
 *    - The very first entry ever placed is Up (hardcoded starting point).
 *    - If the last bet WON, the next window's bet is the SAME side again.
 *    - If the last bet LOST, the next window's bet FLIPS to the other side.
 *    This is a pure streak-following rule — it has no opinion about the
 *    market at all, only about its own last outcome.
 *
 *  SIZING — pure martingale, base resets on a win:
 *    - After a WIN, the next bet's stake resets to BASE_PCT (0.25%) of the
 *      CURRENT bankroll at that moment (so the base itself slowly grows or
 *      shrinks as bankroll compounds over time).
 *    - After a LOSS, the next bet's stake is simply DOUBLE the dollar
 *      amount just staked. No formula, no recovery target — pure doubling.
 *    - This is uncapped by design: a long losing streak grows the stake
 *      geometrically with no ceiling. That's the explicit, accepted
 *      behavior of "pure martingale," not an oversight.
 *
 *  EXECUTION: single-shot limit buy quoted QUOTE_BUFFER above the current
 *    ask (deliberately marketable) — no retry, no cancel, no fill
 *    verification.
 *
 *  EXIT: none. No TP, no SL. The position rides to actual window
 *    resolution; a separate, independent auto-claim script handles real
 *    redemption. This bot's own bookkeeping still simulates resolution
 *    (via the public Gamma API) purely to keep the dashboard's P&L figures
 *    meaningful, and to know whether to reset or double next time.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable (see setMode) — dashboard has
 *    a one-click toggle plus an independent pause button.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // force-resolve this many seconds BEFORE the nominal window end (298s)
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // runtime-switchable — see setMode
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const ENTRY_SECS  = Number(process.env.ENTRY_SECS || 150); // the one and only checkpoint
const BASE_PCT    = Number(process.env.BASE_PCT || 0.0025); // 0.25% of current bankroll — recomputed fresh after every win
const MIN_SHARES  = Number(process.env.MIN_SHARES || 1);
const QUOTE_BUFFER = Number(process.env.QUOTE_BUFFER || 0.01); // above the ask — deliberately marketable, single shot

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

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-martingale-streak-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-martingale-streak-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// A marketable buy — priced above the current ask so it fills now. Single
// shot: no retry, no cancel, no fill verification.
async function placeEntryBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
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
    entryDone: false,
    entry: null,                  // at most one per window
    // Streak state — persists ACROSS windows, NOT reset per-window:
    nextSide: 'Up',                // first-ever bet is Up
    nextStakeDollars: null,        // null = "compute fresh base (0.25% of bankroll)" — set on init and after every win
    streakLosses: 0,               // just for dashboard visibility — how many consecutive losses right now
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
  p.entry = null;
  log(`🔭 ${p.symbol} window loaded: ${slug} | next bet: ${p.nextSide}${p.nextStakeDollars != null ? ` @ $${p.nextStakeDollars.toFixed(2)} (martingale)` : ' @ base (0.25% of bankroll)'} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z`);
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
function pairMarkValue(p) {
  if (!p.entry || p.entry.closed) return round2(p.bankroll);
  const bid = p.entry.side === 'Up' ? p.upBid : p.downBid;
  const held = round2(p.entry.shares * (bid ?? p.entry.entryPrice));
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
//  Entry: one per window, streak-driven direction and sizing
// ─────────────────────────────────────────
async function attemptEntry(p) {
  const side = p.nextSide;
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  const ask = side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null) { log(`⏭️  ${p.symbol}: no ${side} ask available, skipping this window's entry entirely`); return; }

  const stakeDollars = p.nextStakeDollars != null ? p.nextStakeDollars : round2(p.bankroll * BASE_PCT);
  if (stakeDollars < 0.05) {
    log(`⏭️  ${p.symbol}: stake too small ($${stakeDollars.toFixed(2)}), skipping`);
    return;
  }
  const quotePrice = round2(ask + QUOTE_BUFFER);
  const shares = Math.max(round2(stakeDollars / quotePrice), MIN_SHARES);
  const notional = round2(quotePrice * shares);
  const fee = takerFee(shares, quotePrice);
  const totalCost = round2(notional + fee);
  if (totalCost > p.bankroll) {
    log(`⏭️  ${p.symbol}: skip entry — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${totalCost.toFixed(2)})`);
    return;
  }

  await placeEntryBuy(tokenId, quotePrice, shares);
  p.bankroll = round2(p.bankroll - totalCost);
  p.realizedPnl = round2(p.realizedPnl - fee);
  p.feesPaid = round2(p.feesPaid + fee);
  const entry = {
    side, entryPrice: quotePrice, shares, cost: totalCost, stakeDollars,
    isMartingale: p.nextStakeDollars != null, closed: false, openedAt: Date.now(),
  };
  p.entry = entry;
  recordEquity(p);
  const tag = entry.isMartingale ? ` [martingale, streak=${p.streakLosses} losses]` : ' [base, 0.25% of bankroll]';
  log(`🎯 ${p.symbol} ${side} entry ${shares.toFixed(2)}sh @ ${quotePrice.toFixed(2)} | stake=$${stakeDollars.toFixed(2)}${tag} | cost=$${totalCost.toFixed(2)} | fee=-$${fee.toFixed(4)}`);
  registerTrade(p, { side: 'BUY', outcome: side, price: quotePrice, shares, cost: totalCost, fee, stakeDollars, isMartingale: entry.isMartingale });
}

async function maybeEnter(p) {
  const elapsed = nowSec() - p.windowStart;
  if (p.entryDone || elapsed < ENTRY_SECS) return;
  p.entryDone = true;
  await attemptEntry(p);
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

function flipSide(side) { return side === 'Up' ? 'Down' : 'Up'; }

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  const entry = p.entry;
  if (entry && !entry.closed) {
    const winner = await determineWinningSide(p);
    const won = winner === entry.side;
    const proceeds = won ? round2(entry.shares * 1) : 0;
    const profit = round2(proceeds - entry.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    entry.closed = true;

    if (won) {
      p.wins++;
      p.streakLosses = 0;
      p.nextSide = entry.side;       // stay
      p.nextStakeDollars = null;     // reset — recompute 0.25% of new bankroll next time
    } else {
      p.losses++;
      p.streakLosses++;
      p.nextSide = flipSide(entry.side); // flip
      p.nextStakeDollars = round2(entry.stakeDollars * 2); // pure double, no cap
    }

    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} ${entry.side} RESOLUTION ${entry.shares}sh entry=${entry.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)} | next: ${p.nextSide} @ ${p.nextStakeDollars != null ? '$'+p.nextStakeDollars.toFixed(2)+' (martingale)' : 'base'} (dashboard bookkeeping only — real redemption is via the separate claim script)`);
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

  await maybeEnter(p);
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const markValue = pairMarkValue(p);
    const unrealized = p.entry && !p.entry.closed ? round2(markValue - p.bankroll - p.entry.cost) : 0;
    return {
      symbol: p.symbol, tradable: p.tradable, slug: p.slug, windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      entryDone: p.entryDone, nextSide: p.nextSide, nextStakeDollars: p.nextStakeDollars, streakLosses: p.streakLosses,
      bankroll: p.bankroll, realizedPnl: p.realizedPnl, unrealizedPnl: unrealized, markValue,
      feesPaid: p.feesPaid, rebatesEarned: p.rebatesEarned, wins: p.wins, losses: p.losses,
      entry: p.entry ? {
        side: p.entry.side, entryPrice: p.entry.entryPrice, shares: p.entry.shares,
        cost: p.entry.cost, stakeDollars: p.entry.stakeDollars, isMartingale: p.entry.isMartingale, closed: p.entry.closed,
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
      entrySecs: ENTRY_SECS, basePct: BASE_PCT, quoteBuffer: QUOTE_BUFFER,
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
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (existing positions still tracked for resolution bookkeeping)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) {
    log(DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real orders');
  }
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Pure Martingale Streak Bot (no signals, no external price data)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  one entry per window at t=${ENTRY_SECS}s | first-ever bet: Up | win → same side + reset to ${(BASE_PCT*100).toFixed(2)}% of bankroll | loss → flip side + double the stake (uncapped)`);
  log(`⚙️  execution: single-shot limit buy quoted ${QUOTE_BUFFER} above the ask (marketable) | no retry, no cancel | no TP/SL — rides to resolution, external claim script handles redemption`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
