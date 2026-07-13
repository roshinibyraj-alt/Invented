'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET BTC 5-MINUTE UP/DOWN — 0.96 BREAKOUT + RECOVERY BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  BTC-only, single market. Completely replaces the old candle-majority-vote
 *  / rebalance-ladder strategy with a much simpler breakout + recovery model:
 *
 *  PER 5-MINUTE WINDOW:
 *    1. WAIT — first WAIT_SECS (default 240s / 4 minutes) of every window:
 *       no trading, just watching prices tick.
 *    2. WATCH — from WAIT_SECS to window end: poll the Up and Down ask
 *       prices every tick. The instant EITHER side's ask reaches
 *       ENTRY_PRICE (default 0.96), immediately place a limit BUY for that
 *       side at 0.96 for either BASE_SHARES (default 6) or, if a recovery is
 *       currently armed, the larger RECOVERY shares count. Only one entry
 *       per window — whichever side crosses 0.96 first.
 *    3. HOLD — once filled, watch the held side's bid every tick:
 *         - If bid drops to SL_PRICE (default 0.50) or below, fire a
 *           marketable limit SELL at the current bid immediately (stop-loss).
 *           No more trading for the rest of that window.
 *         - Otherwise the position simply rides to window resolution — no
 *           take-profit order is placed; a win pays $1/share, a loss pays $0,
 *           exactly as resolved by Polymarket / this bot's own resolution
 *           bookkeeping (redemption itself is handled by the separate claim
 *           script, same as before).
 *
 *  LOSS RECOVERY (one-shot, non-chaining):
 *    Whenever a BASE trade loses (either stopped out at 0.50, or loses at
 *    resolution), the bot computes the $ loss on that trade and arms a
 *    RECOVERY for the very next window: the next entry is sized so that a
 *    WIN at 0.96 nets back the prior loss plus a fixed extra profit
 *    (RECOVERY_EXTRA_PROFIT, default $1), i.e.
 *        recoveryShares = ceil((loss + extraProfit) / netProfitPerShare)
 *    where netProfitPerShare is the (1 - 0.96) win payout per share minus
 *    the estimated taker fee on that share.
 *
 *    The recovery trade fires on the next window's first 0.96 cross, same
 *    WAIT → WATCH → HOLD mechanics as any other trade. If it WINS, the loss
 *    is recovered and the bot returns to BASE sizing. If it ALSO loses (SL
 *    or resolution), recovery does NOT chain again — the bot unconditionally
 *    returns to BASE_SHARES on the following window, and that new loss is
 *    simply absorbed (not re-armed).
 *
 *  EXECUTION:
 *    - Entry: single-shot limit BUY priced exactly at ENTRY_PRICE. No
 *      retry/re-quote — if the market moves before it fills, it's missed
 *      for that window (there's still 60s+ of window left in most cases,
 *      but the design deliberately doesn't chase).
 *    - Stop-loss exit: single-shot limit SELL priced at the current bid
 *      (marketable) the moment bid <= SL_PRICE, so it's not a resting order
 *      sitting exactly at 0.50 that Polymarket has to match — the bot
 *      actively detects the breach and fires the sell itself.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable via setMode(), independent of
 *    the pause/resume toggle, same as before.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // force-resolve this many seconds BEFORE the nominal window end
const SLUG_OFFSET_FALLBACKS = [0, -300, 300];
const SYMBOL                = 'BTC'; // single-market bot

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // runtime-switchable — see setMode
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const WAIT_SECS               = Number(process.env.WAIT_SECS || 240);      // 4 minutes of no trading after window opens
const ENTRY_PRICE             = Number(process.env.ENTRY_PRICE || 0.96);   // trigger + fill price for entry
const SL_PRICE                = Number(process.env.SL_PRICE || 0.50);      // stop-loss trigger price
const BASE_SHARES             = Number(process.env.BASE_SHARES || 6);      // default entry size
const RECOVERY_EXTRA_PROFIT   = Number(process.env.RECOVERY_EXTRA_PROFIT || 1); // $ profit target beyond just breaking even on the prior loss

const CRYPTO_TAKER_FEE_RATE = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let totalEquityCurve = [];

// ── Recovery state (single market, so this is global rather than per-pair) ──
let recoveryMode = false;
let recoveryTargetShares = 0;
let recoveryLossToCover = 0;

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-btc-breakout-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-btc-breakout-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// The two order types this bot places: a limit BUY at exactly ENTRY_PRICE
// for entries, and a limit SELL at the current bid for stop-loss exits (so
// it's deliberately marketable). Both are single-shot — no retry, no cancel.
async function placeEntryBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function placeExitSell(tokenId, price, shares) {
  if (!DRY_RUN && trader) {
    if (typeof trader.limitSell === 'function') return await trader.limitSell(tokenId, shares, price);
    log('⚠️  trader.limitSell() is not implemented in polymarket-trader.js — stop-loss exit was NOT actually placed on-chain. Add a limitSell(tokenId, shares, price) method mirroring limitBuy.');
    return null;
  }
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}

// ─────────────────────────────────────────
//  Recovery sizing
// ─────────────────────────────────────────
// Net $ profit per share if a fresh entry at ENTRY_PRICE wins (pays $1).
// Entries are limit orders (fee-free / rebate-eligible) and resolution
// settlement itself is also fee-free, so this is simply the raw payout
// margin. Fees only apply on a stop-loss exit (see checkStopLoss), which is
// a deliberately marketable/taker sell.
function netProfitPerShareAtEntry() {
  return (1 - ENTRY_PRICE);
}
function computeRecoveryShares(lossAmount) {
  const npps = netProfitPerShareAtEntry();
  if (npps <= 0) return BASE_SHARES; // degenerate config guard
  const needed = (lossAmount + RECOVERY_EXTRA_PROFIT) / npps;
  return Math.max(BASE_SHARES, Math.ceil(needed));
}

// Called once per closed trade (SL or resolution). Arms/disarms recovery.
function handlePositionClosed(p, profit, wasRecoveryTrade) {
  if (profit < 0) {
    const lossAmount = round2(Math.abs(profit));
    if (wasRecoveryTrade) {
      recoveryMode = false; recoveryTargetShares = 0; recoveryLossToCover = 0;
      log(`⚠️  ${p.symbol} recovery trade ALSO lost $${lossAmount.toFixed(2)} — no re-chaining, returning to BASE (${BASE_SHARES}sh) next window`);
    } else {
      recoveryLossToCover = lossAmount;
      recoveryTargetShares = computeRecoveryShares(lossAmount);
      recoveryMode = true;
      log(`🔁 ${p.symbol} base trade lost $${lossAmount.toFixed(2)} — arming RECOVERY: ${recoveryTargetShares}sh @ ${ENTRY_PRICE.toFixed(2)} next window (target +$${RECOVERY_EXTRA_PROFIT.toFixed(2)} beyond breakeven)`);
    }
  } else {
    if (wasRecoveryTrade) log(`✅ ${p.symbol} recovery trade WON +$${profit.toFixed(2)} — loss recovered, back to BASE`);
    recoveryMode = false; recoveryTargetShares = 0; recoveryLossToCover = 0;
  }
}

// ─────────────────────────────────────────
//  Market state (single BTC pair)
// ─────────────────────────────────────────
function freshPairState() {
  return {
    symbol: SYMBOL,
    tradable: false,
    windowStart: null, windowEnd: null, slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
    phase: 'waiting', // waiting | watching | holding | closed
    position: null,   // { side, shares, entryPrice, cost, fee, mode: 'base'|'recovery', openedAt }
    resolvedThisWindow: true,
    bankroll: TOTAL_CAPITAL,
    realizedPnl: 0,
    feesPaid: 0,
    wins: 0, losses: 0,
    equityCurve: [{ t: Date.now(), equity: TOTAL_CAPITAL }],
  };
}
let pair = freshPairState();

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
  p.phase = 'waiting';
  p.position = null;
  log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11,19)}Z | ${recoveryMode ? `RECOVERY armed (${recoveryTargetShares}sh, covering $${recoveryLossToCover.toFixed(2)})` : `base sizing (${BASE_SHARES}sh)`}`);
}

// ─────────────────────────────────────────
//  Polymarket price feed (unchanged plumbing, single pair)
// ─────────────────────────────────────────
async function refreshPolyPrices() {
  if (!pair.tradable || !pair.upTokenId || !pair.downTokenId) return;
  const requests = [
    { token_id: pair.upTokenId, side: 'BUY' },
    { token_id: pair.upTokenId, side: 'SELL' },
    { token_id: pair.downTokenId, side: 'BUY' },
    { token_id: pair.downTokenId, side: 'SELL' },
  ];
  function applyPolyPrice(tid, side, price) {
    if (!Number.isFinite(price)) return;
    if (pair.upTokenId === tid) { if (side === 'BUY') pair.upAsk = price; else if (side === 'SELL') pair.upBid = price; }
    else if (pair.downTokenId === tid) { if (side === 'BUY') pair.downAsk = price; else if (side === 'SELL') pair.downBid = price; }
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
    try {
      const [upAsk, upBid, downAsk, downBid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${pair.upTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${pair.upTokenId}&side=SELL`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${pair.downTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${pair.downTokenId}&side=SELL`).catch(() => null),
      ]);
      if (upAsk) pair.upAsk = parseFloat(upAsk.price || upAsk.mid || pair.upAsk);
      if (upBid) pair.upBid = parseFloat(upBid.price || upBid.mid || pair.upBid);
      if (downAsk) pair.downAsk = parseFloat(downAsk.price || downAsk.mid || pair.downAsk);
      if (downBid) pair.downBid = parseFloat(downBid.price || downBid.mid || pair.downBid);
    } catch (_) {}
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function pairMarkValue(p) {
  if (!p.position) return round2(p.bankroll);
  const bid = p.position.side === 'Up' ? p.upBid : p.downBid;
  const px = bid != null ? bid : p.position.entryPrice;
  return round2(p.bankroll + p.position.shares * px);
}
function pushGlobalEquity() {
  const total = pairMarkValue(pair);
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
//  Entry: fires the instant either side's ask crosses ENTRY_PRICE
// ─────────────────────────────────────────
async function tryEnterPosition(p) {
  let side = null;
  if (p.upAsk != null && p.upAsk >= ENTRY_PRICE) side = 'Up';
  else if (p.downAsk != null && p.downAsk >= ENTRY_PRICE) side = 'Down';
  if (!side) return;

  const shares = recoveryMode ? recoveryTargetShares : BASE_SHARES;
  if (shares <= 0) return;
  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  const price = ENTRY_PRICE;
  // Entry is a limit order — fee-free (rebate-eligible side of the book),
  // unlike the stop-loss exit which is a deliberately marketable taker sell.
  const totalCost = round2(price * shares);
  if (totalCost > p.bankroll) {
    log(`⏭️  ${p.symbol} entry skipped — insufficient bankroll ($${p.bankroll.toFixed(2)} < $${totalCost.toFixed(2)})`);
    return;
  }

  await placeEntryBuy(tokenId, price, shares); // fire and forget, single-shot
  p.bankroll = round2(p.bankroll - totalCost);
  const mode = recoveryMode ? 'recovery' : 'base';
  p.position = { side, shares, entryPrice: price, cost: totalCost, fee: 0, mode, openedAt: Date.now() };
  const modeTag = mode === 'recovery' ? `RECOVERY (covering $${recoveryLossToCover.toFixed(2)})` : 'BASE';
  log(`🎯 ${p.symbol} ENTRY [${modeTag}] bought ${side} ${shares}sh @ ${price.toFixed(2)} | cost=$${totalCost.toFixed(2)} (no fee — limit entry)`);
  registerTrade(p, { side: 'BUY', outcome: side, reason: mode === 'recovery' ? 'ENTRY-RECOVERY' : 'ENTRY-BASE', price, shares, cost: totalCost, fee: 0 });
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Stop-loss: fires the instant held side's bid drops to SL_PRICE or below
// ─────────────────────────────────────────
async function checkStopLoss(p) {
  const pos = p.position;
  if (!pos) return;
  const bid = pos.side === 'Up' ? p.upBid : p.downBid;
  if (bid == null || bid > SL_PRICE) return;

  const sellPrice = bid; // marketable — sell at the actual current bid to guarantee the fill
  const tokenId = pos.side === 'Up' ? p.upTokenId : p.downTokenId;
  await placeExitSell(tokenId, sellPrice, pos.shares);

  const proceeds = round2(sellPrice * pos.shares);
  const fee = takerFee(pos.shares, sellPrice);
  const netProceeds = round2(proceeds - fee);
  const profit = round2(netProceeds - pos.cost);

  p.bankroll = round2(p.bankroll + netProceeds);
  p.feesPaid = round2(p.feesPaid + fee);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.losses++;
  log(`🧯 ${p.symbol} STOP-LOSS [${pos.mode.toUpperCase()}] sold ${pos.shares}sh ${pos.side} @ ${sellPrice.toFixed(2)} | proceeds=$${netProceeds.toFixed(2)} (fee=-$${fee.toFixed(4)}, taker) | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'SELL', outcome: pos.side, reason: 'SL', price: sellPrice, shares: pos.shares, proceeds: netProceeds, profit });

  handlePositionClosed(p, profit, pos.mode === 'recovery');
  p.position = null;
  p.resolvedThisWindow = true; // one shot per window — no re-entry after SL
  p.phase = 'closed';
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Window resolution (position rode to close without hitting SL)
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
  if (pos) {
    const winnerSide = await determineWinningSide(p);
    const won = winnerSide === pos.side;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    p.bankroll = round2(p.bankroll + proceeds);
    p.realizedPnl = round2(p.realizedPnl + profit);
    if (won) p.wins++; else p.losses++;
    const icon = won ? '💰' : '💥';
    log(`${icon} ${p.symbol} RESOLUTION [${pos.mode.toUpperCase()}] winner=${winnerSide ?? '?'} | held ${pos.side} ${pos.shares}sh | proceeds=$${proceeds.toFixed(2)} (no fee) | cost=$${pos.cost.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
    registerTrade(p, { side: 'SELL', outcome: winnerSide, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, proceeds, profit });
    handlePositionClosed(p, profit, pos.mode === 'recovery');
    p.position = null;
  } else {
    log(`${p.symbol} window closed — no trade this window (0.96 never hit after the wait phase)`);
  }
  p.phase = 'closed';
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Main per-window tick
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

  if (elapsed < WAIT_SECS) {
    p.phase = 'waiting';
    return;
  }

  if (!p.position) {
    p.phase = 'watching';
    await tryEnterPosition(p);
  } else {
    p.phase = 'holding';
    await checkStopLoss(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const markValue = pairMarkValue(pair);
  const heldValue = round2(markValue - pair.bankroll);
  const unrealized = pair.position ? round2(heldValue - pair.position.cost) : 0;
  const pairState = {
    symbol: pair.symbol, tradable: pair.tradable, slug: pair.slug, windowEnd: pair.windowEnd,
    secsToEnd: pair.windowEnd ? Math.max(0, Math.floor(pair.windowEnd - nowSec())) : null,
    secsToWatch: pair.windowStart ? Math.max(0, Math.floor(WAIT_SECS - (nowSec() - pair.windowStart))) : null,
    phase: pair.phase,
    upAsk: pair.upAsk, upBid: pair.upBid, downAsk: pair.downAsk, downBid: pair.downBid,
    position: pair.position,
    bankroll: pair.bankroll, realizedPnl: pair.realizedPnl, unrealizedPnl: unrealized, markValue,
    feesPaid: pair.feesPaid, wins: pair.wins, losses: pair.losses,
    equityCurve: pair.equityCurve,
  };
  const totalWins = pair.wins, totalLosses = pair.losses;
  return {
    dryRun: DRY_RUN, tradingEnabled,
    totalCapital: TOTAL_CAPITAL, totalBankroll: pair.bankroll, totalMarkValue: markValue,
    totalRealizedPnl: pair.realizedPnl, totalUnrealizedPnl: unrealized, totalPnl: round2(markValue - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid: pair.feesPaid,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    recovery: { armed: recoveryMode, targetShares: recoveryTargetShares, lossToCover: recoveryLossToCover, extraProfit: RECOVERY_EXTRA_PROFIT },
    config: {
      waitSecs: WAIT_SECS, entryPrice: ENTRY_PRICE, slPrice: SL_PRICE,
      baseShares: BASE_SHARES, recoveryExtraProfit: RECOVERY_EXTRA_PROFIT,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
    },
    pairState, totalEquityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastPolyPriceFetch = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshPolyPrices(); }
      try { await processPair(pair); } catch (e) { log(`⚠️  ${pair.symbol} tick error: ${e.message}`); }
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (existing position still tracked for resolution bookkeeping)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

// Runtime live/demo switch — DRY_RUN is no longer fixed at startup. An
// existing open position is left alone (still tracked for bookkeeping);
// only NEW orders placed after the switch use the new mode.
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
  log(`🚀 BTC 0.96 Breakout + Recovery Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} capital | wait ${WAIT_SECS}s (${(WAIT_SECS/60).toFixed(1)}m) then watch for either side to hit ${ENTRY_PRICE.toFixed(2)} | base size ${BASE_SHARES}sh | SL at ${SL_PRICE.toFixed(2)} (bot-monitored, marketable exit) | no TP order — rides to resolution`);
  log(`⚙️  fees: entries (limit) and resolution settlement are fee-free; only a stop-loss exit (marketable taker sell) pays the taker fee`);
  log(`⚙️  recovery: on a base loss, next window sizes to cover the loss + $${RECOVERY_EXTRA_PROFIT.toFixed(2)} extra; one-shot only — a losing recovery does NOT re-chain, returns to base`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, pauseTrading, resumeTrading, setMode, getStatus, buildState };
