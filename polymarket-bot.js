'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET TWO-LAYER COMPOUNDING BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  CAPITAL: $2000 split into 10 blocks x $200 (0.01-0.99)
 *
 *  LAYER 1 — GRID TRADING ($140/block, 70%):
 *   4 resting limit BUY rungs below each block's pivot.
 *   Each fill -> TP at entry+0.06. Profit compounds back into grid pool.
 *   Grid capital cascades upward as price moves through blocks.
 *     First cascade: full grid pool moves up.
 *     Repeat cascade (block revisited): only profit above $140 base moves up.
 *   LOW-BLOCK GRID POWER: block 1 rung 4 @ 0.015 pays 400% per fill.
 *
 *  LAYER 2 — CONVICTION HOLDS ($60/block, 30%):
 *   On FIRST block activation, $60 buys shares at the live price, NO TP.
 *   Shares ride to resolution at $1.00/share.
 *     $60 @ 0.055 (block 1) = 1091 shares -> $1091 at win (18x)
 *     $60 @ 0.02 extreme    = 3000 shares -> $3000 at win (50x!)
 *   All 10 blocks conviction: $600 invested -> $2451 at win (4.1x).
 *   Conviction shares NEVER cascade — stay in-block until resolution.
 *
 *  LAYER 3 — ENDGAME ALL-IN (ALLIN_SECS before resolution):
 *   If price >= ALLIN_PRICE_THRESHOLD (0.70): cancel all grid orders,
 *   pool ALL idle grid capital from every block, buy shares at live price.
 *   Hold to resolution — maximises payout on a confirmed win.
 *
 *  ENDGAME (ENDGAME_SECS before close):
 *   Sell all positions (grid TPs, conviction, all-in) at live price.
 *   Wrong-side (lost) positions close near zero automatically.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Target match — settable via env or dashboard URL search ──
let MATCH_EVENT_SLUG = process.env.MATCH_SLUG || 'fifwc-ger-par-2026-06-29';

// ── Timing ──
const TICK_MS               = 500;
const PRICE_REFRESH_MS      = 500;
const MARKET_REFETCH_MS     = 60_000;
const ENDGAME_SECS          = 10;       // force-close window before match end
const ALLIN_SECS            = 300;      // go all-in 5 min before end
const ALLIN_PRICE_THRESHOLD = 0.70;     // only all-in if price >= this (winning trajectory)

// ── Strategy constants ──
const TOTAL_CAPITAL   = 2000;
const NUM_BLOCKS      = 10;
const BLOCK_SIZE      = TOTAL_CAPITAL / NUM_BLOCKS;   // $200
const CONV_BLOCK      = 60;    // $60 per block -> conviction holds (30%)
const GRID_BLOCK      = 140;   // $140 per block -> active grid trading (70%)
const RUNGS_PER_BLOCK = 4;
const RUNG_OFFSET     = 0.01;  // pivot-0.01, -0.02, -0.03, -0.04
const TP_OFFSET       = 0.06;  // entry + 0.06

// ── Env ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// ── Block range definitions ──
function buildBlockDefs() {
  const defs = [];
  for (let i = 0; i < NUM_BLOCKS; i++) {
    const lo    = i === 0 ? 0.01 : i * 0.10;
    const hi    = i === NUM_BLOCKS - 1 ? 0.99 : (i + 1) * 0.10;
    const pivot = Math.round(((lo + hi) / 2) * 100) / 100;
    defs.push({ index: i, lo, hi, pivot });
  }
  return defs;
}
const BLOCK_DEFS = buildBlockDefs();

function blockIndexForPrice(price) {
  if (price < 0.01) return 0;
  if (price > 0.99) return NUM_BLOCKS - 1;
  for (const b of BLOCK_DEFS) {
    if (price >= b.lo && price < b.hi) return b.index;
  }
  return NUM_BLOCKS - 1;
}

// ── Global state ──
let emitFn          = () => {};
let slog            = () => {};
let trader          = null;
let startTime       = Date.now();
let lastPriceFetch  = 0;
let lastMarketFetch = 0;
let logs            = [];
let trades          = [];
let matchEndTime    = null;
let drawTokenId     = null;
let drawMarket      = null;
let currentNoPrice  = null;
let endgameTriggered = false;
let allInTriggered   = false;
let allInPosition    = null; // { shares, buyPrice, cost, orderId }
let eventInfo       = { title: null, slug: MATCH_EVENT_SLUG };
let tradeSide       = 'No';

let blocks = [];

/**
 * freshBlock — initialise a block's full state.
 *
 * Layer 1 Grid ($140):  gridCapital starts at GRID_BLOCK.
 *   Cascades upward when price exits block. First cascade: full pool.
 *   Repeat cascade: profit only (base $140 stays for next revisit).
 *
 * Layer 2 Conviction ($60):  convCapital starts at CONV_BLOCK.
 *   Deployed ONCE on first block activation at the live price.
 *   Shares held with no TP — ride to $1.00 at resolution.
 *   Never cascades, never reseeds.
 */
function freshBlock(def) {
  return {
    index: def.index,
    lo:    def.lo,
    hi:    def.hi,
    pivot: def.pivot,
    // Layer 1: Grid
    gridCapital:    GRID_BLOCK,  // idle cash available for grid orders
    realizedGridPnl: 0,
    // Layer 2: Conviction
    convCapital:  CONV_BLOCK,   // $60 ready to deploy on first activation
    convShares:   0,             // shares held, no TP
    convCost:     0,             // total $ spent on conviction
    convBuyPrice: null,          // live price at time of conviction buy
    // Flags
    active:         false,
    everActivated:  false,       // true once block has armed/traded
    cascadedBefore: false,       // true after first grid cascade (determines full vs profit-only)
    rungs: Array.from({ length: RUNGS_PER_BLOCK }, (_, i) => ({
      offsetIdx:      i + 1,    // 1..4 -> pivot - 0.01*offsetIdx
      restingOrderId: null,
      restingPrice:   null,
      restingSize:    null,
      position:       null,     // { shares, entryPrice, cost, tpOrderId, tpPrice }
    })),
  };
}

function resetAllBlocks() {
  blocks = BLOCK_DEFS.map(freshBlock);
}
resetAllBlocks();

function resetSession() {
  logs            = [];
  trades          = [];
  startTime       = Date.now();
  allInTriggered  = false;
  allInPosition   = null;
}

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

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function extractSlug(input) {
  if (!input) return null;
  let s = input.trim();
  try {
    if (s.includes('polymarket.com')) {
      const u = new URL(s.startsWith('http') ? s : `https://${s}`);
      const parts = u.pathname.split('/').filter(Boolean);
      s = parts[parts.length - 1] || s;
    }
  } catch (_) {
    const parts = s.split('/').filter(Boolean);
    s = parts[parts.length - 1] || s;
  }
  return s.split('?')[0];
}

// ─────────────────────────────────────────
//  Fetch event + find "Draw - Yes or No" sub-market
//
//  Gamma API market schema (from official docs):
//    outcomes     → JSON-encoded string: '["Yes","No"]'
//    clobTokenIds → JSON-encoded string: '["tokenIdYes","tokenIdNo"]'
//  The token at index i in clobTokenIds corresponds to outcomes[i].
//  There is NO `tokens` array — that field doesn't exist on Gamma markets.
//
//  Correct endpoint: GET /events/slug/{slug}  (not /events?slug=)
// ─────────────────────────────────────────
function qOf(m) {
  return (m.question || m.groupItemTitle || m.title || '').toLowerCase();
}

// Parse a Gamma market's outcomes+clobTokenIds into [{outcome, token_id}]
function parseMarketTokens(m) {
  try {
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
    const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) {
    return [];
  }
}

// Return the token_id for a given outcome label (e.g. "No", "Yes", "Up", "Down") - generic
function tokenIdForSide(market, side) {
  const tokens = parseMarketTokens(market);
  const want = (side || '').trim().toLowerCase();
  const tok = tokens.find(t => (t.outcome || '').toLowerCase() === want);
  return tok?.token_id || null;
}

// Return the NO token_id from a Gamma market, or null
function noTokenIdFromMarket(m) {
  return tokenIdForSide(m, 'no');
}

function findDrawMarket(markets) {
  for (const m of markets) {
    const q = qOf(m);
    if (q.includes('draw')) return m;
  }
  return null;
}

async function loadMatch(slugInput) {
  const slug = extractSlug(slugInput) || MATCH_EVENT_SLUG;
  MATCH_EVENT_SLUG = slug;
  log(`🔭 Loading match: ${slug}`);
  try {
    // Correct endpoint per Polymarket docs: GET /events/slug/{slug}
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
    if (!event || !event.id) {
      log(`❌ No event found for slug "${slug}"`);
      return { ok: false, error: 'Event not found' };
    }
    const markets = event.markets || [];
    log(`📋 ${markets.length} sub-markets found in event`);

    const draw = findDrawMarket(markets);
    if (!draw) {
      const names = markets.map(m => qOf(m)).join(' | ');
      log(`❌ No draw market found. Markets: ${names}`);
      return { ok: false, error: 'Draw market not found in this event' };
    }

    const tid = noTokenIdFromMarket(draw);
    if (!tid) {
      log(`❌ Draw market found ("${qOf(draw)}") but NO token id is missing. outcomes=${draw.outcomes} clobTokenIds=${draw.clobTokenIds}`);
      return { ok: false, error: 'NO token id missing on draw market' };
    }

    drawMarket = draw;
    drawTokenId = tid;
    tradeSide = 'No';
    eventInfo = { title: event.title || event.slug, slug };
    matchEndTime = sanitizeEndTime(event.endDate, draw);
    endgameTriggered = false;

    resetAllBlocks();
    resetSession();
    currentNoPrice = null;

    log(`✅ Match loaded: ${eventInfo.title}`);
    log(`🎯 Draw market: "${qOf(draw)}" | NO token: ${tid}`);
    if (matchEndTime) log(`⏰ Match ends (est.): ${new Date(matchEndTime).toISOString()}`);
    else log(`⚠️  No reliable end time yet — endgame auto-exit disabled until one is confirmed`);

    return { ok: true, title: eventInfo.title, slug };
  } catch (e) {
    log(`❌ loadMatch error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────
//  GENERIC MARKET DISCOVERY & SELECTION
//  Lets the dashboard search ANY Polymarket market (crypto up/down,
//  generic Yes/No, etc.) — not just the soccer "Draw" sub-market —
//  and lets the user pick which side (outcome label) to trade.
// ─────────────────────────────────────────

// Search Gamma's public search for events/markets matching a keyword
// (e.g. "bitcoin up or down", "fed rate", "premier league") — OR, if the
// input looks like a direct Polymarket URL/slug (e.g. someone pasted
// https://polymarket.com/event/btc-updown-15m-1782798300), fetch that
// event directly. This matters a lot for short-lived markets (5m/15m/1h
// crypto up-down windows named by unix timestamp) which Gamma's keyword
// search frequently does NOT index in time, since they're created and
// expire every few minutes.
function looksLikeUrlOrSlug(input) {
  const s = input.trim();
  if (s.includes('polymarket.com')) return true;
  // bare slug: no spaces, has at least one hyphen (e.g. btc-updown-15m-1782798300)
  return !/\s/.test(s) && s.includes('-');
}

async function searchMarkets(query) {
  if (!query || !query.trim()) return { ok: false, error: 'Missing search query' };
  const q = query.trim();

  // 1) Direct URL/slug path — try this first since it's exact and fast.
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
        log(`⚠️  Event "${slug}" found but has no tradable (open) markets`);
        return { ok: false, error: `Event found but no tradable markets on it (may be closed/resolved)` };
      }
      // fall through to keyword search if slug lookup 404'd
    } catch (e) {
      log(`⚠️  Direct slug lookup failed for "${slug}": ${e.message} — falling back to keyword search`);
    }
  }

  // 2) Keyword/full-text search path.
  try {
    const url = `${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=15&events_status=active`;
    const data = await getJSON(url);
    const events = data.events || data.Events || [];
    const results = [];

    for (const ev of events) {
      const markets = ev.markets || ev.Markets || [];
      for (const m of markets) {
        const tokens = parseMarketTokens(m);
        if (!tokens.length || tokens.every(t => !t.token_id)) continue; // not tradable
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

// Load any market by event slug + market id, trading the chosen outcome side.
// Reuses the exact same shared state (drawMarket/drawTokenId/matchEndTime/etc.)
// that the block-ladder engine already operates on — it's agnostic to what
// the underlying market actually is.
async function loadMarket({ eventSlug, marketId, side }) {
  if (!eventSlug) return { ok: false, error: 'Missing eventSlug' };
  if (!side) return { ok: false, error: 'Missing side (e.g. "Yes", "No", "Up", "Down")' };
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(eventSlug)}`);
    if (!event || !event.id) return { ok: false, error: 'Event not found' };

    const markets = event.markets || [];
    let market = marketId ? markets.find(m => String(m.id) === String(marketId)) : null;
    if (!market && markets.length === 1) market = markets[0];
    if (!market) return { ok: false, error: 'Market not found in event — pass marketId from search results' };

    const tid = tokenIdForSide(market, side);
    if (!tid) {
      const tokens = parseMarketTokens(market);
      return { ok: false, error: `Side "${side}" not found. Available outcomes: ${tokens.map(t => t.outcome).join(', ')}` };
    }

    MATCH_EVENT_SLUG = eventSlug;
    drawMarket = market;
    drawTokenId = tid;
    tradeSide = side;
    eventInfo = { title: event.title || event.slug, slug: eventSlug };
    matchEndTime = sanitizeEndTime(event.endDate, market);
    endgameTriggered = false;

    resetAllBlocks();
    resetSession();
    currentNoPrice = null;

    log(`✅ Market loaded: ${eventInfo.title} — "${qOf(market)}" — trading "${side}"`);
    log(`🎯 Token: ${tid}`);
    if (matchEndTime) log(`⏰ Resolves (est.): ${new Date(matchEndTime).toISOString()}`);
    else log(`⚠️  No reliable end time yet — endgame auto-exit disabled until confirmed`);

    return { ok: true, title: eventInfo.title, slug: eventSlug, side, question: qOf(market) };
  } catch (e) {
    log(`❌ loadMarket error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────
//  Match end time — sanity-checked & periodically re-confirmed.
//
//  Why: Polymarket's Gamma `event.endDate` for live sports is frequently
//  just a rough scheduled estimate (e.g. kickoff + regulation time) and
//  does NOT account for stoppage time, extra time, delays, or postponed
//  starts. Trusting it blindly means the moment the match goes live and
//  real time crosses that estimate, `secsLeft` goes negative and the bot
//  force-triggers ENDGAME immediately — then stays idle for the rest of
//  the match (the trigger is a one-shot latch). To fix this:
//   1. A freshly-loaded endDate that's already <= now (or within a small
//      buffer) is treated as unreliable and discarded (-> null), so it
//      can never arm a false-positive endgame.
//   2. We periodically re-fetch the event while the match is loaded
//      (MARKET_REFETCH_MS) so a *real*, updated endDate (Polymarket does
//      push these out as matches run long) gets picked up.
//   3. We additionally watch the draw market's own `closed` flag as a
//      corroborating signal — only that, or a sane future endDate that
//      has actually arrived, should ever cause the bot to stop trading.
// ─────────────────────────────────────────
const END_TIME_STALE_BUFFER_MS = 60_000; // ignore endDate if already <=60s old when loaded/refetched

function sanitizeEndTime(rawEndDate, market) {
  if (!rawEndDate) return null;
  const t = new Date(rawEndDate).getTime();
  if (!Number.isFinite(t)) return null;
  if (t <= Date.now() + END_TIME_STALE_BUFFER_MS) {
    // Stale/too-soon estimate (typical for in-play sports markets) — don't trust it.
    return null;
  }
  return t;
}

// Re-pull the event during a live match to pick up a corrected endDate,
// and to check whether the draw market has actually closed/resolved.
async function refreshMatchEndTime() {
  if (!MATCH_EVENT_SLUG) return;
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(MATCH_EVENT_SLUG)}`);
    if (!event) return;

    const markets = event.markets || [];
    const draw = (drawMarket && markets.find(m => String(m.id) === String(drawMarket.id)))
              || findDrawMarket(markets)
              || drawMarket;

    // Corroborating hard signal: the draw market itself has actually closed.
    if (draw && draw.closed === true && !endgameTriggered) {
      log(`🏁 Draw market reports closed — forcing endgame exit now`);
      matchEndTime = Date.now(); // treat as "ended right now"
      await runEndgame();
      return;
    }

    const newEnd = sanitizeEndTime(event.endDate, draw);
    if (newEnd && newEnd !== matchEndTime) {
      matchEndTime = newEnd;
      log(`⏰ Match end time updated: ${new Date(matchEndTime).toISOString()}`);
    } else if (!newEnd && matchEndTime === null) {
      // still no reliable estimate — fine, we just keep trading without a timer
    }
  } catch (e) {
    log(`⚠️  refreshMatchEndTime error: ${e.message}`);
  }
}

// ─────────────────────────────────────────
//  Price refresh (NO token only)
// ─────────────────────────────────────────
async function refreshPrice() {
  if (!drawTokenId) return;
  try {
    let price = null;
    try {
      const d = await postJSON(`${CLOB}/prices`, { token_ids: [drawTokenId] });
      const arr = Array.isArray(d) ? d : Object.values(d);
      const item = arr.find(x => (x.token_id || x.asset_id || x.tokenId) === drawTokenId) || arr[0];
      const p = parseFloat(item?.price || item?.mid || 0);
      if (p > 0) price = p;
    } catch (_) {
      const d = await getJSON(`${CLOB}/midpoint?token_id=${drawTokenId}`);
      const p = parseFloat(d.mid || d.price || 0);
      if (p > 0) price = p;
    }
    if (price !== null) {
      currentNoPrice = price;
    }
  } catch (e) {
    log(`⚠️  Price refresh failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────
//  Order helpers (live API calls, gated by DRY_RUN inside trader
//  usage — trader itself is real & authenticated; DRY_RUN controls
//  whether we actually fire orders or just simulate fills locally)
// ─────────────────────────────────────────
async function placeLimitBuy(price, shares) {
  if (!DRY_RUN && trader) {
    return await trader.limitBuy(drawTokenId, shares, price);
  }
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}

async function placeLimitSell(price, shares) {
  if (!DRY_RUN && trader) {
    return await trader.limitSell(drawTokenId, shares, price);
  }
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}

async function cancelOrder(orderId) {
  if (!orderId) return;
  if (!DRY_RUN && trader && typeof trader.cancelOrder === 'function') {
    try { await trader.cancelOrder(orderId); } catch (e) { log(`⚠️  cancelOrder: ${e.message}`); }
  }
}


function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ═══════════════════════════════════════════════════════════════
//  STRATEGY CORE — Two-Layer Compounding
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────
//  LAYER 2: Conviction buy
//  Deploy the block's $60 at the current live price, no TP.
//  Called ONCE on first block activation only.
// ─────────────────────────────────────────
async function placeConvictionBuy(block) {
  const price = currentNoPrice;
  if (!price || price <= 0 || block.convCapital <= 0) return;

  const shares = round2(block.convCapital / price);
  if (shares <= 0) return;

  const cost = round2(shares * price);
  const order = await placeLimitBuy(price, shares);

  block.convShares   = round2(block.convShares + shares);
  block.convCost     = round2(block.convCost + cost);
  block.convBuyPrice = price;
  block.convCapital  = 0; // fully deployed

  const valueAtWin = round2(shares * 1.00);
  const multiple   = round2(valueAtWin / cost);
  log(`🎯 CONVICTION Block#${block.index + 1} [${block.lo.toFixed(2)}-${block.hi.toFixed(2)}] BUY ${shares}sh @ ${price.toFixed(3)} | cost=$${cost.toFixed(2)} | value@win=$${valueAtWin.toFixed(2)} (${multiple}x) | orderId=${order.id || order.orderId || 'dry'}`);
  trades.push({ time: new Date().toISOString().slice(11, 19), block: block.index, side: 'CONVICTION_BUY', price, shares, cost });
  if (trades.length > 200) trades.shift();
}

// ─────────────────────────────────────────
//  LAYER 1: Grid helpers
// ─────────────────────────────────────────

// Cancel all resting grid buy orders (does not touch TP positions or conviction shares)
async function deactivateBlock(block) {
  for (const rung of block.rungs) {
    if (rung.restingOrderId) {
      await cancelOrder(rung.restingOrderId);
      rung.restingOrderId = null;
      rung.restingPrice   = null;
      rung.restingSize    = null;
    }
  }
  block.active = false;
}

// Arm a rung's resting limit buy, sized off current gridCapital
async function armRung(block, rung) {
  const unit = round2(block.gridCapital / RUNGS_PER_BLOCK);
  if (unit < 1) return;
  const price = round2(block.pivot - RUNG_OFFSET * rung.offsetIdx);
  if (price <= 0.01) return;
  const shares = round2(unit / price);
  if (shares <= 0) return;

  const order = await placeLimitBuy(price, shares);
  rung.restingOrderId = order.id || order.orderId || order.orderID || null;
  rung.restingPrice   = price;
  rung.restingSize    = shares;
  log(`🪣 Block#${block.index + 1} [${block.lo.toFixed(2)}-${block.hi.toFixed(2)}] rung${rung.offsetIdx} GRID BUY ${shares}sh @ ${price.toFixed(3)} (unit=$${unit.toFixed(2)})`);
}

// Activate a block:
//   - First ever activation: fire conviction buy + arm grid rungs
//   - Revisit: reseed gridCapital=$140, re-arm grid rungs (NO new conviction buy)
async function activateBlock(block) {
  const wasDormant      = !block.active;
  const hasGridPosition = block.rungs.some(r => r.position);

  // Grid reseed on revisit (gridCapital was cascaded out last time)
  if (wasDormant && block.gridCapital <= 0 && !hasGridPosition) {
    block.gridCapital = GRID_BLOCK;
    log(`🔄 Block#${block.index + 1} grid reseeded $${GRID_BLOCK}`);
  }

  // Conviction — FIRST activation only, once per block per session
  if (!block.everActivated && block.convCapital > 0) {
    await placeConvictionBuy(block);
  }

  block.active        = true;
  block.everActivated = true;

  // Arm all empty grid rungs
  for (const rung of block.rungs) {
    if (!rung.position && !rung.restingOrderId) {
      await armRung(block, rung);
    }
  }
}

// Simulate fill: limit buy fires when price drops to/through rung price
async function checkRungFill(block, rung, price) {
  if (!rung.restingOrderId || rung.position) return;
  if (price <= rung.restingPrice) {
    const entryPrice = rung.restingPrice;
    const shares     = rung.restingSize;
    const cost       = round2(entryPrice * shares);

    block.gridCapital   = round2(block.gridCapital - cost);
    rung.restingOrderId = null;
    rung.restingPrice   = null;
    rung.restingSize    = null;

    const tpPrice = round2(entryPrice + TP_OFFSET);
    const tpOrder = await placeLimitSell(tpPrice, shares);

    rung.position = {
      shares,
      entryPrice,
      cost,
      tpOrderId: tpOrder.id || tpOrder.orderId || tpOrder.orderID || null,
      tpPrice,
      filledAt: Date.now(),
    };

    log(`✅ GRID FILL Block#${block.index + 1} rung${rung.offsetIdx} BUY ${shares}sh @ ${entryPrice.toFixed(3)} | cost=$${cost.toFixed(2)} | TP @ ${tpPrice.toFixed(3)}`);
    trades.push({ time: new Date().toISOString().slice(11, 19), block: block.index, side: 'GRID_BUY', price: entryPrice, shares, cost });
    if (trades.length > 200) trades.shift();
  }
}

// Check if price reaches a grid TP; realize profit, return to grid pool, re-arm
async function checkRungTakeProfit(block, rung, price) {
  if (!rung.position) return;
  if (price >= rung.position.tpPrice) {
    const { shares, entryPrice, cost, tpPrice } = rung.position;
    const proceeds = round2(tpPrice * shares);
    const profit   = round2(proceeds - cost);
    const pct      = round2(profit / cost * 100);

    block.gridCapital     = round2(block.gridCapital + proceeds);
    block.realizedGridPnl = round2(block.realizedGridPnl + profit);

    log(`💰 GRID TP Block#${block.index + 1} rung${rung.offsetIdx} SELL ${shares}sh @ ${tpPrice.toFixed(3)} | entry=${entryPrice.toFixed(3)} | profit=$${profit.toFixed(2)} (+${pct}%) | grid pool $${block.gridCapital.toFixed(2)}`);
    trades.push({ time: new Date().toISOString().slice(11, 19), block: block.index, side: 'GRID_TP', price: tpPrice, shares, profit });
    if (trades.length > 200) trades.shift();

    rung.position = null;
    if (block.active) await armRung(block, rung);
  }
}

// ─────────────────────────────────────────
//  Block value helpers
// ─────────────────────────────────────────
function blockMarkValue(block, price) {
  const gridPosValue = block.rungs.reduce((s, r) => r.position ? s + r.position.shares * price : s, 0);
  const convValue    = block.convShares * price;
  return round2(block.gridCapital + gridPosValue + convValue);
}

function blockOpenGridShares(block) {
  return block.rungs.reduce((s, r) => s + (r.position ? r.position.shares : 0), 0);
}

// ─────────────────────────────────────────
//  CASCADE: grid capital only moves upward.
//  Conviction shares stay put forever.
//  First cascade: full gridCapital moves up.
//  Repeat cascade: only profit above $140 base moves up.
// ─────────────────────────────────────────
async function cascadeUp(fromBlock, toBlock) {
  if (fromBlock.gridCapital <= 0) {
    await deactivateBlock(fromBlock);
    return;
  }

  const isFirst = !fromBlock.cascadedBefore;
  let moving;

  if (isFirst) {
    moving = fromBlock.gridCapital;
    fromBlock.gridCapital = 0;
  } else {
    const profit = round2(fromBlock.gridCapital - GRID_BLOCK);
    moving = profit > 0 ? profit : 0;
    fromBlock.gridCapital = round2(fromBlock.gridCapital - moving); // base stays
  }

  await deactivateBlock(fromBlock);
  fromBlock.cascadedBefore = true;
  toBlock.gridCapital = round2(toBlock.gridCapital + moving);
  log(`⬆️  CASCADE Block#${fromBlock.index + 1} -> Block#${toBlock.index + 1} | $${moving.toFixed(2)} grid (${isFirst ? 'first: full pool' : 'repeat: profit only'}) | Block#${toBlock.index + 1} grid pool $${toBlock.gridCapital.toFixed(2)}`);
}

// ─────────────────────────────────────────
//  LAYER 3: Endgame all-in
//  Cancel all grid orders, pool all idle gridCapital, buy shares at live price.
//  Only fires if price >= ALLIN_PRICE_THRESHOLD (we're winning).
// ─────────────────────────────────────────
async function runAllIn() {
  if (allInTriggered) return;
  allInTriggered = true;

  const price = currentNoPrice;
  log(`🚀 ALL-IN triggered @ ${price.toFixed(2)} — pooling all idle grid capital across all blocks`);

  let totalIdle = 0;
  for (const block of blocks) {
    for (const rung of block.rungs) {
      if (rung.restingOrderId) {
        await cancelOrder(rung.restingOrderId);
        rung.restingOrderId = null;
        rung.restingPrice   = null;
        rung.restingSize    = null;
      }
    }
    totalIdle           = round2(totalIdle + block.gridCapital);
    block.gridCapital   = 0;
    block.active        = false;
  }

  if (totalIdle > 0 && price > 0) {
    const shares     = round2(totalIdle / price);
    const order      = await placeLimitBuy(price, shares);
    const valueAtWin = round2(shares * 1.00);
    allInPosition = { shares, buyPrice: price, cost: totalIdle, orderId: order.id || order.orderId || null };
    log(`🎯 ALL-IN BUY ${shares}sh @ ${price.toFixed(2)} | cost=$${totalIdle.toFixed(2)} | value@win=$${valueAtWin.toFixed(2)} | orderId=${allInPosition.orderId || 'dry'}`);
    trades.push({ time: new Date().toISOString().slice(11, 19), block: -1, side: 'ALLIN_BUY', price, shares, cost: totalIdle });
    if (trades.length > 200) trades.shift();
  } else {
    log(`⚠️  ALL-IN: no idle grid capital to deploy`);
  }
}

// ─────────────────────────────────────────
//  Main per-tick state machine
// ─────────────────────────────────────────
async function processBlocks(price) {
  if (price === null) return;
  const targetIdx = blockIndexForPrice(price);

  // Check fills and TPs for every block with resting orders or positions
  for (const block of blocks) {
    for (const rung of block.rungs) {
      await checkRungFill(block, rung, price);
      await checkRungTakeProfit(block, rung, price);
    }
  }

  // Activate / cascade based on which block price is in
  for (const block of blocks) {
    const isTarget = block.index === targetIdx;

    if (isTarget && !block.active) {
      // Cascade all lower blocks that were genuinely activated or hold leftover grid cash
      for (const lower of blocks) {
        if (lower.index < block.index && (lower.active || (lower.everActivated && lower.gridCapital > 0))) {
          await cascadeUp(lower, block);
        }
      }
      await activateBlock(block);

    } else if (isTarget && block.active) {
      // Re-arm any empty rungs (e.g. after new grid capital cascaded in)
      for (const rung of block.rungs) {
        if (!rung.position && !rung.restingOrderId) {
          await armRung(block, rung);
        }
      }

    } else if (!isTarget && block.active && block.index < targetIdx) {
      // Price jumped above this block — cascade it up
      await cascadeUp(block, blocks[targetIdx]);

    }
    // Price below an active block: leave resting orders/positions in place
  }
}

// ─────────────────────────────────────────
//  Endgame: close all positions at live price
// ─────────────────────────────────────────
async function runEndgame() {
  if (endgameTriggered) return;
  endgameTriggered = true;

  // Use actual live price — losing side closes near 0, winning side near 1
  const exitPrice = currentNoPrice !== null ? currentNoPrice : 0.99;
  log(`🚨 ENDGAME @ ${exitPrice.toFixed(2)} — closing all grid TPs, conviction holds, and all-in`);

  for (const block of blocks) {
    // Cancel resting grid buy orders
    for (const rung of block.rungs) {
      if (rung.restingOrderId) {
        await cancelOrder(rung.restingOrderId);
        rung.restingOrderId = null;
        rung.restingPrice   = null;
        rung.restingSize    = null;
      }
      // Close open grid TP positions
      if (rung.position) {
        const { shares, entryPrice, cost, tpOrderId } = rung.position;
        await cancelOrder(tpOrderId);
        const order    = await placeLimitSell(exitPrice, shares);
        const proceeds = round2(exitPrice * shares);
        const profit   = round2(proceeds - cost);
        block.gridCapital     = round2(block.gridCapital + proceeds);
        block.realizedGridPnl = round2(block.realizedGridPnl + profit);
        log(`🏁 GRID EXIT Block#${block.index + 1} rung${rung.offsetIdx} SELL ${shares}sh @ ${exitPrice.toFixed(2)} | profit=$${profit.toFixed(2)}`);
        trades.push({ time: new Date().toISOString().slice(11, 19), block: block.index, side: 'GRID_EXIT', price: exitPrice, shares, profit });
        rung.position = null;
      }
    }
    // Close conviction hold shares
    if (block.convShares > 0) {
      const order    = await placeLimitSell(exitPrice, block.convShares);
      const proceeds = round2(exitPrice * block.convShares);
      const profit   = round2(proceeds - block.convCost);
      log(`🏁 CONVICTION EXIT Block#${block.index + 1} SELL ${block.convShares}sh @ ${exitPrice.toFixed(2)} | cost=$${block.convCost.toFixed(2)} | profit=$${profit.toFixed(2)}`);
      trades.push({ time: new Date().toISOString().slice(11, 19), block: block.index, side: 'CONVICTION_EXIT', price: exitPrice, shares: block.convShares, profit });
      block.convShares = 0;
    }
    block.active = false;
  }

  // Close all-in position
  if (allInPosition && allInPosition.shares > 0) {
    const { shares, cost } = allInPosition;
    const order    = await placeLimitSell(exitPrice, shares);
    const proceeds = round2(exitPrice * shares);
    const profit   = round2(proceeds - cost);
    log(`🏁 ALL-IN EXIT SELL ${shares}sh @ ${exitPrice.toFixed(2)} | cost=$${cost.toFixed(2)} | profit=$${profit.toFixed(2)}`);
    trades.push({ time: new Date().toISOString().slice(11, 19), block: -1, side: 'ALLIN_EXIT', price: exitPrice, shares, profit });
    allInPosition = null;
  }

  if (trades.length > 200) trades.splice(0, trades.length - 200);
}

// ─────────────────────────────────────────
//  UI state (real-time mark-to-market)
// ─────────────────────────────────────────
function buildState() {
  const price = currentNoPrice;

  const blockStates = blocks.map(b => {
    const gridPosShares = blockOpenGridShares(b);
    const gridPosValue  = price !== null ? round2(gridPosShares * price) : 0;
    const convValue     = price !== null ? round2(b.convShares * price) : 0;
    const convValueWin  = round2(b.convShares * 1.00);
    const markValue     = round2(b.gridCapital + gridPosValue + convValue);

    return {
      index:        b.index,
      range:        `${b.lo.toFixed(2)}-${b.hi.toFixed(2)}`,
      pivot:        b.pivot,
      active:       b.active,
      everActivated: b.everActivated,
      cascadedBefore: b.cascadedBefore,
      // Grid layer
      cash:           b.gridCapital,
      realizedPnl:    b.realizedGridPnl,
      openShares:     gridPosShares,
      openPosValue:   gridPosValue,
      // Conviction layer
      convShares:     b.convShares,
      convCost:       b.convCost,
      convBuyPrice:   b.convBuyPrice,
      convValue,
      convValueWin,
      // Total
      markValue,
      rungs: b.rungs.map(r => ({
        offsetIdx:    r.offsetIdx,
        restingPrice: r.restingPrice,
        restingSize:  r.restingSize,
        hasPosition:  !!r.position,
        entryPrice:   r.position?.entryPrice || null,
        shares:       r.position?.shares || null,
        tpPrice:      r.position?.tpPrice || null,
        unrealizedPnl: r.position && price !== null
          ? round2((price - r.position.entryPrice) * r.position.shares)
          : 0,
      })),
    };
  });

  // Aggregates
  const totalGridCash      = round2(blocks.reduce((s, b) => s + b.gridCapital, 0));
  const totalGridPnl       = round2(blocks.reduce((s, b) => s + b.realizedGridPnl, 0));
  const totalConvShares    = round2(blocks.reduce((s, b) => s + b.convShares, 0));
  const totalConvCost      = round2(blocks.reduce((s, b) => s + b.convCost, 0));
  const totalConvValue     = price !== null ? round2(totalConvShares * price) : 0;
  const totalConvValueWin  = round2(totalConvShares * 1.00);
  const allInValue         = allInPosition && price !== null ? round2(allInPosition.shares * price) : 0;
  const allInValueWin      = allInPosition ? round2(allInPosition.shares * 1.00) : 0;
  const totalMark          = round2(
    blocks.reduce((s, b) => s + (price !== null ? blockMarkValue(b, price) : b.gridCapital + b.convShares), 0) +
    (allInPosition && price !== null ? round2(allInPosition.shares * price) : 0)
  );

  return {
    dryRun:            DRY_RUN,
    eventSlug:         MATCH_EVENT_SLUG,
    eventTitle:        eventInfo.title,
    question:          drawMarket ? qOf(drawMarket) : null,
    tradeSide,
    noPrice:           price,
    // Capital summary
    totalCapital:      TOTAL_CAPITAL,
    totalGridCash,
    totalGridPnl,
    totalConvShares,
    totalConvCost,
    totalConvValue,
    totalConvValueWin,
    allInPosition,
    allInValue,
    allInValueWin,
    totalMarkValue:    totalMark,
    totalPnl:          round2(totalMark - TOTAL_CAPITAL),
    // Timing
    uptime:            Math.floor((Date.now() - startTime) / 1000),
    matchEndTime:      matchEndTime ? new Date(matchEndTime).toISOString() : null,
    secsToEnd:         matchEndTime ? Math.floor((matchEndTime - Date.now()) / 1000) : null,
    // Flags
    endgameTriggered,
    allInTriggered,
    // Per-block data + logs/trades
    blocks:            blockStates,
    logs:              logs.slice(-80),
    trades:            trades.slice(-60).reverse(),
  };
}

// ─────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────
async function mainLoop() {
  while (true) {
    try {
      const now = Date.now();

      if (drawTokenId && now - lastMarketFetch > MARKET_REFETCH_MS) {
        lastMarketFetch = now;
        await refreshMatchEndTime();
      }

      if (drawTokenId && now - lastPriceFetch > PRICE_REFRESH_MS) {
        await refreshPrice();
        lastPriceFetch = now;
        if (currentNoPrice !== null) {
          if (matchEndTime && !endgameTriggered) {
            const secsLeft = (matchEndTime - now) / 1000;
            if (secsLeft <= ENDGAME_SECS) {
              await runEndgame();
            } else if (secsLeft <= ALLIN_SECS && !allInTriggered && currentNoPrice >= ALLIN_PRICE_THRESHOLD) {
              await runAllIn();
            }
          }
          if (!endgameTriggered && !allInTriggered) {
            await processBlocks(currentNoPrice);
          }
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
//  Public API
// ─────────────────────────────────────────
async function searchMatch(urlOrSlug) {
  return await loadMatch(urlOrSlug);
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog   = slogFn;
  log(`🚀 Two-Layer Compounding Bot — $${TOTAL_CAPITAL} total`);
  log(`⚙️  Grid $${GRID_BLOCK}/block (${RUNGS_PER_BLOCK} rungs, TP +${TP_OFFSET}) | Conviction $${CONV_BLOCK}/block (hold to $1) | All-in last ${ALLIN_SECS}s if price >= ${ALLIN_PRICE_THRESHOLD}`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  await loadMatch(MATCH_EVENT_SLUG);
  lastMarketFetch = Date.now();
  await refreshPrice();
  lastPriceFetch = Date.now();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, searchMatch, searchMarkets, loadMarket };
