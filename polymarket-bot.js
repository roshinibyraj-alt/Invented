'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET 5-MINUTE CRYPTO UP/DOWN — MERGE ARBITRAGE BOT
 * ═══════════════════════════════════════════════════════════════
 *
 *  MARKETS: BTC / ETH / SOL "<asset>-updown-5m-<unixWindowStart>"
 *  events. Each event has one market, two outcomes ("Up"/"Down").
 *  Slug math: window_ts = now - (now % 300); slug = `${asset}-updown-5m-${window_ts}`.
 *
 *  ── STRATEGY: complementary-pair merge arbitrage, not directional ──
 *  Every Up token + Down token pair is a "complete set" that the
 *  Polymarket CTF contract will always let you convert into exactly
 *  $1 of collateral before resolution (mergePositions), regardless
 *  of what happens to the market price. So instead of betting on
 *  which side wins, this bot tries to acquire one Up share and one
 *  Down share for LESS than $1 combined, then merges them for a
 *  guaranteed, resolution-independent $1 — the loss/gain is locked
 *  in the moment both legs fill, not at window close.
 *
 *  PER PAIR, EVERY 10 SECONDS (while inside the trading window):
 *    1. Read live mid price on each side: mid = (bid+ask)/2.
 *    2. Only proceed if BOTH mids sit inside [0.25, 0.75] — this
 *       avoids one-sided/near-resolved books where there's no real
 *       edge left and fills are unlikely anyway.
 *    3. Place TWO resting (maker) limit BUY orders, 50 shares each:
 *         Up   limit price = round(upMid   - 0.04, 2)
 *         Down limit price = round(downMid - 0.04, 2)
 *       Neither crosses the spread, so neither is a taker order.
 *    4. Poll every 500ms for fills on both legs.
 *    5. At the 9-second mark (T+9s from cycle start), cancel
 *       whatever hasn't filled. The next cycle starts at T+10s
 *       regardless of how this one resolved — cycles are strictly
 *       sequential, never overlapping.
 *    6. Whenever the bot's running Up-share and Down-share inventory
 *       for a window becomes equal on both sides (could be same
 *       cycle, could be spread across several cycles), it merges the
 *       matched amount into pUSD immediately via mergePositions.
 *
 *  WINDOW GATING:
 *    - New cycles only start during the first 4 minutes (240s) of
 *      the 5-minute window — the last 60s are left clear of new risk.
 *    - After the 4-minute mark, any inventory that never found its
 *      match (couldn't be merged) gets a resting limit SELL at 0.99.
 *      If that doesn't fill before the window closes, it's simply
 *      let ride to Polymarket's own on-chain resolution (winning
 *      side redeems $1/share, losing side is worth $0).
 *
 *  MERGE MECHANICS (docs.polymarket.com/concepts/positions-tokens):
 *    Every Up/Down pair in existence is backed 1:1 by $1 of collateral
 *    locked in the Gnosis Conditional Token Framework (CTF) contract
 *    the moment it was split into being. mergePositions() burns 1 Up
 *    + 1 Down token from the caller and releases that $1 straight
 *    back — this is a contract guarantee, not a market trade, so it
 *    works at ANY price and needs no counterparty. It cannot be done
 *    after the market resolves (post-resolution you redeem the
 *    winning side instead). The only cost is Polygon gas (fractions
 *    of a cent) — Polymarket does not charge a trading fee on merges.
 *    That is exactly why this strategy works: paying < $1 combined
 *    for one Up + one Down share is a locked-in, resolution-agnostic
 *    profit the instant both legs are matched and merged.
 *
 *    In DRY_RUN this is pure bookkeeping (instant, as requested). In
 *    live mode this bot calls mergePositions() directly on the CTF
 *    contract the moment a match is found — not through the CLOB —
 *    so it isn't waiting on order-book depth or a counterparty, and
 *    fires within the same 500ms tick that created the match. It's
 *    routed through Polymarket's Builder Relayer (the same one
 *    trader.js already uses to derive the deposit wallet) so it
 *    executes as the wallet actually holding the tokens and stays
 *    gasless.
 *
 *  FEES & MAKER REBATES (Polymarket Fee Structure V2, crypto category
 *  — docs.polymarket.com/trading/fees, current as of March 30, 2026):
 *    fee = shares × feeRate × price × (1 - price)   [taker only]
 *    Crypto category taker fee rate: 0.07 (peaks at 1.75% per-contract
 *    fee-of-price at the p=0.50 midpoint, shrinks toward 0 near $0.01
 *    / $0.99). Makers ALWAYS pay $0 in fees, and additionally earn a
 *    rebate = fee-that-would-have-applied × 20% (crypto's maker rebate
 *    share; most other categories are 25%), credited at fill time.
 *    Every entry leg here is a genuine resting maker order (priced
 *    below the live mid, doesn't cross the book), so every fill is
 *    0 fee + rebate. The 0.99 leftover cleanup sell is also a resting
 *    maker order for the same reason. Only a market/taker order would
 *    ever pay the 0.07 fee — this bot never places one.
 *
 *  CAPITAL: $2000 demo capital split evenly across the configured
 *  pairs (BTC/ETH/SOL by default) into independent bankrolls, so one
 *  pair's exposure can't starve another's.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');
const { RelayClient } = require('@polymarket/builder-relayer-client');
const { encodeFunctionData } = require('viem');

// ── API endpoints ──
const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const BINANCE = 'https://api.binance.com';
const RELAYER_HOST = 'https://relayer-v2.polymarket.com';

// ── CTF contract (Polygon mainnet) — used for the direct on-chain merge ──
// docs.polymarket.com/developers/CTF/merge. Same addresses used by
// Polymarket's own example scripts and the official Go/relayer SDKs
// (cross-checked against the CTF contract's verified ABI on PolygonScan).
const CTF_CONTRACT    = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ZERO_BYTES32    = '0x' + '0'.repeat(64);
const CTF_MERGE_ABI = [{
  type: 'function', name: 'mergePositions', stateMutability: 'nonpayable',
  inputs: [
    { name: 'collateralToken', type: 'address' },
    { name: 'parentCollectionId', type: 'bytes32' },
    { name: 'conditionId', type: 'bytes32' },
    { name: 'partition', type: 'uint256[]' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [],
}];

// ── Timing ──
const TICK_MS                = 500;   // main loop AND fill-check cadence (per spec: check every 500ms)
const SPOT_REFRESH_MS        = 2000;  // Binance price poll (only used for display + resolution fallback now)
const POLY_PRICE_REFRESH_MS  = 500;   // CLOB up/down ask & bid poll — needs to be fast, fills are checked off this
const WINDOW_SECS            = 300;   // 5 minutes
const RESOLUTION_BUFFER_S    = 8;     // wait this long past window close before finalizing outcome
const SLUG_OFFSET_FALLBACKS  = [0, -300, 300]; // handle brief indexing lag around the boundary

// ── Env / config ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const DEFAULT_PAIRS = (process.env.CRYPTO_PAIRS || 'BTC,ETH,SOL')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// ── Strategy parameters (per user spec) ──
const CYCLE_INTERVAL_SEC     = Number(process.env.CYCLE_INTERVAL_SEC || 10);   // new cycle cadence
const CYCLE_CANCEL_OFFSET_SEC = Number(process.env.CYCLE_CANCEL_OFFSET_SEC || 9); // cancel unfilled leg at T+9s
const ORDER_SIZE_SHARES      = Number(process.env.ORDER_SIZE_SHARES || 50);    // fixed size, each leg, each cycle
const ENTRY_DISCOUNT         = Number(process.env.ENTRY_DISCOUNT || 0.04);     // limit = mid - 0.04
const PRICE_BAND_MIN         = Number(process.env.PRICE_BAND_MIN || 0.25);
const PRICE_BAND_MAX         = Number(process.env.PRICE_BAND_MAX || 0.75);
const TRADING_CUTOFF_SEC     = Number(process.env.TRADING_CUTOFF_SEC || 240);  // stop new cycles after 4 minutes
const LEFTOVER_SELL_PRICE    = Number(process.env.LEFTOVER_SELL_PRICE || 0.99);
const EQUITY_POINTS_PER_PAIR = Number(process.env.EQUITY_POINTS_PER_PAIR || 300);
const EQUITY_POINTS_TOTAL    = Number(process.env.EQUITY_POINTS_TOTAL || 500);

// ── Fees & maker rebates (Polymarket Fee Structure V2, crypto category) ──
// fee = shares × feeRate × price × (1-price). Only TAKER fills pay this;
// makers always pay zero. Crypto: taker fee rate 0.07, maker rebate 20%
// of the fee value the maker's filled liquidity generated. Every order
// this bot places is a resting maker order, so in practice this bot only
// ever earns rebates and never pays this fee — the constant is kept and
// applied generically so the accounting is correct if that ever changes.
const CRYPTO_TAKER_FEE_RATE     = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);
const CRYPTO_MAKER_REBATE_SHARE = Number(process.env.CRYPTO_MAKER_REBATE_SHARE || 0.20);

const BINANCE_SYMBOL = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT',
  DOGE: 'DOGEUSDT', BNB: 'BNBUSDT', LTC: 'LTCUSDT', ADA: 'ADAUSDT',
  AVAX: 'AVAXUSDT', LINK: 'LINKUSDT', MATIC: 'MATICUSDT', POL: 'POLUSDT',
};

// ── State ──
let emitFn   = () => {};
let slog     = () => {};
let trader   = null;
let relayClient = null; // built in init(), used only for the on-chain mergePositions call
let startTime = Date.now();
let logs     = [];
let trades   = [];
let tradingEnabled = true;
let pairList = [...DEFAULT_PAIRS];
let perPairCapital = TOTAL_CAPITAL / Math.max(pairList.length, 1);
let pairs = {}; // symbol -> pair state
let lastSpotFetch = 0;
let lastPolyPriceFetch = 0;
let totalEquityCurve = [];

// ─────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }
function nowSec() { return Date.now() / 1000; }

// ─────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-merge-arb-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-merge-arb-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Pair state
// ─────────────────────────────────────────
function freshPairState(symbol) {
  return {
    symbol,
    binanceSymbol: BINANCE_SYMBOL[symbol] || `${symbol}USDT`,
    tradable: false,
    windowStart: null,
    windowEnd: null,
    slug: null,
    eventTitle: null,
    conditionId: null,
    upTokenId: null,
    downTokenId: null,
    openSpot: null,
    spotBuffer: [],
    upAsk: null, upBid: null, downAsk: null, downBid: null,

    bankroll: perPairCapital,
    realizedPnl: 0,
    feesPaid: 0,
    rebatesEarned: 0,
    wins: 0, losses: 0,
    lastResult: null,

    // cycle bookkeeping (this window)
    lastCycleIndex: -1,
    cycle: null,          // { idx, startedAt, cancelAt, up:{orderId,price,shares,filled}, down:{...} }
    cyclesRun: 0, cyclesFilledBoth: 0, cyclesFilledOne: 0, cyclesFilledNone: 0,

    // unmerged inventory (this window)
    upShares: 0, downShares: 0, upCostSum: 0, downCostSum: 0,
    mergedPairsTotal: 0, mergedProfitTotal: 0,

    // post-cutoff cleanup
    sellOrder: null,       // { side, tokenId, price, shares, orderId, placedAt }

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
    } catch (_) { /* not indexed yet — try next offset */ }
  }
  return null;
}

async function loadPairWindow(p) {
  const ws = currentWindowStart();
  if (p.windowStart === ws && p.upTokenId) return;

  const found = await fetchEventForWindow(p.symbol, ws);
  if (!found) { p.tradable = false; return; }
  const { event, windowStart, slug } = found;
  const market = event.markets.find(m => {
    const q = qOf(m);
    return q.includes('up') || q.includes('down');
  }) || event.markets[0];

  const upId = tokenIdForSide(market, 'up');
  const downId = tokenIdForSide(market, 'down');
  if (!upId || !downId) {
    log(`⚠️  ${p.symbol}: window loaded but Up/Down token ids missing — outcomes=${market.outcomes}`);
    p.tradable = false;
    return;
  }

  const isNewWindow = p.windowStart !== windowStart;

  p.windowStart = windowStart;
  p.windowEnd = windowStart + WINDOW_SECS;
  p.slug = slug;
  p.eventTitle = event.title || event.slug;
  p.conditionId = market.conditionId || null;
  p.upTokenId = upId;
  p.downTokenId = downId;
  p.tradable = true;

  if (isNewWindow) {
    p.resolvedThisWindow = false;
    p.spotBuffer = [];
    p.openSpot = null;

    // fresh per-window cycle/inventory state
    p.lastCycleIndex = -1;
    p.cycle = null;
    p.cyclesRun = 0; p.cyclesFilledBoth = 0; p.cyclesFilledOne = 0; p.cyclesFilledNone = 0;
    p.upShares = 0; p.downShares = 0; p.upCostSum = 0; p.downCostSum = 0;
    p.mergedPairsTotal = 0; p.mergedProfitTotal = 0;
    p.sellOrder = null;

    log(`🔭 ${p.symbol} window loaded: ${slug} | ends ${new Date(p.windowEnd * 1000).toISOString().slice(11, 19)}Z`);
  }
}

// ─────────────────────────────────────────
//  Spot price feed (display + resolution fallback only — no longer drives entries)
// ─────────────────────────────────────────
async function refreshSpotPrices() {
  const symbols = [...new Set(Object.values(pairs).map(p => p.binanceSymbol))];
  if (!symbols.length) return;
  try {
    const qs = encodeURIComponent(JSON.stringify(symbols));
    const data = await getJSON(`${BINANCE}/api/v3/ticker/price?symbols=${qs}`);
    const now = Date.now();
    const bySymbol = {};
    for (const row of data) bySymbol[row.symbol] = parseFloat(row.price);
    for (const p of Object.values(pairs)) {
      const price = bySymbol[p.binanceSymbol];
      if (!price || !Number.isFinite(price)) continue;
      p.spotBuffer.push({ t: now, price });
      const cutoff = now - 90_000;
      while (p.spotBuffer.length && p.spotBuffer[0].t < cutoff) p.spotBuffer.shift();
      if (p.openSpot === null && p.windowStart !== null) p.openSpot = price;
    }
  } catch (e) {
    log(`⚠️  Spot price refresh failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────
//  Polymarket CLOB price feed (Up/Down ask+bid — drives cycle pricing & fills)
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
      } catch (_) { /* leave stale values, try again next tick */ }
    }
  }

  function applyPolyPrice(tid, side, price) {
    if (!Number.isFinite(price)) return;
    for (const p of Object.values(pairs)) {
      if (p.upTokenId === tid) {
        if (side === 'BUY') p.upAsk = price; else if (side === 'SELL') p.upBid = price;
      } else if (p.downTokenId === tid) {
        if (side === 'BUY') p.downAsk = price; else if (side === 'SELL') p.downBid = price;
      }
    }
  }
}

// ─────────────────────────────────────────
//  Order helpers (real trader calls, gated by DRY_RUN)
// ─────────────────────────────────────────
// placeGtcOrder rests a real maker limit order (Good-Til-Cancelled) — this
// is trader.js's actual method name/signature (tokenId, 'BUY'|'SELL', price, size).
async function placeLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.placeGtcOrder(tokenId, 'BUY', price, shares);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function placeLimitSell(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.placeGtcOrder(tokenId, 'SELL', price, shares);
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function cancelOrder(orderId) {
  if (!DRY_RUN && trader && orderId) {
    try { await trader.cancelOrder(orderId); }
    catch (e) { log(`⚠️  cancel failed: ${e.message}`); }
  }
}

// ─────────────────────────────────────────
//  On-chain merge — CTF mergePositions(), called directly (not via the CLOB)
//  so it works immediately regardless of order-book depth. Routed through
//  Polymarket's Builder Relayer (same one trader.js already uses to derive
//  the deposit wallet) so it executes as the wallet that actually holds the
//  position tokens, and stays gasless. This never touches polymarket-trader.js.
// ─────────────────────────────────────────
async function performMerge(p, shares) {
  if (DRY_RUN || !trader) return; // dry run: merge is instant bookkeeping only, already handled by the caller
  if (!relayClient) { log(`⚠️  ${p.symbol}: relay client not ready — merge deferred, will retry next tick`); throw new Error('relay not ready'); }
  if (!p.conditionId) { log(`⚠️  ${p.symbol}: missing conditionId — cannot merge, will retry next tick`); throw new Error('no conditionId'); }

  const amount = BigInt(Math.round(shares * 1_000_000)); // USDC.e has 6 decimals; CTF outcome-token units mirror the collateral
  const data = encodeFunctionData({
    abi: CTF_MERGE_ABI,
    functionName: 'mergePositions',
    args: [USDC_E_CONTRACT, ZERO_BYTES32, p.conditionId, [1n, 2n], amount],
  });

  try {
    const response = await relayClient.execute([{ to: CTF_CONTRACT, data, value: '0' }], `Merge ${shares}sh ${p.symbol}`);
    const result = await response.wait();
    if (!result) throw new Error('relay execute() returned no result');
    log(`⛓️  ${p.symbol}: on-chain merge tx confirmed${result.transactionHash ? ' (' + result.transactionHash.slice(0, 12) + '…)' : ''}`);
  } catch (e) {
    log(`⚠️  ${p.symbol}: on-chain merge failed: ${e.message} — inventory still tracked, will retry, and will fall back to 0.99 sell / resolution if it never clears. NOTE: trader.js derives a "deposit wallet" (the newer Polymarket wallet flow) — if this keeps failing, the deposit-wallet flow may need its own dedicated relayer method instead of the standard execute() used here; test with a small amount first.`);
    throw e;
  }
}

// ─────────────────────────────────────────
//  Fees & maker rebates
// ─────────────────────────────────────────
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function pairMarkValue(p) {
  const upMark = p.upShares * (p.upBid ?? (p.upShares > 0 ? (p.upCostSum / p.upShares) : 0));
  const downMark = p.downShares * (p.downBid ?? (p.downShares > 0 ? (p.downCostSum / p.downShares) : 0));
  return round2(p.bankroll + upMark + downMark);
}
function pushGlobalEquity() {
  const total = round2(Object.values(pairs).reduce((s, p) => s + pairMarkValue(p), 0));
  totalEquityCurve.push({ t: Date.now(), equity: total });
  if (totalEquityCurve.length > EQUITY_POINTS_TOTAL) totalEquityCurve.shift();
}
function recordEquity(p) {
  p.equityCurve.push({ t: Date.now(), equity: pairMarkValue(p) });
  if (p.equityCurve.length > EQUITY_POINTS_PER_PAIR) p.equityCurve.shift();
  pushGlobalEquity();
}

function registerTrade(p, entry) {
  const rec = { time: new Date().toISOString().slice(11, 19), symbol: p.symbol, ...entry };
  trades.push(rec);
  if (trades.length > 300) trades.shift();
}

// ─────────────────────────────────────────
//  Cycle engine — 2 resting maker orders every 10s, cancel stragglers at 9s
// ─────────────────────────────────────────
function midOf(bid, ask) {
  if (bid == null || ask == null) return null;
  return (bid + ask) / 2;
}

async function maybeStartCycle(p, elapsed) {
  if (!tradingEnabled) return;
  if (p.cycle) return; // strictly sequential — never overlap cycles
  if (elapsed >= TRADING_CUTOFF_SEC) return; // only trade through minute 4

  const idx = Math.floor(elapsed / CYCLE_INTERVAL_SEC);
  if (idx <= p.lastCycleIndex) return;
  p.lastCycleIndex = idx;

  const upMid = midOf(p.upBid, p.upAsk);
  const downMid = midOf(p.downBid, p.downAsk);
  if (upMid == null || downMid == null) return; // no book yet, skip this slot

  if (upMid < PRICE_BAND_MIN || upMid > PRICE_BAND_MAX || downMid < PRICE_BAND_MIN || downMid > PRICE_BAND_MAX) {
    return; // outside the 0.25–0.75 band — sit this cycle out
  }

  const upPrice = clamp(round2(upMid - ENTRY_DISCOUNT), 0.01, 0.99);
  const downPrice = clamp(round2(downMid - ENTRY_DISCOUNT), 0.01, 0.99);
  const neededCash = round2(ORDER_SIZE_SHARES * upPrice + ORDER_SIZE_SHARES * downPrice);
  if (neededCash > p.bankroll) {
    log(`⏭️  ${p.symbol}: skip cycle #${idx} — insufficient bankroll ($${p.bankroll.toFixed(2)} left, need ~$${neededCash.toFixed(2)})`);
    return;
  }

  const [upOrder, downOrder] = await Promise.all([
    placeLimitBuy(p.upTokenId, upPrice, ORDER_SIZE_SHARES),
    placeLimitBuy(p.downTokenId, downPrice, ORDER_SIZE_SHARES),
  ]);

  const now = Date.now();
  p.cycle = {
    idx,
    startedAt: now,
    cancelAt: now + CYCLE_CANCEL_OFFSET_SEC * 1000,
    up: { orderId: upOrder.id || upOrder.orderId || null, price: upPrice, shares: ORDER_SIZE_SHARES, filled: false },
    down: { orderId: downOrder.id || downOrder.orderId || null, price: downPrice, shares: ORDER_SIZE_SHARES, filled: false },
  };
  p.cyclesRun++;
  log(`📌 ${p.symbol} cycle #${idx}: Up@${upPrice.toFixed(2)} (mid ${upMid.toFixed(2)}) + Down@${downPrice.toFixed(2)} (mid ${downMid.toFixed(2)}) × ${ORDER_SIZE_SHARES}sh each — cancel unfilled @ T+${CYCLE_CANCEL_OFFSET_SEC}s`);
}

function fillLeg(p, side, leg) {
  leg.filled = true;
  const notional = round2(leg.price * leg.shares);
  const rebate = makerRebate(leg.shares, leg.price);
  p.bankroll = round2(p.bankroll - notional + rebate);
  p.realizedPnl = round2(p.realizedPnl + rebate);
  p.rebatesEarned = round2(p.rebatesEarned + rebate);

  if (side === 'Up') {
    p.upShares = round2(p.upShares + leg.shares);
    p.upCostSum = round2(p.upCostSum + notional);
  } else {
    p.downShares = round2(p.downShares + leg.shares);
    p.downCostSum = round2(p.downCostSum + notional);
  }

  log(`🎯 ${p.symbol} FILLED(maker) ${side} ${leg.shares}sh @ ${leg.price.toFixed(2)} | cost=$${notional.toFixed(2)} | rebate=+$${rebate.toFixed(4)}`);
  registerTrade(p, { side: 'BUY', outcome: side, reason: 'CYCLE_FILL', price: leg.price, shares: leg.shares, cost: notional, rebate });
}

async function tryMerge(p) {
  const mergeable = round2(Math.min(p.upShares, p.downShares));
  if (mergeable <= 0) return;

  const avgUpCost = p.upShares > 0 ? p.upCostSum / p.upShares : 0;
  const avgDownCost = p.downShares > 0 ? p.downCostSum / p.downShares : 0;
  const cost = round2(mergeable * (avgUpCost + avgDownCost));
  const proceeds = round2(mergeable * 1.0);

  try {
    await performMerge(p, mergeable);
  } catch (_) {
    return; // merge failed live — leave inventory intact, try again next tick
  }

  p.upShares = round2(p.upShares - mergeable);
  p.downShares = round2(p.downShares - mergeable);
  p.upCostSum = round2(p.upCostSum - mergeable * avgUpCost);
  p.downCostSum = round2(p.downCostSum - mergeable * avgDownCost);

  const profit = round2(proceeds - cost);
  p.bankroll = round2(p.bankroll + proceeds);
  p.realizedPnl = round2(p.realizedPnl + profit);
  p.mergedPairsTotal = round2(p.mergedPairsTotal + mergeable);
  p.mergedProfitTotal = round2(p.mergedProfitTotal + profit);

  const icon = profit >= 0 ? '💰' : '💥';
  log(`${icon} ${p.symbol} MERGE ${mergeable}sh Up+Down → $${proceeds.toFixed(2)} pUSD | cost=$${cost.toFixed(2)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'MERGE', outcome: 'Up+Down', reason: 'MERGE', price: 1.00, shares: mergeable, cost, profit });
  recordEquity(p);
}

async function checkCycle(p) {
  const c = p.cycle;
  if (!c) return;

  if (!c.up.filled && p.upAsk != null && p.upAsk <= c.up.price) fillLeg(p, 'Up', c.up);
  if (!c.down.filled && p.downAsk != null && p.downAsk <= c.down.price) fillLeg(p, 'Down', c.down);
  if (c.up.filled || c.down.filled) await tryMerge(p);

  if (Date.now() >= c.cancelAt) {
    if (!c.up.filled) { await cancelOrder(c.up.orderId); log(`⏭️  ${p.symbol} cycle #${c.idx}: Up leg unfilled @ ${c.up.price.toFixed(2)} — cancelled`); }
    if (!c.down.filled) { await cancelOrder(c.down.orderId); log(`⏭️  ${p.symbol} cycle #${c.idx}: Down leg unfilled @ ${c.down.price.toFixed(2)} — cancelled`); }

    if (c.up.filled && c.down.filled) p.cyclesFilledBoth++;
    else if (c.up.filled || c.down.filled) p.cyclesFilledOne++;
    else p.cyclesFilledNone++;

    p.cycle = null;
    recordEquity(p);
  }
}

// ─────────────────────────────────────────
//  Post-cutoff cleanup — sell any unmatched leftover at 0.99, else resolve
// ─────────────────────────────────────────
async function manageLeftover(p) {
  if (p.cycle) return; // let the in-flight cycle finish/cancel first

  const side = p.upShares > 0 ? 'Up' : (p.downShares > 0 ? 'Down' : null);
  if (!side) return;

  if (p.sellOrder) {
    const bid = p.sellOrder.side === 'Up' ? p.upBid : p.downBid;
    if (bid != null && bid >= p.sellOrder.price) {
      const shares = p.sellOrder.shares;
      const proceeds = round2(p.sellOrder.price * shares);
      const rebate = makerRebate(shares, p.sellOrder.price);
      const costSum = p.sellOrder.side === 'Up' ? p.upCostSum : p.downCostSum;
      const profit = round2(proceeds + rebate - costSum);

      p.bankroll = round2(p.bankroll + proceeds + rebate);
      p.realizedPnl = round2(p.realizedPnl + profit);
      p.rebatesEarned = round2(p.rebatesEarned + rebate);
      if (p.sellOrder.side === 'Up') { p.upShares = 0; p.upCostSum = 0; } else { p.downShares = 0; p.downCostSum = 0; }
      if (profit >= 0) { p.wins++; p.lastResult = 'WIN'; } else { p.losses++; p.lastResult = 'LOSS'; }

      const icon = profit >= 0 ? '💰' : '💥';
      log(`${icon} ${p.symbol} LEFTOVER SELL(maker) ${p.sellOrder.side} ${shares}sh @ ${p.sellOrder.price.toFixed(2)} | rebate=+$${rebate.toFixed(4)} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
      registerTrade(p, { side: 'SELL', outcome: p.sellOrder.side, reason: 'LEFTOVER_SELL', price: p.sellOrder.price, shares, profit, rebate });
      p.sellOrder = null;
      recordEquity(p);
    }
    return;
  }

  const tokenId = side === 'Up' ? p.upTokenId : p.downTokenId;
  const shares = side === 'Up' ? p.upShares : p.downShares;
  const order = await placeLimitSell(tokenId, LEFTOVER_SELL_PRICE, shares);
  p.sellOrder = { side, tokenId, price: LEFTOVER_SELL_PRICE, shares, orderId: order.id || order.orderId || null, placedAt: Date.now() };
  log(`📌 ${p.symbol}: past minute 4 with ${shares}sh unmatched ${side} — resting cleanup sell @ ${LEFTOVER_SELL_PRICE.toFixed(2)}`);
}

// ─────────────────────────────────────────
//  Resolution — winning side redeemed at $1/share, losing side at $0
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
  } catch (_) { /* fall through to heuristic */ }

  const lastSpot = p.spotBuffer.length ? p.spotBuffer[p.spotBuffer.length - 1].price : null;
  if (lastSpot === null || p.openSpot === null) return null;
  return lastSpot >= p.openSpot ? 'Up' : 'Down';
}

async function resolvePairWindow(p) {
  if (p.resolvedThisWindow) return;
  p.resolvedThisWindow = true;

  if (p.cycle) {
    if (!p.cycle.up.filled) await cancelOrder(p.cycle.up.orderId);
    if (!p.cycle.down.filled) await cancelOrder(p.cycle.down.orderId);
    p.cycle = null;
  }
  if (p.sellOrder) { await cancelOrder(p.sellOrder.orderId); p.sellOrder = null; }

  if (p.upShares <= 0 && p.downShares <= 0) return; // everything already merged / sold off

  const winner = await determineWinningSide(p);
  if (winner === null) {
    log(`⚠️  ${p.symbol}: could not determine window outcome — leaving remaining inventory tracked at last mark`);
    return;
  }

  const side = p.upShares > 0 ? 'Up' : 'Down';
  const shares = side === 'Up' ? p.upShares : p.downShares;
  const costSum = side === 'Up' ? p.upCostSum : p.downCostSum;
  const won = winner === side;
  const proceeds = won ? round2(shares * 1) : 0;
  const profit = round2(proceeds - costSum);

  p.bankroll = round2(p.bankroll + proceeds);
  p.realizedPnl = round2(p.realizedPnl + profit);
  if (won) { p.wins++; p.lastResult = 'WIN'; } else { p.losses++; p.lastResult = 'LOSS'; }

  const icon = won ? '💰' : '💥';
  log(`${icon} ${p.symbol} RESOLUTION ${side} ${shares}sh → ${won ? '$1.00/sh' : '$0.00/sh'} | pnl=$${profit.toFixed(2)} | bankroll=$${p.bankroll.toFixed(2)}`);
  registerTrade(p, { side: 'RESOLVE', outcome: side, reason: 'RESOLUTION', price: won ? 1 : 0, shares, profit });

  p.upShares = 0; p.downShares = 0; p.upCostSum = 0; p.downCostSum = 0;
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

  const elapsed = nowSec() - p.windowStart;
  const remaining = p.windowEnd - nowSec();

  await checkCycle(p);
  if (elapsed < TRADING_CUTOFF_SEC) {
    await maybeStartCycle(p, elapsed);
  } else {
    await manageLeftover(p);
  }

  if (remaining <= -RESOLUTION_BUFFER_S && !p.resolvedThisWindow) {
    await resolvePairWindow(p);
  }
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildState() {
  const pairStates = Object.values(pairs).map(p => {
    const spot = p.spotBuffer.length ? p.spotBuffer[p.spotBuffer.length - 1].price : null;
    const markValue = pairMarkValue(p);
    const unrealized = round2(markValue - p.bankroll
      - 0); // inventory mark minus its own cost is implicit in markValue vs bankroll; kept simple/consistent with equity curve

    return {
      symbol: p.symbol,
      tradable: p.tradable,
      slug: p.slug,
      windowEnd: p.windowEnd,
      secsToEnd: p.windowEnd ? Math.max(0, Math.floor(p.windowEnd - nowSec())) : null,
      secsToCutoff: (p.windowStart != null) ? Math.max(0, Math.floor(TRADING_CUTOFF_SEC - (nowSec() - p.windowStart))) : null,
      openSpot: p.openSpot,
      spot,
      upAsk: p.upAsk, upBid: p.upBid, downAsk: p.downAsk, downBid: p.downBid,
      bankroll: p.bankroll,
      realizedPnl: p.realizedPnl,
      markValue,
      feesPaid: p.feesPaid,
      rebatesEarned: p.rebatesEarned,
      wins: p.wins,
      losses: p.losses,
      lastResult: p.lastResult,
      cyclesRun: p.cyclesRun,
      cyclesFilledBoth: p.cyclesFilledBoth,
      cyclesFilledOne: p.cyclesFilledOne,
      cyclesFilledNone: p.cyclesFilledNone,
      upShares: p.upShares, downShares: p.downShares,
      mergedPairsTotal: p.mergedPairsTotal, mergedProfitTotal: p.mergedProfitTotal,
      cycle: p.cycle ? {
        idx: p.cycle.idx,
        upPrice: p.cycle.up.price, upFilled: p.cycle.up.filled,
        downPrice: p.cycle.down.price, downFilled: p.cycle.down.filled,
        secsToCancel: Math.max(0, Math.round((p.cycle.cancelAt - Date.now()) / 1000)),
      } : null,
      sellOrder: p.sellOrder ? { side: p.sellOrder.side, price: p.sellOrder.price, shares: p.sellOrder.shares } : null,
      equityCurve: p.equityCurve,
    };
  });

  const totalBankroll = round2(pairStates.reduce((s, p) => s + p.bankroll, 0));
  const totalMark = round2(pairStates.reduce((s, p) => s + p.markValue, 0));
  const totalRealized = round2(pairStates.reduce((s, p) => s + p.realizedPnl, 0));
  const totalWins = pairStates.reduce((s, p) => s + p.wins, 0);
  const totalLosses = pairStates.reduce((s, p) => s + p.losses, 0);
  const totalFeesPaid = round2(pairStates.reduce((s, p) => s + p.feesPaid, 0));
  const totalRebatesEarned = round2(pairStates.reduce((s, p) => s + p.rebatesEarned, 0));
  const totalMergedPairs = round2(pairStates.reduce((s, p) => s + p.mergedPairsTotal, 0));
  const totalMergedProfit = round2(pairStates.reduce((s, p) => s + p.mergedProfitTotal, 0));

  return {
    dryRun: DRY_RUN,
    tradingEnabled,
    pairs: pairList,
    totalCapital: TOTAL_CAPITAL,
    perPairCapital,
    totalBankroll,
    totalMarkValue: totalMark,
    totalRealizedPnl: totalRealized,
    totalUnrealizedPnl: round2(totalMark - totalBankroll - totalRealized + totalRealized), // markValue already includes unrealized; kept for compatibility
    totalPnl: round2(totalMark - TOTAL_CAPITAL),
    totalWins, totalLosses,
    totalFeesPaid,
    totalRebatesEarned,
    totalMergedPairs,
    totalMergedProfit,
    winRate: (totalWins + totalLosses) > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      cycleIntervalSec: CYCLE_INTERVAL_SEC,
      cycleCancelOffsetSec: CYCLE_CANCEL_OFFSET_SEC,
      orderSizeShares: ORDER_SIZE_SHARES,
      entryDiscount: ENTRY_DISCOUNT,
      priceBandMin: PRICE_BAND_MIN,
      priceBandMax: PRICE_BAND_MAX,
      tradingCutoffSec: TRADING_CUTOFF_SEC,
      leftoverSellPrice: LEFTOVER_SELL_PRICE,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
      cryptoMakerRebateShare: CRYPTO_MAKER_REBATE_SHARE,
    },
    pairStates,
    totalEquityCurve,
    logs: logs.slice(-100),
    trades: trades.slice(-80).reverse(),
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
      if (now - lastSpotFetch >= SPOT_REFRESH_MS) {
        lastSpotFetch = now;
        await refreshSpotPrices();
      }
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
//  Public controls (dashboard)
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
  log('⏸️  Trading paused (existing cycles/merges/leftover-sells/resolution still managed)');
  return { ok: true };
}
function resumeTrading() {
  tradingEnabled = true;
  log('▶️  Trading resumed');
  return { ok: true };
}

function getStatus() {
  return { ok: true, ...buildState() };
}

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 5-Minute Crypto Up/Down MERGE ARBITRAGE Bot`);
  log(`⚙️  $${TOTAL_CAPITAL} demo capital across ${pairList.length} pairs (${pairList.join(', ')}) → $${perPairCapital.toFixed(2)}/pair`);
  log(`⚙️  every ${CYCLE_INTERVAL_SEC}s: 2× ${ORDER_SIZE_SHARES}sh maker limit buys at mid-${ENTRY_DISCOUNT.toFixed(2)} on Up & Down | cancel unfilled @ T+${CYCLE_CANCEL_OFFSET_SEC}s | band [${PRICE_BAND_MIN},${PRICE_BAND_MAX}] | trade only through minute ${(TRADING_CUTOFF_SEC/60).toFixed(0)} of 5`);
  log(`⚙️  merge matched Up+Down shares → $1 pUSD instantly (fee-free, gas only) | leftover past cutoff → limit sell @ ${LEFTOVER_SELL_PRICE} or resolution`);
  log(`⚙️  fees: all entries & cleanup sells are resting maker orders → $0 fee + rebate (crypto ${(CRYPTO_MAKER_REBATE_SHARE*100).toFixed(0)}% of taker-fee-rate ${CRYPTO_TAKER_FEE_RATE})`);
  log(`${DRY_RUN ? '⚠️  DRY RUN — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  if (!DRY_RUN) {
    try {
      // Reuses the exact same authenticated viem wallet client trader.js
      // already built (and already proved works, since it signed the auth
      // flow) — same construction pattern trader.js uses internally to
      // derive the deposit wallet. This never modifies polymarket-trader.js.
      relayClient = new RelayClient(RELAYER_HOST, 137, trader._walletClient);
      log(`⛓️  Relay client ready for on-chain merges (wallet: ${trader.depositWallet || trader.address})`);
    } catch (e) {
      log(`⚠️  Could not init relay client — merges will fail live until this is fixed: ${e.message}`);
    }
  }

  await refreshSpotPrices();
  lastSpotFetch = Date.now();

  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
