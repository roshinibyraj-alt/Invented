'use strict';

const cfg = require('./config');
const WickBot = require('./wick-bot');
const marketData = require('./wick-market-data');
const { predictNextCandle } = require('./candle-predictor');
const { quoteFromBook, takerFeeFor, feeContext } = WickBot._test;

const ASSETS = Object.freeze(['BTC', 'ETH']);
const QUOTE_MAX_AGE_MS = 2000;

function round(value) {
  return Number(Number(value).toFixed(6));
}

function emptySignal(asset) {
  return {
    asset,
    indicatorStatus: 'LOADING',
    direction: 'PENDING',
    side: null,
    score: null,
    sensitivity: cfg.PREDICTOR_SENSITIVITY,
    lookback: cfg.PREDICTOR_LOOKBACK,
    bars: [],
    lastReason: 'Loading completed Binance candles.',
    entryStatus: 'WAITING_FOR_SIGNAL',
    triggered: false,
    triggeredAt: null,
    triggerAsk: null,
    triggerPhase: null,
    maxEntryPrice: null,
    filledAt: null,
    positionId: null,
    orderId: null,
    lastDepthNotice: null,
    lastDepthNoticeAt: 0,
  };
}

function emptyInventoryBoxes() {
  return Object.fromEntries(ASSETS.map(asset => [asset, Object.fromEntries(
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
    const key = `${position.asset}:${position.side}`;
    floatingTotals.set(key, (floatingTotals.get(key) || 0) + Number(position.unrealizedPnl));
  }
  for (const asset of ASSETS) {
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

function sortedLevels(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1 &&
      Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

function sweepBook(levels, requestedShares, maxPrice) {
  let remaining = requestedShares;
  let notional = 0;
  const fills = [];
  for (const level of sortedLevels(levels)) {
    if (Number.isFinite(maxPrice) && level.price > maxPrice + 1e-9) break;
    if (remaining <= 1e-9) break;
    const shares = Math.min(remaining, level.size);
    const value = shares * level.price;
    notional += value;
    remaining -= shares;
    fills.push({ shares: round(shares), price: round(level.price), value: round(value) });
  }
  const filledShares = requestedShares - remaining;
  return {
    filledShares: round(filledShares),
    remainingShares: round(remaining),
    notional: round(notional),
    averagePrice: filledShares > 0 ? round(notional / filledShares) : null,
    fills,
  };
}

function feesFor(market, fills) {
  return round(fills.reduce((sum, fill) =>
    sum + takerFeeFor(market, fill.price, fill.shares), 0));
}

class WickySignalBot extends WickBot {
  constructor({ marketData: data = marketData } = {}) {
    super({
      timeframe: '5m',
      windowMs: cfg.WINDOW_MS_5M,
      capital: cfg.DEMO_CAPITAL,
      strategyId: 'btc-eth-next-candle-predictor',
      strategyName: 'BTC/ETH Next Candle Predictor paper strategy',
      rules: { sharesPerSide: cfg.ENTRY_SHARES },
      marketData: data,
    });
    this.crossAssetData = data;
    this.btcMarket = null;
    this.btcLiveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
    this.assetSignals = Object.fromEntries(ASSETS.map(asset => [asset, emptySignal(asset)]));
    this.signalWindowStart = null;
    this.signalPromise = Promise.resolve();
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
    this.btcMarket = btcMarket;
    if (!btcMarket || !ethMarket) return null;
    if (Number(btcMarket.start) !== Number(ethMarket.start)) {
      throw new Error('BTC and ETH markets do not share the same 5-minute window start.');
    }
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
    for (const position of this.positions) {
      if (position.asset !== 'BTC' || position.status !== 'OPEN' ||
          position.windowStart !== this.market?.start) continue;
      const quote = this.btcLiveQuotes[position.side];
      position.markBid = quote?.bestBid ?? null;
      position.markUpdatedAt = quote?.updatedAt || now;
      position.markStatus = quote?.bestBid != null ? 'LIVE' : 'MISSING';
    }
  }

  openStrategyWindow(start, now) {
    super.openStrategyWindow(start, now);
    this.signalWindowStart = start;
    this.assetSignals = Object.fromEntries(ASSETS.map(asset => [asset, emptySignal(asset)]));
    this.maxObservedAskDepthByToken.clear();
    this.consumedAskDepthByToken.clear();
    this.signalPromise = this.loadWindowSignals(start, now);
  }

  async loadWindowSignals(start, now) {
    await Promise.all(ASSETS.map(async asset => {
      const state = this.assetSignals[asset];
      try {
        const candles = await this.crossAssetData.getBinanceCandles(
          asset, start, cfg.PREDICTOR_LOOKBACK,
        );
        if (candles.some(candle => Number(candle.closeTime) >= Number(start))) {
          throw new Error('The predictor only accepts candles closed before the window opened.');
        }
        const prediction = predictNextCandle(candles);
        Object.assign(state, prediction, {
          asset,
          indicatorStatus: 'READY',
          source: 'BINANCE_5M',
          generatedAt: now,
          entryStatus: prediction.side ? 'WAITING_FOR_FRESH_ASK' : 'NO_TRADE_NEUTRAL',
          lastReason: prediction.side
            ? `${prediction.direction} signal from ${prediction.lookback} completed Binance candles.`
            : 'Predictor is neutral; this asset will not enter this window.',
        });
        this.log('WICKY_SIGNAL_READY', {
          asset,
          direction: prediction.direction,
          score: prediction.score,
          sensitivity: prediction.sensitivity,
          lookback: prediction.lookback,
          completedCandles: candles.length,
          windowStart: start,
        });
      } catch (error) {
        Object.assign(state, {
          indicatorStatus: 'UNAVAILABLE',
          direction: 'UNAVAILABLE',
          side: null,
          score: null,
          bars: [],
          generatedAt: now,
          entryStatus: 'NO_TRADE_DATA',
          lastReason: error?.message || 'Could not load completed Binance candles.',
        });
        this.log('WICKY_SIGNAL_UNAVAILABLE', {
          asset,
          note: state.lastReason,
          windowStart: start,
        });
      }
    }));
  }

  quoteFor(asset, side) {
    return asset === 'BTC' ? this.btcLiveQuotes[side] : this.liveQuotes[side];
  }

  marketFor(asset) {
    return asset === 'BTC' ? this.btcMarket : this.market;
  }

  isFreshQuote(quote, now) {
    const ask = Number(quote?.bestAsk);
    return quote?.status === 'LIVE' && Number.isFinite(ask) && ask > 0 && ask < 1 &&
      Number.isFinite(Number(quote.updatedAt)) &&
      now - Number(quote.updatedAt) <= QUOTE_MAX_AGE_MS;
  }

  availableAskLevels(asset, side, market, quote) {
    const tokenId = String(market.tokens[side]);
    if (!this.maxObservedAskDepthByToken.has(tokenId)) {
      this.maxObservedAskDepthByToken.set(tokenId, new Map());
    }
    const maxObserved = this.maxObservedAskDepthByToken.get(tokenId);
    const consumed = this.consumedAskDepthByToken.get(tokenId) || new Map();
    const currentByPrice = new Map();
    for (const level of sortedLevels(quote.askLevels)) {
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

  async processStrategyEntry(now) {
    const start = this.orderWindowStart;
    if (!this.market || !this.btcMarket || Number(this.market.start) !== Number(start) ||
        Number(this.btcMarket.start) !== Number(start) || this.completedWindows.has(start)) {
      return false;
    }
    const elapsed = now - Number(start);
    if (elapsed < 0 || elapsed >= this.windowMs) return false;
    if (this.signalWindowStart !== start) {
      this.signalWindowStart = start;
      this.assetSignals = Object.fromEntries(ASSETS.map(asset => [asset, emptySignal(asset)]));
      this.signalPromise = this.loadWindowSignals(start, now);
    }
    await this.signalPromise;

    let changed = false;
    for (const asset of ASSETS) {
      const state = this.assetSignals[asset];
      if (state.indicatorStatus !== 'READY' || !state.side ||
          ['FILLED', 'BLOCKED_INSUFFICIENT_CASH', 'NO_TRADE_NEUTRAL', 'NO_TRADE_DATA']
            .includes(state.entryStatus)) continue;

      const quote = this.quoteFor(asset, state.side);
      const market = this.marketFor(asset);
      if (!market || !this.isFreshQuote(quote, now)) {
        state.entryStatus = state.triggered ? 'WAITING_FOR_FRESH_ASK' : 'WAITING_FOR_FRESH_ASK';
        state.lastReason = 'Waiting for a fresh best ask on the predicted side.';
        continue;
      }

      const ask = Number(quote.bestAsk);
      if (!state.triggered) {
        state.triggerPhase = 'IMMEDIATE_SIGNAL';
        state.maxEntryPrice = null;
        state.triggered = true;
        state.triggeredAt = now;
        state.triggerAsk = round(ask);
        state.entryStatus = 'TRIGGERED';
        this.log('WICKY_ENTRY_TRIGGERED', {
          asset,
          side: state.side,
          ask: round(ask),
          phase: state.triggerPhase,
          score: state.score,
          windowStart: start,
        });
      }

      if (this.buySignal(asset, state, market, quote, now)) changed = true;
    }
    this.lastScanAt = now;
    return changed;
  }

  buySignal(asset, state, market, quote, now) {
    const requestedShares = cfg.ENTRY_SHARES;
    const maxPrice = null;
    const levels = this.availableAskLevels(asset, state.side, market, quote);
    const fill = sweepBook(levels, requestedShares, null);
    if (fill.filledShares + 1e-9 < requestedShares) {
      state.entryStatus = 'WAITING_FOR_FULL_FILL';
      state.lastReason =
        `Visible ask depth covers ${fill.filledShares}/${requestedShares} shares; no partial position is recorded.`;
      if (state.lastDepthNotice !== `${fill.filledShares}/${requestedShares}` ||
          now - state.lastDepthNoticeAt >= 5000) {
        this.log('PAPER_WICKY_WAITING_FOR_FULL_FILL', {
          asset,
          side: state.side,
          availableShares: fill.filledShares,
          requestedShares,
          triggerAsk: state.triggerAsk,
          windowStart: this.orderWindowStart,
        });
        state.lastDepthNotice = `${fill.filledShares}/${requestedShares}`;
        state.lastDepthNoticeAt = now;
      }
      return false;
    }

    const fees = feesFor(market, fill.fills);
    const totalDebit = fill.notional + fees;
    if (totalDebit > this.cash + 1e-9) {
      state.entryStatus = 'BLOCKED_INSUFFICIENT_CASH';
      state.lastReason =
        `The ${requestedShares}-share entry needs ${moneyText(totalDebit)} including fees; paper cash is ${moneyText(this.cash)}.`;
      this.log('PAPER_WICKY_BLOCKED_CASH', {
        asset,
        side: state.side,
        requiredCash: round(totalDebit),
        availableCash: round(this.cash),
        windowStart: this.orderWindowStart,
      });
      return false;
    }

    const positionId = `${this.orderWindowStart}-${asset.toLowerCase()}-${state.side.toLowerCase()}`;
    const orderId = `${positionId}-buy`;
    const fillEvents = fill.fills.map(level => ({
      filledAt: now,
      shares: level.shares,
      price: level.price,
      cost: level.value,
      fee: round(takerFeeFor(market, level.price, level.shares)),
      source: 'VISIBLE_ASK_DEPTH',
    }));
    const order = {
      id: orderId,
      timeframe: this.timeframe,
      windowStart: this.orderWindowStart,
      marketId: market.id,
      marketSlug: market.slug,
      asset,
      tokenId: market.tokens[state.side],
      side: state.side,
      action: 'BUY',
      kind: 'WICKY_SIGNAL_ENTRY',
      orderType: 'MARKET',
      requestedShares,
      filledShares: requestedShares,
      remainingShares: 0,
      cost: fill.notional,
      fee: fees,
      averagePrice: fill.averagePrice,
      fillEvents,
      maxPricePerShare: maxPrice,
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
      marketId: market.id,
      slug: market.slug,
      title: market.title,
      asset,
      side: state.side,
      tokenId: market.tokens[state.side],
      signalDirection: state.direction,
      signalScore: state.score,
      signalSensitivity: state.sensitivity,
      signalLookback: state.lookback,
      entryGate: state.triggerPhase,
      entryThreshold: null,
      triggerAsk: state.triggerAsk,
      entryKey: orderId,
      entryLabel: `${asset} ${state.side} · ${state.direction} candle signal`,
      entryMode: 'WICKY_NEXT_CANDLE_PREDICTOR',
      entryType: 'MARKET_TAKER_BUY',
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      orderType: 'MARKET',
      fillModel: 'PAPER_VISIBLE_ASK_DEPTH_FULL_FILL',
      shares: requestedShares,
      initialShares: requestedShares,
      requestedShares,
      maxEntryPrice: null,
      avgEntry: fill.averagePrice,
      fillPrice: fill.averagePrice,
      cost: fill.notional,
      totalCost: fill.notional,
      initialTotalCost: fill.notional,
      fees,
      initialFees: fees,
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
        asset === 'BTC' ? this.btcLiveQuotes : this.liveQuotes,
      ),
      entryQuoteAt: now,
      feeContext: feeContext(market),
      markBid: quote.bestBid ?? null,
      markUpdatedAt: quote.updatedAt || now,
      markStatus: 'LIVE',
      maxObservedBidSizeByPrice: {},
    };

    this.consumeAskDepth(market.tokens[state.side], fill.fills);
    this.cash = round(this.cash - totalDebit);
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.positions.unshift(position);
    this.totalOrderAttempts += 1;
    Object.assign(state, {
      entryStatus: 'FILLED',
      filledAt: now,
      positionId,
      orderId,
      averagePrice: fill.averagePrice,
      fees,
      shares: requestedShares,
      lastReason:
        `Filled ${requestedShares} ${asset} ${state.side} shares from visible asks; holding for exact-market resolution.`,
    });
    this.entryOrderPlaced = true;
    this.entryOrderId = orderId;
    this.entryTriggerLatched = true;
    this.entryTriggerAt = state.triggeredAt;
    this.entryTriggerSide = `${asset} ${state.side}`;
    this.entryTriggerReason = `${asset} ${state.direction} signal; bought immediately from visible asks at ${priceText(state.triggerAsk)}.`;
    this.entrySignal = {
      asset,
      direction: state.direction,
      score: state.score,
      side: state.side,
      triggerAsk: state.triggerAsk,
      maxEntryPrice: null,
      triggeredAt: state.triggeredAt,
    };
    this.log('PAPER_WICKY_ENTRY_FILLED', {
      positionId,
      orderId,
      asset,
      side: state.side,
      direction: state.direction,
      score: state.score,
      sharesBought: requestedShares,
      averageFillPrice: fill.averagePrice,
      entryCost: fill.notional,
      fees,
      maxEntryPrice: maxPrice,
      windowStart: this.orderWindowStart,
    });
    return true;
  }

  snapshot() {
    const state = super.snapshot();
    const now = Date.now();
    const windowStart = Number(state.window?.start);
    const elapsedMs = Number.isFinite(windowStart) ? now - windowStart : null;
    const windowOpen = elapsedMs != null && elapsedMs >= 0 && elapsedMs < this.windowMs;
    const btcPrices = this.captureQuotePair(now, this.btcLiveQuotes);
    const ethPrices = state.livePrices;
    const positionBuckets = {
      currentWindow: aggregateInventory(this.positions, position =>
        position.status === 'OPEN' && Number(position.windowStart) === windowStart, true),
      awaitingResolution: aggregateInventory(this.positions,
        position => position.status === 'PENDING_RESOLUTION', false),
    };
    const signals = Object.fromEntries(ASSETS.map(asset => {
      const signal = this.assetSignals[asset] || emptySignal(asset);
      const market = this.marketFor(asset);
      const quotes = this.captureQuotePair(
        now,
        asset === 'BTC' ? this.btcLiveQuotes : this.liveQuotes,
      );
      const sideQuote = signal.side ? quotes[signal.side] : null;
      const timeRemainingMs = windowOpen ? Math.max(0, this.windowMs - elapsedMs) : 0;
      return [asset, {
        asset,
        marketId: market?.id || null,
        marketSlug: market?.slug || null,
        indicatorStatus: signal.indicatorStatus,
        direction: signal.direction,
        side: signal.side,
        score: signal.score,
        sensitivity: signal.sensitivity,
        lookback: signal.lookback,
        source: signal.source || 'BINANCE_5M',
        generatedAt: signal.generatedAt || null,
        latestCandleCloseTime: signal.latestCandleCloseTime || null,
        averageBody: signal.averageBody ?? null,
        averageWick: signal.averageWick ?? null,
        averageRelativeVolume: signal.averageRelativeVolume ?? null,
        latestRelativeVolume: signal.latestRelativeVolume ?? null,
        bullishCandles: signal.bullishCandles ?? 0,
        bearishCandles: signal.bearishCandles ?? 0,
        neutralCandles: signal.neutralCandles ?? 0,
        bars: signal.bars || [],
        quotes,
        entry: {
          status: signal.entryStatus,
          side: signal.side,
          currentAsk: sideQuote?.bestAsk ?? null,
          triggerAsk: signal.triggerAsk,
          triggerPhase: signal.triggerPhase,
          triggeredAt: signal.triggeredAt,
          maxEntryPrice: signal.maxEntryPrice,
          filledAt: signal.filledAt,
          positionId: signal.positionId,
          orderId: signal.orderId,
          averagePrice: signal.averagePrice ?? null,
          fees: signal.fees ?? null,
          shares: signal.shares ?? 0,
          lastReason: signal.lastReason,
          elapsedMs,
          timeRemainingMs,
        },
      }];
    }));
    const entryReasons = Object.values(signals)
      .map(signal => `${signal.asset}: ${signal.entry.lastReason}`)
      .join(' ');
    const pendingResolutionPositions =
      this.positions.filter(position => position.status === 'PENDING_RESOLUTION').length;
    const strategy = {
      id: this.strategyId,
      name: this.strategyName,
      timeframe: '5m',
      market: 'Polymarket BTC and ETH 5-minute UP/DOWN',
      capital: this.capital,
      execution: 'PAPER ONLY',
      indicator: {
        name: 'Next Candle Predictor',
        source: 'WickyWackyTrader-inspired; calculations use closed Binance 5-minute candles.',
        lookback: cfg.PREDICTOR_LOOKBACK,
        wickWeight: cfg.PREDICTOR_WICK_WEIGHT,
        bodyWeight: cfg.PREDICTOR_BODY_WEIGHT,
        volumeWeight: cfg.PREDICTOR_VOLUME_WEIGHT,
        sensitivity: cfg.PREDICTOR_SENSITIVITY,
        output: 'Directional score, not a probability.',
      },
      entries: {
        orderType: 'MARKET',
        sharesPerAsset: cfg.ENTRY_SHARES,
        maximumEntriesPerAssetPerWindow: 1,
        priceFilter: null,
        fillPolicy: 'Buy immediately on the signaled side with no price filter, only when the full requested size is visible in fresh asks. No partial or timeout fills.',
      },
      settlement: {
        intraWindowSells: false,
        resolutionPollIntervalMs: cfg.RESOLUTION_POLL_MS,
        windowEnd: 'All filled shares wait for confirmed resolution of their exact original BTC or ETH market.',
      },
      timing: 'Read five completed Binance 5-minute candles, then monitor each Polymarket market for the full aligned window.',
      trigger: 'Use independent BTC and ETH signals. Buy the predicted side immediately when the signal is ready and a fresh ask book is available; there is no price filter.',
      sizing: `${cfg.ENTRY_SHARES} shares per asset per 5-minute window.`,
      executionNote: 'Demo-only simulation. No live orders are sent; positions are held to exact-market resolution.',
    };

    return {
      ...state,
      account: {
        ...state.account,
        openPositions: this.positions.filter(position =>
          ['OPEN', 'PENDING_RESOLUTION'].includes(position.status)).length,
        pendingResolutionPositions,
      },
      strategy,
      btcPrices: {
        marketSlug: this.btcMarket?.slug || null,
        marketId: this.btcMarket?.id || null,
        updatedAt: Math.max(btcPrices.UP.updatedAt || 0, btcPrices.DOWN.updatedAt || 0) || null,
        UP: btcPrices.UP,
        DOWN: btcPrices.DOWN,
      },
      livePrices: ethPrices,
      signals,
      signal: {
        ready: Object.values(signals).some(item => item.indicatorStatus === 'READY'),
        reason: entryReasons,
      },
      entryWindow: {
        elapsedMs,
        waiting: elapsedMs == null || elapsedMs < 0,
        open: windowOpen,
        windowOpen,
        cutoffReached: !windowOpen && elapsedMs != null && elapsedMs >= this.windowMs,
        secondsUntilOpen: 0,
        secondsRemaining: windowOpen ? Math.ceil((this.windowMs - elapsedMs) / 1000) : 0,
        secondsToWindowEnd: windowOpen ? Math.ceil((this.windowMs - elapsedMs) / 1000) : 0,
      },
      positionBuckets,
      scanner: {
        timeframe: '5m',
        lastScanAt: this.lastScanAt,
        source: 'Binance BTC/ETH 5-minute candles and Polymarket Gamma/CLOB order books',
        marketResolution: 'Unexited shares resolve only against the confirmed result of their exact original BTC or ETH market.',
        resolutionPollIntervalMs: cfg.RESOLUTION_POLL_MS,
      },
    };
  }
}

function priceText(value) {
  return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : '—';
}

function moneyText(value) {
  return Number.isFinite(Number(value))
    ? `$${Number(value).toFixed(2)}`
    : '—';
}

WickySignalBot.constants = {
  ASSETS,
  QUOTE_MAX_AGE_MS,
};

WickySignalBot._test = { sweepBook, aggregateInventory };

module.exports = WickySignalBot;
