'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  SPORTS TRAILING-GRID LADDER ENGINE — Cricket, Tennis & Crypto, multi-match
 * ═══════════════════════════════════════════════════════════════
 *
 *  This engine replaces the old single-event cricket-bot.js and the
 *  crypto (BTC/ETH) ladder bot entirely. It runs the SAME trailing-grid
 *  ladder strategy — independently — against any number of cricket,
 *  tennis matches, or crypto Up/Down markets at once. Matches are added
 *  at startup (from env, for back-compat) or at any time from the
 *  dashboard by supplying the Polymarket market IDs (a token ID to
 *  trade, ideally with its condition ID for resolution detection).
 *
 *  STRATEGY (identical for every match, cricket, tennis, or crypto):
 *   - INITIAL ENTRY: on add, the near rung's first buy is priced AT the
 *     live ask (crosses the spread, fills immediately) instead of resting
 *     below the market. The far rung starts completely dormant — it is
 *     NOT armed and is skipped by the 2-min stale rearm — until that
 *     initial entry actually fills. Only then does far activate, anchored
 *     at (initial fill price - 0.05). This is a one-time bootstrap per
 *     match; every rung's behavior afterward is identical to before.
 *   - GRID: exactly 2 resting-buy rungs active at a time, $0.05 apart
 *     once both are live.
 *   - TP: each rung's TP = its own entry price + 0.10.
 *   - TRAILING RE-ENTRY: the instant a rung's TP fills, that SAME rung
 *     re-arms at old_entry + 0.05 (its own history) — it climbs 0.05
 *     per round trip. Stops re-arming once its next TP would exceed
 *     0.99 (maxed out).
 *   - 2-MINUTE STALE REARM (new): a rung that is NOT currently holding
 *     a position (idle, or resting-and-unfilled) gets re-anchored to
 *     the LIVE price every 2 minutes, instead of sitting parked at a
 *     price the market has moved away from. This does not touch rungs
 *     that are already holding a position / waiting on their TP — only
 *     idle/unfilled entry rungs get refreshed. This keeps the ladder
 *     "following" the live price instead of stalling.
 *   - SIZING / COMPOUNDING: each match starts with its own capital
 *     (default $200, configurable per match) and fully compounds — every
 *     arming pass, notional = current free bankroll / (number of rungs
 *     arming right now). The common case is one rung arming alone (a TP
 *     just freed it up), so it gets 100% of the freed cash, profit
 *     included. If both rungs happen to arm in the same pass, they split
 *     the free bankroll evenly between them so neither over-commits.
 *   - ORDER STYLE: resting limit orders only (maker) — eligible for
 *     Polymarket's Sports-category Maker Rebates Program (25% share,
 *     0.03 taker-fee-equivalent rate). Real payouts are pooled daily
 *     across all makers, so the per-fill number here is a best-effort
 *     ESTIMATE (see docs.polymarket.com/market-makers/maker-rebates).
 *   - RESOLUTION: each match polls Gamma (by event slug, or by
 *     condition ID) for market closure, and determines win/loss by
 *     checking the final settlement price of the SPECIFIC token this
 *     match trades (not by guessing outcome labels). Once closed, open
 *     positions settle at $1/$0 per share, resting orders are
 *     cancelled, and that match's ladder freezes.
 *
 *  ADDING A MATCH FROM THE DASHBOARD — two ways:
 *   1) Token ID (recommended): supply the exact CLOB token ID to trade.
 *      Optionally add the condition ID too, so the bot can auto-detect
 *      when the match resolves. This is the most reliable path since
 *      there's no guessing involved.
 *   2) Event slug + outcome label: supply the Gamma event slug (e.g.
 *      "crint-npl2-nam3-2026-07-21") and the outcome you want to back
 *      (e.g. "Nepal", "Djokovic"). The bot will pick the moneyline /
 *      match-winner market in that event and find the matching token.
 *      Less reliable than (1) — check the log line after adding to
 *      confirm it locked onto the right market/token before trusting
 *      it with real money.
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
const STATUS_REFRESH_MS  = 5000;        // how often to poll Gamma for match/market resolution
const ORDER_POLL_MS      = 2000;        // how often to poll resting LIVE order fills
const REARM_INTERVAL_MS  = Number(process.env.SPORTS_REARM_INTERVAL_MS || 2 * 60 * 1000); // fallback default (2 min) when a match doesn't specify its own — see m.rearmIntervalMs
const MIN_REARM_MS = 2 * 1000;   // dashboard floor: 2 seconds
const MAX_REARM_MS = 5 * 60 * 1000; // dashboard ceiling: 5 minutes

const SIDE_CANDIDATES_DEFAULT = []; // populated per-match from outcomeLabel

let DRY_RUN = (process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const DEFAULT_CAPITAL = Number(process.env.SPORTS_DEFAULT_CAPITAL || 200);

// ── Strategy parameters (shared across every match) ──
const GRID_INTERVAL = Number(process.env.SPORTS_GRID_INTERVAL || 0.05); // spacing between rungs AND the trailing step after each TP
const TP_OFFSET     = Number(process.env.SPORTS_TP_OFFSET || 0.10);     // every rung's TP = its own entry + this
const MAX_ENTRY_PRICE = 0.89; // a rung won't (re-)arm past this — its TP (entry+0.10) would exceed 0.99, an unreachable sell price
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
let warnedNoTraderLimitMethods = false;
let globalTradeSeq = 0;

/** @type {Map<string, any>} matchId -> match state object */
let matches = new Map();
let nextMatchSeq = 1;

// ─────────────────────────────────────────
//  Match / rung factories
// ─────────────────────────────────────────
function freshRung(id) {
  return {
    id,
    nextEntryPrice: null, // set once we've discovered/anchored a live price
    maxedOut: false,      // true once its TP would exceed 0.99 — stops (re-)arming
    entryOrderId: null,
    entryPending: false,
    pendingShares: null, // shares actually committed to the current resting entry order — the source of truth for fill sizing
    fills: 0,
    position: null, // { shares, entryPrice, cost, tpPrice, tpOrderId, tpPending, closed, won, closedReason }
  };
}

function newMatch({ id, sport, label, tokenId, conditionId, eventSlug, outcomeLabel, capital, rearmSeconds }) {
  const cap = Number(capital) > 0 ? Number(capital) : DEFAULT_CAPITAL;
  const rearmMs = Number(rearmSeconds) > 0
    ? Math.min(MAX_REARM_MS, Math.max(MIN_REARM_MS, Math.round(Number(rearmSeconds) * 1000)))
    : REARM_INTERVAL_MS;
  return {
    id,
    sport,                       // 'cricket' | 'tennis' | 'crypto'
    label: label || id,
    outcomeLabel: outcomeLabel || null,
    eventSlug: eventSlug || null,
    tradingEnabled: true,
    removed: false,
    market: {
      status: tokenId ? 'awaiting-price' : 'discovering', // 'discovering' | 'awaiting-price' | 'trading' | 'resolved' | 'error'
      eventTitle: null,
      marketQuestion: label || null,
      conditionId: conditionId || null,
      tokenId: tokenId || null,
      ask: null, bid: null,
      resolvedWinner: null,
    },
    capital: cap,
    bankroll: cap,
    realizedPnl: 0, rebatesEarned: 0, wins: 0, losses: 0,
    equityCurve: [{ t: Date.now(), equity: cap }],
    rungs: [freshRung('near'), freshRung('far')],
    initialGridActivated: false, // 'far' rung stays inactive until the initial (near) entry actually fills
    rearmIntervalMs: rearmMs,    // per-match self-healing interval — set at add-time, 2s-5min, defaults to REARM_INTERVAL_MS
    logs: [],
    trades: [],
    lastPriceFetch: 0, lastStatusFetch: 0, lastOrderPoll: 0, lastRearm: Date.now(),
    createdAt: Date.now(),
  };
}

// ─────────────────────────────────────────
//  Logging / bookkeeping (per match)
// ─────────────────────────────────────────
function log(m, msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  m.logs.push(line);
  if (m.logs.length > 400) m.logs.shift();
  slog(`[${m.sport}:${m.label}] ${line}`);
}
function registerTrade(m, t) {
  const trade = { seq: ++globalTradeSeq, matchId: m.id, match: m.label, sport: m.sport, time: new Date().toISOString().slice(11, 19), ...t };
  m.trades.push(trade);
  if (m.trades.length > 300) m.trades.shift();
}
function recordEquity(m) {
  m.equityCurve.push({ t: Date.now(), equity: markValue(m) });
  if (m.equityCurve.length > 1000) m.equityCurve.shift();
}
function markValue(m) {
  let held = 0;
  for (const r of m.rungs) {
    if (r.position && !r.position.closed) {
      const px = m.market.bid != null ? m.market.bid : r.position.entryPrice;
      held += r.position.shares * px;
    }
  }
  return round2(m.bankroll + held);
}

// ─────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-grid-bot/1.0' } });
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
    slog('[sports] ❌ LIVE trading needs trader.placeLimitBuy / trader.placeLimitSell (and ideally getOrder / cancelOrder) on polymarket-trader.js — LIVE order actions will be skipped until added. DRY_RUN is unaffected.');
  }
  return ok;
}
async function placeRestingBuy(m, tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethods()) return null;
    try { return await trader.placeLimitBuy(tokenId, price, shares); }
    catch (e) { log(m, `❌ placeLimitBuy failed: ${describeOrderError(e)}`); return null; }
  }
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: false };
}
async function placeRestingSell(m, tokenId, price, shares) {
  if (!DRY_RUN) {
    if (!traderHasLimitMethods()) return null;
    try { return await trader.placeLimitSell(tokenId, price, shares); }
    catch (e) { log(m, `❌ placeLimitSell failed: ${describeOrderError(e)}`); return null; }
  }
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: false };
}
async function cancelRestingOrder(m, orderId) {
  if (!orderId || orderId.startsWith('dry-')) return;
  if (!DRY_RUN && trader && typeof trader.cancelOrder === 'function') {
    try { await trader.cancelOrder(orderId); } catch (e) { log(m, `⚠️  cancelOrder failed: ${describeOrderError(e)}`); }
  }
}

// ─────────────────────────────────────────
//  Market discovery — only used when a match is added by event slug
//  (no explicit token ID). Generic across cricket / tennis.
// ─────────────────────────────────────────
function parseMarketTokens(mk) {
  try {
    const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
    const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}
function tokenIdForOutcome(mk, outcomeLabel) {
  const tokens = parseMarketTokens(mk);
  if (!tokens.length) return null;
  const target = (outcomeLabel || '').trim().toLowerCase();
  if (!target) return { tokenId: tokens[0].token_id, outcome: tokens[0].outcome };
  let tok = tokens.find(t => (t.outcome || '').trim().toLowerCase() === target);
  if (!tok) tok = tokens.find(t => (t.outcome || '').toLowerCase().includes(target));
  if (!tok) tok = tokens.find(t => target.includes((t.outcome || '').toLowerCase()));
  return tok ? { tokenId: tok.token_id, outcome: tok.outcome } : null;
}
function pickPrimaryMarket(event) {
  const marketsList = event.markets || [];
  if (!marketsList.length) return null;
  const blacklist = ['toss', 'batter', 'completed', 'draw', 'set winner', 'total games', 'ace count', 'handicap'];
  const isBlacklisted = mk => {
    const s = `${mk.groupItemTitle || ''} ${mk.question || ''}`.toLowerCase();
    return blacklist.some(b => s.includes(b));
  };
  // 1) explicit "moneyline" / "match winner" / "winner" keyword hit
  let mk = marketsList.find(x => /moneyline|match winner/i.test(`${x.groupItemTitle || ''} ${x.question || ''}`));
  if (mk) return mk;
  // 2) highest-volume market that isn't one of the known other sub-markets
  const candidates = marketsList.filter(x => !isBlacklisted(x));
  if (candidates.length) {
    candidates.sort((a, b) => (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0));
    return candidates[0];
  }
  // 3) last resort — just the highest-volume market of any kind
  const all = [...marketsList].sort((a, b) => (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0));
  return all[0] || null;
}

async function discoverMarket(m) {
  if (!m.eventSlug) { m.market.status = 'error'; log(m, '⚠️  no eventSlug or tokenId provided — cannot discover a market'); return; }
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(m.eventSlug)}`);
    if (!event || !event.id) { log(m, `⚠️  event slug not found: ${m.eventSlug}`); m.market.status = 'error'; return; }
    m.market.eventTitle = event.title || event.slug;

    const mk = pickPrimaryMarket(event);
    if (!mk) { log(m, '⚠️  no usable market found in event'); m.market.status = 'error'; return; }

    const found = tokenIdForOutcome(mk, m.outcomeLabel);
    if (!found) { log(m, `⚠️  could not find a "${m.outcomeLabel || '(any)'}" token on market "${mk.question || mk.groupItemTitle}"`); m.market.status = 'error'; return; }

    m.market.marketQuestion = mk.groupItemTitle || mk.question || mk.slug;
    m.market.conditionId = mk.conditionId || m.market.conditionId || null;
    m.market.tokenId = found.tokenId;
    m.market.status = 'awaiting-price';
    log(m, `🎯 locked onto market "${m.market.marketQuestion}" (event: ${m.market.eventTitle}) — trading outcome "${found.outcome}" — PLEASE VERIFY this is correct before relying on this in LIVE mode`);
  } catch (e) {
    log(m, `⚠️  discoverMarket failed: ${e.message}`);
    m.market.status = 'error';
  }
}

// ─────────────────────────────────────────
//  URL lookup — paste any Polymarket match URL (or bare slug) and get
//  back the sport, the market, and BOTH outcomes with live prices, so
//  the dashboard can add the match with one click, no guessing.
// ─────────────────────────────────────────
function extractSlugFromInput(input) {
  const raw = (input || '').trim();
  if (!raw) return { slug: null, pathParts: [] };
  const noQueryOrHash = raw.split('?')[0].split('#')[0];
  const parts = noQueryOrHash.split('/').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { slug: null, pathParts: [] };
  return { slug: parts[parts.length - 1], pathParts: parts };
}
function detectSportFromPath(pathParts, slug) {
  const hay = `${pathParts.join(' ')} ${slug || ''}`.toLowerCase();
  const tennisHints = ['atp', 'wta', 'itf', 'tennis', 'wimbledon', 'roland-garros', 'us-open-tennis', 'australian-open'];
  const cricketHints = ['cricket', 'crint', 'ipl', 'bbl', 'psl', 'cpl', 't20', 't10', 'odi', 'the-hundred', 'test-cricket'];
  const cryptoHints = ['updown', 'up-or-down', 'btc-', 'eth-', 'sol-', 'xrp-', 'crypto'];
  if (tennisHints.some(h => hay.includes(h))) return 'tennis';
  if (cricketHints.some(h => hay.includes(h))) return 'cricket';
  if (cryptoHints.some(h => hay.includes(h))) return 'crypto';
  return null;
}

async function lookupMatchByUrl(input) {
  const { slug, pathParts } = extractSlugFromInput(input);
  if (!slug) {
    return { ok: false, error: 'Could not read a match slug out of that — paste the full match page URL, e.g. https://polymarket.com/sports/atp/atp-baez-kecmano-2026-07-20' };
  }
  const sport = detectSportFromPath(pathParts, slug);
  if (!sport) {
    return { ok: false, error: `Could not tell whether "${slug}" is cricket, tennis, or a crypto Up/Down market from that URL — this engine only supports those right now. If it IS one of those, use the manual Token ID field below instead.` };
  }
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
    if (!event || !event.id) return { ok: false, error: `No Polymarket event found for slug "${slug}" — double check the URL.` };

    const mk = pickPrimaryMarket(event);
    if (!mk) return { ok: false, error: `Found the event "${event.title || slug}" but it has no usable market inside it.` };

    const tokens = parseMarketTokens(mk);
    if (!tokens.length || tokens.some(t => !t.token_id)) {
      return { ok: false, error: `Found the market "${mk.question || mk.groupItemTitle || slug}" but couldn't read its outcome tokens — it may not be live/tradeable yet.` };
    }

    const outcomes = await Promise.all(tokens.map(async t => {
      const [ask, bid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${t.token_id}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${t.token_id}&side=SELL`).catch(() => null),
      ]);
      return {
        outcome: t.outcome,
        tokenId: t.token_id,
        ask: ask?.price != null ? parseFloat(ask.price) : null,
        bid: bid?.price != null ? parseFloat(bid.price) : null,
      };
    }));

    return {
      ok: true,
      sport,
      eventSlug: slug,
      eventTitle: event.title || event.slug,
      marketQuestion: mk.groupItemTitle || mk.question || mk.slug,
      conditionId: mk.conditionId || null,
      outcomes,
    };
  } catch (e) {
    return { ok: false, error: `Lookup failed: ${e.message}` };
  }
}

// ─────────────────────────────────────────
//  Price feed
// ─────────────────────────────────────────
async function refreshPrice(m) {
  if (!m.market.tokenId) return;
  try {
    const [ask, bid] = await Promise.all([
      getJSON(`${CLOB}/price?token_id=${m.market.tokenId}&side=BUY`).catch(() => null),
      getJSON(`${CLOB}/price?token_id=${m.market.tokenId}&side=SELL`).catch(() => null),
    ]);
    if (ask?.price != null) m.market.ask = parseFloat(ask.price);
    if (bid?.price != null) m.market.bid = parseFloat(bid.price);
  } catch (_) {}
}

// Seeds ONLY the initial (near) entry, priced AT the live ask so it crosses
// the spread and fills right away. The far rung stays fully dormant
// (nextEntryPrice = null, so armRungs/rearmStaleRungs both skip it) until
// that initial entry actually fills — see the activation block in
// onEntryFilled, which anchors far at (initial fill price - GRID_INTERVAL).
function tryEstablishInitialGrid(m) {
  if (m.market.status !== 'awaiting-price') return;
  if (m.market.ask == null) return;
  const initialPrice = round2(m.market.ask);
  if (initialPrice < MIN_ENTRY_PRICE || initialPrice > MAX_ENTRY_PRICE) {
    // Price too extreme to place a workable initial entry right now (its TP would be unreachable) — keep waiting.
    return;
  }
  m.rungs[0].nextEntryPrice = initialPrice; // near rung — the initial entry
  m.rungs[1].nextEntryPrice = null;         // far rung — inactive until initial entry fills
  m.market.status = 'trading';
  log(m, `🎯 initial entry queued at live ask ${initialPrice.toFixed(2)} (crosses the spread to fill immediately, TP ${round2(initialPrice + TP_OFFSET).toFixed(2)}) — 2nd grid rung stays dormant until this fills`);
}

// ─────────────────────────────────────────
//  Entry / TP management
// ─────────────────────────────────────────
function affordable(m, shares, price) { return round2(shares * price) <= m.bankroll; }

async function armRungs(m) {
  if (!m.tradingEnabled || m.market.status !== 'trading') return;
  const eligible = m.rungs.filter(r => !r.position && !r.entryPending && !r.maxedOut && r.nextEntryPrice != null);
  if (!eligible.length) return;
  // Full reinvestment: whichever rung(s) are actually arming right now split
  // the ENTIRE free bankroll between them. If only one rung is arming (the
  // common case — one TP just freed it up), it gets 100% of the free cash,
  // not a flat half. If both happen to arm in the same pass, they split it
  // evenly so neither over-commits against the other's pending order.
  const notionalEach = round2(m.bankroll / eligible.length); // snapshot once — simultaneous arms split cleanly
  for (const r of eligible) {
    await armRung(m, r, notionalEach);
  }
}

async function armRung(m, r, notional) {
  if (r.position || r.entryPending || r.maxedOut) return;
  const price = r.nextEntryPrice;
  if (price == null || price < MIN_ENTRY_PRICE || price > MAX_ENTRY_PRICE) return;
  if (notional <= 0) return;
  const shares = round2(notional / price);
  if (!affordable(m, shares, price)) return; // will retry next tick once bankroll frees up

  const resp = await placeRestingBuy(m, m.market.tokenId, price, shares);
  if (!resp) return;
  r.entryOrderId = resp.id;
  r.entryPending = true;
  r.pendingShares = shares; // the size actually committed to this resting order — fill paths must use THIS, not re-derive from a bankroll snapshot taken later
  if (resp.filled) await onEntryFilled(m, r, price, resp.filledShares || shares);
}

async function onEntryFilled(m, r, fillPrice, filledShares) {
  if (r.position) return; // never stack a second position on this rung
  const shares = filledShares > 0 ? filledShares : (r.pendingShares > 0 ? r.pendingShares : round2(m.bankroll / fillPrice));
  const cost = round2(shares * fillPrice);
  const rebate = estimateMakerRebate(shares, fillPrice);

  m.bankroll = round2(m.bankroll - cost + rebate);
  m.rebatesEarned = round2(m.rebatesEarned + rebate);

  const tpPrice = round2(fillPrice + TP_OFFSET);
  r.entryPending = false;
  r.entryOrderId = null;
  r.pendingShares = null;
  r.fills += 1;
  r.position = { shares, entryPrice: fillPrice, cost, tpPrice, tpOrderId: null, tpPending: false, closed: false, won: null, closedReason: null };

  registerTrade(m, { rung: r.id, side: 'BUY', reason: 'ENTRY', price: fillPrice, shares, cost, rebate, fill: r.fills });
  log(m, `✅ [${r.id}] resting buy filled @ ${fillPrice.toFixed(2)} — ${shares.toFixed(2)}sh ($${cost.toFixed(2)}) | +$${rebate.toFixed(5)} maker rebate (est.) | TP armed @ ${tpPrice.toFixed(2)} — fill #${r.fills}`);

  // First-ever fill in this match activates the dormant far rung, anchored
  // off this REAL fill price (not the pre-trade ask) — one-time only.
  if (!m.initialGridActivated) {
    m.initialGridActivated = true;
    const far = m.rungs.find(x => x.id === 'far');
    if (far && far !== r && !far.position) {
      const farPrice = round2(fillPrice - GRID_INTERVAL);
      if (farPrice >= MIN_ENTRY_PRICE) {
        far.nextEntryPrice = farPrice;
        log(m, `🔓 [far] 2nd grid rung activated — next entry ${farPrice.toFixed(2)} (initial fill ${fillPrice.toFixed(2)} − ${GRID_INTERVAL.toFixed(2)})`);
      } else {
        log(m, `🔓 [far] 2nd grid rung would activate below the minimum entry floor (${farPrice.toFixed(2)} < ${MIN_ENTRY_PRICE}) — stays dormant until a stale rearm brings it into range`);
      }
    }
  }

  const tpResp = await placeRestingSell(m, m.market.tokenId, tpPrice, shares);
  if (tpResp) {
    r.position.tpOrderId = tpResp.id;
    r.position.tpPending = true;
    if (tpResp.filled) await onTPFilled(m, r, tpResp.avgPrice || tpPrice, tpResp.filledShares || shares);
  }
  recordEquity(m);
}

async function onTPFilled(m, r, fillPrice, filledShares) {
  const pos = r.position;
  if (!pos || pos.closed) return;
  const shares = filledShares > 0 ? filledShares : pos.shares;
  const proceeds = round2(shares * fillPrice);
  const rebate = estimateMakerRebate(shares, fillPrice);
  const profit = round2(proceeds - pos.cost + rebate);

  m.bankroll = round2(m.bankroll + proceeds + rebate);
  m.realizedPnl = round2(m.realizedPnl + profit);
  m.rebatesEarned = round2(m.rebatesEarned + rebate);
  m.wins++;
  pos.closed = true; pos.won = true; pos.closedReason = 'TP'; pos.tpPending = false;

  registerTrade(m, { rung: r.id, side: 'SELL', reason: 'TP', price: fillPrice, shares, profit, rebate });
  log(m, `💰 [${r.id}] TP filled @ ${fillPrice.toFixed(2)} — pnl=$${profit.toFixed(2)} (incl. rebate) | bankroll=$${m.bankroll.toFixed(2)} — trailing this rung up`);

  r.position = null;
  // Trail this rung up by GRID_INTERVAL, based on its OWN old entry — not the live price.
  const nextPrice = round2(pos.entryPrice + GRID_INTERVAL);
  if (round2(nextPrice + TP_OFFSET) > 0.99) {
    r.maxedOut = true;
    r.nextEntryPrice = nextPrice;
    log(m, `🛑 [${r.id}] next entry would be ${nextPrice.toFixed(2)} (TP ${round2(nextPrice + TP_OFFSET).toFixed(2)} > 0.99) — this rung has maxed out for now, no further re-entries until a stale rearm brings it back in range`);
  } else {
    r.nextEntryPrice = nextPrice;
  }
  recordEquity(m);
  await armRungs(m); // this rung just freed up — try to re-enter (sized off current bankroll)
}

// DRY_RUN fill simulation — checked every tick.
function tickDryRun(m) {
  if (m.market.status !== 'trading') return;
  const ask = m.market.ask, bid = m.market.bid;
  for (const r of m.rungs) {
    const pos = r.position;
    if (pos && !pos.closed && pos.tpPending) {
      if (bid != null && bid >= pos.tpPrice) {
        onTPFilled(m, r, pos.tpPrice, pos.shares).catch(e => log(m, `⚠️  TP fill error: ${e.message}`));
      }
      continue;
    }
    if (!pos && r.entryPending && ask != null && r.nextEntryPrice != null && ask <= r.nextEntryPrice) {
      const shares = r.pendingShares > 0 ? r.pendingShares : round2(m.bankroll / r.nextEntryPrice);
      onEntryFilled(m, r, r.nextEntryPrice, shares).catch(e => log(m, `⚠️  entry fill error: ${e.message}`));
    }
  }
}

// LIVE order-fill polling
async function pollLiveOrders(m) {
  if (DRY_RUN || !trader || typeof trader.getOrder !== 'function') return;
  for (const r of m.rungs) {
    if (r.entryPending && r.entryOrderId) {
      try {
        const st = await trader.getOrder(r.entryOrderId);
        if (st && st.filled) await onEntryFilled(m, r, r.nextEntryPrice, st.filledShares || r.pendingShares || round2(m.bankroll / r.nextEntryPrice));
      } catch (e) { log(m, `⚠️  getOrder (entry) failed: ${describeOrderError(e)}`); }
    }
    const pos = r.position;
    if (pos && !pos.closed && pos.tpPending && pos.tpOrderId) {
      try {
        const st = await trader.getOrder(pos.tpOrderId);
        if (st && st.filled) await onTPFilled(m, r, st.avgPrice || pos.tpPrice, st.filledShares || pos.shares);
      } catch (e) { log(m, `⚠️  getOrder (tp) failed: ${describeOrderError(e)}`); }
    }
  }
}

// ─────────────────────────────────────────
//  Idle/unfilled-rung self-healing rearm — re-anchor to the LIVE price so
//  the ladder follows the market instead of stalling. Interval is
//  per-match (m.rearmIntervalMs, 2s-5min, set at add-time via the
//  dashboard; falls back to REARM_INTERVAL_MS if unspecified). Rungs that
//  already hold a position (waiting on their TP) are never touched here
//  — only idle / still-resting entry rungs.
// ─────────────────────────────────────────
async function rearmStaleRungs(m) {
  if (m.market.status !== 'trading') return;
  if (m.market.ask == null) return;
  const now = Date.now();
  const intervalMs = m.rearmIntervalMs > 0 ? m.rearmIntervalMs : REARM_INTERVAL_MS;
  if (now - m.lastRearm < intervalMs) return;
  m.lastRearm = now;

  for (let i = 0; i < m.rungs.length; i++) {
    const r = m.rungs[i];
    if (r.position && !r.position.closed) continue; // never disturb an open position or its TP
    if (r.id === 'far' && !m.initialGridActivated) continue; // far stays dormant until the initial entry fills — don't wake it off a timer

    // Cancel any stale resting entry order that hasn't filled in this window.
    if (r.entryPending && r.entryOrderId) {
      await cancelRestingOrder(m, r.entryOrderId);
      r.entryPending = false;
      r.entryOrderId = null;
      r.pendingShares = null;
    }

    const spacing = (i + 1) * GRID_INTERVAL; // near = 1x below ask, far = 2x below ask
    const fresh = round2(m.market.ask - spacing);
    const willBeMaxed = fresh < MIN_ENTRY_PRICE || round2(fresh + TP_OFFSET) > 0.99;
    const prevEntry = r.nextEntryPrice;
    r.nextEntryPrice = fresh;
    r.maxedOut = willBeMaxed;

    if (prevEntry !== fresh) {
      log(m, `🔁 [${r.id}] 2-min rearm — re-anchored to live ask ${m.market.ask.toFixed(2)} → next entry ${fresh.toFixed(2)}${willBeMaxed ? ' (currently unreachable — parked)' : ''}`);
    }
  }
}

// ─────────────────────────────────────────
//  Match / market resolution
// ─────────────────────────────────────────
async function checkResolution(m) {
  if (m.market.status === 'resolved') return;
  if (!m.market.conditionId && !m.eventSlug) return; // nothing to poll against — added by bare tokenId only
  try {
    let mk = null;
    if (m.eventSlug) {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(m.eventSlug)}`);
      const list = event.markets || [];
      mk = (m.market.conditionId ? list.find(x => x.conditionId === m.market.conditionId) : null) || list[0] || null;
    } else if (m.market.conditionId) {
      const arr = await getJSON(`${GAMMA}/markets?condition_ids=${encodeURIComponent(m.market.conditionId)}`);
      mk = Array.isArray(arr) ? arr[0] : (arr && arr.length ? arr[0] : null);
    }
    if (!mk || mk.closed !== true) return;

    let won = null;
    if (mk.outcomePrices && m.market.tokenId) {
      const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : mk.outcomePrices;
      const tokens = parseMarketTokens(mk);
      const idx = tokens.findIndex(t => String(t.token_id) === String(m.market.tokenId));
      if (idx >= 0 && prices[idx] != null) won = parseFloat(prices[idx]) >= 0.5;
    }
    await resolveMatch(m, won);
  } catch (e) {
    log(m, `⚠️  checkResolution failed: ${e.message}`);
  }
}

async function resolveMatch(m, won) {
  if (m.market.status === 'resolved') return;
  if (won == null) {
    log(m, '⚠️  market appears closed but the outcome for our specific token could not be confirmed — leaving positions open, please check manually');
    return;
  }
  m.market.status = 'resolved';
  m.market.resolvedWinner = won ? (m.outcomeLabel || 'Our side') : 'Other';

  for (const r of m.rungs) {
    if (r.entryPending) {
      await cancelRestingOrder(m, r.entryOrderId);
      r.entryPending = false;
      r.entryOrderId = null;
      r.pendingShares = null;
    }
    const pos = r.position;
    if (!pos || pos.closed) continue;
    if (pos.tpPending) await cancelRestingOrder(m, pos.tpOrderId);

    const proceeds = won ? round2(pos.shares * 1) : 0;
    const profit = round2(proceeds - pos.cost);
    m.bankroll = round2(m.bankroll + proceeds);
    m.realizedPnl = round2(m.realizedPnl + profit);
    if (won) m.wins++; else m.losses++;
    pos.closed = true; pos.won = won; pos.closedReason = 'RESOLUTION';
    const icon = won ? '💰' : '💥';
    log(m, `${icon} [${r.id}] RESOLUTION ${pos.shares.toFixed(2)}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${m.bankroll.toFixed(2)}`);
    registerTrade(m, { rung: r.id, side: 'SELL', reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
  }
  log(m, `🏁 Match resolved — ${won ? 'WON' : 'LOST'} | final bankroll $${m.bankroll.toFixed(2)} | realized P&L $${m.realizedPnl.toFixed(2)} | rebates $${m.rebatesEarned.toFixed(5)} — ladder is done, no further trading`);
  recordEquity(m);
}

// ─────────────────────────────────────────
//  Per-match tick
// ─────────────────────────────────────────
async function tick(m) {
  if (m.market.status === 'discovering') { await discoverMarket(m); return; }
  if (m.market.status === 'error') return; // discovery failed — stays idle; check logs
  if (m.market.status === 'awaiting-price') { tryEstablishInitialGrid(m); if (m.market.status !== 'trading') return; }
  if (m.market.status === 'resolved') return;

  if (DRY_RUN) tickDryRun(m);
  if (!m.tradingEnabled) return;
  await armRungs(m);
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      const now = Date.now();
      for (const m of matches.values()) {
        if (m.removed) continue;
        try {
          if (now - m.lastPriceFetch >= PRICE_REFRESH_MS) { m.lastPriceFetch = now; await refreshPrice(m); }
          if (now - m.lastStatusFetch >= STATUS_REFRESH_MS && m.market.status !== 'discovering') { m.lastStatusFetch = now; await checkResolution(m); }
          if (!DRY_RUN && now - m.lastOrderPoll >= ORDER_POLL_MS) { m.lastOrderPoll = now; await pollLiveOrders(m); }
          await rearmStaleRungs(m);
          await tick(m);
        } catch (e) {
          log(m, `⚠️  match loop error: ${e.message}`);
        }
      }
      emitFn('sportsState', buildState());
    } catch (e) { slog(`[sports] ⚠️  Loop error: ${e.message}`); }
    await new Promise(res => setTimeout(res, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildMatchState(m) {
  const mv = markValue(m);
  let costBasis = 0;
  for (const r of m.rungs) if (r.position && !r.position.closed) costBasis += r.position.cost;
  costBasis = round2(costBasis);
  const held = round2(mv - m.bankroll);
  const unrealizedPnl = round2(held - costBasis);

  return {
    id: m.id, sport: m.sport, label: m.label, outcomeLabel: m.outcomeLabel, eventSlug: m.eventSlug,
    tradingEnabled: m.tradingEnabled,
    market: { ...m.market },
    rungs: m.rungs.map(r => ({
      id: r.id, nextEntryPrice: r.nextEntryPrice, maxedOut: r.maxedOut,
      entryPending: r.entryPending, fills: r.fills,
      position: r.position ? {
        shares: r.position.shares, entryPrice: r.position.entryPrice, cost: r.position.cost,
        tpPrice: r.position.tpPrice, tpPending: r.position.tpPending, closed: r.position.closed,
      } : null,
    })),
    capital: m.capital, bankroll: m.bankroll, markValue: mv,
    realizedPnl: m.realizedPnl, unrealizedPnl, rebatesEarned: m.rebatesEarned, wins: m.wins, losses: m.losses,
    totalPnl: round2(mv - m.capital),
    rearmIntervalMs: m.rearmIntervalMs,
    equityCurve: m.equityCurve, logs: m.logs.slice(-60),
    createdAt: m.createdAt,
  };
}
function buildState() {
  const list = [...matches.values()].filter(m => !m.removed).sort((a, b) => a.createdAt - b.createdAt).map(buildMatchState);
  const allTrades = [];
  for (const m of matches.values()) if (!m.removed) allTrades.push(...m.trades);
  allTrades.sort((a, b) => b.seq - a.seq);
  return {
    dryRun: DRY_RUN,
    matches: list,
    trades: allTrades.slice(0, 100),
    config: {
      gridInterval: GRID_INTERVAL, tpOffset: TP_OFFSET,
      makerRebateShare: SPORTS_MAKER_REBATE_SHARE, sportsTakerFeeRate: SPORTS_TAKER_FEE_RATE,
      rearmIntervalMsDefault: REARM_INTERVAL_MS, rearmIntervalMsMin: MIN_REARM_MS, rearmIntervalMsMax: MAX_REARM_MS,
      orderType: 'resting-limit', reentryMode: 'trailing + configurable stale rearm (per match)',
    },
  };
}

// ─────────────────────────────────────────
//  Controls
// ─────────────────────────────────────────
function addMatch(opts) {
  const { sport, label, tokenId, conditionId, eventSlug, outcomeLabel, capital, rearmSeconds } = opts || {};
  const VALID_SPORTS = ['cricket', 'tennis', 'crypto'];
  if (!VALID_SPORTS.includes(sport)) return { ok: false, error: `sport must be one of: ${VALID_SPORTS.join(', ')}` };
  if (!tokenId && !eventSlug) return { ok: false, error: 'Provide a tokenId (recommended) or an eventSlug + outcomeLabel to add a match.' };
  if (!tokenId && eventSlug && !outcomeLabel) return { ok: false, error: 'When adding by eventSlug (no tokenId), an outcomeLabel is required (e.g. "Nepal", "Djokovic") so the bot knows which side to back.' };
  if (rearmSeconds != null && (isNaN(Number(rearmSeconds)) || Number(rearmSeconds) <= 0)) {
    return { ok: false, error: 'rearmSeconds must be a positive number of seconds' };
  }

  const id = `${sport}-${nextMatchSeq++}-${Date.now().toString(36)}`;
  const m = newMatch({ id, sport, label, tokenId, conditionId, eventSlug, outcomeLabel, capital, rearmSeconds });
  matches.set(id, m);

  const rearmSecEffective = Math.round(m.rearmIntervalMs / 1000);
  log(m, `➕ Match added — ${sport} | "${m.label}" | ${tokenId ? `token ${tokenId}${conditionId ? ` (condition ${conditionId})` : ' (no condition ID — resolution won\'t auto-detect; add one or pause/remove manually when it ends)'}` : `discovering via slug "${eventSlug}", backing "${outcomeLabel}"`} | capital $${m.capital.toFixed(2)} | self-healing every ${rearmSecEffective}s`);

  return { ok: true, id };
}
function removeMatch(id) {
  const m = matches.get(id);
  if (!m) return { ok: false, error: 'match not found' };
  log(m, '🗑️  Match removed from dashboard — no further trading, resting orders left as-is (cancel manually if needed)');
  m.removed = true;
  matches.delete(id);
  return { ok: true };
}
function pauseMatch(id) {
  const m = matches.get(id);
  if (!m) return { ok: false, error: 'match not found' };
  m.tradingEnabled = false;
  log(m, '⏸️  Paused (open positions/TPs still managed; no new entries armed)');
  return { ok: true };
}
function resumeMatch(id) {
  const m = matches.get(id);
  if (!m) return { ok: false, error: 'match not found' };
  m.tradingEnabled = true;
  log(m, '▶️  Resumed');
  return { ok: true };
}
function pauseAll() { for (const m of matches.values()) m.tradingEnabled = false; slog('[sports] ⏸️  All matches paused'); return { ok: true }; }
function resumeAll() { for (const m of matches.values()) m.tradingEnabled = true; slog('[sports] ▶️  All matches resumed'); return { ok: true }; }

function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) slog(`[sports] ${DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real resting limit orders'}`);
  return { ok: true, dryRun: DRY_RUN };
}
function getStatus() { return { ok: true, ...buildState() }; }

// Legacy aliases so an old caller expecting the single-match cricket-bot
// API (pauseTrading/resumeTrading/getStatus/buildState) still works and
// controls every match at once.
function pauseTrading() { return pauseAll(); }
function resumeTrading() { return resumeAll(); }

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  slog('[sports] 🏟️  Sports Trailing-Grid Ladder Engine — cricket, tennis & crypto Up/Down, multi-match');
  slog(`[sports] ⚙️  Default capital per match: $${DEFAULT_CAPITAL} (compounding) | Grid: 2 rungs, $${GRID_INTERVAL.toFixed(2)} apart, TP = entry + $${TP_OFFSET.toFixed(2)}`);
  slog(`[sports] ⚙️  Idle/unfilled rungs self-heal every ${Math.round(REARM_INTERVAL_MS / 1000)}s by default (2s-${Math.round(MAX_REARM_MS / 60000)}min, configurable per match from the dashboard)`);
  slog(`[sports] ${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  // Seed the original cricket match from env, for back-compat with the old single-event bot.
  const seedSlug = process.env.CRICKET_EVENT_SLUG || 'crint-npl2-nam3-2026-07-21';
  if (seedSlug) {
    const res = addMatch({
      sport: 'cricket',
      label: process.env.CRICKET_EVENT_LABEL || 'Nepal vs Namibia (Moneyline)',
      eventSlug: seedSlug,
      outcomeLabel: process.env.CRICKET_SIDE || 'nepal',
      capital: process.env.CRICKET_CAPITAL || DEFAULT_CAPITAL,
    });
    if (!res.ok) slog(`[sports] ⚠️  Failed to seed default cricket match: ${res.error}`);
  }

  mainLoop().catch(e => slog(`[sports] ❌ Fatal: ${e.message}`));
}

module.exports = {
  init,
  addMatch, removeMatch, pauseMatch, resumeMatch,
  pauseAll, resumeAll, pauseTrading, resumeTrading,
  setMode, getStatus, buildState,
  lookupMatchByUrl,
};
