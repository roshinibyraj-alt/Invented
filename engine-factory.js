'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 0.60 MARTINGALE ENGINE — 5m Up/Down windows
 * ═══════════════════════════════════════════════════════════════
 *
 *  COMPLETE replacement of the old momentum/hedge logic.
 *
 *  New strategy, 5m Up/Down windows:
 *
 *  1. When a window opens, the bot does NOT bet immediately. It waits:
 *        - 2 minutes after a 5m window opens
 *        - 6 minutes after a 15m window opens (proportional 3x)
 *  2. When the wait ends, the bot fires the $50 entry IMMEDIATELY on
 *     the leading side (the higher-priced side) at WHATEVER the price
 *     is — no waiting for the price to come back to 0.60.
 *  3. While the window is open, the moment the OPPOSITE side's price
 *     reaches 0.50, the bot flips INSTANTLY: it buys that side with ONE
 *     martingale flip of $100 (2x the $50 entry, max 1 flip per window).
 *     About 2 seconds after the flip it CLOSES the losing side it just
 *     left, selling all
 *     of those shares at the current bid and recovering capital. NO
 * *  4. At window end, whichever side's price is above 0.90 is declared
 *     the winner. Window PnL = payout of the FINAL held side's shares
 *     ($1.00 each) + proceeds from the losing-side sales - total cost
 *     of every buy.
 *  5. Every new window starts fresh with the $50 entry. 5m and 15m
 *     trade completely independently with SEPARATE demo capital.
 *
 *  Dashboard: per-timeframe equity curves, max drawdown, win rate, and
 *  the number of windows that reached the max martingale ($100 flip).
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS                = 100;
const DISCOVERY_RETRY_MS     = 500;
const RESOLUTION_POLL_MS     = 1000;
const MIN_ORDER_SHARES       = 1;
const EQUITY_RECORD_MS       = 1000;

const TRIGGER_PRICE      = 0.60; // legacy entry reference (kept for state/UI)
const FLIP_TRIGGER_PRICE = 0.50; // martingale: fire instantly at 0.50+
const WINNER_PRICE       = 0.90; // resolution: side above 0.90 wins
const MOMENTUM_HOLD_MS  = 3000;  // price must stay >= entryPrice for 3s before entry
const MAX_ENTRY_PRICE   = 0.65;  // never enter above this price
const MIN_SECONDS_LEFT  = 60;    // don't enter if < 60s remain in window
const DIVERGENCE_MIN    = 0.10;  // opposite side must be at least this far below entry side

function round2(n) { return Math.round(n * 100) / 100; }
function sgn2(n) { return (n > 0 ? '+$' : (n < 0 ? '-$' : '±$')) + Math.abs(n).toFixed(2); }

function createEngine(cfg) {
  const {
    label = 'BTC-0.60-MART',
    startingCapital = 4000,
    startingCapital5,
    entryPrice = 0.60,
    stopLossPrice = 0.49,
    entryDollars = 50,
    martingaleMultiplier = 1.5,
    maxMartingaleLevels = 1,
    waitSeconds5 = 0,
    windowType = '5m',
    windowSeconds5 = 300,
    feeTheta = 0.07,
    rebatePct = 0,
    trader,
    dryRun = true,
    statsStatePath,
    emit = () => {},
    slog = () => {},
    nowFn = Date.now,
    tickMs = TICK_MS,
    priceRefreshMs = 100,
  } = cfg;

  const window5 = windowSeconds5;
  let tradeSeq = 0;

  // Separate demo capital per timeframe (default: split startingCapital evenly).
  const capital5 = startingCapital5 != null ? round2(startingCapital5) : round2(startingCapital);

  let DRY_RUN = dryRun;
  let warnedNoRestingMethod = false;
  let warnedNoCancelMethod = false;
  let warnedNoSellMethod = false;

  function loadStats() {
    if (!statsStatePath) return null;
    try {
      const raw = fs.readFileSync(statsStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && (typeof parsed.bankroll5 === 'number' || typeof parsed.bankroll === 'number')) {
        // Migrate old 5m-suffixed keys to new plain keys
        if (typeof parsed.bankroll === 'undefined' && typeof parsed.bankroll5 === 'number') {
          parsed.bankroll = parsed.bankroll5;
          parsed.realizedPnl = parsed.realizedPnl5 || 0;
          parsed.wins = parsed.wins5 || 0;
          parsed.losses = parsed.losses5 || 0;
          parsed.maxMartCount = parsed.maxMartCount5 || 0;
          parsed.history = parsed.history5 || [];
          parsed.equityCurve = parsed.equityCurve5 || [];
          parsed.trades = parsed.trades5 || [];
        }
        return parsed;
      }
    } catch (_) {}
    return null;
  }
  const savedStats = loadStats();

  const engine = {
    tradingEnabled: true,
    bankroll: savedStats && typeof savedStats.bankroll === 'number' ? savedStats.bankroll : capital5,
    realizedPnl: savedStats ? (savedStats.realizedPnl || 0) : 0,
    wins: savedStats ? (savedStats.wins || 0) : 0,
    losses: savedStats ? (savedStats.losses || 0) : 0,
    maxMartCount: savedStats ? (savedStats.maxMartCount || 0) : 0,
    history: savedStats && Array.isArray(savedStats.history) ? savedStats.history : [],
    trades: [],
    logs: [],
    equityCurve: savedStats && Array.isArray(savedStats.equityCurve) && savedStats.equityCurve.length
      ? savedStats.equityCurve
      : [{ t: nowFn(), equity: capital5 }],
    current: null,
    pending: [],
    lastResolutionPoll: 0,
    lastPriceFetch: 0,
    lastEquityRecord: 0,
    waitingForBoundary: true,
    boundaryWindowTs: null,
    totalFeesPaid: savedStats ? savedStats.totalFeesPaid || 0 : 0,
    totalRebatesEarned: savedStats ? savedStats.totalRebatesEarned || 0 : 0,
    totalVolume: savedStats ? savedStats.totalVolume || 0 : 0,
  };

  function saveStats() {
    if (!statsStatePath) return;
    try {
      fs.writeFileSync(statsStatePath, JSON.stringify({
        bankroll: engine.bankroll,
        realizedPnl: engine.realizedPnl,
        wins: engine.wins, losses: engine.losses,
        maxMartCount: engine.maxMartCount,
        history: engine.history.slice(0, 100),
        equityCurve: engine.equityCurve.slice(-300),
        totalFeesPaid: engine.totalFeesPaid,
        totalRebatesEarned: engine.totalRebatesEarned,
        totalVolume: engine.totalVolume,
        savedAt: nowFn(),
      }));
    } catch (_) {}
  }

  function log(msg) {
    const line = `[${new Date(nowFn()).toISOString().slice(11, 19)}] ${msg}`;
    engine.logs.push(line);
    if (engine.logs.length > 500) engine.logs.shift();
    slog(`[${label.toLowerCase()}] ${line}`);
  }
  function registerTrade(t) {
    const trade = { seq: ++tradeSeq, time: new Date(nowFn()).toISOString().slice(11, 19), ...t };
    const list = engine.trades;
    list.push(trade);
    if (list.length > 300) list.shift();
  }
  function tfLabel() { return windowType; }
  function winSec() { return window5; }
  function waitSec() { return waitSeconds5; }

  function totalCostOf(t) {
    if (!t || !t.buys || !t.buys.length) return 0;
    return round2(t.buys.reduce((s, b) => s + b.cost, 0));
  }
  function positionMTM(t) {
    if (!t || !t.buys || !t.buys.length) return 0;
    let val = 0;
    for (const side of ['up', 'down']) {
      const held = heldShares(t, side);
      if (held > 0) {
        const p = markPrice(t.leg, side);
        if (p != null) val += held * p;
      }
    }
    return val;
  }
  function unrealizedFor(t) {
    if (!t || t.settled || !t.buys || !t.buys.length) return null;
    return round2(positionMTM(t) - totalCostOf(t) + totalSellProceeds(t));
  }
  function recordEquity() {
    engine.equityCurve.push({ t: nowFn(), equity: round2(engine.bankroll + positionMTM(engine.current)) });
    if (engine.equityCurve.length > 2000) engine.equityCurve.shift();
    saveStats();
  }

  async function getJSON(url, timeoutMs = 4000) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-martingale-bot/1.0' }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return await res.json();
    } finally {
      clearTimeout(to);
    }
  }
  function describeOrderError(e) {
    const parts = [e?.message || String(e)];
    const extra = e?.response?.data ?? e?.data ?? e?.body ?? null;
    if (extra) { try { parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (_) {} }
    return parts.join(' | ');
  }
  function traderHasRestingOrderMethods() {
    const ok = trader && typeof trader.placeFokLimitOrder === 'function';
    if (!ok && !warnedNoRestingMethod) {
      warnedNoRestingMethod = true;
      slog(`[${label.toLowerCase()}] ❌ LIVE trading needs trader.placeFokLimitOrder(tokenId, side, price, size) - LIVE order placement will be skipped until added. DRY_RUN is unaffected.`);
    }
    return ok;
  }
  async function cancelRestingOrder(orderId) {
    if (DRY_RUN || !orderId) return;
    if (!trader || typeof trader.cancelOrder !== 'function') {
      if (!warnedNoCancelMethod) { warnedNoCancelMethod = true; slog(`[${label.toLowerCase()}] ⚠️ trader.cancelOrder not implemented.`); }
      return;
    }
    try { await trader.cancelOrder(orderId); } catch (e) { log(`⚠️ cancelRestingOrder(${orderId}) failed: ${e.message}`); }
  }
  async function placeTakerBuy(tokenId, price, shares) {
    if (!DRY_RUN) {
      if (!traderHasRestingOrderMethods()) return null;
      try {
        const resp = await trader.placeFokLimitOrder(tokenId, 'BUY', price, shares);
        if (resp?.isFilled) return { id: resp.id || null, filledNow: true, avgPrice: resp.avgPrice || price, filledShares: shares };
        if (resp?.id) await cancelRestingOrder(resp.id);
        return { id: null, filledNow: false, avgPrice: price, filledShares: 0 };
      } catch (e) {
        log(`❌ placeTakerBuy(${tokenId}) failed: ${describeOrderError(e)}`);
        return null;
      }
    }
    return { id: `dry-${nowFn()}-${Math.random().toString(36).slice(2, 7)}`, filledNow: true, avgPrice: price, filledShares: shares };
  }

  async function placeTakerSell(tokenId, shares) {
    if (!DRY_RUN) {
      if (!trader || typeof trader.placeFokSell !== 'function') {
        if (!warnedNoSellMethod) {
          warnedNoSellMethod = true;
          slog(`[${label.toLowerCase()}] ❌ LIVE closing of the losing side needs trader.placeFokSell(tokenId, shares) — losing-side sells will be SKIPPED in live mode until it is added.`);
        }
        return null;
      }
      try {
        const resp = await trader.placeFokSell(tokenId, shares);
        if (resp && resp.isFilled) return { filledNow: true, avgPrice: resp.avgPrice != null ? resp.avgPrice : null, filledShares: shares };
        return { filledNow: false };
      } catch (e) {
        log(`❌ placeTakerSell(${tokenId}) failed: ${describeOrderError(e)}`);
        return null;
      }
    }
    return { filledNow: true, avgPrice: null, filledShares: shares }; // demo: fill at the current bid
  }

  // Close the losing side: sell the quantity that was held at flip time (so a
  // faster next flip never closes the position we just flipped TO).
  async function sellLeg(t, side, qty, forcePrice) {
    const leg = t.leg;
    const tokenId = tokenIdFor(leg, side);
    const held = heldShares(t, side);
    const sellQty = round2(Math.min(qty == null ? held : qty, held));
    if (!tokenId || sellQty <= 0) return { ok: false, reason: 'nothing-held' };
    const bid = bidFor(leg, side);
    if (bid == null) return { ok: false, reason: 'no-bid' };
    const resp = await placeTakerSell(tokenId, sellQty);
    if (!resp || !resp.filledNow) return { ok: false, reason: 'sell-not-filled' };
    const avgPrice = resp.avgPrice != null ? resp.avgPrice : (forcePrice != null ? forcePrice : bid);
    const gross = round2(sellQty * avgPrice);
    const fee = computeFee(sellQty, avgPrice);
    const netFee = round2(fee - round2(fee * rebatePct));
    const proceeds = round2(gross - netFee);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    engine.totalVolume = round2(engine.totalVolume + gross);
    engine.bankroll = round2(engine.bankroll + proceeds);
    t.sells.push({ side, ts: nowFn(), shares: sellQty, price: avgPrice, proceeds });
    log(`${tfLabel()} 🧹 closed losing side ${side.toUpperCase()} — sold ${sellQty.toFixed(2)}sh @${avgPrice.toFixed(3)} (recovered $${proceeds.toFixed(2)})`);
    return { ok: true, shares: sellQty, avgPrice, proceeds };
  }

  // Execute any losing-side sells whose 2s delay has elapsed.
  async function processPendingSells(t) {
    if (!t.pendingSells || !t.pendingSells.length) return;
    const now = nowFn();
    const due = t.pendingSells.filter(x => now >= x.at);
    if (!due.length) return;
    t.pendingSells = t.pendingSells.filter(x => now < x.at);
    const totals = {};
    for (const x of due) totals[x.side] = round2((totals[x.side] || 0) + (x.qty || 0));
    for (const side of Object.keys(totals)) {
      const result = await sellLeg(t, side, totals[side]);
      if (!result || !result.ok) {
        log(`⚠️ ${tfLabel()} pending sell ${side.toUpperCase()} ${totals[side].toFixed(2)}sh failed (${result?.reason || 'unknown'}) — shares lost at window close`);
      }
    }
  }

  // Emergency close at window end: sell anything still pending (defensive).
  async function flushPendingSells(t) {
    if (!t.pendingSells || !t.pendingSells.length) return;
    const totals = {};
    for (const x of t.pendingSells) totals[x.side] = round2((totals[x.side] || 0) + (x.qty || 0));
    t.pendingSells = [];
    for (const side of Object.keys(totals)) {
      const result = await sellLeg(t, side, totals[side]);
      if (!result || !result.ok) {
        log(`⚠️ ${tfLabel()} flush-sell ${side.toUpperCase()} ${totals[side].toFixed(2)}sh failed (${result?.reason || 'unknown'}) — shares expire worthless`);
      }
    }
  }

  // Polymarket taker fee: fee = shares * theta * price * (1-price).
  function computeFee(shares, price) {
    return shares * feeTheta * price * (1 - price);
  }
  function parseMarketTokens(mk) {
    try {
      const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
      const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
      return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
    } catch (_) { return []; }
  }

  function freshLeg(windowTs, windowSeconds, slugPrefix) {
    return {
      slug: `${slugPrefix}${windowTs}`,
      windowTs, windowSeconds,
      closeAt: (windowTs + windowSeconds) * 1000,
      conditionId: null, upTokenId: null, downTokenId: null,
      upAsk: null, downAsk: null, upBid: null, downBid: null,
      discovered: false, lastDiscoveryAttempt: 0,
      resolved: false, winner: null, resolutionMethod: null,
    };
  }

  async function discoverLeg(leg) {
    try {
      // Try primary slug, then ±windowSec neighbors for clock skew tolerance
      const candidates = [leg.slug];
      if (leg.windowSeconds) {
        const baseTs = leg.windowTs;
        const prefix = leg.slug.split('-').slice(0, -1).join('-');
        candidates.push(`${prefix}-${baseTs - leg.windowSeconds}`);
        candidates.push(`${prefix}-${baseTs + leg.windowSeconds}`);
      }
      for (const slug of candidates) {
        const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`).catch(() => null);
        const event = Array.isArray(events) ? events[0] : null;
        if (!event) continue;
        const mk = (event.markets || [])[0];
        if (!mk) continue;
        const tokens = parseMarketTokens(mk);
        const up = tokens.find(t => /up/i.test(t.outcome));
        const down = tokens.find(t => /down/i.test(t.outcome));
        if (!up || !down || !up.token_id || !down.token_id) continue;
        leg.conditionId = mk.conditionId || null;
        leg.upTokenId = up.token_id;
        leg.downTokenId = down.token_id;
        leg.slug = slug;
        leg.discovered = true;
        log(`🎯 leg discovered ${slug} — Up ${String(up.token_id).slice(0, 10)}… / Down ${String(down.token_id).slice(0, 10)}…`);
        return;
      }
    } catch (e) {
      log(`⚠️ discoverLeg(${leg.slug}) failed: ${e.message}`);
    }
  }


  function markPrice(leg, side) {
    const bid = side === 'up' ? leg.upBid : leg.downBid;
    const ask = side === 'up' ? leg.upAsk : leg.downAsk;
    if (bid != null) return bid;
    if (ask != null) return ask;
    return null;
  }
  function leadingSide(leg) {
    const upP = markPrice(leg, 'up');
    const downP = markPrice(leg, 'down');
    if (upP == null && downP == null) return null;
    if (upP == null) return 'down';
    if (downP == null) return 'up';
    return upP >= downP ? 'up' : 'down';
  }

  async function attemptFastResolution(leg) {
    if (leg.resolved) return true;
    if (!leg.upTokenId || !leg.downTokenId) return false;
    const upP = markPrice(leg, 'up');
    const downP = markPrice(leg, 'down');
    if (upP == null && downP == null) return false;
    // At window end, whichever side's price is above 0.90 is declared the winner.
    if (upP > WINNER_PRICE) {
      leg.resolved = true;
      leg.winner = 'up';
      leg.resolutionMethod = 'final-price';
      log(`⚡ [${leg.slug}] resolved FINAL-PRICE at window close (up ${upP.toFixed(3)} / down ${downP != null ? downP.toFixed(3) : '—'}) — winner UP (above ${WINNER_PRICE.toFixed(2)})`);
      return true;
    }
    if (downP > WINNER_PRICE) {
      leg.resolved = true;
      leg.winner = 'down';
      leg.resolutionMethod = 'final-price';
      log(`⚡ [${leg.slug}] resolved FINAL-PRICE at window close (up ${upP != null ? upP.toFixed(3) : '—'} / down ${downP.toFixed(3)}) — winner DOWN (above ${WINNER_PRICE.toFixed(2)})`);
      return true;
    }
    return false;
  }

  async function resolveLegAttempt(leg) {
    if (leg.resolved) return true;
    try {
      let mk = null;
      if (leg.conditionId) {
        const arr = await getJSON(`${GAMMA}/markets?condition_ids=${encodeURIComponent(leg.conditionId)}`);
        mk = Array.isArray(arr) ? arr[0] : null;
      }
      if (!mk) {
        const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(leg.slug)}`);
        const event = Array.isArray(events) ? events[0] : null;
        mk = event ? (event.markets || [])[0] : null;
      }
      if (mk && mk.closed === true && mk.outcomePrices) {
        const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : mk.outcomePrices;
        const tokens = parseMarketTokens(mk);
        const upIdx = tokens.findIndex(t => String(t.token_id) === String(leg.upTokenId));
        const downIdx = tokens.findIndex(t => String(t.token_id) === String(leg.downTokenId));
        if (upIdx >= 0 && downIdx >= 0 && prices[upIdx] != null) {
          leg.resolved = true;
          leg.winner = parseFloat(prices[upIdx]) >= 0.5 ? 'up' : 'down';
          leg.resolutionMethod = 'official';
          log(`🏁 [${leg.slug}] resolved OFFICIAL — winner ${leg.winner.toUpperCase()}`);
          return true;
        }
      }
    } catch (e) {
      log(`⚠️ resolveLegAttempt(${leg.slug}) failed: ${e.message}`);
    }

    return false;
  }

  function tokenIdFor(leg, side) { return side === 'up' ? leg.upTokenId : leg.downTokenId; }
  function askFor(leg, side) { return side === 'up' ? leg.upAsk : leg.downAsk; }
  function bidFor(leg, side) { return side === 'up' ? leg.upBid : leg.downBid; }

  function heldShares(t, side) {
    const bought = (t.buys || []).filter(b => b.side === side).reduce((s, b) => s + b.shares, 0);
    const sold = (t.sells || []).filter(x => x.side === side).reduce((s, x) => s + x.shares, 0);
    return round2(bought - sold);
  }
  function totalSellProceeds(t) {
    if (!t || !t.sells || !t.sells.length) return 0;
    return round2(t.sells.reduce((s, x) => s + x.proceeds, 0));
  }

  // Buy `dollars` worth of `side` on this window's leg at the ask (taker).
  async function buyLeg(t, side, dollars, what) {
    const leg = t.leg;
    const tokenId = tokenIdFor(leg, side);
    const ask = askFor(leg, side);
    if (!tokenId || ask == null) return { ok: false, reason: 'no-ask' };
    const shares = round2(dollars / ask);
    if (shares < MIN_ORDER_SHARES) return { ok: false, reason: `below-min-shares (${shares}sh)` };
    const resp = await placeTakerBuy(tokenId, ask, shares);
    if (!resp) return { ok: false, reason: 'place-failed' };
    if (!resp.filledNow) return { ok: false, reason: 'not-filled' };
    const avgPrice = resp.avgPrice || ask;
    const filled = resp.filledShares || shares;
    const notional = round2(filled * avgPrice);
    const fee = computeFee(filled, avgPrice);
    const rebate = round2(fee * rebatePct);
    const netFee = round2(fee - rebate);
    const cost = round2(notional + netFee);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    engine.totalRebatesEarned = round2(engine.totalRebatesEarned + rebate);
    engine.totalVolume = round2(engine.totalVolume + notional);
    engine.bankroll = round2(engine.bankroll - cost);
    const buy = { level: t.buys.length, ts: nowFn(), dollars, side, price: avgPrice, shares: filled, cost };
    t.buys.push(buy);
    t.lastSide = side;
    log(`${tfLabel()} 🎯 ${what} #${buy.level + 1} — ${side.toUpperCase()} $${dollars.toFixed(2)} @${avgPrice.toFixed(3)} = ${filled.toFixed(2)}sh (cost $${cost.toFixed(2)})`);
    return { ok: true, shares: filled, avgPrice, notional, fee, rebate, netFee, cost };
  }

  async function maybeEntry(t) {
    const inMart = t.currentMartLevel > 0;
    if (t.buys.length && !inMart) { t.phase = 'trading'; return; }

    // #5 Time-to-close guard: don't enter if window is about to end.
    const now = nowFn();
    const msLeft = t.closeAt - now;
    if (msLeft < MIN_SECONDS_LEFT * 1000) {
      if (!inMart) { t.skipped = true; t.phase = 'resolved'; }
      return;
    }

    // Determine which side to monitor for entry.
    let side;
    if (inMart) {
      const askUp = askFor(t.leg, 'up');
      const askDn = askFor(t.leg, 'down');
      const upOk = askUp != null && askUp >= entryPrice;
      const dnOk = askDn != null && askDn >= entryPrice;
      if (upOk && dnOk) side = askUp <= askDn ? 'up' : 'down';
      else if (upOk) side = 'up';
      else if (dnOk) side = 'down';
      else return;
    } else {
      side = leadingSide(t.leg);
      if (!side) return;
    }

    const ask = askFor(t.leg, side);
    const oppSide = side === 'up' ? 'down' : 'up';
    const oppAsk = askFor(t.leg, oppSide);

    if (!inMart) {
      // #2 Momentum confirmation: price must be >= entryPrice for MOMENTUM_HOLD_MS.
      if (ask == null || ask < entryPrice) {
        t.entryPriceAboveSince = 0;
        return;
      }
      if (t.entryPriceAboveSince === 0) {
        t.entryPriceAboveSince = now;
        log(`${tfLabel()} ⏳ momentum hold started — ${side.toUpperCase()} @${ask.toFixed(3)} >= ${entryPrice}, waiting ${MOMENTUM_HOLD_MS / 1000}s`);
        return;
      }
      if (now - t.entryPriceAboveSince < MOMENTUM_HOLD_MS) {
        return; // still holding
      }

      // #4 Entry price cap: reject if ask is too high.
      if (ask > MAX_ENTRY_PRICE) {
        log(`${tfLabel()} ⛔ entry rejected — ${side.toUpperCase()} @${ask.toFixed(3)} above max ${MAX_ENTRY_PRICE}`);
        t.entryPriceAboveSince = 0;
        return;
      }

      // #3 Divergence check: opposite side must not be converging.
      if (oppAsk != null) {
        const gap = ask - oppAsk;
        if (gap < DIVERGENCE_MIN) {
          log(`${tfLabel()} ⛔ entry rejected — gap too narrow (${side.toUpperCase()} ${ask.toFixed(3)} vs ${oppSide.toUpperCase()} ${oppAsk.toFixed(3)} = ${gap.toFixed(3)} < ${DIVERGENCE_MIN})`);
          t.entryPriceAboveSince = 0;
          return;
        }
      }
    }

    const dollars = inMart ? round2(entryDollars * Math.pow(martingaleMultiplier, t.currentMartLevel)) : entryDollars;
    const res = await buyLeg(t, side, dollars, inMart ? `martingale ${t.currentMartLevel + 1}` : 'entry');
    if (res.ok) {
      t.phase = 'trading';
      t.highAskSeen = false;
      t.highSideAsk = null;
      t.stopLossTriggered = false;
      t.entryPriceAboveSince = 0;
      if (inMart) {
        t.lastSide = side;
        engine.maxMartCount = (engine.maxMartCount || 0) + 1;
        log(`${tfLabel()} 🎯 martingale #${t.currentMartLevel + 1} entry — ${side.toUpperCase()} $${dollars.toFixed(2)} @${res.avgPrice.toFixed(3)} (1.5x instant)`);
      } else {
        log(`${tfLabel()} 🚦 entry — ${side.toUpperCase()} $${dollars.toFixed(2)} @${res.avgPrice.toFixed(3)} (held ${MOMENTUM_HOLD_MS / 1000}s above ${entryPrice})`);
      }
    } else if (res.reason && res.reason !== 'no-ask') {
      log(`⚠️ ${tfLabel()} entry skipped: ${res.reason}`);
    }
  }

  async function maybeMartingale(t) {
    if (!t.lastSide) return;
    const bid = bidFor(t.leg, t.lastSide);
    if (bid != null && bid <= stopLossPrice) {
      const qty = heldShares(t, t.lastSide);
      if (qty > 0) {
        const sellRes = await sellLeg(t, t.lastSide, qty, stopLossPrice);
        if (sellRes && sellRes.ok) {
          const stoppedCost = totalCostOf(t);
          const stoppedRecovered = totalSellProceeds(t);
          const stoppedPnl = round2(stoppedRecovered - stoppedCost);
          log(`${tfLabel()} 🛑 STOP LOSS — sold ${t.lastSide.toUpperCase()} ${qty.toFixed(2)}sh @${(sellRes.avgPrice || stopLossPrice).toFixed(3)} (bid <= ${stopLossPrice}) | cost ${stoppedCost.toFixed(2)} recovered ${stoppedRecovered.toFixed(2)} P&L ${sgn2(stoppedPnl)}`);
        }
      }
      t.stopLossTriggered = true;
      t.currentMartLevel = (t.currentMartLevel || 0) + 1;
      if (t.currentMartLevel > maxMartingaleLevels) {
        t.reachedMax = true;
        t.lastSide = null;
        t.highAskSeen = false;
        t.highSideAsk = null;
        log(`${tfLabel()} ⚠️ MAX MARTINGALE LEVELS (${maxMartingaleLevels}) reached — no more entries this window`);
        return;
      }
      t.highAskSeen = false;
      t.highSideAsk = null;
      t.phase = 'awaiting-trigger';
      if (t.leg.discovered && t.leg.upTokenId) await refreshLegPrices(t.leg);
      log(`${tfLabel()} 🔄 ready for martingale #${t.currentMartLevel + 1} — flip to ${t.lastSide === 'up' ? 'DOWN' : 'UP'} — monitoring for ${entryPrice}+ entry`);
    }
  }

  function freshTrade(windowTs) {
    const wsec = winSec();
    return {
      windowTs,
      closeAt: (windowTs + wsec) * 1000,
      waitUntil: (windowTs + waitSec()) * 1000,
      waitSeconds: waitSec(),
      leg: freshLeg(windowTs, wsec, `btc-updown-${windowType}-`),
      phase: 'waiting',
      buys: [],
      sells: [],
      pendingSells: [],
      lastSide: null,
      highSideAsk: null,
      highAskSeen: false,
      stopLossTriggered: false,
      currentMartLevel: 0,
      reachedMax: false,
      pnl: null,
      win: null,
      skipped: false,
      settled: false,
      entryPriceAboveSince: 0,
      prevOppositePrice: null,
    };
  }

  async function ensureTrade(now) {
    const nowSec = Math.floor(now / 1000);
    const wsec = winSec();
    const windowTs = Math.floor(nowSec / wsec) * wsec;
    let t = engine.current;

    if (!t || t.windowTs !== windowTs) {
      if (t && !t.settled) {
        await flushPendingSells(t); // close anything still open before we settle
        if (!t.leg.resolved) await attemptFastResolution(t.leg);
        if (t.leg.resolved && !t.settled) settle(t);
        else {
          t.phase = 'pending-resolution';
          engine.pending.push(t);
          if (engine.pending.length > 40) {
            const dropped = engine.pending.shift();
            log(`⚠️ ${tfLabel()} dropped oldest pending trade [${dropped.leg.slug}] — pending queue exceeded 40; unresolved cost $${totalCostOf(dropped).toFixed(2)} may not settle`);
          }
        }
      }
      t = freshTrade(windowTs);
      engine.current = t;
      log(`${tfLabel()} 🆕 window t=${windowTs} opened — waiting ${waitSec()}s before monitoring for ${entryPrice}+ entry`);
    }

    if (t.phase === 'waiting' && now >= t.waitUntil) {
      t.phase = 'awaiting-trigger';
      // The wait just ended — pull FRESH prices so the entry (and any instant
      // flip check) never fires on stale pre-wait 0.50/0.50 snapshots.
      log(`${tfLabel()} ⏱ wait over (t=${t.windowTs}) — monitoring for ${entryPrice}+ entry`);
    }

    if (!t.leg.discovered && now - t.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
      t.leg.lastDiscoveryAttempt = now;
      await discoverLeg(t.leg);
    }
    if (!t.leg.discovered || !engine.tradingEnabled || now >= t.closeAt || t.settled) return;

    const secsIntoWindow = (now - t.windowTs * 1000) / 1000;
    const noNewEntry = false;

    if (t.phase === 'awaiting-trigger' && !noNewEntry) {
      await maybeEntry(t);
    } else if (t.phase === 'trading') {
      await maybeMartingale(t);
      await processPendingSells(t);
    }
  }

  function settle(t) {
    if (t.settled) return;
    const leg = t.leg;
    const winner = leg.winner || null;
    const buys = t.buys;
    const totalCost = totalCostOf(t);
    const sellProceeds = totalSellProceeds(t);
    // Only the FINAL held side remains at resolution — every side that was
    // flipped away was already sold (closing the loser). payout = held shares.
    let payout = 0;
    if (winner) payout = round2(heldShares(t, winner));
    const pnl = round2(payout + sellProceeds - totalCost);
    engine.bankroll = round2(engine.bankroll + payout);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);

    const betPlaced = buys.length > 0;
    let win = null;
    if (betPlaced && winner) {
      win = pnl > 0;
      engine.wins = engine.wins + (win ? 1 : 0);
      engine.losses = engine.losses + (win ? 0 : 1);
    }
    t.pnl = pnl;
    t.win = win;
    t.winner = winner;
    t.skipped = !betPlaced;
    t.settled = true;
    t.phase = 'resolved';

    engine.history.unshift({
      windowTs: t.windowTs, slug: leg.slug, winner, resolutionMethod: leg.resolutionMethod,
      entrySide: buys.length ? buys[0].side : null,
      lastSide: t.lastSide,
      legs: buys.map(b => ({ level: b.level, dollars: b.dollars, side: b.side, price: b.price, shares: b.shares, cost: b.cost, ts: b.ts })),
      sells: (t.sells || []).map(x => ({ side: x.side, ts: x.ts, shares: x.shares, price: x.price, proceeds: x.proceeds })),
      sellProceeds,
      stopLossCount: t.currentMartLevel || 0,
      martingaleLevels: buys.length,
      reachedMaxMartingale: t.reachedMax,
      betPlaced, skipped: !betPlaced, win,
      wager: totalCost, payout, pnl, bankrollAfter: engine.bankroll, resolvedAt: nowFn(),
    });
    const hist = engine.history;
    if (hist.length > 300) hist.pop();
    registerTrade('5', { slug: leg.slug, winner, legs: buys.length, sells: (t.sells || []).length, recovered: sellProceeds, pnl });

    const summary = winner ? `winner ${winner.toUpperCase()}` : 'winner unknown';
    if (!betPlaced) {
      log(`🏁 ${tfLabel()} [${leg.slug}] resolved (${leg.resolutionMethod || '?'}) — ${summary} — NO bet placed`);
    } else {
      log(`🏁 ${tfLabel()} [${leg.slug}] resolved — ${summary} — ${buys.length} leg(s), ${win ? 'WIN' : 'LOSS'} ${sgn2(pnl)} (cost $${totalCost.toFixed(2)}, payout $${payout.toFixed(2)}, recovered $${sellProceeds.toFixed(2)})`);
    }
    recordEquity();
  }

  function computeDrawdown(curve) {
    let peak = -Infinity;
    let peakT = null;
    let maxPct = 0;
    let maxDollars = 0;
    let troughT = null;
    for (const p of curve) {
      if (p.equity > peak) { peak = p.equity; peakT = p.t; }
      const dd = peak > 0 ? (peak - p.equity) / peak : 0;
      if (dd > maxPct) { maxPct = dd; maxDollars = peak - p.equity; troughT = p.t; }
    }
    return { pct: round2(maxPct), dollars: round2(maxDollars), peakT, troughT };
  }

  // ── dashboard state ────────────────────────────────────────────
  async function refreshLegPrices(leg) {
    if (!leg.upTokenId || !leg.downTokenId) return;
    try {
      const [upMid, downMid] = await Promise.all([
        getJSON(`${CLOB}/midpoint?token_id=${leg.upTokenId}`).catch(() => null),
        getJSON(`${CLOB}/midpoint?token_id=${leg.downTokenId}`).catch(() => null),
      ]);
      if (upMid?.mid != null) { leg.upAsk = parseFloat(upMid.mid); leg.upBid = parseFloat(upMid.mid); }
      if (downMid?.mid != null) { leg.downAsk = parseFloat(downMid.mid); leg.downBid = parseFloat(downMid.mid); }
    } catch (_) {}
  }

  function legSummary(leg) {
    return {
      slug: leg.slug,
      conditionId: leg.conditionId,
      upTokenId: leg.upTokenId, downTokenId: leg.downTokenId,
      upAsk: leg.upAsk, downAsk: leg.downAsk,
      upBid: leg.upBid, downBid: leg.downBid,
      discovered: leg.discovered,
      resolved: leg.resolved, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
    };
  }
  function tradeSummary(t) {
    if (!t) return null;
    const heldUp = heldShares(t, 'up');
    const heldDown = heldShares(t, 'down');
    const upMark = markPrice(t.leg, 'up');
    const downMark = markPrice(t.leg, 'down');
    const mtmUp = heldUp > 0 && upMark != null ? round2(heldUp * upMark) : 0;
    const mtmDown = heldDown > 0 && downMark != null ? round2(heldDown * downMark) : 0;
    const mtmTotal = round2(mtmUp + mtmDown);
    return {
      windowTs: t.windowTs, closeAt: t.closeAt, waitUntil: t.waitUntil,
      phase: t.phase, waitSeconds: t.waitSeconds,
      leg: legSummary(t.leg),
      buys: t.buys,
      sells: t.sells,
      pendingSells: t.pendingSells,
      sellProceeds: totalSellProceeds(t),
      lastSide: t.lastSide,
      martingaleLevel: t.buys.length,
      reachedMaxMartingale: t.reachedMax,
      totalCost: totalCostOf(t),
      entryPrice: t.buys.length ? t.buys[0].price : null,
      pnl: t.pnl, win: t.win, skipped: t.skipped,
      unrealizedPnl: unrealizedFor(t),
      heldUp, heldDown, mtmUp, mtmDown, mtmTotal,
      upMark, downMark,
      countdownMs: t.phase === 'waiting' ? Math.max(0, t.waitUntil - nowFn()) : null,
      secsLeft: Math.max(0, Math.floor((t.closeAt - nowFn()) / 1000)),
    };
  }
  function baseState() {
    return {
      dryRun: DRY_RUN,
      tradingEnabled: engine.tradingEnabled,
      waitingForBoundary: engine.waitingForBoundary,
      startingCapital: capital5,
      realizedPnlTotal: engine.realizedPnl,
      totalFeesPaid: engine.totalFeesPaid,
      totalRebatesEarned: engine.totalRebatesEarned,
      totalVolume: engine.totalVolume,
      feeTheta, rebatePct,
      entryPrice,
      stopLossPrice,
      winnerPrice: WINNER_PRICE,
      entryDollars,
      martingaleMultiplier,
      maxMartingaleLevels,
      logs: engine.logs.slice(-80),
      boundaryWindowTs: engine.boundaryWindowTs,
    };
  }
  function buildState() {
    const decided = engine.wins + engine.losses;
    const curve = engine.equityCurve;
    const allOpen = allTrackedTrades();
    const totalOutstandingCost = round2(allOpen.reduce((s, t) => s + totalCostOf(t), 0));
    const totalMTM = round2(allOpen.reduce((s, t) => {
      const hUp = heldShares(t, 'up'), hDown = heldShares(t, 'down');
      const upP = markPrice(t.leg, 'up'), downP = markPrice(t.leg, 'down');
      return s + (hUp > 0 && upP != null ? hUp * upP : 0) + (hDown > 0 && downP != null ? hDown * downP : 0);
    }, 0));
    const totalUnrealized = round2(totalMTM - totalOutstandingCost + round2(allOpen.reduce((s, t) => s + totalSellProceeds(t), 0)));
    return {
      ...baseState(),
      label: label,
      windowSeconds: winSec(),
      waitSeconds: waitSec(),
      bankroll: engine.bankroll,
      startingCapital: capital5,
      equity: round2(engine.bankroll + totalMTM),
      equityCurve: curve,
      maxDrawdown: computeDrawdown(curve),
      realizedPnl: engine.realizedPnl,
      totalUnrealized,
      totalMTM,
      totalOutstandingCost,
      wins: engine.wins,
      losses: engine.losses,
      windowsDecided: decided,
      windowsReachedMaxMartingale: engine.maxMartCount || 0,
      winRate: decided > 0 ? round2(engine.wins / decided) : null,
      current: { btc: tradeSummary(engine.current) },
      pending: engine.pending.map(tradeSummary),
      history: engine.history.slice(0, 60),
      trades: engine.trades.slice(-100).slice().reverse(),
      pendingResolutionCount: engine.pending.length,
    };
  }
  function emitState() {
    emit('hedgeState:' + label, buildState());
  }

  function pauseTrading() {
    engine.tradingEnabled = false;
    log('⏸️  Trading paused — no new entries or flips; open positions still tracked to resolution');
    return { ok: true };
  }
  function resumeTrading() {
    engine.tradingEnabled = true;
    log('▶️  Trading resumed');
    return { ok: true };
  }
  function setMode(live) {
    DRY_RUN = !live;
    log(`⚙️  Switched to ${live ? '🔴 LIVE' : '⚠️  DEMO'} mode`);
    return { ok: true, dryRun: DRY_RUN };
  }

  function allTrackedTrades() {
    return [engine.current, ...engine.pending].filter(Boolean);
  }

  async function mainLoop() {
    while (true) {
      try {
        const now = nowFn();
        const nowSec = Math.floor(now / 1000);

        if (engine.waitingForBoundary) {
          engine.waitingForBoundary = false;
        }

        if (!engine.waitingForBoundary) {
          await ensureTrade(now);
        }


        if (engine.pending.length && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
          engine.lastResolutionPoll = now;
          const still = [];
          for (const trade of engine.pending) {
            if (!trade.leg.resolved) await resolveLegAttempt(trade.leg);
            if (trade.leg.resolved && !trade.settled) settle(trade);
            if (!trade.settled) still.push(trade);
          }
          engine.pending = still;
        }
        if (now - engine.lastPriceFetch >= priceRefreshMs) {
          engine.lastPriceFetch = now;
          await Promise.all(allTrackedTrades().map(t => refreshLegPrices(t.leg)));
        }
        if (now - engine.lastEquityRecord >= EQUITY_RECORD_MS) {
          engine.lastEquityRecord = now;
          recordEquity();
        }

        emitState();
      } catch (e) {
        slog(`[${label.toLowerCase()}] ⚠️ Loop error: ${e.message}`);
      }
      await new Promise(res => setTimeout(res, tickMs));
    }
  }

  async function start() {
    slog(`[${label.toLowerCase()}] ⛏ ${label} — BTC 5m martingale engine, fully automatic`);
    slog(`[${label.toLowerCase()}] ⚙️  Wait 30s after window open, fire when any side pulls to ~${entryPrice}.`);
    slog(`[${label.toLowerCase()}] ⚙️  Entry: buy when price pulls to ~${entryPrice} after the wait time. Stop loss at ${stopLossPrice} (force sell). Martingale: ${martingaleMultiplier}x re-entry (max ${maxMartingaleLevels} level). Side above ${WINNER_PRICE.toFixed(2)} at window end wins.`);
    slog(`[${label.toLowerCase()}] ⚙️  Capital: $${capital5.toFixed(2)}. Fees: ${rebatePct > 0 ? (rebatePct * 100).toFixed(0) + '% rebate' : 'no rebate'}.`);
    if (savedStats) {
      slog(`[${label.toLowerCase()}] 💾 Restored — bankroll $${engine.bankroll.toFixed(2)}, ${engine.wins}W/${engine.losses}L, max-mart: ${engine.maxMartCount}`);
    } else if (statsStatePath) {
      slog(`[${label.toLowerCase()}] 💾 Fresh start — $${capital5.toFixed(2)}. Stats persist to ${statsStatePath}.`);
    }
    mainLoop().catch(e => slog(`[${label.toLowerCase()}] ❌ Fatal: ${e.message}`));
  }



  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine };
