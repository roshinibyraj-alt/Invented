'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC 15m/5m HEDGE ENGINE (single combined strategy)
 * ═══════════════════════════════════════════════════════════════
 *
 *  One engine, one shared bankroll, two coupled markets:
 *
 *  - Every 15m window: immediately buy the 15m direction with $150.
 *    The 15m direction FOLLOWS the previous 15m resolved outcome
 *    (previous UP -> UP, previous DOWN -> DOWN; first window = UP).
 *  - Every 5m window: buy the OPPOSITE direction with $50
 *    (15m UP -> 5m DOWN, 15m DOWN -> 5m UP).
 *  - If a 5m bet WINS: its profit (payout - cost) is rolled into the
 *    15m window it was opened under (buying more of those shares), but
 *    only while that 15m window is still open — never the next one.
 *  - If a 5m bet LOSES: the next TWO 5m windows are skipped (no bets),
 *    then betting resumes.
 *
 *  All buys are immediate taker orders placed as soon as the window's
 *  market is discovered. Dry-run mode simulates fills at the ask.
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const { createCandleFeed } = require('./candles');
const { predictNextDirection } = require('./three-candle-model');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS             = 500;
const PRICE_REFRESH_MS    = 1000;
const DISCOVERY_RETRY_MS  = 2000;
const RESOLUTION_POLL_MS  = 3000;
const MIN_ORDER_SHARES    = 5;
const RESOLUTION_FALLBACK_MS = 60000;
const HIGH_CONF_PRICE     = 0.90;

const WINDOW_15M = 900;
const WINDOW_5M  = 300;

function round2(n) { return Math.round(n * 100) / 100; }
function sgn2(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }

/**
 * Pure 5m skip logic (exported for testing):
 * with `skipRemaining` windows still to skip, this window is skipped and
 * the counter decrements; otherwise the window is bet on.
 */
function next5mWindowAction(skipRemaining) {
  if (skipRemaining > 0) return { bet: false, skipRemaining: skipRemaining - 1 };
  return { bet: true, skipRemaining: 0 };
}

function createEngine(cfg) {
  const {
    label = 'BTC-HEDGE',
    startingCapital = 4000,
    baseBet15m = 150,
    baseBet5m = 50,
    feeTheta = 0.07,
    rebatePct = 0,
    candleRefreshMs = 15000,
    trader,
    dryRun = true,
    startAtBoundary = true,
    statsStatePath,
    emit = () => {},
    slog = () => {},
  } = cfg;

  const candles15 = createCandleFeed({ interval: '15m', maxCandles: 500, label: '15m' });
  const candles5  = createCandleFeed({ interval: '5m', maxCandles: 500, label: '5m' });

  let DRY_RUN = dryRun;
  let warnedNoRestingMethod = false;
  let warnedNoCancelMethod = false;
  let tradeSeq15 = 0;
  let tradeSeq5 = 0;

  function loadStats() {
    if (!statsStatePath) return null;
    try {
      const raw = fs.readFileSync(statsStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.bankroll === 'number') return parsed;
    } catch (_) {}
    return null;
  }
  const savedStats = loadStats();

  const engine = {
    tradingEnabled: true,
    bankroll: savedStats ? savedStats.bankroll : startingCapital,
    realizedPnl: savedStats ? savedStats.realizedPnl : 0,
    realizedPnl15: savedStats ? savedStats.realizedPnl15 : 0,
    realizedPnl5: savedStats ? savedStats.realizedPnl5 : 0,
    wins15: savedStats ? savedStats.wins15 : 0,
    losses15: savedStats ? savedStats.losses15 : 0,
    wins5: savedStats ? savedStats.wins5 : 0,
    losses5: savedStats ? savedStats.losses5 : 0,
    skipped5: savedStats ? savedStats.skipped5 : 0,
    direction: savedStats ? savedStats.direction : null,
    lastOutcome15: savedStats ? savedStats.lastOutcome15 : null,
    skipRemaining: savedStats ? savedStats.skipRemaining : 0,
    history15: savedStats && Array.isArray(savedStats.history15) ? savedStats.history15 : [],
    history5: savedStats && Array.isArray(savedStats.history5) ? savedStats.history5 : [],
    trades15: [],
    trades5: [],
    logs: [],
    equityCurve: savedStats && Array.isArray(savedStats.equityCurve) ? savedStats.equityCurve : [{ t: Date.now(), equity: startingCapital }],
    current: { m15: null, m5: null },
    pending15: [],
    pending5: [],
    lastPriceFetch: 0,
    lastCandleRefresh: 0,
    lastResolutionPoll: 0,
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
        bankroll: engine.bankroll,
        realizedPnl: engine.realizedPnl,
        realizedPnl15: engine.realizedPnl15,
        realizedPnl5: engine.realizedPnl5,
        wins15: engine.wins15, losses15: engine.losses15,
        wins5: engine.wins5, losses5: engine.losses5,
        skipped5: engine.skipped5,
        direction: engine.direction,
        lastOutcome15: engine.lastOutcome15,
        skipRemaining: engine.skipRemaining,
        history15: engine.history15.slice(0, 100),
        history5: engine.history5.slice(0, 100),
        equityCurve: engine.equityCurve.slice(-200),
        totalFeesPaid: engine.totalFeesPaid,
        totalRebatesEarned: engine.totalRebatesEarned,
        totalVolume: engine.totalVolume,
        savedAt: Date.now(),
      }));
    } catch (_) {}
  }

  function log(msg) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    engine.logs.push(line);
    if (engine.logs.length > 500) engine.logs.shift();
    slog(`[hedgebot] ${line}`);
  }
  function registerTrade(list, seqRef, t) {
    const trade = { seq: ++seqRef, time: new Date().toISOString().slice(11, 19), ...t };
    list.push(trade);
    if (list.length > 300) list.shift();
  }
  function recordEquity() {
    engine.equityCurve.push({ t: Date.now(), equity: round2(engine.bankroll + openPositionsMTM()) });
    if (engine.equityCurve.length > 1000) engine.equityCurve.shift();
    saveStats();
  }

  async function getJSON(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-hedgebot/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
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
      slog(`[hedgebot] ❌ LIVE trading needs trader.placeFokLimitOrder(tokenId, side, price, size) - LIVE order placement will be skipped until added. DRY_RUN is unaffected.`);
    }
    return ok;
  }
  async function cancelRestingOrder(orderId) {
    if (DRY_RUN || !orderId) return;
    if (!trader || typeof trader.cancelOrder !== 'function') {
      if (!warnedNoCancelMethod) { warnedNoCancelMethod = true; slog(`[hedgebot] ⚠️ trader.cancelOrder not implemented.`); }
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
    return { id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filledNow: true, avgPrice: price, filledShares: shares };
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
      highConfSide: null, highConfPrice: null, highConfCandidateSide: null, highConfCandidateCount: 0,
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
  function updateHighConfidence(leg) {
    if (leg.highConfSide) return;
    if (Date.now() < leg.closeAt) return;
    const upP = leg.upBid != null ? leg.upBid : leg.upAsk;
    const downP = leg.downBid != null ? leg.downBid : leg.downAsk;
    let candidate = null, candidatePrice = null;
    if (upP != null && upP >= HIGH_CONF_PRICE) { candidate = 'up'; candidatePrice = upP; }
    else if (downP != null && downP >= HIGH_CONF_PRICE) { candidate = 'down'; candidatePrice = downP; }
    if (!candidate) { leg.highConfCandidateSide = null; leg.highConfCandidateCount = 0; return; }
    if (leg.highConfCandidateSide === candidate) leg.highConfCandidateCount = (leg.highConfCandidateCount || 0) + 1;
    else { leg.highConfCandidateSide = candidate; leg.highConfCandidateCount = 1; }
    if (leg.highConfCandidateCount >= 2) { leg.highConfSide = candidate; leg.highConfPrice = candidatePrice; }
  }

  async function attemptFastResolution(leg) {
    if (leg.resolved) return true;
    if (!leg.upTokenId || !leg.downTokenId) return false;
    await refreshLegPrices(leg);
    const upP = markPrice(leg, 'up');
    const downP = markPrice(leg, 'down');
    if (upP == null && downP == null) return false;
    leg.resolved = true;
    leg.winner = (upP != null ? upP : 0) >= (downP != null ? downP : 0) ? 'up' : 'down';
    leg.resolutionMethod = 'final-price';
    log(`⚡ [${leg.slug}] resolved FINAL-PRICE at window close (up ${upP != null ? upP.toFixed(3) : '—'} / down ${downP != null ? downP.toFixed(3) : '—'}) — winner ${leg.winner.toUpperCase()}`);
    return true;
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
    updateHighConfidence(leg);
    if (leg.highConfSide) {
      leg.resolved = true;
      leg.winner = leg.highConfSide;
      leg.resolutionMethod = 'high-confidence-price';
      log(`⚡ [${leg.slug}] resolved HIGH-CONFIDENCE (${leg.highConfPrice.toFixed(3)}) — winner ${leg.winner.toUpperCase()}`);
      return true;
    }
    if (Date.now() - leg.closeAt >= RESOLUTION_FALLBACK_MS) {
      const winner = leadingSide(leg);
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

  // Buy `dollars` worth of `side` on this leg at the ask (taker).
  async function buyLegMarket(leg, side, dollars, what) {
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
    log(`${what} ${side.toUpperCase()} $${dollars.toFixed(2)} @${avgPrice.toFixed(3)} = ${filled}sh (cost $${cost.toFixed(2)})`);
    return { ok: true, shares: filled, avgPrice, notional, fee, rebate, netFee, cost };
  }

  function freshTrade15(windowTs) {
    const direction = engine.lastOutcome15 || 'up';
    return {
      windowTs,
      closeAt: (windowTs + WINDOW_15M) * 1000,
      leg: freshLeg(windowTs, WINDOW_15M, 'btc-updown-15m-'),
      direction,
      position: null,
      buys: [],
      state: 'discovering',
      betPlaced: false,
      pnl: null,
      settled: false,
    };
  }

  function freshTrade5(windowTs) {
    const side = engine.direction === 'up' ? 'down' : 'up';
    return {
      windowTs,
      closeAt: (windowTs + WINDOW_5M) * 1000,
      leg: freshLeg(windowTs, WINDOW_5M, 'btc-updown-5m-'),
      parent15WindowTs: Math.floor(windowTs / WINDOW_15M) * WINDOW_15M,
      side,
      skipped: false,
      position: null,
      state: 'discovering',
      betPlaced: false,
      pnl: null,
      settled: false,
    };
  }

  // ── 15m window management ─────────────────────────────────────────
  async function ensure15mTrade(now) {
    const nowSec = Math.floor(now / 1000);
    const windowTs = Math.floor(nowSec / WINDOW_15M) * WINDOW_15M;
    let t = engine.current.m15;

    if (!t || t.windowTs !== windowTs) {
      if (t && !t.settled) {
        if (!t.leg.resolved) await attemptFastResolution(t.leg);
        if (t.leg.resolved && !t.settled) settle15(t);
        else {
          t.state = 'pending-resolution';
          engine.pending15.push(t);
          if (engine.pending15.length > 40) engine.pending15.shift();
        }
      }
      engine.direction = engine.lastOutcome15 || 'up';
      t = freshTrade15(windowTs);
      engine.current.m15 = t;
      log(`🆕 15m window t=${windowTs} — direction ${engine.direction.toUpperCase()} (follows last outcome ${engine.lastOutcome15 ? engine.lastOutcome15.toUpperCase() : '— first window'}) — buying $${baseBet15m.toFixed(2)} immediately`);
    }

    if (t.state === 'discovering' && now - t.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
      t.leg.lastDiscoveryAttempt = now;
      await discoverLeg(t.leg);
      if (t.leg.discovered) t.state = 'trading';
    }
    if (t.state === 'trading' && engine.tradingEnabled && now < t.closeAt && !t.betPlaced) {
      const res = await buyLegMarket(t.leg, t.direction, baseBet15m, '15m base');
      if (res.ok) {
        t.position = { shares: res.shares, cost: res.cost };
        t.buys.push({ ts: now, dollars: baseBet15m, shares: res.shares, price: res.avgPrice, cost: res.cost });
        t.betPlaced = true;
      } else if (res.reason && res.reason !== 'no-ask') {
        log(`⚠️ 15m ${t.direction.toUpperCase()} base buy skipped: ${res.reason}`);
      }
    }
  }

  function settle15(t) {
    const leg = t.leg;
    const winner = leg.winner || '?';
    if (!t.position || !t.betPlaced) {
      t.state = 'resolved';
      t.settled = true;
      t.pnl = 0;
      engine.lastOutcome15 = leg.winner || null;
      engine.history15.unshift({
        windowTs: t.windowTs, slug: leg.slug, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
        direction: t.direction, betPlaced: false, win: null,
        wager: 0, shares: 0, pnl: 0, bankrollAfter: engine.bankroll, resolvedAt: Date.now(),
      });
      if (engine.history15.length > 300) engine.history15.pop();
      log(`🏁 15m [${leg.slug}] resolved — winner ${winner.toUpperCase()} (${leg.resolutionMethod}) — no position held`);
      recordEquity();
      return;
    }

    const win = t.direction === leg.winner;
    const payout = win ? round2(t.position.shares * 1) : 0;
    const pnl = round2(payout - t.position.cost);
    engine.bankroll = round2(engine.bankroll + payout);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);
    engine.realizedPnl15 = round2(engine.realizedPnl15 + pnl);
    if (win) engine.wins15++; else engine.losses15++;
    engine.lastOutcome15 = leg.winner;
    t.pnl = pnl;
    t.state = 'resolved';
    t.settled = true;
    engine.history15.unshift({
      windowTs: t.windowTs, slug: leg.slug, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
      direction: t.direction, betPlaced: true, win,
      wager: t.position.cost, shares: t.position.shares, entryPrice: round2(t.position.cost / t.position.shares),
      pnl, bankrollAfter: engine.bankroll, resolvedAt: Date.now(),
    });
    if (engine.history15.length > 300) engine.history15.pop();
    registerTrade(engine.trades15, tradeSeq15, { slug: leg.slug, side: leg.winner, shares: t.position.shares, pnl });
    log(`🏆 15m [${leg.slug}] resolved — winner ${winner.toUpperCase()} (${leg.resolutionMethod}) — our ${t.direction.toUpperCase()} bet ${win ? 'WON' : 'LOST'} ${sgn2(pnl)} | next 15m starts ${winner.toUpperCase()}`);
    recordEquity();
  }

  // ── 5m window management ──────────────────────────────────────────
  async function ensure5mTrade(now) {
    const nowSec = Math.floor(now / 1000);
    const windowTs = Math.floor(nowSec / WINDOW_5M) * WINDOW_5M;
    let t = engine.current.m5;

    if (!t || t.windowTs !== windowTs) {
      if (t && !t.settled) {
        if (!t.leg.resolved) await attemptFastResolution(t.leg);
        if (t.leg.resolved && !t.settled) await settle5(t);
        else {
          t.state = 'pending-resolution';
          engine.pending5.push(t);
          if (engine.pending5.length > 40) engine.pending5.shift();
        }
      }
      const action = next5mWindowAction(engine.skipRemaining);
      engine.skipRemaining = action.skipRemaining;
      t = freshTrade5(windowTs);
      t.skipped = !action.bet;
      engine.current.m5 = t;
      if (t.skipped) {
        t.state = 'skipped';
        log(`⏭ 5m window t=${windowTs} SKIPPED (after 5m loss — ${engine.skipRemaining} more to skip after this)`);
      } else {
        log(`🆕 5m window t=${windowTs} — betting ${t.side.toUpperCase()} $${baseBet5m.toFixed(2)} (opposite of 15m ${engine.direction ? engine.direction.toUpperCase() : 'n/a'})`);
      }
    }

    if (t.state === 'discovering' && now - t.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
      t.leg.lastDiscoveryAttempt = now;
      await discoverLeg(t.leg);
      if (t.leg.discovered) t.state = 'trading';
    }
    if (t.state === 'trading' && engine.tradingEnabled && now < t.closeAt && !t.betPlaced) {
      const res = await buyLegMarket(t.leg, t.side, baseBet5m, '5m bet');
      if (res.ok) {
        t.position = { shares: res.shares, cost: res.cost };
        t.betPlaced = true;
      } else if (res.reason && res.reason !== 'no-ask') {
        log(`⚠️ 5m ${t.side.toUpperCase()} buy skipped: ${res.reason}`);
      }
    }
  }

  async function roll5mProfitInto15m(profit, t5) {
    if (profit <= 0) return;
    // The profit belongs to the 15m window this 5m bet was opened under —
    // never the NEXT 15m window. Each 15m window runs to resolution alone.
    const t15 = t5 && t5.parent15WindowTs != null
      ? [engine.current.m15, ...engine.pending15].find(t => t && t.windowTs === t5.parent15WindowTs)
      : engine.current.m15;
    if (!t15 || t15.settled || !t15.position || !t15.betPlaced) {
      log(`💰 5m profit $${profit.toFixed(2)} — its 15m window has no open position to roll into; kept in bankroll`);
      return;
    }
    if (Date.now() >= t15.closeAt) {
      log(`💰 5m profit $${profit.toFixed(2)} — its 15m window already closed; kept in bankroll`);
      return;
    }
    const res = await buyLegMarket(t15.leg, t15.direction, profit, '5m profit roll');
    if (res.ok) {
      t15.position.shares = round2(t15.position.shares + res.shares);
      t15.position.cost = round2(t15.position.cost + res.cost);
      t15.buys.push({ ts: Date.now(), dollars: profit, shares: res.shares, price: res.avgPrice, cost: res.cost });
      log(`💰 rolled 5m profit $${profit.toFixed(2)} into 15m ${t15.direction.toUpperCase()} (+${res.shares}sh, +$${res.cost.toFixed(2)})`);
    } else if (res.reason !== 'no-ask') {
      log(`⚠️ could not roll 5m profit into 15m: ${res.reason}`);
    }
  }

  async function settle5(t) {
    const leg = t.leg;
    const winner = leg.winner || '?';
    if (t.skipped || !t.position) {
      t.state = 'resolved';
      t.settled = true;
      t.pnl = 0;
      engine.skipped5++;
      engine.history5.unshift({
        windowTs: t.windowTs, slug: leg.slug, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
        side: t.skipped ? null : t.side, skipped: true, win: null,
        wager: 0, shares: 0, pnl: 0, bankrollAfter: engine.bankroll, resolvedAt: Date.now(),
      });
      if (engine.history5.length > 300) engine.history5.pop();
      log(`🏁 5m [${leg.slug}] resolved — winner ${winner.toUpperCase()} (${leg.resolutionMethod}) — ${t.skipped ? 'window was skipped (after 5m loss)' : 'no bet placed'}`);
      recordEquity();
      return;
    }

    const win = t.side === leg.winner;
    const payout = win ? round2(t.position.shares * 1) : 0;
    const pnl = round2(payout - t.position.cost);
    engine.bankroll = round2(engine.bankroll + payout);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);
    engine.realizedPnl5 = round2(engine.realizedPnl5 + pnl);
    if (win) engine.wins5++; else { engine.losses5++; engine.skipRemaining = 2; }
    t.pnl = pnl;
    t.state = 'resolved';
    t.settled = true;
    engine.history5.unshift({
      windowTs: t.windowTs, slug: leg.slug, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
      side: t.side, skipped: false, win,
      wager: t.position.cost, shares: t.position.shares, entryPrice: round2(t.position.cost / t.position.shares),
      pnl, bankrollAfter: engine.bankroll, resolvedAt: Date.now(),
    });
    if (engine.history5.length > 300) engine.history5.pop();
    registerTrade(engine.trades5, tradeSeq5, { slug: leg.slug, side: t.side, shares: t.position.shares, pnl });
    log(`🏆 5m [${leg.slug}] resolved — winner ${winner.toUpperCase()} (${leg.resolutionMethod}) — our ${t.side.toUpperCase()} bet ${win ? 'WON' : 'LOST'} ${sgn2(pnl)}`);
    if (win) {
      await roll5mProfitInto15m(pnl, t);
    } else {
      log(`⏭ 5m loss — 15m is in favor, skipping the next 2 windows`);
    }
    recordEquity();
  }

  // ── loops ─────────────────────────────────────────────────────────
  function allTrackedTrades() {
    return [
      engine.current.m15, engine.current.m5,
      ...engine.pending15, ...engine.pending5,
    ].filter(Boolean);
  }

  async function mainLoop() {
    while (true) {
      try {
        const now = Date.now();
        const nowSec = Math.floor(now / 1000);

        if (engine.waitingForBoundary) {
          if (engine.boundaryWindowTs == null) {
            const current15 = Math.floor(nowSec / WINDOW_15M) * WINDOW_15M;
            engine.boundaryWindowTs = nowSec > current15 ? current15 + WINDOW_15M : current15;
            log(`⏳ starting ${nowSec > current15 ? 'mid-window — waiting for the next 15m boundary' : 'on a fresh 15m boundary'} (t=${engine.boundaryWindowTs}) before trading begins`);
          }
          if (nowSec >= engine.boundaryWindowTs) {
            engine.waitingForBoundary = false;
            log('🚦 new boundary reached — trading starts now');
          }
        }

        if (!engine.waitingForBoundary) {
          await ensure15mTrade(now);
          await ensure5mTrade(now);
        }

        if (now - engine.lastCandleRefresh >= candleRefreshMs) {
          engine.lastCandleRefresh = now;
          await Promise.all([candles15.refresh(log), candles5.refresh(log)]);
        }
        if (now - engine.lastPriceFetch >= PRICE_REFRESH_MS) {
          engine.lastPriceFetch = now;
          await Promise.all(allTrackedTrades().map(t => refreshLegPrices(t.leg)));
        }
        if ((engine.pending15.length || engine.pending5.length) && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
          engine.lastResolutionPoll = now;
          const still15 = [];
          for (const trade of engine.pending15) {
            if (!trade.leg.resolved) await resolveLegAttempt(trade.leg);
            if (trade.leg.resolved && !trade.settled) settle15(trade);
            if (!trade.settled) still15.push(trade);
          }
          engine.pending15 = still15;
          const still5 = [];
          for (const trade of engine.pending5) {
            if (!trade.leg.resolved) await resolveLegAttempt(trade.leg);
            if (trade.leg.resolved && !trade.settled) await settle5(trade);
            if (!trade.settled) still5.push(trade);
          }
          engine.pending5 = still5;
        }

        emitState();
      } catch (e) {
        slog(`[hedgebot] ⚠️ Loop error: ${e.message}`);
      }
      await new Promise(res => setTimeout(res, TICK_MS));
    }
  }

  // ── dashboard state ───────────────────────────────────────────────
  function refPred(feed) {
    return predictNextDirection(feed.getCandles());
  }
  function legSummary(leg) {
    if (!leg) return null;
    return {
      slug: leg.slug, windowTs: leg.windowTs, closeAt: leg.closeAt,
      discovered: leg.discovered, upAsk: leg.upAsk, downAsk: leg.downAsk, upBid: leg.upBid, downBid: leg.downBid,
      highConfSide: leg.highConfSide, highConfPrice: leg.highConfPrice,
      resolved: leg.resolved, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
    };
  }
  function unrealizedFor(t) {
    if (!t || !t.position || !t.leg) return 0;
    const side = t.direction || t.side;
    const bid = markPrice(t.leg, side);
    if (bid == null) return 0;
    return round2(t.position.shares * bid - t.position.cost);
  }
  function openPositionsMTM() {
    return round2(unrealizedFor(engine.current.m15) + unrealizedFor(engine.current.m5));
  }
  function tradeSummary15(t) {
    if (!t) return null;
    const pred = refPred(candles15);
    return {
      windowTs: t.windowTs, closeAt: t.closeAt, state: t.state,
      leg: legSummary(t.leg),
      signalSide: t.direction,
      signalNote: 'follows last 15m outcome',
      confidence: round2(pred.confidence),
      model: pred,
      betPlaced: t.betPlaced,
      skipReason: t.direction ? null : 'no direction',
      position: t.position ? { shares: t.position.shares, cost: t.position.cost, entryPrice: round2(t.position.cost / t.position.shares), buys: t.buys } : null,
      pnl: t.pnl,
      unrealizedPnl: unrealizedFor(t),
    };
  }
  function tradeSummary5(t) {
    if (!t) return null;
    const pred = refPred(candles5);
    return {
      windowTs: t.windowTs, closeAt: t.closeAt, state: t.state,
      leg: legSummary(t.leg),
      signalSide: t.skipped ? null : t.side,
      signalNote: 'opposite of 15m direction',
      confidence: round2(pred.confidence),
      model: pred,
      betPlaced: t.betPlaced,
      skipReason: t.skipped ? `skipping after 5m loss — ${engine.skipRemaining} more after this` : (t.side ? null : 'no bet'),
      position: t.position ? { shares: t.position.shares, cost: t.position.cost, entryPrice: round2(t.position.cost / t.position.shares) } : null,
      pnl: t.pnl,
      unrealizedPnl: unrealizedFor(t),
    };
  }
  function baseState(which) {
    return {
      dryRun: DRY_RUN,
      tradingEnabled: engine.tradingEnabled,
      waitingForBoundary: engine.waitingForBoundary,
      bankroll: engine.bankroll,
      startingCapital,
      realizedPnlTotal: engine.realizedPnl,
      skipRemaining: which === '5m' ? engine.skipRemaining : null,
      direction: engine.direction,
      totalFeesPaid: engine.totalFeesPaid,
      totalRebatesEarned: engine.totalRebatesEarned,
      totalVolume: engine.totalVolume,
      feeTheta, rebatePct,
      logs: engine.logs.slice(-80),
      pendingResolutionCount: (which === '5m' ? engine.pending5 : engine.pending15).length,
      equityCurve: engine.equityCurve,
    };
  }
  function buildState15() {
    const totalDecided = engine.wins15 + engine.losses15;
    return {
      ...baseState('15m'),
      label: 'BTC-15m', windowSeconds: WINDOW_15M,
      baseBetDollars: baseBet15m,
      realizedPnl: engine.realizedPnl15, unrealizedPnl: unrealizedFor(engine.current.m15), equity: round2(engine.bankroll + openPositionsMTM()),
      wins: engine.wins15, losses: engine.losses15, skipped: 0,
      winRate: totalDecided > 0 ? round2(engine.wins15 / totalDecided) : null,
      candleCount: candles15.count(),
      latestBtcPrice: candles15.latestClose(),
      lastCandles: candles15.getCandles().slice(-3).map(k => ({ openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, closeTime: k.closeTime, up: k.close >= k.open })),
      current: { btc: tradeSummary15(engine.current.m15) },
      pending: engine.pending15.map(tradeSummary15),
      history: engine.history15.slice(0, 60),
      trades: engine.trades15.slice(-100).slice().reverse(),
    };
  }
  function buildState5() {
    const totalDecided = engine.wins5 + engine.losses5;
    return {
      ...baseState('5m'),
      label: 'BTC-5m', windowSeconds: WINDOW_5M,
      baseBetDollars: baseBet5m,
      realizedPnl: engine.realizedPnl5, unrealizedPnl: unrealizedFor(engine.current.m5), equity: round2(engine.bankroll + openPositionsMTM()),
      wins: engine.wins5, losses: engine.losses5, skipped: engine.skipped5,
      winRate: totalDecided > 0 ? round2(engine.wins5 / totalDecided) : null,
      candleCount: candles5.count(),
      latestBtcPrice: candles5.latestClose(),
      lastCandles: candles5.getCandles().slice(-3).map(k => ({ openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, closeTime: k.closeTime, up: k.close >= k.open })),
      current: { btc: tradeSummary5(engine.current.m5) },
      pending: engine.pending5.map(tradeSummary5),
      history: engine.history5.slice(0, 60),
      trades: engine.trades5.slice(-100).slice().reverse(),
    };
  }
  function emitState() {
    emit('hedgeState:BTC-15m', buildState15());
    emit('hedgeState:BTC-5m', buildState5());
  }
  function buildState() {
    return { m5: buildState5(), m15: buildState15() };
  }

  function pauseTrading() {
    engine.tradingEnabled = false;
    log('⏸️  Trading paused — no new bets will be placed; open positions still tracked to resolution');
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

  async function start() {
    slog(`[hedgebot] 🪙 ${label} — 15m/5m hedge engine, fully automatic`);
    slog(`[hedgebot] ⚙️  Every 15m window: buy the 15m direction (follows the previous 15m outcome; first = UP) with $${baseBet15m.toFixed(2)}, immediately at open.`);
    slog(`[hedgebot] ⚙️  Every 5m window: buy the OPPOSITE direction with $${baseBet5m.toFixed(2)}. 5m WIN → its profit (payout − cost) is rolled into the open 15m position. 5m LOSS → the next two 5m windows are skipped.`);
    slog(`[hedgebot] ⚙️  One shared bankroll of $${engine.bankroll.toFixed(2)} across both markets.`);
    slog(`[hedgebot] ⚙️  Fees: Polymarket taker fee = shares × ${feeTheta} × price × (1-price) (crypto category), ${rebatePct > 0 ? (rebatePct * 100).toFixed(0) + '% rebate applied' : 'no rebate configured'}.`);
    if (savedStats) {
      slog(`[hedgebot] 💾 Restored saved stats — bankroll $${engine.bankroll.toFixed(2)}, 15m ${engine.wins15}W/${engine.losses15}L, 5m ${engine.wins5}W/${engine.losses5}L.`);
    } else if (statsStatePath) {
      slog(`[hedgebot] 💾 No previous saved stats — starting fresh at $${startingCapital}. Stats persist to ${statsStatePath}.`);
    }
    await Promise.all([candles15.seed(slog), candles5.seed(slog)]);
    mainLoop().catch(e => slog(`[hedgebot] ❌ Fatal: ${e.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine, next5mWindowAction };
