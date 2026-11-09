'use strict';

const cfg = require('./config');
const WickBot = require('./wick-bot');
const marketData = require('./wick-market-data');
const { quoteFromBook, takerFeeFor, feeContext } = WickBot._test;

const ENTRY_TIERS = Object.freeze(cfg.CROSS_PAIR_ENTRY_TIERS.map(tier => Object.freeze({ ...tier })));
const SHARES_PER_FIRE = ENTRY_TIERS[0].sharesPerFire;
const MAX_ENTRY_PRICE = cfg.CROSS_PAIR_MAX_ENTRY_PRICE;
const MIN_ENTRY_PRICE = cfg.CROSS_PAIR_MIN_ENTRY_PRICE;
const ENTRY_CUTOFF_MS = cfg.CROSS_PAIR_ENTRY_CUTOFF_MS;
const QUOTE_MAX_AGE_MS = 2000;
const PAIRS = Object.freeze([
  Object.freeze({
    id: 'btc-up-leads-eth-up',
    label: 'BTC UP leads → buy ETH UP',
    leaderAsset: 'BTC',
    leaderSide: 'UP',
    targetAsset: 'ETH',
    targetSide: 'UP',
  }),
  Object.freeze({
    id: 'eth-up-leads-btc-up',
    label: 'ETH UP leads → buy BTC UP',
    leaderAsset: 'ETH',
    leaderSide: 'UP',
    targetAsset: 'BTC',
    targetSide: 'UP',
  }),
  Object.freeze({
    id: 'btc-down-leads-eth-down',
    label: 'BTC DOWN leads → buy ETH DOWN',
    leaderAsset: 'BTC',
    leaderSide: 'DOWN',
    targetAsset: 'ETH',
    targetSide: 'DOWN',
  }),
  Object.freeze({
    id: 'eth-down-leads-btc-down',
    label: 'ETH DOWN leads → buy BTC DOWN',
    leaderAsset: 'ETH',
    leaderSide: 'DOWN',
    targetAsset: 'BTC',
    targetSide: 'DOWN',
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
    leaderAsset: pair.leaderAsset,
    leaderSide: pair.leaderSide,
    targetAsset: pair.targetAsset,
    targetSide: pair.targetSide,
    cycleCount: 0,
    status: 'ARMED',
    cycleIds: [],
    tiers: Object.fromEntries(ENTRY_TIERS.map(tier => [tier.id, {
      id: tier.id,
      label: tier.label,
      leaderMinPrice: tier.leaderMinPrice,
      targetMaxPriceExclusive: tier.targetMaxPriceExclusive,
      minEntryPrice: MIN_ENTRY_PRICE,
      sharesPerFire: tier.sharesPerFire,
      status: 'ARMED',
      qualifiedAt: null,
      filledAt: null,
      cycleId: null,
      lastReason: `Waiting for ${pair.leaderAsset} ${pair.leaderSide} ≥ $${tier.leaderMinPrice.toFixed(2)} and ${pair.targetAsset} ${pair.targetSide} at $${MIN_ENTRY_PRICE.toFixed(2)}–below $${tier.targetMaxPriceExclusive.toFixed(2)}.`,
      lastDepthNotice: null,
      lastDepthNoticeAt: 0,
      lastBlockNotice: null,
      lastBlockNoticeAt: 0,
    }])),
    lastReason: 'Waiting for fresh leader and target asks.',
    lastLeaderPrice: null,
    lastTargetAsk: null,
  };
}

class CrossPairBot extends WickBot {
  constructor({ marketData: data = marketData } = {}) {
    super({
      timeframe: '5m',
      windowMs: cfg.WINDOW_MS_5M,
      capital: cfg.DEMO_CAPITAL,
      strategyId: 'btc-eth-cross-pair-arbitrage',
      strategyName: 'BTC/ETH same-direction lagging-price entries',
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
    const leader = {
      asset: pair.leaderAsset,
      side: pair.leaderSide,
      quote: this.quoteFor(pair.leaderAsset, pair.leaderSide),
      market: this.marketFor(pair.leaderAsset),
    };
    const target = {
      asset: pair.targetAsset,
      side: pair.targetSide,
      quote: this.quoteFor(pair.targetAsset, pair.targetSide),
      market: this.marketFor(pair.targetAsset),
    };
    const quotesFresh = this.isFreshQuote(leader.quote, now, 'bestAsk') &&
      this.isFreshQuote(target.quote, now, 'bestAsk');
    return {
      leader,
      target,
      quotesFresh,
      leaderPrice: quotesFresh ? Number(leader.quote.bestAsk) : null,
      targetAsk: quotesFresh ? Number(target.quote.bestAsk) : null,
    };
  }

  processStrategyEntry(now) {
    const start = this.orderWindowStart;
    if (!this.market || !this.btcMarket || this.market.start !== start ||
        this.btcMarket.start !== start || this.completedWindows.has(start)) return false;
    const elapsed = now - start;
    if (elapsed < 0 || elapsed >= this.windowMs) return false;
    if (elapsed >= ENTRY_CUTOFF_MS) {
      for (const pair of PAIRS) {
        const pairState = this.pairStates[pair.id];
        pairState.status = 'ENTRY CUTOFF REACHED';
        pairState.lastReason = `The ${Math.round(ENTRY_CUTOFF_MS / 1000)}-second entry cutoff has passed.`;
        for (const tierState of Object.values(pairState.tiers)) {
          if (tierState.status === 'FILLED') continue;
          tierState.status = 'CUTOFF_REACHED';
          tierState.lastReason = 'No new entries are allowed after the 270-second cutoff.';
        }
      }
      this.lastScanAt = now;
      return false;
    }

    let changed = false;
    for (const pair of PAIRS) {
      const pairState = this.pairStates[pair.id];
      const signal = this.linkQuote(pair, now);
      pairState.lastLeaderPrice = signal.leaderPrice;
      pairState.lastTargetAsk = signal.targetAsk;
      pairState.quotesFresh = signal.quotesFresh;
      if (!signal.quotesFresh) {
        pairState.status = 'WAITING_FOR_QUOTES';
        pairState.lastReason = 'Waiting for fresh asks on the leader and target outcomes.';
        continue;
      }
      for (const tier of ENTRY_TIERS) {
        const tierState = pairState.tiers[tier.id];
        const qualified = signal.leaderPrice >= tier.leaderMinPrice &&
          signal.targetAsk >= MIN_ENTRY_PRICE &&
          signal.targetAsk < tier.targetMaxPriceExclusive;
        if (qualified && tierState.status !== 'FILLED') {
          const firstQualification = tierState.qualifiedAt == null;
          if (firstQualification) {
          tierState.qualifiedAt = now;
            tierState.lastReason = `${pair.leaderAsset} ${pair.leaderSide} at ${signal.leaderPrice.toFixed(3)}; ${pair.targetAsset} ${pair.targetSide} at ${signal.targetAsk.toFixed(3)}.`;
            this.log('PAPER_LAGGING_ENTRY_TIER_QUALIFIED', {
            pairId: pair.id,
            pairLabel: pair.label,
            tierId: tier.id,
            tierLabel: tier.label,
              leaderAsset: pair.leaderAsset,
              leaderSide: pair.leaderSide,
              leaderPrice: signal.leaderPrice,
              targetAsset: pair.targetAsset,
              targetSide: pair.targetSide,
              targetAsk: signal.targetAsk,
              sharesPerFire: tier.sharesPerFire,
          });
          }
          tierState.status = 'ENTRY_READY';
          if (this.buySignal(pair, pairState, signal, now, tier, tierState)) changed = true;
        } else if (tierState.status !== 'FILLED') {
          if (tierState.qualifiedAt != null) {
            tierState.qualifiedAt = null;
            tierState.status = 'ARMED';
          }
          tierState.lastReason = signal.targetAsk < MIN_ENTRY_PRICE
            ? `${pair.targetAsset} ${pair.targetSide} is below the $${MIN_ENTRY_PRICE.toFixed(2)} minimum entry price.`
            : `Waiting for leader ≥ $${tier.leaderMinPrice.toFixed(2)} and target ask ≥ $${MIN_ENTRY_PRICE.toFixed(2)} but < $${tier.targetMaxPriceExclusive.toFixed(2)}.`;
        }
      }
      const tiers = Object.values(pairState.tiers);
      const pending = tiers.filter(tier => tier.qualifiedAt != null && tier.status !== 'FILLED');
      const filled = tiers.filter(tier => tier.status === 'FILLED');
      pairState.status = pending.some(tier => tier.status === 'WAITING_FOR_FULL_FILL')
        ? 'WAITING FOR FULL FILL'
        : pending.some(tier => tier.status === 'BLOCKED_INSUFFICIENT_CASH')
          ? 'BLOCKED BY CASH'
          : pending.length
            ? 'ENTRY READY'
            : filled.length
              ? 'HOLDING TO RESOLUTION'
              : 'ARMED';
      pairState.lastReason = pending.length
        ? pending.map(tier => tier.lastReason).join(' ')
        : filled.length
          ? `${filled.length} tier(s) filled. Holding target shares for exact-market resolution.`
          : signal.targetAsk < MIN_ENTRY_PRICE
            ? `${pair.targetAsset} ${pair.targetSide} ask ${signal.targetAsk.toFixed(3)} is below the $${MIN_ENTRY_PRICE.toFixed(2)} entry floor.`
            : `${pair.leaderAsset} ${pair.leaderSide} ask ${signal.leaderPrice.toFixed(3)}; ${pair.targetAsset} ${pair.targetSide} ask ${signal.targetAsk.toFixed(3)}. Watching leader/laggard tiers.`;
    }
    this.lastScanAt = now;
    return changed;
  }

  buySignal(pair, pairState, signal, now, tier, tierState) {
    const target = signal.target;
    const requestedShares = tier.sharesPerFire;
    const maxTargetFillPrice = Math.min(
      MAX_ENTRY_PRICE,
      tier.targetMaxPriceExclusive - 1e-6,
    );
    const fill = sweepBook(
      this.availableAskLevels(target),
      requestedShares,
      'BUY',
      maxTargetFillPrice,
    );
    const fee = feesFor(target.market, fill.fills);
    if (fill.filledShares + 1e-9 < requestedShares) {
      const reason = `${pair.label} · ${tier.label}: visible asks under $${tier.targetMaxPriceExclusive.toFixed(2)} can fill ${fill.filledShares}/${requestedShares} shares. No shares booked; retrying only while the signal remains valid.`;
      tierState.status = 'WAITING_FOR_FULL_FILL';
      tierState.lastReason = reason;
      if (tierState.lastDepthNotice !== `${fill.filledShares}/${requestedShares}` ||
          now - tierState.lastDepthNoticeAt >= 5000) {
        this.log('PAPER_LAGGING_ENTRY_WAITING_FOR_FULL_FILL', {
          pairId: pair.id,
          pairLabel: pair.label,
          tierId: tier.id,
          tierLabel: tier.label,
          leaderPrice: signal.leaderPrice,
          targetAsk: signal.targetAsk,
          targetAsset: target.asset,
          targetSide: target.side,
          requestedShares,
          availableSharesWithinCap: fill.filledShares,
          maxPricePerShare: maxTargetFillPrice,
          message: 'No position was booked because the full 100-share target entry was not available within its tier price cap.',
        });
        tierState.lastDepthNotice = `${fill.filledShares}/${requestedShares}`;
        tierState.lastDepthNoticeAt = now;
      }
      return false;
    }

    const totalDebit = fill.notional + fee;
    if (totalDebit > this.cash + 1e-9) {
      tierState.status = 'BLOCKED_INSUFFICIENT_CASH';
      const reason = `${tier.label}: 100-share target entry needs $${round(totalDebit).toFixed(2)} including fees; paper cash is $${round(this.cash).toFixed(2)}.`;
      tierState.lastReason = reason;
      if (tierState.lastBlockNotice !== reason ||
          now - tierState.lastBlockNoticeAt >= 5000) {
        this.log('PAPER_LAGGING_ENTRY_BLOCKED_CASH', {
          pairId: pair.id,
          pairLabel: pair.label,
          tierId: tier.id,
          tierLabel: tier.label,
          requiredCash: round(totalDebit),
          availableCash: round(this.cash),
          requestedShares,
          maxPricePerShare: maxTargetFillPrice,
        });
        tierState.lastBlockNotice = reason;
        tierState.lastBlockNoticeAt = now;
      }
      return false;
    }

    this.consumeAskDepth(target.market.tokens[target.side], fill.fills);
    const cycleNumber = pairState.cycleCount + 1;
    const cycleId = `${pair.id}-${this.orderWindowStart}-${tier.id}-${cycleNumber}`;
    const orderId = `${cycleId}-${target.asset.toLowerCase()}-${target.side.toLowerCase()}-buy`;
    const positionId = `${cycleId}-${target.asset.toLowerCase()}-${target.side.toLowerCase()}`;
    const fillEvents = fill.fills.map(level => ({
      filledAt: now,
      shares: level.shares,
      price: level.price,
      cost: level.value,
      fee: round(takerFeeFor(target.market, level.price, level.shares)),
      source: 'VISIBLE_ASK_DEPTH',
    }));
    const order = {
      id: orderId,
      pairId: pair.id,
      pairCycleId: cycleId,
      timeframe: this.timeframe,
      windowStart: this.orderWindowStart,
      marketId: target.market.id,
      marketSlug: target.market.slug,
      asset: target.asset,
      tokenId: target.market.tokens[target.side],
      side: target.side,
      action: 'BUY',
      kind: 'SAME_DIRECTION_LAGGING_ENTRY',
      orderType: 'MARKET',
      requestedShares,
      filledShares: requestedShares,
      remainingShares: 0,
      cost: fill.notional,
      fee,
      averagePrice: fill.averagePrice,
      fillEvents,
      cancelledRemainderShares: 0,
      maxPricePerShare: maxTargetFillPrice,
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
      marketId: target.market.id,
      slug: target.market.slug,
      title: target.market.title,
      asset: target.asset,
      side: target.side,
      tokenId: target.market.tokens[target.side],
      pairId: pair.id,
      pairLabel: pair.label,
      entryTierId: tier.id,
      entryTierLabel: tier.label,
      entryThreshold: tier.leaderMinPrice,
      leaderAsset: pair.leaderAsset,
      leaderSide: pair.leaderSide,
      leaderPriceAtEntry: signal.leaderPrice,
      targetPriceAtEntry: signal.targetAsk,
      targetMaxPriceExclusive: tier.targetMaxPriceExclusive,
      pairCycleId: cycleId,
      pairCycleNumber: cycleNumber,
      entryKey: orderId,
      entryLabel: `${pair.label} · ${tier.label} · ${target.asset} ${target.side}`,
      entryMode: 'SAME_DIRECTION_LAGGING_MARKET_BUY',
      entryType: 'MARKET_TAKER_BUY',
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      orderType: 'MARKET',
      fillModel: 'PAPER_VISIBLE_ASK_DEPTH_WITH_TIER_PRICE_CAP',
      shares: requestedShares,
      initialShares: requestedShares,
      requestedShares,
      maxEntryPrice: maxTargetFillPrice,
      avgEntry: fill.averagePrice,
      fillPrice: fill.averagePrice,
      cost: fill.notional,
      totalCost: fill.notional,
      initialTotalCost: fill.notional,
      fees: fee,
      initialFees: fee,
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
        target.asset === 'BTC' ? this.btcLiveQuotes : this.liveQuotes,
      ),
      entryQuoteAt: now,
      feeContext: feeContext(target.market),
      markBid: target.quote.bestBid ?? null,
      markUpdatedAt: target.quote.updatedAt || now,
      markStatus: 'LIVE',
      maxObservedBidSizeByPrice: {},
    };
    const cycle = {
      id: cycleId,
      pairId: pair.id,
      pairLabel: pair.label,
      entryTierId: tier.id,
      entryTierLabel: tier.label,
      entryThreshold: tier.leaderMinPrice,
      leaderAsset: pair.leaderAsset,
      leaderSide: pair.leaderSide,
      leaderPrice: signal.leaderPrice,
      targetAsset: target.asset,
      targetSide: target.side,
      targetAsk: signal.targetAsk,
      sharesPerFire: requestedShares,
      cycleNumber,
      windowStart: this.orderWindowStart,
      status: 'HOLDING_TO_RESOLUTION',
      entryAt: now,
      entryAveragePrice: fill.averagePrice,
      entryCost: fill.notional,
      entryFees: fee,
      legPositionIds: [positionId],
      legs: [{
        asset: target.asset,
        side: target.side,
        requestedShares,
        filledShares: requestedShares,
        positionId,
        orderId,
      }],
      realizedPnl: null,
    };

    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.positions.unshift(position);
    this.totalOrderAttempts += 1;
    this.cash = round(this.cash - totalDebit);
    pairState.cycleCount = cycleNumber;
    pairState.cycleIds.push(cycleId);
    pairState.lastReason = `Bought ${requestedShares} ${target.asset} ${target.side} shares; holding for exact-market resolution.`;
    tierState.status = 'FILLED';
    tierState.filledAt = now;
    tierState.cycleId = cycleId;
    tierState.lastReason = `Filled ${requestedShares} target shares at ${fill.averagePrice.toFixed(3)} average; holding for resolution.`;
    this.pairCycles.unshift(cycle);
    this.entryOrderPlaced = true;
    this.entryOrderId = order.id;
    this.entryTriggerLatched = true;
    this.entryTriggerAt = now;
    this.entryTriggerSide = `${target.asset} ${target.side}`;
    this.entryTriggerReason = `${pair.label} · ${tier.label}; bought ${requestedShares} ${target.asset} ${target.side}.`;
    this.entrySignal = {
      pairId: pair.id,
      pairLabel: pair.label,
      tierId: tier.id,
      tierLabel: tier.label,
      leaderAsset: pair.leaderAsset,
      leaderSide: pair.leaderSide,
      leaderPrice: signal.leaderPrice,
      targetAsset: target.asset,
      targetSide: target.side,
      targetAsk: signal.targetAsk,
      windowStart: this.orderWindowStart,
      triggeredAt: now,
    };
    this.log('PAPER_LAGGING_ENTRY_FILLED', {
      cycleId,
      pairId: pair.id,
      pairLabel: pair.label,
      tierId: tier.id,
      tierLabel: tier.label,
      leaderAsset: pair.leaderAsset,
      leaderSide: pair.leaderSide,
      leaderPrice: signal.leaderPrice,
      targetAsset: target.asset,
      targetSide: target.side,
      targetAsk: signal.targetAsk,
      requestedShares,
      filledShares: requestedShares,
      averageFillPrice: fill.averagePrice,
      maxPricePerShare: maxTargetFillPrice,
      entryCost: fill.notional,
      fees: fee,
      orderId,
      positionId,
    });
    return true;
  }

  snapshot() {
    const state = super.snapshot();
    const now = Date.now();
    const elapsedMs = state.window ? now - Number(state.window.start) : null;
    const windowOpen = elapsedMs != null && elapsedMs >= 0 && elapsedMs < this.windowMs;
    const entryOpen = windowOpen && elapsedMs < ENTRY_CUTOFF_MS;
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
        tier.qualifiedAt != null && tier.status !== 'FILLED' && tier.status !== 'CUTOFF_REACHED');
      const filledTiers = tiers.filter(tier => tier.status === 'FILLED');
      const status = !windowOpen ? 'WINDOW CLOSED'
        : !entryOpen ? 'ENTRY CUTOFF REACHED'
          : !signal.quotesFresh ? 'WAITING FOR QUOTES'
          : pendingTiers.some(tier => tier.status === 'WAITING_FOR_FULL_FILL') ? 'WAITING FOR FULL FILL'
            : pendingTiers.some(tier => tier.status === 'BLOCKED_INSUFFICIENT_CASH') ? 'BLOCKED BY CASH'
              : pendingTiers.length ? 'ENTRY READY'
                : filledTiers.length ? 'HOLDING TO RESOLUTION'
                  : 'ARMED';
      const reason = !windowOpen ? 'Waiting for the next aligned 5-minute BTC/ETH window.'
        : !entryOpen ? 'The 270-second entry cutoff has passed; no new buys will be placed this window.'
          : !signal.quotesFresh ? 'Waiting for fresh asks on the leader and target outcomes.'
          : pendingTiers.length ? pendingTiers.map(tier => tier.lastReason).join(' ')
            : filledTiers.length
              ? `${filledTiers.length} tier(s) filled. Holding target-side shares for exact-market resolution.`
              : signal.targetAsk < MIN_ENTRY_PRICE
                ? `Target ask ${signal.targetAsk.toFixed(3)} is below the $${MIN_ENTRY_PRICE.toFixed(2)} floor.`
                : `${pair.leaderAsset} ${pair.leaderSide} ask ${signal.leaderPrice.toFixed(3)}; ${pair.targetAsset} ${pair.targetSide} ask ${signal.targetAsk.toFixed(3)}. Waiting for a tier match.`;
      const currentWindowPositions = this.positions.filter(position =>
        position.pairId === pair.id && position.windowStart === this.orderWindowStart &&
        ['OPEN', 'PENDING_RESOLUTION'].includes(position.status));
      return {
        id: pair.id,
        label: pair.label,
        leaderAsset: pair.leaderAsset,
        leaderSide: pair.leaderSide,
        targetAsset: pair.targetAsset,
        targetSide: pair.targetSide,
        status,
        reason,
        sharesPerFire: SHARES_PER_FIRE,
        leaderPrice: signal.leaderPrice,
        targetAsk: signal.targetAsk,
        quotesFresh: signal.quotesFresh,
        minEntryPrice: MIN_ENTRY_PRICE,
        maxEntryPricePerShare: MAX_ENTRY_PRICE,
        cycleCount: pairState.cycleCount,
        tiers,
        activeCycles: activeCycles.map(cycle => ({
          id: cycle.id,
          cycleNumber: cycle.cycleNumber,
          tierId: cycle.entryTierId,
          tierLabel: cycle.entryTierLabel,
          leaderAsset: cycle.leaderAsset,
          leaderSide: cycle.leaderSide,
          leaderPrice: cycle.leaderPrice,
          targetAsset: cycle.targetAsset,
          targetSide: cycle.targetSide,
          targetAsk: cycle.targetAsk,
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
    const signalReason = windowOpen && !entryOpen
      ? 'The 270-second entry cutoff has passed. No additional buys will be placed in this window.'
      : entryOpen
      ? fullFillPendingCount
        ? `${fullFillPendingCount} triggered tier(s) lack full 100-share depth within their target-price caps; no shares were booked and they will retry only while their signals remain valid.`
        : pendingTierCount
          ? `${pendingTierCount} triggered tier(s) are awaiting a complete 100-share target fill.`
          : filledTierCount
            ? `${filledTierCount} tier fire(s) filled; target-side positions are held for official resolution.`
            : 'Monitoring same-direction BTC/ETH leader and laggard prices across four tiers.'
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
          leaderMinPrice: tier.leaderMinPrice,
          targetMaxPriceExclusive: tier.targetMaxPriceExclusive,
          minEntryPrice: MIN_ENTRY_PRICE,
          sharesPerFire: tier.sharesPerFire,
        })),
        minTargetPrice: MIN_ENTRY_PRICE,
        maxPricePerShare: MAX_ENTRY_PRICE,
        entryCutoffMs: ENTRY_CUTOFF_MS,
        routes: PAIRS.map(pair => ({ id: pair.id, label: pair.label, status:
          pairSnapshots.find(item => item.id === pair.id)?.status || 'ARMED' })),
        trigger: 'For UP and DOWN independently, buy the same-side target when the leader ask meets a tier floor and the target ask is at or above $0.20 but below its tier ceiling.',
        fillPolicy: 'Each valid route/tier fires once per window for 100 target shares. Sweep visible target asks strictly below that tier ceiling, capped at $0.99; book only a complete fill and retry only while the price signal remains valid.',
      },
      settlement: {
        intraWindowSells: false,
        resolutionPollIntervalMs: cfg.RESOLUTION_POLL_MS,
        windowEnd: 'All filled shares wait for confirmed resolution of their exact original BTC or ETH market.',
      },
      timing: 'Monitor aligned 5-minute BTC/ETH markets from window open; stop all new entries at 270 seconds.',
      sizing: 'Each qualifying route/tier fire buys 100 shares on the target outcome only.',
      trigger: 'Compare BTC UP with ETH UP and BTC DOWN with ETH DOWN; buy the same-side outcome on the cheaper target market.',
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
        cutoffMs: ENTRY_CUTOFF_MS,
        waiting: elapsedMs == null || elapsedMs < 0,
        open: entryOpen,
        windowOpen,
        cutoffReached: windowOpen && !entryOpen,
        secondsUntilOpen: 0,
        secondsRemaining: entryOpen ? Math.ceil((ENTRY_CUTOFF_MS - elapsedMs) / 1000) : 0,
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
  ENTRY_CUTOFF_MS,
  MIN_ENTRY_PRICE,
  QUOTE_MAX_AGE_MS,
  PAIRS,
};
module.exports = CrossPairBot;
