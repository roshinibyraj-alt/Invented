'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET CRYPTO UP/DOWN — DECOUPLED 1H → 15m → 5m CANDLE-COLOR PLAYBOOK
 * ═══════════════════════════════════════════════════════════════
 *
 *  Every layer looks ONLY at its own immediate parent timeframe's most
 *  recently CLOSED Binance candle — plain red/green, no streak or
 *  reversal condition, no sitting out. Each layer is evaluated
 *  independently; a 5m window's side depends on the real 15m candle
 *  that just closed, NOT on whatever side its parent 15m block was
 *  assigned.
 *
 *  LAYER A — 1-hour candle → the hour's four 15m blocks:
 *  evaluated once at the top of every hour, using the most recently
 *  CLOSED 1h candle, and LOCKED for that whole hour:
 *
 *    1h candle closed RED   → block 1 (min 0–15)  = Up
 *                              block 2 (min 15–30) = Up
 *                              block 3 (min 30–45) = Down
 *                              block 4 (min 45–60) = Down
 *    1h candle closed GREEN → opposite: blocks 1–2 = Down, blocks 3–4 = Up
 *
 *  1H MARKET ITSELF — one direct entry attempt on the hourly market,
 *  watched from the 29-minute mark to the end of the hour. Side is a
 *  plain continuation of the same closed 1h candle (independent of the
 *  15m plan above): closed RED → Down, closed GREEN → Up.
 *
 *  LAYER B — 15-minute candle → that block's three 5m windows:
 *  evaluated independently at the start of each 15m block, using the
 *  most recently CLOSED 15m candle (the 15 minutes immediately before
 *  that block begins):
 *
 *    15m candle closed RED   → window 1 = Up,   windows 2–3 = Down
 *    15m candle closed GREEN → opposite: window 1 = Down, windows 2–3 = Up
 *
 *  A closed candle with close == open is folded into "green" for
 *  simplicity (no separate flat case).
 *
 *  ENTRY TRIGGER (identical at every timeframe) — a fixed-size market
 *  buy of FIXED_SHARES (50) shares fires the FIRST time the ask for
 *  the assigned side drops below ENTRY_THRESHOLD (0.40) at any point
 *  while that window is being watched. One-shot per window: once it
 *  fires (or the window ends without ever going below 0.40), that
 *  window is done — no more attempts.
 *
 *  SIZING — fixed 50 shares on every single entry, at every timeframe.
 *  No compounding, no pool, no bankroll-based scaling.
 *
 *  EXIT: none. No TP, no SL. Positions ride to actual window
 *  resolution; a separate, independent auto-claim script handles real
 *  redemption. This bot's own bookkeeping still simulates resolution
 *  (via the public Gamma API) purely to keep the dashboard's P&L
 *  figures meaningful.
 *
 *  SLUGS: the 5m/15m Polymarket markets use predictable epoch-based
 *  slugs (`{symbol}-updown-{tf}-{epoch}`) — same scheme the previous
 *  version of this bot already relied on successfully. The 1-HOUR
 *  market uses a DIFFERENT, confirmed Eastern-Time slug format, e.g.
 *  "bitcoin-up-or-down-july-14-2026-7pm-et" (verified directly against
 *  polymarket.com) — full coin name, month, day, YEAR, hour+am/pm, "-et".
 *  No guessing, no fallback variants: this is the one format built and
 *  used for every 1h lookup.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable (see setMode).
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const BINANCE = 'https://api.binance.com/api/v3';

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // stop watching / start resolving this many secs before nominal window end

let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true'; // runtime-switchable — see setMode
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const ENTRY_THRESHOLD      = Number(process.env.ENTRY_THRESHOLD || 0.40); // buy trigger: ask must fall below this
const FIXED_SHARES         = Number(process.env.FIXED_SHARES || 50);      // fixed size, every single entry
const QUOTE_BUFFER         = Number(process.env.QUOTE_BUFFER || 0.01);    // small buffer above ask so the "market" buy actually fills
const WATCH_1H_AFTER_SECS  = Number(process.env.WATCH_1H_AFTER_SECS || 29 * 60); // 1h market: only start watching at +29min

const CRYPTO_TAKER_FEE_RATE = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);

const TIMEFRAMES = { '1h': 3600, '15m': 900, '5m': 300 };
// Layer A: 1h candle color -> that hour's four 15m block sides
const SIDES_15M_BY_1H_COLOR = { red: ['Up', 'Up', 'Down', 'Down'], green: ['Down', 'Down', 'Up', 'Up'] };
// 1h market itself: plain continuation of the same closed 1h candle
const SIDE_1H_BY_1H_COLOR = { red: 'Down', green: 'Up' };
// Layer B: 15m candle color -> that block's three 5m window sides
const SIDES_5M_BY_15M_COLOR = { red: ['Up', 'Down', 'Down'], green: ['Down', 'Up', 'Up'] };

// Best-effort mapping for the 1h market's human-readable slug. Extend as needed.
const SYMBOL_FULL_NAME = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'xrp', DOGE: 'dogecoin',
  LTC: 'litecoin', ADA: 'cardano', AVAX: 'avalanche', LINK: 'chainlink', BNB: 'bnb',
};

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let pairList = [...DEFAULT_PAIRS];
let perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
let pairs = {};
let lastPolyPriceFetch = 0;
let totalEquityCurve = [];
let tokenAskMap = {}; // tokenId -> current BUY (ask) price

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-1h-reversal-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-1h-reversal-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// A marketable buy — priced a hair above the current ask so it fills now.
async function placeEntryBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}

// ─────────────────────────────────────────
//  1-hour reversal signal
// ─────────────────────────────────────────
// close == open is folded into 'green' — no separate flat case.
function candleColor(c) {
  const o = parseFloat(c[1]), cl = parseFloat(c[4]);
  return cl < o ? 'red' : 'green';
}

// Fetches the most recently CLOSED Binance candle for `symbol` at the given
// interval ('1h' or '15m') and returns its color ('red'|'green'), or null if
// no closed candle is available yet (caller should retry).
async function fetchLastClosedColor(symbol, interval) {
  const binanceSymbol = `${symbol}USDT`;
  const now = Date.now();
  const data = await getJSON(`${BINANCE}/klines?symbol=${binanceSymbol}&interval=${interval}&limit=3`);
  const closed = data.filter(c => c[6] < now); // [6] = closeTime
  if (!closed.length) return null;
  return candleColor(closed[closed.length - 1]);
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshPairState(symbol) {
  return {
    symbol,
    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    wins: 0, losses: 0,
    hourStart: null,
    hourColor: null,     // 'red' | 'green' — the closed 1h candle that decided this hour's plan
    direction1h: null,
    hourlySlugWarned: false,
    hourColorWarned: false,
    windows: [],          // flat list of window trackers: 1h(1) + 15m(4) + 5m(12) per hour
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

function windowStartFor(tf, tsSec = nowSec()) { const secs = TIMEFRAMES[tf]; return Math.floor(tsSec / secs) * secs; }

function buildWindow(symbol, tf, windowStart, side) {
  const secs = TIMEFRAMES[tf];
  return {
    id: `${symbol}-${tf}-${windowStart}`,
    tf, windowStart, windowEnd: windowStart + secs, side,
    slug: null, conditionId: null, upTokenId: null, downTokenId: null,
    loaded: false, tradable: false,
    watchStart: tf === '1h' ? windowStart + WATCH_1H_AFTER_SECS : windowStart,
    entryDone: false, entry: null, entrySkipped: false,
    resolved: false, resolvedAt: null, won: null,
    // only meaningful for tf === '15m': has its own 3x 5m children been built yet?
    subBuilt: tf !== '15m' ? null : false,
    subBuildWarned: false,
    refColor: null, // the closed candle color that decided this window's side (for the UI)
  };
}

// ─────────────────────────────────────────
//  Market discovery
// ─────────────────────────────────────────
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
function pickMarket(event) {
  return (event.markets || []).find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || (event.markets || [])[0];
}

// 5m / 15m: predictable epoch-based slugs, same scheme the prior version used.
async function fetchEventForWindow(symbol, tf, windowStart) {
  const secs = TIMEFRAMES[tf];
  for (const offsetMult of [0, -1, 1]) {
    const ws = windowStart + offsetMult * secs;
    const slug = `${symbol.toLowerCase()}-updown-${tf}-${ws}`;
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) {
        return { event, market: pickMarket(event), slug };
      }
    } catch (_) {}
  }
  return null;
}

// 1h: confirmed live format is Eastern-Time, WITH year, e.g.
// "bitcoin-up-or-down-july-14-2026-7pm-et" for the hour beginning 7PM ET
// on July 14, 2026 (verified directly against polymarket.com). No guessing,
// no fallback variants — this is the one format Polymarket currently issues
// for current/future hourly windows.
function etHourParts(windowStartSec) {
  const d = new Date(windowStartSec * 1000);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', hour12: true,
  });
  const parts = fmt.formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value || '';
  const month = get('month').toLowerCase();
  const day = get('day');
  const year = get('year');
  const hourNum = get('hour').toLowerCase();
  const dayPeriod = (parts.find(p => p.type === 'dayPeriod')?.value || '').toLowerCase();
  return { month, day, year, hourLabel: `${hourNum}${dayPeriod}` };
}
function buildHourlySlug(symbol, windowStart) {
  const name = SYMBOL_FULL_NAME[symbol] || symbol.toLowerCase();
  const { month, day, year, hourLabel } = etHourParts(windowStart);
  return `${name}-up-or-down-${month}-${day}-${year}-${hourLabel}-et`;
}
async function fetchHourlyEvent(symbol, windowStart) {
  const slug = buildHourlySlug(symbol, windowStart);
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
    if (event && event.id && Array.isArray(event.markets) && event.markets.length) {
      return { event, market: pickMarket(event), slug };
    }
  } catch (_) {}
  return null;
}

async function tryLoadWindow(s, w) {
  const found = w.tf === '1h'
    ? await fetchHourlyEvent(s.symbol, w.windowStart)
    : await fetchEventForWindow(s.symbol, w.tf, w.windowStart);
  if (!found) {
    if (w.tf === '1h' && !s.hourlySlugWarned && nowSec() - w.windowStart > 30) {
      s.hourlySlugWarned = true;
      log(`⚠️  ${s.symbol}: 1h market not found at slug "${buildHourlySlug(s.symbol, w.windowStart)}" — 1h entry for this hour will be skipped. If this persists, check the real slug on polymarket.com and update SYMBOL_FULL_NAME / buildHourlySlug().`);
    }
    return;
  }
  const { event, market, slug } = found;
  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) return;
  w.slug = slug;
  w.conditionId = market.conditionId || null;
  w.upTokenId = upId;
  w.downTokenId = downId;
  w.loaded = true;
  w.tradable = true;
}

// ─────────────────────────────────────────
//  Polymarket price feed
// ─────────────────────────────────────────
async function refreshAllPrices() {
  const tokenSet = new Set();
  for (const s of Object.values(pairs)) {
    for (const w of s.windows) {
      if (w.resolved || !w.loaded) continue;
      if (w.upTokenId) tokenSet.add(w.upTokenId);
      if (w.downTokenId) tokenSet.add(w.downTokenId);
    }
  }
  if (!tokenSet.size) return;
  const requests = [...tokenSet].map(tid => ({ token_id: tid, side: 'BUY' }));
  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const price = parseFloat(row.price);
        if (tid && Number.isFinite(price)) tokenAskMap[tid] = price;
      }
    } else if (data && typeof data === 'object') {
      for (const [tid, val] of Object.entries(data)) {
        if (val && typeof val === 'object') {
          const p = val.BUY != null ? val.BUY : (val.buy != null ? val.buy : null);
          if (p != null) tokenAskMap[tid] = parseFloat(p);
        }
      }
    }
  } catch (e) {
    for (const tid of tokenSet) {
      try {
        const r = await getJSON(`${CLOB}/price?token_id=${tid}&side=BUY`);
        const p = parseFloat(r.price || r.mid);
        if (Number.isFinite(p)) tokenAskMap[tid] = p;
      } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function windowMarkValue(w) {
  if (!w.entryDone || !w.entry || w.resolved) return 0;
  const tid = w.entry.side === 'Up' ? w.upTokenId : w.downTokenId;
  const px = tokenAskMap[tid];
  return round2(w.entry.shares * (px ?? w.entry.entryPrice));
}
function pairMarkValue(s) {
  const held = s.windows.reduce((sum, w) => sum + windowMarkValue(w), 0);
  return round2(s.bankroll + held);
}
function pushGlobalEquity() {
  const total = round2(Object.values(pairs).reduce((sum, s) => sum + pairMarkValue(s), 0));
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > 500) totalEquityCurve.shift();
}
function recordEquity(s) {
  s.equityCurve.push({ t: Date.now(), equity: pairMarkValue(s) });
  if (s.equityCurve.length > 300) s.equityCurve.shift();
  pushGlobalEquity();
}
function registerTrade(s, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: s.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Hour transition — compute signal, build the whole hour's window tree
// ─────────────────────────────────────────
// Layer A: decides the whole hour's plan from the most recently closed 1h
// candle. No streak/reversal condition — always fires. Only commits
// s.hourStart on success, so a fetch failure retries every tick instead of
// silently sitting the hour out.
async function startNewHour(s, hourStart) {
  let color = null;
  try { color = await fetchLastClosedColor(s.symbol, '1h'); }
  catch (e) { log(`⚠️  ${s.symbol} 1h candle fetch failed: ${e.message}`); }

  if (!color) {
    if (!s.hourColorWarned) {
      s.hourColorWarned = true;
      log(`⚠️  ${s.symbol}: could not fetch closed 1h candle yet for hour ${new Date(hourStart * 1000).toISOString().slice(0, 13)}:00Z — retrying`);
    }
    return; // s.hourStart stays behind; we'll retry this same hour next tick
  }

  s.hourStart = hourStart;
  s.hourColor = color;
  s.hourColorWarned = false;
  s.hourlySlugWarned = false;

  const direction1h = SIDE_1H_BY_1H_COLOR[color];
  const sides15 = SIDES_15M_BY_1H_COLOR[color];
  s.direction1h = direction1h;

  log(`🕐 ${s.symbol} hour ${new Date(hourStart * 1000).toISOString().slice(0, 13)}:00Z — last closed 1h candle ${color.toUpperCase()} → 1h market ${direction1h} @+${Math.round(WATCH_1H_AFTER_SECS / 60)}m | 15m plan: ${sides15.join(', ')}`);

  const w1h = buildWindow(s.symbol, '1h', hourStart, direction1h);
  w1h.refColor = color;
  s.windows.push(w1h);

  for (let i = 0; i < 4; i++) {
    const ws15 = hourStart + i * TIMEFRAMES['15m'];
    const w15 = buildWindow(s.symbol, '15m', ws15, sides15[i]);
    w15.refColor = color;
    s.windows.push(w15);
  }
}

// Layer B: independent of Layer A. Right as each 15m block begins, fetch the
// 15m candle that JUST closed (the 15 minutes immediately before this block)
// and build that block's three 5m windows from ITS color — not from the
// side assigned to the parent 15m block. Retries every tick until it
// succeeds (no sitting out).
async function maybeBuildFiveMinWindows(s, w15) {
  if (w15.subBuilt) return;
  if (nowSec() < w15.windowStart) return;

  let color = null;
  try { color = await fetchLastClosedColor(s.symbol, '15m'); }
  catch (e) { log(`⚠️  ${s.symbol} 15m candle fetch failed: ${e.message}`); }

  if (!color) {
    if (!w15.subBuildWarned) {
      w15.subBuildWarned = true;
      log(`⚠️  ${s.symbol} 15m [${new Date(w15.windowStart * 1000).toISOString().slice(11, 16)}Z]: could not fetch closed 15m candle yet — retrying`);
    }
    return;
  }

  const sides5 = SIDES_5M_BY_15M_COLOR[color];
  log(`🕐 ${s.symbol} 15m block [${new Date(w15.windowStart * 1000).toISOString().slice(11, 16)}Z] — last closed 15m candle ${color.toUpperCase()} → 5m plan: ${sides5.join(', ')}`);

  for (let j = 0; j < 3; j++) {
    const ws5 = w15.windowStart + j * TIMEFRAMES['5m'];
    const w5 = buildWindow(s.symbol, '5m', ws5, sides5[j]);
    w5.refColor = color;
    s.windows.push(w5);
  }
  w15.subBuilt = true;
}

// ─────────────────────────────────────────
//  Entry — fixed 50 shares, fires once ask < ENTRY_THRESHOLD
// ─────────────────────────────────────────
async function maybeEnterWindow(s, w) {
  const tokenId = w.side === 'Up' ? w.upTokenId : w.downTokenId;
  const ask = tokenAskMap[tokenId];
  if (ask == null || ask >= ENTRY_THRESHOLD) return;

  const quotePrice = round2(Math.min(ask + QUOTE_BUFFER, 0.99));
  const shares = FIXED_SHARES;
  const notional = round2(quotePrice * shares);
  const fee = takerFee(shares, quotePrice);
  const totalCost = round2(notional + fee);

  if (totalCost > s.bankroll) {
    log(`⏭️  ${s.symbol} ${w.tf} [${w.id}]: skip entry — bankroll $${s.bankroll.toFixed(2)} < $${totalCost.toFixed(2)}`);
    w.entryDone = true;
    w.entrySkipped = true;
    return;
  }

  await placeEntryBuy(tokenId, quotePrice, shares);
  s.bankroll = round2(s.bankroll - totalCost);
  s.realizedPnl = round2(s.realizedPnl - fee);
  s.feesPaid = round2(s.feesPaid + fee);
  w.entryDone = true;
  w.entry = { side: w.side, entryPrice: quotePrice, shares, cost: totalCost };
  recordEquity(s);
  log(`🎯 ${s.symbol} ${w.tf} [${new Date(w.windowStart * 1000).toISOString().slice(11, 16)}Z] ${w.side} MARKET BUY ${shares}sh @ ${quotePrice.toFixed(2)} (ask ${ask.toFixed(2)} < ${ENTRY_THRESHOLD}) | cost=$${totalCost.toFixed(2)} | fee=-$${fee.toFixed(4)}`);
  registerTrade(s, { side: 'BUY', outcome: w.side, tf: w.tf, reason: 'ENTRY', price: quotePrice, shares, cost: totalCost, fee });
}

// ─────────────────────────────────────────
//  Resolution (dashboard bookkeeping only — real redemption is external)
// ─────────────────────────────────────────
async function determineWinningSideForWindow(w) {
  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(w.slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === w.conditionId) || (event.markets || [])[0];
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      let bestI = 0;
      for (let i = 1; i < prices.length; i++) if (parseFloat(prices[i]) > parseFloat(prices[bestI])) bestI = i;
      const winner = (outcomes[bestI] || '').trim();
      if (winner) return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
    }
  } catch (_) {}
  const upAsk = tokenAskMap[w.upTokenId], downAsk = tokenAskMap[w.downTokenId];
  if (upAsk != null && downAsk != null) return upAsk >= downAsk ? 'Up' : 'Down';
  return null;
}

async function resolveWindow(s, w) {
  w.resolved = true;
  w.resolvedAt = Date.now();
  if (!w.entryDone || !w.entry) return;

  const winner = await determineWinningSideForWindow(w);
  const won = winner === w.entry.side;
  const proceeds = won ? round2(w.entry.shares * 1) : 0;
  const profit = round2(proceeds - w.entry.cost);
  s.bankroll = round2(s.bankroll + proceeds);
  s.realizedPnl = round2(s.realizedPnl + profit);
  if (won) s.wins++; else s.losses++;
  w.won = won;

  const icon = won ? '💰' : '💥';
  log(`${icon} ${s.symbol} ${w.tf} [${new Date(w.windowStart * 1000).toISOString().slice(11, 16)}Z] ${w.entry.side} RESOLUTION ${w.entry.shares}sh entry=${w.entry.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'} | pnl=$${profit.toFixed(2)} | bankroll=$${s.bankroll.toFixed(2)}`);
  registerTrade(s, { side: 'SELL', outcome: w.entry.side, tf: w.tf, reason: 'RESOLUTION', price: won ? 1 : 0, shares: w.entry.shares, profit });
  recordEquity(s);
}

// ─────────────────────────────────────────
//  Main per-symbol tick
// ─────────────────────────────────────────
async function processSymbol(s) {
  const hourStart = windowStartFor('1h');
  if (s.hourStart !== hourStart) await startNewHour(s, hourStart);
  if (!tradingEnabled) return;

  // Layer B: build each 15m block's 5m children independently, right as
  // that block begins, from that block's own just-closed 15m candle.
  for (const w15 of s.windows) {
    if (w15.tf === '15m' && !w15.subBuilt) await maybeBuildFiveMinWindows(s, w15);
  }

  const t = nowSec();
  for (const w of s.windows) {
    if (w.resolved) continue;
    if (!w.loaded) { await tryLoadWindow(s, w); if (!w.loaded) continue; }

    if (!w.entryDone && t >= w.watchStart && t < w.windowEnd - EARLY_CUTOFF_SECS) {
      await maybeEnterWindow(s, w);
    }
    if (t >= w.windowEnd - EARLY_CUTOFF_SECS) {
      await resolveWindow(s, w);
    }
  }

  // prune old resolved windows so the list doesn't grow forever
  const cutoffMs = Date.now() - 15 * 60 * 1000;
  s.windows = s.windows.filter(w => !w.resolved || w.resolvedAt > cutoffMs);
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(s => {
    const markValue = pairMarkValue(s);
    return {
      symbol: s.symbol,
      bankroll: s.bankroll,
      realizedPnl: s.realizedPnl,
      unrealizedPnl: round2(markValue - s.bankroll),
      markValue,
      feesPaid: s.feesPaid,
      wins: s.wins, losses: s.losses,
      hourStart: s.hourStart,
      hourColor: s.hourColor,
      direction1h: s.direction1h,
      windows: s.windows.map(w => ({
        id: w.id, tf: w.tf, side: w.side,
        windowStart: w.windowStart, windowEnd: w.windowEnd,
        secsToEnd: Math.max(0, Math.floor(w.windowEnd - nowSec())),
        secsToStart: Math.max(0, Math.floor(w.windowStart - nowSec())),
        watchStart: w.watchStart,
        tradable: w.tradable, entryDone: w.entryDone, entrySkipped: w.entrySkipped,
        entry: w.entry, resolved: w.resolved, won: w.won,
        upAsk: w.upTokenId != null ? (tokenAskMap[w.upTokenId] ?? null) : null,
        downAsk: w.downTokenId != null ? (tokenAskMap[w.downTokenId] ?? null) : null,
      })),
      equityCurve: s.equityCurve,
    };
  });
  const totalBankroll = round2(pairStates.reduce((sum, p) => sum + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((sum, p) => sum + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((sum, p) => sum + p.realizedPnl, 0));
  const totalUnrealized = round2(pairStates.reduce((sum, p) => sum + p.unrealizedPnl, 0));
  const totalWins = pairStates.reduce((sum, p) => sum + p.wins, 0);
  const totalLosses = pairStates.reduce((sum, p) => sum + p.losses, 0);
  return {
    dryRun: DRY_RUN, tradingEnabled, pairs: pairList,
    totalCapital: TOTAL_CAPITAL, perPairCapital, totalBankroll, totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized, totalUnrealizedPnl: totalUnrealized, totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid: round2(pairStates.reduce((sum, p) => sum + p.feesPaid, 0)),
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      entryThreshold: ENTRY_THRESHOLD, fixedShares: FIXED_SHARES, quoteBuffer: QUOTE_BUFFER,
      watch1hAfterSecs: WATCH_1H_AFTER_SECS,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
    },
    pairStates, totalEquityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) { lastPolyPriceFetch = now; await refreshAllPrices(); }
      for (const s of Object.values(pairs)) { try { await processSymbol(s); } catch (e) { log(`⚠️  ${s.symbol} tick error: ${e.message}`); } }
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(list) {
  const clean = (list || []).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!clean.length) return { ok: false, error: 'Empty pair list' };
  pairList = [...new Set(clean)];
  resetPairs();
  log(`⚙️  Pairs updated: ${pairList.join(', ')} | $${perPairCapital.toFixed(2)} per pair (bookkeeping only — sizing is fixed at ${FIXED_SHARES} shares/entry)`);
  return { ok: true, pairs: pairList, perPairCapital };
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

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Decoupled 1h → 15m → 5m Candle-Color Playbook Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair bookkeeping bankroll`);
  log(`⚙️  Layer A: closed 1h candle RED → 15m blocks Up,Up,Down,Down (1h market Down). GREEN → Down,Down,Up,Up (1h market Up). Always fires, locked for the whole hour.`);
  log(`⚙️  Layer B: each 15m block's own just-closed 15m candle (independent of its assigned side) — RED → 5m Up,Down,Down. GREEN → 5m Down,Up,Up. Always fires.`);
  log(`⚙️  entries: fixed ${FIXED_SHARES} shares, market buy the FIRST time ask drops below ${ENTRY_THRESHOLD}, one-shot per window | 1h market only watched from +${Math.round(WATCH_1H_AFTER_SECS / 60)}min`);
  log(`⚙️  no TP/SL — rides to resolution, external claim script handles real redemption`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price/candle data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
