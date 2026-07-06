'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE BTC UP/DOWN — 0.90 BREAKOUT → 0.80 ENTRY + FLIP-RECOVERY CHAIN
 * ═══════════════════════════════════════════════════════════════
 *
 *  Per window (WINDOW_SECS = 300s), each pair independently:
 *
 *  MONITOR (from window open): watch both sides' live price. The
 *  instant EITHER side's price hits BREAKOUT_TRIGGER_PRICE (0.90),
 *  place ONE resting maker limit BUY at ENTRY_ORDER_PRICE (0.80) on
 *  that side — below the trigger, hoping price retraces to fill.
 *  Only one trigger per window — whichever side hits 0.90 first
 *  wins; the other side is ignored for the rest of the window. If
 *  price never hits 0.90, no trade this window and the recovery
 *  chain is untouched.
 *
 *  ENTRY SIZING (computed at trigger time):
 *    - Chain level 0 (base): shares = (BASE_PCT_OF_BANKROLL × current
 *      live bankroll) / ENTRY_ORDER_PRICE.
 *    - Chain level 1 or 2 (recovery): target profit = cumulative
 *      chain loss so far + RECOVERY_PROFIT_ADD ($10). Shares sized
 *      so that hitting TP_PRICE (0.99) exactly nets that target
 *      profit: shares = target profit / (TP_PRICE − ENTRY_ORDER_PRICE).
 *
 *  ON FILL: rest a maker TP sell at TP_PRICE (0.99). Simultaneously
 *  monitor the position's bid — if it falls to SL_PRICE (0.40)
 *  before TP fills, force-sell (taker) immediately at market. Only
 *  one of TP or SL can happen; whichever comes first closes the
 *  window's trade.
 *
 *  IF NEITHER TP NOR SL FIRES before window end: the still-open
 *  position resolves against Polymarket's actual outcome (win →
 *  $1/share, lose → $0/share), same as a normal resolution. That
 *  result also feeds the recovery chain below.
 *
 *  RECOVERY CHAIN (max 3 windows: base + 2 recovery attempts):
 *    - Win (TP or resolution) at ANY chain level → chain resets to
 *      base (level 0), cumulative loss cleared.
 *    - Loss (SL or resolution) at level 0 → cumulative loss = that
 *      loss, chain advances to level 1 (recovery attempt #1 next
 *      window this pair triggers).
 *    - Loss at level 1 → cumulative loss += that loss, chain
 *      advances to level 2 (recovery attempt #2).
 *    - Loss at level 2 (the 3rd loss in the chain) → chain is
 *      EXHAUSTED: reset to base, cumulative loss cleared, no win
 *      credited.
 *    - If a resting entry buy never fills before window end, it's
 *      cancelled — no trade, chain unaffected.
 *
 *  FEES: entry buys and TP sells are maker (0 fee + rebate). The
 *  forced SL market sell is a taker order (fee applies).
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

// ── Breakout + flip-recovery strategy parameters ──
const BREAKOUT_TRIGGER_PRICE = Number(process.env.BREAKOUT_TRIGGER_PRICE || 0.90); // price that must be hit to arm the entry
const ENTRY_ORDER_PRICE      = Number(process.env.ENTRY_ORDER_PRICE || 0.80);      // resting maker buy price once triggered
const SL_PRICE               = Number(process.env.SL_PRICE || 0.40);          // force-sell (taker) trigger
const TP_PRICE               = Number(process.env.TP_PRICE || 0.99);          // resting maker take-profit
const BASE_PCT_OF_BANKROLL   = Number(process.env.BASE_PCT_OF_BANKROLL || 0.01); // 1% of live bankroll, base sizing only
const RECOVERY_PROFIT_ADD    = Number(process.env.RECOVERY_PROFIT_ADD || 10);    // flat $ added on top of recovered loss
const MAX_CHAIN_LEVEL        = Number(process.env.MAX_CHAIN_LEVEL || 2);         // 0=base,1,2 recovery attempts (3 windows total)

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
function nowSec() { return Date.now() / 1000; }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-breakout-recovery/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-breakout-recovery/1.0' },
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
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round2(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
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

    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,

    // recovery chain — persists ACROSS windows (not reset per-window)
    chainLevel: 0,        // 0 = base, 1 = recovery attempt #1, 2 = recovery attempt #2
    cumulativeLoss: 0,    // running $ loss the chain is trying to recover

    // per-window trading state (reset in loadPairWindow)
    entryOrder: null,     // resting buy before fill: { orderId, side, price, shares, cost, chainLevelAtEntry, targetProfit, placedAt }
    position: null,       // filled position: { side, entryPrice, shares, cost, chainLevelAtEntry, targetProfit, tp:{orderId,price,status}, openedAt }
    windowOutcome: null,  // last outcome tag this window, for UI/logging only

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

  // reset per-window trading state — chainLevel / cumulativeLoss persist
  p.entryOrder = null;
  p.position = null;
  p.windowOutcome = null;

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
function positionsMarkValue(p) {
  if (!p.position) return 0;
  const bid = p.position.side === 'Up' ? p.upBid : p.downBid;
  const price = bid ?? (p.position.cost / p.position.shares);
  return round2(p.position.shares * price);
}
function pairMarkValue(p) {
  return round2(p.bankroll + positionsMarkValue(p));
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
//  Sizing helper
// ─────────────────────────────────────────
function computeEntrySizing(p) {
  if (p.chainLevel === 0) {
    const shares = round2((BASE_PCT_OF_BANKROLL * p.bankroll) / ENTRY_ORDER_PRICE);
    return { shares, targetProfit: null };
  }
  const targetProfit = round2(p.cumulativeLoss + RECOVERY_PROFIT_ADD);
  const shares = round2(targetProfit / (TP_PRICE - ENTRY_ORDER_PRICE));
  return { shares, targetProfit };
}

// ─────────────────────────────────────────
//  Monitor: watch for the 0.90 breakout trigger from window start
// ─────────────────────────────────────────
async function maybeTriggerEntry(p) {
  for (const side of ['Up', 'Down']) {
    const ask = side === 'Up' ? p.upAsk : p.downAsk;
    const bid = side === 'Up' ? p.upBid : p.downBid;
    const price = ask ?? bid;
    if (price == null || price < BREAKOUT_TRIGGER_PRICE) continue;

    let { shares, targetProfit } = computeEntrySizing(p);
    let cost = round2(shares * ENTRY_ORDER_PRICE);

    if (shares <= 0 || cost <= 0) {
      log(`⏭️  ${p.symbol} ${side}: hit ${BREAKOUT_TRIGGER_PRICE.toFixed(2)} (${price.toFixed(2)}) but computed size is zero — skipped`);
      return;
    }
    if (cost > p.bankroll) {
      log(`⚠️  ${p.symbol} ${side}: recovery size $${cost.toFixed(2)} exceeds bankroll $${p.bankroll.toFixed(2)} — capping to available cash (target profit will undershoot)`);
      cost = p.bankroll;
      shares = round2(cost / ENTRY_ORDER_PRICE);
      if (shares <= 0) { log(`⏭️  ${p.symbol} ${side}: no bankroll left — skipped`); return; }
    }

    const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
    const order = await placeLimitBuy(tokenId, ENTRY_ORDER_PRICE, shares);
    p.entryOrder = {
      orderId: order.id || order.orderId || null,
      side, price: ENTRY_ORDER_PRICE, shares, cost,
      chainLevelAtEntry: p.chainLevel, targetProfit,
      placedAt: Date.now(),
    };
    const lvlTxt = p.chainLevel > 0 ? ` [RECOVERY L${p.chainLevel}, target profit $${targetProfit.toFixed(2)}]` : ' [BASE]';
    log(`🎯 ${p.symbol} ${side}: price ${price.toFixed(2)} hit ${BREAKOUT_TRIGGER_PRICE.toFixed(2)} — resting BUY ${shares.toFixed(2)}sh @ ${ENTRY_ORDER_PRICE.toFixed(2)}${lvlTxt}`);
    return; // one trigger per window — first side wins, other side ignored
  }
}

// ─────────────────────────────────────────
//  Entry order fill check
// ─────────────────────────────────────────
async function checkEntryOrderFill(p) {
  if (!p.entryOrder) return;
  const eo = p.entryOrder;
  const ask = eo.side === 'Up' ? p.upAsk : p.downAsk;
  if (ask == null || ask > eo.price) return;

  const rebate = makerRebate(eo.shares, eo.price);
  p.bankroll = round2(p.bankroll - eo.cost + rebate);
  p.realizedPnl = round2(p.realizedPnl + rebate);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);

  const tokenId = eo.side === 'Up' ? p.upTokenId : p.downTokenId;
  const tpOrder = await placeLimitSell(tokenId, TP_PRICE, eo.shares);
  p.position = {
    side: eo.side, entryPrice: eo.price, shares: eo.shares, cost: eo.cost,
    chainLevelAtEntry: eo.chainLevelAtEntry, targetProfit: eo.targetProfit,
    tp: { orderId: tpOrder.id || tpOrder.orderId || null, price: TP_PRICE, status: 'resting' },
    openedAt: Date.now(),
  };
  p.entryOrder = null;

  log(`✅ ${p.symbol} ${eo.side}: entry filled ${eo.shares.toFixed(2)}sh @ ${eo.price.toFixed(2)} | cost=$${eo.cost.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | TP resting @ ${TP_PRICE.toFixed(2)} | SL @ ${SL_PRICE.toFixed(2)} (forced)`);
  registerTrade(p, { side: 'BUY', outcome: eo.side, reason: `ENTRY-L${eo.chainLevelAtEntry}`, price: eo.price, shares: eo.shares, cost: eo.cost, rebate });
  recordEquity(p);
}

// ─────────────────────────────────────────
//  Chain bookkeeping shared by SL + resolution losses/wins
// ─────────────────────────────────────────
function applyChainWin(p) {
  p.wins++;
  p.chainLevel = 0;
  p.cumulativeLoss = 0;
}
function applyChainLoss(p, loss) {
  p.losses++;
  p.cumulativeLoss = round2(p.cumulativeLoss + loss);
  const exhausted = p.chainLevel >= MAX_CHAIN_LEVEL;
  if (exhausted) {
    p.chainLevel = 0;
    p.cumulativeLoss = 0;
  } else {
    p.chainLevel++;
  }
  return exhausted;
}

// ─────────────────────────────────────────
//  Position exit checking: TP fill or forced SL
// ─────────────────────────────────────────
async function checkPositionExits(p) {
  if (!p.position) return;
  const pos = p.position;
  const side = pos.side;
  const bid = side === 'Up' ? p.upBid : p.downBid;
  if (bid == null) return;

  if (bid >= pos.tp.price) {
    const proceeds = round2(pos.tp.price * pos.shares);
    const rebate = makerRebate(pos.shares, pos.tp.price);
    const net = round2(proceeds + rebate);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.rebatesEarned = round2(p.rebatesEarned + rebate);
    applyChainWin(p);
    p.windowOutcome = 'WIN-TP';

    log(`💰 ${p.symbol} ${side}: TP filled ${pos.shares.toFixed(2)}sh @ ${pos.tp.price.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}) | pnl=$${profit.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | bankroll=$${p.bankroll.toFixed(2)} | chain reset to base`);
    registerTrade(p, { side: 'SELL', outcome: side, reason: 'TP', price: pos.tp.price, shares: pos.shares, profit, rebate });
    p.position = null;
    recordEquity(p);
    return;
  }

  if (bid <= SL_PRICE) {
    await cancelOrder(pos.tp.orderId);
    const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
    await placeLimitSell(tokenId, bid, pos.shares); // forced taker sell, simulated at current bid
    const proceeds = round2(bid * pos.shares);
    const fee = takerFee(pos.shares, bid);
    const net = round2(proceeds - fee);
    p.bankroll = round2(p.bankroll + net);
    const profit = round2(net - pos.cost);
    p.realizedPnl = round2(p.realizedPnl + profit);
    p.feesPaid = round2(p.feesPaid + fee);

    const loss = round2(pos.cost - net);
    const exhausted = applyChainLoss(p, loss);
    p.windowOutcome = 'LOSS-SL';

    if (exhausted) {
      log(`💥 ${p.symbol} ${side}: SL forced sell ${pos.shares.toFixed(2)}sh @ ${bid.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}) | loss=$${loss.toFixed(2)} | chain EXHAUSTED — reset to base, no win credited`);
    } else {
      log(`💥 ${p.symbol} ${side}: SL forced sell ${pos.shares.toFixed(2)}sh @ ${bid.toFixed(2)} (entry ${pos.entryPrice.toFixed(2)}) | loss=$${loss.toFixed(2)} | cumulative loss $${p.cumulativeLoss.toFixed(2)} → next recovery level ${p.chainLevel} (target profit $${(p.cumulativeLoss + RECOVERY_PROFIT_ADD).toFixed(2)})`);
    }
    registerTrade(p, { side: 'SELL', outcome: side, reason: 'SL-FORCED', price: bid, shares: pos.shares, profit, fee });
    p.position = null;
    recordEquity(p);
  }
}

// ─────────────────────────────────────────
//  Window resolution — cancels stragglers; if a position never hit
//  TP/SL, resolves it against the actual outcome and feeds the chain.
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

  if (p.entryOrder) {
    await cancelOrder(p.entryOrder.orderId);
    log(`🛑 ${p.symbol} ${p.entryOrder.side}: entry buy ${p.entryOrder.shares.toFixed(2)}sh @ ${p.entryOrder.price.toFixed(2)} unfilled — cancelled at window close, no trade, chain unaffected`);
    p.entryOrder = null;
  }

  if (!p.position) return;

  const pos = p.position;
  const side = pos.side;
  await cancelOrder(pos.tp.orderId);

  const winner = await determineWinningSide(p);
  const won = winner === side;
  const proceeds = won ? round2(pos.shares * 1) : 0;
  const profit = round2(proceeds - pos.cost);
  p.bankroll = round2(p.bankroll + proceeds);
  p.realizedPnl = round2(p.realizedPnl + profit);

  if (won) {
    applyChainWin(p);
    p.windowOutcome = 'WIN-RESOLUTION';
    log(`💰 ${p.symbol} ${side}: RESOLUTION win ${pos.shares.toFixed(2)}sh cost=$${pos.cost.toFixed(2)} → $1.00/sh | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)} | chain reset to base`);
  } else {
    const loss = round2(pos.cost - proceeds);
    const exhausted = applyChainLoss(p, loss);
    p.windowOutcome = 'LOSS-RESOLUTION';
    if (exhausted) {
      log(`💥 ${p.symbol} ${side}: RESOLUTION loss ${pos.shares.toFixed(2)}sh cost=$${pos.cost.toFixed(2)} → $0.00/sh | loss=$${loss.toFixed(2)} | chain EXHAUSTED — reset to base, no win credited`);
    } else {
      log(`💥 ${p.symbol} ${side}: RESOLUTION loss ${pos.shares.toFixed(2)}sh cost=$${pos.cost.toFixed(2)} → $0.00/sh | loss=$${loss.toFixed(2)} | cumulative loss $${p.cumulativeLoss.toFixed(2)} → next recovery level ${p.chainLevel}`);
    }
  }
  registerTrade(p, { side: 'SELL', outcome: side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
  p.position = null;
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
  if (!tradingEnabled) return;

  await checkEntryOrderFill(p);
  await checkPositionExits(p);

  if (!p.entryOrder && !p.position && !p.windowOutcome) {
    await maybeTriggerEntry(p);
  }

  const remaining = p.windowEnd - nowSec();
  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const markValue = pairMarkValue(p);
    const posValue = positionsMarkValue(p);
    const unrealized = p.position ? round2(posValue - p.position.cost) : 0;
    const elapsed = p.windowStart != null ? Math.max(0, nowSec() - p.windowStart) : null;

    let phase = '—';
    if (p.tradable && elapsed != null) {
      if (p.position) phase = 'IN POSITION';
      else if (p.entryOrder) phase = 'ENTRY PENDING';
      else phase = 'MONITORING';
    }

    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      eventTitle: p.eventTitle,
      windowEnd: p.windowEnd,
      elapsedSecs: elapsed != null ? Math.floor(elapsed) : null,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      phase,
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: unrealized,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      chainLevel: p.chainLevel,
      cumulativeLoss: p.cumulativeLoss,
      nextRecoveryTarget: p.chainLevel > 0 ? round2(p.cumulativeLoss + RECOVERY_PROFIT_ADD) : null,
      entryOrder: p.entryOrder ? {
        side: p.entryOrder.side, price: p.entryOrder.price, shares: p.entryOrder.shares,
        cost: p.entryOrder.cost, chainLevelAtEntry: p.entryOrder.chainLevelAtEntry,
        targetProfit: p.entryOrder.targetProfit,
      } : null,
      position: p.position ? {
        side: p.position.side, entryPrice: p.position.entryPrice, shares: p.position.shares,
        cost: p.position.cost, tpPrice: p.position.tp.price, slPrice: SL_PRICE,
        chainLevelAtEntry: p.position.chainLevelAtEntry, targetProfit: p.position.targetProfit,
      } : null,
      windowOutcome: p.windowOutcome,
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
      breakoutTriggerPrice: BREAKOUT_TRIGGER_PRICE,
      entryOrderPrice: ENTRY_ORDER_PRICE,
      slPrice: SL_PRICE,
      tpPrice: TP_PRICE,
      basePctOfBankroll: BASE_PCT_OF_BANKROLL,
      recoveryProfitAdd: RECOVERY_PROFIT_ADD,
      maxChainLevel: MAX_CHAIN_LEVEL,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates,
    totalEquityCurve,
    logs: logs.slice(-120),
    trades: trades.slice(-100).reverse(),
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
  log('⏸️  Trading paused (open/pending orders still managed for fills/TP/SL/resolution)');
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
  log(`🚀 5-Minute BTC Up/Down — 0.90 Breakout → 0.80 Entry + Flip-Recovery Chain`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pair(s) (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  Monitor both sides from window open. First side to hit ${BREAKOUT_TRIGGER_PRICE.toFixed(2)} gets a resting BUY @ ${ENTRY_ORDER_PRICE.toFixed(2)}`);
  log(`⚙️  Base size = ${(BASE_PCT_OF_BANKROLL * 100).toFixed(1)}% of live bankroll | TP resting @ ${TP_PRICE.toFixed(2)} | SL forced (taker) @ ${SL_PRICE.toFixed(2)}`);
  log(`⚙️  On SL/loss: next window sizes to recover cumulative loss + $${RECOVERY_PROFIT_ADD.toFixed(2)} at TP. Max ${MAX_CHAIN_LEVEL} recovery attempts, then reset to base`);
  log(`⚙️  If neither TP nor SL fires by window end, position resolves to actual outcome and still feeds the chain`);
  log(`⚙️  fees: entry buy + TP are maker (0 fee, +${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% rebate) | forced SL sell is taker (fee applies)`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
