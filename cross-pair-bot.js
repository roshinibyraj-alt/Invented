'use strict';

const cfg = require('./config');
const WickBot = require('./wick-bot');
const marketData = require('./wick-market-data');
const { quoteFromBook, takerFeeFor, feeContext } = WickBot._test;

const SHARES_PER_LEG = cfg.CROSS_PAIR_SHARES_PER_LEG;
const ENTRY_ASK_SUM_MAX = cfg.CROSS_PAIR_ENTRY_ASK_SUM_MAX;
const EXIT_BID_SUM_MIN = cfg.CROSS_PAIR_EXIT_BID_SUM_MIN;
const MAX_ENTRY_PRICE = cfg.CROSS_PAIR_MAX_ENTRY_PRICE;
const QUOTE_MAX_AGE_MS = 2000;
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

function round(value) {
  return Number(Number(value).toFixed(6));
}

function sortedLevels(levels, action) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1 &&
      Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => action === 'BUY' ? a.price - b.price : b.price - a.price);
}

function sweepBook(levels, requestedShares, action, maxPrice = null) {
  let remaining = requestedShares;
  let notional = 0;
  const fills = [];
  for (const level of sortedLevels(levels, action)) {
    if (action === 'BUY' && maxPrice != null && level.price > maxPrice + 1e-9) break;
    if (remaining <= 1e-9) break;
    const shares = Math.min(remaining, level.size);
    const value = shares * level.price;
    notional += value;
    remaining -= shares;
    fills.push({ shares: round(shares), price: round(level.price), value: round(value) });
  }
  return {
    filledShares: round(requestedShares - remaining),
    remainingShares: round(remaining),
    notional: round(notional),
    averagePrice: requestedShares - remaining > 0
      ? round(notional / (requestedShares - remaining))
      : null,
    fills,
  };
}

function feesFor(market, fills) {
  return round(fills.reduce((sum, fill) =>
    sum + takerFeeFor(market, fill.price, fill.shares), 0));
}

function emptyPairState(pair) {
  return {
    id: pair.id,
    label: pair.label,
    cycleCount: 0,
    status: 'ARMED',
    activeCycle: null,
    lastReason: 'Waiting for both ask quotes.',
    lastEntryAskSum: null,
    lastExitBidSum: null,
    lastDepthNotice: null,
    lastDepthNoticeAt: 0,
    lastBlockNotice: null,
    lastBlockNoticeAt: 0,
  };
}

class CrossPairBot extends WickBot {
  constructor({ marketData: data = marketData } = {}) {
    super({
      timeframe: '5m',
      windowMs: cfg.WINDOW_MS_5M,
      capital: cfg.DEMO_CAPITAL,
      strategyId: 'btc-eth-cross-pair-arbitrage',
      strategyName: 'BTC/ETH cross-pair arbitrage',
      rules: { sharesPerSide: SHARES_PER_LEG },
      marketData: data,
    });
    this.crossAssetData = data;
    this.btcMarket = null;
    this.btcLiveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
    this.pairStates = Object.fromEntries(PAIRS.map(pair => [pair.id, emptyPairState(pair)]));
    this.pairCycles = [];
  }

  getWindowStartToScan(_now, currentStart) {
    return currentStart;
  }

  async loadMarket(start, windowMs) {
    const [btcMarket, ethMarket] = await Promise.all([
      this.crossAssetData.getBtcMarket(start, windowMs),
      this.crossAssetData.getEthMarket(start, windowMs),
    ]);
    if (!btcMarket || !ethMarket) {
      this.btcMarket = btcMarket;
      return null;
    }
    if (Number(btcMarket.start) !== Number(ethMarket.start)) {
      throw new Error('BTC and ETH markets do not share the same 5-minute window start.');
    }
    this.btcMarket = btcMarket;
    return ethMarket;
  }

  async refreshLiveQuotes(now) {
    await super.refreshLiveQuotes(now);
    if (!this.btcMarket) {
      this.btcLiveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
      return;
    }
    const sides = ['UP', 'DOWN'];
    const results = await Promise.allSettled(
      sides.map(side => this.crossAssetData.getBook(this.btcMarket.tokens[side])),
    );
    for (const [index, side] of sides.entries()) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        this.btcLiveQuotes[side] = quoteFromBook(result.value, now);
      } else {
        const previous = this.btcLiveQuotes[side] || {};
        const stale = !previous.updatedAt || now - previous.updatedAt > 10000;
        this.btcLiveQuotes[side] = {
          ...previous,
          status: previous.updatedAt ? (stale ? 'STALE' : 'LIVE') : 'ERROR',
          stale,
          attemptedAt: now,
          error: result.reason?.message || 'BTC order book unavailable',
        };
      }
    }

    // The base class marks ETH positions; explicitly correct BTC marks too.
    for (const position of this.positions) {
      if (position.status !== 'OPEN' || position.windowStart !== this.market?.start) continue;
      const quote = this.quoteFor(position.asset, position.side);
      position.markBid = quote?.bestBid ?? null;
      position.markUpdatedAt = quote?.updatedAt || now;
      position.markStatus = quote?.bestBid != null ? 'LIVE' : 'MISSING';
    }
  }

  openStrategyWindow(start, now) {
    super.openStrategyWindow(start, now);
    this.pairStates = Object.fromEntries(PAIRS.map(pair => [pair.id, emptyPairState(pair)]));
  }

  quoteFor(asset, side) {
    return asset === 'BTC' ? this.btcLiveQuotes[side] : this.liveQuotes[side];
  }

  marketFor(asset) {
    return asset === 'BTC' ? this.btcMarket : this.market;
  }

  isFreshQuote(quote, now, field) {
    const value = Number(quote?.[field]);
    return quote?.status === 'LIVE' && Number.isFinite(value) && value > 0 && value < 1 &&
      Number.isFinite(Number(quote.updatedAt)) &&
      now - Number(quote.updatedAt) <= QUOTE_MAX_AGE_MS;
  }

  pairQuote(pair, now) {
    const legs = pair.legs.map(leg => ({
      ...leg,
      quote: this.quoteFor(leg.asset, leg.side),
      market: this.marketFor(leg.asset),
    }));
    const asksFresh = legs.every(leg => this.isFreshQuote(leg.quote, now, 'bestAsk'));
    const bidsFresh = legs.every(leg => this.isFreshQuote(leg.quote, now, 'bestBid'));
    return {
      legs,
      asksFresh,
      bidsFresh,
      askSum: asksFresh ? round(legs.reduce((sum, leg) => sum + Number(leg.quote.bestAsk), 0)) : null,
      bidSum: bidsFresh ? round(legs.reduce((sum, leg) => sum + Number(leg.quote.bestBid), 0)) : null,
    };
  }

  processStrategyEntry(now) {
    const start = this.orderWindowStart;
    if (!this.market || !this.btcMarket || this.market.start !== start ||
        this.btcMarket.start !== start || this.completedWindows.has(start)) return false;
    const elapsed = now - start;
    if (elapsed < 0 || elapsed >= this.windowMs) return false;

    let changed = this.processPairExits(now);
    for (const pair of PAIRS) {
      const pairState = this.pairStates[pair.id];
      if (pairState.activeCycle) continue;
      const marketPair = this.pairQuote(pair, now);
      pairState.lastEntryAskSum = marketPair.askSum;
      if (!marketPair.asksFresh) {
        pairState.status = 'WAITING_FOR_QUOTES';
        pairState.lastReason = 'Waiting for fresh asks on both legs.';
        continue;
      }
      if (marketPair.askSum >= ENTRY_ASK_SUM_MAX) {
        pairState.status = 'ARMED';
        pairState.lastReason = `Combined ask ${marketPair.askSum.toFixed(3)} is not below $${ENTRY_ASK_SUM_MAX.toFixed(2)}.`;
        pairState.lastDepthNotice = null;
        pairState.lastBlockNotice = null;
        continue;
      }
      pairState.status = 'ENTRY_READY';
      pairState.lastReason = `Combined ask ${marketPair.askSum.toFixed(3)} is below $${ENTRY_ASK_SUM_MAX.toFixed(2)}.`;
      if (this.buyPair(pair, pairState, marketPair, now)) changed = true;
    }
    this.lastScanAt = now;
    return changed;
  }

  buyPair(pair, pairState, marketPair, now) {
    const fills = marketPair.legs.map(leg => ({
      ...leg,
      fill: sweepBook(leg.quote.askLevels, SHARES_PER_LEG, 'BUY', MAX_ENTRY_PRICE),
    }));
    for (const leg of fills) {
      leg.fee = feesFor(leg.market, leg.fill.fills);
    }
    const incomplete = fills.filter(leg => leg.fill.filledShares + 1e-9 < SHARES_PER_LEG);
    if (incomplete.length) {
      const depthSummary = fills.map(leg =>
        `${leg.asset} ${leg.side} ${leg.fill.filledShares}/${SHARES_PER_LEG}`).join(', ');
      const reason = `Waiting for a complete pair: visible asks at or below $${MAX_ENTRY_PRICE.toFixed(2)} can fill ${depthSummary}. No shares were booked; retrying.`;
      pairState.status = 'WAITING_FOR_FULL_FILL';
      pairState.lastReason = reason;
      if (pairState.lastDepthNotice !== depthSummary ||
          now - pairState.lastDepthNoticeAt >= 5000) {
        this.log('PAPER_CROSS_PAIR_ENTRY_WAITING_FOR_FULL_FILL', {
          pairId: pair.id,
          pairLabel: pair.label,
          combinedBestAsk: marketPair.askSum,
          maxPricePerShare: MAX_ENTRY_PRICE,
          requestedSharesPerLeg: SHARES_PER_LEG,
          legs: fills.map(leg => ({
            asset: leg.asset,
            side: leg.side,
            requestedShares: SHARES_PER_LEG,
            availableSharesWithinCap: leg.fill.filledShares,
          })),
          message: 'No entry was booked because both legs could not fill completely.',
        });
        pairState.lastDepthNotice = depthSummary;
        pairState.lastDepthNoticeAt = now;
      }
      return false;
    }
    const totalDebit = fills.reduce((sum, leg) => sum + leg.fill.notional + leg.fee, 0);
    if (totalDebit > this.cash + 1e-9) {
      pairState.status = 'BLOCKED_INSUFFICIENT_CASH';
      const reason = `Complete pair needs $${round(totalDebit).toFixed(2)} including fees; available paper cash is $${round(this.cash).toFixed(2)}. No shares were booked.`;
      pairState.lastReason = reason;
      if (pairState.lastBlockNotice !== reason || now - pairState.lastBlockNoticeAt >= 5000) {
        this.log('PAPER_CROSS_PAIR_ENTRY_BLOCKED_CASH', {
          pairId: pair.id,
          pairLabel: pair.label,
          requiredCash: round(totalDebit),
          availableCash: round(this.cash),
          maxPricePerShare: MAX_ENTRY_PRICE,
        });
        pairState.lastBlockNotice = reason;
        pairState.lastBlockNoticeAt = now;
      }
      return false;
    }

    const cycleNumber = pairState.cycleCount + 1;
    const cycleId = `${pair.id}-${this.orderWindowStart}-${cycleNumber}`;
    const cycle = {
      id: cycleId,
      pairId: pair.id,
      pairLabel: pair.label,
      cycleNumber,
      windowStart: this.orderWindowStart,
      status: 'OPEN',
      entryAt: now,
      entryAskSum: marketPair.askSum,
      entryAveragePriceSum: round(fills.reduce((sum, leg) => sum + leg.fill.averagePrice, 0)),
      entryCost: round(fills.reduce((sum, leg) => sum + leg.fill.notional, 0)),
      entryFees: round(fills.reduce((sum, leg) => sum + leg.fee, 0)),
      legPositionIds: [],
      legs: [],
      exitTriggeredAt: null,
      exitBidSum: null,
      realizedPnl: null,
    };

    for (const leg of fills) {
      const orderId = `${cycleId}-${leg.asset.toLowerCase()}-${leg.side.toLowerCase()}-buy`;
      const order = {
        id: orderId,
        pairId: pair.id,
        pairCycleId: cycleId,
        timeframe: this.timeframe,
        windowStart: this.orderWindowStart,
        marketId: leg.market.id,
        marketSlug: leg.market.slug,
        asset: leg.asset,
        tokenId: leg.market.tokens[leg.side],
        side: leg.side,
        action: 'BUY',
        kind: 'PAIR_ENTRY',
        orderType: 'MARKET',
        requestedShares: SHARES_PER_LEG,
        filledShares: SHARES_PER_LEG,
        remainingShares: 0,
        cost: leg.fill.notional,
        fee: leg.fee,
        averagePrice: leg.fill.averagePrice,
        fillEvents: leg.fill.fills.map(fill => ({
          filledAt: now,
          shares: fill.shares,
          price: fill.price,
          cost: fill.value,
          fee: round(takerFeeFor(leg.market, fill.price, fill.shares)),
          source: 'VISIBLE_ASK_DEPTH',
        })),
        cancelledRemainderShares: 0,
        maxPricePerShare: MAX_ENTRY_PRICE,
        createdAt: now,
        submittedAt: now,
        filledAt: now,
        status: 'FILLED',
      };
      const positionId = `${cycleId}-${leg.asset.toLowerCase()}-${leg.side.toLowerCase()}`;
      const position = {
        id: positionId,
        timeframe: this.timeframe,
        windowMs: this.windowMs,
        windowStart: this.orderWindowStart,
        marketId: leg.market.id,
        slug: leg.market.slug,
        title: leg.market.title,
        asset: leg.asset,
        side: leg.side,
        tokenId: leg.market.tokens[leg.side],
        pairId: pair.id,
        pairLabel: pair.label,
        pairCycleId: cycleId,
        pairCycleNumber: cycleNumber,
        pairedWith: `${fills.find(other => other !== leg).asset} ${fills.find(other => other !== leg).side}`,
        entryKey: orderId,
        entryLabel: `${pair.label} · ${leg.asset} ${leg.side}`,
        entryMode: 'CROSS_PAIR_MARKET_BUY',
        entryType: 'MARKET_TAKER_BUY',
        strategyId: this.strategyId,
        strategyName: this.strategyName,
        orderType: 'MARKET',
        fillModel: 'PAPER_VISIBLE_ASK_DEPTH_WITH_MAX_PRICE',
        shares: SHARES_PER_LEG,
        initialShares: SHARES_PER_LEG,
        requestedShares: SHARES_PER_LEG,
        maxEntryPrice: MAX_ENTRY_PRICE,
        avgEntry: leg.fill.averagePrice,
        fillPrice: leg.fill.averagePrice,
        cost: leg.fill.notional,
        totalCost: leg.fill.notional,
        initialTotalCost: leg.fill.notional,
        fees: leg.fee,
        initialFees: leg.fee,
        exitFees: 0,
        exitProceeds: 0,
        estimatedMakerRebate: 0,
        status: 'OPEN',
        submittedAt: now,
        openedAt: now,
        filledAt: now,
        updatedAt: now,
        entryFillEvents: order.fillEvents,
        entryQuotes: this.captureQuotePair(
          now,
          leg.asset === 'BTC' ? this.btcLiveQuotes : this.liveQuotes,
        ),
        entryQuoteAt: now,
        feeContext: feeContext(leg.market),
        markBid: leg.quote.bestBid ?? null,
        markUpdatedAt: leg.quote.updatedAt || now,
        markStatus: 'LIVE',
        maxObservedBidSizeByPrice: {},
      };
      order.positionId = positionId;
      order.positionIds = [positionId];
      leg.positionId = positionId;
      leg.orderId = orderId;
      leg.position = position;
      cycle.legs.push({
        asset: leg.asset, side: leg.side,
        requestedShares: SHARES_PER_LEG, filledShares: SHARES_PER_LEG,
        positionId, orderId,
      });
      this.orders.unshift(order);
      this.windowOrders.unshift(order);
      this.positions.unshift(position);
      this.totalOrderAttempts += 1;
      cycle.legPositionIds.push(positionId);
    }

    this.cash = round(this.cash - totalDebit);
    pairState.cycleCount = cycleNumber;
    pairState.status = 'IN_POSITION';
    pairState.activeCycle = cycle;
    pairState.lastEntryAskSum = marketPair.askSum;
    pairState.lastReason = `Both legs fully filled for ${SHARES_PER_LEG} shares each; waiting for combined best bids of $${EXIT_BID_SUM_MIN.toFixed(2)} or more.`;
    pairState.lastDepthNotice = null;
    pairState.lastBlockNotice = null;
    this.pairCycles.unshift(cycle);
    this.entryOrderPlaced = true;
    this.entryOrderId = this.orders[0]?.id || null;
    this.entryTriggerLatched = true;
    this.entryTriggerAt = now;
    this.entryTriggerSide = pair.id;
    this.entryTriggerReason = `${pair.label} entered at combined ask ${marketPair.askSum.toFixed(3)}.`;
    this.entrySignal = {
      pairId: pair.id,
      pairLabel: pair.label,
      askSum: marketPair.askSum,
      windowStart: this.orderWindowStart,
      triggeredAt: now,
    };
    this.log('PAPER_CROSS_PAIR_ENTRY_FILLED', {
      cycleId,
      pairId: pair.id,
      pairLabel: pair.label,
      sharesPerLeg: SHARES_PER_LEG,
      combinedAsk: marketPair.askSum,
      combinedAverageFillPrice: cycle.entryAveragePriceSum,
      maxPricePerShare: MAX_ENTRY_PRICE,
      entryCost: cycle.entryCost,
      fees: cycle.entryFees,
      legs: fills.map(leg => ({
        asset: leg.asset,
        side: leg.side,
        requestedShares: SHARES_PER_LEG,
        filledShares: SHARES_PER_LEG,
        cancelledRemainderShares: 0,
        averageAsk: leg.fill.averagePrice,
        cost: leg.fill.notional,
        fee: leg.fee,
        orderId: leg.orderId,
        positionId: leg.positionId,
      })),
    });
    return true;
  }

  processPairExits(now) {
    let changed = false;
    for (const pair of PAIRS) {
      const pairState = this.pairStates[pair.id];
      const cycle = pairState.activeCycle;
      if (!cycle) continue;
      const marketPair = this.pairQuote(pair, now);
      pairState.lastExitBidSum = marketPair.bidSum;

      if (!cycle.exitTriggeredAt) {
        if (!marketPair.bidsFresh || marketPair.bidSum < EXIT_BID_SUM_MIN) continue;
        cycle.exitTriggeredAt = now;
        cycle.exitBidSum = marketPair.bidSum;
        cycle.status = 'EXITING';
        pairState.status = 'EXITING';
        pairState.lastReason =
          `Combined best bids reached ${marketPair.bidSum.toFixed(3)}; selling both legs.`;
        for (const positionId of cycle.legPositionIds) {
          const position = this.positions.find(item => item.id === positionId);
          if (!position || position.status !== 'OPEN') continue;
          const order = {
            id: `${cycle.id}-${position.asset.toLowerCase()}-${position.side.toLowerCase()}-sell`,
            pairId: pair.id,
            pairCycleId: cycle.id,
            timeframe: this.timeframe,
            windowStart: cycle.windowStart,
            marketId: position.marketId,
            marketSlug: position.slug,
            asset: position.asset,
            tokenId: position.tokenId,
            side: position.side,
            action: 'SELL',
            kind: 'PAIR_EXIT',
            orderType: 'MARKET',
            requestedShares: position.shares,
            filledShares: 0,
            remainingShares: position.shares,
            proceeds: 0,
            fee: 0,
            fillEvents: [],
            maxObservedBidSizeByPrice: {},
            createdAt: now,
            submittedAt: now,
            status: 'SUBMITTED',
            positionId,
            positionIds: [positionId],
          };
          position.exitOrderId = order.id;
          this.orders.unshift(order);
          this.windowOrders.unshift(order);
          this.totalOrderAttempts += 1;
        }
        this.log('PAPER_CROSS_PAIR_EXIT_TRIGGERED', {
          cycleId: cycle.id,
          pairId: pair.id,
          pairLabel: pair.label,
          combinedBestBid: marketPair.bidSum,
          threshold: EXIT_BID_SUM_MIN,
        });
      }

      const activePositions = cycle.legPositionIds
        .map(id => this.positions.find(position => position.id === id))
        .filter(position => position && position.status === 'OPEN');
      for (const position of activePositions) {
        const quote = this.quoteFor(position.asset, position.side);
        if (!this.isFreshQuote(quote, now, 'bestBid')) continue;
        const order = this.orders.find(item => item.id === position.exitOrderId);
        if (order && this.sellFromVisibleBids(position, order, quote, this.marketFor(position.asset), now)) {
          changed = true;
        }
      }

      const cyclePositions = cycle.legPositionIds
        .map(id => this.positions.find(position => position.id === id))
        .filter(Boolean);
      if (cyclePositions.length > 0 &&
          cyclePositions.every(position => position.status === 'SETTLED_EXIT')) {
        cycle.status = 'SOLD';
        cycle.closedAt = now;
        cycle.realizedPnl = round(cyclePositions.reduce(
          (sum, position) => sum + (Number(position.realizedPnl) || 0), 0,
        ));
        pairState.activeCycle = null;
        pairState.status = 'ARMED';
        pairState.lastReason = 'Both legs sold; this pair is armed for another entry.';
        this.log('PAPER_CROSS_PAIR_CLOSED', {
          cycleId: cycle.id,
          pairId: pair.id,
          realizedPnl: cycle.realizedPnl,
          closedAt: now,
        });
        changed = true;
      }
    }
    return changed;
  }

  sellFromVisibleBids(position, order, quote, market, now) {
    const freshDepth = [];
    for (const level of sortedLevels(quote.bidLevels, 'SELL')) {
      const key = level.price.toFixed(6);
      const previous = Number(order.maxObservedBidSizeByPrice[key] || 0);
      const newlyVisible = Math.max(0, level.size - previous);
      order.maxObservedBidSizeByPrice[key] = Math.max(previous, level.size);
      if (newlyVisible > 0) freshDepth.push({ price: level.price, size: newlyVisible });
    }
    const fill = sweepBook(freshDepth, position.shares, 'SELL');
    if (fill.filledShares <= 1e-9) {
      order.status = order.filledShares > 0 ? 'PARTIALLY_FILLED' : 'PENDING_NEW_BID_DEPTH';
      order.remainingShares = position.shares;
      return false;
    }

    const exitFees = feesFor(market, fill.fills);
    const previousShares = position.shares;
    const fraction = fill.filledShares / previousShares;
    const releasedCost = position.totalCost * fraction;
    const releasedEntryFees = position.fees * fraction;
    position.shares = round(previousShares - fill.filledShares);
    position.totalCost = round(position.totalCost - releasedCost);
    position.cost = position.totalCost;
    position.fees = round(position.fees - releasedEntryFees);
    position.exitProceeds = round((position.exitProceeds || 0) + fill.notional);
    position.exitFees = round((position.exitFees || 0) + exitFees);
    position.realizedPnl = round(
      position.exitProceeds -
      (position.initialTotalCost - position.totalCost) -
      (position.initialFees - position.fees) -
      position.exitFees +
      (position.estimatedMakerRebate || 0),
    );
    position.updatedAt = now;
    position.exitFillEvents = position.exitFillEvents || [];
    position.exitFillEvents.push(...fill.fills.map(item => ({
      filledAt: now,
      shares: item.shares,
      price: item.price,
      proceeds: item.value,
      fee: round(takerFeeFor(market, item.price, item.shares)),
      source: 'VISIBLE_BID_DEPTH',
    })));

    order.filledShares = round(order.filledShares + fill.filledShares);
    order.remainingShares = position.shares;
    order.proceeds = round(order.proceeds + fill.notional);
    order.fee = round(order.fee + exitFees);
    order.averagePrice = round(order.proceeds / order.filledShares);
    order.fillEvents.push(...fill.fills.map(item => ({
      filledAt: now,
      shares: item.shares,
      price: item.price,
      proceeds: item.value,
      fee: round(takerFeeFor(market, item.price, item.shares)),
      source: 'VISIBLE_BID_DEPTH',
    })));
    order.status = position.shares <= 1e-9 ? 'FILLED' : 'PARTIALLY_FILLED';
    order.lastFillAt = now;
    order.lastFillShares = fill.filledShares;

    this.cash = round(this.cash + fill.notional - exitFees);
    if (position.shares <= 1e-9) {
      position.shares = 0;
      position.totalCost = 0;
      position.cost = 0;
      position.fees = 0;
      position.proceeds = position.exitProceeds;
      position.realizedPnl = round(
        position.exitProceeds - position.initialTotalCost - position.initialFees +
        position.estimatedMakerRebate - position.exitFees,
      );
      position.status = 'SETTLED_EXIT';
      position.settlementBasis = 'PAPER_CROSS_PAIR_BID_EXIT';
      position.exitReason = 'CROSS_PAIR_COMBINED_BID_THRESHOLD';
      position.exitType = 'CROSS_PAIR_MARKET_SELL';
      position.exitPrice = position.initialShares
        ? round(position.exitProceeds / position.initialShares)
        : null;
      position.settledAt = now;
      position.markStatus = 'CLOSED';
      this.recordStrategyOutcome(
        position,
        position.realizedPnl > 0 ? 'WIN' : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN',
        now,
        'CROSS_PAIR_BID_EXIT',
      );
    }

    this.log('PAPER_CROSS_PAIR_LEG_SOLD', {
      cycleId: position.pairCycleId,
      pairId: position.pairId,
      positionId: position.id,
      orderId: order.id,
      asset: position.asset,
      side: position.side,
      sharesSold: fill.filledShares,
      averageBid: fill.averagePrice,
      proceeds: fill.notional,
      takerFee: exitFees,
      remainingShares: position.shares,
      orderStatus: order.status,
    });
    return true;
  }

  snapshot() {
    const state = super.snapshot();
    const now = Date.now();
    const elapsedMs = state.window ? now - Number(state.window.start) : null;
    const windowOpen = elapsedMs != null && elapsedMs >= 0 && elapsedMs < this.windowMs;
    const btcPrices = this.captureQuotePair(now, this.btcLiveQuotes);
    const ethPrices = state.livePrices;
    const pairSnapshots = PAIRS.map(pair => {
      const pairState = this.pairStates[pair.id] || emptyPairState(pair);
      const marketPair = this.pairQuote(pair, now);
      const activeCycle = pairState.activeCycle;
      const cyclePositions = activeCycle
        ? activeCycle.legPositionIds
          .map(id => this.positions.find(position => position.id === id))
          .filter(Boolean)
        : [];
      const status = activeCycle
        ? activeCycle.exitTriggeredAt ? 'EXITING' : 'IN POSITION'
        : !windowOpen ? 'WINDOW CLOSED'
          : !marketPair.asksFresh ? 'WAITING FOR QUOTES'
            : marketPair.askSum < ENTRY_ASK_SUM_MAX
              ? pairState.status === 'WAITING_FOR_FULL_FILL' ? 'WAITING FOR FULL FILL'
                : pairState.status === 'BLOCKED_INSUFFICIENT_CASH' ? 'BLOCKED BY CASH' : 'ENTRY READY'
              : 'ARMED';
      const reason = activeCycle
        ? activeCycle.exitTriggeredAt
          ? `Exit triggered at combined bids ${Number(activeCycle.exitBidSum).toFixed(3)}; completing visible-depth sells.`
          : `Both legs fully filled at or below $${MAX_ENTRY_PRICE.toFixed(2)} per share; exit at combined bids of $${EXIT_BID_SUM_MIN.toFixed(2)} or more.`
        : !windowOpen ? 'Waiting for the next aligned 5-minute BTC/ETH window.'
          : !marketPair.asksFresh ? 'Waiting for fresh ask quotes on both legs.'
            : marketPair.askSum < ENTRY_ASK_SUM_MAX
              ? pairState.lastReason || 'Entry threshold met; checking visible ask depth.'
              : `Combined asks ${marketPair.askSum.toFixed(3)}; waiting for a value below $${ENTRY_ASK_SUM_MAX.toFixed(2)}.`;
      return {
        id: pair.id,
        label: pair.label,
        status,
        reason,
        sharesPerLeg: SHARES_PER_LEG,
        entryAskSum: marketPair.askSum,
        exitBidSum: marketPair.bidSum,
        asksFresh: marketPair.asksFresh,
        bidsFresh: marketPair.bidsFresh,
        entryThreshold: ENTRY_ASK_SUM_MAX,
        exitThreshold: EXIT_BID_SUM_MIN,
        maxEntryPricePerShare: MAX_ENTRY_PRICE,
        cycleCount: pairState.cycleCount,
        activeCycle: activeCycle ? {
          id: activeCycle.id,
          cycleNumber: activeCycle.cycleNumber,
          status: activeCycle.status,
          entryAskSum: activeCycle.entryAskSum,
          entryAveragePriceSum: activeCycle.entryAveragePriceSum,
          entryCost: activeCycle.entryCost,
          entryFees: activeCycle.entryFees,
          exitTriggeredAt: activeCycle.exitTriggeredAt,
          exitBidSum: activeCycle.exitBidSum,
          realizedPnl: activeCycle.realizedPnl,
          legs: cyclePositions.map(position => ({
            asset: position.asset,
            side: position.side,
            shares: position.shares,
            averageEntry: position.avgEntry,
            marketId: position.marketId,
            status: position.status,
          })),
        } : null,
      };
    });
    const entryReadyCount = pairSnapshots.filter(pair =>
      ['ENTRY READY', 'WAITING FOR FULL FILL', 'BLOCKED BY CASH'].includes(pair.status)).length;
    const fullFillPendingCount = pairSnapshots.filter(pair =>
      pair.status === 'WAITING FOR FULL FILL').length;
    const signalReason = windowOpen
      ? fullFillPendingCount
        ? `${fullFillPendingCount} pair(s) meet the ask threshold but lack enough visible asks under $${MAX_ENTRY_PRICE.toFixed(2)} to fill both 200-share legs completely; no entry is booked.`
        : entryReadyCount
        ? `${entryReadyCount} cross-pair combination(s) meet the ask threshold; checking for complete fills on both legs.`
        : 'Monitoring both cross-pair combinations for combined asks below $0.90.'
      : 'Waiting for the next aligned BTC and ETH 5-minute window.';
    const strategy = {
      id: this.strategyId,
      name: this.strategyName,
      timeframe: '5m',
      market: 'Polymarket BTC and ETH 5-minute UP/DOWN',
      capital: this.capital,
      execution: 'PAPER ONLY',
      entries: {
        orderType: 'MARKET',
        sharesPerLeg: SHARES_PER_LEG,
        combinedAskMaximum: ENTRY_ASK_SUM_MAX,
        maxPricePerShare: MAX_ENTRY_PRICE,
        pairs: PAIRS.map(pair => ({ id: pair.id, label: pair.label, status:
          pairSnapshots.find(item => item.id === pair.id)?.status || 'ARMED' })),
        trigger: 'Independently buy 200 shares of both legs when that pair’s fresh best asks sum to less than $0.90.',
        fillPolicy: 'Sweep visible asks up to $0.99 per share. Book the paired entry only if all 200 shares on both legs fill; otherwise book zero and retry.',
      },
      exit: {
        orderType: 'MARKET_SELL_ON_COMBINED_BID',
        combinedBestBidMinimum: EXIT_BID_SUM_MIN,
        trigger: 'When the pair’s fresh best bids sum to $1.10 or more, sell both legs using visible bid depth.',
        fillPolicy: 'Sell fills use visible bid depth and modeled taker fees. Partial fills remain pending; the pair cannot rearm until every filled leg is fully sold.',
        windowEnd: 'Any unsold shares wait for confirmed resolution of their exact original BTC or ETH market.',
      },
      timing: 'Monitor both pairings throughout each aligned 5-minute window; no startup wait or entry cutoff.',
      sizing: '200 shares per leg for each qualifying pairing; the two pairings are independent.',
      trigger: 'BTC UP + ETH DOWN and ETH UP + BTC DOWN are monitored independently.',
      executionNote: 'Demo-only simulation; entry asks and exit bids are distinct. Both entry legs must fully sweep visible depth under the $0.99 per-share cap.',
    };
    return {
      ...state,
      strategy,
      btcPrices: {
        marketSlug: this.btcMarket?.slug || null,
        marketId: this.btcMarket?.id || null,
        updatedAt: Math.max(btcPrices.UP.updatedAt || 0, btcPrices.DOWN.updatedAt || 0) || null,
        UP: btcPrices.UP,
        DOWN: btcPrices.DOWN,
      },
      livePrices: ethPrices,
      signal: { pairId: null, reason: signalReason, ready: entryReadyCount > 0 },
      entryWindow: {
        elapsedMs,
        waitMs: 0,
        cutoffMs: this.windowMs,
        waiting: !windowOpen,
        open: windowOpen,
        secondsUntilOpen: 0,
        secondsRemaining: windowOpen ? Math.ceil((this.windowMs - elapsedMs) / 1000) : 0,
      },
      pairStates: pairSnapshots,
      recentPairCycles: this.pairCycles.slice(0, 12).map(cycle => ({
        ...cycle,
        legs: cycle.legPositionIds.map(id => {
          const position = this.positions.find(item => item.id === id);
          return position ? {
            asset: position.asset,
            side: position.side,
            initialShares: position.initialShares,
            averageEntry: position.avgEntry,
            exitPrice: position.exitPrice ?? null,
            status: position.status,
            realizedPnl: position.realizedPnl ?? null,
          } : null;
        }).filter(Boolean),
      })),
      scanner: {
        timeframe: '5m',
        lastScanAt: this.lastScanAt,
        source: 'Polymarket BTC and ETH 5-minute Gamma/CLOB order books',
        marketResolution: 'Unexited legs resolve only against the confirmed result of their exact original BTC or ETH market.',
      },
    };
  }
}

CrossPairBot.constants = { SHARES_PER_LEG, ENTRY_ASK_SUM_MAX, EXIT_BID_SUM_MIN, QUOTE_MAX_AGE_MS, PAIRS };
module.exports = CrossPairBot;
