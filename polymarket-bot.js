'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET GRID-LADDER BOT — BTC-UP / ETH-DOWN, 15-MINUTE WINDOWS
 * ═══════════════════════════════════════════════════════════════
 *
 *  Trades ONLY the 15-minute Up/Down windows for BTC and ETH.
 *  Exactly TWO independent grid ladders are active, sharing one
 *  bankroll but never otherwise interacting with each other. BTC-Down
 *  and ETH-Up are disabled entirely — only these two run, and they can
 *  both be live at the same time (they are not mutually exclusive):
 *
 *    BTC-Up    range 0.15 – 0.45
 *    ETH-Down  range 0.45 – 0.85
 *
 *  GRID: each ladder has fixed entry levels every 0.10 across its range.
 *  Nothing is placed at window open. Instead, every tick the bot checks
 *  the live ask against each rung; the instant ask <= rung, a market BUY
 *  fires for that rung right away.
 *
 *  RE-ENTRY: a rung is only eligible to fire again after its previous
 *  position has closed via TP. While a rung is holding (position open,
 *  TP not yet hit), it will NOT re-fire even if price revisits the rung.
 *  The moment that position's TP sells, the rung is free again and will
 *  fire a fresh entry the next time ask <= rung — unlimited re-entries
 *  per window, just never while already holding.
 *
 *  EXIT: each fill gets its own TP — entry price + 0.20 (TP_OFFSET) —
 *  not a shared target. The instant bid >= that rung's TP price, a
 *  market SELL fires for that rung's shares. Anything not sold by the
 *  time the window ends simply rides to real settlement ($1 win / $0
 *  loss per share). A separate, independent auto-claim script handles
 *  real on-chain redemption; this bot's bookkeeping just mirrors it via
 *  the public Gamma API so the dashboard's P&L stays meaningful.
 *
 *  NO MID-WINDOW STARTS: if the bot is started (or restarted) partway
 *  through a live 15-minute window, it will NOT arm a partial grid for
 *  the window already in progress. It sits out and waits for the next
 *  window boundary so every grid it trades gets the full window.
 *
 *  ORDER STYLE: market orders (taker), NOT resting limit orders. Nothing
 *  sits on the book in advance. Each tick, the bot watches the live ask/bid
 *  for every rung; the moment price actually reaches a rung (ask <= rung
 *  level) it fires a single market BUY for that rung, right then — same
 *  for the exit (bid >= that rung's own TP price fires a market SELL). This
 *  trades a little slippage risk for a much higher chance of actually
 *  getting filled once price gets there, vs. a resting limit order that
 *  may never get filled. In DRY_RUN, fills are simulated at the live
 *  polled ask/bid the instant the trigger condition is met. In LIVE mode
 *  this calls out to the trader module — see the "trader interface" note
 *  below.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable (see setMode) — dashboard
 *  has a one-click toggle plus an independent pause button.
 * ═══════════════════════════════════════════════════════════════
 *
 *  TRADER INTERFACE (LIVE mode only) — this bot expects the following
 *  methods on the PolymarketTrader instance. If your polymarket-trader.js
 *  doesn't have them yet, LIVE grid trading will log a clear error and
 *  skip the action rather than crash; DRY_RUN never touches these:
 *
 *    trader.placeMarketBuy(tokenId, size)
 *      -> { id, filled, avgPrice, filledShares }   // market order, should
 *         resolve filled=true immediately (or false/throw on failure —
 *         the bot just retries next tick if price is still at trigger)
 *    trader.placeMarketSell(tokenId, size)
 *      -> same shape as placeMarketBuy
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com'; // public, no-auth — real wallet balance/positions

const TICK_MS                 = 500;
const POLY_PRICE_REFRESH_MS   = 1000;
const REAL_ACCOUNT_REFRESH_MS = 5000; // how often to pull real balance/positions in live mode
const EARLY_CUTOFF_SECS       = Number(process.env.EARLY_CUTOFF_SECS || 2); // stop trading this close to window end, go to resolution
const SLUG_OFFSET_FALLBACKS_FACTORY = (windowSecs) => [0, -windowSecs, windowSecs];

const WINDOW_SECS = 900; // 15 minutes — the ONLY timeframe this bot trades
const SYMBOLS = ['BTC', 'ETH'];

// DRY_RUN defaults to true (demo) unless explicitly overridden. Flip via
// setMode(true) / the dashboard toggle, or set DRY_RUN=false in the env.
let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const GRID_STEP        = Number(process.env.GRID_STEP || 0.10);       // rungs 0.10 apart -> 0.15/0.25/0.35/0.45
const TP_OFFSET        = Number(process.env.TP_OFFSET || 0.20);       // each rung's TP = its own entry price + this offset
const ENTRY_SHARES     = Number(process.env.ENTRY_SHARES || 50);      // fixed size per individual grid entry
const TAKER_FEE_RATE   = Number(process.env.TAKER_FEE_RATE || process.env.MAKER_FEE_RATE || 0); // market orders are taker fills
const STARTUP_GRACE_SECS = Number(process.env.STARTUP_GRACE_SECS || 3); // how close to a window's start the bot is still allowed to jump in

// Ladder definitions: ONLY BTC-Up and ETH-Down are traded. Both can be
// active/holding positions at the same time — they are independent grids
// sharing one bankroll, not a mutually-exclusive toggle.
const LADDER_DEFS = [
  { key: 'BTC-Up',   symbol: 'BTC', side: 'Up',   min: 0.15, max: 0.45 },
  { key: 'ETH-Down', symbol: 'ETH', side: 'Down', min: 0.45, max: 0.85 },
];

function buildLevels(min, max, step) {
  const levels = [];
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) levels.push(round2(min + i * step));
  return levels;
}

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let bankroll = TOTAL_CAPITAL;
let realizedPnl = 0, feesPaid = 0, wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];
let warnedNoTraderLimitMethods = false;

// ── Real account state (live mode only) — actual wallet balance/positions
// pulled from Polymarket itself, independent of the bot's internal simulated
// bankroll/position bookkeeping used above for trade decisions. ──
let realBalance = null;
let realPositions = [];
let realLastUpdated = null;
let realFetchError = null;

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-grid-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-grid-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function orderFee(shares, price) {
  return TAKER_FEE_RATE > 0 ? round5(shares * TAKER_FEE_RATE * price) : 0;
}

// CLOB order rejections often carry the real reason in e.response.data / e.data /
// e.body rather than e.message. Pull whatever's actually there so failures are
// diagnosable instead of showing a generic message.
function describeOrderError(e) {
  const parts = [e?.message || String(e)];
  const extra = e?.response?.data ?? e?.data ?? e?.body ?? null;
  if (extra) {
    try { parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (_) {}
  }
  return parts.join(' | ');
}

function traderHasMarketMethods() {
  const ok = trader && typeof trader.placeMarketBuy === 'function' && typeof trader.placeMarketSell === 'function';
  if (!ok && !warnedNoTraderLimitMethods) {
    warnedNoTraderLimitMethods = true;
    log('❌ LIVE grid trading needs trader.placeMarketBuy / trader.placeMarketSell on polymarket-trader.js — these are missing, so LIVE order actions will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}

// Market BUY, fired the instant ask <= rung level. DRY_RUN: simulated fill
// at the current live ask (the price a real market order would actually
// execute at). LIVE: places a real market order via the trader module.
async function placeMarketBuy(tokenId, shares, refAsk) {
  if (!DRY_RUN) {
    if (!traderHasMarketMethods()) return null;
    try {
      return await trader.placeMarketBuy(tokenId, shares);
    } catch (e) {
      log(`❌ placeMarketBuy failed: ${describeOrderError(e)}`);
      return null;
    }
  }
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: true, avgPrice: refAsk, filledShares: shares };
}
async function placeMarketSell(tokenId, shares, refBid) {
  if (!DRY_RUN) {
    if (!traderHasMarketMethods()) return null;
    try {
      return await trader.placeMarketSell(tokenId, shares);
    } catch (e) {
      log(`❌ placeMarketSell failed: ${describeOrderError(e)}`);
      return null;
    }
  }
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: true, avgPrice: refBid, filledShares: shares };
}

// ─────────────────────────────────────────
//  Market state (BTC / ETH 15m window)
// ─────────────────────────────────────────
function freshMarketSlot() {
  return {
    slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
  };
}

function freshSlot(level) {
  return {
    level,
    entryOrderId: null,
    firing: false,          // transient lock while a market buy call is in flight for this rung
    position: null,         // { shares, entryPrice, cost, tpPrice, tpOrderId, tpPending, exiting, closed, won, closedReason }
    reentries: 0,           // how many times this rung has filled this window — unlimited, but only ever one at a time
  };
}

function freshLadder(def) {
  return {
    key: def.key, symbol: def.symbol, side: def.side, min: def.min, max: def.max,
    levels: buildLevels(def.min, def.max, GRID_STEP),
    slots: Object.fromEntries(buildLevels(def.min, def.max, GRID_STEP).map(l => [String(l), freshSlot(l)])),
  };
}

function freshWindowState() {
  return {
    windowSecs: WINDOW_SECS,
    tradable: false,
    windowStart: null, windowEnd: null,
    resolvedThisWindow: true,
    markets: { BTC: freshMarketSlot(), ETH: freshMarketSlot() },
    ladders: Object.fromEntries(LADDER_DEFS.map(d => [d.key, freshLadder(d)])),
  };
}

let win = freshWindowState();

// If set, the bot deliberately sits out the window that was already in
// progress at startup (so it never arms a partial/mid-window grid). It
// stays null once the bot has synced up with a window from its start.
let skipUntilWindowStart = null;

// ─────────────────────────────────────────
//  Slug / window math
// ─────────────────────────────────────────
function currentWindowStart(windowSecs, tsSec = nowSec()) { return Math.floor(tsSec / windowSecs) * windowSecs; }
function slugFor(symbol, windowStartSec) { return `${symbol.toLowerCase()}-updown-15m-${windowStartSec}`; }
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

// ─────────────────────────────────────────
//  Window load — (re)builds market slots + arms all grid entry orders
// ─────────────────────────────────────────
async function loadWindow() {
  const ws = currentWindowStart(WINDOW_SECS);
  if (win.windowStart === ws && win.markets.BTC.upTokenId && win.markets.ETH.upTokenId) return;

  const [foundBtc, foundEth] = await Promise.all([
    fetchEventForWindow('BTC', ws),
    fetchEventForWindow('ETH', ws),
  ]);
  if (!foundBtc || !foundEth) { win.tradable = false; return; }
  if (foundBtc.windowStart !== foundEth.windowStart) { win.tradable = false; return; }

  function slotFrom(found) {
    const market = found.event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || found.event.markets[0];
    const upId = tokenIdForSide(market, 'up');
    const downId = tokenIdForSide(market, 'down');
    if (!upId || !downId) return null;
    const slot = freshMarketSlot();
    slot.slug = found.slug;
    slot.eventTitle = found.event.title || found.event.slug;
    slot.conditionId = market.conditionId || null;
    slot.upTokenId = upId;
    slot.downTokenId = downId;
    return slot;
  }
  const btcSlot = slotFrom(foundBtc);
  const ethSlot = slotFrom(foundEth);
  if (!btcSlot || !ethSlot) { log('⚠️  window loaded but Up/Down token ids missing'); win.tradable = false; return; }

  const fresh = freshWindowState();
  fresh.windowStart = foundBtc.windowStart;
  fresh.windowEnd = foundBtc.windowStart + WINDOW_SECS;
  fresh.markets.BTC = btcSlot;
  fresh.markets.ETH = ethSlot;
  fresh.tradable = true;
  fresh.resolvedThisWindow = false;

  win = fresh;
  log(`🔭 [15m] window loaded: BTC=${btcSlot.slug} ETH=${ethSlot.slug} | ends ${new Date(win.windowEnd * 1000).toISOString().slice(11, 19)}Z`);
  // Nothing is placed here — every rung just sits watched. tick() fires a
  // market buy the instant price actually reaches a rung.
}

// ─────────────────────────────────────────
//  Polymarket price feed
// ─────────────────────────────────────────
async function refreshPrices() {
  if (!win.tradable) return;
  const requests = [];
  for (const symbol of SYMBOLS) {
    const m = win.markets[symbol];
    if (!m.upTokenId || !m.downTokenId) continue;
    requests.push({ token_id: m.upTokenId, side: 'BUY' }, { token_id: m.upTokenId, side: 'SELL' });
    requests.push({ token_id: m.downTokenId, side: 'BUY' }, { token_id: m.downTokenId, side: 'SELL' });
  }
  if (!requests.length) return;

  function apply(tid, side, price) {
    if (!Number.isFinite(price)) return;
    for (const symbol of SYMBOLS) {
      const m = win.markets[symbol];
      if (tid === m.upTokenId) { if (side === 'BUY') m.upAsk = price; else m.upBid = price; return; }
      if (tid === m.downTokenId) { if (side === 'BUY') m.downAsk = price; else m.downBid = price; return; }
    }
  }
  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const side = (row.side || '').toUpperCase();
        const price = parseFloat(row.price);
        if (tid && Number.isFinite(price)) apply(tid, side, price);
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (val && typeof val === 'object') {
          if (val.BUY != null) apply(tid, 'BUY', parseFloat(val.BUY));
          if (val.SELL != null) apply(tid, 'SELL', parseFloat(val.SELL));
          if (val.buy != null) apply(tid, 'BUY', parseFloat(val.buy));
          if (val.sell != null) apply(tid, 'SELL', parseFloat(val.sell));
        }
      }
    }
  } catch (e) {
    // Fallback: per-token price calls
    for (const symbol of SYMBOLS) {
      const m = win.markets[symbol];
      if (!m.upTokenId || !m.downTokenId) continue;
      try {
        const [upAsk, upBid, downAsk, downBid] = await Promise.all([
          getJSON(`${CLOB}/price?token_id=${m.upTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${m.upTokenId}&side=SELL`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${m.downTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${m.downTokenId}&side=SELL`).catch(() => null),
        ]);
        if (upAsk?.price != null) m.upAsk = parseFloat(upAsk.price);
        if (upBid?.price != null) m.upBid = parseFloat(upBid.price);
        if (downAsk?.price != null) m.downAsk = parseFloat(downAsk.price);
        if (downBid?.price != null) m.downBid = parseFloat(downBid.price);
      } catch (_) {}
    }
  }
}

function tokenIdFor(ladder) {
  const m = win.markets[ladder.symbol];
  return ladder.side === 'Up' ? m.upTokenId : m.downTokenId;
}
function currentAsk(ladder) {
  const m = win.markets[ladder.symbol];
  return ladder.side === 'Up' ? m.upAsk : m.downAsk;
}
function currentBid(ladder) {
  const m = win.markets[ladder.symbol];
  return ladder.side === 'Up' ? m.upBid : m.downBid;
}

// ─────────────────────────────────────────
//  Grid entry / TP management
// ─────────────────────────────────────────
function registerTrade(t) {
  const trade = { time: new Date().toISOString().slice(11, 19), ...t };
  trades.push(trade);
  if (trades.length > 500) trades.shift();
}
function recordEquity() {
  equityCurve.push({ t: Date.now(), equity: markValue() });
  if (equityCurve.length > 1000) equityCurve.shift();
}
function markValue() {
  let held = 0;
  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const level of ladder.levels) {
      const pos = ladder.slots[String(level)].position;
      if (pos && !pos.closed) {
        const bid = currentBid(ladder);
        const px = bid != null ? bid : pos.entryPrice;
        held += pos.shares * px;
      }
    }
  }
  return round2(bankroll + held);
}

// Reserve check: don't arm an order we can't afford if it fills.
function affordable(shares, price) {
  return round2(shares * price) <= bankroll;
}

// Fires a market BUY the instant ask reaches this rung. Checked every tick
// for every rung that hasn't fired yet this window.
async function attemptEntry(ladder, slot) {
  if (!tradingEnabled) return;
  if (slot.position) return;      // already holding — only eligible again once this position's TP closes it
  if (slot.firing) return;        // a buy call is already in flight for this rung
  const ask = currentAsk(ladder);
  if (ask == null || ask > slot.level) return; // price hasn't reached this rung yet
  const tokenId = tokenIdFor(ladder);
  if (!tokenId) return;
  if (!affordable(ENTRY_SHARES, ask)) return; // skip silently — will retry next tick once bankroll frees up

  slot.firing = true;
  try {
    const resp = await placeMarketBuy(tokenId, ENTRY_SHARES, ask);
    if (!resp || !resp.filled) return; // LIVE trader missing methods, call failed, or didn't fill — retry next tick
    slot.entryOrderId = resp.id;
    await onEntryFilled(ladder, slot, resp.avgPrice != null ? resp.avgPrice : ask, resp.filledShares || ENTRY_SHARES);
  } finally {
    slot.firing = false;
  }
}

async function onEntryFilled(ladder, slot, fillPrice, filledShares) {
  const shares = filledShares > 0 ? filledShares : ENTRY_SHARES;
  const cost = round2(shares * fillPrice);
  const fee = orderFee(shares, fillPrice);
  bankroll = round2(bankroll - cost);
  feesPaid = round2(feesPaid + fee);

  const tpPrice = round2(fillPrice + TP_OFFSET);
  slot.entryOrderId = null;
  slot.reentries += 1;
  slot.position = {
    shares, entryPrice: fillPrice, cost, tpPrice,
    tpOrderId: null, tpPending: true, exiting: false,
    closed: false, won: null, closedReason: null,
  };

  registerTrade({ ladder: ladder.key, symbol: ladder.symbol, side: 'BUY', outcome: ladder.side, reason: 'ENTRY', price: fillPrice, shares, cost, fee, level: slot.level, reentry: slot.reentries });
  log(`✅ [${ladder.key}] market buy filled @ ${fillPrice.toFixed(2)} (rung ${slot.level.toFixed(2)}) — ${shares}sh, watching for TP @ ${tpPrice.toFixed(2)} (entry+${TP_OFFSET.toFixed(2)}) — re-entry #${slot.reentries}`);
  recordEquity();
}

// Fires a market SELL the instant bid reaches this position's own TP price
// (entry + TP_OFFSET). Checked every tick for every rung currently holding.
async function attemptExit(ladder, slot) {
  const pos = slot.position;
  if (!pos || pos.closed || !pos.tpPending) return;
  if (pos.exiting) return; // a sell call is already in flight for this position
  const bid = currentBid(ladder);
  if (bid == null || bid < pos.tpPrice) return; // price hasn't reached this rung's TP yet

  pos.exiting = true;
  try {
    const tokenId = tokenIdFor(ladder);
    const resp = await placeMarketSell(tokenId, pos.shares, bid);
    if (!resp || !resp.filled) return; // LIVE trader missing methods, call failed, or didn't fill — retry next tick
    pos.tpOrderId = resp.id;
    await onTPFilled(ladder, slot, resp.avgPrice != null ? resp.avgPrice : bid, resp.filledShares || pos.shares);
  } finally {
    if (slot.position) slot.position.exiting = false;
  }
}

async function onTPFilled(ladder, slot, fillPrice, filledShares) {
  const pos = slot.position;
  if (!pos || pos.closed) return;
  const shares = filledShares > 0 ? filledShares : pos.shares;
  const proceeds = round2(shares * fillPrice);
  const fee = orderFee(shares, fillPrice);
  const profit = round2(proceeds - pos.cost - fee);

  bankroll = round2(bankroll + proceeds);
  realizedPnl = round2(realizedPnl + profit);
  feesPaid = round2(feesPaid + fee);
  wins++;
  pos.closed = true;
  pos.won = true;
  pos.closedReason = 'TP';
  pos.tpPending = false;

  registerTrade({ ladder: ladder.key, symbol: ladder.symbol, side: 'SELL', outcome: ladder.side, reason: 'TP', price: fillPrice, shares, profit, level: slot.level });
  log(`💰 [${ladder.key}] TP market sell filled @ ${fillPrice.toFixed(2)} (rung ${slot.level.toFixed(2)}) — pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)} — rung is free again, will re-enter next time ask reaches it`);

  slot.position = null;
  recordEquity();
  // Rung is now free — attemptEntry will fire again as soon as ask reaches
  // this rung. Unlimited re-entries per window, just never while holding.
}

// One evaluation pass per ladder per tick — checks exits first (works even
// while paused), then entries (blocked while paused). Identical for
// DRY_RUN and LIVE since a market order resolves synchronously either way.
async function evaluateLadder(ladder) {
  for (const level of ladder.levels) {
    const slot = ladder.slots[String(level)];
    await attemptExit(ladder, slot);
  }
  if (!tradingEnabled) return; // pause blocks NEW entries only, not exits
  for (const level of ladder.levels) {
    const slot = ladder.slots[String(level)];
    await attemptEntry(ladder, slot);
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

  const winners = {}; // symbol -> 'Up' | 'Down' | null
  for (const symbol of SYMBOLS) {
    const m = win.markets[symbol];
    const anyOpen = LADDER_DEFS.filter(d => d.symbol === symbol).some(d => {
      const ladder = win.ladders[d.key];
      return ladder.levels.some(l => {
        const slot = ladder.slots[String(l)];
        return slot.position && !slot.position.closed;
      });
    });
    if (!anyOpen) continue;
    winners[symbol] = await determineWinningSide(m.slug, m.conditionId, m.upBid, m.downBid);
  }

  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    const winner = winners[def.symbol];
    for (const level of ladder.levels) {
      const slot = ladder.slots[String(level)];
      const pos = slot.position;
      if (!pos || pos.closed) continue;

      const won = winner === ladder.side;
      const proceeds = won ? round2(pos.shares * 1) : 0;
      const profit = round2(proceeds - pos.cost);
      bankroll = round2(bankroll + proceeds);
      realizedPnl = round2(realizedPnl + profit);
      if (won) wins++; else losses++;
      pos.closed = true;
      pos.won = won;
      pos.closedReason = 'RESOLUTION';
      const icon = won ? '💰' : '💥';
      log(`${icon} [${ladder.key}] level ${level.toFixed(2)} RESOLUTION ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)} (dashboard bookkeeping only — real redemption is via the separate claim script)`);
      registerTrade({ ladder: ladder.key, symbol: ladder.symbol, side: 'SELL', outcome: ladder.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit, level });
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
        // Still the same (or an earlier/stale) window we deliberately sat
        // out at startup — stay untradable, don't call loadWindow/arm anything.
        win = freshWindowState();
        win.windowStart = ws;
        win.windowEnd = ws + WINDOW_SECS;
        win.tradable = false;
        win.resolvedThisWindow = true;
        return;
      }
      log('⏰ Next window boundary reached — resuming normal trading');
      skipUntilWindowStart = null;
    }

    await loadWindow();
  }
  if (!win.tradable) return;

  const elapsed = nowSec() - win.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !win.resolvedThisWindow) {
    await resolveWindow();
  }
  if (win.resolvedThisWindow) return;

  for (const def of LADDER_DEFS) {
    await evaluateLadder(win.ladders[def.key]);
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
    realFetchError = null;
    realLastUpdated = Date.now();
  } catch (e) {
    realFetchError = e.message;
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildLadderState(ladder) {
  return {
    key: ladder.key, symbol: ladder.symbol, side: ladder.side, min: ladder.min, max: ladder.max,
    ask: currentAsk(ladder), bid: currentBid(ladder),
    levels: ladder.levels.map(level => {
      const slot = ladder.slots[String(level)];
      const pos = slot.position;
      return {
        level,
        entryPending: !pos, // still watching, eligible to fire an entry
        reentries: slot.reentries,
        position: pos ? {
          shares: pos.shares, entryPrice: pos.entryPrice, cost: pos.cost,
          tpPrice: pos.tpPrice, tpPending: pos.tpPending, closed: pos.closed,
        } : null,
      };
    }),
  };
}

function buildState() {
  const mv = markValue();
  let costBasis = 0;
  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const level of ladder.levels) {
      const pos = ladder.slots[String(level)].position;
      if (pos && !pos.closed) costBasis += pos.cost;
    }
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
    ladders: LADDER_DEFS.map(d => buildLadderState(win.ladders[d.key])),
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    realizedPnl, unrealizedPnl, feesPaid, wins, losses,
    totalPnl: round2(mv - TOTAL_CAPITAL),
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      gridStep: GRID_STEP, tpOffset: TP_OFFSET, entryShares: ENTRY_SHARES,
      takerFeeRate: TAKER_FEE_RATE, orderType: 'market',
      upRange: [LADDER_DEFS.find(d => d.side === 'Up')?.min, LADDER_DEFS.find(d => d.side === 'Up')?.max],
      downRange: [LADDER_DEFS.find(d => d.side === 'Down')?.min, LADDER_DEFS.find(d => d.side === 'Down')?.max],
    },
    equityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
    real: {
      enabled: !DRY_RUN,
      wallet: tradingWalletAddress(),
      balance: realBalance,
      positions: realPositions,
      lastUpdated: realLastUpdated,
      error: realFetchError,
    },
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastPolyPriceFetch = 0, lastRealAccountFetch = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) {
        lastPolyPriceFetch = now;
        await refreshPrices();
      }
      if (now - lastRealAccountFetch >= REAL_ACCOUNT_REFRESH_MS) {
        lastRealAccountFetch = now;
        await refreshRealAccount();
      }
      await tick();
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(_list) {
  // This bot always trades BTC+ETH grid ladders on the 15m window — retained as a no-op for API compatibility with the dashboard.
  return { ok: true, symbols: SYMBOLS, ladders: LADDER_DEFS.map(d => d.key) };
}
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (open positions/TPs still watched for exit; no new entries will fire)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) {
    log(DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real market orders');
    if (!DRY_RUN) refreshRealAccount().catch(() => {}); // don't make the dashboard wait up to 5s to see real balance
  }
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log('🚀 Grid-Ladder Bot — BTC-Up / ETH-Down, 15-minute windows only');
  log(`⚙️  $${TOTAL_CAPITAL} capital (shared across both ladders)`);
  log('⚙️  Ladders: BTC-Up [0.15-0.45] | ETH-Down [0.55-0.85] — independent, both can hold at once, BTC-Down/ETH-Up disabled');
  log(`⚙️  Grid: entry every ${GRID_STEP.toFixed(2)} across each range, TP = entry + ${TP_OFFSET.toFixed(2)} per rung, no SL — unfilled TPs ride to resolution`);
  log(`⚙️  Re-entry: unlimited per rung, but only after that rung's current position closes via TP (never re-fires while holding)`);
  log(`⚙️  Sizing: fixed ${ENTRY_SHARES}sh per entry | market orders — fire the instant price reaches trigger, not resting limit orders`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  const ws0 = currentWindowStart(WINDOW_SECS);
  const elapsed0 = nowSec() - ws0;
  if (elapsed0 > STARTUP_GRACE_SECS) {
    skipUntilWindowStart = ws0;
    log(`⏳ Started ${elapsed0.toFixed(0)}s into an in-progress ${WINDOW_SECS}s window — sitting this one out, will arm the grid fresh at the next window boundary`);
  }

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
