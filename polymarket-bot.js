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
 *  CAPITAL: $2000 demo split into 10 fixed price-blocks of $200:
 *           0.01-0.10, 0.10-0.20, ... 0.90-0.99
 *
 *  PER-BLOCK LOGIC (while live NO price sits inside a block's range):
 *   - pivot = block midpoint (e.g. 0.40-0.50 -> pivot 0.45)
 *   - unit  = block's current capital pool / 4
 *   - 4 resting limit BUY orders at pivot-0.01, -0.02, -0.03, -0.04,
 *     each sized at `unit` dollars worth of shares
 *   - each FILL gets its own limit SELL (take-profit) at entry+0.06
 *   - when a TP fills: profit returns to this block's pool, and the
 *     same rung re-arms a fresh buy order off the new (larger) pool
 *     -> continuous compounding ladder within the block
 *   - NO stop loss, ever
 *
 *  CASCADE (capital only ever moves UP, never down):
 *   - when price exits a block upward, ALL of that block's remaining
 *     cash + open-position value rolls into the landing block's pool
 *     (added on top of landing block's own base/existing pool)
 *   - if price jumps multiple blocks at once, it cascades through
 *     every skipped block into the final landing block
 *   - the vacated block goes dormant (its resting orders cancelled)
 *   - if price later returns to a dormant block, it reactivates
 *     fresh at base $200 (cascaded money does NOT come back down)
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
const PRICE_REFRESH_MS   = 3_000;
const MARKET_REFETCH_MS  = 300_000;
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
    capital: BLOCK_SIZE,     // cash available to this block right now
    realizedPnl: 0,          // cumulative profit ever booked in this block's lineage
    active: false,
    rungs: Array.from({ length: RUNGS_PER_BLOCK }, (_, i) => ({
      offsetIdx: i + 1,        // 1..4 -> pivot - 0.01*offsetIdx
      restingOrderId: null,
      restingPrice: null,
      restingSize: null,       // shares
      position: null,          // { shares, entryPrice, cost, tpOrderId, tpPrice }
    })),
  };
}

function resetAllBlocks() {
  blocks = BLOCK_DEFS.map(freshBlock);
}
resetAllBlocks();

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

// Return the NO token_id from a Gamma market, or null
function noTokenIdFromMarket(m) {
  const tokens = parseMarketTokens(m);
  const noTok = tokens.find(t => (t.outcome || '').toLowerCase() === 'no');
  return noTok?.token_id || null;
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
    eventInfo = { title: event.title || event.slug, slug };
    matchEndTime = event.endDate ? new Date(event.endDate).getTime() : null;
    endgameTriggered = false;

    resetAllBlocks();
    currentNoPrice = null;

    log(`✅ Match loaded: ${eventInfo.title}`);
    log(`🎯 Draw market: "${qOf(draw)}" | NO token: ${tid}`);
    if (matchEndTime) log(`⏰ Match ends: ${new Date(matchEndTime).toISOString()}`);
    else log(`⚠️  No end time on event — endgame auto-exit disabled`);

    return { ok: true, title: eventInfo.title, slug };
  } catch (e) {
    log(`❌ loadMatch error: ${e.message}`);
    return { ok: false, error: e.message };
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

// Activate a block: arm all rungs that don't already have a resting order or open position.
// If the block was dormant and fully emptied (no cash, no open positions anywhere in it),
// it reactivates fresh at base $200 — cascaded-away money never comes back down.
async function activateBlock(block) {
  const wasDormant = !block.active;
  const hasAnyPosition = block.rungs.some(r => r.position);
  if (wasDormant && block.capital <= 0 && !hasAnyPosition) {
    block.capital = BLOCK_SIZE;
    log(`🔄 Block#${block.index} [${block.lo.toFixed(2)}-${block.hi.toFixed(2)}] reactivated fresh at base $${BLOCK_SIZE.toFixed(2)}`);
  }
  block.active = true;
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

// Cascade: move ALL of a block's cash + open position VALUE up into target block.
// Open positions themselves keep living (their TP orders stay resting) — only the
// block's cash pool is what transfers; mark-to-market value is for display, but the
// actual transferable capital is realized cash (positions remain attached to their
// own rungs and keep ticking toward their own TP independently of which block "owns"
// the cash). This matches "no stop loss" — we never force-liquidate to cascade.
async function cascadeUp(fromBlock, toBlock) {
  if (fromBlock.capital <= 0) {
    await deactivateBlock(fromBlock);
    return;
  }
  const moving = fromBlock.capital;
  await deactivateBlock(fromBlock);
  fromBlock.capital = 0;
  toBlock.capital = round2(toBlock.capital + moving);
  log(`⬆️  CASCADE Block#${fromBlock.index} -> Block#${toBlock.index} | moved $${moving.toFixed(2)} | Block#${toBlock.index} pool now $${toBlock.capital.toFixed(2)}`);
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
      // Cascade money up from every lower block that's currently active/holding cash
      for (const lower of blocks) {
        if (lower.index < block.index && (lower.active || lower.capital > 0)) {
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
  log(`🚨 ENDGAME — cancelling all resting orders, exiting all positions @ ${ENDGAME_EXIT_PRICE}`);
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
        const order = await placeLimitSell(ENDGAME_EXIT_PRICE, shares);
        const proceeds = round2(ENDGAME_EXIT_PRICE * shares);
        const profit = round2(proceeds - cost);
        block.capital = round2(block.capital + proceeds);
        block.realizedPnl = round2(block.realizedPnl + profit);
        log(`🏁 ENDGAME EXIT Block#${block.index} rung${rung.offsetIdx} SELL ${shares}sh @ ${ENDGAME_EXIT_PRICE} | entry=${entryPrice.toFixed(2)} | profit=$${profit.toFixed(2)} | orderId=${order.id || order.orderId || 'n/a'}`);
        trades.push({
          time: new Date().toISOString().slice(11, 19),
          block: block.index,
          side: 'SELL_ENDGAME',
          price: ENDGAME_EXIT_PRICE,
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

  const totalCash = round2(blocks.reduce((s, b) => s + b.capital, 0));
  const totalMark = round2(blocks.reduce((s, b) => s + (price !== null ? blockMarkValue(b, price) : b.capital), 0));
  const totalRealized = round2(blocks.reduce((s, b) => s + b.realizedPnl, 0));
  const totalUnrealized = round2(totalMark - totalCash - blocks.reduce((s, b) => s + blockOpenShares(b), 0) * 0 + (price !== null ? blocks.reduce((s, b) => s + b.rungs.reduce((s2, r) => r.position ? s2 + (price - r.position.entryPrice) * r.position.shares : s2, 0), 0) : 0));
  const totalOpenShares = blocks.reduce((s, b) => s + blockOpenShares(b), 0);

  return {
    dryRun: DRY_RUN,
    eventSlug: MATCH_EVENT_SLUG,
    eventTitle: eventInfo.title,
    noPrice: price,
    totalCapital: TOTAL_CAPITAL,
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
  log(`⚙️  $${TOTAL_CAPITAL} demo capital | ${NUM_BLOCKS} blocks x $${BLOCK_SIZE} | ${RUNGS_PER_BLOCK} rungs/block | TP +${TP_OFFSET}`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for data/order calls' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  await loadMatch(MATCH_EVENT_SLUG);
  lastMarketFetch = Date.now();
  await refreshPrice();
  lastPriceFetch = Date.now();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, searchMatch };
