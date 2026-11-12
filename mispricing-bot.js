'use strict';

const config = require('./config');
const WickBot = require('./wick-bot');
const BinanceTickFeed = require('./binance-tick-feed');
const defaultMarketData = require('./wick-market-data');

const { takerFeeFor } = WickBot._test;
const SECONDS_PER_WINDOW = config.WINDOW_MS_5M / 1000;
const EPSILON = 1e-9;

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

function normalCdf(value) {
  return Math.max(0, Math.min(1, 0.5 * (1 + erf(value / Math.sqrt(2)))));
}

function calculateVolatility(candles, count = config.VOLATILITY_CANDLES) {
  const sample = (Array.isArray(candles) ? candles : [])
    .filter((candle) => Number(candle?.open) > 0 && Number(candle?.close) > 0)
    .slice(-count);
  if (sample.length !== count) return null;
  const returns = sample.map((candle) => Math.log(Number(candle.close) / Number(candle.open)));
  const variance = returns.reduce((sum, value) => sum + value ** 2, 0) / returns.length;
  const volatility = Math.sqrt(variance);
  return Number.isFinite(volatility) && volatility > 1e-10 ? volatility : null;
}

function estimateUpProbability({ currentPrice, windowOpenPrice, volatility5m, secondsRemaining }) {
  if (![currentPrice, windowOpenPrice, volatility5m, secondsRemaining]
    .every((value) => Number.isFinite(Number(value)))
    || currentPrice <= 0 || windowOpenPrice <= 0 || volatility5m <= 0 || secondsRemaining <= 0) {
    return null;
  }
  const remainingVolatility = volatility5m * Math.sqrt(secondsRemaining / SECONDS_PER_WINDOW);
  if (!(remainingVolatility > 1e-10)) return null;
  const zScore = Math.log(currentPrice / windowOpenPrice) / remainingVolatility;
  return Math.max(0, Math.min(1, normalCdf(zScore)));
}

function sweepLevels(levels, shares, { side, minimumPrice = 0, market } = {}) {
  const ordered = (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price >= 0 && level.price <= 1 && level.size > 0)
    .filter((level) => side === 'SELL' ? level.price + EPSILON >= minimumPrice : true)
    .sort((a, b) => side === 'SELL' ? b.price - a.price : a.price - b.price);
  let remaining = Number(shares);
  let gross = 0;
  let fees = 0;
  const fills = [];
  for (const level of ordered) {
    if (remaining <= EPSILON) break;
    const filled = Math.min(remaining, level.size);
    if (!(filled > EPSILON)) continue;
    gross += filled * level.price;
    fees += takerFeeFor(market, level.price, filled);
    fills.push({ price: level.price, shares: filled });
    remaining -= filled;
  }
  const filledShares = Number(shares) - remaining;
  return {
    complete: remaining <= EPSILON,
    requestedShares: Number(shares),
    filledShares,
    remainingShares: Math.max(0, remaining),
    gross,
    fees,
    netProceeds: gross - fees,
    averagePrice: filledShares > 0 ? gross / filledShares : null,
    fills,
  };
}

function calculateTakeProfitLimit({ market, shares, entryGross, entryFees }) {
  const allInCost = Number(entryGross) + Number(entryFees);
  if (!(allInCost > 0) || !(Number(shares) > 0)) {
    return { possible: false, reason: 'Entry cost is unavailable.', allInCost, targetNetProceeds: null };
  }
  const targetNetProceeds = allInCost * (1 + config.TAKE_PROFIT_NET_RETURN);
  const netAt = (price) => price * shares - takerFeeFor(market, price, shares);
  if (netAt(config.TAKE_PROFIT_MAX_PRICE) + EPSILON < targetNetProceeds) {
    return {
      possible: false,
      reason: 'A 50% net return cannot be reached at or below the $0.99 limit.',
      allInCost,
      targetNetProceeds,
    };
  }
  let low = 0;
  let high = config.TAKE_PROFIT_MAX_PRICE;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (netAt(middle) + EPSILON >= targetNetProceeds) high = middle;
    else low = middle;
  }
  const ticks = Math.ceil((high - EPSILON) / config.PRICE_TICK);
  const limitPrice = Number((ticks * config.PRICE_TICK).toFixed(2));
  return {
    possible: limitPrice <= config.TAKE_PROFIT_MAX_PRICE + EPSILON,
    limitPrice,
    allInCost,
    targetNetProceeds,
    targetNetProfit: allInCost * config.TAKE_PROFIT_NET_RETURN,
    reason: null,
  };
}

class MispricingBot extends WickBot {
  constructor({
    marketData = defaultMarketData,
    priceFeed = null,
    now = Date.now,
    initialCapital = config.DEMO_CAPITAL,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    super({
      strategyId: 'btc-5m-binance-mispricing-tp50',
      strategyName: 'BTC 5-minute Binance mispricing paper strategy',
      timeframe: '5m',
      windowMs: config.WINDOW_MS_5M,
      capital: initialCapital,
      rules: {
        sharesPerSide: config.ENTRY_SHARES,
        entryDelayMs: config.ENTRY_DELAY_MS,
        minimumNetEdgePerShare: config.MIN_NET_EDGE_PER_SHARE,
      },
      marketData,
      now,
    });
    this.config = config;
    this.priceFeed = priceFeed || new BinanceTickFeed({ now });
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.model = null;
    this.signal = { side: null, reason: 'Waiting for Binance feed and market data.' };
    this.strategyWindowStart = null;
    this.entriesThisWindow = 0;
    this.positionSequence = 0;
    this.rearmReadyAt = null;
    this.lastTakeProfitAt = null;
    this.books = { UP: null, DOWN: null };
    this.bookMarketId = null;
    this.marketStream = null;
    this.streamGeneration = 0;
    this.websocket = {
      status: 'WAITING',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
  }

  start() {
    void this.priceFeed.start?.();
    return super.start();
  }

  stop() {
    super.stop();
    this.closeMarketStream();
    this.priceFeed.stop?.();
  }

  async refreshLiveQuotes(now = this.now()) {
    const market = this.market;
    if (!market?.tokens?.UP || !market?.tokens?.DOWN) return;
    const marketId = String(market.id || market.slug || market.start);
    if (this.bookMarketId === marketId) return;

    this.closeMarketStream();
    this.bookMarketId = marketId;
    this.books = { UP: null, DOWN: null };
    this.liveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
    await Promise.all(['UP', 'DOWN'].map(async (side) => {
      try {
        const book = await this.marketData.getBook(market.tokens[side]);
        this.applyBookSnapshot({
          asset_id: market.tokens[side],
          bids: book?.bids,
          asks: book?.asks,
          timestamp: now,
        }, now);
      } catch (error) {
        this.log('INITIAL_BOOK_SNAPSHOT_ERROR', {
          side,
          note: error?.message || 'Could not fetch the initial order book.',
        });
      }
    }));
    this.startMarketStream(market);
  }

  startMarketStream(market) {
    this.closeMarketStream();
    const generation = this.streamGeneration;
    if (typeof this.marketData.connectMarketStream !== 'function') {
      this.websocket = {
        ...this.websocket,
        status: 'ERROR',
        error: 'Polymarket market WebSocket is unavailable.',
      };
      return;
    }
    this.websocket = {
      ...this.websocket,
      status: 'CONNECTING',
      connectedAt: null,
      lastMessageAt: null,
      error: null,
    };
    this.marketStream = this.marketData.connectMarketStream(
      [market.tokens.UP, market.tokens.DOWN],
      {
        WebSocketImpl: this.WebSocketImpl,
        heartbeatMs: 10_000,
        reconnectMinMs: 1_000,
        reconnectMaxMs: 15_000,
        onStatus: (update) => {
          if (generation !== this.streamGeneration) return;
          this.websocket = { ...this.websocket, ...update };
          if (update.status === 'CONNECTED') this.websocket.connectedAt = this.now();
        },
        onMessage: (event) => {
          if (generation !== this.streamGeneration) return;
          this.handleMarketMessage(event);
        },
      },
    );
  }

  closeMarketStream() {
    this.streamGeneration += 1;
    this.marketStream?.close?.();
    this.marketStream = null;
  }

  handleMarketMessage(event) {
    if (Array.isArray(event)) {
      for (const item of event) this.handleMarketMessage(item);
      return;
    }
    if (!event || typeof event !== 'object') return;
    const type = event.event_type || event.eventType;
    if (!type || type === 'PONG') return;
    const now = this.now();
    this.websocket.lastMessageAt = now;
    this.websocket.error = null;
    if (type === 'book') this.applyBookSnapshot(event, now);
    else if (type === 'price_change') this.applyPriceChanges(event, now);
    else if (type === 'best_bid_ask') this.applyBestBidAsk(event, now);
  }

  sideForToken(tokenId) {
    if (!this.market?.tokens) return null;
    const value = String(tokenId || '');
    return Object.entries(this.market.tokens).find(([, token]) => String(token) === value)?.[0] || null;
  }

  normalizeBookLevels(levels, side) {
    return (Array.isArray(levels) ? levels : [])
      .map((level) => ({
        price: Number(level.price),
        size: Number(level.size ?? level.amount),
        availableSize: Number(level.size ?? level.amount),
      }))
      .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
      .sort((a, b) => side === 'asks' ? a.price - b.price : b.price - a.price);
  }

  applyBookSnapshot(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = this.sideForToken(tokenId);
    if (!side) return false;
    const book = {
      bids: this.normalizeBookLevels(event.bids, 'bids'),
      asks: this.normalizeBookLevels(event.asks, 'asks'),
      updatedAt: now,
      sourceTimestamp: Number(event.timestamp) || now,
    };
    this.books[side] = book;
    this.updateQuoteFromBook(side, book, now);
    return true;
  }

  applyPriceChanges(event, now) {
    const changes = Array.isArray(event.price_changes)
      ? event.price_changes
      : Array.isArray(event.priceChanges) ? event.priceChanges : [];
    for (const change of changes) {
      const side = this.sideForToken(change.asset_id || change.assetId);
      const book = side && this.books[side];
      if (!book) continue;
      this.applyLevelChange(book, change);
      book.updatedAt = now;
      book.sourceTimestamp = Number(event.timestamp) || now;
      this.updateQuoteFromBook(side, book, now);
    }
  }

  applyLevelChange(book, change) {
    const price = Number(change.price);
    const size = Number(change.size);
    if (!(price > 0 && price < 1) || !Number.isFinite(size)) return;
    const direction = String(change.side || '').toUpperCase();
    const isAsk = ['SELL', 'ASK', 'ASKS'].includes(direction);
    const isBid = ['BUY', 'BID', 'BIDS'].includes(direction);
    const levels = isAsk ? book.asks : isBid ? book.bids : null;
    if (!levels) return;
    const index = levels.findIndex((level) => Math.abs(level.price - price) < EPSILON);
    if (size <= 0) {
      if (index >= 0) levels.splice(index, 1);
    } else if (index >= 0) {
      levels[index].size = size;
      levels[index].availableSize = size;
    } else {
      levels.push({ price, size, availableSize: size });
    }
    levels.sort((a, b) => isAsk ? a.price - b.price : b.price - a.price);
  }

  applyBestBidAsk(event, now) {
    const side = this.sideForToken(event.asset_id || event.assetId);
    if (!side) return;
    const quote = this.liveQuotes[side] || {};
    const book = this.books[side];
    const bestAsk = Number(event.best_ask ?? event.bestAsk);
    const bestBid = Number(event.best_bid ?? event.bestBid);
    const askLevel = Number.isFinite(bestAsk)
      ? book?.asks.find((level) => Math.abs(level.price - bestAsk) < EPSILON)
      : null;
    const bidLevel = Number.isFinite(bestBid)
      ? book?.bids.find((level) => Math.abs(level.price - bestBid) < EPSILON)
      : null;
    this.liveQuotes[side] = {
      ...quote,
      bestAsk: Number.isFinite(bestAsk) ? bestAsk : quote.bestAsk ?? null,
      askSize: Number.isFinite(bestAsk) ? (askLevel?.availableSize ?? 0) : quote.askSize ?? 0,
      bestBid: Number.isFinite(bestBid) ? bestBid : quote.bestBid ?? null,
      bidSize: Number.isFinite(bestBid) ? (bidLevel?.availableSize ?? 0) : quote.bidSize ?? 0,
      updatedAt: now,
      sourceTimestamp: Number(event.timestamp) || now,
      status: 'LIVE',
    };
  }

  updateQuoteFromBook(side, book, now) {
    const ask = book.asks[0] || null;
    const bid = book.bids[0] || null;
    this.liveQuotes[side] = {
      side,
      bestAsk: ask?.price ?? null,
      askSize: ask?.availableSize ?? 0,
      bestBid: bid?.price ?? null,
      bidSize: bid?.availableSize ?? 0,
      askLevels: book.asks.map((level) => ({ ...level })),
      bidLevels: book.bids.map((level) => ({ ...level })),
      updatedAt: now,
      sourceTimestamp: book.sourceTimestamp,
      status: 'LIVE',
      stale: false,
    };
  }

  getActiveWindowStart() {
    const value = Number(this.market?.start ?? this.windowStart ?? this.orderWindowStart);
    return Number.isFinite(value) ? value : null;
  }

  modelSnapshot(now = this.now()) {
    const windowStart = this.getActiveWindowStart();
    const feed = this.priceFeed.snapshot?.() || {};
    const candles = (feed.candles || []).slice(-config.VOLATILITY_CANDLES);
    const volatility5m = calculateVolatility(candles, config.VOLATILITY_CANDLES);
    const currentCandle = feed.currentCandle;
    const windowOpenPrice = currentCandle
      && Number(currentCandle.start) === windowStart
      && currentCandle.openSource !== 'FIRST_TICK'
      ? Number(currentCandle.open)
      : null;
    const secondsRemaining = windowStart == null
      ? null
      : Math.max(0, (windowStart + config.WINDOW_MS_5M - now) / 1000);
    const tickAt = Number(feed.tickAt);
    const tickAgeMs = Number.isFinite(tickAt) ? Math.max(0, now - tickAt) : null;
    const tickFresh = feed.status === 'CONNECTED'
      && tickAgeMs != null
      && tickAgeMs <= config.MAX_DATA_AGE_MS;
    const historyReady = feed.historyStatus === 'READY'
      && candles.length === config.VOLATILITY_CANDLES
      && volatility5m != null;
    const ready = tickFresh
      && historyReady
      && windowOpenPrice > 0
      && secondsRemaining > 0;
    const probabilityUp = ready ? estimateUpProbability({
      currentPrice: Number(feed.price),
      windowOpenPrice,
      volatility5m,
      secondsRemaining,
    }) : null;
    let reason = 'Waiting for a fresh Binance tick and three closed 5-minute candles.';
    if (feed.error && !tickFresh) reason = `Binance feed: ${feed.error}`;
    else if (!tickFresh) reason = 'Waiting for a Binance tick no more than 2 seconds old.';
    else if (!historyReady) reason = 'Waiting for three closed 5-minute candles.';
    else if (!(windowOpenPrice > 0)) reason = 'Waiting for the official Binance 5-minute candle open.';
    else if (!(secondsRemaining > 0)) reason = 'The current BTC 5-minute window has ended.';
    else reason = 'Signal model ready.';
    return {
      ready,
      reason,
      currentPrice: Number.isFinite(Number(feed.price)) ? Number(feed.price) : null,
      windowOpenPrice: Number.isFinite(windowOpenPrice) ? windowOpenPrice : null,
      secondsRemaining,
      volatility5m,
      volatilityCandles: candles.map((candle) => ({
        start: candle.start,
        open: candle.open,
        close: candle.close,
        logReturn: Math.log(Number(candle.close) / Number(candle.open)),
      })),
      probabilityUp,
      probabilityDown: probabilityUp == null ? null : 1 - probabilityUp,
      tickAt: Number.isFinite(tickAt) ? tickAt : null,
      tickAgeMs,
      feedStatus: feed.status || 'WAITING',
      historyStatus: feed.historyStatus || 'WAITING',
      feedError: feed.error || null,
    };
  }

  getFreshQuote(side, now) {
    const quote = this.liveQuotes?.[side];
    const book = this.books?.[side];
    if (!quote || quote.status !== 'LIVE' || quote.stale) return null;
    const updatedAt = Number(quote.updatedAt);
    const bookUpdatedAt = Number(book?.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt > now || now - updatedAt > config.MAX_DATA_AGE_MS
      || !Number.isFinite(bookUpdatedAt) || bookUpdatedAt > now
      || now - bookUpdatedAt > config.MAX_DATA_AGE_MS) return null;
    return quote;
  }

  buildEntryCandidate(side, probability, market, now) {
    const quote = this.getFreshQuote(side, now);
    if (!quote || !Array.isArray(quote.askLevels)) return null;
    const sweep = sweepLevels(quote.askLevels, config.ENTRY_SHARES, { side: 'BUY', market });
    if (!sweep.complete || !(sweep.gross > 0)) return null;
    const allInCost = sweep.gross + sweep.fees;
    const expectedEdgePerShare = (probability * config.ENTRY_SHARES - allInCost) / config.ENTRY_SHARES;
    return {
      side,
      probability,
      bestAsk: quote.bestAsk,
      expectedEdgePerShare,
      grossCost: sweep.gross,
      entryFees: sweep.fees,
      allInCost,
      fills: sweep.fills,
    };
  }

  async processStrategyEntry(now = this.now()) {
    const windowStart = this.getActiveWindowStart();
    if (windowStart == null) {
      this.signal = { side: null, reason: 'Waiting for the current BTC 5-minute market.' };
      return false;
    }
    if (this.strategyWindowStart !== windowStart) {
      this.strategyWindowStart = windowStart;
      this.entriesThisWindow = 0;
      this.rearmReadyAt = null;
    }

    this.model = this.modelSnapshot(now);
    const elapsedMs = now - windowStart;
    if (!this.model.ready) {
      this.signal = { side: null, reason: this.model.reason, modelReady: false };
      return false;
    }
    if (elapsedMs < config.ENTRY_DELAY_MS) {
      const remaining = Math.ceil((config.ENTRY_DELAY_MS - elapsedMs) / 1000);
      this.signal = {
        side: null,
        reason: `Waiting ${remaining}s after window open before following signals.`,
        modelReady: true,
      };
      return false;
    }
    if (elapsedMs >= config.WINDOW_MS_5M) {
      this.signal = { side: null, reason: 'Window closed; any unfilled position is held to resolution.' };
      return false;
    }
    if (this.rearmReadyAt != null && now < this.rearmReadyAt) {
      this.signal = { side: null, reason: 'Take-profit filled; waiting for the next signal scan.' };
      return false;
    }

    const activePosition = this.positions.find((position) =>
      ['OPEN', 'PENDING_RESOLUTION'].includes(position.status));
    if (activePosition?.status === 'OPEN') return this.processTakeProfit(activePosition, now);
    if (activePosition?.status === 'PENDING_RESOLUTION') {
      this.signal = {
        side: activePosition.side,
        reason: 'Holding the previous position to official resolution; no new entry until it settles.',
      };
      return false;
    }

    const market = this.market || {};
    const candidates = [
      this.buildEntryCandidate('UP', this.model.probabilityUp, market, now),
      this.buildEntryCandidate('DOWN', this.model.probabilityDown, market, now),
    ].filter((candidate) => candidate
      && candidate.expectedEdgePerShare >= config.MIN_NET_EDGE_PER_SHARE);
    candidates.sort((a, b) => b.expectedEdgePerShare - a.expectedEdgePerShare);
    const selected = candidates[0];
    if (!selected) {
      this.signal = {
        side: null,
        reason: `No full 100-share entry has at least $${config.MIN_NET_EDGE_PER_SHARE.toFixed(2)} net edge per share.`,
        modelReady: true,
        probabilityUp: this.model.probabilityUp,
        probabilityDown: this.model.probabilityDown,
      };
      return false;
    }
    if (selected.allInCost > this.cash + EPSILON) {
      this.signal = { side: selected.side, reason: 'Signal qualified, but demo cash is insufficient.' };
      return false;
    }
    return this.openPosition(selected, market, now, windowStart);
  }

  openPosition(candidate, market, now, windowStart) {
    const id = `${windowStart}-btc-${candidate.side.toLowerCase()}-${++this.positionSequence}`;
    const target = calculateTakeProfitLimit({
      market,
      shares: config.ENTRY_SHARES,
      entryGross: candidate.grossCost,
      entryFees: candidate.entryFees,
    });
    const tpOrder = {
      id: `${id}-tp`,
      positionId: id,
      action: 'SELL',
      side: candidate.side,
      orderType: 'LIMIT',
      status: target.possible ? 'RESTING' : 'UNAVAILABLE',
      requestedShares: config.ENTRY_SHARES,
      filledShares: 0,
      remainingShares: config.ENTRY_SHARES,
      limitPrice: target.possible ? target.limitPrice : null,
      targetNetReturn: config.TAKE_PROFIT_NET_RETURN,
      targetNetProceeds: target.targetNetProceeds,
      targetNetProfit: target.targetNetProfit,
      reason: target.reason,
      createdAt: now,
      paperOnly: true,
    };
    const position = {
      id,
      strategyId: 'btc-5m-binance-mispricing-tp50',
      marketId: market.id || market.conditionId || market.slug || null,
      marketSlug: market.slug || null,
      marketTitle: market.title || market.slug || 'BTC 5-minute Up/Down',
      windowStart,
      windowEnd: windowStart + config.WINDOW_MS_5M,
      asset: 'BTC',
      side: candidate.side,
      status: 'OPEN',
      shares: config.ENTRY_SHARES,
      initialShares: config.ENTRY_SHARES,
      entryPrice: candidate.grossCost / config.ENTRY_SHARES,
      totalCost: candidate.grossCost,
      initialTotalCost: candidate.grossCost,
      fees: candidate.entryFees,
      initialFees: candidate.entryFees,
      entryFees: candidate.entryFees,
      openedAt: now,
      filledAt: now,
      markPrice: null,
      unrealizedPnl: null,
      estimatedMakerRebate: 0,
      takeProfitOrder: tpOrder,
      takeProfitTarget: target,
      entryEdgePerShare: candidate.expectedEdgePerShare,
      entryProbability: candidate.probability,
      entryFills: candidate.fills,
      exitProceeds: 0,
      exitFees: 0,
      proceeds: 0,
      realizedPnl: null,
      feeContext: WickBot._test.feeContext(market),
      paperOnly: true,
    };
    const entryOrder = {
      id: `${id}-entry`,
      positionId: id,
      action: 'BUY',
      side: candidate.side,
      orderType: 'PAPER_ASK_SWEEP',
      status: 'FILLED',
      requestedShares: config.ENTRY_SHARES,
      filledShares: config.ENTRY_SHARES,
      remainingShares: 0,
      averagePrice: position.entryPrice,
      grossCost: candidate.grossCost,
      fees: candidate.entryFees,
      createdAt: now,
      filledAt: now,
      paperOnly: true,
    };

    this.cash -= candidate.allInCost;
    this.positions.unshift(position);
    this.orders.unshift(entryOrder, tpOrder);
    this.windowOrders.unshift(entryOrder, tpOrder);
    this.totalOrderAttempts += 2;
    this.entriesThisWindow += 1;
    this.entryTriggeredThisWindow = true;
    this.entryOrderPlaced = true;
    this.lastTakeProfitAt = null;
    this.signal = {
      side: candidate.side,
      reason: `${candidate.side} selected at ${(candidate.probability * 100).toFixed(1)}% model probability and $${candidate.expectedEdgePerShare.toFixed(3)} net edge/share.`,
      expectedEdgePerShare: candidate.expectedEdgePerShare,
      probability: candidate.probability,
      entryOrderId: entryOrder.id,
    };
    this.events.unshift({
      ts: now,
      event: 'ENTRY_FILLED',
      type: 'ENTRY_FILLED',
      message: `Paper bought ${config.ENTRY_SHARES} ${candidate.side} shares at an average ${position.entryPrice.toFixed(3)}.`,
      details: { positionId: id, grossCost: candidate.grossCost, fees: candidate.entryFees },
    });
    if (this.events.length > 200) this.events.length = 200;
    return true;
  }

  processTakeProfit(position, now) {
    const order = position.takeProfitOrder;
    if (!order || order.status !== 'RESTING' || !Number.isFinite(Number(order.limitPrice))) {
      this.signal = {
        side: position.side,
        reason: order?.status === 'UNAVAILABLE'
          ? order.reason
          : 'Holding this position to official resolution; no early flip.',
      };
      return false;
    }
    const quote = this.getFreshQuote(position.side, now);
    if (!quote || !Array.isArray(quote.bidLevels)) {
      this.signal = { side: position.side, reason: 'Take-profit limit is resting; waiting for fresh bid data.' };
      return false;
    }
    const sweep = sweepLevels(quote.bidLevels, position.shares, {
      side: 'SELL',
      minimumPrice: Number(order.limitPrice),
      market: this.market || {},
    });
    if (!sweep.complete) {
      this.signal = {
        side: position.side,
        reason: `Take-profit limit at ${Number(order.limitPrice).toFixed(2)} is resting; full-size bid depth is not available.`,
      };
      return false;
    }
    const allInCost = Number(position.initialTotalCost) + Number(position.initialFees);
    const minimumNetProceeds = allInCost * (1 + config.TAKE_PROFIT_NET_RETURN);
    if (sweep.netProceeds + EPSILON < minimumNetProceeds) {
      this.signal = {
        side: position.side,
        reason: 'Bid sweep did not meet the 50% net-return target after fees; holding to resolution.',
      };
      return false;
    }

    order.status = 'FILLED';
    order.filledShares = sweep.filledShares;
    order.remainingShares = 0;
    order.averagePrice = sweep.averagePrice;
    order.grossProceeds = sweep.gross;
    order.fees = sweep.fees;
    order.fills = sweep.fills;
    order.filledAt = now;
    position.status = 'SETTLED_EXIT';
    position.settledAt = now;
    position.closedAt = now;
    position.exitReason = 'TAKE_PROFIT';
    position.exitType = 'LIMIT';
    position.exitPrice = sweep.averagePrice;
    position.exitProceeds = sweep.gross;
    position.takeProfitProceeds = sweep.gross;
    position.exitFees = sweep.fees;
    position.proceeds = sweep.gross;
    position.realizedPnl = sweep.gross - allInCost - sweep.fees;
    position.unrealizedPnl = 0;
    position.markPrice = sweep.averagePrice;
    position.strategyOutcome = 'WIN';
    position.strategyOutcomeAt = now;
    this.cash += sweep.netProceeds;
    this.lastTakeProfitAt = now;
    this.rearmReadyAt = now + config.POLL_INTERVAL_MS;
    this.entryTriggeredThisWindow = false;
    this.entryOrderPlaced = false;
    this.signal = {
      side: null,
      reason: 'Take-profit filled; rearmed for the next qualifying signal.',
      lastExitPositionId: position.id,
      realizedPnl: position.realizedPnl,
    };
    const orderRecord = this.orders.find((item) => item.id === order.id);
    if (orderRecord) Object.assign(orderRecord, order);
    const windowOrder = this.windowOrders.find((item) => item.id === order.id);
    if (windowOrder) Object.assign(windowOrder, order);
    this.events.unshift({
      ts: now,
      event: 'TAKE_PROFIT_FILLED',
      type: 'TAKE_PROFIT_FILLED',
      message: `Paper limit sell filled all ${sweep.filledShares} ${position.side} shares for a 50%+ net return after fees.`,
      details: { positionId: position.id, proceeds: sweep.gross, fees: sweep.fees, realizedPnl: position.realizedPnl },
    });
    if (this.events.length > 200) this.events.length = 200;
    return true;
  }

  async closePreviousWindows(currentStart, now) {
    const closing = this.positions.filter((position) =>
      position.status === 'OPEN' && Number(position.windowStart) < currentStart);
    const closed = await super.closePreviousWindows(currentStart, now);
    for (const position of closing) {
      if (position.status !== 'PENDING_RESOLUTION') continue;
      const order = position.takeProfitOrder;
      if (!order || order.status !== 'RESTING') continue;
      order.status = 'CANCELLED_WINDOW_END';
      order.cancelledAt = now;
      const orderRecord = this.orders.find((item) => item.id === order.id);
      if (orderRecord) Object.assign(orderRecord, order);
      const windowOrder = this.windowOrders.find((item) => item.id === order.id);
      if (windowOrder) Object.assign(windowOrder, order);
      this.events.unshift({
        ts: now,
        event: 'TAKE_PROFIT_CANCELLED',
        type: 'TAKE_PROFIT_CANCELLED',
        message: 'Unfilled paper take-profit order cancelled at window end; position remains through resolution.',
        details: { positionId: position.id },
      });
    }
    return closed;
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const model = this.model || this.modelSnapshot(now);
    const windowStart = this.getActiveWindowStart();
    const windowEnd = windowStart == null ? null : windowStart + config.WINDOW_MS_5M;
    const pendingPosition = this.positions.find((position) =>
      position.status === 'PENDING_RESOLUTION' && Number(position.windowStart) === windowStart);
    const activePosition = this.positions.find((position) =>
      ['OPEN', 'PENDING_RESOLUTION'].includes(position.status));
    const currentPosition = activePosition || pendingPosition || null;
    const feed = this.priceFeed.snapshot?.() || {};
    const account = {
      ...state.account,
      startingCapital: state.account.capital,
      tradeCount: state.account.totalTrades,
      settledPositions: state.account.settledTrades,
      pendingResolutionPositions: this.positions.filter((position) => position.status === 'PENDING_RESOLUTION').length,
      closedPositions: this.positions.filter((position) => position.status === 'SETTLED_EXIT').length,
    };
    const recentTrades = [...(state.positions || [])].slice(0, 100);
    const quotes = Object.fromEntries(['UP', 'DOWN'].map((side) => {
      const quote = this.liveQuotes[side] || {};
      const bookUpdatedAt = Number(this.books[side]?.updatedAt);
      const quoteUpdatedAt = Number(quote.updatedAt);
      const freshestRequiredAt = Math.min(
        Number.isFinite(bookUpdatedAt) ? bookUpdatedAt : Infinity,
        Number.isFinite(quoteUpdatedAt) ? quoteUpdatedAt : Infinity,
      );
      const ageMs = Number.isFinite(freshestRequiredAt) ? Math.max(0, now - freshestRequiredAt) : null;
      return [side, {
        ...state.livePrices?.[side],
        ...quote,
        ageMs,
        stale: ageMs == null || ageMs > config.MAX_DATA_AGE_MS,
        status: ageMs != null && ageMs <= config.MAX_DATA_AGE_MS ? 'LIVE' : 'STALE',
      }];
    }));
    return {
      ...state,
      now,
      status: state.status === 'blocked_or_error' ? 'ERROR' : 'RUNNING',
      statusReason: this.signal?.reason || state.statusReason || 'Paper strategy is scanning.',
      strategy: {
        ...state.strategy,
        id: 'btc-5m-binance-mispricing-tp50',
        name: 'BTC 5-minute Binance mispricing',
        version: 'btc-5m-binance-mispricing-tp50-v1',
        execution: 'PAPER ONLY',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        baseShares: config.ENTRY_SHARES,
        volatilityLookbackCandles: config.VOLATILITY_CANDLES,
        minimumNetEdgePerShare: config.MIN_NET_EDGE_PER_SHARE,
        entryDelaySeconds: config.ENTRY_DELAY_MS / 1000,
        takeProfitNetReturn: config.TAKE_PROFIT_NET_RETURN,
        takeProfitMaximumPrice: config.TAKE_PROFIT_MAX_PRICE,
        rearmAfterTakeProfit: true,
        maximumConcurrentPositions: 1,
        entries: {
          orderType: 'PAPER_ASK_SWEEP',
          sharesPerSide: config.ENTRY_SHARES,
          entryDelayMs: config.ENTRY_DELAY_MS,
          minimumNetEdgePerShare: config.MIN_NET_EDGE_PER_SHARE,
          orderStatus: activePosition?.status === 'OPEN' ? 'FILLED' : 'NOT_PLACED',
          signal: this.signal,
        },
        exit: {
          orderType: 'PAPER_LIMIT_SELL',
          takeProfitNetReturn: config.TAKE_PROFIT_NET_RETURN,
          stopLoss: null,
          flip: false,
          windowEnd: 'If take-profit does not fill, hold the position to official resolution.',
        },
        timing: 'Wait 10 seconds after window open, then scan on each 500 ms strategy tick.',
        sizing: `One ${config.ENTRY_SHARES}-share entry at a time.`,
        trigger: 'Buy the side with the higher qualifying Binance-derived net edge.',
        exitPolicy: 'Resting paper limit sell for 50% net return after fees; otherwise hold to official resolution.',
      },
      account,
      model,
      signal: this.signal,
      binance: {
        ...feed,
        tickAgeMs: model.tickAgeMs,
        price: model.currentPrice,
      },
      websocket: {
        ...this.websocket,
        detail: 'Polymarket UP/DOWN books and Binance BTC ticks use public WebSocket feeds.',
      },
      quotes,
      market: this.market ? {
        ...this.market,
        title: this.market.title || this.market.slug || 'BTC 5-minute Up/Down',
      } : null,
      window: windowStart == null ? null : {
        start: windowStart,
        end: windowEnd,
        slug: this.market?.slug || `btc-updown-5m-${Math.floor(windowStart / 1000)}`,
        secondsRemaining: Math.max(0, (windowEnd - now) / 1000),
      },
      position: currentPosition ? {
        ...currentPosition,
        markPrice: quotes[currentPosition.side]?.bestBid ?? currentPosition.markPrice,
        unrealizedPnl: currentPosition.status === 'OPEN'
          && Number.isFinite(Number(quotes[currentPosition.side]?.bestBid))
          ? Number(quotes[currentPosition.side].bestBid) * currentPosition.shares
            - currentPosition.totalCost - currentPosition.fees
          : currentPosition.unrealizedPnl,
      } : null,
      trades: recentTrades,
      persistence: { status: 'MEMORY ONLY', detail: 'Railway restarts reset paper history.' },
      rearm: {
        enabled: true,
        entriesThisWindow: this.entriesThisWindow,
        readyAt: this.rearmReadyAt,
        lastTakeProfitAt: this.lastTakeProfitAt,
      },
    };
  }
}

MispricingBot._test = {
  calculateVolatility,
  estimateUpProbability,
  calculateTakeProfitLimit,
  normalCdf,
  sweepLevels,
};

module.exports = MispricingBot;
