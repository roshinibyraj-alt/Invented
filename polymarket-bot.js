'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET DRAW-NO BLOCK-LADDER BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  MARKET: Single sub-market only — "Draw - Yes or No" moneyline
 *          for one FIFA match. We trade the NO side exclusively.
 *          Thesis: match does NOT end in a draw.
 *
 *  CAPITAL: $2000 total, hard-capped, tracked by a single shared
 *           RESERVE plus 10 price-blocks of up to $200 each:
 *           0.01-0.10, 0.10-0.20, ... 0.90-0.99
 *           Blocks start EMPTY. A block only ever receives cash by
 *           drawing it from the shared reserve (capped at $200/draw)
 *           or by a cascade transfer from another block. No code path
 *           ever creates capital out of nothing — reserve + sum(block
 *           cash) + sum(open position cost) == $2000 at all times.
 *           This means total realistic risk is always exactly $2000,
 *           never more, even across a choppy match that revisits the
 *           same blocks many times — late-match reactivations simply
 *           get a smaller draw (or $0) once the reserve runs dry.
 *
 *  PER-BLOCK LOGIC (while live NO price sits inside a block's range):
 *   - pivot = block midpoint (e.g. 0.40-0.50 -> pivot 0.45)
 *   - unit  = block's current capital pool / 4
 *   - 4 resting limit BUY orders at pivot-0.01, -0.02, -0.03, -0.04,
 *     each sized at `unit` dollars worth of shares
 *   - each FILL gets its own limit SELL (take-profit) at
 *     min(entry+0.06, 0.99) — capped so the top block's rungs never
 *     try to place an invalid >0.99 order
 *   - when a TP fills: profit returns to this block's pool, and the
 *     same rung re-arms a fresh buy order off the new (larger) pool
 *     -> continuous compounding ladder within the block
 *   - NO stop loss, ever
 *
 *  CASCADE (capital only ever moves UP, never down):
 *   - when price exits a block upward, that block's ENTIRE pool
 *     (100% — principal and profit alike) cascades into the landing
 *     block's pool, on top of whatever that block already holds —
 *     this is the compounding engine: capital concentrates behind
 *     wherever price currently is
 *   - if price jumps multiple blocks at once, it cascades through
 *     every skipped block into the final landing block
 *   - the vacated block goes dormant (its resting orders cancelled)
 *     and its cash is gone (capital=0); open positions keep living
 *     and ticking toward their own TP regardless of which block
 *     currently "owns" the cash
 *   - if price LATER returns to a now-empty block, it reactivates by
 *     drawing a fresh draw (up to $200) from the shared reserve —
 *     see CAPITAL above for why this can never exceed $2000 total
 *
 *  ENDGAME:
 *   - at T-10s before match end (incl. stoppage/extra time), cancel
 *     all resting orders and place sell limits at 0.99 for every
 *     open position, across all blocks
 *
 *  CAPITAL/PNL DISPLAY: always real-time mark-to-market. Every
 *  block's capital = cash + (open position shares * live NO price).
 *  Total bot capital = sum of all blocks, recalculated every tick.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Target match — settable via env, or via dashboard URL search ──
let MATCH_EVENT_SLUG = process.env.MATCH_SLUG || 'fifwc-ger-par-2026-06-29';

// ── Timing ──
const TICK_MS            = 500;
const PRICE_REFRESH_MS   = 500;
const MARKET_REFETCH_MS  = 60_000;
const ENDGAME_SECS       = 10;       // force-close window before match end

// ── Strategy constants ──
const TOTAL_CAPITAL   = 2000;
const NUM_BLOCKS      = 10;
const BLOCK_SIZE       = TOTAL_CAPITAL / NUM_BLOCKS; // $200
const RUNGS_PER_BLOCK  = 4;
const RUNG_OFFSET      = 0.01;   // pivot - 0.01, -0.02, -0.03, -0.04
const TP_OFFSET        = 0.06;   // entry + 0.06
const ENDGAME_EXIT_PRICE = 0.99;

// ── Env ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// ── Block range definitions ──
function buildBlockDefs() {
  const defs = [];
  for (let i = 0; i < NUM_BLOCKS; i++) {
    const lo = i === 0 ? 0.01 : i * 0.10;
    const hi = i === NUM_BLOCKS - 1 ? 0.99 : (i + 1) * 0.10;
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
  return NUM_BLOCKS - 1; // covers exactly 0.99 and the top edge
}

// ── State ──
let emitFn         = () => {};
let slog           = () => {};
let trader         = null;
let startTime      = Date.now();
let lastPriceFetch = 0;
let lastMarketFetch = 0;
let logs           = [];
let trades         = [];
let matchEndTime   = null;
let drawTokenId    = null; // NO token of "Draw - Yes or No"
let drawMarket     = null;
let currentNoPrice = null;
let endgameTriggered = false;
let eventInfo      = { title: null, slug: MATCH_EVENT_SLUG };
let tradeSide      = 'No'; // generic: which outcome label we're trading (No/Yes/Up/Down/etc.)

// Each block: { index, lo, hi, pivot, capital (cash, unallocated),
//   active (bool), rungs: [ {offsetIdx, restingOrderId, restingPrice,
//   restingSize, position:{shares, entryPrice, tpOrderId, tpPrice} } ] }
let blocks = [];

function freshBlock(def) {
  return {
    index: def.index,
    lo: def.lo,
    hi: def.hi,
    pivot: def.pivot,
    capital: 0,               // cash available to this block right now — starts empty,
                               // drawn from the shared reserve when first activated
    realizedPnl: 0,          // cumulative profit ever booked in this block's lineage
    active: false,
    everActivated: false,     // true once this block has actually been armed/traded —
                               // only blocks that were genuinely live can cascade their
                               // capital upward; a pristine, never-visited block must not
    rungs: Array.from({ length: RUNGS_PER_BLOCK }, (_, i) => ({
      offsetIdx: i + 1,        // 1..4 -> pivot - 0.01*offsetIdx
      restingOrderId: null,
      restingPrice: null,
      restingSize: null,       // shares
      position: null,          // { shares, entryPrice, cost, tpOrderId, tpPrice }
    })),
  };
}

// ── Shared capital reserve — the ONLY source of fresh cash for any block.
// Starts at TOTAL_CAPITAL; every block draw (first activation or a later
// reactivation after going to zero) subtracts from it, capped at BLOCK_SIZE
// per draw. Once it hits 0, no block can be seeded further — this is what
// guarantees the bot can never have more than $2000 genuinely at risk,
// no matter how many times price whips back and forth across blocks.
let reserveCapital = TOTAL_CAPITAL;

function resetAllBlocks() {
  blocks = BLOCK_DEFS.map(freshBlock);
  reserveCapital = TOTAL_CAPITAL;
}
resetAllBlocks();

// Wipe logs/trades/uptime so each newly-loaded market starts with a clean
// slate — makes it easy to pull logs for just one window's activity instead
// of it being mixed in with whatever the bot was doing on the previous market.
function resetSession() {
  logs = [];
  trades = [];
  startTime = Date.now();
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

// ─────────────────────────────────────────
//  Slug parsing — accepts full Polymarket URLs or bare slugs
//  e.g. https://polymarket.com/sports/world-cup/fifwc-ger-par-2026-06-29
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

// ─────────────────────────────────────────
//  Block engine
// ─────────────────────────────────────────

// Cancel all resting buy orders in a block (does not touch open TP positions)
async function deactivateBlock(block) {
  for (const rung of block.rungs) {
    if (rung.restingOrderId) {
      await cancelOrder(rung.restingOrderId);
      rung.restingOrderId = null;
      rung.restingPrice = null;
      rung.restingSize = null;
    }
  }
  block.active = false;
}

// Arm (or re-arm) a single rung's resting buy order, sized off current block capital
async function armRung(block, rung) {
  const unit = block.capital / RUNGS_PER_BLOCK;
  if (unit < 1) return; // nothing meaningful left to deploy
  const price = round2(block.pivot - RUNG_OFFSET * rung.offsetIdx);
  if (price <= 0) return;
  const shares = round2(unit / price);
  if (shares <= 0) return;

  const order = await placeLimitBuy(price, shares);
  rung.restingOrderId = order.id || order.orderId || order.orderID || null;
  rung.restingPrice = price;
  rung.restingSize = shares;
  log(`🪣 Block#${block.index} [${block.lo.toFixed(2)}-${block.hi.toFixed(2)}] rung${rung.offsetIdx} armed BUY ${shares}sh @ ${price.toFixed(2)} (unit=$${unit.toFixed(2)})`);
}

// Activate a block: draw fresh cash from the shared reserve if it's currently
// empty (true first activation, or reactivation after a prior full cascade),
// then arm all rungs that don't already have a resting order or open position.
// The reserve draw is capped at BLOCK_SIZE and at whatever's actually left in
// the shared reserve — this is the only thing standing between this bot and
// genuinely risking more than $2000 (see CAPITAL reserve note near the top).
async function activateBlock(block) {
  const hasAnyPosition = block.rungs.some(r => r.position);

  if (block.capital <= 0 && !hasAnyPosition) {
    const draw = round2(Math.min(BLOCK_SIZE, reserveCapital));
    if (draw > 0) {
      reserveCapital = round2(reserveCapital - draw);
      block.capital = draw;
      log(`🔄 Block#${block.index} [${block.lo.toFixed(2)}-${block.hi.toFixed(2)}] drew $${draw.toFixed(2)} from reserve (reserve now $${reserveCapital.toFixed(2)})`);
    } else {
      log(`⛔ Block#${block.index} [${block.lo.toFixed(2)}-${block.hi.toFixed(2)}] reserve exhausted — $0 available, staying unfunded`);
    }
  }
  block.active = true;
  block.everActivated = true;
  for (const rung of block.rungs) {
    if (!rung.position && !rung.restingOrderId) {
      await armRung(block, rung);
    }
  }
}

// Simulate/track a fill on a rung's resting buy order when price touches it
async function checkRungFill(block, rung, price) {
  if (!rung.restingOrderId || rung.position) return;
  // A limit buy fills when live price drops to/through the resting price
  if (price <= rung.restingPrice) {
    const entryPrice = rung.restingPrice;
    const shares = rung.restingSize;
    const cost = round2(entryPrice * shares);

    block.capital = round2(block.capital - cost);
    rung.restingOrderId = null;
    rung.restingPrice = null;
    rung.restingSize = null;

    const tpPrice = Math.min(round2(entryPrice + TP_OFFSET), 0.99);
    const tpOrder = await placeLimitSell(tpPrice, shares);

    rung.position = {
      shares,
      entryPrice,
      cost,
      tpOrderId: tpOrder.id || tpOrder.orderId || tpOrder.orderID || null,
      tpPrice,
      filledAt: Date.now(),
    };

    log(`✅ FILL Block#${block.index} rung${rung.offsetIdx} BUY ${shares}sh @ ${entryPrice.toFixed(2)} | cost=$${cost.toFixed(2)} | TP armed @ ${tpPrice.toFixed(2)}`);
    trades.push({
      time: new Date().toISOString().slice(11, 19),
      block: block.index,
      side: 'BUY',
      price: entryPrice,
      shares,
      cost,
    });
    if (trades.length > 200) trades.shift();
  }
}

// Check if a rung's TP sell has been reached -> realize profit, return to pool, re-arm
async function checkRungTakeProfit(block, rung, price) {
  if (!rung.position) return;
  if (price >= rung.position.tpPrice) {
    const { shares, entryPrice, cost, tpPrice } = rung.position;
    const proceeds = round2(tpPrice * shares);
    const profit = round2(proceeds - cost);

    block.capital = round2(block.capital + proceeds);
    block.realizedPnl = round2(block.realizedPnl + profit);

    log(`💰 TP HIT Block#${block.index} rung${rung.offsetIdx} SELL ${shares}sh @ ${tpPrice.toFixed(2)} | entry=${entryPrice.toFixed(2)} | profit=$${profit.toFixed(2)} | block pool now $${block.capital.toFixed(2)}`);
    trades.push({
      time: new Date().toISOString().slice(11, 19),
      block: block.index,
      side: 'SELL_TP',
      price: tpPrice,
      shares,
      profit,
    });
    if (trades.length > 200) trades.shift();

    rung.position = null;

    // Re-arm the same rung off the new (compounded) pool, only if block still active
    if (block.active) {
      await armRung(block, rung);
    }
  }
}

// Value of a block right now = cash + mark-to-market of open positions
function blockMarkValue(block, price) {
  const posValue = block.rungs.reduce((sum, r) => {
    if (!r.position) return sum;
    return sum + r.position.shares * price;
  }, 0);
  return round2(block.capital + posValue);
}

function blockOpenShares(block) {
  return block.rungs.reduce((sum, r) => sum + (r.position ? r.position.shares : 0), 0);
}

// Cascade: move a block's cash up into the target block. Open positions themselves
// keep living (their TP orders stay resting) -- only the block's cash pool transfers;
// positions remain attached to their own rungs and keep ticking toward their own TP
// independently of which block "owns" the cash. This matches "no stop loss" -- we
// never force-liquidate to cascade.
//
// Every cascade moves the block's ENTIRE current pool (100% — principal and any
// profit realized into it) up into the landing block. This is the compounding
// engine: capital concentrates fully behind wherever price currently sits. It's
// safe to do unconditionally (no more "first cascade only" special-casing) because
// capital is no longer minted on reactivation — if price later returns to this now-
// empty block, activateBlock() will draw a fresh, reserve-gated amount instead (see
// the shared reserve note near the top), so total system capital still never exceeds
// $2000 regardless of how many times a block cascades.
async function cascadeUp(fromBlock, toBlock) {
  if (fromBlock.capital <= 0) {
    await deactivateBlock(fromBlock);
    return;
  }

  const moving = fromBlock.capital;
  fromBlock.capital = 0;

  await deactivateBlock(fromBlock);
  toBlock.capital = round2(toBlock.capital + moving);
  log(`⬆️  CASCADE Block#${fromBlock.index} -> Block#${toBlock.index} | moved $${moving.toFixed(2)} (full pool) | Block#${toBlock.index} pool now $${toBlock.capital.toFixed(2)}`);
}
// Main per-tick block state machine
async function processBlocks(price) {
  if (price === null) return;
  const targetIdx = blockIndexForPrice(price);

  for (const block of blocks) {
    // Check fills/TPs for any block that has resting orders or open positions,
    // regardless of whether price is currently inside its range (orders rest
    // until filled or the block is deactivated by a cascade).
    for (const rung of block.rungs) {
      await checkRungFill(block, rung, price);
      await checkRungTakeProfit(block, rung, price);
    }
  }

  // Determine activation / cascade based on which block the price is in now
  for (const block of blocks) {
    const isTarget = block.index === targetIdx;

    if (isTarget && !block.active) {
      // Cascade money up from every lower block that's currently active, or was
      // genuinely traded before and still holds leftover cash. Blocks that were
      // never activated keep their default $200 reserved and do NOT cascade —
      // they only get pulled in once price actually visits them.
      for (const lower of blocks) {
        if (lower.index < block.index && (lower.active || (lower.everActivated && lower.capital > 0))) {
          await cascadeUp(lower, block);
        }
      }
      await activateBlock(block);
    } else if (isTarget && block.active) {
      // Make sure any empty rungs (no resting order, no position) are armed —
      // covers the case where capital just cascaded in
      for (const rung of block.rungs) {
        if (!rung.position && !rung.restingOrderId) {
          await armRung(block, rung);
        }
      }
    } else if (!isTarget && block.active && block.index < targetIdx) {
      // Price moved above this block without "landing" exactly here this tick
      // (shouldn't normally happen given 1c rungs, but handle multi-block jumps)
      await cascadeUp(block, blocks[targetIdx]);
    } else if (!isTarget && block.active && block.index > targetIdx) {
      // Price dropped back below an active block - just stop arming new rungs
      // here; existing resting orders/positions keep living. Per your rule,
      // capital only ever moves up, so we leave this block "active" (still
      // holding orders) until either it gets filled or price returns and we
      // keep compounding, or price moves further and this block's range is
      // passed going up again later (handled by the cascade-on-landing logic).
    }
  }
}

// ─────────────────────────────────────────
//  Endgame: force-exit everything at 0.99
// ─────────────────────────────────────────
async function runEndgame() {
  if (endgameTriggered) return;
  endgameTriggered = true;
  // Exit at the actual live price, not a fixed constant — if the traded side
  // lost, price will be sitting near 0.01 and the position must close near
  // worthless, not get marked at a fictitious 0.99 "win" price.
  const exitPrice = currentNoPrice !== null ? currentNoPrice : ENDGAME_EXIT_PRICE;
  log(`🚨 ENDGAME — cancelling all resting orders, exiting all positions @ ${exitPrice}`);
  for (const block of blocks) {
    for (const rung of block.rungs) {
      if (rung.restingOrderId) {
        await cancelOrder(rung.restingOrderId);
        rung.restingOrderId = null;
        rung.restingPrice = null;
        rung.restingSize = null;
      }
      if (rung.position) {
        const { shares, entryPrice, cost, tpOrderId } = rung.position;
        await cancelOrder(tpOrderId);
        const order = await placeLimitSell(exitPrice, shares);
        const proceeds = round2(exitPrice * shares);
        const profit = round2(proceeds - cost);
        block.capital = round2(block.capital + proceeds);
        block.realizedPnl = round2(block.realizedPnl + profit);
        log(`🏁 ENDGAME EXIT Block#${block.index} rung${rung.offsetIdx} SELL ${shares}sh @ ${exitPrice.toFixed(2)} | entry=${entryPrice.toFixed(2)} | profit=$${profit.toFixed(2)} | orderId=${order.id || order.orderId || 'n/a'}`);
        trades.push({
          time: new Date().toISOString().slice(11, 19),
          block: block.index,
          side: 'SELL_ENDGAME',
          price: exitPrice,
          shares,
          profit,
        });
        rung.position = null;
      }
    }
    block.active = false;
  }
  if (trades.length > 200) trades.splice(0, trades.length - 200);
}

// ─────────────────────────────────────────
//  UI state (real-time mark-to-market)
// ─────────────────────────────────────────
function buildState() {
  const price = currentNoPrice;
  const blockStates = blocks.map(b => {
    const markValue = price !== null ? blockMarkValue(b, price) : b.capital;
    const openShares = blockOpenShares(b);
    const unrealized = price !== null
      ? round2(b.rungs.reduce((sum, r) => r.position ? sum + (price - r.position.entryPrice) * r.position.shares : sum, 0))
      : 0;
    return {
      index: b.index,
      range: `${b.lo.toFixed(2)}-${b.hi.toFixed(2)}`,
      pivot: b.pivot,
      active: b.active,
      cash: b.capital,
      markValue,
      realizedPnl: b.realizedPnl,
      unrealized,
      openShares,
      rungs: b.rungs.map(r => ({
        offsetIdx: r.offsetIdx,
        restingPrice: r.restingPrice,
        restingSize: r.restingSize,
        hasPosition: !!r.position,
        entryPrice: r.position?.entryPrice || null,
        shares: r.position?.shares || null,
        tpPrice: r.position?.tpPrice || null,
        unrealizedPnl: r.position && price !== null ? round2((price - r.position.entryPrice) * r.position.shares) : 0,
      })),
    };
  });

  const totalCash = round2(blocks.reduce((s, b) => s + b.capital, 0) + reserveCapital);
  const totalMark = round2(blocks.reduce((s, b) => s + (price !== null ? blockMarkValue(b, price) : b.capital), 0) + reserveCapital);
  const totalRealized = round2(blocks.reduce((s, b) => s + b.realizedPnl, 0));
  const totalUnrealized = round2(totalMark - totalCash - blocks.reduce((s, b) => s + blockOpenShares(b), 0) * 0 + (price !== null ? blocks.reduce((s, b) => s + b.rungs.reduce((s2, r) => r.position ? s2 + (price - r.position.entryPrice) * r.position.shares : s2, 0), 0) : 0));
  const totalOpenShares = blocks.reduce((s, b) => s + blockOpenShares(b), 0);

  return {
    dryRun: DRY_RUN,
    eventSlug: MATCH_EVENT_SLUG,
    eventTitle: eventInfo.title,
    question: drawMarket ? qOf(drawMarket) : null,
    tradeSide,
    noPrice: price,
    totalCapital: TOTAL_CAPITAL,
    reserveCapital,
    totalCash,
    totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized,
    totalUnrealizedPnl: round2(totalUnrealized),
    totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalOpenShares,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    matchEndTime: matchEndTime ? new Date(matchEndTime).toISOString() : null,
    secsToEnd: matchEndTime ? Math.floor((matchEndTime - Date.now()) / 1000) : null,
    endgameTriggered,
    blocks: blockStates,
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

      if (drawTokenId && now - lastMarketFetch > MARKET_REFETCH_MS) {
        // Periodically reconfirm match hasn't closed / refresh end time
        lastMarketFetch = now;
        await refreshMatchEndTime();
      }

      if (drawTokenId && now - lastPriceFetch > PRICE_REFRESH_MS) {
        await refreshPrice();
        lastPriceFetch = now;
        if (currentNoPrice !== null) {
          // Endgame check
          if (matchEndTime && !endgameTriggered) {
            const secsLeft = (matchEndTime - now) / 1000;
            if (secsLeft <= ENDGAME_SECS) {
              await runEndgame();
            }
          }
          if (!endgameTriggered) {
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
//  Public: search/load a new match from dashboard
// ─────────────────────────────────────────
async function searchMatch(urlOrSlug) {
  return await loadMatch(urlOrSlug);
}

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Draw-NO Block-Ladder Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} shared reserve | up to $${BLOCK_SIZE}/block draw, ${NUM_BLOCKS} blocks | ${RUNGS_PER_BLOCK} rungs/block | TP +${TP_OFFSET} (capped @0.99) | full-pool cascade`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for data/order calls' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  await loadMatch(MATCH_EVENT_SLUG);
  lastMarketFetch = Date.now();
  await refreshPrice();
  lastPriceFetch = Date.now();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, searchMatch, searchMarkets, loadMarket };
