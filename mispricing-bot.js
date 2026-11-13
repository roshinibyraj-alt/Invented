'use strict';

const config = require('./config');
const WickBot = require('./wick-bot');
const BinanceTickFeed = require('./binance-tick-feed');
const defaultMarketData = require('./wick-market-data');

const { takerFeeFor } = WickBot._test;
const SECONDS_PER_WINDOW = config.WINDOW_MS_5M / 1000;
const EPSILON = 1e-8;

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
    .filter((candle) => candle?.closed !== false
      && Number(candle?.open) > 0 && Number(candle?.close) > 0)
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

function sweepLevels(levels, shares, {
  side,
  minimumPrice = 0,
  maximumPriceExclusive = Infinity,
  market,
} = {}) {
  const ordered = (Array.isArray(levels) ? levels : [])
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.availableSize ?? level.size),
    }))
    .filter((level) => level.price >= 0 && level.price <= 1 && level.size > 0)
    .filter((level) => side === 'SELL' ? level.price + EPSILON >= minimumPrice : true)
    .filter((level) => side === 'BUY' ? level.price < maximumPriceExclusive : true)
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

class MispricingBot extends WickBot {
  constructor({
    marketData = defaultMarketData,
    priceFeed = null,
    now = Date.now,
    initialCapital = config.DEMO_CAPITAL,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    super({
      strategyId: 'btc-5m-binance-mispricing-2candle-dual-tp',
      strategyName: 'BTC 5-minute Binance dual-side take-profit paper strategy',
      timeframe: '5m',
      windowMs: config.WINDOW_MS_5M,
      capital: initialCapital,
      rules: {
        sharesPerSide: config.ENTRY_SHARES,
        entryDelayMs: config.ENTRY_DELAY_MS,
        minimumNetEdgePerShare: config.MIN_NET_EDGE_PER_SHARE,
        maximumEntryPriceExclusive: config.ENTRY_MAX_PRICE_EXCLUSIVE,
        takeProfitMultiplier: config.TAKE_PROFIT_MULTIPLIER,
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
    this.entryTriggeredThisWindow = false;
    this.sideEntryCountsThisWindow = { UP: 0, DOWN: 0 };
    this.sideSignals = {
      UP: { status: 'WAITING', reason: 'Waiting for a qualifying UP signal.' },
      DOWN: { status: 'WAITING', reason: 'Waiting for a qualifying DOWN signal.' },
    };
    this.positionSequence = 0;
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
    let reason = `Waiting for a fresh Binance tick and ${config.VOLATILITY_CANDLES} closed 5-minute candles.`;
    if (feed.error && !tickFresh) reason = `Binance feed: ${feed.error}`;
    else if (!tickFresh) reason = 'Waiting for a Binance tick no more than 2 seconds old.';
    else if (!historyReady) reason = `Waiting for ${config.VOLATILITY_CANDLES} closed 5-minute candles.`;
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

  sweep(side, bookSide, shares, {
    now = this.now(),
    consume = false,
    minimumPrice = 0,
    maximumPriceExclusive = Infinity,
  } = {}) {
    const quote = this.getFreshQuote(side, now);
    const book = this.books?.[side];
    const levels = book?.[bookSide];
    if (!quote || !Array.isArray(levels) || !levels.length) return null;
    const isBuy = bookSide === 'asks';
    const quotedBest = Number(isBuy ? quote.bestAsk : quote.bestBid);
    const bookBest = Number(levels[0]?.price);
    if (!Number.isFinite(quotedBest) || !Number.isFinite(bookBest)
      || Math.abs(quotedBest - bookBest) > EPSILON) return null;
    const execution = sweepLevels(levels, shares, {
      side: isBuy ? 'BUY' : 'SELL',
      minimumPrice,
      maximumPriceExclusive,
      market: this.market || {},
    });
    if (!execution.complete) return execution;
    if (consume) {
      for (const fill of execution.fills) {
        let remaining = Number(fill.shares);
        for (const level of levels) {
          if (Math.abs(Number(level.price) - Number(fill.price)) > EPSILON || remaining <= EPSILON) continue;
          const available = Number(level.availableSize ?? level.size);
          const used = Math.min(remaining, available);
          level.availableSize = Math.max(0, available - used);
          remaining -= used;
        }
      }
      this.updateQuoteFromBook(side, book, now);
    }
    return {
      ...execution,
      totalCost: isBuy ? execution.gross + execution.fees : null,
      netProceeds: isBuy ? null : execution.gross - execution.fees,
    };
  }

  buildEntryCandidate(side, probability, market, now) {
    const execution = this.sweep(side, 'asks', config.ENTRY_SHARES, {
      now,
      maximumPriceExclusive: config.ENTRY_MAX_PRICE_EXCLUSIVE,
    });
    if (!execution?.complete || !(execution.gross > 0)) return null;
    const allInCost = execution.totalCost;
    const expectedEdgePerShare = (probability * config.ENTRY_SHARES - allInCost) / config.ENTRY_SHARES;
    return {
      side,
      probability,
      bestAsk: this.liveQuotes[side]?.bestAsk ?? null,
      expectedEdgePerShare,
      grossCost: execution.gross,
      entryFees: execution.fees,
      allInCost,
      fills: execution.fills,
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
      this.entryTriggeredThisWindow = false;
      this.sideEntryCountsThisWindow = { UP: 0, DOWN: 0 };
    }

    this.sideSignals = { UP: null, DOWN: null };
    const takeProfitsFilled = this.processTakeProfits(windowStart, now);
    this.model = this.modelSnapshot(now);
    if (!this.model.ready) {
      this.signal = { side: null, reason: this.model.reason, modelReady: false };
      for (const side of ['UP', 'DOWN']) {
        if (!this.sideSignals[side]) {
          this.sideSignals[side] = {
            status: this.hasOpenPosition(side, windowStart) ? 'OPEN' : 'WAITING',
            reason: this.model.reason,
          };
        }
      }
      return takeProfitsFilled > 0;
    }

    const elapsedMs = now - windowStart;
    if (elapsedMs >= config.WINDOW_MS_5M) {
      this.signal = { side: null, reason: 'Window closed; open positions wait for official resolution.' };
      return takeProfitsFilled > 0;
    }

    const market = this.market || {};
    const candidates = [];
    for (const [side, probability] of [
      ['UP', this.model.probabilityUp],
      ['DOWN', this.model.probabilityDown],
    ]) {
      if (this.hasOpenPosition(side, windowStart)) {
        if (!this.sideSignals[side]) {
          const position = this.getOpenPosition(side, windowStart);
          this.sideSignals[side] = {
            status: 'OPEN',
            reason: `${side} position is open with take-profit at $${position.takeProfitPrice.toFixed(3)}.`,
            positionId: position.id,
          };
        }
        continue;
      }

      const quote = this.getFreshQuote(side, now);
      if (!quote) {
        this.sideSignals[side] = {
          status: 'WAITING_FOR_FRESH_BOOK',
          reason: 'Waiting for a fresh Polymarket ask and full visible depth.',
        };
        continue;
      }
      if (!(Number(quote.bestAsk) < config.ENTRY_MAX_PRICE_EXCLUSIVE)) {
        this.sideSignals[side] = {
          status: 'ASK_AT_OR_ABOVE_LIMIT',
          reason: `Waiting for the ${side} ask to fall below $${config.ENTRY_MAX_PRICE_EXCLUSIVE.toFixed(2)}.`,
        };
        continue;
      }

      const candidate = this.buildEntryCandidate(side, probability, market, now);
      if (!candidate) {
        this.sideSignals[side] = {
          status: 'WAITING_FOR_FULL_DEPTH',
          reason: `Waiting for a complete ${config.ENTRY_SHARES}-share ask sweep below $${config.ENTRY_MAX_PRICE_EXCLUSIVE.toFixed(2)}.`,
        };
        continue;
      }
      if (candidate.expectedEdgePerShare < config.MIN_NET_EDGE_PER_SHARE) {
        this.sideSignals[side] = {
          status: 'EDGE_TOO_LOW',
          reason: `Net model edge is ${candidate.expectedEdgePerShare.toFixed(3)} per share; needs $${config.MIN_NET_EDGE_PER_SHARE.toFixed(2)}.`,
          expectedEdgePerShare: candidate.expectedEdgePerShare,
        };
        continue;
      }
      this.sideSignals[side] = {
        status: 'QUALIFIED',
        reason: `Qualified at ${candidate.bestAsk.toFixed(3)} ask and ${candidate.expectedEdgePerShare.toFixed(3)} net edge/share.`,
        expectedEdgePerShare: candidate.expectedEdgePerShare,
      };
      candidates.push(candidate);
    }

    candidates.sort((a, b) => b.expectedEdgePerShare - a.expectedEdgePerShare);
    const enteredSides = [];
    for (const candidate of candidates) {
      if (candidate.allInCost > this.cash + EPSILON) {
        this.sideSignals[candidate.side] = {
          status: 'INSUFFICIENT_CASH',
          reason: 'Signal qualified, but demo cash cannot fund the full entry.',
        };
        continue;
      }
      const execution = this.sweep(candidate.side, 'asks', config.ENTRY_SHARES, {
        now,
        consume: true,
        maximumPriceExclusive: config.ENTRY_MAX_PRICE_EXCLUSIVE,
      });
      if (!execution?.complete) {
        this.sideSignals[candidate.side] = {
          status: 'WAITING_FOR_FULL_DEPTH',
          reason: 'The full qualifying ask depth changed before the entry filled.',
        };
        continue;
      }
      this.openPosition(candidate, execution, market, now, windowStart);
      enteredSides.push(candidate.side);
    }

    if (enteredSides.length) {
      this.signal = {
        side: enteredSides.length === 1 ? enteredSides[0] : null,
        sides: enteredSides,
        reason: `${enteredSides.join(' and ')} entered independently; each has its own 50% take-profit.`,
        modelReady: true,
      };
    } else if (takeProfitsFilled > 0) {
      this.signal = {
        side: null,
        reason: 'Take-profit filled; that side is re-armed for another qualifying signal.',
        modelReady: true,
      };
    } else if (takeProfitsFilled === 0) {
      this.signal = {
        side: null,
        reason: 'No side currently meets the signal, price, full-depth, and net-edge entry rules.',
        modelReady: true,
        probabilityUp: this.model.probabilityUp,
        probabilityDown: this.model.probabilityDown,
      };
    }
    return enteredSides.length > 0 || takeProfitsFilled > 0;
  }

  hasOpenPosition(side, windowStart) {
    return Boolean(this.getOpenPosition(side, windowStart));
  }

  getOpenPosition(side, windowStart) {
    return this.positions.find((position) => position.status === 'OPEN'
      && Number(position.windowStart) === Number(windowStart)
      && position.side === side) || null;
  }

  processTakeProfits(windowStart, now) {
    let filledCount = 0;
    const openPositions = this.positions.filter((position) =>
      position.status === 'OPEN' && Number(position.windowStart) === Number(windowStart));

    for (const position of openPositions) {
      const order = position.takeProfitOrder;
      if (!order || order.status !== 'RESTING') continue;

      const available = this.sweep(position.side, 'bids', position.shares, {
        now,
        minimumPrice: order.limitPrice,
      });
      if (!available?.complete) {
        const quote = this.getFreshQuote(position.side, now);
        if (Number(quote?.bestBid) + EPSILON >= order.limitPrice) {
          this.sideSignals[position.side] = {
            status: 'TAKE_PROFIT_WAITING_FOR_DEPTH',
            reason: `Take-profit reached; waiting for full ${position.shares}-share bid depth at or above $${order.limitPrice.toFixed(3)}.`,
            positionId: position.id,
          };
        }
        continue;
      }

      const execution = this.sweep(position.side, 'bids', position.shares, {
        now,
        consume: true,
        minimumPrice: order.limitPrice,
      });
      if (!execution?.complete) continue;
      this.closePosition(position, execution, now);
      this.sideSignals[position.side] = {
        status: 'TAKE_PROFIT_FILLED',
        reason: `${position.side} take-profit filled; that side is re-armed for another signal.`,
        positionId: position.id,
      };
      filledCount += 1;
    }
    return filledCount;
  }

  openPosition(candidate, execution, market, now, windowStart) {
    const id = `${windowStart}-btc-${candidate.side.toLowerCase()}-${++this.positionSequence}`;
    const takeProfitPrice = Math.ceil(
      execution.averagePrice * config.TAKE_PROFIT_MULTIPLIER * 1000 - EPSILON,
    ) / 1000;
    const position = {
      id,
      strategyId: 'btc-5m-binance-mispricing-2candle-dual-tp',
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
      entryPrice: execution.averagePrice,
      totalCost: execution.gross,
      initialTotalCost: execution.gross,
      fees: execution.fees,
      initialFees: execution.fees,
      entryFees: execution.fees,
      openedAt: now,
      filledAt: now,
      markPrice: null,
      unrealizedPnl: null,
      estimatedMakerRebate: 0,
      entryEdgePerShare: candidate.expectedEdgePerShare,
      entryProbability: candidate.probability,
      entryFills: execution.fills,
      takeProfitPrice,
      takeProfitMultiplier: config.TAKE_PROFIT_MULTIPLIER,
      takeProfitProceeds: 0,
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
      orderType: 'PAPER_ASK_SWEEP_BELOW_0_50',
      status: 'FILLED',
      requestedShares: config.ENTRY_SHARES,
      filledShares: config.ENTRY_SHARES,
      remainingShares: 0,
      averagePrice: position.entryPrice,
      grossCost: execution.gross,
      fees: execution.fees,
      fills: execution.fills,
      windowStart,
      createdAt: now,
      filledAt: now,
      paperOnly: true,
    };
    const takeProfitOrder = {
      id: `${id}-take-profit`,
      positionId: id,
      action: 'SELL',
      side: candidate.side,
      orderType: 'PAPER_LIMIT_TAKE_PROFIT',
      status: 'RESTING',
      requestedShares: config.ENTRY_SHARES,
      filledShares: 0,
      remainingShares: config.ENTRY_SHARES,
      limitPrice: takeProfitPrice,
      createdAt: now,
      windowStart,
      paperOnly: true,
    };
    position.takeProfitOrder = takeProfitOrder;
    position.takeProfitOrderId = takeProfitOrder.id;
    this.cash -= execution.totalCost;
    this.positions.unshift(position);
    this.orders.unshift(takeProfitOrder);
    this.orders.unshift(entryOrder);
    this.windowOrders.unshift(entryOrder);
    this.totalOrderAttempts += 1;
    this.entryTriggeredThisWindow = true;
    this.sideEntryCountsThisWindow[candidate.side] += 1;
    this.entryOrderPlaced = true;
    this.entryOrderId = entryOrder.id;
    this.entryTriggerLatched = true;
    this.entryTriggerAt = now;
    this.entryTriggerSide = candidate.side;
    this.entryTriggerReason = `${candidate.side} qualifying model signal`;
    this.sideSignals[candidate.side] = {
      status: 'OPEN',
      reason: `${candidate.side} entered at $${position.entryPrice.toFixed(3)}; take-profit is $${takeProfitPrice.toFixed(3)}.`,
      positionId: id,
      takeProfitPrice,
      entriesThisWindow: this.sideEntryCountsThisWindow[candidate.side],
    };
    this.signal = {
      side: candidate.side,
      reason: `${candidate.side} entered below $${config.ENTRY_MAX_PRICE_EXCLUSIVE.toFixed(2)} with $${candidate.expectedEdgePerShare.toFixed(3)} net edge/share.`,
      expectedEdgePerShare: candidate.expectedEdgePerShare,
      probability: candidate.probability,
      entryOrderId: entryOrder.id,
    };
    this.events.unshift({
      ts: now,
      at: now,
      event: 'ENTRY_FILLED',
      type: 'ENTRY_FILLED',
      message: `Paper bought ${config.ENTRY_SHARES} ${candidate.side} shares at an average ${position.entryPrice.toFixed(3)}; take-profit set at ${takeProfitPrice.toFixed(3)}.`,
      details: { positionId: id, grossCost: execution.gross, fees: execution.fees, fills: execution.fills },
    });
    if (this.events.length > 200) this.events.length = 200;
    return true;
  }

  closePosition(position, execution, now) {
    const order = position.takeProfitOrder;
    order.status = 'FILLED';
    order.filledShares = execution.filledShares;
    order.remainingShares = 0;
    order.averagePrice = execution.averagePrice;
    order.grossProceeds = execution.gross;
    order.fees = execution.fees;
    order.fills = execution.fills;
    order.filledAt = now;
    const netProceeds = execution.netProceeds;
    position.status = 'SETTLED_EXIT';
    position.settlementStatus = 'TAKE_PROFIT_FILLED';
    position.closedAt = now;
    position.settledAt = now;
    position.settlementBasis = 'PAPER_TAKE_PROFIT';
    position.exitReason = 'TAKE_PROFIT';
    position.exitType = 'PAPER_LIMIT_TAKE_PROFIT';
    position.exitPrice = execution.averagePrice;
    position.exitBid = execution.averagePrice;
    position.exitProceeds = execution.gross;
    position.takeProfitProceeds = execution.gross;
    position.exitFees = execution.fees;
    position.proceeds = execution.gross;
    position.realizedPnl = netProceeds - Number(position.totalCost) - Number(position.fees || 0);
    position.outcome = position.realizedPnl > 0 ? 'WIN'
      : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN';
    position.markPrice = execution.averagePrice;
    position.unrealizedPnl = 0;
    position.exitFills = execution.fills;
    this.cash += netProceeds;
    this.totalOrderAttempts += 1;
    this.recordStrategyOutcome(position, position.outcome, now, 'TAKE_PROFIT');
    this.events.unshift({
      ts: now,
      at: now,
      event: 'PAPER_TAKE_PROFIT_FILLED',
      type: 'PAPER_TAKE_PROFIT_FILLED',
      message: `Paper take-profit sold all ${execution.filledShares} ${position.side} shares at an average ${execution.averagePrice.toFixed(3)} for a net result of $${position.realizedPnl.toFixed(2)}.`,
      details: {
        positionId: position.id,
        grossProceeds: execution.gross,
        exitFees: execution.fees,
        realizedPnl: position.realizedPnl,
        fills: execution.fills,
      },
    });
    if (this.events.length > 200) this.events.length = 200;
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const model = this.model || this.modelSnapshot(now);
    const windowStart = this.getActiveWindowStart();
    const windowEnd = windowStart == null ? null : windowStart + config.WINDOW_MS_5M;
    const currentPositions = this.positions.filter((position) =>
      position.status === 'OPEN' && Number(position.windowStart) === Number(windowStart));
    const feed = this.priceFeed.snapshot?.() || {};
    const account = {
      ...state.account,
      startingCapital: state.account.capital,
      tradeCount: state.account.totalTrades,
      openPositions: this.positions.filter((position) => position.status === 'OPEN').length,
      settledPositions: state.account.settledTrades,
      pendingResolutionPositions: this.positions.filter((position) => position.status === 'PENDING_RESOLUTION').length,
      closedPositions: this.positions.filter((position) =>
        ['CLOSED', 'SETTLED_EXIT'].includes(position.status)).length,
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
    const displayPosition = (position) => {
      if (!position) return null;
      const markPrice = quotes[position.side]?.bestBid ?? position.markPrice;
      const unrealizedPnl = position.status === 'OPEN' && Number.isFinite(Number(markPrice))
        ? Number(markPrice) * position.shares - position.totalCost - position.fees
        : position.unrealizedPnl;
      return { ...position, markPrice, unrealizedPnl };
    };
    const openWindowPositions = currentPositions.map(displayPosition);
    const positionsBySide = Object.fromEntries(['UP', 'DOWN'].map((side) => [
      side,
      openWindowPositions.find((position) => position.side === side) || null,
    ]));
    return {
      ...state,
      now,
      status: state.status === 'blocked_or_error' ? 'ERROR' : 'RUNNING',
      statusReason: this.signal?.reason || state.statusReason || 'Paper strategy is scanning.',
      strategy: {
        ...state.strategy,
        id: 'btc-5m-binance-mispricing-2candle-dual-tp',
        name: 'BTC 5-minute Binance independent-side take-profit strategy',
        version: 'btc-5m-binance-mispricing-2candle-v3',
        execution: 'PAPER ONLY',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        baseShares: config.ENTRY_SHARES,
        volatilityLookbackCandles: config.VOLATILITY_CANDLES,
        minimumNetEdgePerShare: config.MIN_NET_EDGE_PER_SHARE,
        entryPriceCeilingExclusive: config.ENTRY_MAX_PRICE_EXCLUSIVE,
        takeProfitMultiplier: config.TAKE_PROFIT_MULTIPLIER,
        entryDelaySeconds: config.ENTRY_DELAY_MS / 1000,
        maximumOpenPositionsPerWindow: 2,
        maximumOpenPositionsPerSide: 1,
        reentryAfterTakeProfit: true,
        sideEntryCountsThisWindow: { ...this.sideEntryCountsThisWindow },
        sideSignals: { ...this.sideSignals },
        unresolvedPositionsBlockNextWindow: false,
        entries: {
          orderType: 'PAPER_ASK_SWEEP_BELOW_0_50',
          sharesPerSide: config.ENTRY_SHARES,
          entryDelayMs: config.ENTRY_DELAY_MS,
          minimumNetEdgePerShare: config.MIN_NET_EDGE_PER_SHARE,
          maximumPriceExclusive: config.ENTRY_MAX_PRICE_EXCLUSIVE,
          oneOpenPositionPerSide: true,
          entryCountBySide: { ...this.sideEntryCountsThisWindow },
          triggeredThisWindow: this.entryTriggeredThisWindow,
          orderStatus: currentPositions.length ? 'FILLED' : 'NOT_PLACED',
          signal: this.signal,
        },
        exit: {
          orderType: 'PAPER_LIMIT_TAKE_PROFIT',
          takeProfitMultiplier: config.TAKE_PROFIT_MULTIPLIER,
          fullFillOnly: true,
          stopLoss: null,
          flip: { enabled: false },
          windowEnd: 'Cancel unfilled take-profit orders at window end; hold remaining positions to official resolution.',
        },
        timing: 'Scan immediately and every 500 ms; manage UP and DOWN entries and take-profits independently.',
        sizing: `${config.ENTRY_SHARES} shares per entry; at most one open position per side, re-armed after that side takes profit.`,
        trigger: `Each side qualifies independently when its full ask sweep is below $${config.ENTRY_MAX_PRICE_EXCLUSIVE.toFixed(2)} and net model edge is at least $${config.MIN_NET_EDGE_PER_SHARE.toFixed(2)} per share.`,
        exitPolicy: `Place a resting limit sell at ${config.TAKE_PROFIT_MULTIPLIER.toFixed(1)}x entry price; if it does not fill, hold to official resolution.`,
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
      openWindowPositions,
      positionsBySide,
      sideEntryCountsThisWindow: { ...this.sideEntryCountsThisWindow },
      sideSignals: { ...this.sideSignals },
      position: openWindowPositions[0] || null,
      trades: recentTrades,
      persistence: { status: 'MEMORY ONLY', detail: 'Railway restarts reset paper history.' },
    };
  }
}

MispricingBot._test = {
  calculateVolatility,
  estimateUpProbability,
  normalCdf,
  sweepLevels,
};

module.exports = MispricingBot;
