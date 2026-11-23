'use strict';

const DipBounceBot = require('./dip-bounce-bot');
const config = require('./config');

const BASE_STRATEGY_ID = DipBounceBot._test.STRATEGY.id;
const BASE_SHARES = config.CROSS_PAIR_BASE_SHARES;
const ASK_SUM_THRESHOLD = config.CROSS_PAIR_ENTRY_ASK_SUM_MAX;
const SWEEP_CAP = config.CROSS_PAIR_TAKER_SWEEP_CAP;
const QUOTE_MAX_AGE_MS = config.DIP_BOUNCE_MAX_QUOTE_AGE_MS;
const TAKE_PROFIT_BID = config.DIP_BOUNCE_TAKE_PROFIT_BID;
const TAKE_PROFIT_PAYOUT = config.DIP_BOUNCE_TAKE_PROFIT_PAYOUT;
const STOP_LOSS_BID = 0;
const CLOSED_POSITION_STATUSES = new Set([
  'TAKE_PROFIT',
  'STOP_LOSS',
  'RESOLVED_WIN',
  'RESOLVED_LOSS',
]);
const PAIRS = Object.freeze([
  Object.freeze({
    id: 'btc-up-eth-down',
    label: 'BTC UP + ETH DOWN',
    legs: Object.freeze([
      Object.freeze({ asset: 'BTC', side: 'UP' }),
      Object.freeze({ asset: 'ETH', side: 'DOWN' }),
    ]),
  }),
  Object.freeze({
    id: 'eth-up-btc-down',
    label: 'ETH UP + BTC DOWN',
    legs: Object.freeze([
      Object.freeze({ asset: 'ETH', side: 'UP' }),
      Object.freeze({ asset: 'BTC', side: 'DOWN' }),
    ]),
  }),
  Object.freeze({
    id: 'btc-up-eth-up',
    label: 'BTC UP + ETH UP',
    legs: Object.freeze([
      Object.freeze({ asset: 'BTC', side: 'UP' }),
      Object.freeze({ asset: 'ETH', side: 'UP' }),
    ]),
  }),
  Object.freeze({
    id: 'btc-down-eth-down',
    label: 'BTC DOWN + ETH DOWN',
    legs: Object.freeze([
      Object.freeze({ asset: 'BTC', side: 'DOWN' }),
      Object.freeze({ asset: 'ETH', side: 'DOWN' }),
    ]),
  }),
]);

const STRATEGY = Object.freeze({
  id: 'btc-eth-four-pair-fixed-100-paper',
  name: 'BTC/ETH four-pair fixed-size paper strategy',
  version: 'four-pairs-080-fixed-100-tp099-sl000-v3',
  assets: ['BTC', 'ETH'],
  timeframes: ['5m'],
  sharesPerLeg: BASE_SHARES,
  entryAskSumBelow: ASK_SUM_THRESHOLD,
  orderType: 'TAKER',
  sweepCap: SWEEP_CAP,
  exit: 'Close a leg at a $0.99 best bid for a $1.00/share payout, or at $0.00 when its fresh book has no bid. Any leg still open at window end waits for official resolution.',
  sizing: 'Always 100 shares per leg on every entry in all four cross-pairs. No size progression after wins or losses.',
  execution: 'PAPER ONLY',
});

function round(value) {
  return Number(Number(value).toFixed(6));
}

function emptySizing() {
  return {
    nextShares: BASE_SHARES,
    lastOutcome: null,
    lastUpdatedAt: null,
    entries: 0,
  };
}

function emptyWindowState(pair, windowStart) {
  return {
    pairId: pair.id,
    pairLabel: pair.label,
    windowStart,
    entered: false,
    status: 'ARMED',
    lastAskSum: null,
    lastReason: 'Waiting for fresh asks on both legs.',
    cycleId: null,
  };
}

function sortLevels(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

function sweepAsks(levels, requestedShares, market) {
  let remaining = requestedShares;
  let notional = 0;
  let fees = 0;
  const fills = [];
  const configuredRate = Number(
    market?.feeSchedule?.rate ?? market?.takerFeeRate ??
    (market?.asset === 'BTC' ? 0.05 : 0.01),
  );
  const feeRate = market?.feesEnabled === false ? 0 : configuredRate;
  if (!Number.isFinite(feeRate) || feeRate < 0) {
    return { filledShares: 0, remainingShares: requestedShares, notional: 0, fees: 0, averagePrice: null, fills: [] };
  }

  for (const level of sortLevels(levels)) {
    if (remaining <= 1e-9 || level.price > SWEEP_CAP) break;
    const shares = Math.min(remaining, level.size);
    const fee = shares * feeRate * level.price * (1 - level.price);
    const value = shares * level.price;
    fills.push({ shares: round(shares), price: round(level.price), value: round(value), fee: round(fee) });
    notional += value;
    fees += fee;
    remaining -= shares;
  }
  const filledShares = requestedShares - remaining;
  return {
    filledShares: round(filledShares),
    remainingShares: round(remaining),
    notional: round(notional),
    fees: round(fees),
    averagePrice: filledShares > 0 ? round(notional / filledShares) : null,
    fills,
  };
}

class CrossPairBot extends DipBounceBot {
  constructor(options = {}) {
    super(options);
    this.strategyId = STRATEGY.id;
    this.strategyName = STRATEGY.name;
    this.sizingByAsset = {};
    this.crossPairSizing = Object.fromEntries(PAIRS.map(pair => [pair.id, emptySizing()]));
    this.pairWindowStates = {};
    this.crossPairCycles = [];
    this.lastCrossPairScanAt = null;
  }

  log(message, {
    asset = null,
    timeframe = null,
    side = null,
    outcome = 'neutral',
    type = 'INFO',
    now = this.now(),
  } = {}) {
    const event = { time: now, asset, timeframe, side, type, outcome, message };
    this.events.unshift(event);
    if (this.events.length > 200) this.events.length = 200;
    console.log(`[cross-pair] ${JSON.stringify(event)}`);
    this.scheduleLedgerSave();
    return event;
  }

  pairWindowState(pair, windowStart) {
    const current = this.pairWindowStates[pair.id];
    if (!current || Number(current.windowStart) !== Number(windowStart)) {
      this.pairWindowStates[pair.id] = emptyWindowState(pair, windowStart);
    }
    return this.pairWindowStates[pair.id];
  }

  pairQuotes(pair, now) {
    const legs = pair.legs.map(leg => {
      const record = this.records.get(`${leg.asset}:5m`);
      return {
        ...leg,
        record,
        market: record?.market || null,
        quote: record?.quotes?.[leg.side] || null,
      };
    });
    const marketsAligned = legs.every(leg => leg.market &&
      leg.record.marketStatus === 'OPEN' &&
      Number(leg.market.start) === Number(legs[0].market?.start) &&
      Number(leg.market.end) === Number(legs[0].market?.end));
    const asksFresh = marketsAligned && legs.every(leg => {
      const quote = leg.quote;
      return quote?.status === 'LIVE' &&
        Number.isFinite(Number(quote.bestAsk)) &&
        Number(quote.bestAsk) > 0 && Number(quote.bestAsk) < 1 &&
        Number.isFinite(Number(quote.updatedAt)) &&
        now - Number(quote.updatedAt) <= QUOTE_MAX_AGE_MS;
    });
    return {
      legs,
      marketsAligned,
      asksFresh,
      windowStart: marketsAligned ? Number(legs[0].market.start) : null,
      windowEnd: marketsAligned ? Number(legs[0].market.end) : null,
      askSum: asksFresh ? round(legs.reduce((sum, leg) => sum + Number(leg.quote.bestAsk), 0)) : null,
    };
  }

  hasUnresolvedCycle(pairId) {
    return this.crossPairCycles.some(cycle => cycle.pairId === pairId &&
      cycle.legPositionIds.some(id => {
        const position = this.positions.find(item => item.id === id);
        return position && ['OPEN', 'PENDING_RESOLUTION'].includes(position.status);
      }));
  }

  processSide(_record, _side, _quote) {
    this.evaluateCrossPairs(this.now());
  }

  checkTakeProfits(record, side, quote, now) {
    if (!record?.market || record.marketStatus !== 'OPEN') return;
    if (!Number.isFinite(Number(quote?.bestBid)) ||
        Number(quote.bestBid) < TAKE_PROFIT_BID) return;
    const marketId = String(record.market.id || record.market.slug);
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.side !== side ||
          position.status !== 'OPEN') continue;
      this.closePosition(position, {
        status: 'TAKE_PROFIT',
        exitPrice: TAKE_PROFIT_BID,
        exitPayout: TAKE_PROFIT_PAYOUT,
        exitReason: 'TAKE_PROFIT_099',
        now,
        quote,
        message: `Take-profit hit at $${TAKE_PROFIT_BID.toFixed(2)} bid; credited $${TAKE_PROFIT_PAYOUT.toFixed(2)} per share.`,
      });
    }
  }

  checkStopLosses(record, side, quote, now) {
    if (!record?.market || record.marketStatus !== 'OPEN') return;
    const fresh = Number.isFinite(Number(quote?.updatedAt)) &&
      now - Number(quote.updatedAt) <= QUOTE_MAX_AGE_MS;
    if (!fresh || (quote.bestBid != null &&
        (!Number.isFinite(Number(quote.bestBid)) || Number(quote.bestBid) > STOP_LOSS_BID))) return;
    const marketId = String(record.market.id || record.market.slug);
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.side !== side ||
          position.status !== 'OPEN') continue;
      this.closePosition(position, {
        status: 'STOP_LOSS',
        exitPrice: STOP_LOSS_BID,
        exitPayout: 0,
        exitReason: 'STOP_LOSS_000',
        now,
        quote,
        message: 'Stop-loss hit: fresh book has no bid, so the position closed at $0.00 payout.',
      });
    }
  }

  closePosition(position, { status, exitPrice, exitPayout, exitReason, now, quote, message }) {
    if (!position || position.status !== 'OPEN') return false;
    const payout = Number(position.shares || 0) * Number(exitPayout || 0);
    this.cash = round(this.cash + payout);
    position.status = status;
    position.exitAt = now;
    position.exitPrice = exitPrice;
    position.exitPayout = exitPayout;
    position.exitReason = exitReason;
    position.realizedPnl = round(
      payout - Number(position.totalCost || 0) - Number(position.fees || 0)
        + Number(position.estimatedMakerRebate || 0),
    );
    position.markBid = exitPrice;
    position.markUpdatedAt = quote?.updatedAt ?? now;
    position.markStatus = 'CLOSED';
    position.unrealizedPnl = null;
    this.updateCycleAfterPositionClose(position, now);
    this.log(`${position.asset} ${position.side}: ${message}`, {
      asset: position.asset,
      timeframe: position.timeframe,
      side: position.side,
      outcome: position.realizedPnl >= 0 ? 'good' : 'bad',
      type: status,
      now,
    });
    this.updateAccountMetrics(now, true);
    this.scheduleLedgerSave();
    return true;
  }

  updateCycleAfterPositionClose(position, now) {
    const cycle = this.crossPairCycles.find(item => item.id === position.pairCycleId);
    if (!cycle) return;
    const positions = cycle.legPositionIds
      .map(id => this.positions.find(item => item.id === id))
      .filter(Boolean);
    if (positions.some(item => !CLOSED_POSITION_STATUSES.has(item.status))) {
      cycle.status = positions.some(item => item.status === 'PENDING_RESOLUTION')
        ? 'PENDING_RESOLUTION' : 'OPEN';
      return;
    }
    cycle.status = 'CLOSED';
    cycle.closedAt = now;
    cycle.realizedPnl = round(positions.reduce(
      (sum, item) => sum + Number(item.realizedPnl || 0), 0,
    ));
    this.applyPairSizing(cycle, positions, now);
  }

  updateSizingAfterClose() {
    // Pair outcome is recorded only after both legs close; size always remains 100.
  }

  evaluateCrossPairs(now = this.now()) {
    let changed = false;
    for (const pair of PAIRS) {
      const marketPair = this.pairQuotes(pair, now);
      if (!marketPair.marketsAligned || marketPair.windowStart == null) continue;
      if (now < marketPair.windowStart || now >= marketPair.windowEnd) continue;

      const pairState = this.pairWindowState(pair, marketPair.windowStart);
      pairState.lastAskSum = marketPair.askSum;
      if (pairState.entered) continue;
      if (!marketPair.asksFresh) {
        pairState.status = 'WAITING_FOR_QUOTES';
        pairState.lastReason = 'Waiting for fresh best asks on both legs.';
        continue;
      }
      if (marketPair.askSum >= ASK_SUM_THRESHOLD) {
        pairState.status = 'ARMED';
        pairState.lastReason =
          `Combined asks are $${marketPair.askSum.toFixed(3)}; waiting for below $${ASK_SUM_THRESHOLD.toFixed(2)}.`;
        continue;
      }
      if (this.hasUnresolvedCycle(pair.id)) {
        pairState.status = 'WAITING_FOR_RESOLUTION';
        pairState.lastReason =
          'The prior entry in this cross-pair is not fully resolved; keeping its size unchanged until both outcomes are known.';
        continue;
      }

      const sizing = this.crossPairSizing[pair.id];
      const sharesPerLeg = BASE_SHARES;
      pairState.status = 'ENTRY_READY';
      pairState.lastReason =
        `Combined asks $${marketPair.askSum.toFixed(3)} are below $${ASK_SUM_THRESHOLD.toFixed(2)}.`;
      const didEnter = this.buyCrossPair(pair, pairState, marketPair, sharesPerLeg, now);
      if (didEnter) changed = true;
    }
    this.lastCrossPairScanAt = now;
    return changed;
  }

  buyCrossPair(pair, pairState, marketPair, sharesPerLeg, now) {
    const fills = marketPair.legs.map(leg => ({
      ...leg,
      fill: sweepAsks(leg.quote.asks, sharesPerLeg, leg.market),
    }));
    const totalDebit = fills.reduce(
      (sum, leg) => sum + leg.fill.notional + leg.fill.fees, 0,
    );
    if (totalDebit > this.availableCash() + 1e-8) {
      pairState.status = 'WAITING_FOR_CASH';
      pairState.lastReason =
        `The two-leg taker sweep needs $${round(totalDebit).toFixed(2)}, more than available paper cash.`;
      return false;
    }

    const cycleNumber = this.crossPairCycles.filter(item =>
      item.pairId === pair.id && Number(item.windowStart) === Number(pairState.windowStart)).length + 1;
    const cycleId = `${pair.id}-${pairState.windowStart}-${cycleNumber}`;
    const cycle = {
      id: cycleId,
      pairId: pair.id,
      pairLabel: pair.label,
      windowStart: pairState.windowStart,
      windowEnd: marketPair.windowEnd,
      status: 'OPEN',
      entryAt: now,
      entryAskSum: marketPair.askSum,
      sharesPerLeg,
      legPositionIds: [],
      legs: [],
      sizingApplied: false,
    };

    for (const leg of fills) {
      const orderId = `cross-${++this.orderSequence}`;
      const positionId = leg.fill.filledShares > 1e-9
        ? `position-${++this.positionSequence}` : null;
      const order = {
        id: orderId,
        pairId: pair.id,
        pairCycleId: cycleId,
        pairLabel: pair.label,
        marketId: String(leg.market.id || leg.market.slug),
        marketSlug: leg.market.slug,
        marketTitle: leg.market.title,
        asset: leg.asset,
        timeframe: '5m',
        windowStart: pairState.windowStart,
        windowEnd: marketPair.windowEnd,
        side: leg.side,
        action: 'BUY_TAKER',
        kind: 'CROSS_PAIR_ENTRY',
        orderType: 'MARKET',
        status: leg.fill.filledShares <= 1e-9
          ? 'REJECTED_NO_VISIBLE_ASK_DEPTH'
          : leg.fill.remainingShares > 1e-9
            ? 'PARTIALLY_FILLED_REMAINDER_CANCELLED' : 'FILLED',
        requestedShares: sharesPerLeg,
        filledShares: leg.fill.filledShares,
        remainingShares: 0,
        cancelledRemainderShares: leg.fill.remainingShares,
        cost: leg.fill.notional,
        fee: leg.fill.fees,
        averagePrice: leg.fill.averagePrice,
        limitPrice: SWEEP_CAP,
        fills: leg.fill.fills,
        fillRule: `Immediate visible-ask sweep up to $${SWEEP_CAP.toFixed(2)}; any remainder is cancelled.`,
        positionId,
        positionIds: positionId ? [positionId] : [],
        createdAt: now,
        submittedAt: now,
        filledAt: leg.fill.filledShares > 0 ? now : null,
      };
      this.orders.unshift(order);
      this.totalOrderAttempts += 1;
      cycle.legs.push({
        asset: leg.asset,
        side: leg.side,
        orderId,
        positionId,
        requestedShares: sharesPerLeg,
        filledShares: leg.fill.filledShares,
        averageEntry: leg.fill.averagePrice,
      });
      if (!positionId) continue;

      const position = {
        id: positionId,
        marketId: order.marketId,
        marketSlug: order.marketSlug,
        marketTitle: order.marketTitle,
        asset: leg.asset,
        timeframe: '5m',
        side: leg.side,
        status: 'OPEN',
        shares: leg.fill.filledShares,
        initialShares: leg.fill.filledShares,
        requestedShares: sharesPerLeg,
        entryPrice: leg.fill.averagePrice,
        totalCost: leg.fill.notional,
        fees: leg.fill.fees,
        estimatedMakerRebate: 0,
        entryAt: now,
        windowStart: pairState.windowStart,
        windowEnd: marketPair.windowEnd,
        markBid: leg.quote.bestBid ?? null,
        markUpdatedAt: leg.quote.updatedAt || now,
        markStatus: leg.quote.bestBid == null ? 'MISSING' : 'LIVE',
        unrealizedPnl: leg.quote.bestBid == null
          ? null
          : Number(leg.quote.bestBid) * leg.fill.filledShares
            - leg.fill.notional - leg.fill.fees,
        realizedPnl: null,
        exitPrice: null,
        exitPayout: null,
        exitReason: null,
        sizingApplied: false,
        nextEntryShares: null,
        pairId: pair.id,
        pairLabel: pair.label,
        pairCycleId: cycleId,
        pairCycleSharesPerLeg: sharesPerLeg,
        fillModel: 'VISIBLE_ASK_TAKER_SWEEP',
      };
      order.position = position;
      this.positions.unshift(position);
      cycle.legPositionIds.push(positionId);
    }

    pairState.entered = true;
    pairState.cycleId = cycleId;
    pairState.status = cycle.legPositionIds.length ? 'IN_POSITION' : 'NO_FILL';
    pairState.lastReason = cycle.legPositionIds.length
      ? `Bought ${cycle.legs.map(leg => `${leg.asset} ${leg.side}: ${leg.filledShares}/${sharesPerLeg}`).join(' · ')}; TP $${TAKE_PROFIT_BID.toFixed(2)}, empty-bid SL $0.00, then resolution if still open.`
      : 'The combined-ask trigger fired, but neither visible ask book could fill shares.';

    if (cycle.legPositionIds.length) {
      this.crossPairCycles.unshift(cycle);
      if (this.crossPairCycles.length > 1000) this.crossPairCycles.length = 1000;
    }
    this.cash = round(this.cash - totalDebit);
    const sizing = this.crossPairSizing[pair.id];
    sizing.entries += 1;
    this.entryOrderPlaced = cycle.legPositionIds.length > 0;
    this.entryOrderId = this.orders[0]?.id || null;
    this.entryTriggerAt = now;
    this.entryTriggerSide = pair.id;
    this.entryTriggerReason = `${pair.label} combined asks ${marketPair.askSum.toFixed(3)}.`;
    this.log(cycle.legPositionIds.length
      ? `${pair.label} entered at combined asks $${marketPair.askSum.toFixed(3)}; TP $${TAKE_PROFIT_BID.toFixed(2)}, empty-bid SL $0.00, resolution fallback.`
      : `${pair.label} qualified at $${marketPair.askSum.toFixed(3)}, but no ask depth filled.`, {
      timeframe: '5m',
      outcome: cycle.legPositionIds.length ? 'good' : 'neutral',
      type: cycle.legPositionIds.length ? 'CROSS_PAIR_ENTRY' : 'CROSS_PAIR_NO_FILL',
      now,
    });
    this.updateAccountMetrics(now, true);
    this.scheduleLedgerSave();
    return cycle.legPositionIds.length > 0;
  }

  settleMarket(marketId, winner, now) {
    super.settleMarket(marketId, winner, now);
    this.applyResolvedPairSizing(now);
  }

  expireMarket(record, now) {
    super.expireMarket(record, now);
    if (!record?.market) return;
    const marketId = String(record.market.id || record.market.slug);
    for (const cycle of this.crossPairCycles) {
      const hasMarketLeg = cycle.legPositionIds.some(id =>
        this.positions.some(position => position.id === id && position.marketId === marketId));
      if (!hasMarketLeg || cycle.sizingApplied) continue;
      const legs = cycle.legPositionIds
        .map(id => this.positions.find(position => position.id === id))
        .filter(Boolean);
      if (legs.some(position => position.status === 'PENDING_RESOLUTION') &&
          cycle.status !== 'PENDING_RESOLUTION') {
        cycle.status = 'PENDING_RESOLUTION';
        cycle.pendingResolutionAt = now;
      }
    }
    this.scheduleLedgerSave();
  }

  applyResolvedPairSizing(now) {
    for (const cycle of this.crossPairCycles) {
      if (cycle.sizingApplied || !cycle.legPositionIds.length) continue;
      const positions = cycle.legPositionIds
        .map(id => this.positions.find(position => position.id === id))
        .filter(Boolean);
      if (positions.length !== cycle.legPositionIds.length ||
          positions.some(position => !CLOSED_POSITION_STATUSES.has(position.status))) continue;
      this.applyPairSizing(cycle, positions, now);
    }
    this.scheduleLedgerSave();
  }

  applyPairSizing(cycle, positions, now) {
    if (cycle.sizingApplied || positions.some(position => !CLOSED_POSITION_STATUSES.has(position.status))) return;
    const bothLost = positions.length === 2 &&
      positions.every(position => ['STOP_LOSS', 'RESOLVED_LOSS'].includes(position.status));
    const hasWin = positions.some(position => ['TAKE_PROFIT', 'RESOLVED_WIN'].includes(position.status));
    const sizing = this.crossPairSizing[cycle.pairId] || emptySizing();
    sizing.nextShares = BASE_SHARES;
    cycle.sizingOutcome = bothLost ? 'BOTH_LEGS_LOST'
      : hasWin ? 'AT_LEAST_ONE_WIN' : 'INCOMPLETE_PAIR';
    sizing.lastOutcome = cycle.sizingOutcome;
    sizing.lastUpdatedAt = now;
    this.crossPairSizing[cycle.pairId] = sizing;
    cycle.sizingApplied = true;
    cycle.closedAt = now;
    if (positions.some(position => position.status === 'PENDING_RESOLUTION')) {
      cycle.status = 'PENDING_RESOLUTION';
    } else {
      cycle.status = 'CLOSED';
      cycle.settledAt = positions.some(position =>
        ['RESOLVED_WIN', 'RESOLVED_LOSS'].includes(position.status)) ? now : cycle.settledAt;
    }
    cycle.realizedPnl = round(positions.reduce(
      (sum, position) => sum + Number(position.realizedPnl || 0), 0,
    ));
    for (const position of positions) {
      position.sizingApplied = true;
      position.sizingOutcome = cycle.sizingOutcome;
      position.nextEntryShares = sizing.nextShares;
      position.pairRealizedPnl = cycle.realizedPnl;
    }
    const description = cycle.sizingOutcome === 'BOTH_LEGS_LOST'
      ? `both legs lost; next qualifying entry remains ${BASE_SHARES} shares per leg`
      : cycle.sizingOutcome === 'AT_LEAST_ONE_WIN'
        ? `at least one leg won; next qualifying entry remains ${BASE_SHARES} shares per leg`
        : `pair cycle closed; next qualifying entry remains ${BASE_SHARES} shares per leg`;
    this.log(`${cycle.pairLabel} closed; ${description}.`, {
      timeframe: '5m',
      outcome: cycle.sizingOutcome === 'BOTH_LEGS_LOST' ? 'bad' : 'good',
      type: 'CROSS_PAIR_SIZING',
      now,
    });
  }

  restoreLedger(ledger) {
    const originalSnapshot = ledger?.snapshot || ledger;
    if (!originalSnapshot || originalSnapshot.strategy?.id !== STRATEGY.id) {
      throw new Error('Saved paper ledger is invalid or belongs to another strategy.');
    }
    const savedSizing = originalSnapshot.crossPairSizing || {};
    const savedStates = originalSnapshot.pairWindowStates || {};
    const savedCycles = originalSnapshot.crossPairCycles || [];
    this.crossPairSizing = Object.fromEntries(PAIRS.map(pair => {
      const saved = savedSizing[pair.id] || {};
      return [pair.id, {
        ...emptySizing(),
        ...saved,
        nextShares: BASE_SHARES,
      }];
    }));
    this.pairWindowStates = Object.fromEntries(PAIRS.map(pair => [
      pair.id,
      savedStates[pair.id] ? { ...savedStates[pair.id] } : null,
    ]).filter(([, value]) => value));
    this.crossPairCycles = Array.isArray(savedCycles)
      ? savedCycles.map(cycle => ({ ...cycle, legs: Array.isArray(cycle.legs) ? cycle.legs.map(leg => ({ ...leg })) : [] }))
      : [];
    const compatibilityLedger = ledger?.snapshot
      ? {
        ...ledger,
        strategyId: BASE_STRATEGY_ID,
        snapshot: { ...originalSnapshot, strategy: { ...originalSnapshot.strategy, id: BASE_STRATEGY_ID } },
      }
      : { ...originalSnapshot, strategy: { ...originalSnapshot.strategy, id: BASE_STRATEGY_ID } };
    super.restoreLedger(compatibilityLedger);
    this.strategyId = STRATEGY.id;
    this.strategyName = STRATEGY.name;
  }

  exportLedger() {
    const snapshot = this.snapshot();
    snapshot.positions = this.positions.map(position => ({ ...position }));
    snapshot.orders = this.orders.map(order => ({ ...order }));
    snapshot.events = this.events.map(event => ({ ...event }));
    snapshot.crossPairCycles = this.crossPairCycles.map(cycle => ({
      ...cycle,
      legs: cycle.legs.map(leg => ({ ...leg })),
    }));
    return {
      schemaVersion: 1,
      strategyId: STRATEGY.id,
      savedAt: this.now(),
      snapshot,
    };
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const marketMap = new Map(state.markets.map(market => [market.asset, market]));
    state.markets = state.markets.map(market => ({
      ...market,
      sideStates: Object.fromEntries(['UP', 'DOWN'].map(side => {
        const original = market.sideStates?.[side] || {};
        const other = market.asset === 'BTC' ? 'ETH' : 'BTC';
        const paired = PAIRS.filter(item => item.legs.some(leg =>
          leg.asset === market.asset && leg.side === side));
        const pairStates = paired.map(pair => ({
          pair,
          state: this.pairWindowStates[pair.id]?.windowStart === market.start
            ? this.pairWindowStates[pair.id] : null,
        }));
        const enteredPairs = pairStates.filter(item => item.state?.entered);
        return [side, {
          bestBid: original.bestBid,
          bestAsk: original.bestAsk,
          mid: original.mid,
          updatedAt: original.updatedAt,
          ageMs: original.ageMs,
          fresh: original.fresh,
          orderStatus: enteredPairs.length
            ? enteredPairs.map(item => item.state.status).join(' · ')
            : 'MONITORING',
          requestedShares: enteredPairs.length ? BASE_SHARES * enteredPairs.length : null,
          filledShares: this.positions
            .filter(position => paired.some(pair => pair.id === position.pairId) &&
              position.windowStart === market.start && position.asset === market.asset &&
              position.side === side)
            .reduce((sum, position) => sum + Number(position.shares || 0), 0),
          pairLabel: paired.map(pair => pair.label).join(' / ') || `${market.asset} ${side} · ${other}`,
          reason: pairStates.map(item => item.state?.lastReason).filter(Boolean).join(' · ')
            || 'Monitored as a leg of each applicable BTC/ETH cross-pair.',
        }];
      })),
    }));
    state.strategy = {
      ...STRATEGY,
      entry: 'Monitor all four BTC/ETH UP/DOWN combinations independently. Enter a pair when its fresh best asks sum to strictly less than $0.80; one entry per pair per 5-minute window.',
      fill: 'Paper taker sweep of visible asks up to $0.99. Actual filled quantity, average entry, and market taker fees are recorded; unfilled remainder is cancelled.',
      sizing: STRATEGY.sizing,
      settlement: 'Each leg closes independently at the $0.99 take-profit or on a fresh empty bid at $0.00. Any still-open leg is sent to official resolution at window end; sizing updates after both pair legs close.',
      execution: 'PAPER ONLY',
    };
    state.sizingByAsset = undefined;
    state.crossPairSizing = Object.fromEntries(PAIRS.map(pair => [
      pair.id,
      { ...this.crossPairSizing[pair.id] },
    ]));
    state.pairWindowStates = Object.fromEntries(PAIRS.map(pair => {
      const currentStart = this.records.get('BTC:5m')?.market?.start;
      const saved = this.pairWindowStates[pair.id];
      const current = currentStart == null ? saved : this.pairWindowState(pair, currentStart);
      return [pair.id, current ? { ...current } : null];
    }));
    state.crossPairCycles = this.crossPairCycles.map(cycle => ({ ...cycle }));
    state.crossPairs = PAIRS.map(pair => {
      const marketPair = this.pairQuotes(pair, now);
      const windowState = marketPair.windowStart == null
        ? this.pairWindowStates[pair.id] || emptyWindowState(pair, null)
        : this.pairWindowState(pair, marketPair.windowStart);
      const sizing = this.crossPairSizing[pair.id] || emptySizing();
      const unresolved = this.hasUnresolvedCycle(pair.id);
      const currentCycleState = this.crossPairCycles.find(item =>
        item.pairId === pair.id && item.windowStart === marketPair.windowStart);
      const currentCyclePositions = currentCycleState?.legPositionIds
        .map(id => this.positions.find(item => item.id === id)).filter(Boolean) || [];
      const currentCyclePending = currentCyclePositions.some(item => item.status === 'PENDING_RESOLUTION');
      const currentCycleClosed = currentCyclePositions.length > 0 &&
        currentCyclePositions.every(item => CLOSED_POSITION_STATUSES.has(item.status));
      let status = windowState.status;
      let reason = windowState.lastReason;
      if (windowState.entered) {
        status = currentCyclePending ? 'PENDING_RESOLUTION' : currentCycleClosed ? 'CLOSED' : 'ENTERED';
        reason = currentCyclePending
          ? 'One or more legs are waiting for official resolution.'
          : currentCycleClosed ? 'All filled legs in this pair have closed.' : reason;
      } else if (unresolved) {
        status = 'WAITING_FOR_RESOLUTION';
        reason = 'Waiting for the previous entry in this pair to fully resolve before sizing the next one.';
      } else if (!marketPair.asksFresh) {
        status = 'WAITING_FOR_QUOTES';
        reason = 'Waiting for fresh asks on both legs.';
      } else if (marketPair.askSum < ASK_SUM_THRESHOLD && marketPair.windowStart != null &&
          now >= marketPair.windowStart &&
          now < marketPair.windowEnd) {
        status = 'ENTRY_READY';
        reason = `Combined asks are below $${ASK_SUM_THRESHOLD.toFixed(2)}.`;
      } else {
        status = 'ARMED';
        reason = marketPair.askSum == null
          ? 'Waiting for fresh asks on both legs.'
          : `Combined asks $${marketPair.askSum.toFixed(3)}; trigger is below $${ASK_SUM_THRESHOLD.toFixed(2)}.`;
      }
      const cycleDetails = cycle => ({
        ...cycle,
        status: cycle.legPositionIds.some(id =>
          this.positions.find(item => item.id === id)?.status === 'PENDING_RESOLUTION')
          ? 'PENDING_RESOLUTION'
          : cycle.legPositionIds.every(id => CLOSED_POSITION_STATUSES.has(
            this.positions.find(item => item.id === id)?.status,
          )) ? 'CLOSED' : 'OPEN',
        legs: cycle.legs.map(leg => {
          const position = this.positions.find(item => item.id === leg.positionId);
          const order = this.orders.find(item => item.id === leg.orderId);
          return {
            ...leg,
            order: order ? {
              status: order.status,
              requestedShares: order.requestedShares,
              filledShares: order.filledShares,
              cancelledRemainderShares: order.cancelledRemainderShares,
              averagePrice: order.averagePrice,
              cost: order.cost,
              fee: order.fee,
              createdAt: order.createdAt,
            } : null,
            position: position ? { ...position } : null,
          };
        }),
      });
      const pairCycles = this.crossPairCycles
        .filter(item => item.pairId === pair.id)
        .slice(0, 8)
        .map(cycleDetails);
      const cycle = pairCycles.find(item => item.windowStart === marketPair.windowStart) || null;
      const legs = pair.legs.map(leg => {
        const record = this.records.get(`${leg.asset}:5m`);
        const quote = record?.quotes?.[leg.side] || {};
        return {
          ...leg,
          bestAsk: quote.bestAsk ?? null,
          bestBid: quote.bestBid ?? null,
          fresh: quote.status === 'LIVE' && Number.isFinite(Number(quote.updatedAt)) &&
            now - Number(quote.updatedAt) <= QUOTE_MAX_AGE_MS,
        };
      });
      return {
        id: pair.id,
        label: pair.label,
        legs,
        windowStart: marketPair.windowStart,
        secondsRemaining: marketPair.windowEnd == null ? null : Math.max(0, (marketPair.windowEnd - now) / 1000),
        combinedAsk: marketPair.askSum,
        entryThreshold: ASK_SUM_THRESHOLD,
        fresh: marketPair.asksFresh,
        status,
        reason,
        entered: Boolean(windowState.entered),
        nextSharesPerLeg: sizing.nextShares,
        lastOutcome: sizing.lastOutcome,
        unresolvedPreviousCycle: unresolved,
        currentCycle: cycle ? {
          ...cycle,
        } : null,
        trades: pairCycles,
      };
    });
    state.lastCrossPairScanAt = this.lastCrossPairScanAt;
    return state;
  }
}

CrossPairBot.PAIRS = PAIRS;
CrossPairBot.STRATEGY = STRATEGY;
CrossPairBot.constants = {
  BASE_SHARES,
  ASK_SUM_THRESHOLD,
  SWEEP_CAP,
  QUOTE_MAX_AGE_MS,
};

module.exports = CrossPairBot;
