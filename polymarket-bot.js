'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET CROSS-PAIR COMBO BOT — BTC/ETH UP/DOWN, 5m + 15m
 * ═══════════════════════════════════════════════════════════════
 *
 *  Complete rewrite. Trades BTC and ETH Up/Down markets together as
 *  paired combos, run as TWO fully independent window instances — a
 *  5-minute instance and a 15-minute instance — both pulling from the
 *  same shared bankroll, never interacting with each other otherwise.
 *
 *  COMBOS (per instance, each tracked independently):
 *    Combo A = BTC-Up  ask + ETH-Down ask
 *    Combo B = BTC-Down ask + ETH-Up  ask
 *
 *  TRIGGER (per combo, once per window, no repeat if missed):
 *    Watch the combined ask price from window start. If it drops below
 *    0.80 at any point before the cutoff, fire the combo:
 *      - 5m instance:  cutoff = 3.5 min  (210s of 300s window)
 *      - 15m instance: cutoff = 10.5 min (630s of 900s window)
 *    Cutoff is a fixed 70% of window length for both instances.
 *    If the cutoff passes without the combo dropping below 0.80, that
 *    combo simply does not trade this window.
 *
 *  EXECUTION: once a combo fires, BOTH legs are bought immediately as
 *    marketable buys at the current ask (taker fee applies) — not
 *    resting limit orders — so both legs land together rather than
 *    risking a one-sided fill. Affordability (bankroll) is checked for
 *    the combined cost of both legs before either leg is sent.
 *    Size: 100 shares per leg, on both timeframes.
 *
 *  EXIT: none. No TP, no SL. Both legs simply ride to actual window
 *    resolution (real settlement pays $1 or $0/share). This bot's own
 *    bookkeeping simulates that via the public Gamma API purely to
 *    keep the dashboard's P&L figures meaningful. A separate,
 *    independent auto-claim script handles real redemption.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable (see setMode) — dashboard
 *    has a one-click toggle plus an independent pause button.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // stop trading this close to window end, go to resolution
const SLUG_OFFSET_FALLBACKS_FACTORY = (windowSecs) => [0, -windowSecs, windowSecs];

const SYMBOLS = ['BTC', 'ETH'];
const INSTANCE_DEFS = [
  { key: '5m',  windowSecs: 300 },
  { key: '15m', windowSecs: 900 },
];

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // runtime-switchable — see setMode
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const COMBO_THRESHOLD        = Number(process.env.COMBO_THRESHOLD || 0.80);
const COMBO_TRIGGER_FRACTION = Number(process.env.COMBO_TRIGGER_FRACTION || 0.70); // cutoff as fraction of window length
const COMBO_SHARES           = Number(process.env.COMBO_SHARES || 100); // per leg, both timeframes

const CRYPTO_TAKER_FEE_RATE = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);

// ═══════════════════════════════════════════════════════════════
//  ORACLE-LAG STRATEGY — separate strategy, separate bankroll, same
//  process/dashboard. Watches the last slice of each BTC 5m window;
//  if the BTC-PERP Oracle price has clearly moved from its window-open
//  reference but the winning side's ask hasn't caught up, buys it.
//  Never opens a perp position — Oracle price is read-only signal data.
//  Everything below prefixed OL_/ol* is fully independent of the combo
//  bot's instances/bankroll/state above.
// ═══════════════════════════════════════════════════════════════
const PERPS = 'https://api.perpetuals.polymarket.com';
const OL_SYMBOL             = 'BTC';
const OL_WINDOW_SECS        = 300; // 5m only
const OL_TOTAL_CAPITAL      = Number(process.env.OL_TOTAL_CAPITAL || 1000);
const OL_STAKE_USD          = Number(process.env.OL_STAKE_USD || 50);
const OL_LAG_WINDOW_FRACTION = Number(process.env.OL_LAG_WINDOW_FRACTION || 0.20);
const OL_MOVE_THRESHOLD_PCT = Number(process.env.OL_MOVE_THRESHOLD_PCT || 0.0004);
const OL_MAX_ENTRY_ASK      = Number(process.env.OL_MAX_ENTRY_ASK || 0.90);
const OL_MIN_REMAINING_SECS = Number(process.env.OL_MIN_REMAINING_SECS || 3);
const OL_ORACLE_REFRESH_MS  = 1000;
const OL_BINARY_REFRESH_MS  = 1000;

let olDryRun = (process.env.OL_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // independent live/demo toggle
let olTradingEnabled = true;
let olBankroll = OL_TOTAL_CAPITAL;
let olRealizedPnl = 0, olFeesPaid = 0, olWins = 0, olLosses = 0;
let olEquityCurve = [{ t: Date.now(), equity: OL_TOTAL_CAPITAL }];
let olLogs = [];
let olTrades = [];
let olPerpInstrumentId = null;

function freshOlState() {
  return {
    tradable: false,
    windowStart: null, windowEnd: null,
    resolvedThisWindow: true,
    referencePrice: null, oraclePrice: null,
    triggered: false,
    market: { slug: null, conditionId: null, upTokenId: null, downTokenId: null, upAsk: null, upBid: null, downAsk: null, downBid: null },
    position: null, // { side, shares, entryPrice, cost, closed }
  };
}
let olState = freshOlState();

function olLog(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] [oracle-lag] ${msg}`;
  olLogs.push(line);
  if (olLogs.length > 400) olLogs.shift();
  slog(line);
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

// Combo leg definitions: which symbol/side belongs to each combo.
const COMBO_LEGS = {
  A: [ { symbol: 'BTC', side: 'Up' },   { symbol: 'ETH', side: 'Down' } ],
  B: [ { symbol: 'BTC', side: 'Down' }, { symbol: 'ETH', side: 'Up' } ],
};
const COMBO_LABEL = { A: 'BTC Up + ETH Down', B: 'BTC Down + ETH Up' };

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-combo-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-combo-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// Marketable buy — priced at the current ask so it fills now (taker).
async function placeMarketableBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}

// ─────────────────────────────────────────
//  Per-instance market state
// ─────────────────────────────────────────
function freshMarketSlot() {
  return {
    slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
  };
}
function freshComboSlot() {
  return {
    triggered: false, // one-shot per window
    positions: { BTC: null, ETH: null }, // filled legs: {shares, entryPrice, cost, side, closed}
  };
}
function freshInstanceState(def) {
  return {
    key: def.key,
    windowSecs: def.windowSecs,
    cutoffSecs: Math.round(def.windowSecs * COMBO_TRIGGER_FRACTION),
    tradable: false,
    windowStart: null, windowEnd: null,
    resolvedThisWindow: true,
    markets: { BTC: freshMarketSlot(), ETH: freshMarketSlot() },
    combos: { A: freshComboSlot(), B: freshComboSlot() },
  };
}

let instances = INSTANCE_DEFS.map(freshInstanceState);

// ─────────────────────────────────────────
//  Slug / window math
// ─────────────────────────────────────────
function currentWindowStart(windowSecs, tsSec = nowSec()) { return Math.floor(tsSec / windowSecs) * windowSecs; }
function windowLabel(windowSecs) { return windowSecs === 300 ? '5m' : windowSecs === 900 ? '15m' : `${Math.round(windowSecs / 60)}m`; }
function slugFor(symbol, windowSecs, windowStartSec) { return `${symbol.toLowerCase()}-updown-${windowLabel(windowSecs)}-${windowStartSec}`; }
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
async function fetchEventForWindow(symbol, windowSecs, windowStart) {
  for (const offset of SLUG_OFFSET_FALLBACKS_FACTORY(windowSecs)) {
    const ws = windowStart + offset;
    if (ws + windowSecs <= nowSec()) continue;
    const slug = slugFor(symbol, windowSecs, ws);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) return { event, windowStart: ws, slug };
    } catch (_) {}
  }
  return null;
}

async function loadInstanceWindow(inst) {
  const ws = currentWindowStart(inst.windowSecs);
  if (inst.windowStart === ws && inst.markets.BTC.upTokenId && inst.markets.ETH.upTokenId) return;

  const [foundBtc, foundEth] = await Promise.all([
    fetchEventForWindow('BTC', inst.windowSecs, ws),
    fetchEventForWindow('ETH', inst.windowSecs, ws),
  ]);
  if (!foundBtc || !foundEth) { inst.tradable = false; return; }

  // Both symbols must agree on the actual window start we found (fallback offsets could disagree).
  if (foundBtc.windowStart !== foundEth.windowStart) { inst.tradable = false; return; }

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
  if (!btcSlot || !ethSlot) { log(`⚠️  [${inst.key}] window loaded but Up/Down token ids missing`); inst.tradable = false; return; }

  const fresh = freshInstanceState(INSTANCE_DEFS.find(d => d.key === inst.key));
  fresh.windowStart = foundBtc.windowStart;
  fresh.windowEnd = foundBtc.windowStart + inst.windowSecs;
  fresh.markets.BTC = btcSlot;
  fresh.markets.ETH = ethSlot;
  fresh.tradable = true;
  fresh.resolvedThisWindow = false;
  Object.assign(inst, fresh);
  log(`🔭 [${inst.key}] window loaded: BTC=${btcSlot.slug} ETH=${ethSlot.slug} | ends ${new Date(fresh.windowEnd * 1000).toISOString().slice(11, 19)}Z | trigger cutoff=${fresh.cutoffSecs}s`);
}

// ─────────────────────────────────────────
//  Polymarket price feed
// ─────────────────────────────────────────
async function refreshInstancePrices(inst) {
  if (!inst.tradable) return;
  const requests = [];
  for (const symbol of SYMBOLS) {
    const m = inst.markets[symbol];
    if (!m.upTokenId || !m.downTokenId) continue;
    requests.push({ token_id: m.upTokenId, side: 'BUY' }, { token_id: m.upTokenId, side: 'SELL' });
    requests.push({ token_id: m.downTokenId, side: 'BUY' }, { token_id: m.downTokenId, side: 'SELL' });
  }
  if (!requests.length) return;

  function apply(tid, side, price) {
    if (!Number.isFinite(price)) return;
    for (const symbol of SYMBOLS) {
      const m = inst.markets[symbol];
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
      const m = inst.markets[symbol];
      if (!m.upTokenId || !m.downTokenId) continue;
      try {
        const [upAsk, upBid, downAsk, downBid] = await Promise.all([
          getJSON(`${CLOB}/price?token_id=${m.upTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${m.upTokenId}&side=SELL`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${m.downTokenId}&side=BUY`).catch(() => null),
          getJSON(`${CLOB}/price?token_id=${m.downTokenId}&side=SELL`).catch(() => null),
        ]);
        if (upAsk) m.upAsk = parseFloat(upAsk.price || upAsk.mid || m.upAsk);
        if (upBid) m.upBid = parseFloat(upBid.price || upBid.mid || m.upBid);
        if (downAsk) m.downAsk = parseFloat(downAsk.price || downAsk.mid || m.downAsk);
        if (downBid) m.downBid = parseFloat(downBid.price || downBid.mid || m.downBid);
      } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function markValue() {
  let held = 0;
  for (const inst of instances) {
    for (const comboKey of ['A', 'B']) {
      const combo = inst.combos[comboKey];
      for (const symbol of SYMBOLS) {
        const pos = combo.positions[symbol];
        if (!pos || pos.closed) continue;
        const m = inst.markets[symbol];
        const bid = pos.side === 'Up' ? m.upBid : m.downBid;
        held += pos.shares * (bid ?? pos.entryPrice);
      }
    }
  }
  return round2(bankroll + held);
}
function recordEquity() {
  equityCurve.push({ t: Date.now(), equity: markValue() });
  if (equityCurve.length > 500) equityCurve.shift();
}
function registerTrade(entry) {
  trades.push({ time: new Date().toISOString().slice(11, 19), ...entry });
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Combo trigger + execution
// ─────────────────────────────────────────
function comboAskSum(inst, comboKey) {
  const legs = COMBO_LEGS[comboKey];
  let sum = 0;
  for (const leg of legs) {
    const m = inst.markets[leg.symbol];
    const ask = leg.side === 'Up' ? m.upAsk : m.downAsk;
    if (ask == null) return null;
    sum += ask;
  }
  return sum;
}

async function checkComboTrigger(inst, comboKey) {
  const combo = inst.combos[comboKey];
  if (combo.triggered) return;

  const elapsed = nowSec() - inst.windowStart;
  if (elapsed >= inst.cutoffSecs) return; // past cutoff — this combo just doesn't trade this window

  const sum = comboAskSum(inst, comboKey);
  if (sum == null || sum >= COMBO_THRESHOLD) return;

  const legs = COMBO_LEGS[comboKey];

  // Price out both legs first, so we only commit if we can afford BOTH.
  const priced = legs.map(leg => {
    const m = inst.markets[leg.symbol];
    const ask = leg.side === 'Up' ? m.upAsk : m.downAsk;
    const tokenId = leg.side === 'Up' ? m.upTokenId : m.downTokenId;
    const fee = takerFee(COMBO_SHARES, ask);
    const cost = round2(ask * COMBO_SHARES + fee);
    return { ...leg, ask, tokenId, fee, cost };
  });
  const totalCost = round2(priced.reduce((s, p) => s + p.cost, 0));
  if (totalCost > bankroll) {
    log(`⏭️  [${inst.key}] Combo ${comboKey} (${COMBO_LABEL[comboKey]}) triggered @ sum=${sum.toFixed(3)} but insufficient bankroll ($${totalCost.toFixed(2)} needed), skipping`);
    combo.triggered = true; // still one-shot — don't keep re-checking a combo we can't afford
    return;
  }

  combo.triggered = true; // lock in before awaiting, so a concurrent tick can't double-fire

  for (const leg of priced) {
    await placeMarketableBuy(leg.tokenId, leg.ask, COMBO_SHARES);
    bankroll = round2(bankroll - leg.cost);
    feesPaid = round2(feesPaid + leg.fee);
    combo.positions[leg.symbol] = { shares: COMBO_SHARES, entryPrice: leg.ask, cost: leg.cost, side: leg.side, closed: false };
    registerTrade({ instance: inst.key, combo: comboKey, symbol: leg.symbol, side: 'BUY', outcome: leg.side, price: leg.ask, shares: COMBO_SHARES, cost: leg.cost, fee: leg.fee });
  }
  recordEquity();
  log(`🔔 [${inst.key}] Combo ${comboKey} (${COMBO_LABEL[comboKey]}) TRIGGERED @ sum=${sum.toFixed(3)} (< ${COMBO_THRESHOLD}) — bought ${COMBO_SHARES}sh each leg: BTC ${priced[0].side}@${priced[0].ask.toFixed(2)} / ETH ${priced[1].side}@${priced[1].ask.toFixed(2)} | total cost=$${totalCost.toFixed(2)} | no exit mgmt — rides to resolution`);
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

async function resolveInstanceWindow(inst) {
  if (inst.resolvedThisWindow) return;
  inst.resolvedThisWindow = true;

  for (const symbol of SYMBOLS) {
    const m = inst.markets[symbol];
    const anyOpen = ['A', 'B'].some(k => { const p = inst.combos[k].positions[symbol]; return p && !p.closed; });
    if (!anyOpen) continue;
    const winner = await determineWinningSide(m.slug, m.conditionId, m.upBid, m.downBid);

    for (const comboKey of ['A', 'B']) {
      const pos = inst.combos[comboKey].positions[symbol];
      if (!pos || pos.closed) continue;
      const won = winner === pos.side;
      const proceeds = won ? round2(pos.shares * 1) : 0;
      const profit = round2(proceeds - pos.cost);
      bankroll = round2(bankroll + proceeds);
      realizedPnl = round2(realizedPnl + profit);
      if (won) wins++; else losses++;
      pos.closed = true;
      const icon = won ? '💰' : '💥';
      log(`${icon} [${inst.key}] Combo ${comboKey} ${symbol} ${pos.side} RESOLUTION ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)} (dashboard bookkeeping only — real redemption is via the separate claim script)`);
      registerTrade({ instance: inst.key, combo: comboKey, symbol, side: 'SELL', outcome: pos.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
    }
  }
  recordEquity();
}

// ─────────────────────────────────────────
//  ORACLE-LAG: perp Oracle price feed (read-only — never trades the perp)
// ─────────────────────────────────────────
async function olResolvePerpInstrumentId() {
  const data = await getJSON(`${PERPS}/v1/info/instruments`);
  const list = Array.isArray(data) ? data : (data.data || []);
  const match = list.find(i => (i.symbol || '').toUpperCase() === `${OL_SYMBOL}-PERP`);
  if (!match) throw new Error(`Could not find ${OL_SYMBOL}-PERP instrument on Perps API`);
  return match.instrument_id ?? match.id;
}
async function olFetchOraclePrice() {
  if (olPerpInstrumentId == null) return null;
  try {
    const data = await getJSON(`${PERPS}/v1/info/tickers?instrument_id=${olPerpInstrumentId}`);
    const row = Array.isArray(data) ? data[0] : (data.data ? data.data[0] : data);
    if (!row) return null;
    const price = parseFloat(row.index_price ?? row.indexPrice);
    return Number.isFinite(price) ? price : null;
  } catch (e) {
    olLog(`⚠️  Oracle price fetch failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────
//  ORACLE-LAG: market loading + prices (reuses the combo bot's generic
//  slug/window/token helpers above — currentWindowStart, slugFor,
//  fetchEventForWindow, determineWinningSide — nothing combo-specific)
// ─────────────────────────────────────────
async function olLoadWindow() {
  const ws = currentWindowStart(OL_WINDOW_SECS);
  if (olState.windowStart === ws && olState.market.upTokenId) return;

  const found = await fetchEventForWindow(OL_SYMBOL, OL_WINDOW_SECS, ws);
  if (!found) { olState.tradable = false; return; }

  const market = found.event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || found.event.markets[0];
  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) { olLog('⚠️  window loaded but Up/Down token ids missing'); olState.tradable = false; return; }

  const fresh = freshOlState();
  fresh.windowStart = found.windowStart;
  fresh.windowEnd = found.windowStart + OL_WINDOW_SECS;
  fresh.market = { slug: found.slug, conditionId: market.conditionId || null, upTokenId: upId, downTokenId: downId, upAsk: null, upBid: null, downAsk: null, downBid: null };
  fresh.tradable = true;
  fresh.resolvedThisWindow = false;
  Object.assign(olState, fresh);
  olLog(`🔭 window loaded: ${fresh.market.slug} | ends ${new Date(fresh.windowEnd * 1000).toISOString().slice(11, 19)}Z | watch phase starts @ +${Math.round(OL_WINDOW_SECS * (1 - OL_LAG_WINDOW_FRACTION))}s`);
}

async function olRefreshBinaryPrices() {
  if (!olState.tradable) return;
  const m = olState.market;
  const requests = [
    { token_id: m.upTokenId, side: 'BUY' }, { token_id: m.upTokenId, side: 'SELL' },
    { token_id: m.downTokenId, side: 'BUY' }, { token_id: m.downTokenId, side: 'SELL' },
  ];
  function apply(tid, side, price) {
    if (!Number.isFinite(price)) return;
    if (tid === m.upTokenId) { if (side === 'BUY') m.upAsk = price; else m.upBid = price; return; }
    if (tid === m.downTokenId) { if (side === 'BUY') m.downAsk = price; else m.downBid = price; }
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
    try {
      const [upAsk, upBid, downAsk, downBid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${m.upTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${m.upTokenId}&side=SELL`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${m.downTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${m.downTokenId}&side=SELL`).catch(() => null),
      ]);
      if (upAsk) m.upAsk = parseFloat(upAsk.price || upAsk.mid || m.upAsk);
      if (upBid) m.upBid = parseFloat(upBid.price || upBid.mid || m.upBid);
      if (downAsk) m.downAsk = parseFloat(downAsk.price || downAsk.mid || m.downAsk);
      if (downBid) m.downBid = parseFloat(downBid.price || downBid.mid || m.downBid);
    } catch (_) {}
  }
}

function olMarkValue() {
  let held = 0;
  if (olState.position && !olState.position.closed) {
    const bid = olState.position.side === 'Up' ? olState.market.upBid : olState.market.downBid;
    held = olState.position.shares * (bid ?? olState.position.entryPrice);
  }
  return round2(olBankroll + held);
}
function olRecordEquity() {
  olEquityCurve.push({ t: Date.now(), equity: olMarkValue() });
  if (olEquityCurve.length > 500) olEquityCurve.shift();
}
function olRegisterTrade(entry) {
  olTrades.push({ time: new Date().toISOString().slice(11, 19), ...entry });
  if (olTrades.length > 300) olTrades.shift();
}

async function olCheckTrigger() {
  if (olState.triggered || !olTradingEnabled) return;
  if (olState.referencePrice == null || olState.oraclePrice == null) return;

  const elapsed = nowSec() - olState.windowStart;
  const remaining = olState.windowEnd - nowSec();
  const lagWindowStart = OL_WINDOW_SECS * (1 - OL_LAG_WINDOW_FRACTION);
  if (elapsed < lagWindowStart) return;
  if (remaining < OL_MIN_REMAINING_SECS) return;

  const move = (olState.oraclePrice - olState.referencePrice) / olState.referencePrice;
  if (Math.abs(move) < OL_MOVE_THRESHOLD_PCT) return;

  const direction = move > 0 ? 'Up' : 'Down';
  const ask = direction === 'Up' ? olState.market.upAsk : olState.market.downAsk;
  const tokenId = direction === 'Up' ? olState.market.upTokenId : olState.market.downTokenId;
  if (ask == null || ask <= 0 || ask >= OL_MAX_ENTRY_ASK) return;

  const shares = round2(OL_STAKE_USD / ask);
  const fee = takerFee(shares, ask);
  const cost = round2(shares * ask + fee);

  olState.triggered = true; // one-shot per window, lock in before awaiting

  if (cost > olBankroll) {
    olLog(`⏭️  Signal fired (oracle move ${(move * 100).toFixed(3)}% → ${direction}, ask=${ask.toFixed(3)}) but insufficient bankroll ($${cost.toFixed(2)} needed) — skipping`);
    return;
  }

  await placeOlMarketableBuy(tokenId, ask, shares);
  olBankroll = round2(olBankroll - cost);
  olFeesPaid = round2(olFeesPaid + fee);
  olState.position = { side: direction, shares, entryPrice: ask, cost, closed: false };
  olRegisterTrade({ side: 'BUY', outcome: direction, price: ask, shares, cost, fee, movePct: round5(move) });
  olRecordEquity();
  olLog(`🔔 TRIGGERED — oracle ${olState.oraclePrice.toFixed(2)} vs ref ${olState.referencePrice.toFixed(2)} (${(move * 100).toFixed(3)}% move, ${remaining.toFixed(1)}s left) → bought ${shares} ${direction} @ ${ask.toFixed(3)} | cost=$${cost.toFixed(2)} | rides to resolution`);
}

async function placeOlMarketableBuy(tokenId, price, shares) {
  if (!olDryRun && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}

async function olResolveWindow() {
  if (olState.resolvedThisWindow) return;
  olState.resolvedThisWindow = true;

  if (olState.position && !olState.position.closed) {
    const winner = await determineWinningSide(olState.market.slug, olState.market.conditionId, olState.market.upBid, olState.market.downBid);
    const pos = olState.position;
    const won = winner === pos.side;
    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    olBankroll = round2(olBankroll + proceeds);
    olRealizedPnl = round2(olRealizedPnl + profit);
    if (won) olWins++; else olLosses++;
    pos.closed = true;
    const icon = won ? '💰' : '💥';
    olLog(`${icon} RESOLUTION ${pos.side} ${pos.shares}sh entry=${pos.entryPrice.toFixed(3)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${olBankroll.toFixed(2)}`);
    olRegisterTrade({ side: 'SELL', outcome: pos.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
  }
  olRecordEquity();
}

async function olTick() {
  const ws = currentWindowStart(OL_WINDOW_SECS);
  if (olState.windowStart === null || ws !== olState.windowStart) {
    if (olState.windowStart !== null && !olState.resolvedThisWindow) await olResolveWindow();
    await olLoadWindow();
  }
  if (!olState.tradable) return;

  if (olState.referencePrice == null && olState.oraclePrice != null) {
    olState.referencePrice = olState.oraclePrice;
    olLog(`📍 reference price captured @ window open: $${olState.referencePrice.toFixed(2)}`);
  }

  const remaining = olState.windowEnd - nowSec();
  if (remaining <= EARLY_CUTOFF_SECS && !olState.resolvedThisWindow) {
    await olResolveWindow();
  }
  if (olState.resolvedThisWindow) return;

  await olCheckTrigger();
}

function buildOlState() {
  const mv = olMarkValue();
  const remaining = olState.windowEnd ? Math.max(0, Math.floor(olState.windowEnd - nowSec())) : null;
  const lagWindowStart = OL_WINDOW_SECS * (1 - OL_LAG_WINDOW_FRACTION);
  const elapsed = olState.windowStart ? (nowSec() - olState.windowStart) : null;
  const secsToLagWindow = (elapsed != null) ? Math.max(0, Math.round(lagWindowStart - elapsed)) : null;
  const movePct = (olState.oraclePrice != null && olState.referencePrice != null) ? round5((olState.oraclePrice - olState.referencePrice) / olState.referencePrice) : null;

  return {
    dryRun: olDryRun, tradingEnabled: olTradingEnabled, symbol: OL_SYMBOL, windowSecs: OL_WINDOW_SECS,
    tradable: olState.tradable, windowEnd: olState.windowEnd, secsToEnd: remaining, secsToLagWindow,
    inWatchPhase: elapsed != null && elapsed >= lagWindowStart,
    referencePrice: olState.referencePrice, oraclePrice: olState.oraclePrice, movePct,
    triggered: olState.triggered, market: olState.market, position: olState.position,
    totalCapital: OL_TOTAL_CAPITAL, bankroll: olBankroll, markValue: mv,
    realizedPnl: olRealizedPnl, feesPaid: olFeesPaid, wins: olWins, losses: olLosses,
    totalPnl: round2(mv - OL_TOTAL_CAPITAL),
    winRate: (olWins + olLosses) > 0 ? round2((olWins / (olWins + olLosses)) * 100) : null,
    config: { stakeUsd: OL_STAKE_USD, lagWindowFraction: OL_LAG_WINDOW_FRACTION, moveThresholdPct: OL_MOVE_THRESHOLD_PCT, maxEntryAsk: OL_MAX_ENTRY_ASK, minRemainingSecs: OL_MIN_REMAINING_SECS, cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE },
    equityCurve: olEquityCurve, logs: olLogs.slice(-100), trades: olTrades.slice(-80).reverse(),
  };
}

// ─────────────────────────────────────────
//  Main tick
// ─────────────────────────────────────────
async function instanceTick(inst) {
  const ws = currentWindowStart(inst.windowSecs);
  if (inst.windowStart === null || ws !== inst.windowStart) {
    if (inst.windowStart !== null && !inst.resolvedThisWindow) await resolveInstanceWindow(inst);
    await loadInstanceWindow(inst);
  }
  if (!inst.tradable || !tradingEnabled) return;

  const elapsed = nowSec() - inst.windowStart;
  if (elapsed >= inst.windowSecs - EARLY_CUTOFF_SECS && !inst.resolvedThisWindow) {
    await resolveInstanceWindow(inst);
  }
  if (inst.resolvedThisWindow) return;

  await checkComboTrigger(inst, 'A');
  await checkComboTrigger(inst, 'B');
}

async function tick() {
  for (const inst of instances) await instanceTick(inst);
  await olTick(); // separate strategy, separate state — does not touch instances/bankroll above
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildInstanceState(inst) {
  const secsToEnd = inst.windowEnd ? Math.max(0, Math.floor(inst.windowEnd - nowSec())) : null;
  const secsToCutoff = inst.windowStart != null ? Math.max(0, Math.floor((inst.windowStart + inst.cutoffSecs) - nowSec())) : null;
  return {
    key: inst.key, windowSecs: inst.windowSecs, cutoffSecs: inst.cutoffSecs,
    tradable: inst.tradable, windowEnd: inst.windowEnd, secsToEnd, secsToCutoff,
    markets: {
      BTC: { slug: inst.markets.BTC.slug, upAsk: inst.markets.BTC.upAsk, upBid: inst.markets.BTC.upBid, downAsk: inst.markets.BTC.downAsk, downBid: inst.markets.BTC.downBid },
      ETH: { slug: inst.markets.ETH.slug, upAsk: inst.markets.ETH.upAsk, upBid: inst.markets.ETH.upBid, downAsk: inst.markets.ETH.downAsk, downBid: inst.markets.ETH.downBid },
    },
    combos: {
      A: { label: COMBO_LABEL.A, triggered: inst.combos.A.triggered, sum: comboAskSum(inst, 'A'), positions: inst.combos.A.positions },
      B: { label: COMBO_LABEL.B, triggered: inst.combos.B.triggered, sum: comboAskSum(inst, 'B'), positions: inst.combos.B.positions },
    },
  };
}

function buildState() {
  const mv = markValue();
  let costBasis = 0;
  for (const inst of instances) {
    for (const comboKey of ['A', 'B']) {
      for (const symbol of SYMBOLS) {
        const pos = inst.combos[comboKey].positions[symbol];
        if (pos && !pos.closed) costBasis += pos.cost;
      }
    }
  }
  costBasis = round2(costBasis);
  const held = round2(mv - bankroll);
  const unrealizedPnl = round2(held - costBasis);
  return {
    dryRun: DRY_RUN, tradingEnabled, symbols: SYMBOLS,
    instances: instances.map(buildInstanceState),
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    realizedPnl, unrealizedPnl, feesPaid, wins, losses,
    totalPnl: round2(mv - TOTAL_CAPITAL),
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      comboThreshold: COMBO_THRESHOLD, comboTriggerFraction: COMBO_TRIGGER_FRACTION, comboShares: COMBO_SHARES,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
    },
    equityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
    oracleLag: buildOlState(), // separate strategy, separate bankroll/state — see buildOlState()
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastPolyPriceFetch = 0, lastOlOracleFetch = 0, lastOlBinaryFetch = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) {
        lastPolyPriceFetch = now;
        await Promise.all(instances.map(refreshInstancePrices));
      }
      if (now - lastOlOracleFetch >= OL_ORACLE_REFRESH_MS) {
        lastOlOracleFetch = now;
        olState.oraclePrice = await olFetchOraclePrice();
      }
      if (now - lastOlBinaryFetch >= OL_BINARY_REFRESH_MS) {
        lastOlBinaryFetch = now;
        await olRefreshBinaryPrices();
      }
      await tick();
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(_list) {
  // This bot always trades BTC+ETH combos on 5m and 15m — retained as a no-op for API compatibility with the dashboard.
  return { ok: true, symbols: SYMBOLS, instances: INSTANCE_DEFS.map(d => d.key) };
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

// ── Oracle-Lag controls — fully independent of the combo bot's controls above ──
function pauseOracleLag() { olTradingEnabled = false; olLog('⏸️  Trading paused'); return { ok: true }; }
function resumeOracleLag() { olTradingEnabled = true; olLog('▶️  Trading resumed'); return { ok: true }; }
function setOracleLagMode(wantLive) {
  const was = olDryRun;
  olDryRun = !wantLive;
  if (was !== olDryRun) olLog(olDryRun ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real orders');
  return { ok: true, dryRun: olDryRun };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Cross-Pair Combo Bot — BTC/ETH Up/Down, 5m + 15m instances`);
  log(`⚙️  $${TOTAL_CAPITAL} capital (shared across both instances)`);
  log(`⚙️  Combo A = BTC-Up + ETH-Down | Combo B = BTC-Down + ETH-Up | trigger: combined ask < ${COMBO_THRESHOLD} before ${Math.round(COMBO_TRIGGER_FRACTION * 100)}% of window elapses`);
  log(`⚙️  5m instance: cutoff @ ${INSTANCE_DEFS[0].windowSecs * COMBO_TRIGGER_FRACTION}s | 15m instance: cutoff @ ${INSTANCE_DEFS[1].windowSecs * COMBO_TRIGGER_FRACTION}s`);
  log(`⚙️  Execution: marketable buy both legs @ current ask, ${COMBO_SHARES}sh each, once per combo per window | no TP/SL — rides to resolution`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  olLog(`🚀 Oracle-Lag Convergence strategy — BTC 5m Up/Down, separate $${OL_TOTAL_CAPITAL} bankroll, separate live/demo toggle`);
  olLog(`⚙️  stake $${OL_STAKE_USD}/trigger | watch last ${Math.round(OL_LAG_WINDOW_FRACTION * 100)}% of window | move≥${(OL_MOVE_THRESHOLD_PCT * 100).toFixed(2)}% | entry ask<${OL_MAX_ENTRY_ASK} | signal: BTC-PERP Oracle price (read-only, no perp ever traded)`);
  try {
    olPerpInstrumentId = await olResolvePerpInstrumentId();
    olLog(`✅ Resolved ${OL_SYMBOL}-PERP instrument_id=${olPerpInstrumentId} for Oracle price feed`);
  } catch (e) {
    olLog(`❌ Could not resolve ${OL_SYMBOL}-PERP instrument — Oracle signal will be unavailable: ${e.message}`);
  }

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = {
  init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState,
  pauseOracleLag, resumeOracleLag, setOracleLagMode,
};
