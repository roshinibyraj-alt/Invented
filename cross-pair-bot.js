'use strict';

const DipBounceBot = require('./dip-bounce-bot');
const config = require('./config');

const BASE_STRATEGY_ID = DipBounceBot._test.STRATEGY.id;
const BASE_SHARES = config.CROSS_PAIR_BASE_SHARES;
const RECOVERY_SHARES = config.CROSS_PAIR_BOTH_LOSS_SHARES;
const ASK_SUM_THRESHOLD = config.CROSS_PAIR_ENTRY_ASK_SUM_MAX;
const SWEEP_CAP = config.CROSS_PAIR_TAKER_SWEEP_CAP;
const QUOTE_MAX_AGE_MS = config.DIP_BOUNCE_MAX_QUOTE_AGE_MS;
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
]);

const STRATEGY = Object.freeze({
  id: 'btc-eth-cross-pair-ask-sum-paper',
  name: 'BTC/ETH cross-pair ask-sum paper strategy',
  version: 'cross-pair-080-double-on-both-losses-v1',
  assets: ['BTC', 'ETH'],
  timeframes: ['5m'],
  sharesPerLeg: BASE_SHARES,
  entryAskSumBelow: ASK_SUM_THRESHOLD,
  orderType: 'TAKER',
  sweepCap: SWEEP_CAP,
  exit: 'Hold every filled leg to official resolution; no intrawindow TP or stop-loss.',
  sizing: 'Each cross-pair starts at 100 shares per leg. If both legs lose, its next qualifying entry uses 1,000 shares per leg. After that 1,000-share entry resolves, reset to 100 whether it wins or loses. Any entry with at least one winning leg stays at 100.',
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
    bothLegLosses: 0,
    entries: 0,
    highSizeResets: 0,
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

  checkTakeProfits() {
    // This strategy holds positions to official market resolution.
  }

  checkStopLosses() {
    // This strategy has no intrawindow stop-loss.
  }

  updateSizingAfterClose() {
    // Pair sizing is updated only after both legs of a cross-pair resolve.
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
      const sharesPerLeg = Number(sizing?.nextShares) || BASE_SHARES;
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
      recoveryAttempt: sharesPerLeg >= RECOVERY_SHARES,
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
      ? `Bought ${cycle.legs.map(leg => `${leg.asset} ${leg.side}: ${leg.filledShares}/${sharesPerLeg}`).join(' · ')}; holding to resolution.`
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
      ? `${pair.label} entered at combined asks $${marketPair.askSum.toFixed(3)}; holding both filled legs to resolution.`
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

  applyResolvedPairSizing(now) {
    for (const cycle of this.crossPairCycles) {
      if (cycle.sizingApplied || !cycle.legPositionIds.length) continue;
      const positions = cycle.legPositionIds
        .map(id => this.positions.find(position => position.id === id))
        .filter(Boolean);
      if (positions.length !== cycle.legPositionIds.length ||
          positions.some(position => !['RESOLVED_WIN', 'RESOLVED_LOSS'].includes(position.status))) {
        continue;
      }

      const bothLost = positions.length === 2 &&
        positions.every(position => position.status === 'RESOLVED_LOSS');
      const sizing = this.crossPairSizing[cycle.pairId] || emptySizing();
      const wasRecoveryAttempt = cycle.recoveryAttempt || cycle.sharesPerLeg >= RECOVERY_SHARES;
      if (wasRecoveryAttempt) {
        sizing.nextShares = BASE_SHARES;
        sizing.highSizeResets += 1;
        cycle.sizingOutcome = 'RECOVERY_ATTEMPT_RESET';
      } else if (bothLost) {
        sizing.nextShares = RECOVERY_SHARES;
        sizing.bothLegLosses += 1;
        cycle.sizingOutcome = 'BOTH_LEGS_LOST';
      } else {
        sizing.nextShares = BASE_SHARES;
        cycle.sizingOutcome = positions.some(position => position.status === 'RESOLVED_WIN')
          ? 'AT_LEAST_ONE_WIN' : 'INCOMPLETE_PAIR';
      }
      sizing.lastOutcome = cycle.sizingOutcome;
      sizing.lastUpdatedAt = now;
      this.crossPairSizing[cycle.pairId] = sizing;
      cycle.sizingApplied = true;
      cycle.status = 'SETTLED';
      cycle.settledAt = now;
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
        ? `both legs lost; next qualifying entry is ${RECOVERY_SHARES} shares per leg`
        : cycle.sizingOutcome === 'RECOVERY_ATTEMPT_RESET'
          ? `the ${RECOVERY_SHARES}-share recovery attempt resolved; reset to ${BASE_SHARES} per leg`
          : `at least one leg won; remain at ${BASE_SHARES} shares per leg`;
      this.log(`${cycle.pairLabel} resolved; ${description}.`, {
        timeframe: '5m',
        outcome: cycle.sizingOutcome === 'BOTH_LEGS_LOST' ? 'bad' : 'good',
        type: 'CROSS_PAIR_SIZING',
        now,
      });
    }
    this.scheduleLedgerSave();
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
        nextShares: Number(saved.nextShares) === RECOVERY_SHARES ? RECOVERY_SHARES : BASE_SHARES,
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
        const pair = PAIRS.find(item => item.legs.some(leg =>
          leg.asset === market.asset && leg.side === side));
        const pairState = pair && this.pairWindowStates[pair.id];
        return [side, {
          bestBid: original.bestBid,
          bestAsk: original.bestAsk,
          mid: original.mid,
          updatedAt: original.updatedAt,
          ageMs: original.ageMs,
          fresh: original.fresh,
          orderStatus: pairState?.entered
            ? pairState.status
            : 'MONITORING',
          requestedShares: pairState?.entered
            ? (this.crossPairSizing[pair.id]?.nextShares || BASE_SHARES) : null,
          filledShares: this.positions
            .filter(position => position.pairId === pair?.id &&
              position.windowStart === market.start && position.asset === market.asset &&
              position.side === side)
            .reduce((sum, position) => sum + Number(position.shares || 0), 0),
          pairLabel: pair?.label || `${market.asset} ${side} · ${other}`,
          reason: pairState?.lastReason || 'Monitored as one leg of its BTC/ETH cross-pair.',
        }];
      })),
    }));
    state.strategy = {
      ...STRATEGY,
      entry: 'Monitor BTC UP + ETH DOWN and ETH UP + BTC DOWN independently. Enter a pair when its fresh best asks sum to strictly less than $0.80; one entry per pair per 5-minute window.',
      fill: 'Paper taker sweep of visible asks up to $0.99. Actual filled quantity, average entry, and market taker fees are recorded; unfilled remainder is cancelled.',
      sizing: STRATEGY.sizing,
      settlement: 'Hold all filled legs to official resolution. Sizing changes only after both filled legs in a cross-pair have resolved.',
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
      let status = windowState.status;
      let reason = windowState.lastReason;
      if (windowState.entered) {
        status = 'ENTERED';
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
      const cycle = this.crossPairCycles.find(item =>
        item.pairId === pair.id && item.windowStart === marketPair.windowStart);
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
          id: cycle.id,
          sharesPerLeg: cycle.sharesPerLeg,
          status: cycle.status,
          legPositionIds: [...cycle.legPositionIds],
          realizedPnl: cycle.realizedPnl ?? null,
        } : null,
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
  RECOVERY_SHARES,
  ASK_SUM_THRESHOLD,
  SWEEP_CAP,
  QUOTE_MAX_AGE_MS,
};

module.exports = CrossPairBot;
