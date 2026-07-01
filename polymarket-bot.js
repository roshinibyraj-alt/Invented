'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET COMPOUNDING SCALP BOT — BTC 5-MIN UP/DOWN WINDOW
 * ═══════════════════════════════════════════════════════════════
 *
 *  Single full-stack position, no blocks. Buy the chosen side, sell
 *  into strength, rebuy the dip with the WHOLE stack (winnings
 *  included), repeat — compounding within one 5-min window.
 *
 *  RULES:
 *   - Enter: buy 100% of available cash the moment the window loads.
 *   - Exit:  sell 100% of shares when price >= lastBuyPrice + SELL_TRIGGER
 *   - Re-enter: buy 100% of proceeds when price <= lastSellPrice - REBUY_TRIGGER
 *   - FREEZE_SECS before resolution: stop scalping entirely. Whatever
 *     state you're in (LONG or FLAT) rides to actual settlement.
 *     No forced exit — Polymarket auto-redeems winning shares at
 *     resolution, so a held position just pays out or goes to zero.
 *
 *  NO stop loss. If you're LONG and price craters instead of bouncing
 *  back to the rebuy trigger... there is no rebuy trigger, you're
 *  just holding into the freeze and then into resolution. This is
 *  intentional per your stated risk tolerance — full stack, one window.
 *
 *  REALISM NOTES:
 *   - Fills use an aggressive limit (price +/- FILL_BUFFER) to get
 *     taken immediately rather than resting — you're reacting to
 *     price, not front-running it. Real fills may differ from the
 *     price your example assumed, especially as the stack grows and
 *     you start moving thinner order books.
 *   - Multiple full round trips inside a 5-min window depend on the
 *     underlying BTC price actually oscillating that much before the
 *     window locks in a direction near expiry. Late in the window,
 *     don't expect round trips — expect a trend to one side.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Timing ──
const TICK_MS           = 500;
const PRICE_REFRESH_MS  = 500;

// ── Strategy constants (env-overridable) ──
const CAPITAL                = Number(process.env.SCALP_CAPITAL || 2000);
const SELL_TRIGGER           = Number(process.env.SELL_TRIGGER_OFFSET || 0.10);  // sell at buy + this
const REBUY_TRIGGER          = Number(process.env.REBUY_TRIGGER_OFFSET || 0.05); // rebuy at sell - this
const FREEZE_SECS            = Number(process.env.FREEZE_SECS_BEFORE_END || 30); // stop scalping this long before resolution
const FILL_BUFFER            = Number(process.env.FILL_BUFFER || 0.01);          // pay up slightly to get filled now
const FORCE_ENTRY_ON_FREEZE  = (process.env.FORCE_ENTRY_ON_FREEZE || 'false').toLowerCase() === 'true';

// ── Env ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// ── State ──
let emitFn         = () => {};
let slog           = () => {};
let trader         = null;
let startTime      = Date.now();
let lastPriceFetch = 0;
let logs           = [];
let trades         = [];
let windowEndTime  = null;
let tokenId        = null;
let market         = null;
let currentPrice   = null;
let eventInfo      = { title: null, slug: null };
let tradeSide      = null;
let frozen         = false;

// position state
let state          = 'FLAT'; // 'FLAT' | 'LONG'
let cash           = CAPITAL;
let shares         = 0;
let lastBuyPrice   = null;
let lastSellPrice  = null;
let roundTrips     = 0;
let realizedPnl    = 0;

// ─────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 300) logs.shift();
  slog(line);
}

// ─────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function round2(n) { return Math.round(n * 100) / 100; }

// ─────────────────────────────────────────
//  Slug parsing
// ─────────────────────────────────────────
function extractSlug(input) {
  if (!input) return null;
  let s = input.trim();
  try {
    if (s.includes('polymarket.com')) {
      const u = new URL(s.startsWith('http') ? s : `https://${s}`);
      const parts = u.pathname.split('/').filter(Boolean);
      s = parts[parts.length - 1] || s;
    }
  } catch (_) {}
  return s.split('?')[0];
}

function qOf(m) {
  return (m.question || m.groupItemTitle || m.title || '').toLowerCase();
}

function parseMarketTokens(m) {
  try {
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
    const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) {
    return [];
  }
}

function tokenIdForSide(m, side) {
  const tokens = parseMarketTokens(m);
  const want = (side || '').trim().toLowerCase();
  const tok = tokens.find(t => (t.outcome || '').toLowerCase() === want);
  return tok?.token_id || null;
}

// ─────────────────────────────────────────
//  Market discovery — same pattern as the block-ladder bot: direct
//  slug/URL lookup first (fast path for timestamp-named 5m windows),
//  fall back to Gamma keyword search.
// ─────────────────────────────────────────
function looksLikeUrlOrSlug(input) {
  const s = input.trim();
  if (s.includes('polymarket.com')) return true;
  return !/\s/.test(s) && s.includes('-');
}

async function searchMarkets(query) {
  if (!query || !query.trim()) return { ok: false, error: 'Missing search query' };
  const q = query.trim();

  if (looksLikeUrlOrSlug(q)) {
    const slug = extractSlug(q);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id) {
        const markets = event.markets || [];
        const results = [];
        for (const m of markets) {
          const tokens = parseMarketTokens(m);
          if (!tokens.length || tokens.every(t => !t.token_id)) continue;
          results.push({
            eventSlug: event.slug,
            eventTitle: event.title || event.slug,
            marketId: m.id,
            question: m.question || qOf(m),
            outcomes: tokens.map(t => t.outcome),
            endDate: event.endDate || m.endDate || null,
          });
        }
        if (results.length > 0) return { ok: true, results };
        return { ok: false, error: 'Event found but no tradable markets on it' };
      }
    } catch (e) {
      log(`⚠️  Direct slug lookup failed for "${slug}": ${e.message} — falling back to keyword search`);
    }
  }

  try {
    const url = `${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=15&events_status=active`;
    const data = await getJSON(url);
    const events = data.events || data.Events || [];
    const results = [];
    for (const ev of events) {
      const markets = ev.markets || ev.Markets || [];
      for (const m of markets) {
        const tokens = parseMarketTokens(m);
        if (!tokens.length || tokens.every(t => !t.token_id)) continue;
        if (m.closed === true || m.active === false) continue;
        results.push({
          eventSlug: ev.slug,
          eventTitle: ev.title || ev.slug,
          marketId: m.id,
          question: m.question || qOf(m),
          outcomes: tokens.map(t => t.outcome),
          endDate: ev.endDate || m.endDate || null,
        });
      }
    }
    return { ok: true, results: results.slice(0, 40) };
  } catch (e) {
    log(`❌ searchMarkets error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Load a BTC 5m window + chosen side ("Up" / "Down"), reset position to fresh $CAPITAL
async function loadWindow({ eventSlug, marketId, side }) {
  if (!eventSlug) return { ok: false, error: 'Missing eventSlug' };
  if (!side) return { ok: false, error: 'Missing side (e.g. "Up", "Down")' };
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(eventSlug)}`);
    if (!event || !event.id) return { ok: false, error: 'Event not found' };

    const markets = event.markets || [];
    let m = marketId ? markets.find(x => String(x.id) === String(marketId)) : null;
    if (!m && markets.length === 1) m = markets[0];
    if (!m) return { ok: false, error: 'Market not found — pass marketId from search results' };

    const tid = tokenIdForSide(m, side);
    if (!tid) {
      const tokens = parseMarketTokens(m);
      return { ok: false, error: `Side "${side}" not found. Available: ${tokens.map(t => t.outcome).join(', ')}` };
    }

    tokenId = tid;
    market = m;
    tradeSide = side;
    eventInfo = { title: event.title || event.slug, slug: eventSlug };
    const rawEnd = event.endDate || m.endDate;
    windowEndTime = rawEnd ? new Date(rawEnd).getTime() : null;

    resetPosition();
    resetSession();
    currentPrice = null;

    log(`✅ Window loaded: ${eventInfo.title} — trading "${side}" | token ${tid}`);
    if (windowEndTime) log(`⏰ Resolves: ${new Date(windowEndTime).toISOString()} | freeze at T-${FREEZE_SECS}s`);
    else log(`⚠️  No end time found on this market — freeze logic disabled until confirmed`);

    return { ok: true, title: eventInfo.title, slug: eventSlug, side, question: qOf(m) };
  } catch (e) {
    log(`❌ loadWindow error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function resetPosition() {
  state = 'FLAT';
  cash = CAPITAL;
  shares = 0;
  lastBuyPrice = null;
  lastSellPrice = null;
  roundTrips = 0;
  realizedPnl = 0;
  frozen = false;
}

function resetSession() {
  logs = [];
  trades = [];
  startTime = Date.now();
}

// ─────────────────────────────────────────
//  Price refresh
// ─────────────────────────────────────────
async function refreshPrice() {
  if (!tokenId) return;
  try {
    let price = null;
    try {
      const res = await fetch(`${CLOB}/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_ids: [tokenId] }),
      });
      const d = await res.json();
      const arr = Array.isArray(d) ? d : Object.values(d);
      const item = arr.find(x => (x.token_id || x.asset_id || x.tokenId) === tokenId) || arr[0];
      const p = parseFloat(item?.price || item?.mid || 0);
      if (p > 0) price = p;
    } catch (_) {
      const d = await getJSON(`${CLOB}/midpoint?token_id=${tokenId}`);
      const p = parseFloat(d.mid || d.price || 0);
      if (p > 0) price = p;
    }
    if (price !== null) currentPrice = price;
  } catch (e) {
    log(`⚠️  Price refresh failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────
//  Order execution — aggressive limit (marketable) so we get filled
//  on this tick rather than resting and waiting for an exact touch.
// ─────────────────────────────────────────
async function placeMarketableBuy(price, dollars) {
  const limitPrice = round2(Math.min(0.99, price + FILL_BUFFER));
  const sh = round2(dollars / limitPrice);
  if (!DRY_RUN && trader) {
    const order = await trader.limitBuy(tokenId, sh, limitPrice);
    return { id: order.id || order.orderId, price: limitPrice, shares: sh };
  }
  return { id: `dry-buy-${Date.now()}`, price: limitPrice, shares: sh };
}

async function placeMarketableSell(price, shareQty) {
  const limitPrice = round2(Math.max(0.01, price - FILL_BUFFER));
  if (!DRY_RUN && trader) {
    const order = await trader.limitSell(tokenId, shareQty, limitPrice);
    return { id: order.id || order.orderId, price: limitPrice };
  }
  return { id: `dry-sell-${Date.now()}`, price: limitPrice };
}

// ─────────────────────────────────────────
//  Core compounding scalp engine
// ─────────────────────────────────────────
async function enterPosition(price, reason) {
  const dollars = cash;
  if (dollars <= 0) return;
  const fill = await placeMarketableBuy(price, dollars);
  shares = fill.shares;
  cash = 0;
  lastBuyPrice = fill.price;
  state = 'LONG';
  log(`🟢 BUY (${reason}) ${shares}sh @ ${fill.price.toFixed(2)} | stack=$${dollars.toFixed(2)}`);
  trades.push({ time: new Date().toISOString().slice(11, 19), side: 'BUY', price: fill.price, shares, reason, stack: dollars });
  if (trades.length > 200) trades.shift();
}

async function exitPosition(price, reason) {
  const sh = shares;
  if (sh <= 0) return;
  const fill = await placeMarketableSell(price, sh);
  const proceeds = round2(sh * fill.price);
  const cost = round2(lastBuyPrice * sh);
  const profit = round2(proceeds - cost);
  cash = proceeds;
  shares = 0;
  lastSellPrice = fill.price;
  realizedPnl = round2(realizedPnl + profit);
  roundTrips += 1;
  state = 'FLAT';
  log(`🔴 SELL (${reason}) ${sh}sh @ ${fill.price.toFixed(2)} | proceeds=$${proceeds.toFixed(2)} | profit=$${profit.toFixed(2)} | stack now $${proceeds.toFixed(2)}`);
  trades.push({ time: new Date().toISOString().slice(11, 19), side: 'SELL', price: fill.price, shares: sh, profit, reason, stack: proceeds });
  if (trades.length > 200) trades.shift();
}

async function tick(price) {
  if (price === null || !tokenId) return;

  // Freeze window: stop scalping N seconds before resolution. Whatever
  // exists (LONG or FLAT) rides to actual settlement — no manual exit,
  // Polymarket auto-redeems winning shares.
  if (windowEndTime && !frozen) {
    const secsLeft = (windowEndTime - Date.now()) / 1000;
    if (secsLeft <= FREEZE_SECS) {
      frozen = true;
      const desc = state === 'LONG'
        ? `LONG ${shares}sh @ ${lastBuyPrice.toFixed(2)} — riding to settlement`
        : 'FLAT — no exposure this window';
      log(`🧊 FREEZE (T-${FREEZE_SECS}s) — ${desc}`);
      if (state === 'FLAT' && FORCE_ENTRY_ON_FREEZE && cash > 0) {
        await enterPosition(price, 'force-entry-on-freeze');
      }
    }
  }
  if (frozen) return;

  if (state === 'FLAT') {
    if (lastSellPrice === null) {
      await enterPosition(price, 'initial-entry');
    } else if (price <= round2(lastSellPrice - REBUY_TRIGGER)) {
      await enterPosition(price, `rebuy dip -${REBUY_TRIGGER}`);
    }
  } else if (state === 'LONG') {
    if (price >= round2(lastBuyPrice + SELL_TRIGGER)) {
      await exitPosition(price, `take-profit +${SELL_TRIGGER}`);
    }
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const price = currentPrice;
  const markValue = state === 'LONG' && price !== null ? round2(shares * price) : cash;
  const unrealizedPnl = state === 'LONG' && price !== null ? round2((price - lastBuyPrice) * shares) : 0;

  return {
    dryRun: DRY_RUN,
    eventTitle: eventInfo.title,
    tradeSide,
    price,
    state,
    cash,
    shares,
    lastBuyPrice,
    lastSellPrice,
    markValue,
    unrealizedPnl,
    realizedPnl,
    totalPnl: round2(markValue - CAPITAL),
    roundTrips,
    frozen,
    windowEndTime: windowEndTime ? new Date(windowEndTime).toISOString() : null,
    secsToEnd: windowEndTime ? Math.floor((windowEndTime - Date.now()) / 1000) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    logs: logs.slice(-80),
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
      if (tokenId && now - lastPriceFetch > PRICE_REFRESH_MS) {
        await refreshPrice();
        lastPriceFetch = now;
        if (currentPrice !== null) await tick(currentPrice);
      }
      emitFn('state', buildState());
    } catch (e) {
      log(`⚠️  Loop error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Compounding Scalp Bot — BTC 5m window`);
  log(`⚙️  capital=$${CAPITAL} | sell@+${SELL_TRIGGER} | rebuy@-${REBUY_TRIGGER} | freeze T-${FREEZE_SECS}s | forceEntryOnFreeze=${FORCE_ENTRY_ON_FREEZE}`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for data/order calls' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, searchMatch, searchMarkets, loadMarket };
