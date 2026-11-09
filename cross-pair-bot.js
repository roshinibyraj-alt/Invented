'use strict';

const cfg = require('./config');
const WickBot = require('./wick-bot');
const marketData = require('./wick-market-data');
const { quoteFromBook, takerFeeFor, feeContext } = WickBot._test;

const ENTRY_TIERS = Object.freeze(cfg.CROSS_PAIR_ENTRY_TIERS.map(tier => Object.freeze({ ...tier })));
const SHARES_PER_LEG = ENTRY_TIERS[0].sharesPerLeg;
const ENTRY_ASK_SUM_MAX = ENTRY_TIERS[0].combinedAskThreshold;
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
    cycleIds: [],
    tiers: Object.fromEntries(ENTRY_TIERS.map(tier => [tier.id, {
      id: tier.id,
      label: tier.label,
      combinedAskThreshold: tier.combinedAskThreshold,
      comparison: tier.comparison,
      sharesPerLeg: tier.sharesPerLeg,
      status: 'ARMED',
      qualifiedAt: null,
      filledAt: null,
      cycleId: null,
      lastReason: `Waiting for combined asks ${tier.comparison === 'LT' ? 'below' : 'at or below'} $${tier.combinedAskThreshold.toFixed(2)}.`,
      lastDepthNotice: null,
      lastDepthNoticeAt: 0,
      lastBlockNotice: null,
      lastBlockNoticeAt: 0,
    }])),
    lastReason: 'Waiting for both ask quotes.',
    lastEntryAskSum: null,
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

  pairQuote(pair, now) {
    const legs = pair.legs.map(leg => ({
      ...leg,
      quote: this.quoteFor(leg.asset, leg.side),
      market: this.marketFor(leg.asset),
    }));
    const asksFresh = legs.every(leg => this.isFreshQuote(leg.quote, now, 'bestAsk'));
    return {
      legs,
      asksFresh,
      askSum: asksFresh ? round(legs.reduce((sum, leg) => sum + Number(leg.quote.bestAsk), 0)) : null,
    };
  }

  processStrategyEntry(now) {
    const start = this.orderWindowStart;
    if (!this.market || !this.btcMarket || this.market.start !== start ||
        this.btcMarket.start !== start || this.completedWindows.has(start)) return false;
    const elapsed = now - start;
    if (elapsed < 0 || elapsed >= this.windowMs) return false;

    let changed = false;
    for (const pair of PAIRS) {
      const pairState = this.pairStates[pair.id];
      const marketPair = this.pairQuote(pair, now);
      pairState.lastEntryAskSum = marketPair.askSum;
      if (!marketPair.asksFresh) {
        pairState.status = 'WAITING_FOR_QUOTES';
        pairState.lastReason = 'Waiting for fresh asks on both legs.';
        continue;
      }
      for (const tier of ENTRY_TIERS) {
        const tierState = pairState.tiers[tier.id];
        const qualified = tier.comparison === 'LT'
          ? marketPair.askSum < tier.combinedAskThreshold
          : marketPair.askSum <= tier.combinedAskThreshold;
        if (qualified && !tierState.qualifiedAt) {
          tierState.qualifiedAt = now;
          tierState.status = 'QUALIFIED';
          tierState.lastReason = `Combined asks ${marketPair.askSum.toFixed(3)} reached ${tier.comparison === 'LT' ? 'below' : 'at or below'} $${tier.combinedAskThreshold.toFixed(2)}.`;
          this.log('PAPER_CROSS_PAIR_ENTRY_TIER_QUALIFIED', {
            pairId: pair.id,
            pairLabel: pair.label,
            tierId: tier.id,
            tierLabel: tier.label,
            combinedAsk: marketPair.askSum,
            threshold: tier.combinedAskThreshold,
            sharesPerLeg: tier.sharesPerLeg,
          });
        }
      }
      for (const tier of ENTRY_TIERS) {
        const tierState = pairState.tiers[tier.id];
        if (!tierState.qualifiedAt || tierState.status === 'FILLED') continue;
        tierState.status = 'ENTRY_READY';
        if (this.buyPair(pair, pairState, marketPair, now, tier, tierState)) changed = true;
      }
      const tiers = Object.values(pairState.tiers);
      const pending = tiers.filter(tier => tier.qualifiedAt && tier.status !== 'FILLED');
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
          ? `${filled.length} entry tier(s) filled. No intra-window sells; holding shares for exact-market resolution.`
          : `Combined asks ${marketPair.askSum.toFixed(3)}; watching all entry tiers.`;
    }
    this.lastScanAt = now;
    return changed;
  }

  buyPair(pair, pairState, marketPair, now, tier, tierState) {
    const fills = marketPair.legs.map(leg => ({
      ...leg,
      fill: sweepBook(this.availableAskLevels(leg), tier.sharesPerLeg, 'BUY', MAX_ENTRY_PRICE),
    }));
    for (const leg of fills) {
      leg.fee = feesFor(leg.market, leg.fill.fills);
    }
    const incomplete = fills.filter(leg => leg.fill.filledShares + 1e-9 < tier.sharesPerLeg);
    if (incomplete.length) {
      const depthSummary = fills.map(leg =>
        `${leg.asset} ${leg.side} ${leg.fill.filledShares}/${tier.sharesPerLeg}`).join(', ');
      const reason = `${tier.label}: asks at or below $${MAX_ENTRY_PRICE.toFixed(2)} can fill ${depthSummary}. No shares were booked; retrying.`;
      tierState.status = 'WAITING_FOR_FULL_FILL';
      tierState.lastReason = reason;
      if (tierState.lastDepthNotice !== depthSummary ||
          now - tierState.lastDepthNoticeAt >= 5000) {
        this.log('PAPER_CROSS_PAIR_ENTRY_WAITING_FOR_FULL_FILL', {
          pairId: pair.id,
          pairLabel: pair.label,
          tierId: tier.id,
          tierLabel: tier.label,
          threshold: tier.combinedAskThreshold,
          combinedBestAsk: marketPair.askSum,
          maxPricePerShare: MAX_ENTRY_PRICE,
          requestedSharesPerLeg: tier.sharesPerLeg,
          legs: fills.map(leg => ({
            asset: leg.asset,
            side: leg.side,
            requestedShares: tier.sharesPerLeg,
            availableSharesWithinCap: leg.fill.filledShares,
          })),
          message: 'No entry was booked because both legs could not fill completely.',
        });
        tierState.lastDepthNotice = depthSummary;
        tierState.lastDepthNoticeAt = now;
      }
      return false;
    }
    const totalDebit = fills.reduce((sum, leg) => sum + leg.fill.notional + leg.fee, 0);
    if (totalDebit > this.cash + 1e-9) {
      tierState.status = 'BLOCKED_INSUFFICIENT_CASH';
      const reason = `${tier.label}: complete pair needs $${round(totalDebit).toFixed(2)} including fees; paper cash is $${round(this.cash).toFixed(2)}. No shares were booked.`;
      tierState.lastReason = reason;
      if (tierState.lastBlockNotice !== reason || now - tierState.lastBlockNoticeAt >= 5000) {
        this.log('PAPER_CROSS_PAIR_ENTRY_BLOCKED_CASH', {
          pairId: pair.id,
          pairLabel: pair.label,
          tierId: tier.id,
          tierLabel: tier.label,
          requiredCash: round(totalDebit),
          availableCash: round(this.cash),
          maxPricePerShare: MAX_ENTRY_PRICE,
        });
        tierState.lastBlockNotice = reason;
        tierState.lastBlockNoticeAt = now;
      }
      return false;
    }

    for (const leg of fills) {
      this.consumeAskDepth(leg.market.tokens[leg.side], leg.fill.fills);
    }

    const cycleNumber = pairState.cycleCount + 1;
    const cycleId = `${pair.id}-${this.orderWindowStart}-${tier.id}-${cycleNumber}`;
    const cycle = {
      id: cycleId,
      pairId: pair.id,
      pairLabel: pair.label,
      entryTierId: tier.id,
      entryTierLabel: tier.label,
      entryThreshold: tier.combinedAskThreshold,
      sharesPerLeg: tier.sharesPerLeg,
      cycleNumber,
      windowStart: this.orderWindowStart,
      status: 'HOLDING_TO_RESOLUTION',
      entryAt: now,
      entryAskSum: marketPair.askSum,
      entryAveragePriceSum: round(fills.reduce((sum, leg) => sum + leg.fill.averagePrice, 0)),
      entryCost: round(fills.reduce((sum, leg) => sum + leg.fill.notional, 0)),
      entryFees: round(fills.reduce((sum, leg) => sum + leg.fee, 0)),
      legPositionIds: [],
      legs: [],
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
        kind: 'PAIR_ENTRY_TIER',
        orderType: 'MARKET',
        requestedShares: tier.sharesPerLeg,
        filledShares: tier.sharesPerLeg,
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
        entryTierId: tier.id,
        entryTierLabel: tier.label,
        entryThreshold: tier.combinedAskThreshold,
        pairCycleId: cycleId,
        pairCycleNumber: cycleNumber,
        pairedWith: `${fills.find(other => other !== leg).asset} ${fills.find(other => other !== leg).side}`,
        entryKey: orderId,
        entryLabel: `${pair.label} · ${tier.label} · ${leg.asset} ${leg.side}`,
        entryMode: 'CROSS_PAIR_MARKET_BUY',
        entryType: 'MARKET_TAKER_BUY',
        strategyId: this.strategyId,
        strategyName: this.strategyName,
        orderType: 'MARKET',
        fillModel: 'PAPER_VISIBLE_ASK_DEPTH_WITH_MAX_PRICE',
        shares: tier.sharesPerLeg,
        initialShares: tier.sharesPerLeg,
        requestedShares: tier.sharesPerLeg,
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
        requestedShares: tier.sharesPerLeg, filledShares: tier.sharesPerLeg,
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
    pairState.cycleIds.push(cycleId);
    tierState.status = 'FILLED';
    tierState.filledAt = now;
    tierState.cycleId = cycleId;
    tierState.lastReason = `Filled both ${tier.sharesPerLeg}-share legs at combined asks ${marketPair.askSum.toFixed(3)}; holding to resolution.`;
    pairState.lastEntryAskSum = marketPair.askSum;
    this.pairCycles.unshift(cycle);
    this.entryOrderPlaced = true;
    this.entryOrderId = this.orders[0]?.id || null;
    this.entryTriggerLatched = true;
    this.entryTriggerAt = now;
    this.entryTriggerSide = `${pair.id}:${tier.id}`;
    this.entryTriggerReason = `${pair.label} ${tier.label} entered at combined asks ${marketPair.askSum.toFixed(3)}.`;
    this.entrySignal = {
      pairId: pair.id,
      pairLabel: pair.label,
      tierId: tier.id,
      tierLabel: tier.label,
      threshold: tier.combinedAskThreshold,
      askSum: marketPair.askSum,
      windowStart: this.orderWindowStart,
      triggeredAt: now,
    };
    this.log('PAPER_CROSS_PAIR_ENTRY_FILLED', {
      cycleId,
      pairId: pair.id,
      pairLabel: pair.label,
      tierId: tier.id,
      tierLabel: tier.label,
      threshold: tier.combinedAskThreshold,
      sharesPerLeg: tier.sharesPerLeg,
      combinedAsk: marketPair.askSum,
      combinedAverageFillPrice: cycle.entryAveragePriceSum,
      maxPricePerShare: MAX_ENTRY_PRICE,
      entryCost: cycle.entryCost,
      fees: cycle.entryFees,
      legs: fills.map(leg => ({
        asset: leg.asset,
        side: leg.side,
        requestedShares: tier.sharesPerLeg,
        filledShares: tier.sharesPerLeg,
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
      const pendingTiers = tiers.filter(tier => tier.qualifiedAt && tier.status !== 'FILLED');
      const filledTiers = tiers.filter(tier => tier.status === 'FILLED');
      const unfilledTiers = tiers.filter(tier => tier.status !== 'FILLED');
      const nextTier = unfilledTiers[0];
      const status = !windowOpen ? 'WINDOW CLOSED'
        : !marketPair.asksFresh ? 'WAITING FOR QUOTES'
          : pendingTiers.some(tier => tier.status === 'WAITING_FOR_FULL_FILL') ? 'WAITING FOR FULL FILL'
            : pendingTiers.some(tier => tier.status === 'BLOCKED_INSUFFICIENT_CASH') ? 'BLOCKED BY CASH'
              : pendingTiers.length ? 'ENTRY READY'
                : filledTiers.length ? 'HOLDING TO RESOLUTION'
                  : 'ARMED';
      const reason = !windowOpen ? 'Waiting for the next aligned 5-minute BTC/ETH window.'
        : !marketPair.asksFresh ? 'Waiting for fresh ask quotes on both legs.'
          : pendingTiers.length ? pendingTiers.map(tier => tier.lastReason).join(' ')
            : filledTiers.length
              ? `${filledTiers.length} tier(s) filled. No intra-window sells; holding all shares for exact-market resolution.`
              : nextTier
                ? `Combined asks ${marketPair.askSum.toFixed(3)}; next trigger is ${nextTier.comparison === 'LT' ? 'below' : 'at or below'} $${nextTier.combinedAskThreshold.toFixed(2)}.`
                : 'All entry tiers have filled; holding for exact-market resolution.';
      const currentWindowPositions = this.positions.filter(position =>
        position.pairId === pair.id && position.windowStart === this.orderWindowStart &&
        ['OPEN', 'PENDING_RESOLUTION'].includes(position.status));
      return {
        id: pair.id,
        label: pair.label,
        status,
        reason,
        sharesPerLeg: SHARES_PER_LEG,
        entryAskSum: marketPair.askSum,
        asksFresh: marketPair.asksFresh,
        entryThreshold: ENTRY_ASK_SUM_MAX,
        maxEntryPricePerShare: MAX_ENTRY_PRICE,
        cycleCount: pairState.cycleCount,
        tiers,
        activeCycles: activeCycles.map(cycle => ({
          id: cycle.id,
          cycleNumber: cycle.cycleNumber,
          tierId: cycle.entryTierId,
          tierLabel: cycle.entryTierLabel,
          sharesPerLeg: cycle.sharesPerLeg,
          status: cycle.status,
          entryAskSum: cycle.entryAskSum,
          entryAveragePriceSum: cycle.entryAveragePriceSum,
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
      count + pair.tiers.filter(tier => tier.qualifiedAt && tier.status !== 'FILLED').length, 0);
    const fullFillPendingCount = pairSnapshots.reduce((count, pair) =>
      count + pair.tiers.filter(tier => tier.status === 'WAITING_FOR_FULL_FILL').length, 0);
    const filledTierCount = pairSnapshots.reduce((count, pair) =>
      count + pair.tiers.filter(tier => tier.status === 'FILLED').length, 0);
    const signalReason = windowOpen
      ? fullFillPendingCount
        ? `${fullFillPendingCount} triggered tier(s) lack visible depth to fill both legs completely under $${MAX_ENTRY_PRICE.toFixed(2)}; no shares were booked and the tiers will retry.`
        : pendingTierCount
          ? `${pendingTierCount} triggered tier(s) are awaiting complete fills on both legs.`
          : filledTierCount
            ? `${filledTierCount} entry tier(s) filled; positions are held for resolution while lower ask tiers are monitored.`
            : 'Monitoring both cross-pair combinations for the five combined-ask entry tiers.'
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
          combinedAskThreshold: tier.combinedAskThreshold,
          comparison: tier.comparison,
          sharesPerLeg: tier.sharesPerLeg,
        })),
        maxPricePerShare: MAX_ENTRY_PRICE,
        pairs: PAIRS.map(pair => ({ id: pair.id, label: pair.label, status:
          pairSnapshots.find(item => item.id === pair.id)?.status || 'ARMED' })),
        trigger: 'For each pair, latch the base trigger below $0.90 and add-on triggers at or below $0.80, $0.70, $0.60, and $0.50.',
        fillPolicy: 'Each tier sweeps visible asks up to $0.99 per share. Book only when both legs fully fill that tier size; otherwise book zero and retry that latched tier.',
      },
      settlement: {
        intraWindowSells: false,
        windowEnd: 'Any unsold shares wait for confirmed resolution of their exact original BTC or ETH market.',
      },
      timing: 'Monitor both pairings throughout each aligned 5-minute window; no startup wait or entry cutoff.',
      sizing: 'Base tier: 200 shares per leg below $0.90; each of the four lower combined-ask tiers adds 300 shares per leg. Both pairings are independent.',
      trigger: 'BTC UP + ETH DOWN and ETH UP + BTC DOWN are monitored independently.',
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
      signal: { pairId: null, reason: signalReason, ready: pendingTierCount > 0 },
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
      recentPairCycles: this.pairCycles.slice(0, 20).map(cycle => ({
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
        marketResolution: 'Unexited legs resolve only against the confirmed result of their exact original BTC or ETH market.',
      },
    };
  }
}

CrossPairBot.constants = { SHARES_PER_LEG, ENTRY_ASK_SUM_MAX, ENTRY_TIERS, QUOTE_MAX_AGE_MS, PAIRS };
module.exports = CrossPairBot;
