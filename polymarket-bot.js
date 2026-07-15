'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET CRYPTO UP/DOWN — DUAL PRICE-ACTION STRADDLE STRATEGIES
 * ═══════════════════════════════════════════════════════════════
 *
 *  Runs on 15m and 5m windows only (no 1h market). For every window,
 *  BOTH the Up and Down outcome tokens are candidates — there is no
 *  pre-assigned directional "side" anymore. Two independent strategies
 *  watch every window at once:
 *
 *  STRATEGY 1 — buy-the-dip straddle:
 *    Each leg (Up, Down) independently places a limit buy at 0.30.
 *    Once a leg fills: TP at 0.70, SL at 0.10. If neither TP nor SL is
 *    hit before the window ends, it settles at actual resolution
 *    (1.00 if that side won, 0.00 if it lost). Bet = $50 PER LEG (so
 *    up to $100 total if both legs fill in the same window). Each leg
 *    fires at most once per window — no repeat re-entry after it
 *    closes.
 *
 *  STRATEGY 2 — momentum-spike straddle:
 *    Independent of Strategy 1. The first time EITHER side's ask
 *    ticks to 0.70 or higher, immediately place a limit buy at 0.70 on
 *    BOTH Up and Down (one-shot trigger per window). Each leg then
 *    carries an SL at 0.30; there is no explicit TP — a leg that isn't
 *    stopped out rides to actual resolution (1.00 or 0.00). Bet = $100
 *    PER LEG (so $200 total once triggered, since both legs are bought
 *    together).
 *
 *  Strategy 1 and Strategy 2 are fully independent and can both fire
 *  in the same window (e.g. Strategy 1 fills the Up dip at 0.30, and
 *  later the same window's price spike to 0.70 also triggers Strategy
 *  2 buying both legs at 0.70).
 *
 *  FEES: a taker fee (CRYPTO_TAKER_FEE_RATE) is charged on every entry
 *  and on every TP/SL exit (a real order-book trade). Resolution
 *  settlement (redemption) is not fee'd, matching how the rest of
 *  this bot's bookkeeping treats final settlement.
 *
 *  SLUGS: 5m/15m Polymarket markets use predictable epoch-based slugs
 *  (`{symbol}-updown-{tf}-{epoch}`).
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable (see setMode). In DEMO
 *  mode all fills are simulated. In LIVE mode, entries route through
 *  trader.limitBuy(); exits route through trader.limitSell() if that
 *  method exists on the configured PolymarketTrader — if it doesn't,
 *  exits are logged but NOT sent to the exchange (bookkeeping only),
 *  since this bot was not given that class's source to verify against.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // stop opening new positions / start resolving this many secs before nominal window end

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // runtime-switchable — see setMode
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const S1_BUY_PRICE = Number(process.env.S1_BUY_PRICE || 0.30);
const S1_TP        = Number(process.env.S1_TP || 0.70);
const S1_SL        = Number(process.env.S1_SL || 0.10);
const S1_BET_USD   = Number(process.env.S1_BET_USD || 50);   // per leg

const S2_TRIGGER   = Number(process.env.S2_TRIGGER || 0.70);
const S2_BUY_PRICE = Number(process.env.S2_BUY_PRICE || 0.70);
const S2_SL        = Number(process.env.S2_SL || 0.30);
const S2_BET_USD   = Number(process.env.S2_BET_USD || 100);  // per leg

const CRYPTO_TAKER_FEE_RATE = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);

const TIMEFRAMES = { '15m': 900, '5m': 300 };

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
let tokenAskMap = {}; // tokenId -> current BUY (ask) price

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-straddle-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-straddle-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function placeEntryBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function placeExitSell(tokenId, price, shares) {
  if (!DRY_RUN && trader) {
    if (typeof trader.limitSell === 'function') return await trader.limitSell(tokenId, shares, price);
    log(`⚠️  trader.limitSell() not available — exit recorded in bookkeeping only, NOT sent to the exchange`);
    return null;
  }
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
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
    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    wins: 0, losses: 0,
    windows: [], // flat list of window trackers (15m + 5m, rolling)
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

function windowStartFor(tf, tsSec = nowSec()) { const secs = TIMEFRAMES[tf]; return Math.floor(tsSec / secs) * secs; }

function freshLeg() {
  return {
    status: 'idle',       // idle -> open -> closed | skipped
    entryPrice: null, shares: null, cost: null,
    exitPrice: null, exitReason: null, // 'tp' | 'sl' | 'resolution'
    profit: null, won: null,
  };
}
function buildWindow(symbol, tf, windowStart) {
  const secs = TIMEFRAMES[tf];
  return {
    id: `${symbol}-${tf}-${windowStart}`,
    tf, windowStart, windowEnd: windowStart + secs,
    slug: null, conditionId: null, upTokenId: null, downTokenId: null,
    loaded: false, tradable: false,
    resolved: false, resolvedAt: null,
    s1: { up: freshLeg(), down: freshLeg() },
    s2: { triggered: false, up: freshLeg(), down: freshLeg() },
  };
}

// Makes sure a window tracker exists for the CURRENT 15m period and the
// CURRENT 5m period. Called every tick — cheap no-op once both exist.
function ensureCurrentWindows(s) {
  for (const tf of ['15m', '5m']) {
    const ws = windowStartFor(tf);
    const id = `${s.symbol}-${tf}-${ws}`;
    if (!s.windows.find(w => w.id === id)) {
      s.windows.push(buildWindow(s.symbol, tf, ws));
      log(`🆕 ${s.symbol} new ${tf} window [${new Date(ws * 1000).toISOString().slice(11, 16)}Z]`);
    }
  }
}

// ─────────────────────────────────────────
//  Market discovery
// ─────────────────────────────────────────
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
function pickMarket(event) {
  return (event.markets || []).find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || (event.markets || [])[0];
}

// 5m / 15m: predictable epoch-based slugs.
async function fetchEventForWindow(symbol, tf, windowStart) {
  const secs = TIMEFRAMES[tf];
  for (const offsetMult of [0, -1, 1]) {
    const ws = windowStart + offsetMult * secs;
    const slug = `${symbol.toLowerCase()}-updown-${tf}-${ws}`;
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) {
        return { event, market: pickMarket(event), slug };
      }
    } catch (_) {}
  }
  return null;
}

async function tryLoadWindow(s, w) {
  const found = await fetchEventForWindow(s.symbol, w.tf, w.windowStart);
  if (!found) return;
  const { market, slug } = found;
  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) return;
  w.slug = slug;
  w.conditionId = market.conditionId || null;
  w.upTokenId = upId;
  w.downTokenId = downId;
  w.loaded = true;
  w.tradable = true;
}

// ─────────────────────────────────────────
//  Polymarket price feed
// ─────────────────────────────────────────
async function refreshAllPrices() {
  const tokenSet = new Set();
  for (const s of Object.values(pairs)) {
    for (const w of s.windows) {
      if (w.resolved || !w.loaded) continue;
      if (w.upTokenId) tokenSet.add(w.upTokenId);
      if (w.downTokenId) tokenSet.add(w.downTokenId);
    }
  }
  if (!tokenSet.size) return;
  const requests = [...tokenSet].map(tid => ({ token_id: tid, side: 'BUY' }));
  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const price = parseFloat(row.price);
        if (tid && Number.isFinite(price)) tokenAskMap[tid] = price;
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (val && typeof val === 'object') {
          const p = val.BUY != null ? val.BUY : (val.buy != null ? val.buy : null);
          if (p != null) tokenAskMap[tid] = parseFloat(p);
        }
      }
    }
  } catch (e) {
    for (const tid of tokenSet) {
      try {
        const r = await getJSON(`${CLOB}/price?token_id=${tid}&side=BUY`);
        const p = parseFloat(r.price || r.mid);
        if (Number.isFinite(p)) tokenAskMap[tid] = p;
      } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function windowMarkValue(w) {
  if (w.resolved) return 0;
  let val = 0;
  for (const stratName of ['s1', 's2']) {
    for (const sideName of ['up', 'down']) {
      const leg = w[stratName][sideName];
      if (leg.status !== 'open') continue;
      const tid = sideName === 'up' ? w.upTokenId : w.downTokenId;
      const px = tokenAskMap[tid];
      val += leg.shares * (px ?? leg.entryPrice);
    }
  }
  return round2(val);
}
function pairMarkValue(s) {
  const held = s.windows.reduce((sum, w) => sum + windowMarkValue(w), 0);
  return round2(s.bankroll + held);
}
function pushGlobalEquity() {
  const total = round2(Object.values(pairs).reduce((sum, s) => sum + pairMarkValue(s), 0));
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > 500) totalEquityCurve.shift();
}
function recordEquity(s) {
  s.equityCurve.push({ t: Date.now(), equity: pairMarkValue(s) });
  if (s.equityCurve.length > 300) s.equityCurve.shift();
  pushGlobalEquity();
}
function registerTrade(s, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: s.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Leg open/close — shared by both strategies
// ─────────────────────────────────────────
async function openLeg(s, w, stratName, sideName, leg, entryPrice, betUsd) {
  const tokenId = sideName === 'up' ? w.upTokenId : w.downTokenId;
  const shares = round2(betUsd / entryPrice);
  const notional = round2(entryPrice * shares);
  const fee = takerFee(shares, entryPrice);
  const cost = round2(notional + fee);

  if (cost > s.bankroll) {
    log(`⏭️  ${s.symbol} ${w.tf} [${w.id}] ${stratName.toUpperCase()} ${sideName.toUpperCase()}: skip entry — bankroll $${s.bankroll.toFixed(2)} < $${cost.toFixed(2)}`);
    leg.status = 'skipped';
    return;
  }

  await placeEntryBuy(tokenId, entryPrice, shares);
  s.bankroll = round2(s.bankroll - cost);
  s.realizedPnl = round2(s.realizedPnl - fee);
  s.feesPaid = round2(s.feesPaid + fee);
  leg.status = 'open'; leg.entryPrice = entryPrice; leg.shares = shares; leg.cost = cost;
  recordEquity(s);
  log(`🎯 ${s.symbol} ${w.tf} [${new Date(w.windowStart * 1000).toISOString().slice(11, 16)}Z] ${stratName.toUpperCase()} ${sideName.toUpperCase()} LIMIT BUY $${betUsd} (${shares}sh @ ${entryPrice.toFixed(2)}) | cost=$${cost.toFixed(2)} | fee=-$${fee.toFixed(4)}`);
  registerTrade(s, { side: 'BUY', outcome: sideName === 'up' ? 'Up' : 'Down', tf: w.tf, reason: `${stratName.toUpperCase()}_ENTRY`, price: entryPrice, shares, cost, fee });
}

async function closeLeg(s, w, stratName, sideName, leg, exitPrice, reason) {
  const tokenId = sideName === 'up' ? w.upTokenId : w.downTokenId;
  let fee = 0;
  if (reason === 'tp' || reason === 'sl') {
    await placeExitSell(tokenId, exitPrice, leg.shares);
    fee = takerFee(leg.shares, exitPrice);
  }
  const proceeds = round2(leg.shares * exitPrice);
  const netProceeds = round2(proceeds - fee);
  const profit = round2(netProceeds - leg.cost);

  s.bankroll = round2(s.bankroll + netProceeds);
  s.realizedPnl = round2(s.realizedPnl + profit);
  if (fee > 0) s.feesPaid = round2(s.feesPaid + fee);
  const won = profit > 0;
  if (won) s.wins++; else s.losses++;
  leg.status = 'closed'; leg.exitPrice = exitPrice; leg.exitReason = reason; leg.profit = profit; leg.won = won;

  const icon = won ? '💰' : '💥';
  const reasonLabel = reason === 'tp' ? 'TP' : reason === 'sl' ? 'SL' : 'RESOLUTION';
  log(`${icon} ${s.symbol} ${w.tf} [${new Date(w.windowStart * 1000).toISOString().slice(11, 16)}Z] ${stratName.toUpperCase()} ${sideName.toUpperCase()} ${reasonLabel} exit@${exitPrice.toFixed(2)} entry@${leg.entryPrice.toFixed(2)} ${leg.shares}sh | pnl=$${profit.toFixed(2)} | bankroll=$${s.bankroll.toFixed(2)}`);
  registerTrade(s, { side: 'SELL', outcome: sideName === 'up' ? 'Up' : 'Down', tf: w.tf, reason: `${stratName.toUpperCase()}_${reasonLabel}`, price: exitPrice, shares: leg.shares, profit });
  recordEquity(s);
}

// ─────────────────────────────────────────
//  Strategy 1 — buy the dip @0.30, TP 0.70 / SL 0.10, per leg independently
// ─────────────────────────────────────────
async function maybeStrategy1(s, w, sideName) {
  const leg = w.s1[sideName];
  if (leg.status === 'closed' || leg.status === 'skipped') return;
  const tokenId = sideName === 'up' ? w.upTokenId : w.downTokenId;
  const ask = tokenAskMap[tokenId];
  if (ask == null) return;

  if (leg.status === 'idle') {
    if (ask <= S1_BUY_PRICE) await openLeg(s, w, 's1', sideName, leg, S1_BUY_PRICE, S1_BET_USD);
    return;
  }
  // leg.status === 'open'
  if (ask >= S1_TP) await closeLeg(s, w, 's1', sideName, leg, S1_TP, 'tp');
  else if (ask <= S1_SL) await closeLeg(s, w, 's1', sideName, leg, S1_SL, 'sl');
}

// ─────────────────────────────────────────
//  Strategy 2 — momentum spike @0.70 triggers BOTH legs, SL 0.30, TP=resolution
// ─────────────────────────────────────────
async function maybeStrategy2(s, w) {
  const s2 = w.s2;
  if (!s2.triggered) {
    const upAsk = tokenAskMap[w.upTokenId], downAsk = tokenAskMap[w.downTokenId];
    if (upAsk == null || downAsk == null) return;
    if (upAsk >= S2_TRIGGER || downAsk >= S2_TRIGGER) {
      s2.triggered = true;
      log(`⚡ ${s.symbol} ${w.tf} [${new Date(w.windowStart * 1000).toISOString().slice(11, 16)}Z] Strategy-2 triggered (up ${upAsk.toFixed(2)} / down ${downAsk.toFixed(2)}) → buying BOTH legs @${S2_BUY_PRICE.toFixed(2)}`);
      await openLeg(s, w, 's2', 'up', s2.up, S2_BUY_PRICE, S2_BET_USD);
      await openLeg(s, w, 's2', 'down', s2.down, S2_BUY_PRICE, S2_BET_USD);
    }
    return;
  }
  for (const sideName of ['up', 'down']) {
    const leg = s2[sideName];
    if (leg.status !== 'open') continue;
    const tokenId = sideName === 'up' ? w.upTokenId : w.downTokenId;
    const ask = tokenAskMap[tokenId];
    if (ask == null) continue;
    if (ask <= S2_SL) await closeLeg(s, w, 's2', sideName, leg, S2_SL, 'sl'); // no TP — rides to resolution otherwise
  }
}

// ─────────────────────────────────────────
//  Resolution — force-close any still-open legs at actual outcome
// ─────────────────────────────────────────
async function determineWinningSideForWindow(w) {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(w.slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === w.conditionId) || (event.markets || [])[0];
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const winner = (outcomes[bestI] || '').trim();
      if (winner) return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
    }
  } catch (_) {}
  const upAsk = tokenAskMap[w.upTokenId], downAsk = tokenAskMap[w.downTokenId];
  if (upAsk != null && downAsk != null) return upAsk >= downAsk ? 'Up' : 'Down';
  return null;
}

async function resolveWindow(s, w) {
  const winner = await determineWinningSideForWindow(w); // 'Up' | 'Down' | null
  for (const stratName of ['s1', 's2']) {
    for (const sideName of ['up', 'down']) {
      const leg = w[stratName][sideName];
      if (leg.status !== 'open') continue;
      const sideLabel = sideName === 'up' ? 'Up' : 'Down';
      let exitPrice;
      if (winner) exitPrice = (winner === sideLabel) ? 1 : 0;
      else exitPrice = tokenAskMap[sideName === 'up' ? w.upTokenId : w.downTokenId] ?? leg.entryPrice;
      await closeLeg(s, w, stratName, sideName, leg, exitPrice, 'resolution');
    }
  }
  w.resolved = true;
  w.resolvedAt = Date.now();
}

// ─────────────────────────────────────────
//  Main per-symbol tick
// ─────────────────────────────────────────
async function processSymbol(s) {
  if (!tradingEnabled) return;
  ensureCurrentWindows(s);

  const t = nowSec();
  for (const w of s.windows) {
    if (w.resolved) continue;
    if (!w.loaded) { await tryLoadWindow(s, w); if (!w.loaded) continue; }

    const nearEnd = t >= w.windowEnd - EARLY_CUTOFF_SECS;

    if (!nearEnd) {
      await maybeStrategy1(s, w, 'up');
      await maybeStrategy1(s, w, 'down');
      await maybeStrategy2(s, w);
    } else {
      await resolveWindow(s, w);
    }
  }

  // prune old resolved windows so the list doesn't grow forever
  const cutoffMs = Date.now() - 15 * 60 * 1000;
  s.windows = s.windows.filter(w => !w.resolved || w.resolvedAt > cutoffMs);
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(s => {
    const markValue = pairMarkValue(s);
    return {
      symbol: s.symbol,
      bankroll: s.bankroll,
      realizedPnl: s.realizedPnl,
      unrealizedPnl: round2(markValue - s.bankroll),
      markValue,
      feesPaid: s.feesPaid,
      wins: s.wins, losses: s.losses,
      windows: s.windows.map(w => ({
        id: w.id, tf: w.tf,
        windowStart: w.windowStart, windowEnd: w.windowEnd,
        secsToEnd: Math.max(0, Math.floor(w.windowEnd - nowSec())),
        secsToStart: Math.max(0, Math.floor(w.windowStart - nowSec())),
        tradable: w.tradable, resolved: w.resolved,
        upAsk: w.upTokenId != null ? (tokenAskMap[w.upTokenId] ?? null) : null,
        downAsk: w.downTokenId != null ? (tokenAskMap[w.downTokenId] ?? null) : null,
        s1: w.s1, s2: w.s2,
      })),
      equityCurve: s.equityCurve,
    };
  });
  const totalBankroll = round2(pairStates.reduce((sum, p) => sum + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((sum, p) => sum + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((sum, p) => sum + p.realizedPnl, 0));
  const totalUnrealized = round2(pairStates.reduce((sum, p) => sum + p.unrealizedPnl, 0));
  const totalWins = pairStates.reduce((sum, p) => sum + p.wins, 0);
  const totalLosses = pairStates.reduce((sum, p) => sum + p.losses, 0);
  return {
    dryRun: DRY_RUN, tradingEnabled, pairs: pairList,
    totalCapital: TOTAL_CAPITAL, perPairCapital, totalBankroll, totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized, totalUnrealizedPnl: totalUnrealized, totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid: round2(pairStates.reduce((sum, p) => sum + p.feesPaid, 0)),
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      strategy1: { buyPrice: S1_BUY_PRICE, tp: S1_TP, sl: S1_SL, betUsd: S1_BET_USD },
      strategy2: { trigger: S2_TRIGGER, buyPrice: S2_BUY_PRICE, sl: S2_SL, betUsd: S2_BET_USD },
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
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
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshAllPrices(); }
      for (const s of Object.values(pairs)) { try { await processSymbol(s); } catch (e) { log(`⚠️  ${s.symbol} tick error: ${e.message}`); } }
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
  log(`⚙️  Pairs updated: ${pairList.join(', ')} | $${perPairCapital.toFixed(2)} per pair (bookkeeping only — S1 $${S1_BET_USD}/leg, S2 $${S2_BET_USD}/leg)`);
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
  log(`🚀 Dual Price-Action Straddle Bot (15m + 5m only)`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair bookkeeping bankroll`);
  log(`⚙️  Strategy 1: limit buy Up & Down independently @${S1_BUY_PRICE.toFixed(2)}, TP @${S1_TP.toFixed(2)} / SL @${S1_SL.toFixed(2)}, $${S1_BET_USD}/leg, one-shot per leg`);
  log(`⚙️  Strategy 2: first tick to @${S2_TRIGGER.toFixed(2)} on either side → buy BOTH legs @${S2_BUY_PRICE.toFixed(2)}, SL @${S2_SL.toFixed(2)}, TP=resolution, $${S2_BET_USD}/leg, one-shot per window`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
