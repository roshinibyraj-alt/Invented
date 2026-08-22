'use strict';

const fs = require('fs');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const TICK_MS = 200;
const DISCOVERY_RETRY_MS = 500;
const EQUITY_RECORD_MS = 1000;
const EXECUTION_RETRY_MS = 2000;
const WINNER_PRICE = 0.90;

function round2(value) { return Math.round(value * 100) / 100; }
function round3(value) { return Math.round(value * 1000) / 1000; }
function money(value) { return (value > 0 ? '+$' : value < 0 ? '-$' : '$') + Math.abs(value).toFixed(2); }

async function getJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function createEngine(config) {
  const {
    label = 'BTC-MARTINGALE',
    startingCapital = 4000,
    windowType = '5m',
    windowSeconds5 = 300,
    baseStakeUsd = 50,
    martingaleMultiplier = 1.5,
    maxMartingales = 3,
    entryMin = 0.60,
    entryMax = 0.70,
    stopLossPrice = 0.45,
    feeTheta = 0.07,
    trader,
    dryRun = true,
    statsStatePath,
    emit = () => {},
    slog = () => {},
    nowFn = Date.now,
    tickMs = TICK_MS,
    priceRefreshMs = 200,
  } = config;

  const winSec = windowSeconds5;
  const capital = round2(startingCapital);
  let dryRunMode = dryRun;
  let positionSequence = 0;
  let executionRetryAt = 0;

  function loadStats() {
    if (!statsStatePath) return null;
    try { return JSON.parse(fs.readFileSync(statsStatePath, 'utf8')); } catch (_) { return null; }
  }

  const saved = loadStats();
  const engine = {
    bankroll: saved ? saved.bankroll : capital,
    realizedPnl: saved ? saved.realizedPnl || 0 : 0,
    wins: saved ? saved.wins || 0 : 0,
    losses: saved ? saved.losses || 0 : 0,
    history: saved && Array.isArray(saved.history) ? saved.history : [],
    equityCurve: saved && Array.isArray(saved.equityCurve) && saved.equityCurve.length
      ? saved.equityCurve
      : [{ t: nowFn(), equity: capital }],
    totalFeesPaid: saved ? saved.totalFeesPaid || 0 : 0,
    up: freshSideState(),
    down: freshSideState(),
    leg: null,
    position: null,
    windowTradeCount: 0,
    windowSides: [],
    windowPnl: 0,
    lastPriceFetch: 0,
    lastEquityRecord: 0,
    logs: [],
  };

  function freshSideState() {
    return { mid: null };
  }

  function log(message) {
    const line = `[${label}] ${new Date().toISOString()} ${message}`;
    engine.logs.push(line);
    if (engine.logs.length > 300) engine.logs.shift();
    slog(line);
  }

  function saveStats() {
    if (!statsStatePath) return;
    try {
      fs.writeFileSync(statsStatePath, JSON.stringify({
        bankroll: engine.bankroll,
        realizedPnl: engine.realizedPnl,
        wins: engine.wins,
        losses: engine.losses,
        history: engine.history.slice(0, 100),
        equityCurve: engine.equityCurve.slice(-300),
        totalFeesPaid: engine.totalFeesPaid,
        savedAt: nowFn(),
      }));
    } catch (_) {}
  }

  function parseTokens(market) {
    try {
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes || [];
      const tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds || [];
      return outcomes.map((outcome, index) => ({ outcome, token_id: tokenIds[index] || null }));
    } catch (_) { return []; }
  }

  function freshLeg(windowTs) {
    return {
      slug: `btc-updown-${windowType}-${windowTs}`,
      windowTs,
      closeAt: (windowTs + winSec) * 1000,
      conditionId: null,
      upTokenId: null,
      downTokenId: null,
      discovered: false,
      lastDiscoveryAttempt: 0,
      resolved: false,
      winner: null,
    };
  }

  async function discoverLeg(leg) {
    const prefix = leg.slug.split('-').slice(0, -1).join('-');
    const candidates = [
      leg.slug,
      `${prefix}-${leg.windowTs - winSec}`,
      `${prefix}-${leg.windowTs + winSec}`,
    ];
    for (const slug of candidates) {
      try {
        const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`).catch(() => null);
        const event = Array.isArray(events) ? events[0] : null;
        const market = event?.markets?.[0];
        if (!market) continue;
        const tokens = parseTokens(market);
        const up = tokens.find(token => /up/i.test(token.outcome));
        const down = tokens.find(token => /down/i.test(token.outcome));
        if (!up?.token_id || !down?.token_id) continue;
        leg.conditionId = market.conditionId || null;
        leg.upTokenId = up.token_id;
        leg.downTokenId = down.token_id;
        leg.slug = slug;
        leg.discovered = true;
        engine.up.mid = null;
        engine.down.mid = null;
        log(`🎯 leg discovered ${slug}`);
        return;
      } catch (error) {
        log(`⚠️ discovery: ${error.message}`);
      }
    }
  }

  async function refreshPrices(leg) {
    if (!leg.upTokenId || !leg.downTokenId) return;
    const [upResponse, downResponse] = await Promise.all([
      getJSON(`${CLOB}/midpoint?token_id=${leg.upTokenId}`).catch(() => null),
      getJSON(`${CLOB}/midpoint?token_id=${leg.downTokenId}`).catch(() => null),
    ]);
    if (upResponse?.mid != null) engine.up.mid = parseFloat(upResponse.mid);
    if (downResponse?.mid != null) engine.down.mid = parseFloat(downResponse.mid);
  }

  function getPrice(side) {
    return side === 'up' ? engine.up.mid : engine.down.mid;
  }

  function getTokenId(side) {
    return side === 'up' ? engine.leg.upTokenId : engine.leg.downTokenId;
  }

  function computeFee(shares, price) {
    return shares * feeTheta * price * (1 - price);
  }

  function stakeForLevel(level) {
    return round2(baseStakeUsd * Math.pow(martingaleMultiplier, level));
  }

  function maxLevels() {
    return maxMartingales + 1;
  }

  function markExecutionRetry() {
    executionRetryAt = nowFn() + EXECUTION_RETRY_MS;
  }

  async function enterPosition() {
    const now = nowFn();
    if (!engine.leg?.discovered || engine.position || now < executionRetryAt) return;
    const nextLevel = engine.windowTradeCount;
    if (nextLevel >= maxLevels()) return;

    const qualifyingSides = ['up', 'down'].filter(side => {
      const price = getPrice(side);
      return price != null && price >= entryMin && price <= entryMax;
    });
    if (!qualifyingSides.length) return;

    qualifyingSides.sort((left, right) => getPrice(right) - getPrice(left));
    const side = qualifyingSides[0];
    let entryPrice = round2(Math.ceil(getPrice(side) * 100) / 100);

    if (!dryRunMode) {
      const book = await trader.getBestBidAsk(getTokenId(side));
      if (!book?.bestAsk || book.bestAsk < entryMin || book.bestAsk > entryMax) {
        markExecutionRetry();
        log(`⏳ ${side.toUpperCase()} ask unavailable/outside zone — no fallback`);
        return;
      }
      entryPrice = round2(book.bestAsk);
    }

    const targetStake = stakeForLevel(nextLevel);
    const shares = Math.max(0.01, Math.floor((targetStake / entryPrice) * 100) / 100);
    const fee = computeFee(shares, entryPrice);
    const cost = round2(shares * entryPrice + fee);

    if (!dryRunMode) {
      const order = await trader.placeFokLimitOrder(getTokenId(side), 'BUY', entryPrice, shares);
      if (!order.isFilled) {
        markExecutionRetry();
        log(`❌ ${side.toUpperCase()} BUY REJECTED ${shares}sh @${entryPrice.toFixed(2)} — no fallback`);
        return;
      }
      const fillPrice = parseFloat(order.avgPrice);
      if (Number.isFinite(fillPrice) && fillPrice > 0) entryPrice = Math.min(0.99, Math.max(0.01, fillPrice));
    }

    engine.bankroll = round2(engine.bankroll - cost);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    engine.position = {
      id: ++positionSequence,
      side,
      level: nextLevel,
      label: nextLevel === 0 ? 'BASE' : `MG${nextLevel}`,
      stake: targetStake,
      shares,
      entryPrice,
      cost,
      openedAtMs: now,
    };
    engine.windowTradeCount += 1;
    engine.windowSides.push(side.toUpperCase());
    executionRetryAt = 0;
    log(`🎯 ${side.toUpperCase()} ${engine.position.label} BUY — $${targetStake.toFixed(2)} → ${shares}sh @${entryPrice.toFixed(2)} | cost $${cost.toFixed(2)} | stop ${stopLossPrice.toFixed(2)}`);
  }

  function closePosition(exitPrice, closeType) {
    const position = engine.position;
    const proceeds = round2(position.shares * exitPrice);
    const fee = computeFee(position.shares, exitPrice);
    const netProceeds = round2(proceeds - fee);
    const pnl = round2(netProceeds - position.cost);
    engine.bankroll = round2(engine.bankroll + netProceeds);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    engine.windowPnl = round2(engine.windowPnl + pnl);
    if (pnl > 0) engine.wins += 1; else engine.losses += 1;
    engine.position = null;
    log(`${closeType === 'STOP' ? '🛑' : '🏁'} ${position.side.toUpperCase()} ${position.label} ${closeType} — ${position.shares}sh @${exitPrice.toFixed(2)} | PnL ${money(pnl)}`);
    return pnl;
  }

  async function checkStopLoss() {
    const position = engine.position;
    if (!position || !engine.leg?.discovered) return;
    const price = getPrice(position.side);
    if (price == null || price > stopLossPrice) return;
    if (nowFn() < executionRetryAt) return;

    let exitPrice = round2(Math.floor(price * 100) / 100);
    if (!dryRunMode) {
      const order = await trader.placeFokSell(getTokenId(position.side), position.shares);
      if (!order.isFilled) {
        markExecutionRetry();
        log(`❌ ${position.side.toUpperCase()} STOP SELL REJECTED — retrying while stop remains active`);
        return;
      }
      const fillPrice = parseFloat(order.avgPrice);
      if (Number.isFinite(fillPrice) && fillPrice > 0) exitPrice = Math.min(0.99, Math.max(0.01, fillPrice));
    }
    closePosition(exitPrice, 'STOP');
    executionRetryAt = 0;
  }

  async function attemptFastResolution(leg) {
    if (leg.resolved) return true;
    if (engine.up.mid > WINNER_PRICE) { leg.resolved = true; leg.winner = 'up'; return true; }
    if (engine.down.mid > WINNER_PRICE) { leg.resolved = true; leg.winner = 'down'; return true; }
    return false;
  }

  async function resolveLegOfficially(leg) {
    if (leg.resolved) return true;
    try {
      let market = null;
      if (leg.conditionId) {
        const markets = await getJSON(`${GAMMA}/markets?condition_ids=${encodeURIComponent(leg.conditionId)}`).catch(() => null);
        market = Array.isArray(markets) ? markets[0] : null;
      }
      if (!market) {
        const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(leg.slug)}`).catch(() => null);
        const event = Array.isArray(events) ? events[0] : null;
        market = event?.markets?.[0] || null;
      }
      if (!market?.closed || !market.outcomePrices) return false;
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const tokens = parseTokens(market);
      const upIndex = tokens.findIndex(token => String(token.token_id) === String(leg.upTokenId));
      if (upIndex < 0 || prices[upIndex] == null) return false;
      leg.resolved = true;
      leg.winner = parseFloat(prices[upIndex]) >= 0.5 ? 'up' : 'down';
      log(`🏁 official resolution — ${leg.winner.toUpperCase()}`);
      return true;
    } catch (_) { return false; }
  }

  function settleWindow(winner) {
    const position = engine.position;
    if (position) {
      const payout = winner === position.side ? position.shares : 0;
      const pnl = round2(payout - position.cost);
      engine.bankroll = round2(engine.bankroll + payout);
      engine.realizedPnl = round2(engine.realizedPnl + pnl);
      engine.windowPnl = round2(engine.windowPnl + pnl);
      if (pnl > 0) engine.wins += 1; else engine.losses += 1;
      engine.position = null;
      log(`🏁 ${position.side.toUpperCase()} ${position.label} RESOLVED — PnL ${money(pnl)}`);
    }

    engine.history.unshift({
      windowTs: engine.leg.windowTs,
      slug: engine.leg.slug,
      winner: winner || 'unresolved',
      sides: engine.windowSides.join('/') || 'NONE',
      trades: engine.windowTradeCount,
      martingales: Math.max(0, engine.windowTradeCount - 1),
      pnl: engine.windowPnl,
      bankrollAfter: engine.bankroll,
    });
    if (engine.history.length > 300) engine.history.length = 300;
    saveStats();
  }

  function resetWindowState() {
    engine.position = null;
    engine.windowTradeCount = 0;
    engine.windowSides = [];
    engine.windowPnl = 0;
    executionRetryAt = 0;
  }

  async function mainLoop() {
    while (true) {
      try {
        const now = nowFn();
        const windowTs = Math.floor(now / 1000 / winSec) * winSec;
        if (!engine.leg || engine.leg.windowTs !== windowTs) {
          if (engine.leg) {
            const oldLeg = engine.leg;
            if (!oldLeg.resolved) await attemptFastResolution(oldLeg);
            if (!oldLeg.resolved) await resolveLegOfficially(oldLeg);
            settleWindow(oldLeg.winner);
          }
          engine.leg = freshLeg(windowTs);
          engine.up = freshSideState();
          engine.down = freshSideState();
          resetWindowState();
          log(`🆕 window t=${windowTs}`);
        }

        const leg = engine.leg;
        if (!leg.discovered && now - leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
          leg.lastDiscoveryAttempt = now;
          await discoverLeg(leg);
        }
        if (now - engine.lastPriceFetch >= priceRefreshMs) {
          engine.lastPriceFetch = now;
          await refreshPrices(leg);
        }
        if (leg.discovered) {
          await checkStopLoss();
          await enterPosition();
        }
        if (now - engine.lastEquityRecord >= EQUITY_RECORD_MS) {
          engine.lastEquityRecord = now;
          const position = engine.position;
          const markPrice = position ? getPrice(position.side) || 0 : 0;
          const unrealized = position ? position.shares * markPrice - position.cost : 0;
          engine.equityCurve.push({ t: now, equity: round2(engine.bankroll + unrealized) });
          if (engine.equityCurve.length > 10000) engine.equityCurve.shift();
        }
        emitState();
      } catch (error) {
        log(`⚠️ loop: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, tickMs));
    }
  }

  function buildState() {
    const leg = engine.leg;
    const position = engine.position;
    const markPrice = position ? getPrice(position.side) || 0 : 0;
    const unrealizedPnl = position ? round2(position.shares * markPrice - position.cost) : 0;
    const decided = engine.wins + engine.losses;
    return {
      label,
      strategy: 'martingale',
      dryRun: dryRunMode,
      windowSeconds: winSec,
      baseStakeUsd,
      martingaleMultiplier,
      maxMartingales,
      entryMin,
      entryMax,
      stopLossPrice,
      nextStakeIfStopped: position ? stakeForLevel(Math.min(maxLevels() - 1, position.level + 1)) : stakeForLevel(engine.windowTradeCount),
      canEnter: engine.windowTradeCount < maxLevels(),
      bankroll: engine.bankroll,
      startingCapital: capital,
      realizedPnl: engine.realizedPnl,
      unrealizedPnl,
      equity: round2(engine.bankroll + unrealizedPnl),
      equityCurve: engine.equityCurve.slice(-200),
      wins: engine.wins,
      losses: engine.losses,
      winRate: decided ? round2(engine.wins / decided * 100) : null,
      totalFeesPaid: engine.totalFeesPaid,
      position: position ? {
        ...position,
        markPrice,
        unrealizedPnl,
        stopLossPrice,
      } : null,
      currentLeg: leg ? {
        slug: leg.slug,
        discovered: leg.discovered,
        upMid: engine.up.mid,
        downMid: engine.down.mid,
        secsLeft: Math.max(0, Math.round((leg.closeAt - nowFn()) / 1000)),
      } : null,
      history: engine.history.slice(0, 30),
      logs: engine.logs.slice(-50),
    };
  }

  function emitState() { emit(`hedgeState:${label}`, buildState()); }
  function pauseTrading() { return { ok: true }; }
  function resumeTrading() { return { ok: true }; }
  function setMode(live) {
    dryRunMode = !live;
    log(`⚙️ ${live ? 'LIVE' : 'DEMO'} mode`);
    return { ok: true };
  }

  function start() {
    log(`⛏ ${label} — Martingale restored`);
    log(`⚙️ Entry ${entryMin.toFixed(2)}-${entryMax.toFixed(2)} | stop ${stopLossPrice.toFixed(2)} | base $${baseStakeUsd.toFixed(2)}`);
    log(`⚙️ ${martingaleMultiplier.toFixed(2)}x martingale | max ${maxMartingales} | ${dryRunMode ? 'DEMO' : 'LIVE'}`);
    mainLoop().catch(error => log(`❌ fatal: ${error.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine };
