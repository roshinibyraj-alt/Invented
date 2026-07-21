'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET GRID LADDER BOT — BTC/ETH 15m Up/Down
 * ═══════════════════════════════════════════════════════════════
 *
 *  Complete rewrite. Only trades 15-minute Up/Down windows. No cross-pair
 *  combos — instead, FOUR fully independent grid ladders, one per
 *  symbol+side: BTC-Up, BTC-Down, ETH-Up, ETH-Down. Each ladder trades only
 *  its own token and never interacts with the others.
 *
 *  GRID DESIGN (per ladder):
 *    - Fixed price levels every $0.05 across a range:
 *        Up ladders:   0.30 – 0.90
 *        Down ladders: 0.25 – 0.85
 *    - Each empty level rests a GTC BUY limit order at that exact price.
 *    - On fill, immediately rest a GTC SELL limit TP order at entry + $0.10.
 *    - On TP fill, the level goes empty again and re-arms its buy order —
 *      it can re-enter as many times as the window allows.
 *    - No stop-loss. Anything still open at window-close cancels its TP
 *      order and rides to actual resolution ($1 or $0/share).
 *
 *  WHY RESTING LIMIT ORDERS, NOT MARKET ORDERS: Polymarket makers pay zero
 *  fee; takers pay a real one. The grid's whole edge is a fixed $0.10 per
 *  round-trip, so capturing it fee-free on both legs matters a lot more
 *  here than it did for the old marketable-buy combo strategy.
 *
 *  RISK CONTROLS (my own additions, not explicitly specified):
 *    - MAX_OPEN_PER_LADDER caps concurrent held positions per ladder. A
 *      strong one-directional move can fill many levels that never recover
 *      to TP before the window ends — those losses are correlated, so this
 *      bounds the worst case instead of letting the grid buy every level
 *      on a straight-line crash.
 *    - ENTRY_CUTOFF_FRACTION stops opening NEW positions once realistic
 *      time-to-TP runs out — existing open positions still get watched for
 *      TP right up to the final resolution cutoff.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // stop everything this close to window end, go to resolution
const SLUG_OFFSET_FALLBACKS = [0, -900, 900];

const WINDOW_SECS = 900; // 15m only

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function nowSec() { return Date.now() / 1000; }

// ── Grid parameters ──
const SYMBOLS = ['BTC', 'ETH'];
const SIDES = ['Up', 'Down'];
const LADDER_KEYS = ['BTC_Up', 'BTC_Down', 'ETH_Up', 'ETH_Down'];
const LADDER_RANGES = {
  Up:   { min: Number(process.env.UP_RANGE_MIN   || 0.30), max: Number(process.env.UP_RANGE_MAX   || 0.90) },
  Down: { min: Number(process.env.DOWN_RANGE_MIN || 0.25), max: Number(process.env.DOWN_RANGE_MAX || 0.85) },
};
const GRID_STEP  = Number(process.env.GRID_STEP || 0.05);
const TP_OFFSET  = Number(process.env.TP_OFFSET || 0.10);
const POSITION_SIZE_SHARES = Number(process.env.POSITION_SIZE_SHARES || 10);
const MAX_OPEN_PER_LADDER  = Number(process.env.MAX_OPEN_PER_LADDER || 4);
const ENTRY_CUTOFF_FRACTION = Number(process.env.ENTRY_CUTOFF_FRACTION || 0.85); // stop new entries after this fraction of the window

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let bankroll = TOTAL_CAPITAL;
let realizedPnl = 0, wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];

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

// CLOB order rejections often carry the real reason in e.response.data / e.data
// rather than e.message (which is frequently just "Request failed with status
// code 400"). Pull whatever's actually there.
function describeOrderError(e) {
  const parts = [e?.message || String(e)];
  const extra = e?.response?.data ?? e?.data ?? e?.body ?? null;
  if (extra) {
    try { parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (_) {}
  }
  return parts.join(' | ');
}
function isOrderFilled(order) {
  const status = (order?.status || '').toUpperCase();
  const matchStatus = (order?.match_status || order?.matchStatus || '').toLowerCase();
  const stateField = (order?.state || '').toLowerCase();
  return status === 'FILLED' || matchStatus === 'filled' || stateField === 'filled';
}

// ─────────────────────────────────────────
//  Slug / window math (15m only)
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) { return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS; }
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
  for (const offset of SLUG_OFFSET_FALLBACKS) {
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
//  Grid level / ladder state
// ─────────────────────────────────────────
function freshLevel(price) {
  return { price, state: 'IDLE', buyOrderId: null, tpOrderId: null, position: null };
  // state: 'IDLE' (no orders) | 'WAITING_BUY' (resting buy order) | 'HOLDING' (filled, TP resting)
}
function generateLevels(min, max, step) {
  const levels = [];
  let p = round2(min);
  while (p <= max + 1e-9) {
    levels.push(freshLevel(round2(p)));
    p = round2(p + step);
  }
  return levels;
}
function freshLadder(symbol, side) {
  const range = LADDER_RANGES[side];
  return { symbol, side, tokenId: null, levels: generateLevels(range.min, range.max, GRID_STEP) };
}
function freshMarketSlot() {
  return { slug: null, conditionId: null, upTokenId: null, downTokenId: null, upAsk: null, upBid: null, downAsk: null, downBid: null };
}
function freshState() {
  return {
    windowStart: null, windowEnd: null, tradable: false, resolvedThisWindow: true,
    markets: { BTC: freshMarketSlot(), ETH: freshMarketSlot() },
    ladders: {
      BTC_Up: freshLadder('BTC', 'Up'), BTC_Down: freshLadder('BTC', 'Down'),
      ETH_Up: freshLadder('ETH', 'Up'), ETH_Down: freshLadder('ETH', 'Down'),
    },
  };
}
let state = freshState();

function ladderPrices(ladderKey) {
  const ladder = state.ladders[ladderKey];
  const m = state.markets[ladder.symbol];
  const ask = ladder.side === 'Up' ? m.upAsk : m.downAsk;
  const bid = ladder.side === 'Up' ? m.upBid : m.downBid;
  return { ask, bid };
}

// ─────────────────────────────────────────
//  Market discovery
// ─────────────────────────────────────────
async function loadWindow() {
  const ws = currentWindowStart();
  if (state.windowStart === ws && state.markets.BTC.upTokenId) return;

  const [foundBtc, foundEth] = await Promise.all([fetchEventForWindow('BTC', ws), fetchEventForWindow('ETH', ws)]);
  if (!foundBtc || !foundEth) { state.tradable = false; return; }
  if (foundBtc.windowStart !== foundEth.windowStart) { state.tradable = false; return; }

  function slotFrom(found) {
    const market = found.event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || found.event.markets[0];
    const upId = tokenIdForSide(market, 'up');
    const downId = tokenIdForSide(market, 'down');
    if (!upId || !downId) return null;
    const slot = freshMarketSlot();
    slot.slug = found.slug;
    slot.conditionId = market.conditionId || null;
    slot.upTokenId = upId;
    slot.downTokenId = downId;
    return slot;
  }
  const btcSlot = slotFrom(foundBtc);
  const ethSlot = slotFrom(foundEth);
  if (!btcSlot || !ethSlot) { log('⚠️  window loaded but Up/Down token ids missing'); state.tradable = false; return; }

  const fresh = freshState();
  fresh.windowStart = foundBtc.windowStart;
  fresh.windowEnd = foundBtc.windowStart + WINDOW_SECS;
  fresh.markets.BTC = btcSlot;
  fresh.markets.ETH = ethSlot;
  fresh.tradable = true;
  fresh.resolvedThisWindow = false;
  fresh.ladders.BTC_Up.tokenId = btcSlot.upTokenId;
  fresh.ladders.BTC_Down.tokenId = btcSlot.downTokenId;
  fresh.ladders.ETH_Up.tokenId = ethSlot.upTokenId;
  fresh.ladders.ETH_Down.tokenId = ethSlot.downTokenId;
  Object.assign(state, fresh);
  log(`🔭 window loaded: BTC=${btcSlot.slug} ETH=${ethSlot.slug} | ends ${new Date(fresh.windowEnd * 1000).toISOString().slice(11, 19)}Z | entry cutoff @ ${Math.round(WINDOW_SECS * ENTRY_CUTOFF_FRACTION)}s`);
}

// ─────────────────────────────────────────
//  Price feed
// ─────────────────────────────────────────
async function refreshPrices() {
  if (!state.tradable) return;
  const requests = [];
  for (const symbol of SYMBOLS) {
    const m = state.markets[symbol];
    if (!m.upTokenId || !m.downTokenId) continue;
    requests.push({ token_id: m.upTokenId, side: 'BUY' }, { token_id: m.upTokenId, side: 'SELL' });
    requests.push({ token_id: m.downTokenId, side: 'BUY' }, { token_id: m.downTokenId, side: 'SELL' });
  }
  if (!requests.length) return;

  function apply(tid, side, price) {
    if (!Number.isFinite(price)) return;
    for (const symbol of SYMBOLS) {
      const m = state.markets[symbol];
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
    for (const symbol of SYMBOLS) {
      const m = state.markets[symbol];
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
//  Equity / trade bookkeeping
// ─────────────────────────────────────────
function markValue() {
  let held = 0;
  for (const ladderKey of LADDER_KEYS) {
    const { bid } = ladderPrices(ladderKey);
    for (const level of state.ladders[ladderKey].levels) {
      if (level.state === 'HOLDING') held += level.position.shares * (bid ?? level.position.entryPrice);
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
//  Grid order management — place/cancel resting BUY orders per the cap
// ─────────────────────────────────────────
async function placeLevelBuy(ladderKey, level) {
  const ladder = state.ladders[ladderKey];
  if (!DRY_RUN && trader) {
    try {
      const order = await trader.placeGtcOrder(ladder.tokenId, 'BUY', level.price, POSITION_SIZE_SHARES);
      level.buyOrderId = order.id;
      level.state = 'WAITING_BUY';
    } catch (e) {
      log(`⚠️  [${ladderKey}] failed to place grid buy @ ${level.price.toFixed(2)}: ${describeOrderError(e)}`);
    }
  } else {
    level.state = 'WAITING_BUY'; // demo — fill simulated against the live ask in checkLadderFills
  }
}
async function cancelLevelBuy(ladderKey, level) {
  if (!DRY_RUN && trader && level.buyOrderId) {
    try { await trader.cancelOrder(level.buyOrderId); } catch (e) { log(`⚠️  [${ladderKey}] failed to cancel grid buy @ ${level.price.toFixed(2)}: ${describeOrderError(e)}`); }
  }
  level.buyOrderId = null;
  level.state = 'IDLE';
}

async function maintainLadder(ladderKey) {
  const ladder = state.ladders[ladderKey];
  if (!ladder.tokenId) return;
  const elapsed = nowSec() - state.windowStart;
  const withinEntryCutoff = elapsed < WINDOW_SECS * ENTRY_CUTOFF_FRACTION;

  if (!withinEntryCutoff || !tradingEnabled) {
    for (const level of ladder.levels) {
      if (level.state === 'WAITING_BUY') await cancelLevelBuy(ladderKey, level);
    }
    return;
  }

  // Cap TOTAL exposure — resting (WAITING_BUY) + filled (HOLDING) combined —
  // not just filled positions. Capping only HOLDING doesn't actually bound
  // worst-case risk: if all levels were left resting simultaneously, a single
  // violent price move could fill many of them at once before the cap ever
  // gets a chance to react. Bounding the resting-order count itself is what
  // actually prevents that.
  const holdingCount = ladder.levels.filter(l => l.state === 'HOLDING').length;
  const waitingCount = ladder.levels.filter(l => l.state === 'WAITING_BUY').length;
  const capacityRemaining = MAX_OPEN_PER_LADDER - (holdingCount + waitingCount);
  if (capacityRemaining <= 0) return;

  const { ask } = ladderPrices(ladderKey);
  const idleLevels = ladder.levels.filter(l => l.state === 'IDLE');
  // Prioritize levels nearest the current price — most actionable, and keeps
  // the bounded resting-order set concentrated where price actually is.
  idleLevels.sort((a, b) => Math.abs(a.price - (ask ?? a.price)) - Math.abs(b.price - (ask ?? b.price)));

  for (let i = 0; i < Math.min(capacityRemaining, idleLevels.length); i++) {
    await placeLevelBuy(ladderKey, idleLevels[i]);
  }
}

// ─────────────────────────────────────────
//  Fill detection — buy fills → open position + rest TP; TP fills → close
// ─────────────────────────────────────────
async function checkLadderFills(ladderKey) {
  const ladder = state.ladders[ladderKey];
  const { ask, bid } = ladderPrices(ladderKey);

  for (const level of ladder.levels) {
    if (level.state === 'WAITING_BUY') {
      let filled = false;
      if (!DRY_RUN && level.buyOrderId && trader) {
        try { filled = isOrderFilled(await trader.getOrder(level.buyOrderId)); } catch (_) {}
      } else if (DRY_RUN) {
        filled = ask != null && ask <= level.price;
      }
      if (!filled) continue;

      const entryPrice = level.price; // a limit fill lands at (or better than) the resting price
      const cost = round2(entryPrice * POSITION_SIZE_SHARES);
      if (cost > bankroll) {
        log(`⏭️  [${ladderKey}] grid buy @ ${level.price.toFixed(2)} would fill but insufficient bankroll — cancelling`);
        await cancelLevelBuy(ladderKey, level);
        continue;
      }
      bankroll = round2(bankroll - cost);
      level.position = { shares: POSITION_SIZE_SHARES, entryPrice, cost };
      level.state = 'HOLDING';
      level.buyOrderId = null;
      registerTrade({ ladder: ladderKey, side: 'BUY', price: entryPrice, shares: POSITION_SIZE_SHARES, cost, fee: 0 });

      const tpPrice = round2(entryPrice + TP_OFFSET);
      if (!DRY_RUN && trader) {
        try {
          const gtc = await trader.placeGtcOrder(ladder.tokenId, 'SELL', tpPrice, POSITION_SIZE_SHARES);
          level.tpOrderId = gtc.id;
        } catch (e) {
          log(`⚠️  [${ladderKey}] grid buy filled @ ${entryPrice.toFixed(2)} but TP placement failed (position still held, resolves normally otherwise): ${describeOrderError(e)}`);
        }
      }
      log(`✅ [${ladderKey}] grid BUY filled @ ${entryPrice.toFixed(2)}, ${POSITION_SIZE_SHARES}sh — TP resting @ ${tpPrice.toFixed(2)}`);
      recordEquity();

    } else if (level.state === 'HOLDING') {
      const tpPrice = round2(level.position.entryPrice + TP_OFFSET);
      let tpFilled = false;
      if (!DRY_RUN && level.tpOrderId && trader) {
        try { tpFilled = isOrderFilled(await trader.getOrder(level.tpOrderId)); } catch (_) {}
      } else if (DRY_RUN) {
        tpFilled = bid != null && bid >= tpPrice;
      }
      if (!tpFilled) continue;

      const proceeds = round2(POSITION_SIZE_SHARES * tpPrice);
      const profit = round2(proceeds - level.position.cost);
      bankroll = round2(bankroll + proceeds);
      realizedPnl = round2(realizedPnl + profit);
      wins++;
      registerTrade({ ladder: ladderKey, side: 'SELL', reason: 'TP', price: tpPrice, shares: POSITION_SIZE_SHARES, profit });
      log(`🎯 [${ladderKey}] TP FILLED @ ${tpPrice.toFixed(2)} (entry ${level.position.entryPrice.toFixed(2)}) | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);
      level.state = 'IDLE';
      level.position = null;
      level.tpOrderId = null;
      recordEquity();
      // level goes IDLE — maintainLadder re-arms its buy order on the next tick, allowing re-entry
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
  if (state.resolvedThisWindow) return;
  state.resolvedThisWindow = true;

  for (const symbol of SYMBOLS) {
    const m = state.markets[symbol];
    const anyHolding = SIDES.some(side => state.ladders[`${symbol}_${side}`].levels.some(l => l.state === 'HOLDING'));
    const winner = anyHolding ? await determineWinningSide(m.slug, m.conditionId, m.upBid, m.downBid) : null;

    for (const side of SIDES) {
      const ladderKey = `${symbol}_${side}`;
      const ladder = state.ladders[ladderKey];
      for (const level of ladder.levels) {
        if (level.state === 'WAITING_BUY' && !DRY_RUN && trader && level.buyOrderId) {
          try { await trader.cancelOrder(level.buyOrderId); } catch (_) {}
        }
        if (level.state === 'HOLDING') {
          if (!DRY_RUN && trader && level.tpOrderId) {
            try { await trader.cancelOrder(level.tpOrderId); } catch (_) {}
          }
          const won = winner === side;
          const proceeds = won ? round2(level.position.shares * 1) : 0;
          const profit = round2(proceeds - level.position.cost);
          bankroll = round2(bankroll + proceeds);
          realizedPnl = round2(realizedPnl + profit);
          if (won) wins++; else losses++;
          registerTrade({ ladder: ladderKey, side: 'SELL', reason: 'RESOLUTION', price: won ? 1 : 0, shares: level.position.shares, profit });
          log(`${won ? '💰' : '💥'} [${ladderKey}] level ${level.price.toFixed(2)} RESOLUTION entry=${level.position.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'} | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);
        }
        level.state = 'IDLE'; level.position = null; level.buyOrderId = null; level.tpOrderId = null;
      }
    }
  }
  recordEquity();
}

// ─────────────────────────────────────────
//  Main tick
// ─────────────────────────────────────────
async function tick() {
  const ws = currentWindowStart();
  if (state.windowStart === null || ws !== state.windowStart) {
    if (state.windowStart !== null && !state.resolvedThisWindow) await resolveWindow();
    await loadWindow();
  }
  if (!state.tradable) return;

  const elapsed = nowSec() - state.windowStart;
  if (elapsed >= WINDOW_SECS - EARLY_CUTOFF_SECS && !state.resolvedThisWindow) {
    await resolveWindow();
  }
  if (state.resolvedThisWindow) return;

  for (const ladderKey of LADDER_KEYS) {
    await checkLadderFills(ladderKey);
    await maintainLadder(ladderKey);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildLadderState(ladderKey) {
  const ladder = state.ladders[ladderKey];
  const { ask, bid } = ladderPrices(ladderKey);
  const holdingCount = ladder.levels.filter(l => l.state === 'HOLDING').length;
  const waitingCount = ladder.levels.filter(l => l.state === 'WAITING_BUY').length;
  return {
    key: ladderKey, symbol: ladder.symbol, side: ladder.side,
    range: LADDER_RANGES[ladder.side], ask, bid,
    holdingCount, waitingCount, maxOpen: MAX_OPEN_PER_LADDER,
    levels: ladder.levels.map(l => ({
      price: l.price, state: l.state,
      tpPrice: l.position ? round2(l.position.entryPrice + TP_OFFSET) : round2(l.price + TP_OFFSET),
      position: l.position,
    })),
  };
}

function buildState() {
  const mv = markValue();
  let costBasis = 0, openCount = 0;
  for (const ladderKey of LADDER_KEYS) {
    for (const level of state.ladders[ladderKey].levels) {
      if (level.state === 'HOLDING') { costBasis += level.position.cost; openCount++; }
    }
  }
  costBasis = round2(costBasis);
  const held = round2(mv - bankroll);
  const unrealizedPnl = round2(held - costBasis);
  return {
    dryRun: DRY_RUN, tradingEnabled,
    tradable: state.tradable, windowEnd: state.windowEnd,
    secsToEnd: state.windowEnd ? Math.max(0, Math.floor(state.windowEnd - nowSec())) : null,
    entryCutoffSecs: Math.round(WINDOW_SECS * ENTRY_CUTOFF_FRACTION),
    secsToEntryCutoff: state.windowStart != null ? Math.max(0, Math.floor((state.windowStart + WINDOW_SECS * ENTRY_CUTOFF_FRACTION) - nowSec())) : null,
    ladders: LADDER_KEYS.map(buildLadderState),
    openPositionCount: openCount,
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    realizedPnl, unrealizedPnl, wins, losses,
    totalPnl: round2(mv - TOTAL_CAPITAL),
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      gridStep: GRID_STEP, tpOffset: TP_OFFSET, positionSizeShares: POSITION_SIZE_SHARES,
      maxOpenPerLadder: MAX_OPEN_PER_LADDER, entryCutoffFraction: ENTRY_CUTOFF_FRACTION,
      upRange: LADDER_RANGES.Up, downRange: LADDER_RANGES.Down,
    },
    equityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastPriceFetch = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPriceFetch >= POLY_PRICE_REFRESH_MS) {
        lastPriceFetch = now;
        await refreshPrices();
      }
      await tick();
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (open positions still monitored for TP; no new grid entries)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }
function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) log(DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real orders');
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Grid Ladder Bot — BTC/ETH 15m Up/Down, 4 independent ladders`);
  log(`⚙️  $${TOTAL_CAPITAL} capital (shared) | ${POSITION_SIZE_SHARES}sh/level | grid every $${GRID_STEP} | TP = entry + $${TP_OFFSET} | no SL — unfilled TP rides to resolution`);
  log(`⚙️  Up ladders: ${LADDER_RANGES.Up.min}-${LADDER_RANGES.Up.max} | Down ladders: ${LADDER_RANGES.Down.min}-${LADDER_RANGES.Down.max}`);
  log(`⚙️  Max ${MAX_OPEN_PER_LADDER} concurrent open positions per ladder | new entries stop after ${Math.round(ENTRY_CUTOFF_FRACTION * 100)}% of window elapses`);
  log(`⚙️  Execution: resting GTC limit orders both ways (maker, zero fee) — not market orders`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, pauseTrading, resumeTrading, setMode, getStatus, buildState };
