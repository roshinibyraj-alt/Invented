'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 0.60 MARTINGALE ENGINE — 5m and 15m Up/Down windows
 * ═══════════════════════════════════════════════════════════════
 *
 *  COMPLETE replacement of the old momentum/hedge logic.
 *
 *  New strategy, per window (5m and 15m windows are independent):
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
 *     flips after 280s into a 5m window or 870s into a 15m window.
 *  4. At window end, whichever side's price is above 0.90 is declared
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
const { createCandleFeed } = require('./candles');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS                = 500;
const PRICE_REFRESH_MS       = 1000;
const DISCOVERY_RETRY_MS     = 2000;
const RESOLUTION_POLL_MS     = 3000;
const MIN_ORDER_SHARES       = 1;
const RESOLUTION_FALLBACK_MS = 60000;
const EQUITY_RECORD_MS       = 5000;

const TRIGGER_PRICE      = 0.60; // legacy entry reference (kept for state/UI)
const FLIP_TRIGGER_PRICE = 0.50; // martingale: fire instantly at 0.50+
const WINNER_PRICE       = 0.90; // resolution: side above 0.90 wins

function round2(n) { return Math.round(n * 100) / 100; }
function sgn2(n) { return (n > 0 ? '+$' : (n < 0 ? '-$' : '±$')) + Math.abs(n).toFixed(2); }

function createEngine(cfg) {
  const {
    label = 'BTC-0.60-MART',
    startingCapital = 4000,
    startingCapital5,
    startingCapital15,
    flipCutoffSeconds5 = 280,
    flipCutoffSeconds15 = 870,
    sellDelayMs = 2000,
    entryDollars = 50,
    martingaleAmounts = [100],
    maxFlips = 1,
    waitSeconds5 = 120,
    waitSeconds15 = 360,
    windowSeconds15 = 900,
    windowSeconds5 = 300,
    feeTheta = 0.07,
    rebatePct = 0,
    triggerSlip = 0.02,
    candleRefreshMs = 15000,
    trader,
    dryRun = true,
    startAtBoundary = false,
    statsStatePath,
    emit = () => {},
    slog = () => {},
    nowFn = Date.now,
    tickMs = TICK_MS,
  } = cfg;

  const candles15 = createCandleFeed({ interval: '15m', maxCandles: 500, label: '15m' });
  const candles5  = createCandleFeed({ interval: '5m', maxCandles: 500, label: '5m' });

  const window15 = windowSeconds15;
  const window5 = windowSeconds5;
  const tradeSeq = { '5': 0, '15': 0 };

  // Separate demo capital per timeframe (default: split startingCapital evenly).
  const capital5 = startingCapital5 != null ? round2(startingCapital5) : round2(startingCapital / 2);
  const capital15 = startingCapital15 != null ? round2(startingCapital15) : round2(startingCapital - capital5);

  let DRY_RUN = dryRun;
  let warnedNoRestingMethod = false;
  let warnedNoCancelMethod = false;
  let warnedNoSellMethod = false;

  function loadStats() {
    if (!statsStatePath) return null;
    try {
      const raw = fs.readFileSync(statsStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && (typeof parsed.bankroll5 === 'number' || typeof parsed.bankroll15 === 'number')) return parsed;
    } catch (_) {}
    return null;
  }
  const savedStats = loadStats();

  const engine = {
    tradingEnabled: true,
    bankroll5: savedStats && typeof savedStats.bankroll5 === 'number' ? savedStats.bankroll5 : capital5,
    bankroll15: savedStats && typeof savedStats.bankroll15 === 'number' ? savedStats.bankroll15 : capital15,
    realizedPnl5: savedStats ? savedStats.realizedPnl5 : 0,
    realizedPnl15: savedStats ? savedStats.realizedPnl15 : 0,
    wins5: savedStats ? savedStats.wins5 : 0,
    losses5: savedStats ? savedStats.losses5 : 0,
    wins15: savedStats ? savedStats.wins15 : 0,
    losses15: savedStats ? savedStats.losses15 : 0,
    maxMartCount5: savedStats ? (savedStats.maxMartCount5 || savedStats.mart3Count5 || 0) : 0,
    maxMartCount15: savedStats ? (savedStats.maxMartCount15 || savedStats.mart3Count15 || 0) : 0,
    history5: savedStats && Array.isArray(savedStats.history5) ? savedStats.history5 : [],
    history15: savedStats && Array.isArray(savedStats.history15) ? savedStats.history15 : [],
    trades5: [],
    trades15: [],
    logs: [],
    equityCurve5: savedStats && Array.isArray(savedStats.equityCurve5) && savedStats.equityCurve5.length
      ? savedStats.equityCurve5
      : [{ t: nowFn(), equity: capital5 }],
    equityCurve15: savedStats && Array.isArray(savedStats.equityCurve15) && savedStats.equityCurve15.length
      ? savedStats.equityCurve15
      : [{ t: nowFn(), equity: capital15 }],
    current: { '5': null, '15': null },
    pending: { '5': [], '15': [] },
    lastPriceFetch: 0,
    lastCandleRefresh: 0,
    lastResolutionPoll: 0,
    lastEquityRecord: 0,
    waitingForBoundary: true,
    boundaryWindowTs: null,
    totalFeesPaid: savedStats ? savedStats.totalFeesPaid || 0 : 0,
    totalRebatesEarned: savedStats ? savedStats.totalRebatesEarned || 0 : 0,
    totalVolume: savedStats ? savedStats.totalVolume || 0 : 0,
  };
  if (!startAtBoundary) engine.waitingForBoundary = false;

  function saveStats() {
    if (!statsStatePath) return;
    try {
      fs.writeFileSync(statsStatePath, JSON.stringify({
        bankroll5: engine.bankroll5,
        bankroll15: engine.bankroll15,
        realizedPnl: round2(engine.realizedPnl5 + engine.realizedPnl15),
        realizedPnl5: engine.realizedPnl5,
        realizedPnl15: engine.realizedPnl15,
        wins5: engine.wins5, losses5: engine.losses5,
        wins15: engine.wins15, losses15: engine.losses15,
        maxMartCount5: engine.maxMartCount5, maxMartCount15: engine.maxMartCount15,
        history5: engine.history5.slice(0, 100),
        history15: engine.history15.slice(0, 100),
        equityCurve5: engine.equityCurve5.slice(-300),
        equityCurve15: engine.equityCurve15.slice(-300),
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
  function registerTrade(tf, t) {
    const trade = { seq: ++tradeSeq[tf], time: new Date(nowFn()).toISOString().slice(11, 19), ...t };
    const list = tf === '5' ? engine.trades5 : engine.trades15;
    list.push(trade);
    if (list.length > 300) list.shift();
  }
  function tfLabel(tf) { return tf === '5' ? '5m' : '15m'; }
  function winSec(tf) { return tf === '5' ? window5 : window15; }
  function waitSec(tf) { return tf === '5' ? waitSeconds5 : waitSeconds15; }

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
    engine.equityCurve5.push({ t: nowFn(), equity: round2(engine.bankroll5 + positionMTM(engine.current['5'])) });
    engine.equityCurve15.push({ t: nowFn(), equity: round2(engine.bankroll15 + positionMTM(engine.current['15'])) });
    if (engine.equityCurve5.length > 2000) engine.equityCurve5.shift();
    if (engine.equityCurve15.length > 2000) engine.equityCurve15.shift();
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
  async function sellLeg(t, side, qty) {
    const leg = t.leg;
    const tokenId = tokenIdFor(leg, side);
    const held = heldShares(t, side);
    const sellQty = round2(Math.min(qty == null ? held : qty, held));
    if (!tokenId || sellQty <= 0) return { ok: false, reason: 'nothing-held' };
    const bid = bidFor(leg, side);
    if (bid == null) return { ok: false, reason: 'no-bid' };
    const resp = await placeTakerSell(tokenId, sellQty);
    if (!resp || !resp.filledNow) return { ok: false, reason: 'sell-not-filled' };
    const avgPrice = resp.avgPrice != null ? resp.avgPrice : bid;
    const gross = round2(sellQty * avgPrice);
    const fee = computeFee(sellQty, avgPrice);
    const netFee = round2(fee - round2(fee * rebatePct));
    const proceeds = round2(gross - netFee);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    engine.totalVolume = round2(engine.totalVolume + gross);
    engine[`bankroll${t.tf}`] = round2(engine[`bankroll${t.tf}`] + proceeds);
    t.sells.push({ side, ts: nowFn(), shares: sellQty, price: avgPrice, proceeds });
    log(`${tfLabel(t.tf)} 🧹 closed losing side ${side.toUpperCase()} — sold ${sellQty.toFixed(2)}sh @${avgPrice.toFixed(3)} (recovered $${proceeds.toFixed(2)})`);
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
        log(`⚠️ ${tfLabel(t.tf)} pending sell ${side.toUpperCase()} ${totals[side].toFixed(2)}sh failed (${result?.reason || 'unknown'}) — shares lost at window close`);
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
        log(`⚠️ ${tfLabel(t.tf)} flush-sell ${side.toUpperCase()} ${totals[side].toFixed(2)}sh failed (${result?.reason || 'unknown'}) — shares expire worthless`);
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
      const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(leg.slug)}`);
      const event = Array.isArray(events) ? events[0] : null;
      if (!event) return;
      const mk = (event.markets || [])[0];
      if (!mk) return;
      const tokens = parseMarketTokens(mk);
      const up = tokens.find(t => /up/i.test(t.outcome));
      const down = tokens.find(t => /down/i.test(t.outcome));
      if (!up || !down || !up.token_id || !down.token_id) return;
      leg.conditionId = mk.conditionId || null;
      leg.upTokenId = up.token_id;
      leg.downTokenId = down.token_id;
      leg.discovered = true;
      log(`🎯 leg discovered ${leg.slug} — Up ${String(up.token_id).slice(0, 10)}… / Down ${String(down.token_id).slice(0, 10)}…`);
    } catch (e) {
      log(`⚠️ discoverLeg(${leg.slug}) failed: ${e.message}`);
    }
  }

  async function refreshLegPrices(leg) {
    if (!leg.upTokenId || !leg.downTokenId) return;
    try {
      const [upAsk, upBid, downAsk, downBid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${leg.upTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${leg.upTokenId}&side=SELL`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${leg.downTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${leg.downTokenId}&side=SELL`).catch(() => null),
      ]);
      if (upAsk?.price != null) leg.upAsk = parseFloat(upAsk.price);
      if (upBid?.price != null) leg.upBid = parseFloat(upBid.price);
      if (downAsk?.price != null) leg.downAsk = parseFloat(downAsk.price);
      if (downBid?.price != null) leg.downBid = parseFloat(downBid.price);
    } catch (_) {}
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
    await refreshLegPrices(leg);
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
    return false; // not decided yet — keep polling official/fallback resolution
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
    if (nowFn() - leg.closeAt >= RESOLUTION_FALLBACK_MS) {
      const upP = markPrice(leg, 'up');
      const downP = markPrice(leg, 'down');
      let winner = null;
      if (upP != null && upP > WINNER_PRICE) winner = 'up';
      else if (downP != null && downP > WINNER_PRICE) winner = 'down';
      else winner = leadingSide(leg); // safety net if neither side crossed 0.90
      if (winner) {
        leg.resolved = true;
        leg.winner = winner;
        leg.resolutionMethod = 'price-fallback';
        log(`⌛ [${leg.slug}] resolved PRICE-FALLBACK — winner ${winner.toUpperCase()}`);
        return true;
      }
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
    engine[`bankroll${t.tf}`] = round2(engine[`bankroll${t.tf}`] - cost);
    const buy = { level: t.buys.length, ts: nowFn(), dollars, side, price: avgPrice, shares: filled, cost };
    t.buys.push(buy);
    t.lastSide = side;
    log(`${tfLabel(t.tf)} 🎯 ${what} #${buy.level + 1} — ${side.toUpperCase()} $${dollars.toFixed(2)} @${avgPrice.toFixed(3)} = ${filled.toFixed(2)}sh (cost $${cost.toFixed(2)})`);
    return { ok: true, shares: filled, avgPrice, notional, fee, rebate, netFee, cost };
  }

  async function maybeEntry(t) {
    if (t.buys.length) { t.phase = 'trading'; return; }
    // After the wait the entry fires on ANY price — buy the leading
    // (higher-priced) side for $10; no waiting for the price to come back.
    const side = leadingSide(t.leg);
    if (!side) return; // no prices yet — retry on the next refresh
    const res = await buyLeg(t, side, entryDollars, 'entry');
    if (res.ok) {
      t.phase = 'trading';
      log(`${tfLabel(t.tf)} 🚦 entry fired on leading side ${side.toUpperCase()} $${entryDollars.toFixed(2)} @${res.avgPrice.toFixed(3)} (any price)`);
    } else if (res.reason && res.reason !== 'no-ask') {
      log(`⚠️ ${tfLabel(t.tf)} entry skipped: ${res.reason}`);
    }
  }

  async function maybeFlip(t) {
    const level = t.buys.length; // next martingale leg index (1..maxFlips)
    if (level <= 0 || level > maxFlips) return;
    if (!t.lastSide) return;
    // No flips in the final stretch of the window: after 280s (5m) / 870s (15m).
    const cutoff = (t.windowTs + (t.tf === '5' ? flipCutoffSeconds5 : flipCutoffSeconds15)) * 1000;
    if (nowFn() >= cutoff) return;
    const opp = t.lastSide === 'up' ? 'down' : 'up';
    const oppAsk = askFor(t.leg, opp);
    // Martingale fires INSTANTLY as soon as the opposite side's price reaches
    // 0.50 — no waiting for it to come back and no transition guard.
    if (oppAsk == null || oppAsk < FLIP_TRIGGER_PRICE) return;
    const prevSide = t.lastSide;
    const prevQty = heldShares(t, prevSide); // losing-side shares to close after the flip
    const dollars = martingaleAmounts[level - 1];
    const res = await buyLeg(t, opp, dollars, `martingale ${level}`);
    if (res.ok) {
      // Flip FIRST, then close that losing-side quantity ~2s later at the current bid.
      t.pendingSells.push({ side: prevSide, qty: prevQty, at: nowFn() + sellDelayMs });
      if (level === maxFlips) {
        t.reachedMax = true;
        engine[`maxMartCount${t.tf}`] = (engine[`maxMartCount${t.tf}`] || 0) + 1;
        log(`${tfLabel(t.tf)} ⚠️ MAX MARTINGALE ($${dollars.toFixed(2)}) reached — this window is at max risk`);
      }
      log(`${tfLabel(t.tf)} 🔄 flipped to ${opp.toUpperCase()} with $${dollars.toFixed(2)} @${res.avgPrice.toFixed(3)} (0.50+ instant)`);
    } else if (res.reason && res.reason !== 'no-ask') {
      log(`⚠️ ${tfLabel(t.tf)} martingale ${level} skipped: ${res.reason}`);
    }
  }

  function freshTrade(tf, windowTs) {
    const wsec = winSec(tf);
    return {
      tf,
      windowTs,
      closeAt: (windowTs + wsec) * 1000,
      waitUntil: (windowTs + waitSec(tf)) * 1000,
      waitSeconds: waitSec(tf),
      leg: freshLeg(windowTs, wsec, `btc-updown-${tf}m-`),
      phase: 'waiting',
      buys: [],
      sells: [],
      pendingSells: [],
      lastSide: null,
      reachedMax: false,
      pnl: null,
      win: null,
      skipped: false,
      settled: false,
    };
  }

  async function ensureTrade(tf, now) {
    const nowSec = Math.floor(now / 1000);
    const wsec = winSec(tf);
    const windowTs = Math.floor(nowSec / wsec) * wsec;
    let t = engine.current[tf];

    if (!t || t.windowTs !== windowTs) {
      if (t && !t.settled) {
        await flushPendingSells(t); // close anything still open before we settle
        if (!t.leg.resolved) await attemptFastResolution(t.leg);
        if (t.leg.resolved && !t.settled) settle(t);
        else {
          t.phase = 'pending-resolution';
          engine.pending[tf].push(t);
          if (engine.pending[tf].length > 40) {
            const dropped = engine.pending[tf].shift();
            log(`⚠️ ${tfLabel(tf)} dropped oldest pending trade [${dropped.leg.slug}] — pending queue exceeded 40; unresolved cost $${totalCostOf(dropped).toFixed(2)} may not settle`);
          }
        }
      }
      t = freshTrade(tf, windowTs);
      engine.current[tf] = t;
      log(`${tfLabel(tf)} 🆕 window t=${windowTs} opened — waiting ${waitSec(tf)}s before firing the entry on the leading side (any price)`);
    }

    if (t.phase === 'waiting' && now >= t.waitUntil) {
      t.phase = 'awaiting-trigger';
      // The wait just ended — pull FRESH prices so the entry (and any instant
      // flip check) never fires on stale pre-wait 0.50/0.50 snapshots.
      if (t.leg.discovered && t.leg.upTokenId) await refreshLegPrices(t.leg);
      log(`${tfLabel(tf)} ⏱ wait over (t=${t.windowTs}) — firing the $${entryDollars.toFixed(2)} entry on the leading side`);
    }

    if (!t.leg.discovered && now - t.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
      t.leg.lastDiscoveryAttempt = now;
      await discoverLeg(t.leg);
    }
    if (!t.leg.discovered || !engine.tradingEnabled || now >= t.closeAt || t.settled) return;

    if (t.phase === 'awaiting-trigger') {
      await maybeEntry(t);
    } else if (t.phase === 'trading') {
      await maybeFlip(t);
      await processPendingSells(t); // close the losing side 2s after each flip
    }
  }

  function settle(t) {
    if (t.settled) return;
    const tf = t.tf;
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
    engine[`bankroll${tf}`] = round2(engine[`bankroll${tf}`] + payout);
    engine[`realizedPnl${tf}`] = round2(engine[`realizedPnl${tf}`] + pnl);

    const betPlaced = buys.length > 0;
    let win = null;
    if (betPlaced && winner) {
      win = pnl > 0;
      engine[`wins${tf}`] = engine[`wins${tf}`] + (win ? 1 : 0);
      engine[`losses${tf}`] = engine[`losses${tf}`] + (win ? 0 : 1);
    }
    t.pnl = pnl;
    t.win = win;
    t.winner = winner;
    t.skipped = !betPlaced;
    t.settled = true;
    t.phase = 'resolved';

    engine[`history${tf}`].unshift({
      tf,
      windowTs: t.windowTs, slug: leg.slug, winner, resolutionMethod: leg.resolutionMethod,
      entrySide: buys.length ? buys[0].side : null,
      lastSide: t.lastSide,
      legs: buys.map(b => ({ level: b.level, dollars: b.dollars, side: b.side, price: b.price, shares: b.shares, cost: b.cost, ts: b.ts })),
      sells: (t.sells || []).map(x => ({ side: x.side, ts: x.ts, shares: x.shares, price: x.price, proceeds: x.proceeds })),
      sellProceeds,
      martingaleLevels: buys.length,
      reachedMaxMartingale: t.reachedMax,
      betPlaced, skipped: !betPlaced, win,
      wager: totalCost, payout, pnl, bankrollAfter: engine[`bankroll${tf}`], resolvedAt: nowFn(),
    });
    const hist = engine[`history${tf}`];
    if (hist.length > 300) hist.pop();
    registerTrade(tf, { slug: leg.slug, winner, legs: buys.length, sells: (t.sells || []).length, recovered: sellProceeds, pnl });

    const summary = winner ? `winner ${winner.toUpperCase()}` : 'winner unknown';
    if (!betPlaced) {
      log(`🏁 ${tfLabel(tf)} [${leg.slug}] resolved (${leg.resolutionMethod || '?'}) — ${summary} — NO bet placed`);
    } else {
      log(`🏁 ${tfLabel(tf)} [${leg.slug}] resolved — ${summary} — ${buys.length} leg(s), ${win ? 'WIN' : 'LOSS'} ${sgn2(pnl)} (cost $${totalCost.toFixed(2)}, payout $${payout.toFixed(2)})`);
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
  function legSummary(leg) {
    return {
      slug: leg.slug,
      upAsk: leg.upAsk, downAsk: leg.downAsk,
      upBid: leg.upBid, downBid: leg.downBid,
      discovered: leg.discovered,
      resolved: leg.resolved, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
    };
  }
  function tradeSummary(t) {
    if (!t) return null;
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
      countdownMs: t.phase === 'waiting' ? Math.max(0, t.waitUntil - nowFn()) : null,
    };
  }
  function baseState() {
    return {
      dryRun: DRY_RUN,
      tradingEnabled: engine.tradingEnabled,
      waitingForBoundary: engine.waitingForBoundary,
      startingCapital5: capital5,
      startingCapital15: capital15,
      realizedPnlTotal: round2(engine.realizedPnl5 + engine.realizedPnl15),
      totalFeesPaid: engine.totalFeesPaid,
      totalRebatesEarned: engine.totalRebatesEarned,
      totalVolume: engine.totalVolume,
      feeTheta, rebatePct,
      triggerPrice: TRIGGER_PRICE,
      flipTriggerPrice: FLIP_TRIGGER_PRICE,
      winnerPrice: WINNER_PRICE,
      triggerSlip,
      entryDollars,
      martingaleAmounts,
      maxFlips,
      flipCutoffSeconds5, flipCutoffSeconds15,
      sellDelayMs,
      logs: engine.logs.slice(-80),
      boundaryWindowTs: engine.boundaryWindowTs,
    };
  }
  function buildStateTf(tf) {
    const decided = engine[`wins${tf}`] + engine[`losses${tf}`];
    const curve = engine[`equityCurve${tf}`];
    return {
      ...baseState(),
      label: tf === '5' ? 'BTC-5m' : 'BTC-15m',
      windowSeconds: winSec(tf),
      waitSeconds: waitSec(tf),
      bankroll: engine[`bankroll${tf}`],
      startingCapital: tf === '5' ? capital5 : capital15,
      equity: round2(engine[`bankroll${tf}`] + positionMTM(engine.current[tf])),
      equityCurve: curve,
      maxDrawdown: computeDrawdown(curve),
      realizedPnl: engine[`realizedPnl${tf}`],
      wins: engine[`wins${tf}`],
      losses: engine[`losses${tf}`],
      windowsDecided: decided,
      windowsReachedMaxMartingale: engine[`maxMartCount${tf}`] || 0,
      winRate: decided > 0 ? round2(engine[`wins${tf}`] / decided) : null,
      latestBtcPrice: tf === '5' ? candles5.latestClose() : candles15.latestClose(),
      current: { btc: tradeSummary(engine.current[tf]) },
      pending: engine.pending[tf].map(tradeSummary),
      history: engine[`history${tf}`].slice(0, 60),
      trades: engine[`trades${tf}`].slice(-100).slice().reverse(),
      pendingResolutionCount: engine.pending[tf].length,
    };
  }
  function emitState() {
    emit('hedgeState:BTC-5m', buildStateTf('5'));
    emit('hedgeState:BTC-15m', buildStateTf('15'));
  }
  function buildState() {
    return { m5: buildStateTf('5'), m15: buildStateTf('15') };
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
    return [
      engine.current['5'], engine.current['15'],
      ...engine.pending['5'], ...engine.pending['15'],
    ].filter(Boolean);
  }

  async function mainLoop() {
    while (true) {
      try {
        const now = nowFn();
        const nowSec = Math.floor(now / 1000);

        if (engine.waitingForBoundary) {
          if (engine.boundaryWindowTs == null) {
            const current15 = Math.floor(nowSec / window15) * window15;
            engine.boundaryWindowTs = nowSec > current15 ? current15 + window15 : current15;
            log(`⏳ starting ${nowSec > current15 ? 'mid-window — waiting for the next 15m boundary' : 'on a fresh 15m boundary'} (t=${engine.boundaryWindowTs}) before trading begins`);
          }
          if (nowSec >= engine.boundaryWindowTs) {
            engine.waitingForBoundary = false;
            log('🚦 new boundary reached — trading starts now');
          }
        }

        if (!engine.waitingForBoundary) {
          await ensureTrade('5', now);
          await ensureTrade('15', now);
        }

        if (now - engine.lastCandleRefresh >= candleRefreshMs) {
          engine.lastCandleRefresh = now;
          // display-only refresh — never block the trading loop on Binance
          Promise.all([candles15.refresh(log), candles5.refresh(log)]).catch(() => {});
        }
        if (now - engine.lastPriceFetch >= PRICE_REFRESH_MS) {
          engine.lastPriceFetch = now;
          await Promise.all(allTrackedTrades().map(t => refreshLegPrices(t.leg)));
        }
        if ((engine.pending['5'].length || engine.pending['15'].length) && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
          engine.lastResolutionPoll = now;
          for (const tf of ['15', '5']) {
            const still = [];
            for (const trade of engine.pending[tf]) {
              if (!trade.leg.resolved) await resolveLegAttempt(trade.leg);
              if (trade.leg.resolved && !trade.settled) settle(trade);
              if (!trade.settled) still.push(trade);
            }
            engine.pending[tf] = still;
          }
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
    if (startAtBoundary) {
      slog(`[${label.toLowerCase()}] ⛏ ${label} — 0.60 martingale engine (5m & 15m), fully automatic`);
      slog(`[${label.toLowerCase()}] ⚙️  startAtBoundary=true — trading begins at the next 15m boundary; until then no windows are opened.`);
    } else {
      slog(`[${label.toLowerCase()}] ⛏ ${label} — 0.60 martingale engine (5m & 15m), fully automatic`);
      slog(`[${label.toLowerCase()}] ⚙️  Starting immediately — 5m/15m windows are independent; each window waits its own 1m/3m then fires the entry on the leading side at any price.`);
    }
    slog(`[${label.toLowerCase()}] ⚙️  Window rules: wait ${waitSeconds5}s (5m) / ${waitSeconds15}s (15m) after open, then fire the $${entryDollars.toFixed(2)} entry on the LEADING side at ANY price (no wait for 0.60).`);
    slog(`[${label.toLowerCase()}] ⚙️  Martingale flip: $${martingaleAmounts.slice(0, maxFlips).join(' / ')} fires INSTANTLY when the opposite side's price reaches ${FLIP_TRIGGER_PRICE.toFixed(2)}+ (max ${maxFlips} flip${maxFlips === 1 ? '' : 's'} per window). ~${(sellDelayMs / 1000).toFixed(0)}s after the flip the losing side is SOLD at the current bid to recover capital. NO flips after ${flipCutoffSeconds5}s (5m) / ${flipCutoffSeconds15}s (15m). The side above ${WINNER_PRICE.toFixed(2)} at window end is the winner.`);
    slog(`[${label.toLowerCase()}] ⚙️  SEPARATE demo capital — 5m $${capital5.toFixed(2)}, 15m $${capital15.toFixed(2)} (no shared bankroll).`);
    slog(`[${label.toLowerCase()}] ⚙️  Fees: Polymarket taker fee = shares × ${feeTheta} × price × (1-price) (crypto category), ${rebatePct > 0 ? (rebatePct * 100).toFixed(0) + '% rebate applied' : 'no rebate configured'}.`);
    if (savedStats) {
      slog(`[${label.toLowerCase()}] 💾 Restored saved stats — bankroll 5m $${engine.bankroll5.toFixed(2)} / 15m $${engine.bankroll15.toFixed(2)}, 5m ${engine.wins5}W/${engine.losses5}L, 15m ${engine.wins15}W/${engine.losses15}L, max-martingale windows 5m:${engine.maxMartCount5} 15m:${engine.maxMartCount15}.`);
    } else if (statsStatePath) {
      slog(`[${label.toLowerCase()}] 💾 No previous saved stats — starting fresh at 5m $${capital5.toFixed(2)} / 15m $${capital15.toFixed(2)}. Stats persist to ${statsStatePath}.`);
    }
    await Promise.all([candles15.seed(slog), candles5.seed(slog)]);
    mainLoop().catch(e => slog(`[${label.toLowerCase()}] ❌ Fatal: ${e.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine };
