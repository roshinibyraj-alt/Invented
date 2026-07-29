'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  SIMPLE PRICE-BAND ENGINE  (no indicators, no patterns, no candles, no learning)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Call createEngine(config) once per timeframe (5-minute, 15-minute).
 *
 *  ── THE ENTIRE STRATEGY ──
 *  For each window, watch the live Polymarket order book for the UP and
 *  DOWN tokens. During a specific late-window time band, check whichever
 *  side is currently cheaper. The FIRST moment that cheaper side's ask
 *  price falls within [priceLow, priceHigh] (default $0.10-$0.20), buy
 *  $betDollars worth of it immediately. One bet per window, max.
 *
 *  If the price never falls in that band during the check window, no
 *  bet is placed that window — the bot just watches and moves on.
 *
 *  That is the whole decision rule. No candlestick patterns, no RSI/
 *  MACD/etc, no historical price data, nothing that "learns." Same
 *  mechanical check every window, forever.
 *
 *  HONESTY NOTE: buying a side priced at $0.10-$0.20 very late in a
 *  window means the market currently thinks that side has roughly a
 *  10-20% chance of winning — you are deliberately taking the less
 *  likely outcome at that snapshot, for a bigger payout if it hits.
 *  This is a long-shot bet, not a "safe" one. Whether long-shots are
 *  systematically under- or over-priced on Polymarket's crypto markets
 *  isn't something this bot assumes either way — it's just a mechanical
 *  rule, and the results over enough windows are the actual answer.
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
    label,                        // 'BTC-5m' / 'BTC-15m'
    windowSeconds,                 // 300 or 900
    slugPrefix,                    // 'btc-updown-5m-' or 'btc-updown-15m-'
    statsStatePath,
    startingCapital = 2000,
    betDollars = 50,
    priceLow = 0.10,
    priceHigh = 0.20,
    // Time band (seconds INTO the window) during which the price check runs.
    // Defaults scale proportionally from the reference 5-minute rule
    // (check between 240s-290s of a 300s window) unless overridden.
    checkStartSec = Math.round(240 * (windowSeconds / 300)),
    checkEndSec = Math.round(290 * (windowSeconds / 300)),
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

  // ── THE ENTIRE STRATEGY LOGIC ──
  function checkPriceBand(leg, elapsedSec) {
    if (elapsedSec < checkStartSec || elapsedSec > checkEndSec) return null;
    const upAsk = leg.upAsk, downAsk = leg.downAsk;
    if (upAsk == null && downAsk == null) return null;
    const cheapSide = (upAsk == null) ? 'down' : (downAsk == null ? 'up' : (upAsk <= downAsk ? 'up' : 'down'));
    const cheapPrice = cheapSide === 'up' ? upAsk : downAsk;
    if (cheapPrice == null) return null;
    if (cheapPrice >= priceLow && cheapPrice <= priceHigh) {
      return { side: cheapSide, price: cheapPrice };
    }
    return null;
  }

  function freshTrade(windowTs) {
    return {
      asset: 'btc', label, windowTs,
      closeAt: (windowTs + windowSeconds) * 1000,
      leg: freshLeg(windowTs),
      state: 'discovering',
      side: null, entryPriceSeen: null,
      betPlaced: false,
      skipReason: null,
      position: null,
      pnl: null,
      settled: false,
    };
  }

  async function placeBandBet(trade, side, seenPrice) {
    if (trade.betPlaced) return;
    const leg = trade.leg;
    const tokenId = tokenIdFor(leg, side);
    const ask = side === 'up' ? leg.upAsk : leg.downAsk;
    if (!tokenId || ask == null) return;

    const shares = round2(betDollars / ask);
    if (shares < minOrderShares) {
      trade.betPlaced = true;
      trade.side = side;
      trade.skipReason = 'below-min-shares';
      log(`⚠️  [${leg.slug}] ${side.toUpperCase()} @${ask.toFixed(3)} in band, but $${betDollars} = ${shares.toFixed(2)}sh, below ${minOrderShares}sh minimum — no bet`);
      return;
    }

    const resp = await placeTakerBuy(tokenId, ask, shares);
    if (!resp) { log(`❌ [${leg.slug}] ${side.toUpperCase()} band bet failed to place — will retry while still in band`); return; }
    if (!resp.filledNow) { log(`⌛ [${leg.slug}] ${side.toUpperCase()} band bet didn't fill immediately — will retry while still in band`); return; }

    trade.betPlaced = true;
    trade.side = side;
    trade.entryPriceSeen = seenPrice;
    const avgPrice = resp.avgPrice || ask;
    const filledShares = resp.filledShares || shares;
    const cost = round2(filledShares * avgPrice);

    trade.position = { shares: filledShares, cost, entryPrice: avgPrice, ts: Date.now() };
    engine.bankroll = round2(engine.bankroll - cost);

    registerTrade({ slug: leg.slug, step: `${side.toUpperCase()} band bet`, side, price: avgPrice, shares: filledShares, cost });
    log(`✅ [${leg.slug}] ${side.toUpperCase()} was cheapest at $${seenPrice.toFixed(3)} (in $${priceLow}-$${priceHigh} band) — bought ${filledShares.toFixed(2)}sh @${avgPrice.toFixed(3)} ($${cost.toFixed(2)}) | bankroll $${engine.bankroll.toFixed(2)}`);
    recordEquity();
  }

  function unrealizedForTrade(trade) {
    if (!trade || !trade.position || trade.settled || (trade.leg && trade.leg.resolved)) return 0;
    const mp = markPrice(trade.leg, trade.side);
    const mark = mp != null ? mp : (trade.position.cost / trade.position.shares);
    return round2(trade.position.shares * mark - trade.position.cost);
  }
  function openCostForTrade(trade) { return trade && trade.position ? trade.position.cost : 0; }
  function allTrackedTrades() {
    const list = [...engine.pending];
    if (engine.current.btc) list.push(engine.current.btc);
    return list;
  }
  function totalUnrealizedPnl() { return round2(allTrackedTrades().reduce((sum, t) => sum + unrealizedForTrade(t), 0)); }
  function openPositionsMTM() { return round2(allTrackedTrades().reduce((sum, t) => sum + openCostForTrade(t) + unrealizedForTrade(t), 0)); }

  function settleTrade(trade) {
    const leg = trade.leg;

    if (!trade.side || !trade.position) {
      trade.state = 'resolved';
      trade.settled = true;
      trade.pnl = 0;
      engine.skipped++;
      const reason = !trade.side ? 'price never entered $' + priceLow + '-$' + priceHigh + ' band during check window' : `no bet placed (${trade.skipReason || 'no fill'})`;
      registerTrade({ slug: leg.slug, step: 'window resolution (no bet)', side: leg.winner, price: null, shares: 0, pnl: 0 });
      engine.history.unshift({
        windowTs: trade.windowTs, slug: leg.slug, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
        side: trade.side, betPlaced: false, win: null,
        wager: 0, shares: 0, pnl: 0, bankrollAfter: engine.bankroll, resolvedAt: Date.now(),
      });
      if (engine.history.length > 300) engine.history.pop();
      log(`🏁 [${leg.slug}] resolved — winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — ${reason}`);
      recordEquity();
      return;
    }

    const side = trade.side;
    const win = side === leg.winner;
    const payout = win ? round2(trade.position.shares * 1) : 0;
    const pnl = round2(payout - trade.position.cost);

    engine.bankroll = round2(engine.bankroll + payout);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);
    if (win) engine.wins++; else engine.losses++;

    trade.pnl = pnl;
    trade.state = 'resolved';
    trade.settled = true;

    registerTrade({ slug: leg.slug, step: 'window resolution', side: leg.winner, price: 1, shares: trade.position.shares, pnl });
    engine.history.unshift({
      windowTs: trade.windowTs, slug: leg.slug, winner: leg.winner, resolutionMethod: leg.resolutionMethod,
      side, betPlaced: true, win,
      wager: trade.position.cost, shares: trade.position.shares, entryPrice: trade.position.entryPrice, pnl,
      bankrollAfter: engine.bankroll, resolvedAt: Date.now(),
    });
    if (engine.history.length > 300) engine.history.pop();

    log(`🏆 [${leg.slug}] resolved — winner ${leg.winner.toUpperCase()} (${leg.resolutionMethod}) — our ${side.toUpperCase()} long-shot bet ${win ? 'WON' : 'LOST'} ${sgn2(pnl)} | bankroll $${engine.bankroll.toFixed(2)}`);
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
      log(`🆕 new window t=${windowTs} — discovering market… will check for a cheap side ($${priceLow}-$${priceHigh}) between ${checkStartSec}s-${checkEndSec}s into this ${windowSeconds}s window`);
    }

    if (!trade.leg.discovered && now - trade.leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
      trade.leg.lastDiscoveryAttempt = now;
      await discoverLeg(trade.leg);
      if (trade.leg.discovered) trade.state = 'trading';
    }

    if (trade.state === 'trading' && engine.tradingEnabled && now < trade.closeAt && !trade.betPlaced) {
      const elapsedSec = Math.floor((now - windowTs * 1000) / 1000);
      const hit = checkPriceBand(trade.leg, elapsedSec);
      if (hit) await placeBandBet(trade, hit.side, hit.price);
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
  function tradeSummary(trade) {
    if (!trade) return null;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - trade.windowTs * 1000) / 1000));
    return {
      windowTs: trade.windowTs, closeAt: trade.closeAt, state: trade.state,
      leg: legSummary(trade.leg),
      side: trade.side,
      betPlaced: trade.betPlaced,
      skipReason: trade.skipReason,
      inCheckWindow: elapsedSec >= checkStartSec && elapsedSec <= checkEndSec,
      secondsToCheckStart: Math.max(0, checkStartSec - elapsedSec),
      secondsToCheckEnd: Math.max(0, checkEndSec - elapsedSec),
      position: trade.position ? { shares: trade.position.shares, cost: trade.position.cost, entryPrice: trade.position.entryPrice } : null,
      pnl: trade.pnl,
      unrealizedPnl: unrealizedForTrade(trade),
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
      betDollars, priceLow, priceHigh, checkStartSec, checkEndSec,
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

  async function start(emit, slogFn) {
    emitFn = emit;
    slog = slogFn;
    slog(`[hedgebot] 🪙 ${label} Simple Price-Band Engine — no indicators, no patterns, no learning`);
    slog(`[hedgebot] ⚙️  [${label}] Rule: between ${checkStartSec}s-${checkEndSec}s into each ${windowSeconds}s window, if the cheaper side's ask is $${priceLow}-$${priceHigh}, buy $${betDollars} of it immediately. One bet per window, max. Starting bankroll (scoreboard only): $${startingCapital}. ${DRY_RUN ? 'DEMO' : 'LIVE'} mode.`);
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
