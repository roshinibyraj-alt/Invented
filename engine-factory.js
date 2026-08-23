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
    martingaleMultiplier = 2.1,
    maxMartingales = 5,
    entryPrice = 0.70,
    entryStartSecond = 30,
    entryEndSecond = 270,
    allowedWindows = null,
    stopLossPrice = 0.45,
    strategy = 'walkthrough',
    sharedCapital = null,
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
    bankroll: sharedCapital ? 0 : (saved ? saved.bankroll : capital),
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
    positions: [],
    martingaleLevel: saved ? saved.martingaleLevel || 0 : 0,
    lastTradeWindowTs: saved ? saved.lastTradeWindowTs || null : null,
    windowTradeCount: 0,
    windowMartingaleLevel: 0,
    windowSides: [],
    windowPnl: 0,
    firedBlocks: {},
    pendingOrders: saved && Array.isArray(saved.pendingOrders) ? saved.pendingOrders : [],
    lastPriceFetch: 0,
    lastEquityRecord: 0,
    logs: [],
  };

  function freshSideState() {
    return { mid: null, previousMid: null };
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
        equityCurve: engine.equityCurve.slice(-10000),
        totalFeesPaid: engine.totalFeesPaid,
        martingaleLevel: engine.martingaleLevel,
        lastTradeWindowTs: engine.lastTradeWindowTs,
        pendingOrders: engine.pendingOrders,
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
    const previousUp = engine.up.mid;
    const previousDown = engine.down.mid;
    const [upResponse, downResponse] = await Promise.all([
      getJSON(`${CLOB}/midpoint?token_id=${leg.upTokenId}`).catch(() => null),
      getJSON(`${CLOB}/midpoint?token_id=${leg.downTokenId}`).catch(() => null),
    ]);
    if (upResponse?.mid != null) {
      engine.up.previousMid = previousUp;
      engine.up.mid = parseFloat(upResponse.mid);
    }
    if (downResponse?.mid != null) {
      engine.down.previousMid = previousDown;
      engine.down.mid = parseFloat(downResponse.mid);
    }
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

  function isWalkThrough(price, previousPrice) {
    if (price == null || price < entryPrice - 0.0005) return false;
    return previousPrice != null && previousPrice < entryPrice - 0.0005;
  }

  function registerResult(position, pnl) {
    if (pnl > 0) {
      engine.martingaleLevel = 0;
      log(`✅ sequence won — reset to $${stakeForLevel(0).toFixed(2)}`);
    } else if (position.level >= maxMartingales) {
      engine.martingaleLevel = 0;
      log(`⚠️ MG${maxMartingales} lost — progression exhausted, restarting base`);
    } else {
      engine.martingaleLevel = position.level + 1;
      log(`⏭ next-window ${engine.martingaleLevel === 0 ? 'BASE' : 'MG' + engine.martingaleLevel} stake $${stakeForLevel(engine.martingaleLevel).toFixed(2)}`);
    }
    saveStats();
  }

  function adjustCapital(cashDelta, feeDelta = 0) {
    if (sharedCapital) sharedCapital.adjust(cashDelta, feeDelta);
    else engine.bankroll = round2(engine.bankroll + cashDelta);
  }

  function markExecutionRetry() {
    executionRetryAt = nowFn() + EXECUTION_RETRY_MS;
  }

  function elapsedSecond() {
    if (!engine.leg) return null;
    return Math.floor((nowFn() - engine.leg.windowTs * 1000) / 1000);
  }

  function currentBlock() {
    const second = elapsedSecond();
    if (!allowedWindows || !Array.isArray(allowedWindows)) return null;
    for (let i = 0; i < allowedWindows.length; i++) {
      if (second >= allowedWindows[i].start && second < allowedWindows[i].end) return i;
    }
    return null;
  }

  function entryAllowed() {
    const second = elapsedSecond();
    if (allowedWindows && Array.isArray(allowedWindows)) {
      return second != null && allowedWindows.some(w => second >= w.start && second < w.end);
    }
    return second != null && second >= entryStartSecond && second < entryEndSecond;
  }

  function orderSharesForStake(stake) {
    return Math.max(0.01, Math.floor((stake / entryPrice) * 100) / 100);
  }

  async function cancelPendingOrders(reason) {
    const remaining = [];
    for (const record of engine.pendingOrders) {
      let cancelled = dryRunMode;
      if (!dryRunMode) {
        try {
          await trader.cancelOrder(record.orderId);
          cancelled = true;
        } catch (error) {
          remaining.push(record);
          log(`⚠️ ${record.side.toUpperCase()} CANCEL FAILED ${record.orderId} — ${error.message}`);
        }
      }
      if (cancelled) {
        adjustCapital(record.notional);
        log(`❎ ${record.side.toUpperCase()} LIMIT CANCELLED — ${reason}`);
      }
    }
    engine.pendingOrders = remaining;
    saveStats();
  }

  async function readOrderFill(record) {
    if (dryRunMode) {
      const price = getPrice(record.side);
      if (price == null || price > entryPrice + 0.0005) return null;
      return { shares: record.shares, price: entryPrice, raw: {} };
    }
    const order = await trader.getOrder(record.orderId);
    if (!order) return null;
    const originalSize = parseFloat(order.original_size ?? order.size ?? record.shares);
    const matchedSize = parseFloat(order.size_matched ?? order.filled_size ?? order.taker_amount ?? '0');
    if (!Number.isFinite(matchedSize) || matchedSize <= 0) return null;
    const fillPrice = parseFloat(order.avg_fill_price || order.price || entryPrice);
    return {
      shares: Math.min(record.shares, Number.isFinite(matchedSize) ? matchedSize : record.shares),
      price: Number.isFinite(fillPrice) && fillPrice > 0 ? fillPrice : entryPrice,
      raw: order,
      originalSize,
    };
  }

  async function openLimitPair() {
    if (!engine.leg?.discovered || engine.position || !entryAllowed()) return;
    if (engine.lastTradeWindowTs === engine.leg.windowTs) return;
    if (engine.pendingOrders.length) return;
    const targetStake = stakeForLevel(engine.martingaleLevel);
    const shares = orderSharesForStake(targetStake);
    const notional = round2(shares * entryPrice);
    const planned = ['up', 'down'].map(side => ({ side, token: getTokenId(side) }));
    const opened = [];
    try {
      for (const item of planned) {
        if (sharedCapital && sharedCapital.available() < notional) throw new Error(`insufficient shared capital for ${item.side.toUpperCase()} $${notional.toFixed(2)}`);
        const orderId = dryRunMode
          ? `demo-${engine.leg.windowTs}-${item.side}`
          : (await trader.placeGtcOrder(item.token, 'BUY', entryPrice, shares)).id;
        adjustCapital(-notional);
        const record = { orderId, token: item.token, side: item.side, windowTs: engine.leg.windowTs, price: entryPrice, shares, notional };
        opened.push(record);
        engine.pendingOrders.push(record);
      }
      log(`📥 LIMIT PAIR — UP/DOWN ${shares}sh @${entryPrice.toFixed(2)} | $${notional.toFixed(2)} reserved per side | MG${engine.martingaleLevel}`);
      saveStats();
    } catch (error) {
      await cancelPendingOrders('pair setup failed');
      markExecutionRetry();
      log(`❌ LIMIT PAIR REJECTED — ${error.message} | no fallback`);
    }
  }

  function makeLimitPosition(side, shares, fillPrice) {
    const safeShares = Math.max(0.01, round3(shares));
    const safePrice = Math.min(0.99, Math.max(0.01, fillPrice));
    const fee = computeFee(safeShares, safePrice);
    const cost = round2(safeShares * safePrice + fee);
    const level = engine.martingaleLevel;
    adjustCapital(-fee);
    if (sharedCapital) sharedCapital.addFee(fee);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    engine.position = {
      id: ++positionSequence,
      side,
      level,
      label: level === 0 ? 'BASE' : `MG${level}`,
      stake: stakeForLevel(level),
      shares: safeShares,
      entryPrice: safePrice,
      cost,
      openedAtMs: nowFn(),
    };
    engine.lastTradeWindowTs = engine.leg.windowTs;
    engine.windowTradeCount += 1;
    engine.windowMartingaleLevel = level;
    engine.windowSides.push(side.toUpperCase());
    executionRetryAt = 0;
    log(`🎯 ${side.toUpperCase()} ${engine.position.label} LIMIT FILLED — ${safeShares}sh @${safePrice.toFixed(2)} | cost $${cost.toFixed(2)} | hold to resolution`);
  }

  async function manageLimitPair() {
    if (!engine.leg?.discovered) return;
    if (engine.position) {
      if (engine.pendingOrders.length) await cancelPendingOrders('opposite side cleanup');
      return;
    }
    if (!engine.pendingOrders.length) {
      await openLimitPair();
      return;
    }
    let trigger = null;
    for (const record of engine.pendingOrders) {
      try {
        const fill = await readOrderFill(record);
        if (fill) { trigger = { record, fill }; break; }
      } catch (_) {}
    }
    if (!trigger) return;
    const matched = Math.min(trigger.record.shares, trigger.fill.shares);
    adjustCapital((trigger.record.shares - matched) * entryPrice);
    for (const record of engine.pendingOrders) {
      if (record === trigger.record && matched < record.shares && !dryRunMode) {
        try { await trader.cancelOrder(record.orderId); } catch (_) {}
        continue;
      }
      if (record !== trigger.record) {
        if (!dryRunMode) {
          try { await trader.cancelOrder(record.orderId); }
          catch (error) { log(`⚠️ ${record.side.toUpperCase()} OPPOSITE CANCEL FAILED — ${error.message}`); }
        }
        adjustCapital(record.notional);
        log(`❎ ${record.side.toUpperCase()} LIMIT CANCELLED — opposite side filled`);
      }
    }
    engine.pendingOrders = [];
    makeLimitPosition(trigger.record.side, matched, trigger.fill.price);
    saveStats();
  }

  async function enterPosition() {
    const now = nowFn();
    if (!engine.leg?.discovered || now < executionRetryAt) return;
    if (!entryAllowed()) return;
    if (engine.positions.length >= 2) return;
    const block = currentBlock();
    if (block == null) return;
    const blockKey = `${engine.leg.windowTs}:${block}`;
    if (engine.firedBlocks[blockKey]) return;
    const nextLevel = engine.martingaleLevel;
    if (nextLevel >= maxLevels()) return;

    const qualifyingSides = ['up', 'down'].filter(side => isWalkThrough(getPrice(side), side === 'up' ? engine.up.previousMid : engine.down.previousMid));
    if (!qualifyingSides.length) return;

    qualifyingSides.sort((left, right) => getPrice(right) - getPrice(left));
    const side = qualifyingSides[0];
    const targetStake = stakeForLevel(nextLevel);
    if (sharedCapital && sharedCapital.available() < targetStake) {
      markExecutionRetry();
      log(`⏳ insufficient shared capital for $${targetStake.toFixed(2)} — no fallback`);
      return;
    }
    let entryPrice = round3(getPrice(side));
    let shares;
    let fee;
    let cost;

    if (dryRunMode) {
      shares = Math.max(0.01, Math.floor((targetStake / entryPrice) * 100) / 100);
      fee = computeFee(shares, entryPrice);
      cost = round2(shares * entryPrice + fee);
    } else {
      const order = await trader.placeFokBuy(getTokenId(side), targetStake);
      if (!order.isFilled) {
        markExecutionRetry();
        log(`❌ ${side.toUpperCase()} FOK MARKET BUY REJECTED $${targetStake.toFixed(2)} — no fallback`);
        return;
      }
      const fillPrice = parseFloat(order.avgPrice);
      if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
        markExecutionRetry();
        log(`❌ ${side.toUpperCase()} fill price unavailable — no fallback`);
        return;
      }
      entryPrice = Math.min(0.99, Math.max(0.01, fillPrice));
      const rawShares = parseFloat(order.raw?.takingAmount || order.raw?.size_matched || 'NaN');
      shares = Number.isFinite(rawShares) && rawShares > 0
        ? round3(rawShares)
        : Math.max(0.01, Math.floor((targetStake / entryPrice) * 1000) / 1000);
      fee = computeFee(shares, entryPrice);
      cost = round2(targetStake + fee);
    }

    adjustCapital(-cost);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    if (sharedCapital) sharedCapital.addFee(fee);
    const position = {
      id: ++positionSequence,
      side,
      level: nextLevel,
      label: nextLevel === 0 ? 'BASE' : `MG${nextLevel}`,
      stake: targetStake,
      shares,
      entryPrice,
      cost,
      openedAtMs: now,
      block,
    };
    engine.positions.push(position);
    engine.up.previousMid = getPrice('up');
    engine.down.previousMid = getPrice('down');
    engine.windowTradeCount += 1;
    engine.firedBlocks[blockKey] = true;
    engine.windowMartingaleLevel = nextLevel;
    engine.windowSides.push(side.toUpperCase());
    executionRetryAt = 0;
    saveStats();
    log(`🎯 ${side.toUpperCase()} BLOCK${block + 1} BUY — $${targetStake.toFixed(2)} → ${shares}sh @${entryPrice.toFixed(2)} | cost $${cost.toFixed(2)} | stop ${stopLossPrice.toFixed(2)}`);
  }

  function closePosition(position, exitPrice, closeType) {
    const proceeds = round2(position.shares * exitPrice);
    const fee = computeFee(position.shares, exitPrice);
    const netProceeds = round2(proceeds - fee);
    const pnl = round2(netProceeds - position.cost);
    adjustCapital(netProceeds);
    if (sharedCapital) sharedCapital.recordResult(pnl);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    engine.windowPnl = round2(engine.windowPnl + pnl);
    if (pnl > 0) engine.wins += 1; else engine.losses += 1;
    engine.positions = engine.positions.filter(p => p.id !== position.id);
    log(`${closeType === 'STOP' ? '🛑' : '🏁'} ${position.side.toUpperCase()} ${position.label} ${closeType} — ${position.shares}sh @${exitPrice.toFixed(2)} | PnL ${money(pnl)}`);
    registerResult(position, pnl);
    return pnl;
  }

  async function checkStopLoss() {
    if (!engine.leg?.discovered || !engine.positions.length) return;
    for (const position of [...engine.positions]) {
    const price = getPrice(position.side);
    if (price == null || price > stopLossPrice) continue;
    if (nowFn() < executionRetryAt) return;

    let exitPrice = round2(Math.floor(price * 100) / 100);
    if (!dryRunMode) {
      const order = await trader.placeFokSell(getTokenId(position.side), position.shares);
      if (!order.isFilled) {
        markExecutionRetry();
        log(`❌ ${position.side.toUpperCase()} STOP SELL REJECTED — retrying while stop remains active`);
        continue;
      }
      const fillPrice = parseFloat(order.avgPrice);
      if (Number.isFinite(fillPrice) && fillPrice > 0) exitPrice = Math.min(0.99, Math.max(0.01, fillPrice));
    }
    closePosition(position, exitPrice, 'STOP');
    }
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
    for (const position of [...engine.positions]) {
      const payout = winner === position.side ? position.shares : 0;
      const pnl = round2(payout - position.cost);
      adjustCapital(payout);
      if (sharedCapital) sharedCapital.recordResult(pnl);
      engine.realizedPnl = round2(engine.realizedPnl + pnl);
      engine.windowPnl = round2(engine.windowPnl + pnl);
      if (pnl > 0) engine.wins += 1; else engine.losses += 1;
      log(`🏁 ${position.side.toUpperCase()} BLOCK${(position.block ?? 0) + 1} RESOLVED — PnL ${money(pnl)}`);
    }
    engine.positions = [];

    engine.history.unshift({
      windowTs: engine.leg.windowTs,
      slug: engine.leg.slug,
      winner: winner || 'unresolved',
      sides: engine.windowSides.join('/') || 'NONE',
      trades: engine.windowTradeCount,
      martingales: engine.windowMartingaleLevel || 0,
      pnl: engine.windowPnl,
      bankrollAfter: sharedCapital ? sharedCapital.available() : engine.bankroll,
    });
    if (engine.history.length > 300) engine.history.length = 300;
    saveStats();
  }

  function resetWindowState() {
    engine.positions = [];
    engine.firedBlocks = {};
    engine.windowTradeCount = 0;
    engine.windowMartingaleLevel = 0;
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
            if (strategy === 'limit-pair') {
              await manageLimitPair();
              await cancelPendingOrders('window ended');
            }
            if (!oldLeg.resolved) await attemptFastResolution(oldLeg);
            if (!oldLeg.resolved) await resolveLegOfficially(oldLeg);
            settleWindow(oldLeg.winner);
          }
          engine.leg = freshLeg(windowTs);
          engine.up = freshSideState();
          engine.down = freshSideState();
          resetWindowState();
          if (strategy === 'limit-pair' && engine.pendingOrders.length) {
            const currentTokens = new Set([String(engine.leg.upTokenId), String(engine.leg.downTokenId)]);
            const stale = engine.pendingOrders.filter(order => order.windowTs !== engine.leg.windowTs || !currentTokens.has(String(order.token)));
            if (stale.length) {
              engine.pendingOrders = stale;
              await cancelPendingOrders('stale window');
            }
          }
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
          if (strategy === 'limit-pair') await manageLimitPair();
          else {
            await checkStopLoss();
            await enterPosition();
          }
        }
        if (now - engine.lastEquityRecord >= EQUITY_RECORD_MS) {
          engine.lastEquityRecord = now;
            let unrealized = 0;
            for (const pos of engine.positions) {
              const mp = getPrice(pos.side) || 0;
              unrealized += pos.shares * mp - pos.cost;
            }
          const cash = sharedCapital ? sharedCapital.available() : engine.bankroll;
          engine.equityCurve.push({ t: now, equity: round2(cash + unrealized) });
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
    let unrealizedPnl = 0;
    const positions = engine.positions.map(pos => {
      const markPrice = getPrice(pos.side) || 0;
      const upnl = round2(pos.shares * markPrice - pos.cost);
      unrealizedPnl += upnl;
      return { ...pos, markPrice, unrealizedPnl: upnl, stopLossPrice };
    });
    const decided = engine.wins + engine.losses;
    return {
      label,
      strategy,
      dryRun: dryRunMode,
      windowSeconds: winSec,
      baseStakeUsd,
      martingaleMultiplier,
      maxMartingales,
      entryPrice,
      entryStartSecond,
      entryEndSecond,
      allowedWindows: allowedWindows || null,
      elapsedSecond: elapsedSecond(),
      tradingAllowed: entryAllowed(),
      stopLossPrice,
      martingaleLevel: engine.martingaleLevel,
      pendingOrders: engine.pendingOrders,
      nextStakeIfStopped: baseStakeUsd,
      canEnter: entryAllowed() && engine.positions.length < 2,
      bankroll: sharedCapital ? sharedCapital.available() : engine.bankroll,
      startingCapital: sharedCapital ? sharedCapital.startingCapital : capital,
      realizedPnl: engine.realizedPnl,
      unrealizedPnl,
      equity: round2((sharedCapital ? sharedCapital.available() : engine.bankroll) + unrealizedPnl),
      equityCurve: engine.equityCurve.slice(-600),
      wins: engine.wins,
      losses: engine.losses,
      winRate: decided ? round2(engine.wins / decided * 100) : null,
      totalFeesPaid: engine.totalFeesPaid,
      positions,
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
    log(`⛏ ${label} — Momentum engine started`);
    log(strategy === 'limit-pair'
      ? `⚙️ ${entryPrice.toFixed(2)} paired limits | no stop | base ${baseStakeUsd.toFixed(2)}`
      : `⚙️ ${entryPrice.toFixed(2)} walk-through entry | stop ${stopLossPrice.toFixed(2)} | base ${baseStakeUsd.toFixed(2)}`);
    const windowDesc = allowedWindows
      ? allowedWindows.map(w => `${w.start}-${w.end}s`).join(' & ')
      : `${entryStartSecond}-${entryEndSecond}s`;
    log(`⚙️ flat stake | entries ${windowDesc} | stops always active | ${dryRunMode ? 'DEMO' : 'LIVE'}`);
    mainLoop().catch(error => log(`❌ fatal: ${error.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine };
