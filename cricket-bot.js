'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  CRICKET TRAILING-GRID LADDER — Nepal moneyline, single one-off event
 * ═══════════════════════════════════════════════════════════════
 *
 *  Trades ONLY the Nepal (npl2) outcome of the Moneyline market for the
 *  Nepal vs Namibia match (event slug crint-npl2-nam3-2026-07-21). This
 *  is a single one-off event, not a recurring window like the BTC/ETH
 *  ladders — it runs once until the match resolves, then stops.
 *
 *  GRID: exactly 2 resting-buy rungs active at a time, $0.05 apart. At
 *  startup, both are anchored off the live ask price P: near = P-0.05,
 *  far = P-0.10. Example: P=0.40 -> near=0.35, far=0.30.
 *
 *  TP: each rung's TP = its own entry price + 0.10 (near 0.35 -> TP
 *  0.45, far 0.30 -> TP 0.40 in the example above).
 *
 *  TRAILING RE-ENTRY: the instant a rung's TP fills, that SAME rung
 *  re-arms at old_entry + 0.05 (its own history, not the live price) —
 *  each rung independently climbs by 0.05 every round trip. A rung
 *  stops re-arming once its next entry would push its TP above 0.99
 *  (unreachable — a $1+ sell is impossible).
 *
 *  SIZING / COMPOUNDING: capital for this ladder starts at $200 and
 *  compounds — all capital and profit are reinvested. Each time a rung
 *  is armed, its notional = (current ladder bankroll) / 2, snapshotted
 *  once per arming pass so simultaneous arms (e.g. the initial setup)
 *  split cleanly 50/50 rather than compounding against each other.
 *
 *  ORDER STYLE: resting limit orders only (maker), same as the crypto
 *  ladders — eligible for Polymarket's Maker Rebates Program. This is
 *  the Sports category: 25% maker rebate share, 0.03 taker-fee rate
 *  (vs Crypto's 20%/0.07) — see docs.polymarket.com/market-makers/maker-rebates.
 *  Real payouts are pooled daily across all makers in the market, so
 *  this bot's per-fill rebate number is a best-effort ESTIMATE.
 *
 *  RESOLUTION: this bot polls the Gamma event slug for match/market
 *  closure. Once closed, any open position rides to real settlement
 *  ($1/share if Nepal won, $0 if not), any still-resting orders are
 *  cancelled, and the ladder freezes (no more re-arming).
 *
 *  MARKET DISCOVERY CAVEAT: the event page groups several sub-markets
 *  under this fixture (Moneyline, Toss Winner, Team Top Batter,
 *  Completed Match). This bot picks the Moneyline market using a
 *  keyword match on groupItemTitle/question first, falling back to
 *  "highest-volume market that isn't clearly one of the other three" if
 *  the keyword match comes up empty. It logs exactly which market and
 *  token it selected at startup — please check that log line once on
 *  first run to confirm it locked onto the actual Moneyline market
 *  before trusting it with real money.
 * ═══════════════════════════════════════════════════════════════
 *
 *  TRADER INTERFACE (LIVE mode only) — same as polymarket-bot.js:
 *    trader.placeLimitBuy(tokenId, price, size)  -> { id, filled, avgPrice, filledShares }
 *    trader.placeLimitSell(tokenId, price, size) -> same shape
 *    trader.getOrder(orderId)                    -> { filled, avgPrice, filledShares }
 *    trader.cancelOrder(orderId)                 -> void
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS            = 500;
const PRICE_REFRESH_MS   = 1000;
const STATUS_REFRESH_MS  = 5000;  // how often to poll Gamma for match/market resolution
const ORDER_POLL_MS      = 2000;  // how often to poll resting LIVE order fills

const EVENT_SLUG = process.env.CRICKET_EVENT_SLUG || 'crint-npl2-nam3-2026-07-21';
const SIDE_CANDIDATES = ['nepal', 'npl2', 'npl']; // tolerant matching against whatever the outcome label actually is

let DRY_RUN = (process.env.CRICKET_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.CRICKET_CAPITAL || 200);

// ── Strategy parameters ──
const GRID_INTERVAL = Number(process.env.CRICKET_GRID_INTERVAL || 0.05); // spacing between the 2 rungs AND the trailing step after each TP
const TP_OFFSET     = Number(process.env.CRICKET_TP_OFFSET || 0.10);     // every rung's TP = its own entry + this
const MAX_ENTRY_PRICE = 0.89; // a rung won't re-arm past this — its TP (entry+0.10) would exceed 0.99, an unreachable sell price
const MIN_ENTRY_PRICE = 0.02; // sanity floor so we never try to rest a buy at ~$0

// Sports-category maker-rebate parameters (docs.polymarket.com/market-makers/maker-rebates).
const SPORTS_TAKER_FEE_RATE = Number(process.env.SPORTS_TAKER_FEE_RATE || 0.03);
const SPORTS_MAKER_REBATE_SHARE = Number(process.env.SPORTS_MAKER_REBATE_SHARE || 0.25);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }

function estimateMakerRebate(shares, price) {
  const feeEquivalent = shares * SPORTS_TAKER_FEE_RATE * price * (1 - price);
  return round5(feeEquivalent * SPORTS_MAKER_REBATE_SHARE);
}

let emitFn = () => {};
let slog = () => {};
let trader = null;
let logs = [];
let trades = [];
let tradingEnabled = true;
let warnedNoTraderLimitMethods = false;

// ── Ladder state ──
let bankroll = TOTAL_CAPITAL;
let realizedPnl = 0, rebatesEarned = 0, wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];

let market = {
  status: 'discovering', // 'discovering' | 'trading' | 'resolved' | 'error'
  eventSlug: EVENT_SLUG, eventTitle: null,
  marketQuestion: null, conditionId: null, tokenId: null,
  ask: null, bid: null,
  resolvedWinner: null, // 'Nepal' | 'Other' | null
};

function freshRung(id) {
  return {
    id,
    nextEntryPrice: null, // set once we've discovered a live price
    maxedOut: false,      // true once its TP would exceed 0.99 — stops re-arming
    entryOrderId: null,
    entryPending: false,
    fills: 0,
    position: null, // { shares, entryPrice, cost, tpPrice, tpOrderId, tpPending, closed, won, closedReason }
  };
}
let rungs = [freshRung('near'), freshRung('far')];

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(`[cricket] ${line}`);
}
function registerTrade(t) {
  const trade = { time: new Date().toISOString().slice(11, 19), ...t };
  trades.push(trade);
  if (trades.length > 300) trades.shift();
}
function recordEquity() {
  equityCurve.push({ t: Date.now(), equity: markValue() });
  if (equityCurve.length > 1000) equityCurve.shift();
}
function markValue() {
  let held = 0;
  for (const r of rungs) {
    if (r.position && !r.position.closed) {
      const px = market.bid != null ? market.bid : r.position.entryPrice;
      held += r.position.shares * px;
    }
  }
  return round2(bankroll + held);
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
function describeOrderError(e) {
  const parts = [e?.message || String(e)];
  const extra = e?.response?.data ?? e?.data ?? e?.body ?? null;
  if (extra) { try { parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (_) {} }
  return parts.join(' | ');
}

function traderHasLimitMethods() {
  const ok = trader && typeof trader.placeLimitBuy === 'function' && typeof trader.placeLimitSell === 'function';
  if (!ok && !warnedNoTraderLimitMethods) {
    warnedNoTraderLimitMethods = true;
    log('❌ LIVE trading needs trader.placeLimitBuy / trader.placeLimitSell (and ideally getOrder / cancelOrder) on polymarket-trader.js — LIVE order actions will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}
async function placeRestingBuy(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethods()) return null;
    try { return await trader.placeLimitBuy(tokenId, price, shares); }
    catch (e) { log(`❌ placeLimitBuy failed: ${describeOrderError(e)}`); return null; }
  }
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: false };
}
async function placeRestingSell(tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethods()) return null;
    try { return await trader.placeLimitSell(tokenId, price, shares); }
    catch (e) { log(`❌ placeLimitSell failed: ${describeOrderError(e)}`); return null; }
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
//  Market discovery — find the event, the Moneyline sub-market, the Nepal token
// ─────────────────────────────────────────
function parseMarketTokens(m) {
  try {
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
    const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}
function tokenIdForNepal(m) {
  const tokens = parseMarketTokens(m);
  for (const cand of SIDE_CANDIDATES) {
    const tok = tokens.find(t => (t.outcome || '').trim().toLowerCase() === cand);
    if (tok) return { tokenId: tok.token_id, outcome: tok.outcome };
  }
  // Fallback: substring match in case the label has extra text
  for (const cand of SIDE_CANDIDATES) {
    const tok = tokens.find(t => (t.outcome || '').toLowerCase().includes(cand));
    if (tok) return { tokenId: tok.token_id, outcome: tok.outcome };
  }
  return null;
}
function pickMoneylineMarket(event) {
  const markets = event.markets || [];
  if (!markets.length) return null;
  const blacklist = ['toss', 'batter', 'completed', 'draw'];
  const isBlacklisted = m => {
    const s = `${m.groupItemTitle || ''} ${m.question || ''}`.toLowerCase();
    return blacklist.some(b => s.includes(b));
  };
  // 1) explicit "moneyline" keyword hit
  let m = markets.find(mk => `${mk.groupItemTitle || ''} ${mk.question || ''}`.toLowerCase().includes('moneyline'));
  if (m) return m;
  // 2) highest-volume market that isn't one of the known other sub-markets
  const candidates = markets.filter(mk => !isBlacklisted(mk));
  if (candidates.length) {
    candidates.sort((a, b) => (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0));
    return candidates[0];
  }
  // 3) last resort — just the highest-volume market of any kind
  const all = [...markets].sort((a, b) => (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0));
  return all[0] || null;
}

async function discoverMarket() {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(EVENT_SLUG)}`);
    if (!event || !event.id) { log(`⚠️  event slug not found: ${EVENT_SLUG}`); market.status = 'error'; return; }
    market.eventTitle = event.title || event.slug;

    const m = pickMoneylineMarket(event);
    if (!m) { log('⚠️  no usable market found in event'); market.status = 'error'; return; }

    const found = tokenIdForNepal(m);
    if (!found) { log(`⚠️  could not find a Nepal-side token on market "${m.question || m.groupItemTitle}"`); market.status = 'error'; return; }

    market.marketQuestion = m.groupItemTitle || m.question || m.slug;
    market.conditionId = m.conditionId || null;
    market.tokenId = found.tokenId;
    market.status = 'awaiting-price';
    log(`🏏 locked onto market "${market.marketQuestion}" (event: ${market.eventTitle}) — trading outcome "${found.outcome}" — PLEASE VERIFY this is the actual Moneyline market before relying on this in LIVE mode`);
  } catch (e) {
    log(`⚠️  discoverMarket failed: ${e.message}`);
    market.status = 'error';
  }
}

// ─────────────────────────────────────────
//  Price feed
// ─────────────────────────────────────────
async function refreshPrice() {
  if (!market.tokenId) return;
  try {
    const [ask, bid] = await Promise.all([
      getJSON(`${CLOB}/price?token_id=${market.tokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${market.tokenId}&side=SELL`).catch(() => null),
    ]);
    if (ask?.price != null) market.ask = parseFloat(ask.price);
    if (bid?.price != null) market.bid = parseFloat(bid.price);
  } catch (_) {}
}

// Establishes the initial anchors for both rungs off the live ask, once.
function tryEstablishInitialGrid() {
  if (market.status !== 'awaiting-price') return;
  if (market.ask == null) return;
  const near = round2(market.ask - GRID_INTERVAL);
  const far = round2(market.ask - 2 * GRID_INTERVAL);
  if (far < MIN_ENTRY_PRICE || near > MAX_ENTRY_PRICE) {
    // Price too extreme to place a workable 2-rung grid below it right now — keep waiting.
    return;
  }
  rungs[0].nextEntryPrice = near; // near rung
  rungs[1].nextEntryPrice = far;  // far rung
  market.status = 'trading';
  log(`🎯 initial grid anchored off live ask ${market.ask.toFixed(2)} — near rung @ ${near.toFixed(2)} (TP ${round2(near + TP_OFFSET).toFixed(2)}), far rung @ ${far.toFixed(2)} (TP ${round2(far + TP_OFFSET).toFixed(2)})`);
}

// ─────────────────────────────────────────
//  Entry / TP management
// ─────────────────────────────────────────
function affordable(shares, price) { return round2(shares * price) <= bankroll; }

async function armRungs() {
  if (!tradingEnabled || market.status !== 'trading') return;
  const eligible = rungs.filter(r => !r.position && !r.entryPending && !r.maxedOut && r.nextEntryPrice != null);
  if (!eligible.length) return;
  const notionalEach = round2(bankroll / 2); // snapshot once — simultaneous arms split cleanly, e.g. the initial setup
  for (const r of eligible) {
    await armRung(r, notionalEach);
  }
}

async function armRung(r, notional) {
  if (r.position || r.entryPending || r.maxedOut) return;
  const price = r.nextEntryPrice;
  if (price == null || price < MIN_ENTRY_PRICE || price > MAX_ENTRY_PRICE) return;
  if (notional <= 0) return;
  const shares = round2(notional / price);
  if (!affordable(shares, price)) return; // will retry next tick once bankroll frees up

  const resp = await placeRestingBuy(market.tokenId, price, shares);
  if (!resp) return;
  r.entryOrderId = resp.id;
  r.entryPending = true;
  if (resp.filled) await onEntryFilled(r, price, resp.filledShares || shares);
}

async function onEntryFilled(r, fillPrice, filledShares) {
  if (r.position) return; // never stack a second position on this rung
  const shares = filledShares > 0 ? filledShares : round2((bankroll / 2) / fillPrice);
  const cost = round2(shares * fillPrice);
  const rebate = estimateMakerRebate(shares, fillPrice);

  bankroll = round2(bankroll - cost + rebate);
  rebatesEarned = round2(rebatesEarned + rebate);

  const tpPrice = round2(fillPrice + TP_OFFSET);
  r.entryPending = false;
  r.entryOrderId = null;
  r.fills += 1;
  r.position = { shares, entryPrice: fillPrice, cost, tpPrice, tpOrderId: null, tpPending: false, closed: false, won: null, closedReason: null };

  registerTrade({ rung: r.id, side: 'BUY', outcome: 'Nepal', reason: 'ENTRY', price: fillPrice, shares, cost, rebate, fill: r.fills });
  log(`✅ [${r.id}] resting buy filled @ ${fillPrice.toFixed(2)} — ${shares.toFixed(2)}sh ($${cost.toFixed(2)}) | +$${rebate.toFixed(5)} maker rebate (est.) | TP armed @ ${tpPrice.toFixed(2)} — fill #${r.fills}`);

  const tpResp = await placeRestingSell(market.tokenId, tpPrice, shares);
  if (tpResp) {
    r.position.tpOrderId = tpResp.id;
    r.position.tpPending = true;
    if (tpResp.filled) await onTPFilled(r, tpResp.avgPrice || tpPrice, tpResp.filledShares || shares);
  }
  recordEquity();
}

async function onTPFilled(r, fillPrice, filledShares) {
  const pos = r.position;
  if (!pos || pos.closed) return;
  const shares = filledShares > 0 ? filledShares : pos.shares;
  const proceeds = round2(shares * fillPrice);
  const rebate = estimateMakerRebate(shares, fillPrice);
  const profit = round2(proceeds - pos.cost + rebate);

  bankroll = round2(bankroll + proceeds + rebate);
  realizedPnl = round2(realizedPnl + profit);
  rebatesEarned = round2(rebatesEarned + rebate);
  wins++;
  pos.closed = true; pos.won = true; pos.closedReason = 'TP'; pos.tpPending = false;

  registerTrade({ rung: r.id, side: 'SELL', outcome: 'Nepal', reason: 'TP', price: fillPrice, shares, profit, rebate });
  log(`💰 [${r.id}] TP filled @ ${fillPrice.toFixed(2)} — pnl=$${profit.toFixed(2)} (incl. rebate) | bankroll=$${bankroll.toFixed(2)} — trailing this rung up`);

  r.position = null;
  // Trail this rung up by GRID_INTERVAL, based on its OWN old entry — not the live price.
  const nextPrice = round2(pos.entryPrice + GRID_INTERVAL);
  if (round2(nextPrice + TP_OFFSET) > 0.99) {
    r.maxedOut = true;
    r.nextEntryPrice = nextPrice;
    log(`🛑 [${r.id}] next entry would be ${nextPrice.toFixed(2)} (TP ${round2(nextPrice + TP_OFFSET).toFixed(2)} > 0.99) — this rung has maxed out for the match, no further re-entries`);
  } else {
    r.nextEntryPrice = nextPrice;
  }
  recordEquity();
  await armRungs(); // this rung just freed up — try to re-enter (sized off current bankroll)
}

// DRY_RUN fill simulation — checked every tick.
function tickDryRun() {
  if (market.status !== 'trading') return;
  const ask = market.ask, bid = market.bid;
  for (const r of rungs) {
    const pos = r.position;
    if (pos && !pos.closed && pos.tpPending) {
      if (bid != null && bid >= pos.tpPrice) {
        onTPFilled(r, pos.tpPrice, pos.shares).catch(e => log(`⚠️  TP fill error: ${e.message}`));
      }
      continue;
    }
    if (!pos && r.entryPending && ask != null && r.nextEntryPrice != null && ask <= r.nextEntryPrice) {
      const notionalEach = round2(bankroll / 2);
      onEntryFilled(r, r.nextEntryPrice, round2(notionalEach / r.nextEntryPrice)).catch(e => log(`⚠️  entry fill error: ${e.message}`));
    }
  }
}

// LIVE order-fill polling
async function pollLiveOrders() {
  if (DRY_RUN || !trader || typeof trader.getOrder !== 'function') return;
  for (const r of rungs) {
    if (r.entryPending && r.entryOrderId) {
      try {
        const st = await trader.getOrder(r.entryOrderId);
        if (st && st.filled) await onEntryFilled(r, r.nextEntryPrice, st.filledShares || round2((bankroll / 2) / r.nextEntryPrice));
      } catch (e) { log(`⚠️  getOrder (entry) failed: ${describeOrderError(e)}`); }
    }
    const pos = r.position;
    if (pos && !pos.closed && pos.tpPending && pos.tpOrderId) {
      try {
        const st = await trader.getOrder(pos.tpOrderId);
        if (st && st.filled) await onTPFilled(r, st.avgPrice || pos.tpPrice, st.filledShares || pos.shares);
      } catch (e) { log(`⚠️  getOrder (tp) failed: ${describeOrderError(e)}`); }
    }
  }
}

// ─────────────────────────────────────────
//  Match / market resolution
// ─────────────────────────────────────────
async function checkResolution() {
  if (market.status === 'resolved' || !market.eventSlug) return;
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(EVENT_SLUG)}`);
    const m = (event.markets || []).find(mk => mk.conditionId === market.conditionId);
    if (!m || m.closed !== true) return;

    let winner = null;
    if (m.outcomePrices) {
      const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const label = (outcomes[bestI] || '').trim().toLowerCase();
      winner = SIDE_CANDIDATES.includes(label) || SIDE_CANDIDATES.some(c => label.includes(c)) ? 'Nepal' : 'Other';
    }
    await resolveMatch(winner);
  } catch (e) {
    log(`⚠️  checkResolution failed: ${e.message}`);
  }
}

async function resolveMatch(winner) {
  if (market.status === 'resolved') return;
  market.status = 'resolved';
  market.resolvedWinner = winner;
  const nepalWon = winner === 'Nepal';

  for (const r of rungs) {
    if (r.entryPending) {
      await cancelRestingOrder(r.entryOrderId);
      r.entryPending = false;
      r.entryOrderId = null;
    }
    const pos = r.position;
    if (!pos || pos.closed) continue;
    if (pos.tpPending) await cancelRestingOrder(pos.tpOrderId);

    const proceeds = nepalWon ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    bankroll = round2(bankroll + proceeds);
    realizedPnl = round2(realizedPnl + profit);
    if (nepalWon) wins++; else losses++;
    pos.closed = true; pos.won = nepalWon; pos.closedReason = 'RESOLUTION';
    const icon = nepalWon ? '💰' : '💥';
    log(`${icon} [${r.id}] RESOLUTION ${pos.shares.toFixed(2)}sh entry=${pos.entryPrice.toFixed(2)} exit=$${nepalWon ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);
    registerTrade({ rung: r.id, side: 'SELL', outcome: 'Nepal', reason: 'RESOLUTION', price: nepalWon ? 1 : 0, shares: pos.shares, profit });
  }
  log(`🏁 Match resolved — winner: ${winner || 'unknown'} | final bankroll $${bankroll.toFixed(2)} | realized P&L $${realizedPnl.toFixed(2)} | rebates $${rebatesEarned.toFixed(5)} — ladder is done, no further trading`);
  recordEquity();
}

// ─────────────────────────────────────────
//  Main tick
// ─────────────────────────────────────────
async function tick() {
  if (market.status === 'discovering') { await discoverMarket(); return; }
  if (market.status === 'error') return; // discovery failed — stays idle; check logs
  if (market.status === 'awaiting-price') { tryEstablishInitialGrid(); if (market.status !== 'trading') return; }
  if (market.status === 'resolved') return;

  if (DRY_RUN) tickDryRun();
  if (!tradingEnabled) return;
  await armRungs();
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastPriceFetch = 0, lastStatusFetch = 0, lastOrderPoll = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPriceFetch >= PRICE_REFRESH_MS) { lastPriceFetch = now; await refreshPrice(); }
      if (now - lastStatusFetch >= STATUS_REFRESH_MS && market.status !== 'discovering') { lastStatusFetch = now; await checkResolution(); }
      if (!DRY_RUN && now - lastOrderPoll >= ORDER_POLL_MS) { lastOrderPoll = now; await pollLiveOrders(); }
      await tick();
      emitFn('cricketState', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(res => setTimeout(res, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const mv = markValue();
  let costBasis = 0;
  for (const r of rungs) if (r.position && !r.position.closed) costBasis += r.position.cost;
  costBasis = round2(costBasis);
  const held = round2(mv - bankroll);
  const unrealizedPnl = round2(held - costBasis);

  return {
    dryRun: DRY_RUN, tradingEnabled,
    market: { ...market },
    rungs: rungs.map(r => ({
      id: r.id, nextEntryPrice: r.nextEntryPrice, maxedOut: r.maxedOut,
      entryPending: r.entryPending, fills: r.fills,
      position: r.position ? {
        shares: r.position.shares, entryPrice: r.position.entryPrice, cost: r.position.cost,
        tpPrice: r.position.tpPrice, tpPending: r.position.tpPending, closed: r.position.closed,
      } : null,
    })),
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    realizedPnl, unrealizedPnl, rebatesEarned, wins, losses,
    totalPnl: round2(mv - TOTAL_CAPITAL),
    config: {
      gridInterval: GRID_INTERVAL, tpOffset: TP_OFFSET,
      makerRebateShare: SPORTS_MAKER_REBATE_SHARE, sportsTakerFeeRate: SPORTS_TAKER_FEE_RATE,
      orderType: 'resting-limit', reentryMode: 'trailing',
    },
    equityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

function pauseTrading() { tradingEnabled = false; log('⏸️  Cricket ladder paused (open positions/TPs still managed; no new entries armed)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Cricket ladder resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }
function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) log(DRY_RUN ? '🟡 Cricket ladder switched to DEMO mode (simulated fills)' : '🔴 Cricket ladder switched to LIVE mode — real money, real resting limit orders');
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log('🏏 Cricket Trailing-Grid Ladder — Nepal moneyline, single event');
  log(`⚙️  $${TOTAL_CAPITAL} starting capital, all capital + profit reinvested (compounding)`);
  log(`⚙️  Event: ${EVENT_SLUG}`);
  log(`⚙️  Grid: 2 rungs, $${GRID_INTERVAL.toFixed(2)} apart, TP = entry + $${TP_OFFSET.toFixed(2)}, trailing +$${GRID_INTERVAL.toFixed(2)} re-entry after each TP`);
  log('⚙️  Sizing: half of current ladder bankroll per rung (snapshotted once per arming pass) | resting limit orders only (maker)');
  log(`⚙️  Maker rebates: Sports category ≈ ${(SPORTS_MAKER_REBATE_SHARE * 100).toFixed(0)}% of taker-fee-equivalent (rate ${SPORTS_TAKER_FEE_RATE}) — estimated per fill, real payouts pooled daily by Polymarket`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, pauseTrading, resumeTrading, setMode, getStatus, buildState };
