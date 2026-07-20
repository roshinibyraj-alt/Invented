'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET CROSS-PAIR COMBO BOT — BTC/ETH UP/DOWN, 5m + 15m
 * ═══════════════════════════════════════════════════════════════
 *
 *  Trades BTC and ETH Up/Down markets together as paired combos, run
 *  as TWO fully independent window instances — a 5-minute instance
 *  and a 15-minute instance — both pulling from the same shared
 *  bankroll, never interacting with each other otherwise.
 *
 *  COMBOS (per instance, each tracked independently):
 *    Combo A = BTC-Up  ask + ETH-Down ask
 *    Combo B = BTC-Down ask + ETH-Up  ask
 *
 *  TRIGGER (per combo, once per window, no repeat if missed):
 *    Watch the combined ask price from window start. If it drops below
 *    0.80 at any point before the cutoff, fire the combo:
 *      - 5m instance:  cutoff = 3.5 min  (210s of 300s window)
 *      - 15m instance: cutoff = 10.5 min (630s of 900s window)
 *    Cutoff is a fixed 70% of window length for both instances.
 *    If the cutoff passes without the combo dropping below 0.80, that
 *    combo simply does not trade this window.
 *
 *  EXECUTION: once a combo fires, BOTH legs are bought immediately as
 *    marketable buys at the current ask (taker fee applies) — not
 *    resting limit orders — so both legs land together rather than
 *    risking a one-sided fill. Affordability (bankroll) is checked for
 *    the combined cost of both legs before either leg is sent.
 *    Size: 20 shares per leg, on both timeframes (real-trading sizing).
 *
 *  EXIT: none. No TP, no SL. Both legs simply ride to actual window
 *    resolution (real settlement pays $1 or $0/share). This bot's own
 *    bookkeeping simulates that via the public Gamma API purely to
 *    keep the dashboard's P&L figures meaningful. A separate,
 *    independent auto-claim script handles real redemption.
 *
 *  LIVE / DEMO: DRY_RUN is runtime-switchable (see setMode) — dashboard
 *    has a one-click toggle plus an independent pause button.
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com'; // public, no-auth — real wallet balance/positions

const TICK_MS               = 500;
const POLY_PRICE_REFRESH_MS = 1000;
const REAL_ACCOUNT_REFRESH_MS = 5000; // how often to pull real balance/positions in live mode
const EARLY_CUTOFF_SECS     = Number(process.env.EARLY_CUTOFF_SECS || 2); // stop trading this close to window end, go to resolution
const SLUG_OFFSET_FALLBACKS_FACTORY = (windowSecs) => [0, -windowSecs, windowSecs];

const SYMBOLS = ['BTC', 'ETH'];
const INSTANCE_DEFS = [
  { key: '5m',  windowSecs: 300 },
  { key: '15m', windowSecs: 900 },
];

// DRY_RUN defaults to true (demo) unless explicitly overridden. Flip via
// setMode(true) / the dashboard toggle, or set DRY_RUN=false in the env.
let DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

// ── Strategy parameters ──
const COMBO_THRESHOLD        = Number(process.env.COMBO_THRESHOLD || 0.80);
const COMBO_TRIGGER_FRACTION = Number(process.env.COMBO_TRIGGER_FRACTION || 0.70); // cutoff as fraction of window length
const COMBO_SHARES           = Number(process.env.COMBO_SHARES || 10); // per leg, base size, both timeframes

// ── Decorrelation follow-through boost: at the last-second check before
// resolution, classify a fired combo by its legs' live prices. Both legs
// trending to ~1 (both about to win) means the REALIZED pairing matches this
// SAME combo. Both legs trending to ~0 (both about to lose) means the
// REALIZED pairing was actually the OPPOSITE combo. Whichever matches gets
// queued and bought unconditionally — both legs, DECORRELATION_BOOST_SHARES
// each, no threshold check — the instant the NEXT window opens. One-shot,
// then clears. Tracked independently per instance (5m vs 15m). ──
const DECORRELATION_BOOST_SHARES = Number(process.env.DECORRELATION_BOOST_SHARES || 50); // per leg, one-shot follow-through buy

const CRYPTO_TAKER_FEE_RATE = Number(process.env.CRYPTO_TAKER_FEE_RATE || 0.07);

// ── Take-profit: each leg gets its own resting TP order at TP_MULTIPLIER
// of its own entry price, capped at TP_MAX_PRICE (binary shares can't
// realistically rest above this). Live mode places a real GTC sell order;
// demo mode simulates the same exit by watching the live bid feed. ──
const TP_MULTIPLIER = Number(process.env.TP_MULTIPLIER || 1.60);
const TP_MAX_PRICE  = Number(process.env.TP_MAX_PRICE || 0.99);

let emitFn = () => {};
let slog = () => {};
let trader = null;
let startTime = Date.now();
let logs = [];
let trades = [];
let tradingEnabled = true;
let bankroll = TOTAL_CAPITAL;
let realizedPnl = 0, feesPaid = 0, wins = 0, losses = 0;
let equityCurve = [{ t: Date.now(), equity: TOTAL_CAPITAL }];

// ── Real account state (live mode only) — actual wallet balance/positions
// pulled from Polymarket itself, independent of the bot's internal simulated
// bankroll/position bookkeeping used above for trade decisions. ──
let realBalance = null;
let realPositions = [];
let realLastUpdated = null;
let realFetchError = null;
let warnedNoDepositWallet = false;

// Combo leg definitions: which symbol/side belongs to each combo.
const COMBO_LEGS = {
  A: [ { symbol: 'BTC', side: 'Up' },   { symbol: 'ETH', side: 'Down' } ],
  B: [ { symbol: 'BTC', side: 'Down' }, { symbol: 'ETH', side: 'Up' } ],
};
const COMBO_LABEL = { A: 'BTC Up + ETH Down', B: 'BTC Down + ETH Up' };

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-combo-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-combo-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// Market buy — true FOK market order via trader.placeFokBuy (dollar-denominated,
// fills immediately at best available price or kills entirely). Demo mode
// simulates the same fill semantics at the observed ask so both modes behave
// the same way, per your instruction that demo and live should both be market orders.
async function placeMarketableBuy(tokenId, price, shares) {
  const dollarAmount = round2(price * shares);
  if (!DRY_RUN && trader) {
    const resp = await trader.placeFokBuy(tokenId, dollarAmount);
    const avgPrice = resp.avgPrice > 0 ? resp.avgPrice : price;
    const filledShares = resp.isFilled ? round2(dollarAmount / avgPrice) : 0;
    return { id: resp.id, filled: !!resp.isFilled, avgPrice, shares: filledShares };
  }
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filled: true, avgPrice: price, shares };
}
function takerFee(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price));
}

// CLOB order rejections often carry the real reason in e.response.data / e.data /
// e.body rather than e.message (which is frequently just "Request failed with
// status code 400"). Pull whatever's actually there so failures are diagnosable
// instead of showing a generic message.
function describeOrderError(e) {
  const parts = [e?.message || String(e)];
  const extra = e?.response?.data ?? e?.data ?? e?.body ?? null;
  if (extra) {
    try { parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (_) {}
  }
  return parts.join(' | ');
}

// ─────────────────────────────────────────
//  Per-instance market state
// ─────────────────────────────────────────
function freshMarketSlot() {
  return {
    slug: null, eventTitle: null, conditionId: null,
    upTokenId: null, downTokenId: null,
    upAsk: null, upBid: null, downAsk: null, downBid: null,
  };
}
function freshComboSlot() {
  return {
    triggered: false, // one-shot per window
    positions: { BTC: null, ETH: null }, // filled legs: {shares, entryPrice, cost, side, closed, won}
    decorrelationChecked: false, // guards against re-classifying the same combo's result twice
  };
}
function freshInstanceState(def) {
  return {
    key: def.key,
    windowSecs: def.windowSecs,
    cutoffSecs: Math.round(def.windowSecs * COMBO_TRIGGER_FRACTION),
    tradable: false,
    windowStart: null, windowEnd: null,
    resolvedThisWindow: true,
    markets: { BTC: freshMarketSlot(), ETH: freshMarketSlot() },
    combos: { A: freshComboSlot(), B: freshComboSlot() },
    pendingBoostCombo: null, // 'A' | 'B' | null — set by decorrelation check, consumed once at the next window's open. Survives across freshInstanceState resets — see loadInstanceWindow.
  };
}

let instances = INSTANCE_DEFS.map(freshInstanceState);

// ─────────────────────────────────────────
//  Slug / window math
// ─────────────────────────────────────────
function currentWindowStart(windowSecs, tsSec = nowSec()) { return Math.floor(tsSec / windowSecs) * windowSecs; }
function windowLabel(windowSecs) { return windowSecs === 300 ? '5m' : windowSecs === 900 ? '15m' : `${Math.round(windowSecs / 60)}m`; }
function slugFor(symbol, windowSecs, windowStartSec) { return `${symbol.toLowerCase()}-updown-${windowLabel(windowSecs)}-${windowStartSec}`; }
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
async function fetchEventForWindow(symbol, windowSecs, windowStart) {
  for (const offset of SLUG_OFFSET_FALLBACKS_FACTORY(windowSecs)) {
    const ws = windowStart + offset;
    if (ws + windowSecs <= nowSec()) continue;
    const slug = slugFor(symbol, windowSecs, ws);
    try {
      const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
      if (event && event.id && Array.isArray(event.markets) && event.markets.length) return { event, windowStart: ws, slug };
    } catch (_) {}
  }
  return null;
}

async function loadInstanceWindow(inst) {
  const ws = currentWindowStart(inst.windowSecs);
  if (inst.windowStart === ws && inst.markets.BTC.upTokenId && inst.markets.ETH.upTokenId) return;

  const [foundBtc, foundEth] = await Promise.all([
    fetchEventForWindow('BTC', inst.windowSecs, ws),
    fetchEventForWindow('ETH', inst.windowSecs, ws),
  ]);
  if (!foundBtc || !foundEth) { inst.tradable = false; return; }

  // Both symbols must agree on the actual window start we found (fallback offsets could disagree).
  if (foundBtc.windowStart !== foundEth.windowStart) { inst.tradable = false; return; }

  function slotFrom(found) {
    const market = found.event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || found.event.markets[0];
    const upId = tokenIdForSide(market, 'up');
    const downId = tokenIdForSide(market, 'down');
    if (!upId || !downId) return null;
    const slot = freshMarketSlot();
    slot.slug = found.slug;
    slot.eventTitle = found.event.title || found.event.slug;
    slot.conditionId = market.conditionId || null;
    slot.upTokenId = upId;
    slot.downTokenId = downId;
    return slot;
  }
  const btcSlot = slotFrom(foundBtc);
  const ethSlot = slotFrom(foundEth);
  if (!btcSlot || !ethSlot) { log(`⚠️  [${inst.key}] window loaded but Up/Down token ids missing`); inst.tradable = false; return; }

  const carryPendingBoostCombo = inst.pendingBoostCombo || null; // must survive the freshInstanceState() reset below

  const fresh = freshInstanceState(INSTANCE_DEFS.find(d => d.key === inst.key));
  fresh.windowStart = foundBtc.windowStart;
  fresh.windowEnd = foundBtc.windowStart + inst.windowSecs;
  fresh.markets.BTC = btcSlot;
  fresh.markets.ETH = ethSlot;
  fresh.tradable = true;
  fresh.resolvedThisWindow = false;
  fresh.pendingBoostCombo = carryPendingBoostCombo; // consumed by fireForcedBoostIfPending() once prices are available this window

  Object.assign(inst, fresh);
  const sizingNote = carryPendingBoostCombo
    ? ` | ⚡ decorrelation follow-through queued: Combo ${carryPendingBoostCombo} will be bought unconditionally @ ${DECORRELATION_BOOST_SHARES}sh/leg as soon as prices load`
    : ` | sizing this window: ${COMBO_SHARES}sh/leg (base)`;
  log(`🔭 [${inst.key}] window loaded: BTC=${btcSlot.slug} ETH=${ethSlot.slug} | ends ${new Date(fresh.windowEnd * 1000).toISOString().slice(11, 19)}Z | trigger cutoff=${fresh.cutoffSecs}s${sizingNote}`);
}

// ─────────────────────────────────────────
//  Polymarket price feed
// ─────────────────────────────────────────
async function refreshInstancePrices(inst) {
  if (!inst.tradable) return;
  const requests = [];
  for (const symbol of SYMBOLS) {
    const m = inst.markets[symbol];
    if (!m.upTokenId || !m.downTokenId) continue;
    requests.push({ token_id: m.upTokenId, side: 'BUY' }, { token_id: m.upTokenId, side: 'SELL' });
    requests.push({ token_id: m.downTokenId, side: 'BUY' }, { token_id: m.downTokenId, side: 'SELL' });
  }
  if (!requests.length) return;

  function apply(tid, side, price) {
    if (!Number.isFinite(price)) return;
    for (const symbol of SYMBOLS) {
      const m = inst.markets[symbol];
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
    // Fallback: per-token price calls
    for (const symbol of SYMBOLS) {
      const m = inst.markets[symbol];
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
//  Real account data (live mode only) — actual wallet, not bot bookkeeping
// ─────────────────────────────────────────
function tradingWalletAddress() {
  if (!trader) return null;
  return trader.depositWallet || trader.address || null; // depositWallet is the actual funder/proxy wallet that holds funds+positions on Polymarket
}
async function refreshRealAccount() {
  if (DRY_RUN || !trader) { realFetchError = null; return; } // no real account to show in demo mode
  const address = tradingWalletAddress();
  if (!address) { realFetchError = 'No wallet address resolved yet'; return; }
  if (!trader.depositWallet && !warnedNoDepositWallet) {
    // #1 cause of "bot can't find my position": if deposit wallet derivation
    // failed during authenticate(), every lookup below silently queries the
    // wrong (EOA) address instead of the actual Safe/proxy wallet Polymarket
    // trades and holds positions through.
    warnedNoDepositWallet = true;
    log(`⚠️  WARNING: no depositWallet resolved — real account lookups are falling back to your EOA (${address}). If real positions/balance don't show up, THIS is almost certainly why — your actual funds/positions live at the deposit (proxy) wallet, not this address.`);
  }
  try {
    const [balance, positions] = await Promise.all([
      trader.getBalance().catch(e => { throw new Error(`balance: ${e.message}`); }),
      getJSON(`${DATA_API}/positions?user=${address}&sizeThreshold=0`).catch(e => { throw new Error(`positions: ${e.message}`); }),
    ]);
    realBalance = balance;
    realPositions = Array.isArray(positions) ? positions.filter(p => Math.abs(p.size) > 0) : [];
    realLastUpdated = Date.now();
    realFetchError = null;
  } catch (e) {
    realFetchError = e.message;
    log(`⚠️  Real account refresh failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────
//  Equity tracking
// ─────────────────────────────────────────
function markValue() {
  let held = 0;
  for (const inst of instances) {
    for (const comboKey of ['A', 'B']) {
      const combo = inst.combos[comboKey];
      for (const symbol of SYMBOLS) {
        const pos = combo.positions[symbol];
        if (!pos || pos.closed) continue;
        const m = inst.markets[symbol];
        const bid = pos.side === 'Up' ? m.upBid : m.downBid;
        held += pos.shares * (bid ?? pos.entryPrice);
      }
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
//  Combo trigger + execution
// ─────────────────────────────────────────
function comboAskSum(inst, comboKey) {
  const legs = COMBO_LEGS[comboKey];
  let sum = 0;
  for (const leg of legs) {
    const m = inst.markets[leg.symbol];
    const ask = leg.side === 'Up' ? m.upAsk : m.downAsk;
    if (ask == null) return null;
    sum += ask;
  }
  return sum;
}

async function checkComboTrigger(inst, comboKey) {
  const combo = inst.combos[comboKey];
  if (combo.triggered) return;

  const elapsed = nowSec() - inst.windowStart;
  if (elapsed >= inst.cutoffSecs) return; // past cutoff — this combo just doesn't trade this window

  const sum = comboAskSum(inst, comboKey);
  if (sum == null || sum >= COMBO_THRESHOLD) return;

  const shares = COMBO_SHARES; // base sizing — the decorrelation boost is a separate, unconditional buy handled by fireForcedBoostIfPending
  const legs = COMBO_LEGS[comboKey];

  // Price out both legs first, so we only commit if we can afford BOTH.
  const priced = legs.map(leg => {
    const m = inst.markets[leg.symbol];
    const ask = leg.side === 'Up' ? m.upAsk : m.downAsk;
    const tokenId = leg.side === 'Up' ? m.upTokenId : m.downTokenId;
    const fee = takerFee(shares, ask);
    const cost = round2(ask * shares + fee);
    return { ...leg, ask, tokenId, fee, cost };
  });
  const totalCost = round2(priced.reduce((s, p) => s + p.cost, 0));
  if (totalCost > bankroll) {
    log(`⏭️  [${inst.key}] Combo ${comboKey} (${COMBO_LABEL[comboKey]}) triggered @ sum=${sum.toFixed(3)} but insufficient bankroll ($${totalCost.toFixed(2)} needed at ${shares}sh/leg), skipping`);
    combo.triggered = true; // still one-shot — don't keep re-checking a combo we can't afford
    return;
  }

  combo.triggered = true; // lock in before awaiting, so a concurrent tick can't double-fire

  for (const leg of priced) {
    const fill = await placeMarketableBuy(leg.tokenId, leg.ask, shares);
    if (!fill.filled) {
      log(`❌ [${inst.key}] Combo ${comboKey} ${leg.symbol} ${leg.side} market order did not fill — leg skipped. NOTE: if the other leg already filled, this window may now be one-sided (unhedged) — check the dashboard.`);
      continue;
    }
    const actualShares = fill.shares > 0 ? fill.shares : shares;
    const actualCost = round2(actualShares * fill.avgPrice);
    bankroll = round2(bankroll - actualCost);
    feesPaid = round2(feesPaid + leg.fee); // fee is an internal estimate for dashboard bookkeeping; the exchange applies its own fee inside the FOK fill
    const tpPrice = Math.min(TP_MAX_PRICE, round2(fill.avgPrice * TP_MULTIPLIER));
    const position = { shares: actualShares, entryPrice: fill.avgPrice, cost: actualCost, side: leg.side, closed: false, won: null, tpPrice, tpOrderId: null, tpFilled: false, closedReason: null };
    combo.positions[leg.symbol] = position;
    registerTrade({ instance: inst.key, combo: comboKey, symbol: leg.symbol, side: 'BUY', outcome: leg.side, price: fill.avgPrice, shares: actualShares, cost: actualCost, fee: leg.fee });

    if (!DRY_RUN && trader) {
      try {
        const gtc = await trader.placeGtcOrder(leg.tokenId, 'SELL', tpPrice, actualShares);
        position.tpOrderId = gtc.id;
        log(`🎯 [${inst.key}] Combo ${comboKey} ${leg.symbol} TP order placed: SELL ${actualShares}sh @ ${tpPrice.toFixed(3)} (${Math.round(TP_MULTIPLIER * 100)}% of entry ${fill.avgPrice.toFixed(3)})`);
      } catch (e) {
        log(`⚠️  [${inst.key}] Combo ${comboKey} ${leg.symbol} failed to place TP order (position still held, will resolve normally if TP never gets placed): ${describeOrderError(e)}`);
      }
    } else {
      log(`🎯 [${inst.key}] Combo ${comboKey} ${leg.symbol} TP target set (demo, simulated against live bid): ${tpPrice.toFixed(3)} (${Math.round(TP_MULTIPLIER * 100)}% of entry ${fill.avgPrice.toFixed(3)})`);
    }
  }
  recordEquity();
  log(`🔔 [${inst.key}] Combo ${comboKey} (${COMBO_LABEL[comboKey]}) TRIGGERED @ sum=${sum.toFixed(3)} (< ${COMBO_THRESHOLD}) — bought ${shares}sh each leg: BTC ${priced[0].side}@${priced[0].ask.toFixed(2)} / ETH ${priced[1].side}@${priced[1].ask.toFixed(2)} | total cost=$${totalCost.toFixed(2)} | TP set per-leg @ ${Math.round(TP_MULTIPLIER * 100)}% of entry — untriggered TP rides to resolution`);
}

// ─────────────────────────────────────────
//  Decorrelation classification — judged purely by the LIVE MARKET PRICE of both legs
//  in the last seconds before the window closes, not by our own win/loss
//  outcome or resolution. If both held sides are trending toward the SAME
//  end (both near $0.00, or both near $1.00) instead of the expected split
//  (one near $1, one near $0), that's decorrelation — e.g. combo bought
//  BTC-Up + ETH-Down, and in the last second BOTH are sitting around 0.01:
//  both are about to lose, meaning BTC and ETH actually moved the SAME
//  direction as each other rather than diverging the way the combo bet.
//  Checked once per combo per window, right before resolution begins, using
//  whatever the freshest polled price is at that moment — completely
//  independent of whether either leg already TP'd or how it later resolves.
// ─────────────────────────────────────────
const DECORRELATION_PRICE_THRESHOLD = Number(process.env.DECORRELATION_PRICE_THRESHOLD || 0.05);

function checkComboDecorrelationByPrice(inst, comboKey) {
  const combo = inst.combos[comboKey];
  if (!combo.triggered || combo.decorrelationChecked) return; // only classify combos that actually fired this window, once each
  combo.decorrelationChecked = true;

  const legs = COMBO_LEGS[comboKey];
  const prices = legs.map(leg => {
    const m = inst.markets[leg.symbol];
    const bid = leg.side === 'Up' ? m.upBid : m.downBid;
    const ask = leg.side === 'Up' ? m.upAsk : m.downAsk;
    return bid ?? ask ?? null; // prefer bid (realizable value); fall back to ask if bid is missing
  });
  if (prices.some(p => p == null)) {
    log(`⚠️  [${inst.key}] Combo ${comboKey} could not classify decorrelation — missing last-second price data`);
    return;
  }

  const [p1, p2] = prices;
  const bothNearZero = p1 <= DECORRELATION_PRICE_THRESHOLD && p2 <= DECORRELATION_PRICE_THRESHOLD;
  const bothNearOne  = p1 >= (1 - DECORRELATION_PRICE_THRESHOLD) && p2 >= (1 - DECORRELATION_PRICE_THRESHOLD);
  const tag = `${legs[0].symbol}-${legs[0].side}=${p1.toFixed(3)} & ${legs[1].symbol}-${legs[1].side}=${p2.toFixed(3)}`;

  if (bothNearZero || bothNearOne) {
    // Both win → realized pairing IS this combo's own legs. Both lose →
    // realized pairing was actually the OTHER combo's legs (BTC and ETH
    // moved the way that combo bets, not this one).
    const realizedCombo = bothNearOne ? comboKey : (comboKey === 'A' ? 'B' : 'A');
    inst.pendingBoostCombo = realizedCombo; // one-shot — overwrites any still-pending queue from earlier this same tick
    log(`⚡ [${inst.key}] Combo ${comboKey} DECORRELATED — last-second prices ${tag}, both trending toward ${bothNearZero ? '0 (both about to lose)' : '1 (both about to win)'} — realized pairing = Combo ${realizedCombo} (${COMBO_LABEL[realizedCombo]}), queued to buy unconditionally @ ${DECORRELATION_BOOST_SHARES}sh/leg the instant the next window opens`);
  } else {
    log(`↔️  [${inst.key}] Combo ${comboKey} split as expected — last-second prices ${tag} — no follow-through boost queued`);
  }
}

// ─────────────────────────────────────────
//  Decorrelation follow-through — the one-shot unconditional buy queued by
//  checkComboDecorrelationByPrice above. Fires as soon as the NEXT window
//  has loaded AND has live ask prices for both legs — no COMBO_THRESHOLD
//  check, no cutoff, bypasses the normal trigger path entirely. Marks the
//  combo triggered so the normal threshold-based check doesn't also fire it.
// ─────────────────────────────────────────
async function fireForcedBoostIfPending(inst) {
  const comboKey = inst.pendingBoostCombo;
  if (!comboKey || !inst.tradable) return;
  const combo = inst.combos[comboKey];
  if (combo.triggered) { inst.pendingBoostCombo = null; return; } // shouldn't happen on a fresh window, but guard against double-fire

  const legs = COMBO_LEGS[comboKey];
  const priced = legs.map(leg => {
    const m = inst.markets[leg.symbol];
    const ask = leg.side === 'Up' ? m.upAsk : m.downAsk;
    const tokenId = leg.side === 'Up' ? m.upTokenId : m.downTokenId;
    return { ...leg, ask, tokenId };
  });
  if (priced.some(p => p.ask == null)) return; // prices not populated yet this tick — retry next tick, still "as soon as window opens"

  const shares = DECORRELATION_BOOST_SHARES;
  const costed = priced.map(p => {
    const fee = takerFee(shares, p.ask);
    return { ...p, fee, cost: round2(p.ask * shares + fee) };
  });
  const totalCost = round2(costed.reduce((s, p) => s + p.cost, 0));

  inst.pendingBoostCombo = null; // one-shot — consumed regardless of what happens below

  if (totalCost > bankroll) {
    log(`⏭️  [${inst.key}] Decorrelation follow-through on Combo ${comboKey} skipped — insufficient bankroll ($${totalCost.toFixed(2)} needed at ${shares}sh/leg)`);
    return;
  }
  combo.triggered = true; // lock so the normal threshold trigger doesn't also fire this combo this window

  for (const leg of costed) {
    const fill = await placeMarketableBuy(leg.tokenId, leg.ask, shares);
    if (!fill.filled) {
      log(`❌ [${inst.key}] Decorrelation follow-through ${leg.symbol} ${leg.side} market order did not fill — leg skipped.`);
      continue;
    }
    const actualShares = fill.shares > 0 ? fill.shares : shares;
    const actualCost = round2(actualShares * fill.avgPrice);
    bankroll = round2(bankroll - actualCost);
    feesPaid = round2(feesPaid + leg.fee);
    const tpPrice = Math.min(TP_MAX_PRICE, round2(fill.avgPrice * TP_MULTIPLIER));
    const position = { shares: actualShares, entryPrice: fill.avgPrice, cost: actualCost, side: leg.side, closed: false, won: null, tpPrice, tpOrderId: null, tpFilled: false, closedReason: null };
    combo.positions[leg.symbol] = position;
    registerTrade({ instance: inst.key, combo: comboKey, symbol: leg.symbol, side: 'BUY', outcome: leg.side, price: fill.avgPrice, shares: actualShares, cost: actualCost, fee: leg.fee, reason: 'DECORR_BOOST' });

    if (!DRY_RUN && trader) {
      try {
        const gtc = await trader.placeGtcOrder(leg.tokenId, 'SELL', tpPrice, actualShares);
        position.tpOrderId = gtc.id;
        log(`🎯 [${inst.key}] Decorrelation follow-through ${leg.symbol} TP order placed: SELL ${actualShares}sh @ ${tpPrice.toFixed(3)}`);
      } catch (e) {
        log(`⚠️  [${inst.key}] Decorrelation follow-through ${leg.symbol} failed to place TP order (position still held): ${describeOrderError(e)}`);
      }
    } else {
      log(`🎯 [${inst.key}] Decorrelation follow-through ${leg.symbol} TP target set (demo): ${tpPrice.toFixed(3)}`);
    }
  }
  recordEquity();
  log(`⚡🔔 [${inst.key}] DECORRELATION FOLLOW-THROUGH — unconditional buy Combo ${comboKey} (${COMBO_LABEL[comboKey]}) @ window open, ${shares}sh/leg, no threshold check: BTC ${costed[0].side}@${costed[0].ask.toFixed(2)} / ETH ${costed[1].side}@${costed[1].ask.toFixed(2)} | total cost=$${totalCost.toFixed(2)}`);
}

// ─────────────────────────────────────────
//  Take-profit monitoring — separate from window resolution. Live mode
//  polls the real GTC order's status; demo mode simulates against the
//  live bid feed we're already polling for the combo trigger.
// ─────────────────────────────────────────
function settleTp(inst, comboKey, symbol, pos) {
  const proceeds = round2(pos.shares * pos.tpPrice);
  const profit = round2(proceeds - pos.cost);
  bankroll = round2(bankroll + proceeds);
  realizedPnl = round2(realizedPnl + profit);
  wins++; // a TP fill is definitionally profitable (tpPrice > entryPrice)
  pos.closed = true;
  pos.won = true;
  pos.tpFilled = true;
  pos.closedReason = 'TP';
  log(`🎯 [${inst.key}] Combo ${comboKey} ${symbol} ${pos.side} TP FILLED ${pos.shares}sh entry=${pos.entryPrice.toFixed(3)} tp=${pos.tpPrice.toFixed(3)} | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);
  registerTrade({ instance: inst.key, combo: comboKey, symbol, side: 'SELL', outcome: pos.side, reason: 'TP', price: pos.tpPrice, shares: pos.shares, profit });
  recordEquity();
}

async function checkTpFills(inst) {
  if (!inst.tradable) return;
  for (const comboKey of ['A', 'B']) {
    const combo = inst.combos[comboKey];
    for (const symbol of SYMBOLS) {
      const pos = combo.positions[symbol];
      if (!pos || pos.closed || pos.tpFilled || !pos.tpPrice) continue;

      if (!DRY_RUN && pos.tpOrderId && trader) {
        try {
          const order = await trader.getOrder(pos.tpOrderId);
          const status = (order?.status || '').toUpperCase();
          const matchStatus = (order?.match_status || order?.matchStatus || '').toLowerCase();
          const state = (order?.state || '').toLowerCase();
          const filled = status === 'FILLED' || matchStatus === 'filled' || state === 'filled';
          if (filled) settleTp(inst, comboKey, symbol, pos);
        } catch (_) { /* transient lookup failure — retry next tick */ }
      } else if (DRY_RUN) {
        const m = inst.markets[symbol];
        const bid = pos.side === 'Up' ? m.upBid : m.downBid;
        if (bid != null && bid >= pos.tpPrice) settleTp(inst, comboKey, symbol, pos);
      }
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

async function resolveInstanceWindow(inst) {
  if (inst.resolvedThisWindow) return;
  inst.resolvedThisWindow = true;

  for (const symbol of SYMBOLS) {
    const m = inst.markets[symbol];
    const anyOpen = ['A', 'B'].some(k => { const p = inst.combos[k].positions[symbol]; return p && !p.closed; });
    if (!anyOpen) continue;
    const winner = await determineWinningSide(m.slug, m.conditionId, m.upBid, m.downBid);

    for (const comboKey of ['A', 'B']) {
      const pos = inst.combos[comboKey].positions[symbol];
      if (!pos || pos.closed) continue;
      if (!DRY_RUN && pos.tpOrderId && trader) {
        try {
          await trader.cancelOrder(pos.tpOrderId);
          log(`🚫 [${inst.key}] Combo ${comboKey} ${symbol} cancelled unfilled TP order before resolution`);
        } catch (e) {
          log(`⚠️  [${inst.key}] Combo ${comboKey} ${symbol} failed to cancel TP order (may already be gone/filled): ${describeOrderError(e)}`);
        }
      }
      const won = winner === pos.side;
      const proceeds = won ? round2(pos.shares * 1) : 0;
      const profit = round2(proceeds - pos.cost);
      bankroll = round2(bankroll + proceeds);
      realizedPnl = round2(realizedPnl + profit);
      if (won) wins++; else losses++;
      pos.closed = true;
      pos.won = won;
      pos.closedReason = 'RESOLUTION';
      const icon = won ? '💰' : '💥';
      log(`${icon} [${inst.key}] Combo ${comboKey} ${symbol} ${pos.side} RESOLUTION ${pos.shares}sh entry=${pos.entryPrice.toFixed(2)} exit=$${won ? '1.00' : '0.00'}/sh | pnl=$${profit.toFixed(2)} | bankroll=$${bankroll.toFixed(2)} (dashboard bookkeeping only — real redemption is via the separate claim script)`);
      registerTrade({ instance: inst.key, combo: comboKey, symbol, side: 'SELL', outcome: pos.side, reason: 'RESOLUTION', price: won ? 1 : 0, shares: pos.shares, profit });
    }
  }
  recordEquity();
}

// ─────────────────────────────────────────
//  Main tick
// ─────────────────────────────────────────
async function instanceTick(inst) {
  const ws = currentWindowStart(inst.windowSecs);
  if (inst.windowStart === null || ws !== inst.windowStart) {
    if (inst.windowStart !== null && !inst.resolvedThisWindow) await resolveInstanceWindow(inst);
    await loadInstanceWindow(inst);
  }
  if (!inst.tradable) return;

  await checkTpFills(inst); // exit management runs regardless of pause state

  const elapsed = nowSec() - inst.windowStart;
  if (elapsed >= inst.windowSecs - EARLY_CUTOFF_SECS && !inst.resolvedThisWindow) {
    // Classify decorrelation using whatever the freshest polled price is
    // right now — this is "the last second" before we hand off to
    // resolution, and is independent of how resolution itself turns out.
    checkComboDecorrelationByPrice(inst, 'A');
    checkComboDecorrelationByPrice(inst, 'B');
    await resolveInstanceWindow(inst);
  }
  if (inst.resolvedThisWindow) return;
  if (!tradingEnabled) return; // pause only blocks NEW entries, not exit management

  await fireForcedBoostIfPending(inst); // one-shot unconditional follow-through buy, if a prior window's decorrelation queued one
  await checkComboTrigger(inst, 'A');
  await checkComboTrigger(inst, 'B');
}

async function tick() {
  for (const inst of instances) await instanceTick(inst);
}

// ─────────────────────────────────────────
//  UI state
// ─────────────────────────────────────────
function buildInstanceState(inst) {
  const secsToEnd = inst.windowEnd ? Math.max(0, Math.floor(inst.windowEnd - nowSec())) : null;
  const secsToCutoff = inst.windowStart != null ? Math.max(0, Math.floor((inst.windowStart + inst.cutoffSecs) - nowSec())) : null;
  return {
    key: inst.key, windowSecs: inst.windowSecs, cutoffSecs: inst.cutoffSecs,
    tradable: inst.tradable, windowEnd: inst.windowEnd, secsToEnd, secsToCutoff,
    sharesThisWindow: COMBO_SHARES, pendingBoostCombo: inst.pendingBoostCombo,
    pendingBoostLabel: inst.pendingBoostCombo ? COMBO_LABEL[inst.pendingBoostCombo] : null,
    markets: {
      BTC: { slug: inst.markets.BTC.slug, upAsk: inst.markets.BTC.upAsk, upBid: inst.markets.BTC.upBid, downAsk: inst.markets.BTC.downAsk, downBid: inst.markets.BTC.downBid },
      ETH: { slug: inst.markets.ETH.slug, upAsk: inst.markets.ETH.upAsk, upBid: inst.markets.ETH.upBid, downAsk: inst.markets.ETH.downAsk, downBid: inst.markets.ETH.downBid },
    },
    combos: {
      A: { label: COMBO_LABEL.A, triggered: inst.combos.A.triggered, sum: comboAskSum(inst, 'A'), positions: inst.combos.A.positions },
      B: { label: COMBO_LABEL.B, triggered: inst.combos.B.triggered, sum: comboAskSum(inst, 'B'), positions: inst.combos.B.positions },
    },
  };
}

function buildState() {
  const mv = markValue();
  let costBasis = 0;
  for (const inst of instances) {
    for (const comboKey of ['A', 'B']) {
      for (const symbol of SYMBOLS) {
        const pos = inst.combos[comboKey].positions[symbol];
        if (pos && !pos.closed) costBasis += pos.cost;
      }
    }
  }
  costBasis = round2(costBasis);
  const held = round2(mv - bankroll);
  const unrealizedPnl = round2(held - costBasis);
  return {
    dryRun: DRY_RUN, tradingEnabled, symbols: SYMBOLS,
    instances: instances.map(buildInstanceState),
    totalCapital: TOTAL_CAPITAL, bankroll, markValue: mv,
    realizedPnl, unrealizedPnl, feesPaid, wins, losses,
    totalPnl: round2(mv - TOTAL_CAPITAL),
    winRate: (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: {
      comboThreshold: COMBO_THRESHOLD, comboTriggerFraction: COMBO_TRIGGER_FRACTION, comboShares: COMBO_SHARES,
      boostShares: DECORRELATION_BOOST_SHARES,
      tpMultiplier: TP_MULTIPLIER, tpMaxPrice: TP_MAX_PRICE,
      cryptoTakerFeeRate: CRYPTO_TAKER_FEE_RATE,
    },
    equityCurve, logs: logs.slice(-100), trades: trades.slice(-80).reverse(),
    real: {
      enabled: !DRY_RUN,
      wallet: tradingWalletAddress(),
      balance: realBalance,
      positions: realPositions,
      lastUpdated: realLastUpdated,
      error: realFetchError,
    },
  };
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let lastPolyPriceFetch = 0, lastRealAccountFetch = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) {
        lastPolyPriceFetch = now;
        await Promise.all(instances.map(refreshInstancePrices));
      }
      if (now - lastRealAccountFetch >= REAL_ACCOUNT_REFRESH_MS) {
        lastRealAccountFetch = now;
        await refreshRealAccount();
      }
      await tick();
      emitFn('state', buildState());
    } catch (e) { log(`⚠️  Loop error: ${e.message}`); }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

function setPairs(_list) {
  // This bot always trades BTC+ETH combos on 5m and 15m — retained as a no-op for API compatibility with the dashboard.
  return { ok: true, symbols: SYMBOLS, instances: INSTANCE_DEFS.map(d => d.key) };
}
function pauseTrading() { tradingEnabled = false; log('⏸️  Trading paused (existing positions still tracked for resolution bookkeeping)'); return { ok: true }; }
function resumeTrading() { tradingEnabled = true; log('▶️  Trading resumed'); return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

function setMode(wantLive) {
  const was = DRY_RUN;
  DRY_RUN = !wantLive;
  if (was !== DRY_RUN) {
    log(DRY_RUN ? '🟡 Switched to DEMO mode (simulated fills)' : '🔴 Switched to LIVE mode — real money, real orders');
    if (!DRY_RUN) refreshRealAccount().catch(() => {}); // don't make the dashboard wait up to 5s to see real balance
  }
  return { ok: true, dryRun: DRY_RUN };
}

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Cross-Pair Combo Bot — BTC/ETH Up/Down, 5m + 15m instances`);
  log(`⚙️  $${TOTAL_CAPITAL} capital (shared across both instances)`);
  log(`⚙️  Combo A = BTC-Up + ETH-Down | Combo B = BTC-Down + ETH-Up | trigger: combined ask < ${COMBO_THRESHOLD} before ${Math.round(COMBO_TRIGGER_FRACTION * 100)}% of window elapses`);
  log(`⚙️  Sizing: base ${COMBO_SHARES}sh/leg | on decorrelation (a combo's both legs win, or both lose), the realized pairing is bought unconditionally next window @ ${DECORRELATION_BOOST_SHARES}sh/leg, no threshold check, one-shot — tracked independently per instance (5m/15m don't share it)`);
  log(`⚙️  5m instance: cutoff @ ${INSTANCE_DEFS[0].windowSecs * COMBO_TRIGGER_FRACTION}s | 15m instance: cutoff @ ${INSTANCE_DEFS[1].windowSecs * COMBO_TRIGGER_FRACTION}s`);
  log(`⚙️  Execution: marketable buy both legs @ current ask, ${COMBO_SHARES}sh/leg (or ${DECORRELATION_BOOST_SHARES}sh/leg for a decorrelation follow-through), once per combo per window | per-leg TP @ ${Math.round(TP_MULTIPLIER * 100)}% of entry (capped ${TP_MAX_PRICE}) — untriggered TP still rides to resolution`);
  log(`${DRY_RUN ? '⚠️  DEMO MODE — simulated fills, real API for market/price data' : '🔴 LIVE MODE — real money'}`);

  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();
  mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, setMode, getStatus, buildState };
