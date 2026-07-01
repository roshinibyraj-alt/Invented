'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET EXPIRY SNIPER BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  STRATEGY: Near-Expiry High-Confidence Sniper
 *
 *  DISCOVERY: Scans ALL active Polymarket markets across every
 *  category — binary Yes/No, sports moneylines (soccer, NBA,
 *  NFL…), crypto up/down windows (BTC/ETH 5m/15m/1h), and
 *  neg-risk multi-outcome events — for markets resolving within
 *  the next 60 minutes.
 *
 *  Uses the Gamma API's end_date_min / end_date_max filters
 *  on the /events endpoint. Each event embeds its markets[],
 *  each market embeds outcomes[] + outcomePrices[] + clobTokenIds[]
 *  as JSON strings — same schema across ALL market categories.
 *
 *  SIGNAL:
 *   Any outcome whose current mid-price > 0.70 (market is
 *   already pricing it as 70%+ favourite with ≤60 min left).
 *
 *  ENTRY:
 *   Limit BUY at the live mid-price for the qualifying outcome
 *   token. Confirmation fetch right before entry to avoid
 *   stale prices.
 *
 *  TAKE PROFIT:
 *   Limit SELL at 0.99 immediately after entry is placed.
 *
 *  SIZING:
 *   3% of $2,000 demo capital = $60 per position.
 *   Concurrent positions allowed until cash runs out.
 *   Never re-enter the same token within one scan window.
 *
 *  EXIT:
 *   TP at 0.99. If the market expires before TP is hit, the
 *   bot places a close-out sell at the last known mid-price.
 *   No manual stop-loss — expiry IS the hard stop.
 *
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Strategy constants ──
const TOTAL_CAPITAL    = 2000;
const TRADE_PCT        = 0.03;                              // 3% per position
const TRADE_AMOUNT     = Math.round(TOTAL_CAPITAL * TRADE_PCT); // $60
const MIN_SIGNAL_PRICE = 0.70;                              // entry threshold
const TP_PRICE         = 0.99;                              // take-profit target
const WINDOW_MINS      = 60;                                // horizon (minutes)
const SCAN_INTERVAL_MS = 30_000;                            // re-scan every 30 s
const PRICE_REFRESH_MS = 2_000;                             // position price tick
const TICK_MS          = 1_000;                             // main loop cadence

// ── Env ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// ── Runtime state ──
let emitFn           = () => {};
let slog             = () => {};
let trader           = null;
let startTime        = Date.now();
let logs             = [];
let trades           = [];
let lastScan         = 0;
let lastPriceRefresh = 0;
let cash             = TOTAL_CAPITAL;

// positions: Map<tokenId, positionObject>
const positions  = new Map();
// seenTokens: tokens already evaluated this session (skip on re-scan)
const seenTokens = new Set();

// ─────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 300) logs.shift();
  slog(line);
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ─────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Token/price parser — works for ALL market categories
//
//  Gamma market schema (identical across binary, sports, crypto,
//  neg-risk multi-outcome):
//    outcomes      → JSON string  e.g. '["Yes","No"]'
//                                       '["Home","Draw","Away"]'
//                                       '["Up","Down"]'
//    clobTokenIds  → JSON string  e.g. '["tokA","tokB"]'
//    outcomePrices → JSON string  e.g. '["0.78","0.22"]'
//
//  Index i in all three arrays refers to the same outcome.
// ─────────────────────────────────────────
function parseMarketCandidates(market) {
  try {
    const outcomes = JSON.parse(market.outcomes      || '[]');
    const tokenIds = JSON.parse(market.clobTokenIds  || '[]');
    const prices   = JSON.parse(market.outcomePrices || '[]');
    if (!outcomes.length || !tokenIds.length) return [];
    return outcomes.map((outcome, i) => ({
      outcome,
      tokenId: tokenIds[i] || null,
      price:   parseFloat(prices[i] || 0),
    })).filter(c => c.tokenId && c.price > 0);
  } catch (_) {
    return [];
  }
}

// ─────────────────────────────────────────
//  Market discovery
//
//  GET /events with:
//    active=true          → only live markets
//    closed=false         → exclude resolved
//    end_date_min=NOW     → don't fetch already-ended events
//    end_date_max=NOW+60m → only events ending within window
//    order=end_date       → nearest expiry first
//    limit=100            → paginate if needed
//
//  Returns flat array of candidates:
//    { eventTitle, question, marketId, tokenId, outcome, price, expiresAt }
//  Only those where outcomePrices shows price > MIN_SIGNAL_PRICE.
// ─────────────────────────────────────────
async function discoverNearExpiryMarkets() {
  const now    = new Date();
  const future = new Date(now.getTime() + WINDOW_MINS * 60 * 1000);
  const minStr = now.toISOString();
  const maxStr = future.toISOString();

  const candidates = [];
  let offset = 0;

  while (true) {
    const url =
      `${GAMMA}/events?active=true&closed=false` +
      `&end_date_min=${encodeURIComponent(minStr)}` +
      `&end_date_max=${encodeURIComponent(maxStr)}` +
      `&limit=100&offset=${offset}&order=end_date&ascending=true`;

    const events = await getJSON(url);
    if (!Array.isArray(events) || events.length === 0) break;

    for (const ev of events) {
      const markets   = ev.markets || [];
      const expiresAt = ev.endDate ? new Date(ev.endDate).getTime() : null;

      for (const m of markets) {
        // Skip closed, inactive, or not accepting orders
        if (m.closed || m.active === false) continue;
        if (m.acceptingOrders === false)     continue;

        const parsed = parseMarketCandidates(m);
        for (const c of parsed) {
          if (c.price > MIN_SIGNAL_PRICE) {
            candidates.push({
              eventTitle: ev.title || ev.slug || '',
              question:   m.question || m.groupItemTitle || m.title || '',
              marketId:   m.id,
              tokenId:    c.tokenId,
              outcome:    c.outcome,
              price:      c.price,
              expiresAt,
            });
          }
        }
      }
    }

    if (events.length < 100) break; // last page
    offset += 100;
  }

  return candidates;
}

// ─────────────────────────────────────────
//  Live price — single token (for pre-entry confirmation)
// ─────────────────────────────────────────
async function fetchPrice(tokenId) {
  try {
    const d = await getJSON(`${CLOB}/midpoint?token_id=${tokenId}`);
    const p = parseFloat(d.mid || d.price || 0);
    return p > 0 ? p : null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────
//  Bulk price fetch — for position monitoring
// ─────────────────────────────────────────
async function fetchPrices(tokenIds) {
  if (!tokenIds.length) return {};
  try {
    const d   = await postJSON(`${CLOB}/prices`, { token_ids: tokenIds });
    const arr = Array.isArray(d) ? d : Object.values(d);
    const map = {};
    for (const item of arr) {
      const id = item.token_id || item.asset_id || item.tokenId;
      const p  = parseFloat(item.price || item.mid || 0);
      if (id && p > 0) map[id] = p;
    }
    return map;
  } catch (_) {
    // Fallback: individual fetches
    const map = {};
    for (const id of tokenIds) {
      const p = await fetchPrice(id);
      if (p !== null) map[id] = p;
    }
    return map;
  }
}

// ─────────────────────────────────────────
//  Order helpers (DRY_RUN simulates locally)
// ─────────────────────────────────────────
async function placeLimitBuy(tokenId, shares, price) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
}

async function placeLimitSell(tokenId, shares, price) {
  if (!DRY_RUN && trader) return await trader.limitSell(tokenId, shares, price);
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
}

async function cancelOrder(orderId) {
  if (!orderId || DRY_RUN || !trader) return;
  try { await trader.cancelOrder(orderId); } catch (e) { log(`⚠️  cancelOrder: ${e.message}`); }
}

// ─────────────────────────────────────────
//  Enter a position
// ─────────────────────────────────────────
async function enterPosition(candidate) {
  const { tokenId, outcome, price, eventTitle, question, expiresAt } = candidate;

  if (seenTokens.has(tokenId))   return; // already evaluated this token
  if (positions.has(tokenId))    return; // already holding this token
  seenTokens.add(tokenId);              // mark as evaluated regardless of outcome

  if (cash < TRADE_AMOUNT) {
    log(`⚠️  Skip "${outcome}" on "${question.slice(0,35)}" — insufficient cash ($${cash.toFixed(2)} < $${TRADE_AMOUNT})`);
    return;
  }

  // Live price confirmation (outcomePrices may be up to ~30 s stale)
  const livePrice = await fetchPrice(tokenId);
  if (livePrice === null) {
    log(`⏭️  Skip "${outcome}" on "${question.slice(0,35)}" — price unavailable`);
    return;
  }
  if (livePrice < MIN_SIGNAL_PRICE) {
    log(`⏭️  Skip "${outcome}" on "${question.slice(0,35)}" — live price ${livePrice.toFixed(3)} < ${MIN_SIGNAL_PRICE}`);
    return;
  }

  const entryPrice = round4(livePrice);
  const shares     = round2(TRADE_AMOUNT / entryPrice);
  const cost       = round2(entryPrice * shares);

  const buyOrder = await placeLimitBuy(tokenId, shares, entryPrice);
  cash = round2(cash - cost);

  const tpOrder = await placeLimitSell(tokenId, shares, TP_PRICE);

  positions.set(tokenId, {
    tokenId,
    eventTitle,
    question,
    outcome,
    entryPrice,
    shares,
    cost,
    tpOrderId:     tpOrder.id || tpOrder.orderId || null,
    tpPrice:       TP_PRICE,
    openedAt:      Date.now(),
    expiresAt,
    status:        'open',
    currentPrice:  entryPrice,
    unrealizedPnl: 0,
    realizedPnl:   null,
  });

  const expStr = expiresAt
    ? `expires ${new Date(expiresAt).toISOString().slice(11, 19)}Z`
    : 'no expiry';
  log(`✅ ENTER [${outcome}] "${question.slice(0,40)}" @ ${entryPrice.toFixed(3)} | $${cost.toFixed(2)} | ${shares.toFixed(2)} sh | TP ${TP_PRICE} | ${expStr}`);
  trades.push({
    time:    new Date().toISOString().slice(11, 19),
    type:    'BUY',
    market:  question.slice(0, 40),
    outcome,
    price:   entryPrice,
    shares,
    cost,
    pnl:     null,
  });
  if (trades.length > 200) trades.shift();
}

// ─────────────────────────────────────────
//  Check positions for TP hit or expiry
// ─────────────────────────────────────────
async function checkPositions(priceMap) {
  const now = Date.now();

  for (const [tokenId, pos] of positions) {
    if (pos.status !== 'open') continue;

    const livePrice = priceMap[tokenId] ?? pos.currentPrice;
    pos.currentPrice   = livePrice;
    pos.unrealizedPnl  = round2((livePrice - pos.entryPrice) * pos.shares);

    // ── Take-profit hit ──
    if (livePrice >= TP_PRICE) {
      await cancelOrder(pos.tpOrderId);
      await placeLimitSell(tokenId, pos.shares, TP_PRICE);
      const proceeds = round2(TP_PRICE * pos.shares);
      const profit   = round2(proceeds - pos.cost);
      cash = round2(cash + proceeds);
      pos.status       = 'closed';
      pos.realizedPnl  = profit;
      pos.unrealizedPnl = 0;
      log(`💰 TP HIT [${pos.outcome}] "${pos.question.slice(0,35)}" | ${pos.entryPrice.toFixed(3)} → ${TP_PRICE} | profit $${profit.toFixed(2)}`);
      trades.push({
        time: new Date().toISOString().slice(11, 19),
        type: 'SELL_TP',
        market: pos.question.slice(0, 40),
        outcome: pos.outcome,
        price: TP_PRICE,
        shares: pos.shares,
        cost: pos.cost,
        pnl: profit,
      });
      if (trades.length > 200) trades.shift();
      continue;
    }

    // ── Market expired without TP ──
    if (pos.expiresAt && now > pos.expiresAt + 5_000) {
      await cancelOrder(pos.tpOrderId);
      const exitPrice = round4(livePrice || pos.entryPrice);
      await placeLimitSell(tokenId, pos.shares, exitPrice);
      const proceeds = round2(exitPrice * pos.shares);
      const profit   = round2(proceeds - pos.cost);
      cash = round2(cash + proceeds);
      pos.status       = 'closed';
      pos.realizedPnl  = profit;
      pos.unrealizedPnl = 0;
      log(`🏁 EXPIRED [${pos.outcome}] "${pos.question.slice(0,35)}" | exit ${exitPrice.toFixed(3)} | pnl $${profit.toFixed(2)}`);
      trades.push({
        time: new Date().toISOString().slice(11, 19),
        type: 'SELL_EXPIRE',
        market: pos.question.slice(0, 40),
        outcome: pos.outcome,
        price: exitPrice,
        shares: pos.shares,
        cost: pos.cost,
        pnl: profit,
      });
      if (trades.length > 200) trades.shift();
    }
  }

  // Prune closed positions after 5 min to keep the map lean
  for (const [tokenId, pos] of positions) {
    if (pos.status === 'closed' && now - pos.openedAt > 5 * 60_000) {
      positions.delete(tokenId);
    }
  }
}

// ─────────────────────────────────────────
//  Scan cycle: discover + enter new positions
// ─────────────────────────────────────────
async function scanAndEnter() {
  log(`🔭 Scanning markets expiring within ${WINDOW_MINS} min (threshold > ${MIN_SIGNAL_PRICE})…`);
  try {
    const candidates = await discoverNearExpiryMarkets();
    const fresh = candidates.filter(c => !seenTokens.has(c.tokenId));
    log(`📋 ${candidates.length} total candidates | ${fresh.length} new (not yet seen)`);
    for (const c of fresh) {
      await enterPosition(c);
    }
  } catch (e) {
    log(`⚠️  Scan error: ${e.message}`);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const open   = [...positions.values()].filter(p => p.status === 'open');
  const closed = [...positions.values()].filter(p => p.status === 'closed');

  const totalUnrealized = round2(open.reduce((s, p) => s + p.unrealizedPnl, 0));
  const totalRealized   = round2([...positions.values()]
    .filter(p => p.realizedPnl !== null)
    .reduce((s, p) => s + p.realizedPnl, 0));
  const markValue = round2(cash + open.reduce((s, p) => s + p.currentPrice * p.shares, 0));

  return {
    dryRun:         DRY_RUN,
    cash,
    totalCapital:   TOTAL_CAPITAL,
    tradeAmount:    TRADE_AMOUNT,
    markValue,
    totalPnl:       round2(markValue - TOTAL_CAPITAL),
    totalRealized,
    totalUnrealized,
    uptime:         Math.floor((Date.now() - startTime) / 1000),
    windowMins:     WINDOW_MINS,
    minPrice:       MIN_SIGNAL_PRICE,
    tpPrice:        TP_PRICE,
    openCount:      open.length,
    nextScanIn:     Math.max(0, Math.round((lastScan + SCAN_INTERVAL_MS - Date.now()) / 1000)),
    positions:      open.map(p => ({
      tokenId:       p.tokenId,
      question:      p.question,
      eventTitle:    p.eventTitle,
      outcome:       p.outcome,
      entryPrice:    p.entryPrice,
      currentPrice:  p.currentPrice,
      shares:        p.shares,
      cost:          p.cost,
      tpPrice:       p.tpPrice,
      unrealizedPnl: p.unrealizedPnl,
      expiresAt:     p.expiresAt ? new Date(p.expiresAt).toISOString() : null,
      secsLeft:      p.expiresAt ? Math.max(0, Math.floor((p.expiresAt - Date.now()) / 1000)) : null,
    })),
    logs:   logs.slice(-80),
    trades: trades.slice(-60).reverse(),
  };
}

// ─────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────
async function mainLoop() {
  while (true) {
    try {
      const now = Date.now();

      if (now - lastScan >= SCAN_INTERVAL_MS) {
        lastScan = now;
        await scanAndEnter();
      }

      if (now - lastPriceRefresh >= PRICE_REFRESH_MS) {
        lastPriceRefresh = now;
        const openIds = [...positions.values()]
          .filter(p => p.status === 'open')
          .map(p => p.tokenId);
        if (openIds.length) {
          const priceMap = await fetchPrices(openIds);
          await checkPositions(priceMap);
        }
      }

      emitFn('state', buildState());
    } catch (e) {
      log(`⚠️  Loop error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  Stubs kept for index.js API route compat
// ─────────────────────────────────────────
async function searchMatch() {
  return { ok: false, error: 'Auto-discovery mode — no manual market loading.' };
}
async function searchMarkets() {
  return { ok: false, error: 'Auto-discovery mode — monitor positions on dashboard.' };
}
async function loadMarket() {
  return { ok: false, error: 'Auto-discovery mode active.' };
}

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog   = slogFn;
  log(`🚀 Expiry Sniper Bot — started`);
  log(`⚙️  Capital $${TOTAL_CAPITAL} | ${TRADE_PCT * 100}% per trade = $${TRADE_AMOUNT} | Window ${WINDOW_MINS} min | Signal > ${MIN_SIGNAL_PRICE} | TP ${TP_PRICE}`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  lastScan         = 0;
  lastPriceRefresh = 0;
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, searchMatch, searchMarkets, loadMarket };
