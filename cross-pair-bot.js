'use strict';

const DipBounceBot = require('./dip-bounce-bot');
const config = require('./config');

const BASE_STRATEGY_ID = DipBounceBot._test.STRATEGY.id;
const BASE_SHARES = config.CROSS_PAIR_BASE_SHARES;
const ASK_SUM_THRESHOLD = config.CROSS_PAIR_ENTRY_ASK_SUM_MAX;
const SWEEP_CAP = config.CROSS_PAIR_TAKER_SWEEP_CAP;
const INVERSE_EXIT_ASK_SUM_THRESHOLD = 1.22;
const TAKE_PROFIT_BID = config.DIP_BOUNCE_TAKE_PROFIT_BID;
const TAKE_PROFIT_PAYOUT = config.DIP_BOUNCE_TAKE_PROFIT_PAYOUT;
const QUOTE_MAX_AGE_MS = config.DIP_BOUNCE_MAX_QUOTE_AGE_MS;
const CLOSED_POSITION_STATUSES = new Set([
  'TAKE_PROFIT',
  'STOP_LOSS',
  'PAIR_REVERSE_EXIT',
  'RESOLVED_WIN',
  'RESOLVED_LOSS',
]);
const PAIRS = Object.freeze([
  Object.freeze({
    id: 'btc-up-eth-down',
    label: 'BTC UP + ETH DOWN',
    inversePairId: 'eth-up-btc-down',
    legs: Object.freeze([
      Object.freeze({ asset: 'BTC', side: 'UP' }),
      Object.freeze({ asset: 'ETH', side: 'DOWN' }),
    ]),
  }),
  Object.freeze({
    id: 'eth-up-btc-down',
    label: 'ETH UP + BTC DOWN',
    inversePairId: 'btc-up-eth-down',
    legs: Object.freeze([
      Object.freeze({ asset: 'ETH', side: 'UP' }),
      Object.freeze({ asset: 'BTC', side: 'DOWN' }),
    ]),
  }),
  Object.freeze({
    id: 'btc-up-eth-up',
    label: 'BTC UP + ETH UP',
    inversePairId: 'btc-down-eth-down',
    legs: Object.freeze([
      Object.freeze({ asset: 'BTC', side: 'UP' }),
      Object.freeze({ asset: 'ETH', side: 'UP' }),
    ]),
  }),
  Object.freeze({
    id: 'btc-down-eth-down',
    label: 'BTC DOWN + ETH DOWN',
    inversePairId: 'btc-up-eth-up',
    legs: Object.freeze([
      Object.freeze({ asset: 'BTC', side: 'DOWN' }),
      Object.freeze({ asset: 'ETH', side: 'DOWN' }),
    ]),
  }),
]);

const STRATEGY = Object.freeze({
  id: 'btc-eth-four-pair-inverse-exit-tpsl-paper',
  name: 'BTC/ETH four-pair fixed-size paper strategy',
  version: 'four-pairs-080-inverse-122-tp-099-empty-book-sl-000-v5',
  assets: ['BTC', 'ETH'],
  timeframes: ['5m'],
  sharesPerLeg: BASE_SHARES,
  entryAskSumBelow: ASK_SUM_THRESHOLD,
  orderType: 'TAKER',
  sweepCap: SWEEP_CAP,
  resolutionPollMs: config.DIP_BOUNCE_RESOLUTION_POLL_MS,
  inverseExitAskSumAtOrAbove: INVERSE_EXIT_ASK_SUM_THRESHOLD,
  takeProfitBid: TAKE_PROFIT_BID,
  takeProfitPayoutPerShare: TAKE_PROFIT_PAYOUT,
  stopLoss: 'Fresh empty best-bid book; settle remaining shares at $0.',
  exit: 'Sell a pair when its own combined asks reach $1.22. The inverse pair enters only if its own asks are below $0.80. Also apply the $0.99 bid take-profit ($1/share) and empty-bid $0 stop; any remaining open shares go to official resolution at window end.',
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

function marketTakerFeeRate(market) {
  const configuredRate = Number(
    market?.feeSchedule?.rate ?? market?.takerFeeRate ??
    (market?.asset === 'BTC' ? 0.05 : 0.01),
  );
  if (market?.feesEnabled === false) return 0;
  return Number.isFinite(configuredRate) && configuredRate >= 0 ? configuredRate : null;
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

function sweepBids(levels, requestedShares, market) {
  let remaining = requestedShares;
  let notional = 0;
  let fees = 0;
  const fills = [];
  const feeRate = marketTakerFeeRate(market);
  if (feeRate == null) {
    return { filledShares: 0, remainingShares: requestedShares, notional: 0, fees: 0, averagePrice: null, fills: [] };
  }

  const descendingBids = sortLevels(levels).sort((a, b) => b.price - a.price);
  for (const level of descendingBids) {
    if (remaining <= 1e-9) break;
    const shares = Math.min(remaining, level.size);
    const value = shares * level.price;
    const fee = shares * feeRate * level.price * (1 - level.price);
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
    this.bidDepthByToken = new Map();
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

  processSide(record, side, quote) {
    const now = this.now();
    this.checkStopLosses(record, side, quote, now);
    this.checkTakeProfits(record, side, quote, now);
    this.evaluateCrossPairs(now);
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
    cycle.sizingOutcome = cycle.realizedPnl > 1e-9 ? 'PAIR_PROFIT'
      : cycle.realizedPnl < -1e-9 ? 'PAIR_LOSS' : 'PAIR_FLAT';
    this.applyPairSizing(cycle, positions, now);
  }

  updateSizingAfterClose(position, _won, now = this.now()) {
    this.updateCycleAfterPositionClose(position, now);
  }

  markPositions(now, onlyRecordKey = null, onlySide = null) {
    super.markPositions(now, onlyRecordKey, onlySide);
    for (const position of this.positions) {
      if (position.status !== 'OPEN') continue;
      if (onlySide && position.side !== onlySide) continue;
      const record = this.records.get(`${position.asset}:${position.timeframe}`);
      if (!record || (onlyRecordKey && record.key !== onlyRecordKey)) continue;
      if (String(record.market?.id || record.market?.slug) !== position.marketId) continue;
      if (position.markStatus !== 'LIVE' || !Number.isFinite(Number(position.markBid))) continue;
      const remainingEntryFees = Number.isFinite(Number(position.remainingEntryFees))
        ? Number(position.remainingEntryFees)
        : Number(position.fees) || 0;
      position.unrealizedPnl = round(
        Number(position.markBid) * Number(position.shares)
        - Number(position.totalCost || 0)
        - remainingEntryFees,
      );
    }
  }

  accountSnapshot() {
    const account = super.accountSnapshot();
    const closedPnl = this.positions.reduce((sum, position) =>
      sum + (Number.isFinite(Number(position.realizedPnl)) ? Number(position.realizedPnl) : 0), 0);
    const openPartialPnl = this.positions
      .filter(position => ['OPEN', 'PENDING_RESOLUTION'].includes(position.status))
      .reduce((sum, position) => sum + (Number(position.partialRealizedPnl) || 0), 0);
    const totalFees = this.positions.reduce((sum, position) =>
      sum + (Number(position.fees) || 0) + (Number(position.exitFees) || 0), 0);
    return {
      ...account,
      realizedPnl: round(closedPnl + openPartialPnl),
      totalFees: round(totalFees),
    };
  }

  evaluateCrossPairs(now = this.now()) {
    let changed = this.processInversePairExits(now);
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

  processInversePairExits(now) {
    let changed = false;
    for (const cycle of this.crossPairCycles) {
      if (!cycle.legPositionIds?.length ||
          cycle.windowStart == null ||
          now < Number(cycle.windowStart) ||
          now >= Number(cycle.windowEnd)) continue;
      const pair = PAIRS.find(item => item.id === cycle.pairId);
      if (!pair) continue;
      const marketPair = this.pairQuotes(pair, now);
      if (!marketPair.marketsAligned || !marketPair.asksFresh ||
          Number(marketPair.windowStart) !== Number(cycle.windowStart)) continue;
      const activePositions = cycle.legPositionIds
        .map(id => this.positions.find(position => position.id === id))
        .filter(position => position?.status === 'OPEN' && Number(position.shares) > 1e-9);
      if (!activePositions.length) continue;

      if (!cycle.reverseExitTriggeredAt && marketPair.askSum < INVERSE_EXIT_ASK_SUM_THRESHOLD) continue;
      if (!cycle.reverseExitTriggeredAt) {
        cycle.reverseExitTriggeredAt = now;
        cycle.reverseExitAskSum = marketPair.askSum;
        cycle.reverseExitReason = `Own combined asks reached $${marketPair.askSum.toFixed(3)} (threshold $${INVERSE_EXIT_ASK_SUM_THRESHOLD.toFixed(2)}).`;
        cycle.reverseExitStatus = 'SELLING';
        changed = true;
        this.log(`${pair.label} inverse exit triggered at combined asks $${marketPair.askSum.toFixed(3)}; selling its remaining legs.`, {
          timeframe: '5m',
          outcome: 'neutral',
          type: 'INVERSE_PAIR_EXIT_TRIGGER',
          now,
        });
      }

      for (const position of activePositions) {
        const leg = marketPair.legs.find(item =>
          item.asset === position.asset && item.side === position.side);
        if (!leg) continue;
        const order = this.sellPositionAtBids(cycle, position, leg, now);
        if (order?.filledShares > 0) changed = true;
      }

      const remaining = cycle.legPositionIds
        .map(id => this.positions.find(position => position.id === id))
        .filter(position => position?.status === 'OPEN' && Number(position.shares) > 1e-9);
      cycle.reverseExitStatus = remaining.length ? 'SELLING_REMAINDER' : 'SOLD';
      const pairState = this.pairWindowState(pair, marketPair.windowStart);
      pairState.status = remaining.length ? 'REVERSAL_EXITING' : 'CLOSED';
      pairState.lastReason = remaining.length
        ? `Inverse exit triggered at $${cycle.reverseExitAskSum.toFixed(3)}; retrying the remaining bid-side sell quantity.`
        : `Sold this pair after combined asks reached $${cycle.reverseExitAskSum.toFixed(3)}. Its inverse pair was evaluated independently against its own $0.80 entry gate.`;
      if (!remaining.length) {
        cycle.status = 'CLOSED';
        cycle.closedAt = now;
        cycle.realizedPnl = round(cycle.legPositionIds.reduce((sum, id) => {
          const position = this.positions.find(item => item.id === id);
          return sum + (Number(position?.realizedPnl) || 0);
        }, 0));
        this.applyPairSizing(cycle, cycle.legPositionIds
          .map(id => this.positions.find(item => item.id === id)).filter(Boolean), now);
      }
    }
    if (changed) {
      this.updateAccountMetrics(now, true);
      this.scheduleLedgerSave();
    }
    return changed;
  }

  availableBidLevels(leg) {
    const tokenId = `${String(leg.market?.id || leg.market?.slug || '')}:${leg.side}`;
    if (tokenId === ':') return [];
    const quote = leg.quote || {};
    const sequence = Number(quote.sequence) || Number(quote.updatedAt) || 0;
    let state = this.bidDepthByToken.get(tokenId);
    if (!state || state.sequence !== sequence) {
      state = {
        sequence,
        remainingByPrice: new Map(sortLevels(quote.bids).map(level => [level.price, level.size])),
      };
      this.bidDepthByToken.set(tokenId, state);
    }
    return sortLevels(quote.bids)
      .map(level => ({ price: level.price, size: Math.min(
        level.size,
        Number(state.remainingByPrice.get(level.price)) || 0,
      ) }))
      .filter(level => level.size > 1e-9)
      .sort((a, b) => b.price - a.price);
  }

  consumeBidLevels(leg, fills) {
    const tokenId = `${String(leg.market?.id || leg.market?.slug || '')}:${leg.side}`;
    const state = this.bidDepthByToken.get(tokenId);
    if (!state) return;
    for (const fill of fills) {
      const previous = Number(state.remainingByPrice.get(fill.price)) || 0;
      state.remainingByPrice.set(fill.price, Math.max(0, previous - Number(fill.shares)));
    }
  }

  sellPositionAtBids(cycle, position, leg, now) {
    const requestedShares = Number(position.shares) || 0;
    if (requestedShares <= 1e-9) return null;
    const bidLevels = this.availableBidLevels(leg);
    const fill = sweepBids(bidLevels, requestedShares, leg.market);
    if (fill.filledShares <= 1e-9) return null;

    this.consumeBidLevels(leg, fill.fills);
    const beforeShares = Number(position.shares);
    const shareRatio = fill.filledShares / beforeShares;
    const costAllocated = Number(position.totalCost || 0) * shareRatio;
    const remainingFeesBefore = Number.isFinite(Number(position.remainingEntryFees))
      ? Number(position.remainingEntryFees)
      : Number(position.fees) || 0;
    const entryFeesAllocated = remainingFeesBefore * shareRatio;
    const partialNet = fill.notional - costAllocated - entryFeesAllocated - fill.fees;
    position.partialRealizedPnl = round((Number(position.partialRealizedPnl) || 0) + partialNet);
    position.totalCost = round(Math.max(0, Number(position.totalCost || 0) - costAllocated));
    position.remainingEntryFees = round(Math.max(0, remainingFeesBefore - entryFeesAllocated));
    position.shares = round(Math.max(0, beforeShares - fill.filledShares));
    position.soldShares = round((Number(position.soldShares) || 0) + fill.filledShares);
    position.exitProceeds = round((Number(position.exitProceeds) || 0) + fill.notional);
    position.exitFees = round((Number(position.exitFees) || 0) + fill.fees);
    position.exitFills = [...(position.exitFills || []), ...fill.fills.map(item => ({
      ...item,
      filledAt: now,
      reason: 'INVERSE_PAIR_ASK_SUM_1.22',
    }))];
    this.cash = round(this.cash + fill.notional - fill.fees);

    const orderId = `cross-${++this.orderSequence}`;
    const fullyFilled = position.shares <= 1e-9;
    const order = {
      id: orderId,
      pairId: cycle.pairId,
      pairCycleId: cycle.id,
      pairLabel: cycle.pairLabel,
      marketId: position.marketId,
      marketSlug: position.marketSlug,
      marketTitle: position.marketTitle,
      asset: position.asset,
      timeframe: position.timeframe,
      windowStart: position.windowStart,
      windowEnd: position.windowEnd,
      side: position.side,
      action: 'SELL_TAKER',
      kind: 'INVERSE_PAIR_EXIT',
      orderType: 'MARKET',
      status: fill.remainingShares <= 1e-9 ? 'FILLED'
        : fill.filledShares > 0 ? 'PARTIALLY_FILLED_RETRY_REMAINDER' : 'NO_FILL',
      requestedShares,
      filledShares: fill.filledShares,
      remainingShares: fill.remainingShares,
      proceeds: fill.notional,
      fee: fill.fees,
      averagePrice: fill.averagePrice,
      fills: fill.fills,
      fillRule: 'Sell against currently visible CLOB bids; retry any unfilled remainder while the exit is latched.',
      positionId: position.id,
      createdAt: now,
      submittedAt: now,
      filledAt: fill.filledShares > 0 ? now : null,
      triggerAskSum: cycle.reverseExitAskSum,
    };
    this.orders.unshift(order);
    this.totalOrderAttempts += 1;
    position.exitOrderIds = [...(position.exitOrderIds || []), orderId];
    position.lastExitOrderId = orderId;
    if (fullyFilled) {
      position.closedSharesAtExit = 0;
      position.status = 'PAIR_REVERSE_EXIT';
      position.exitAt = now;
      position.exitPrice = position.soldShares > 0
        ? round(position.exitProceeds / position.soldShares)
        : fill.averagePrice;
      position.exitReason = 'INVERSE_PAIR_ASK_SUM_1.22';
      position.realizedPnl = round(Number(position.partialRealizedPnl) || 0);
      position.markStatus = 'CLOSED';
      position.markBid = leg.quote.bestBid ?? null;
      position.markUpdatedAt = leg.quote.updatedAt || now;
      position.unrealizedPnl = null;
      this.updateSizingAfterClose(position, position.realizedPnl > 0, now);
    } else {
      position.partialExitReason = 'INVERSE_PAIR_ASK_SUM_1.22';
      position.markBid = leg.quote.bestBid ?? null;
      position.markUpdatedAt = leg.quote.updatedAt || now;
      position.markStatus = 'LIVE';
      position.unrealizedPnl = position.markBid == null ? null : round(
        Number(position.markBid) * position.shares
        - position.totalCost
        - position.remainingEntryFees,
      );
    }
    cycle.legs.forEach(item => {
      if (item.positionId !== position.id) return;
      item.soldShares = position.soldShares || 0;
      item.lastExitOrderId = orderId;
      item.exitStatus = order.status;
    });
    this.log(`${position.asset} ${position.side} inverse-pair sell filled ${fill.filledShares}/${requestedShares} at average $${fill.averagePrice.toFixed(3)}; net sell fees $${fill.fees.toFixed(3)}.`, {
      timeframe: '5m',
      side: position.side,
      outcome: fill.filledShares > 0 ? 'good' : 'neutral',
      type: 'INVERSE_PAIR_SELL',
      now,
    });
    return order;
  }

  checkTakeProfits(record, side, quote, now) {
    if (!record?.market || record.marketStatus !== 'OPEN' ||
        Number(quote?.bestBid) < TAKE_PROFIT_BID) return;
    if (!Number.isFinite(Number(quote?.updatedAt)) ||
        now - Number(quote.updatedAt) > config.DIP_BOUNCE_MAX_QUOTE_AGE_MS) return;
    const marketId = String(record.market.id || record.market.slug);
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.side !== side || position.status !== 'OPEN') continue;
      const remainingShares = Number(position.shares) || 0;
      const payout = remainingShares * TAKE_PROFIT_PAYOUT;
      const remainingEntryFees = Number.isFinite(Number(position.remainingEntryFees))
        ? Number(position.remainingEntryFees)
        : Number(position.fees) || 0;
      this.cash = round(this.cash + payout);
      position.partialRealizedPnl = Number(position.partialRealizedPnl) || 0;
      position.realizedPnl = round(
        position.partialRealizedPnl + payout
        - Number(position.totalCost || 0)
        - remainingEntryFees,
      );
      position.status = 'TAKE_PROFIT';
      position.closedSharesAtExit = remainingShares;
      position.shares = 0;
      position.exitAt = now;
      position.exitPrice = TAKE_PROFIT_BID;
      position.exitPayout = TAKE_PROFIT_PAYOUT;
      position.exitReason = 'TAKE_PROFIT_099';
      position.takeProfitPayout = round((Number(position.takeProfitPayout) || 0) + payout);
      position.remainingEntryFees = 0;
      position.markBid = TAKE_PROFIT_BID;
      position.markUpdatedAt = quote.updatedAt;
      position.markStatus = 'CLOSED';
      position.unrealizedPnl = null;
      this.updateSizingAfterClose(position, position.realizedPnl > 0, now);
      this.log(`${position.asset} ${side} take-profit hit at $0.99; credited $1.00 per remaining share.`, {
        asset: position.asset,
        timeframe: position.timeframe,
        side,
        outcome: position.realizedPnl >= 0 ? 'good' : 'bad',
        type: 'TAKE_PROFIT',
        now,
      });
      this.updateAccountMetrics(now, true);
    }
  }

  checkStopLosses(record, side, quote, now) {
    if (!record?.market || record.marketStatus !== 'OPEN') return;
    const fresh = Number.isFinite(Number(quote?.updatedAt))
      && now - Number(quote.updatedAt) <= config.DIP_BOUNCE_MAX_QUOTE_AGE_MS;
    if (!fresh || (quote.bestBid != null && Number(quote.bestBid) > 0)) return;
    const marketId = String(record.market.id || record.market.slug);
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.side !== side || position.status !== 'OPEN') continue;
      const remainingEntryFees = Number.isFinite(Number(position.remainingEntryFees))
        ? Number(position.remainingEntryFees)
        : Number(position.fees) || 0;
      position.partialRealizedPnl = Number(position.partialRealizedPnl) || 0;
      position.realizedPnl = round(
        position.partialRealizedPnl
        - Number(position.totalCost || 0)
        - remainingEntryFees,
      );
      position.status = 'STOP_LOSS';
      position.closedSharesAtExit = Number(position.shares) || 0;
      position.shares = 0;
      position.exitAt = now;
      position.exitPrice = 0;
      position.exitPayout = 0;
      position.exitReason = 'STOP_LOSS_000';
      position.remainingEntryFees = 0;
      position.markBid = 0;
      position.markUpdatedAt = quote.updatedAt;
      position.markStatus = 'CLOSED';
      position.unrealizedPnl = null;
      this.updateSizingAfterClose(position, false, now);
      this.log(`${position.asset} ${side} stop-loss hit: the fresh bid book is empty; remaining shares count as a $0 payout.`, {
        asset: position.asset,
        timeframe: position.timeframe,
        side,
        outcome: 'bad',
        type: 'STOP_LOSS',
        now,
      });
      this.updateAccountMetrics(now, true);
    }
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
      inversePairId: pair.inversePairId,
      sharesPerLeg,
      legPositionIds: [],
      legs: [],
      sizingApplied: false,
      reverseExitTriggeredAt: null,
      reverseExitAskSum: null,
      reverseExitStatus: null,
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
        soldShares: 0,
        exitOrderIds: [],
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
        initialCost: leg.fill.notional,
        initialFees: leg.fill.fees,
        remainingEntryFees: leg.fill.fees,
        partialRealizedPnl: 0,
        soldShares: 0,
        exitProceeds: 0,
        exitFees: 0,
        exitOrderIds: [],
        exitFills: [],
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
      ? `Bought ${cycle.legs.map(leg => `${leg.asset} ${leg.side}: ${leg.filledShares}/${sharesPerLeg}`).join(' · ')}; exit at own ask sum $1.22, TP $0.99, empty-bid SL $0, or official resolution.`
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
      ? `${pair.label} entered at combined asks $${marketPair.askSum.toFixed(3)}; pair exit $1.22, TP $0.99, empty-bid SL $0, otherwise resolution.`
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
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.status !== 'PENDING_RESOLUTION') continue;
      const won = position.side === winner;
      const resolvedShares = Number(position.shares) || 0;
      const payout = won ? resolvedShares : 0;
      const remainingEntryFees = Number.isFinite(Number(position.remainingEntryFees))
        ? Number(position.remainingEntryFees)
        : Number(position.fees) || 0;
      this.cash = round(this.cash + payout);
      position.partialRealizedPnl = Number(position.partialRealizedPnl) || 0;
      position.status = won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS';
      position.closedSharesAtExit = resolvedShares;
      position.shares = 0;
      position.resolvedAt = now;
      position.resolutionWinner = winner;
      position.exitPrice = won ? 1 : 0;
      position.exitPayout = won ? 1 : 0;
      position.exitReason = 'OFFICIAL_RESOLUTION';
      position.realizedPnl = round(
        position.partialRealizedPnl + payout
        - Number(position.totalCost || 0)
        - remainingEntryFees,
      );
      position.remainingEntryFees = 0;
      position.markStatus = 'CLOSED';
      position.unrealizedPnl = null;
      this.updateSizingAfterClose(position, won, now);
      this.log(`${position.asset} ${position.side} resolved ${won ? 'WIN' : 'LOSS'}; official market winner was ${winner}.`, {
        asset: position.asset,
        timeframe: position.timeframe,
        side: position.side,
        outcome: won ? 'good' : 'bad',
        type: 'RESOLUTION',
        now,
      });
    }
    this.applyResolvedPairSizing(now);
    this.updateAccountMetrics(now, true);
  }

  expireMarket(record, now) {
    if (!record?.market) return;
    const marketId = String(record.market.id || record.market.slug);
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.status !== 'OPEN') continue;
      position.resolutionMarkBid = position.markBid;
      position.resolutionMarkAt = position.markUpdatedAt;
      position.resolutionMarkPnl = position.unrealizedPnl;
    }
    super.expireMarket(record, now);
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.status !== 'PENDING_RESOLUTION') continue;
      position.markStatus = position.resolutionMarkBid == null
        ? 'PENDING_RESOLUTION'
        : 'LAST_MARK_PENDING_RESOLUTION';
      position.unrealizedPnl = Number.isFinite(Number(position.resolutionMarkPnl))
        ? Number(position.resolutionMarkPnl)
        : null;
    }
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
    const netPnl = positions.reduce((sum, position) => sum + (Number(position.realizedPnl) || 0), 0);
    const sizing = this.crossPairSizing[cycle.pairId] || emptySizing();
    sizing.nextShares = BASE_SHARES;
    cycle.sizingOutcome = netPnl > 1e-9 ? 'PAIR_PROFIT'
      : netPnl < -1e-9 ? 'PAIR_LOSS' : 'PAIR_FLAT';
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
    this.log(`${cycle.pairLabel} closed with ${cycle.sizingOutcome.toLowerCase()}; size remains ${BASE_SHARES} shares per leg.`, {
      timeframe: '5m',
      outcome: netPnl < -1e-9 ? 'bad' : 'good',
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
    for (const position of this.positions) {
      if (position.status !== 'PENDING_RESOLUTION' ||
          !Number.isFinite(Number(position.resolutionMarkPnl))) continue;
      position.unrealizedPnl = Number(position.resolutionMarkPnl);
      position.markBid = Number.isFinite(Number(position.resolutionMarkBid))
        ? Number(position.resolutionMarkBid)
        : position.markBid;
      position.markUpdatedAt = Number.isFinite(Number(position.resolutionMarkAt))
        ? Number(position.resolutionMarkAt)
        : position.markUpdatedAt;
      position.markStatus = position.markBid == null
        ? 'PENDING_RESOLUTION'
        : 'LAST_MARK_PENDING_RESOLUTION';
    }
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
              position.side === side && ['OPEN', 'PENDING_RESOLUTION'].includes(position.status))
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
      inverseExit: `If a pair's own combined asks reach $${INVERSE_EXIT_ASK_SUM_THRESHOLD.toFixed(2)}, sell its remaining shares against visible bids. Its inverse pair is not forced to sell and can enter only when its own combined asks are below $${ASK_SUM_THRESHOLD.toFixed(2)}.`,
      takeProfit: `When a side's best bid reaches $${TAKE_PROFIT_BID.toFixed(2)}, model a $${TAKE_PROFIT_PAYOUT.toFixed(2)} payout per remaining share.`,
      stopLoss: 'A fresh empty best-bid book triggers the $0.00 stop-loss for that side.',
      settlement: `Any shares still open at window end move to official Polymarket resolution; the bot checks for an official result every ${config.DIP_BOUNCE_RESOLUTION_POLL_MS / 1000} seconds.`,
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
      const inversePair = PAIRS.find(item => item.id === pair.inversePairId);
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
        status = currentCyclePending ? 'PENDING_RESOLUTION'
          : currentCycleClosed ? 'CLOSED'
            : currentCycleState?.reverseExitStatus === 'SELLING_REMAINDER' ? 'REVERSAL_EXITING'
              : 'ENTERED';
        reason = currentCyclePending
          ? 'One or more legs are waiting for official resolution.'
          : currentCycleClosed ? 'All filled legs in this pair have closed.'
            : currentCycleState?.reverseExitStatus === 'SELLING_REMAINDER'
              ? `Inverse exit is active; selling remaining shares. ${inversePair?.label || 'The inverse pair'} still needs its own ask sum below $0.80 to enter.`
              : reason;
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
      const cycle = pairCycles.find(item => ['OPEN', 'PENDING_RESOLUTION'].includes(item.status))
        || pairCycles.find(item => item.windowStart === marketPair.windowStart)
        || null;
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
        inversePairId: pair.inversePairId,
        inversePairLabel: inversePair?.label || null,
        legs,
        windowStart: marketPair.windowStart,
        secondsRemaining: marketPair.windowEnd == null ? null : Math.max(0, (marketPair.windowEnd - now) / 1000),
        combinedAsk: marketPair.askSum,
        entryThreshold: ASK_SUM_THRESHOLD,
        inverseExitThreshold: INVERSE_EXIT_ASK_SUM_THRESHOLD,
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
  INVERSE_EXIT_ASK_SUM_THRESHOLD,
  TAKE_PROFIT_BID,
  TAKE_PROFIT_PAYOUT,
  QUOTE_MAX_AGE_MS,
};

module.exports = CrossPairBot;
