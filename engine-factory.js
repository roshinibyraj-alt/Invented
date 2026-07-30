'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  SIMPLE PRICE-BAND ENGINE — TWO independent rules per window
 *  (no indicators, no patterns, no candles, no learning)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Call createEngine(config) once per timeframe (5-minute, 15-minute).
 *
 *  RULE 1 — EARLY TAKE-PROFIT BET:
 *  Between earlyStartSec-earlyEndSec (default 0s-60s of a 300s window,
 *  scaled to 0s-180s for 900s), watch both sides. The FIRST moment
 *  either side's ask falls within [earlyPriceLow, earlyPriceHigh]
 *  (default $0.15-$0.25), buy $betDollars of it. From then on, watch
 *  that position's bid — the moment it reaches takeProfitPrice (default
 *  $0.85), sell immediately to lock in the profit, before the window
 *  even resolves. If take-profit never triggers, the position rides to
 *  normal window resolution like any other bet.
 *
 *  RULE 2 — LATE HOLD-TO-RESOLUTION BET:
 *  Between lateStartSec-lateEndSec (default 240s-290s of a 300s window,
 *  scaled to 720s-870s for 900s), check whichever side is currently
 *  CHEAPER. The first moment that side's ask falls within
 *  [latePriceLow, latePriceHigh] (default $0.10-$0.20), buy $betDollars
 *  of it and hold to resolution — no take-profit on this one.
 *
 *  These two rules are fully independent: a single window can have
 *  neither, either, or both bets active at once, and they share the
 *  same bankroll/win-rate scoreboard for that timeframe.
 *
 *  HONESTY NOTE: both rules involve buying a side priced well under
 *  $0.50 - the side the market currently sees as less likely. These
 *  are long-shot bets by construction, not "safe" ones. The early
 *  rule's take-profit exit changes the payoff shape (smaller, more
 *  frequent wins if price recovers to $0.85, vs the full $1 payout if
 *  held to resolution) but doesn't change that basic fact.
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require('fs');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS             = 500;
const PRICE_REFRESH_MS    = 1000;
const DISCOVERY_RETRY_MS  = 2000;
const RESOLUTION_POLL_MS  = 3000;

function round2(n) { return Math.round(n * 100) / 100; }
function sgn2(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }

function createEngine(cfg) {
  const {
    label,
    windowSeconds,
    slugPrefix,
    statsStatePath,
    startingCapital = 2000,
    betDollars = 50,

    earlyStartSec = 0,
    earlyEndSec = Math.round(60 * (windowSeconds / 300)),
    earlyPriceLow = 0.15,
    earlyPriceHigh = 0.25,
    takeProfitPrice = 0.85,

    lateStartSec = Math.round(240 * (windowSeconds / 300)),
    lateEndSec = Math.round(290 * (windowSeconds / 300)),
    latePriceLow = 0.10,
    latePriceHigh = 0.20,

    minOrderShares = 5,
    highConfPrice = 0.90,
    resolutionFallbackMs = 60000,
    trader,
    dryRun = true,
  } = cfg;

  let DRY_RUN = dryRun;
  let emitFn = () => {};
  let slog = () => {};
  let warnedNoRestingMethod = false;
  let warnedNoCancelMethod = false;
  let tradeSeq = 0;

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
    wins: savedStats ? savedStats.wins : 0,
    losses: savedStats ? savedStats.losses : 0,
    skipped: savedStats ? savedStats.skipped : 0,
    current: { btc: null },
    pending: [],
    history: savedStats && Array.isArray(savedStats.history) ? savedStats.history : [],
    logs: [],
    trades: [],
    equityCurve: savedStats && Array.isArray(savedStats.equityCurve) ? savedStats.equityCurve : [{ t: Date.now(), equity: startingCapital }],
    lastPriceFetch: 0,
    lastResolutionPoll: 0,
    waitingForBoundary: true,
    boundaryWindowTs: null,
  };

  function saveStats() {
    if (!statsStatePath) return;
    try {
      fs.writeFileSync(statsStatePath, JSON.stringify({
        bankroll: engine.bankroll,
        realizedPnl: engine.realizedPnl,
        wins: engine.wins,
        losses: engine.losses,
        skipped: engine.skipped,
        history: engine.history.slice(0, 100),
        equityCurve: engine.equityCurve.slice(-200),
        savedAt: Date.now(),
      }));
    } catch (_) {}
  }

  function log(msg) {
    const line = `[${new Date().toISOString().slice(11, 19)}] [${label}] ${msg}`;
    engine.logs.push(line);
    if (engine.logs.length > 500) engine.logs.shift();
    slog(`[hedgebot] ${line}`);
  }
  function registerTrade(t) {
    const trade = { seq: ++tradeSeq, time: new Date().toISOString().slice(11, 19), ...t };
    engine.trades.push(trade);
    if (engine.trades.length > 300) engine.trades.shift();
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
      slog(`[hedgebot] ❌ [${label}] LIVE trading needs trader.placeFokLimitOrder(tokenId, side, price, size) — LIVE order placement will be skipped until added. DRY_RUN is unaffected.`);
    }
    return ok;
  }
  async function cancelRestingOrder(orderId) {
    if (DRY_RUN || !orderId) return;
    if (!trader || typeof trader.cancelOrder !== 'function') {
      if (!warnedNoCancelMethod) { warnedNoCancelMethod = true; slog(`[hedgebot] ⚠️  [${label}] trader.cancelOrder not implemented.`); }
      return;
    }
    try { await trader.cancelOrder(orderId); } catch (e) { log(`⚠️  cancelRestingOrder(${orderId}) failed: ${e.message}`); }
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
  async function placeTakerSell(tokenId, price, shares) {
    if (!DRY_RUN) {
      if (!traderHasRestingOrderMethods()) return null;
      try {
        const resp = await trader.placeFokLimitOrder(tokenId, 'SELL', price, shares);
        if (resp?.isFilled) return { id: resp.id || null, filledNow: true, avgPrice: resp.avgPrice || price, filledShares: shares };
        if (resp?.id) await cancelRestingOrder(resp.id);
        return { id: null, filledNow: false, avgPrice: price, filledShares: 0 };
      } catch (e) {
        log(`❌ placeTakerSell(${tokenId}) failed: ${describeOrderError(e)}`);
        return null;
      }
    }
    return { id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, filledNow: true, avgPrice: price, filledShares: shares };
  }

  function parseMarketTokens(mk) {
    try {
      const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
      const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
      return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
    } catch (_) { return []; }
  }

  function freshLeg(windowTs) {
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
      log(`⚠️  discoverLeg(${leg.slug}) failed: ${e.message}`);
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
  function bidPrice(leg, side) {
    const bid = side === 'up' ? leg.upBid : leg.downBid;
    return bid != null ? bid : markPrice(leg, side);
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
    if (upP != null && upP >= highConfPrice) { candidate = 'up'; candidatePrice = upP; }
    else if (downP != null && downP >= highConfPrice) { candidate = 'down'; candidatePrice = downP; }
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
      log(`⚠️  resolveLegAttempt(${leg.slug}) failed: ${e.message}`);
    }
    updateHighConfidence(leg);
    if (leg.highConfSide) {
      leg.resolved = true;
      leg.winner = leg.highConfSide;
      leg.resolutionMethod = 'high-confidence-price';
      log(`⚡ [${leg.slug}] resolved HIGH-CONFIDENCE (${leg.highConfPrice.toFixed(3)}) — winner ${leg.winner.toUpperCase()}`);
      return true;
    }
    if (Date.now() - leg.closeAt >= resolutionFallbackMs) {
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

  function checkEarlyBand(leg, elapsedSec) {
    if (elapsedSec < earlyStartSec || elapsedSec > earlyEndSec) return null;
    const upAsk = leg.upAsk, downAsk = leg.downAsk;
    const upHit = upAsk != null && upAsk >= earlyPriceLow && upAsk <= earlyPriceHigh;
    const downHit = downAsk != null && downAsk >= earlyPriceLow && downAsk <= earlyPriceHigh;
    if (upHit && downHit) return upAsk <= downAsk ? { side: 'up', price: upAsk } : { side: 'down', price: downAsk };
    if (upHit) return { side: 'up', price: upAsk };
    if (downHit) return { side: 'down', price: downAsk };
    return null;
  }
  function checkLateBand(leg, elapsedSec) {
    if (elapsedSec < lateStartSec || elapsedSec > lateEndSec) return null;
    const upAsk = leg.upAsk, downAsk = leg.downAsk;
    if (upAsk == null && downAsk == null) return null;
    const cheapSide = (upAsk == null) ? 'down' : (downAsk == null ? 'up' : (upAsk <= downAsk ? 'up' : 'down'));
    const cheapPrice = cheapSide === 'up' ? upAsk : downAsk;
    if (cheapPrice == null) return null;
    if (cheapPrice >= latePriceLow && cheapPrice <= latePriceHigh) return { side: cheapSide, price: cheapPrice };
    return null;
  }

  function freshBet() {
    return { side: null, betPlaced: false, skipReason: null, position: null, closedEarly: false, pnl: null };
  }
  function freshTrade(windowTs) {
    return {
      asset: 'btc', label, windowTs,
      closeAt: (windowTs + windowSeconds) * 1000,
      leg: freshLeg(windowTs),
      state: 'discovering',
      early: freshBet(),
      late: freshBet(),
      settled: false,
    };
  }

  async function placeBet(trade, betKey, side, ask) {
    const bet = trade[betKey];
    if (bet.betPlaced) return;
    const leg = trade.leg;
    const tokenId = tokenIdFor(leg, side);
    if (!tokenId || ask == null) return;

    const shares = round2(betDollars / ask);
    if (shares < minOrderShares) {
      bet.betPlaced = true;
      bet.side = side;
      bet.skipReason = 'below-min-shares';
      log(`⚠️  [${leg.slug}] (${betKey}) ${side.toUpperCase()} @${ask.toFixed(3)} in band, but $${betDollars} = ${shares.toFixed(2)}sh, below ${minOrderShares}sh minimum — no bet`);
      return;
    }

    const resp = await placeTakerBuy(tokenId, ask, shares);
    if (!resp) { log(`❌ [${leg.slug}] (${betKey}) ${side.toUpperCase()} bet failed to place — will retry while still in band`); return; }
    if (!resp.filledNow) { log(`⌛ [${leg.slug}] (${betKey}) ${side.toUpperCase()} bet didn't fill immediately — will retry while still in band`); return; }

    bet.betPlaced = true;
    bet.side = side;
    const avgPrice = resp.avgPrice || ask;
    const filledShares = resp.filledShares || shares;
    const cost = round2(filledShares * avgPrice);

    bet.position = { shares: filledShares, cost, entryPrice: avgPrice, ts: Date.now() };
    engine.bankroll = round2(engine.bankroll - cost);

    registerTrade({ slug: leg.slug, step: `${side.toUpperCase()} ${betKey} bet`, side, price: avgPrice, shares: filledShares, cost });
    log(`✅ [${leg.slug}] (${betKey}) ${side.toUpperCase()} was in band at $${ask.toFixed(3)} — bought ${filledShares.toFixed(2)}sh @${avgPrice.toFixed(3)} ($${cost.toFixed(2)}) | bankroll $${engine.bankroll.toFixed(2)}`);
    recordEquity();
  }

  async function checkTakeProfit(trade) {
    const bet = trade.early;
    if (!bet.position || bet.closedEarly || trade.leg.resolved) return;
    const bid = bidPrice(trade.leg, bet.side);
    if (bid == null || bid < takeProfitPrice) return;

    const tokenId = tokenIdFor(trade.leg, bet.side);
    const resp = await placeTakerSell(tokenId, bid, bet.position.shares);
    if (!resp || !resp.filledNow) { log(`⌛ [${trade.leg.slug}] (early) take-profit sell at $${bid.toFixed(3)} didn't fill — will keep watching`); return; }

    const avgPrice = resp.avgPrice || bid;
    const proceeds = round2(bet.position.shares * avgPrice);
    const pnl = round2(proceeds - bet.position.cost);

    engine.bankroll = round2(engine.bankroll + proceeds);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);
    engine.wins++;
    bet.closedEarly = true;
    bet.pnl = pnl;

    registerTrade({ slug: trade.leg.slug, step: `${bet.side.toUpperCase()} early take-profit`, side: bet.side, price: avgPrice, shares: bet.position.shares, pnl });
    engine.history.unshift({
      windowTs: trade.windowTs, slug: trade.leg.slug, winner: null, resolutionMethod: 'take-profit',
      betType: 'early', side: bet.side, betPlaced: true, win: true,
      wager: bet.position.cost, shares: bet.position.shares, entryPrice: bet.position.entryPrice, pnl,
      bankrollAfter: engine.bankroll, resolvedAt: Date.now(),
    });
    if (engine.history.length > 300) engine.history.pop();
    log(`🎯 [${trade.leg.slug}] (early) TAKE-PROFIT hit — sold ${bet.side.toUpperCase()} @${avgPrice.toFixed(3)} ${sgn2(pnl)} | bankroll $${engine.bankroll.toFixed(2)}`);
    recordEquity();
  }

  function unrealizedForBet(trade, betKey) {
    const bet = trade[betKey];
    if (!bet.position || bet.closedEarly || trade.settled || (trade.leg && trade.leg.resolved)) return 0;
    const mp = markPrice(trade.leg, bet.side);
    const mark = mp != null ? mp : (bet.position.cost / bet.position.shares);
    return round2(bet.position.shares * mark - bet.position.cost);
  }
  function unrealizedForTrade(trade) { return round2(unrealizedForBet(trade, 'early') + unrealizedForBet(trade, 'late')); }
  function openCostForBet(trade, betKey) {
    const bet = trade[betKey];
    return (bet.position && !bet.closedEarly) ? bet.position.cost : 0;
  }
  function openCostForTrade(trade) { return round2(openCostForBet(trade, 'early') + openCostForBet(trade, 'late')); }
  function allTrackedTrades() {
    const list = [...engine.pending];
    if (engine.current.btc) list.push(engine.current.btc);
    return list;
  }
  function totalUnrealizedPnl() { return round2(allTrackedTrades().reduce((sum, t) => sum + unrealizedForTrade(t), 0)); }
  function openPositionsMTM() { return round2(allTrackedTrades().reduce((sum, t) => sum + openCostForTrade(t) + unrealizedForTrade(t), 0)); }

  function settleBetAtResolution(trade, betKey) {
    const bet = trade[betKey];
    const leg = trade.leg;

    if (bet.closedEarly) return;

    if (!bet.side || !bet.position) {
      engine.skipped++;
      const reason = !bet.side ? 'price never entered the target band during check window' : `no bet placed (${bet.skipReason || 'no fill'})`;
      registerTrade({ slug: leg.slug, step: `window resolution (${betKey}, no bet)`, side: leg.winner, price: null, shares: 0, pnl: 0 });
      engine.history.unshift({
        windowTs: trade.windowTs, slug: leg.slug, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
        betType: betKey, side: bet.side, betPlaced: false, win: null,
        wager: 0, shares: 0, pnl: 0, bankrollAfter: engine.bankroll, resolvedAt: Date.now(),
      });
      if (engine.history.length > 300) engine.history.pop();
      log(`🏁 [${leg.slug}] (${betKey}) resolved — winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — ${reason}`);
      return;
    }

    const side = bet.side;
    const win = side === leg.winner;
    const payout = win ? round2(bet.position.shares * 1) : 0;
    const pnl = round2(payout - bet.position.cost);

    engine.bankroll = round2(engine.bankroll + payout);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);
    if (win) engine.wins++; else engine.losses++;
    bet.pnl = pnl;

    registerTrade({ slug: leg.slug, step: `window resolution (${betKey})`, side: leg.winner, price: 1, shares: bet.position.shares, pnl });
    engine.history.unshift({
      windowTs: trade.windowTs, slug: leg.slug, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
      betType: betKey, side, betPlaced: true, win,
      wager: bet.position.cost, shares: bet.position.shares, entryPrice: bet.position.entryPrice, pnl,
      bankrollAfter: engine.bankroll, resolvedAt: Date.now(),
    });
    if (engine.history.length > 300) engine.history.pop();
    log(`🏆 [${leg.slug}] (${betKey}) resolved — winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — our ${side.toUpperCase()} bet ${win ? 'WON' : 'LOST'} ${sgn2(pnl)} | bankroll $${engine.bankroll.toFixed(2)}`);
  }

  function settleTrade(trade) {
    settleBetAtResolution(trade, 'early');
    settleBetAtResolution(trade, 'late');
    trade.state = 'resolved';
    trade.settled = true;
    recordEquity();
  }

  function currentWindowTs(nowSec) { return Math.floor(nowSec / windowSeconds) * windowSeconds; }

  async function tickBtc(now) {
    const nowSec = Math.floor(now / 1000);
    const windowTs = currentWindowTs(nowSec);
    let trade = engine.current.btc;

    if (!trade || trade.windowTs !== windowTs) {
      if (trade && !trade.settled) {
        if (!trade.leg.resolved) await attemptFastResolution(trade.leg);
        if (trade.leg.resolved && !trade.settled) {
          settleTrade(trade);
        } else {
          log(`⚠️  [${trade.leg.slug}] couldn't fast-resolve at close — falling back to slower resolution`);
          trade.state = 'pending-resolution';
          engine.pending.push(trade);
          if (engine.pending.length > 40) {
            const dropped = engine.pending.shift();
            log(`⚠️  dropped stale pending window ${dropped.leg.slug} from the resolution queue`);
          }
        }
      }
      if (windowTs < engine.boundaryWindowTs) return;

      trade = freshTrade(windowTs);
      engine.current.btc = trade;
      log(`🆕 new window t=${windowTs} — discovering market… early band $${earlyPriceLow}-$${earlyPriceHigh} @ ${earlyStartSec}s-${earlyEndSec}s (TP $${takeProfitPrice}) · late band $${latePriceLow}-$${latePriceHigh} @ ${lateStartSec}s-${lateEndSec}s`);
    }

    if (!trade.leg.discovered && now - trade.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
      trade.leg.lastDiscoveryAttempt = now;
      await discoverLeg(trade.leg);
      if (trade.leg.discovered) trade.state = 'trading';
    }

    if (trade.state === 'trading' && engine.tradingEnabled && now < trade.closeAt) {
      const elapsedSec = Math.floor((now - windowTs * 1000) / 1000);

      if (!trade.early.betPlaced) {
        const hit = checkEarlyBand(trade.leg, elapsedSec);
        if (hit) await placeBet(trade, 'early', hit.side, hit.price);
      } else {
        await checkTakeProfit(trade);
      }

      if (!trade.late.betPlaced) {
        const hit = checkLateBand(trade.leg, elapsedSec);
        if (hit) await placeBet(trade, 'late', hit.side, hit.price);
      }
    }
  }

  async function mainLoop() {
    while (true) {
      try {
        const now = Date.now();
        const nowSec = Math.floor(now / 1000);

        if (engine.waitingForBoundary) {
          if (engine.boundaryWindowTs == null) {
            engine.boundaryWindowTs = currentWindowTs(nowSec) + windowSeconds;
            log(`⏳ started mid-window — waiting for next fresh boundary (t=${engine.boundaryWindowTs}) before trading begins`);
          }
          if (nowSec >= engine.boundaryWindowTs) {
            engine.waitingForBoundary = false;
            log('🚦 new boundary reached — trading starts now');
          }
        }

        if (!engine.waitingForBoundary) await tickBtc(now);

        if (now - engine.lastPriceFetch >= PRICE_REFRESH_MS) {
          engine.lastPriceFetch = now;
          const legs = allTrackedTrades().map(t => t.leg);
          await Promise.all(legs.map(refreshLegPrices));
        }
        if (engine.pending.length && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
          engine.lastResolutionPoll = now;
          const stillPending = [];
          for (const trade of engine.pending) {
            if (!trade.leg.resolved) await resolveLegAttempt(trade.leg);
            if (trade.leg.resolved && !trade.settled) settleTrade(trade);
            if (!trade.settled) stillPending.push(trade);
          }
          engine.pending = stillPending;
        }

        emitFn(`hedgeState:${label}`, buildState());
      } catch (e) {
        slog(`[hedgebot] ⚠️  [${label}] Loop error: ${e.message}`);
      }
      await new Promise(res => setTimeout(res, TICK_MS));
    }
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
  function betSummary(trade, betKey) {
    const bet = trade[betKey];
    return {
      side: bet.side,
      betPlaced: bet.betPlaced,
      skipReason: bet.skipReason,
      closedEarly: bet.closedEarly,
      position: bet.position ? { shares: bet.position.shares, cost: bet.position.cost, entryPrice: bet.position.entryPrice } : null,
      pnl: bet.pnl,
      unrealizedPnl: unrealizedForBet(trade, betKey),
    };
  }
  function tradeSummary(trade) {
    if (!trade) return null;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - trade.windowTs * 1000) / 1000));
    return {
      windowTs: trade.windowTs, closeAt: trade.closeAt, state: trade.state,
      leg: legSummary(trade.leg),
      early: betSummary(trade, 'early'),
      late: betSummary(trade, 'late'),
      earlyInWindow: elapsedSec >= earlyStartSec && elapsedSec <= earlyEndSec,
      lateInWindow: elapsedSec >= lateStartSec && elapsedSec <= lateEndSec,
      secondsToEarlyEnd: Math.max(0, earlyEndSec - elapsedSec),
      secondsToLateStart: Math.max(0, lateStartSec - elapsedSec),
      secondsToLateEnd: Math.max(0, lateEndSec - elapsedSec),
    };
  }

  function buildState() {
    const unrealizedPnl = totalUnrealizedPnl();
    const equity = round2(engine.bankroll + openPositionsMTM());
    const totalDecided = engine.wins + engine.losses;
    return {
      label, windowSeconds,
      dryRun: DRY_RUN,
      tradingEnabled: engine.tradingEnabled,
      waitingForBoundary: engine.waitingForBoundary,
      bankroll: engine.bankroll,
      startingCapital,
      betDollars,
      earlyStartSec, earlyEndSec, earlyPriceLow, earlyPriceHigh, takeProfitPrice,
      lateStartSec, lateEndSec, latePriceLow, latePriceHigh,
      realizedPnl: engine.realizedPnl, unrealizedPnl, equity,
      wins: engine.wins, losses: engine.losses, skipped: engine.skipped,
      winRate: totalDecided > 0 ? round2(engine.wins / totalDecided) : null,
      current: { btc: tradeSummary(engine.current.btc) },
      pendingResolutionCount: engine.pending.length,
      pending: engine.pending.map(tradeSummary),
      history: engine.history.slice(0, 60),
      trades: engine.trades.slice(-100).slice().reverse(),
      equityCurve: engine.equityCurve,
      logs: engine.logs.slice(-80),
    };
  }

  function pauseTrading() {
    engine.tradingEnabled = false;
    log('⏸️  Trading paused — no new bets will be placed; open positions still tracked to take-profit/resolution');
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

  async function start(emit, slogFn) {
    emitFn = emit;
    slog = slogFn;
    slog(`[hedgebot] 🪙 ${label} Simple Price-Band Engine (2 rules) — no indicators, no patterns, no learning`);
    slog(`[hedgebot] ⚙️  [${label}] EARLY rule: ${earlyStartSec}s-${earlyEndSec}s, band $${earlyPriceLow}-$${earlyPriceHigh}, buy $${betDollars}, take-profit at $${takeProfitPrice}.`);
    slog(`[hedgebot] ⚙️  [${label}] LATE rule: ${lateStartSec}s-${lateEndSec}s, band $${latePriceLow}-$${latePriceHigh} (cheaper side), buy $${betDollars}, hold to resolution.`);
    slog(`[hedgebot] ⚙️  [${label}] Starting bankroll (scoreboard only): $${startingCapital}. ${DRY_RUN ? 'DEMO' : 'LIVE'} mode.`);
    if (savedStats) {
      slog(`[hedgebot] 💾 [${label}] Restored saved stats — bankroll $${engine.bankroll.toFixed(2)}, ${engine.wins}W/${engine.losses}L.`);
    } else if (statsStatePath) {
      slog(`[hedgebot] 💾 [${label}] No previous saved stats — starting fresh at $${startingCapital}.`);
    }
    mainLoop().catch(e => slog(`[hedgebot] ❌ [${label}] Fatal: ${e.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState, getStatus: buildState };
}

module.exports = { createEngine };
