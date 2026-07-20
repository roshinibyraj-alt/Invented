'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET GRID-LADDER BOT — BTC/ETH UP/DOWN, 15-MINUTE WINDOWS
 * ═══════════════════════════════════════════════════════════════
 *
 *  Trades ONLY the 15-minute Up/Down windows for BTC and ETH.
 *  There are FOUR fully independent grid ladders, sharing one bankroll
 *  but never otherwise interacting with each other:
 *
 *    BTC-Up    range 0.30 – 0.90
 *    BTC-Down  range 0.25 – 0.85
 *    ETH-Up    range 0.30 – 0.90
 *    ETH-Down  range 0.25 – 0.85
 *
 *  GRID: each ladder has fixed entry levels every 0.05 across its range
 *  (e.g. Up: 0.30, 0.35, 0.40 … 0.90). At window open, a resting limit
 *  BUY order is placed at every level. As price drops to/through a
 *  level, that level's order fills.
 *
 *  TP: every fill gets its own resting limit SELL at entry + 0.10.
 *  When that TP fills, the slot is freed and IMMEDIATELY re-arms a
 *  fresh resting buy at the same level — a level can re-enter many
 *  times in the same window. Ladders are independent of one another.
 *
 *  NO STOP LOSS: anything still open (filled, TP not yet hit) when the
 *  window ends simply rides to real settlement ($1 win / $0 loss per
 *  share). A separate, independent auto-claim script handles real
 *  on-chain redemption; this bot's bookkeeping just mirrors it via the
 *  public Gamma API so the dashboard's P&L stays meaningful.
 *
 *  ORDER STYLE: resting limit orders (maker), not marketable/taker
 *  orders. In DRY_RUN, fills are simulated locally against the live
 *  polled ask/bid feed. In LIVE mode this calls out to the trader
 *  module — see the "trader interface" note below.
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
 *    trader.placeLimitBuy(tokenId, price, size)
 *      -> { id, filled, avgPrice, filledShares }   // filled=true if the
 *         order was immediately marketable, false if it now rests
 *    trader.placeLimitSell(tokenId, price, size)
 *      -> same shape as placeLimitBuy
 *    trader.getOrder(orderId)
 *      -> { filled, avgPrice, filledShares }        // poll a resting order
 *    trader.cancelOrder(orderId)
 *      -> void / resolves when cancelled
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com'; // public, no-auth — real wallet balance/positions

const TICK_MS                 = 500;
const POLY_PRICE_REFRESH_MS   = 1000;
const REAL_ACCOUNT_REFRESH_MS = 5000; // how often to pull real balance/positions in live mode
const ORDER_POLL_MS           = 2000; // how often to poll resting LIVE order fills
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
const GRID_STEP      = Number(process.env.GRID_STEP || 0.05);
const TP_OFFSET       = Number(process.env.TP_OFFSET || 0.10);
const ENTRY_SHARES    = Number(process.env.ENTRY_SHARES || 50); // fixed size per individual grid entry
const MAKER_FEE_RATE  = Number(process.env.MAKER_FEE_RATE || 0); // resting orders are maker fills — no taker fee by default

// Ladder definitions: 4 fully independent grids sharing one bankroll.
const LADDER_DEFS = [
  { key: 'BTC-Up',   symbol: 'BTC', side: 'Up',   min: 0.30, max: 0.90 },
  { key: 'BTC-Down', symbol: 'BTC', side: 'Down', min: 0.25, max: 0.85 },
  { key: 'ETH-Up',   symbol: 'ETH', side: 'Up',   min: 0.30, max: 0.90 },
  { key: 'ETH-Down', symbol: 'ETH', side: 'Down', min: 0.25, max: 0.85 },
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

function makerFee(shares, price) {
  return MAKER_FEE_RATE > 0 ? round5(shares * MAKER_FEE_RATE * price) : 0;
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

function traderHasLimitMethods() {
  const ok = trader && typeof trader.placeLimitBuy === 'function' && typeof trader.placeLimitSell === 'function';
  if (!ok && !warnedNoTraderLimitMethods) {
    warnedNoTraderLimitMethods = true;
    log('❌ LIVE grid trading needs trader.placeLimitBuy / trader.placeLimitSell (and ideally getOrder / cancelOrder) on polymarket-trader.js — these are missing, so LIVE order actions will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}

// Resting limit BUY. DRY_RUN: purely bookkeeping, actual fill is detected by
// price-crossing simulation in tickLadder. LIVE: places a real resting order.
async function placeRestingBuy(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethods()) return null;
    try {
      return await trader.placeLimitBuy(tokenId, price, shares);
    } catch (e) {
      log(`❌ placeLimitBuy failed: ${describeOrderError(e)}`);
      return null;
    }
  }
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: false };
}
async function placeRestingSell(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethods()) return null;
    try {
      return await trader.placeLimitSell(tokenId, price, shares);
    } catch (e) {
      log(`❌ placeLimitSell failed: ${describeOrderError(e)}`);
      return null;
    }
  }
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: false };
}
async function cancelRestingOrder(orderId) {
  if (!orderId || orderId.startsWith('dry-')) return;
  if (!DRY_RUN && trader && typeof trader.cancelOrder === 'function') {
    try { await trader.cancelOrder(orderId); } catch (e) { log(`⚠️  cancelOrder failed: ${describeOrderError(e)}`); }
  }
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
    entryPending: false,   // a resting buy order is currently live at this level
    position: null,        // { shares, entryPrice, cost, tpPrice, tpOrderId, tpPending, closed, won, closedReason }
    reentries: 0,           // number of times this level has filled this window
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

  // Arm the full grid — a resting buy at every level of every ladder.
  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const level of ladder.levels) {
      await armEntry(ladder, ladder.slots[String(level)]);
    }
  }
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

async function armEntry(ladder, slot) {
  if (!tradingEnabled) return;
  if (slot.position) return;      // slot already holding a position
  if (slot.entryPending) return;  // already resting
  const tokenId = tokenIdFor(ladder);
  if (!tokenId) return;
  if (!affordable(ENTRY_SHARES, slot.level)) return; // skip silently — will retry next tick once bankroll frees up

  const resp = await placeRestingBuy(tokenId, slot.level, ENTRY_SHARES);
  if (!resp) return; // LIVE trader missing methods, or the call failed — already logged
  slot.entryOrderId = resp.id;
  slot.entryPending = true;

  if (resp.filled) {
    // Immediately marketable — handle the fill right away.
    await onEntryFilled(ladder, slot, resp.avgPrice || slot.level, resp.filledShares || ENTRY_SHARES);
  }
}

async function onEntryFilled(ladder, slot, fillPrice, filledShares) {
  const shares = filledShares > 0 ? filledShares : ENTRY_SHARES;
  const cost = round2(shares * fillPrice);
  const fee = makerFee(shares, fillPrice);
  bankroll = round2(bankroll - cost);
  feesPaid = round2(feesPaid + fee);

  const tpPrice = round2(slot.level + TP_OFFSET);
  slot.entryPending = false;
  slot.entryOrderId = null;
  slot.reentries += 1;
  slot.position = {
    shares, entryPrice: fillPrice, cost, tpPrice,
    tpOrderId: null, tpPending: false,
    closed: false, won: null, closedReason: null,
  };

  registerTrade({ ladder: ladder.key, symbol: ladder.symbol, side: 'BUY', outcome: ladder.side, reason: 'ENTRY', price: fillPrice, shares, cost, fee, level: slot.level, reentry: slot.reentries });
  log(`✅ [${ladder.key}] entry filled @ ${fillPrice.toFixed(2)} (level ${slot.level.toFixed(2)}) — ${shares}sh, TP armed @ ${tpPrice.toFixed(2)} (re-entry #${slot.reentries})`);

  // Arm the TP immediately.
  const tokenId = tokenIdFor(ladder);
  const tpResp = await placeRestingSell(tokenId, tpPrice, shares);
  if (tpResp) {
    slot.position.tpOrderId = tpResp.id;
    slot.position.tpPending = true;
    if (tpResp.filled) {
      await onTPFilled(ladder, slot, tpResp.avgPrice || tpPrice, tpResp.filledShares || shares);
    }
  }
  recordEquity();
}

async function onTPFilled(ladder, slot, fillPrice, filledShares) {
  const pos = slot.position;
  if (!pos || pos.closed) return;
  const shares = filledShares > 0 ? filledShares : pos.shares;
  const proceeds = round2(shares * fillPrice);
  const fee = makerFee(shares, fillPrice);
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
  log(`💰 [${ladder.key}] TP hit @ ${fillPrice.toFixed(2)} (level ${slot.level.toFixed(2)}) — pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)} — re-arming level`);

  slot.position = null;
  recordEquity();
  await armEntry(ladder, slot); // re-enter — grid levels can refill many times per window
}

// Tick a single ladder: DRY_RUN simulates fills purely from the live price
// feed (ask crossing the entry level, bid crossing the TP level). LIVE
// relies on real order fills detected via the polling loop below, but we
// still opportunistically check here in case a resp came back filled=true
// synchronously (handled in armEntry / onEntryFilled already).
function tickLadderDryRun(ladder) {
  const ask = currentAsk(ladder);
  const bid = currentBid(ladder);
  for (const level of ladder.levels) {
    const slot = ladder.slots[String(level)];
    const pos = slot.position;
    if (pos && !pos.closed && pos.tpPending) {
      if (bid != null && bid >= pos.tpPrice) {
        onTPFilled(ladder, slot, pos.tpPrice, pos.shares).catch(e => log(`⚠️  TP fill error: ${e.message}`));
      }
      continue;
    }
    if (!pos && slot.entryPending && ask != null && ask <= level) {
      onEntryFilled(ladder, slot, level, ENTRY_SHARES).catch(e => log(`⚠️  entry fill error: ${e.message}`));
    }
  }
}

// ─────────────────────────────────────────
//  LIVE order-fill polling
// ─────────────────────────────────────────
async function pollLiveOrders() {
  if (DRY_RUN || !trader || typeof trader.getOrder !== 'function') return;
  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const level of ladder.levels) {
      const slot = ladder.slots[String(level)];
      if (slot.entryPending && slot.entryOrderId) {
        try {
          const st = await trader.getOrder(slot.entryOrderId);
          if (st && st.filled) await onEntryFilled(ladder, slot, st.avgPrice || level, st.filledShares || ENTRY_SHARES);
        } catch (e) { log(`⚠️  getOrder (entry) failed: ${describeOrderError(e)}`); }
      }
      const pos = slot.position;
      if (pos && !pos.closed && pos.tpPending && pos.tpOrderId) {
        try {
          const st = await trader.getOrder(pos.tpOrderId);
          if (st && st.filled) await onTPFilled(ladder, slot, st.avgPrice || pos.tpPrice, st.filledShares || pos.shares);
        } catch (e) { log(`⚠️  getOrder (tp) failed: ${describeOrderError(e)}`); }
      }
    }
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
    const anyOpenOrPending = LADDER_DEFS.filter(d => d.symbol === symbol).some(d => {
      const ladder = win.ladders[d.key];
      return ladder.levels.some(l => {
        const slot = ladder.slots[String(l)];
        return slot.entryPending || (slot.position && !slot.position.closed);
      });
    });
    if (!anyOpenOrPending) continue;
    winners[symbol] = await determineWinningSide(m.slug, m.conditionId, m.upBid, m.downBid);
  }

  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    const winner = winners[def.symbol];
    for (const level of ladder.levels) {
      const slot = ladder.slots[String(level)];

      // Cancel any still-resting entry order — window's over, no new fills wanted.
      if (slot.entryPending) {
        await cancelRestingOrder(slot.entryOrderId);
        slot.entryPending = false;
        slot.entryOrderId = null;
      }

      const pos = slot.position;
      if (!pos || pos.closed) continue;

      // Cancel the resting TP too — real settlement will pay out directly.
      if (pos.tpPending) await cancelRestingOrder(pos.tpOrderId);

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
    await loadWindow();
  }
  if (!win.tradable) return;

  const elapsed = nowSec() - win.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !win.resolvedThisWindow) {
    await resolveWindow();
  }
  if (win.resolvedThisWindow) return;

  if (DRY_RUN) {
    for (const def of LADDER_DEFS) tickLadderDryRun(win.ladders[def.key]);
  }
  // In LIVE mode fills are detected via pollLiveOrders() in mainLoop.

  if (!tradingEnabled) return; // pause only blocks NEW arm attempts, not exit/TP management
  for (const def of LADDER_DEFS) {
    const ladder = win.ladders[def.key];
    for (const level of ladder.levels) {
      await armEntry(ladder, ladder.slots[String(level)]);
    }
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
        entryPending: slot.entryPending,
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
      makerFeeRate: MAKER_FEE_RATE,
      upRange: [0.30, 0.90], downRange: [0.25, 0.85],
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
  let lastPolyPriceFetch = 0, lastRealAccountFetch = 0, lastOrderPoll = 0;
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
      if (!DRY_RUN && now - lastOrderPoll >= ORDER_POLL_MS) {
        lastOrderPoll = now;
        await pollLiveOrders();
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
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (open positions/TPs still managed; no new grid entries armed)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) {
    log(DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real resting orders');
    if (!DRY_RUN) refreshRealAccount().catch(() => {}); // don't make the dashboard wait up to 5s to see real balance
  }
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log('🚀 Grid-Ladder Bot — BTC/ETH Up/Down, 15-minute windows only');
  log(`⚙️  $${TOTAL_CAPITAL} capital (shared across all 4 ladders)`);
  log('⚙️  Ladders: BTC-Up [0.30-0.90] | BTC-Down [0.25-0.85] | ETH-Up [0.30-0.90] | ETH-Down [0.25-0.85] — fully independent');
  log(`⚙️  Grid: entry every ${GRID_STEP.toFixed(2)} across each range, TP = entry + ${TP_OFFSET.toFixed(2)}, no SL — unfilled TPs ride to resolution`);
  log(`⚙️  Sizing: fixed ${ENTRY_SHARES}sh per entry | resting limit orders (maker) | levels re-arm immediately after a TP fills — unlimited re-entries per window`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
