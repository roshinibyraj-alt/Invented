'use strict';

const cfg = require('./config');
const WickBot = require('./wick-bot');
const marketData = require('./wick-market-data');
const { quoteFromBook, takerFeeFor, feeContext } = WickBot._test;

const ENTRY_TIERS = Object.freeze(cfg.CROSS_PAIR_ENTRY_TIERS.map(tier => Object.freeze({ ...tier })));
const SHARES_PER_FIRE = ENTRY_TIERS[0].sharesPerFire;
const MAX_ENTRY_PRICE = cfg.CROSS_PAIR_MAX_ENTRY_PRICE;
const QUOTE_MAX_AGE_MS = 2000;
const PAIRS = Object.freeze([
  Object.freeze({
    id: 'btc-up-eth-down',
    label: 'BTC UP + ETH DOWN',
    legs: Object.freeze([{ asset: 'BTC', side: 'UP' }, { asset: 'ETH', side: 'DOWN' }]),
  }),
  Object.freeze({
    id: 'eth-up-btc-down',
    label: 'ETH UP + BTC DOWN',
    legs: Object.freeze([{ asset: 'ETH', side: 'UP' }, { asset: 'BTC', side: 'DOWN' }]),
  }),
]);

function round(value) {
  return Number(Number(value).toFixed(6));
}

function emptyInventoryBoxes() {
  return Object.fromEntries(['BTC', 'ETH'].map(asset => [asset, Object.fromEntries(
    ['UP', 'DOWN'].map(side => [side, {
      shares: 0,
      costBasis: 0,
      averageEntry: null,
      positionCount: 0,
      unrealizedPnl: null,
      unpricedPositions: 0,
    }]),
  )]));
}

function aggregateInventory(positions, predicate, includeUnrealized) {
  const boxes = emptyInventoryBoxes();
  const floatingTotals = new Map();
  for (const position of positions) {
    if (!predicate(position)) continue;
    const box = boxes[position.asset]?.[position.side];
    if (!box) continue;
    const shares = Number(position.shares) || 0;
    if (shares <= 0) continue;
    box.shares = round(box.shares + shares);
    const cost = Number(position.totalCost);
    box.costBasis = round(box.costBasis +
      (Number.isFinite(cost) ? cost : (Number(position.avgEntry) || 0) * shares));
    box.positionCount += 1;
    if (!includeUnrealized) continue;
    if (position.unrealizedPnl == null || !Number.isFinite(Number(position.unrealizedPnl))) {
      box.unpricedPositions += 1;
      continue;
    }
    floatingTotals.set(`${position.asset}:${position.side}`,
      (floatingTotals.get(`${position.asset}:${position.side}`) || 0) +
      Number(position.unrealizedPnl));
  }
  for (const asset of ['BTC', 'ETH']) {
    for (const side of ['UP', 'DOWN']) {
      const box = boxes[asset][side];
      box.averageEntry = box.shares ? round(box.costBasis / box.shares) : null;
      if (includeUnrealized) {
        box.unrealizedPnl = box.unpricedPositions
          ? null
          : round(floatingTotals.get(`${asset}:${side}`) || 0);
      }
    }
  }
  return boxes;
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
    cycleIds: [],
    tiers: Object.fromEntries(ENTRY_TIERS.map(tier => [tier.id, {
      id: tier.id,
      label: tier.label,
      threshold: tier.threshold,
      strict: tier.strict,
      sharesPerFire: tier.sharesPerFire,
      status: 'ARMED',
      pausedByPairId: null,
      qualifiedAt: null,
      filledAt: null,
      cycleId: null,
      lastReason: `Waiting for ${pair.label} combined asks to reach ${tier.label}.`,
      lastDepthNotice: null,
      lastDepthNoticeAt: 0,
      lastBlockNotice: null,
      lastBlockNoticeAt: 0,
    }])),
    lastReason: 'Waiting for fresh leader and target asks.',
    lastCombinedAsk: null,
  };
}

class CrossPairBot extends WickBot {
  constructor({ marketData: data = marketData } = {}) {
    super({
      timeframe: '5m',
      windowMs: cfg.WINDOW_MS_5M,
      capital: cfg.DEMO_CAPITAL,
      strategyId: 'btc-eth-cross-pair-arbitrage',
      strategyName: 'BTC/ETH opposite-direction cross-pair entries',
      rules: { sharesPerSide: SHARES_PER_FIRE },
      marketData: data,
    });
    this.crossAssetData = data;
    this.btcMarket = null;
    this.btcLiveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
    this.pairStates = Object.fromEntries(PAIRS.map(pair => [pair.id, emptyPairState(pair)]));
    this.pairCycles = [];
    this.maxObservedAskDepthByToken = new Map();
    this.consumedAskDepthByToken = new Map();
    this.pairTierLocks = {};
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
    this.pairTierLocks = {};
    this.maxObservedAskDepthByToken.clear();
    this.consumedAskDepthByToken.clear();
  }

  async closePreviousWindows(currentStart, now = Date.now()) {
    const closedPositions = await super.closePreviousWindows(currentStart, now);
    for (const cycle of this.pairCycles) {
      if (cycle.status === 'HOLDING_TO_RESOLUTION' &&
          Number(cycle.windowStart) + this.windowMs <= currentStart) {
        cycle.status = 'AWAITING_RESOLUTION';
      }
    }
    return closedPositions;
  }

  finalizeResolution(position, winner, now = Date.now()) {
    const finalized = super.finalizeResolution(position, winner, now);
    if (!finalized || !position.pairCycleId) return finalized;
    const cycle = this.pairCycles.find(item => item.id === position.pairCycleId);
    if (!cycle) return finalized;
    const cyclePositions = cycle.legPositionIds
      .map(id => this.positions.find(item => item.id === id))
      .filter(Boolean);
    if (cyclePositions.length && cyclePositions.every(item => item.status === 'SETTLED_EXIT')) {
      cycle.status = 'RESOLVED';
      cycle.closedAt = now;
      cycle.realizedPnl = round(cyclePositions.reduce(
        (sum, item) => sum + (Number(item.realizedPnl) || 0), 0,
      ));
    } else {
      cycle.status = 'AWAITING_RESOLUTION';
    }
    return finalized;
  }

  quoteFor(asset, side) {
    return asset === 'BTC' ? this.btcLiveQuotes[side] : this.liveQuotes[side];
  }

  availableAskLevels(leg) {
    const tokenId = String(leg.market.tokens[leg.side]);
    if (!this.maxObservedAskDepthByToken.has(tokenId)) {
      this.maxObservedAskDepthByToken.set(tokenId, new Map());
    }
    const maxObserved = this.maxObservedAskDepthByToken.get(tokenId);
    const consumed = this.consumedAskDepthByToken.get(tokenId) || new Map();
    const currentByPrice = new Map();
    for (const level of sortedLevels(leg.quote.askLevels, 'BUY')) {
      const key = level.price.toFixed(6);
      currentByPrice.set(key, (currentByPrice.get(key) || 0) + level.size);
    }
    return [...currentByPrice].map(([key, currentSize]) => {
      const maximum = Math.max(maxObserved.get(key) || 0, currentSize);
      maxObserved.set(key, maximum);
      return {
        price: Number(key),
        size: round(Math.max(0, Math.min(currentSize, maximum - (consumed.get(key) || 0)))),
      };
    }).filter(level => level.size > 1e-9);
  }

  consumeAskDepth(tokenId, fills) {
    const keyToken = String(tokenId);
    if (!this.consumedAskDepthByToken.has(keyToken)) {
      this.consumedAskDepthByToken.set(keyToken, new Map());
    }
    const consumed = this.consumedAskDepthByToken.get(keyToken);
    for (const fill of fills) {
      const key = Number(fill.price).toFixed(6);
      consumed.set(key, round((consumed.get(key) || 0) + fill.shares));
    }
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

  linkQuote(pair, now) {
    const legs = pair.legs.map(definition => ({
      ...definition,
      quote: this.quoteFor(definition.asset, definition.side),
      market: this.marketFor(definition.asset),
    }));
    const quotesFresh = legs.every(leg => leg.market &&
      this.isFreshQuote(leg.quote, now, 'bestAsk'));
    const legAsks = quotesFresh ? legs.map(leg => Number(leg.quote.bestAsk)) : null;
    return {
      legs,
      quotesFresh,
      legAsks,
      combinedAsk: quotesFresh ? legAsks.reduce((sum, ask) => sum + ask, 0) : null,
    };
  }

  processStrategyEntry(now) {
    const start = this.orderWindowStart;
    if (!this.market || !this.btcMarket || this.market.start !== start ||
        this.btcMarket.start !== start || this.completedWindows.has(start)) return false;
    const elapsed = now - start;
    if (elapsed < 0 || elapsed >= this.windowMs) return false;
    let changed = false;
    for (const tier of ENTRY_TIERS) {
      const lockedPairId = this.pairTierLocks[tier.id];
      if (lockedPairId) {
        const pair = PAIRS.find(candidate => candidate.id === lockedPairId);
        if (pair && this.processPairTier(pair, tier, now)) changed = true;
        continue;
      }
      for (const pair of PAIRS) {
        const signal = this.linkQuote(pair, now);
        const pairState = this.pairStates[pair.id];
        const tierState = pairState.tiers[tier.id];
        if (!signal.quotesFresh || tierState.status === 'FILLED') continue;
        tierState.lastCombinedAsk = round(signal.combinedAsk);
        if (!this.tierQualifies(tier, signal.combinedAsk)) continue;

        this.pairTierLocks[tier.id] = pair.id;
        tierState.qualifiedAt = now;
        this.pauseOppositeTier(pair, tier, now);
        this.log('OPPOSITE_RUNG_PAUSED', {
          pairId: pair.id,
          pairLabel: pair.label,
          tierId: tier.id,
          tierLabel: tier.label,
          combinedAsk: round(signal.combinedAsk),
        });
        this.log('PAPER_CROSS_PAIR_TIER_QUALIFIED', {
          pairId: pair.id,
          pairLabel: pair.label,
          tierId: tier.id,
          tierLabel: tier.label,
          legs: pair.legs.map((leg, index) => ({
            asset: leg.asset,
            side: leg.side,
            ask: signal.legAsks[index],
          })),
          combinedAsk: round(signal.combinedAsk),
          sharesPerLeg: tier.sharesPerFire,
        });
        if (this.buySignal(pair, signal, now, tier, tierState)) changed = true;
        break;
      }
    }
    for (const pair of PAIRS) {
      const state = this.pairStates[pair.id];
      const tiers = Object.values(state.tiers);
      const filled = tiers.filter(tier => tier.status === 'FILLED');
      const pending = tiers.filter(tier =>
        ['WAITING_FOR_FULL_FILL', 'BLOCKED_INSUFFICIENT_CASH'].includes(tier.status));
      const signal = this.linkQuote(pair, now);
      if (!signal.quotesFresh) {
        state.status = 'WAITING_FOR_QUOTES';
        state.lastReason = 'Waiting for fresh asks on both pair legs.';
      } else {
        state.status = pending.some(tier => tier.status === 'WAITING_FOR_FULL_FILL')
          ? 'WAITING FOR FULL PAIRED FILL'
          : pending.length ? 'BLOCKED BY CASH'
            : filled.length ? 'HOLDING TO RESOLUTION' : 'ARMED';
        state.lastReason = pending.length
          ? pending.map(tier => tier.lastReason).join(' ')
          : filled.length
            ? `${filled.length} rung(s) filled. Both pair legs are held for exact-market resolution.`
            : `Combined ask ${signal.combinedAsk.toFixed(3)}. Watching the five combined-ask rungs.`;
      }
    }
    this.lastScanAt = now;
    return changed;
  }

  tierQualifies(tier, combinedAsk) {
    return tier.strict ? combinedAsk < tier.threshold : combinedAsk <= tier.threshold;
  }

  pauseOppositeTier(pair, tier, now) {
    const opposite = PAIRS.find(candidate => candidate.id !== pair.id);
    const state = opposite && this.pairStates[opposite.id]?.tiers[tier.id];
    if (!state || state.status === 'FILLED') return;
    state.status = 'PAUSED_BY_OPPOSITE';
    state.pausedByPairId = pair.id;
    state.lastReason = `Paused because ${pair.label} triggered rung ${tier.id} for this window.`;
  }

  processPairTier(pair, tier, now) {
    const state = this.pairStates[pair.id].tiers[tier.id];
    if (state.status === 'FILLED') return false;
    const signal = this.linkQuote(pair, now);
    if (!signal.quotesFresh) {
      state.status = 'WAITING_FOR_QUOTES';
      state.lastReason = 'Waiting for fresh asks on both pair legs.';
      return false;
    }
    state.lastCombinedAsk = round(signal.combinedAsk);
    if (!this.tierQualifies(tier, signal.combinedAsk)) {
      state.status = 'ARMED';
      state.lastReason = `Combined ask ${signal.combinedAsk.toFixed(3)} is above this rung.`;
      return false;
    }
    return this.buySignal(pair, signal, now, tier, state);
  }

  buySignal(pair, signal, now, tier, tierState) {
    const requestedShares = tier.sharesPerFire;
    const executions = signal.legs.map(leg => {
      const fill = sweepBook(
        this.availableAskLevels(leg),
        requestedShares,
        'BUY',
        MAX_ENTRY_PRICE,
      );
      return { ...leg, fill, fee: feesFor(leg.market, fill.fills) };
    });
    const incomplete = executions.find(execution =>
      execution.fill.filledShares + 1e-9 < requestedShares);
    if (incomplete) {
      const available = executions.map(item =>
        `${item.asset} ${item.side}: ${item.fill.filledShares}/${requestedShares}`).join('; ');
      tierState.status = 'WAITING_FOR_FULL_FILL';
      tierState.lastReason = `Waiting for full paired depth (${available}). No leg is booked unless both legs can fill.`;
      if (tierState.lastDepthNotice !== available ||
          now - tierState.lastDepthNoticeAt >= 5000) {
        this.log('PAPER_CROSS_PAIR_WAITING_FOR_FULL_FILL', {
          pairId: pair.id,
          pairLabel: pair.label,
          tierId: tier.id,
          tierLabel: tier.label,
          combinedAsk: round(signal.combinedAsk),
          requestedSharesPerLeg: requestedShares,
          legs: executions.map(item => ({
            asset: item.asset,
            side: item.side,
            availableShares: item.fill.filledShares,
          })),
          message: 'No position was recorded because full visible depth was not available on both legs.',
        });
        tierState.lastDepthNotice = available;
        tierState.lastDepthNoticeAt = now;
      }
      return false;
    }

    const grossCost = executions.reduce((sum, item) => sum + item.fill.notional, 0);
    const totalFees = executions.reduce((sum, item) => sum + item.fee, 0);
    const totalDebit = grossCost + totalFees;
    if (totalDebit > this.cash + 1e-9) {
      tierState.status = 'BLOCKED_INSUFFICIENT_CASH';
      tierState.lastReason = `Both 100-share legs need $${round(totalDebit).toFixed(2)} including fees; paper cash is $${round(this.cash).toFixed(2)}.`;
      this.log('PAPER_CROSS_PAIR_BLOCKED_CASH', {
        pairId: pair.id,
        pairLabel: pair.label,
        tierId: tier.id,
        tierLabel: tier.label,
        requiredCash: round(totalDebit),
        availableCash: round(this.cash),
      });
      return false;
    }

    const pairState = this.pairStates[pair.id];
    const cycleNumber = pairState.cycleCount + 1;
    const cycleId = `${pair.id}-${this.orderWindowStart}-${tier.id}-${cycleNumber}`;
    const created = executions.map((execution, index) => {
      this.consumeAskDepth(execution.market.tokens[execution.side], execution.fill.fills);
      const positionId = `${cycleId}-${execution.asset.toLowerCase()}-${execution.side.toLowerCase()}`;
      const orderId = `${positionId}-buy`;
      const fillEvents = execution.fill.fills.map(level => ({
        filledAt: now,
        shares: level.shares,
        price: level.price,
        cost: level.value,
        fee: round(takerFeeFor(execution.market, level.price, level.shares)),
        source: 'VISIBLE_ASK_DEPTH',
      }));
      const order = {
        id: orderId,
        pairId: pair.id,
        pairCycleId: cycleId,
        timeframe: this.timeframe,
        windowStart: this.orderWindowStart,
        marketId: execution.market.id,
        marketSlug: execution.market.slug,
        asset: execution.asset,
        tokenId: execution.market.tokens[execution.side],
        side: execution.side,
        action: 'BUY',
        kind: 'CROSS_PAIR_MARKET_ENTRY',
        orderType: 'MARKET',
        requestedShares,
        filledShares: requestedShares,
        remainingShares: 0,
        cost: execution.fill.notional,
        fee: execution.fee,
        averagePrice: execution.fill.averagePrice,
        fillEvents,
        cancelledRemainderShares: 0,
        maxPricePerShare: MAX_ENTRY_PRICE,
        createdAt: now,
        submittedAt: now,
        filledAt: now,
        status: 'FILLED',
        positionId,
        positionIds: [positionId],
      };
      const position = {
        id: positionId,
        timeframe: this.timeframe,
        windowMs: this.windowMs,
        windowStart: this.orderWindowStart,
        marketId: execution.market.id,
        slug: execution.market.slug,
        title: execution.market.title,
        asset: execution.asset,
        side: execution.side,
        tokenId: execution.market.tokens[execution.side],
        pairId: pair.id,
        pairLabel: pair.label,
        entryTierId: tier.id,
        entryTierLabel: tier.label,
        combinedAskAtEntry: signal.combinedAsk,
        legAskAtEntry: signal.legAsks[index],
        pairCycleId: cycleId,
        pairCycleNumber: cycleNumber,
        entryKey: orderId,
        entryLabel: `${pair.label} · ${tier.label} · ${execution.asset} ${execution.side}`,
        entryMode: 'OPPOSITE_DIRECTION_CROSS_PAIR',
        entryType: 'MARKET_TAKER_BUY',
        strategyId: this.strategyId,
        strategyName: this.strategyName,
        orderType: 'MARKET',
        fillModel: 'PAPER_VISIBLE_ASK_DEPTH_FULL_PAIRED_FILL',
        shares: requestedShares,
        initialShares: requestedShares,
        requestedShares,
        maxEntryPrice: MAX_ENTRY_PRICE,
        avgEntry: execution.fill.averagePrice,
        fillPrice: execution.fill.averagePrice,
        cost: execution.fill.notional,
        totalCost: execution.fill.notional,
        initialTotalCost: execution.fill.notional,
        fees: execution.fee,
        initialFees: execution.fee,
        exitFees: 0,
        exitProceeds: 0,
        estimatedMakerRebate: 0,
        status: 'OPEN',
        submittedAt: now,
        openedAt: now,
        filledAt: now,
        updatedAt: now,
        entryFillEvents: fillEvents,
        entryQuotes: this.captureQuotePair(
          now,
          execution.asset === 'BTC' ? this.btcLiveQuotes : this.liveQuotes,
        ),
        entryQuoteAt: now,
        feeContext: feeContext(execution.market),
        markBid: execution.quote.bestBid ?? null,
        markUpdatedAt: execution.quote.updatedAt || now,
        markStatus: 'LIVE',
        maxObservedBidSizeByPrice: {},
      };
      this.orders.unshift(order);
      this.windowOrders.unshift(order);
      this.positions.unshift(position);
      this.totalOrderAttempts += 1;
      return { order, position, execution };
    });

    this.cash = round(this.cash - totalDebit);
    const positionIds = created.map(item => item.position.id);
    const cycle = {
      id: cycleId,
      pairId: pair.id,
      pairLabel: pair.label,
      entryTierId: tier.id,
      entryTierLabel: tier.label,
      combinedAsk: round(signal.combinedAsk),
      legAsks: signal.legAsks,
      sharesPerFire: requestedShares,
      cycleNumber,
      windowStart: this.orderWindowStart,
      status: 'HOLDING_TO_RESOLUTION',
      entryAt: now,
      entryCost: round(grossCost),
      entryFees: round(totalFees),
      legPositionIds: positionIds,
      legs: created.map(item => ({
        asset: item.execution.asset,
        side: item.execution.side,
        requestedShares,
        filledShares: requestedShares,
        positionId: item.position.id,
        orderId: item.order.id,
        averagePrice: item.execution.fill.averagePrice,
        cost: round(item.execution.fill.notional),
        fees: item.execution.fee,
      })),
      realizedPnl: null,
    };
    pairState.cycleCount = cycleNumber;
    pairState.cycleIds.push(cycleId);
    pairState.lastReason = `Bought ${requestedShares} shares on both legs; holding for exact-market resolution.`;
    tierState.status = 'FILLED';
    tierState.filledAt = now;
    tierState.cycleId = cycleId;
    tierState.lastReason = `Filled both ${requestedShares}-share legs at combined asks ${signal.combinedAsk.toFixed(3)}; holding to resolution.`;
    this.pairCycles.unshift(cycle);
    this.entryOrderPlaced = true;
    this.entryOrderId = created[0].order.id;
    this.entryTriggerLatched = true;
    this.entryTriggerAt = now;
    this.entryTriggerSide = pair.label;
    this.entryTriggerReason = `${pair.label} · ${tier.label}; bought both legs.`;
    this.entrySignal = {
      pairId: pair.id,
      pairLabel: pair.label,
      tierId: tier.id,
      tierLabel: tier.label,
      combinedAsk: round(signal.combinedAsk),
      legs: pair.legs.map((leg, index) => ({
        ...leg,
        ask: signal.legAsks[index],
      })),
      windowStart: this.orderWindowStart,
      triggeredAt: now,
    };
    this.log('PAPER_CROSS_PAIR_ENTRY_FILLED', {
      cycleId,
      pairId: pair.id,
      pairLabel: pair.label,
      tierId: tier.id,
      tierLabel: tier.label,
      combinedAsk: round(signal.combinedAsk),
      sharesPerLeg: requestedShares,
      legs: cycle.legs.map(({ orderId, positionId, ...leg }) => leg),
      combinedFillCost: round(grossCost),
      fees: round(totalFees),
      orderIds: created.map(item => item.order.id),
      positionIds,
    });
    return true;
  }

  snapshot() {
    const state = super.snapshot();
    const now = Date.now();
    const elapsedMs = state.window ? now - Number(state.window.start) : null;
    const windowOpen = elapsedMs != null && elapsedMs >= 0 && elapsedMs < this.windowMs;
    const entryOpen = windowOpen;
    const btcPrices = this.captureQuotePair(now, this.btcLiveQuotes);
    const ethPrices = state.livePrices;
    const positionBuckets = {
      currentWindow: aggregateInventory(this.positions, position =>
        position.status === 'OPEN' && Number(position.windowStart) === Number(state.window?.start), true),
      awaitingResolution: aggregateInventory(this.positions,
        position => position.status === 'PENDING_RESOLUTION', false),
    };
    const pairSnapshots = PAIRS.map(pair => {
      const pairState = this.pairStates[pair.id] || emptyPairState(pair);
      const signal = this.linkQuote(pair, now);
      const tiers = ENTRY_TIERS.map(tier => {
        const tierState = pairState.tiers[tier.id];
        const cycle = tierState.cycleId
          ? this.pairCycles.find(item => item.id === tierState.cycleId)
          : null;
        return {
          ...tierState,
          cycleStatus: cycle?.status || null,
        };
      });
      const activeCycles = pairState.cycleIds
        .map(id => this.pairCycles.find(cycle => cycle.id === id))
        .filter(Boolean);
      const pendingTiers = tiers.filter(tier =>
        ['WAITING_FOR_FULL_FILL', 'BLOCKED_INSUFFICIENT_CASH'].includes(tier.status));
      const filledTiers = tiers.filter(tier => tier.status === 'FILLED');
      const status = !windowOpen ? 'WINDOW CLOSED'
        : !signal.quotesFresh ? 'WAITING FOR QUOTES'
          : pendingTiers.some(tier => tier.status === 'WAITING_FOR_FULL_FILL') ? 'WAITING FOR FULL PAIRED FILL'
            : pendingTiers.length ? 'BLOCKED BY CASH'
              : filledTiers.length ? 'HOLDING TO RESOLUTION'
                : tiers.every(tier => tier.status === 'PAUSED_BY_OPPOSITE')
                  ? 'PAUSED BY OPPOSITE'
                  : 'ARMED';
      const reason = !windowOpen ? 'Waiting for the next aligned 5-minute BTC/ETH window.'
        : !signal.quotesFresh ? 'Waiting for fresh asks on both pair legs.'
          : pendingTiers.length ? pendingTiers.map(tier => tier.lastReason).join(' ')
            : filledTiers.length
              ? `${filledTiers.length} rung(s) filled. Both legs are held for exact-market resolution.`
              : `Combined ask ${signal.combinedAsk?.toFixed(3) ?? '—'}. Watching five combined-ask rungs.`;
      const currentWindowPositions = this.positions.filter(position =>
        position.pairId === pair.id && position.windowStart === this.orderWindowStart &&
        ['OPEN', 'PENDING_RESOLUTION'].includes(position.status));
      return {
        id: pair.id,
        label: pair.label,
        legs: pair.legs,
        status,
        reason,
        sharesPerFire: SHARES_PER_FIRE,
        legAsks: signal.legAsks,
        combinedAsk: round(signal.combinedAsk),
        quotesFresh: signal.quotesFresh,
        maxEntryPricePerShare: MAX_ENTRY_PRICE,
        cycleCount: pairState.cycleCount,
        tiers,
        activeCycles: activeCycles.map(cycle => ({
          id: cycle.id,
          cycleNumber: cycle.cycleNumber,
          tierId: cycle.entryTierId,
          tierLabel: cycle.entryTierLabel,
          combinedAsk: cycle.combinedAsk,
          legAsks: cycle.legAsks,
          sharesPerFire: cycle.sharesPerFire,
          status: cycle.status,
          entryAveragePrice: cycle.entryAveragePrice,
          entryCost: cycle.entryCost,
          entryFees: cycle.entryFees,
          legs: cycle.legPositionIds.map(id => this.positions.find(position => position.id === id))
            .filter(Boolean).map(position => ({
              asset: position.asset,
              side: position.side,
              shares: position.shares,
              averageEntry: position.avgEntry,
              marketId: position.marketId,
              status: position.status,
            })),
        })),
        heldSharesByLeg: currentWindowPositions.reduce((result, position) => {
          const key = `${position.asset} ${position.side}`;
          result[key] = round((result[key] || 0) + position.shares);
          return result;
        }, {}),
      };
    });
    const pendingTierCount = pairSnapshots.reduce((count, pair) =>
      count + pair.tiers.filter(tier =>
        tier.qualifiedAt != null && tier.status !== 'FILLED' && tier.status !== 'CUTOFF_REACHED').length, 0);
    const fullFillPendingCount = pairSnapshots.reduce((count, pair) =>
      count + pair.tiers.filter(tier => tier.status === 'WAITING_FOR_FULL_FILL').length, 0);
    const filledTierCount = pairSnapshots.reduce((count, pair) =>
      count + pair.tiers.filter(tier => tier.status === 'FILLED').length, 0);
    const signalReason = windowOpen
      ? fullFillPendingCount
        ? `${fullFillPendingCount} triggered rung(s) are waiting for full 100-share depth on both legs; no partial pair is recorded.`
        : pendingTierCount
          ? `${pendingTierCount} triggered rung(s) are blocked by insufficient paper cash.`
          : filledTierCount
            ? `${filledTierCount} pair/rung entries filled; both legs are held for official resolution.`
            : 'Monitoring BTC UP + ETH DOWN and ETH UP + BTC DOWN combined asks across five rungs.'
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
        tiers: ENTRY_TIERS.map(tier => ({
          id: tier.id,
          label: tier.label,
          threshold: tier.threshold,
          strict: tier.strict,
          sharesPerLeg: tier.sharesPerFire,
        })),
        maxPricePerShare: MAX_ENTRY_PRICE,
        routes: PAIRS.map(pair => ({ id: pair.id, label: pair.label, status:
          pairSnapshots.find(item => item.id === pair.id)?.status || 'ARMED' })),
        trigger: 'Buy 100 BTC UP + ETH DOWN or ETH UP + BTC DOWN shares per leg when the combined asks reach a configured rung.',
        fillPolicy: 'Each pair/rung can fill once per 5-minute window. Sweep visible asks up to $0.99 per leg and book only when both 100-share fills are complete.',
        oppositePairRule: 'The first pair to trigger a rung pauses the opposite pair on that rung for the rest of the window; other rungs remain independent.',
      },
      settlement: {
        intraWindowSells: false,
        resolutionPollIntervalMs: cfg.RESOLUTION_POLL_MS,
        windowEnd: 'All filled shares wait for confirmed resolution of their exact original BTC or ETH market.',
      },
      timing: 'Monitor aligned 5-minute BTC/ETH markets for the full window.',
      sizing: 'Each qualifying pair/rung buys 100 shares on both legs.',
      trigger: 'Compare BTC UP + ETH DOWN and ETH UP + BTC DOWN combined asks.',
      executionNote: 'Demo-only simulation. No positions are sold during the window; all filled shares are held for exact-market resolution.',
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
      signal: { pairId: null, reason: signalReason, ready: pendingTierCount > 0 || filledTierCount > 0 },
      entryWindow: {
        elapsedMs,
        waitMs: 0,
        waiting: elapsedMs == null || elapsedMs < 0,
        open: entryOpen,
        windowOpen,
        cutoffReached: false,
        secondsUntilOpen: 0,
        secondsRemaining: entryOpen ? Math.ceil((this.windowMs - elapsedMs) / 1000) : 0,
        secondsToWindowEnd: windowOpen ? Math.ceil((this.windowMs - elapsedMs) / 1000) : 0,
      },
      pairStates: pairSnapshots,
      positionBuckets,
      recentEntryFires: this.pairCycles.slice(0, 20).map(cycle => ({
        ...cycle,
        legs: cycle.legPositionIds.map(id => {
          const position = this.positions.find(item => item.id === id);
          return position ? {
            asset: position.asset,
            side: position.side,
            initialShares: position.initialShares,
            averageEntry: position.avgEntry,
            status: position.status,
            realizedPnl: position.realizedPnl ?? null,
          } : null;
        }).filter(Boolean),
      })),
      scanner: {
        timeframe: '5m',
        lastScanAt: this.lastScanAt,
        source: 'Polymarket BTC and ETH 5-minute Gamma/CLOB order books',
        marketResolution: 'Unexited shares resolve only against the confirmed result of their exact original BTC or ETH market.',
        resolutionPollIntervalMs: cfg.RESOLUTION_POLL_MS,
      },
    };
  }
}

CrossPairBot.constants = {
  SHARES_PER_FIRE,
  ENTRY_TIERS,
  QUOTE_MAX_AGE_MS,
  PAIRS,
};
module.exports = CrossPairBot;
