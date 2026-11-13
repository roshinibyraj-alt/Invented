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

function sweepLevels(levels, shares, { side, minimumPrice = 0, market } = {}) {
  const ordered = (Array.isArray(levels) ? levels : [])
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.availableSize ?? level.size),
    }))
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

class MispricingBot extends WickBot {
  constructor({
    marketData = defaultMarketData,
    priceFeed = null,
    now = Date.now,
    initialCapital = config.DEMO_CAPITAL,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    super({
      strategyId: 'btc-5m-binance-mispricing-2candle-flip',
      strategyName: 'BTC 5-minute Binance mispricing paper strategy',
      timeframe: '5m',
      windowMs: config.WINDOW_MS_5M,
      capital: initialCapital,
      rules: {
        sharesPerSide: config.ENTRY_SHARES,
        entryDelayMs: config.ENTRY_DELAY_MS,
        minimumNetEdgePerShare: config.MIN_NET_EDGE_PER_SHARE,
        minimumFlipNetEdgePerShare: config.MIN_FLIP_NET_EDGE_PER_SHARE,
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
    this.flipsThisWindow = 0;
    this.flipConfirmation = { side: null, count: 0, lastTickAt: null };
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

  resetFlipConfirmation() {
    this.flipConfirmation = { side: null, count: 0, lastTickAt: null };
  }

  recordFlipConfirmation(side, model, now) {
    const tickAt = Number(model?.tickAt);
    if (!Number.isFinite(tickAt) || tickAt > now
      || now - tickAt > config.MAX_DATA_AGE_MS) {
      this.resetFlipConfirmation();
      return false;
    }
    const state = this.flipConfirmation;
    if (state.side !== side || state.lastTickAt == null) {
      this.flipConfirmation = { side, count: 1, lastTickAt: tickAt };
      return false;
    }
    if (tickAt <= state.lastTickAt) return false;
    const interval = tickAt - state.lastTickAt;
    if (interval > config.FLIP_CONFIRMATION_MAX_INTERVAL_MS) {
      this.flipConfirmation = { side, count: 1, lastTickAt: tickAt };
      return false;
    }
    if (interval < config.FLIP_CONFIRMATION_MIN_INTERVAL_MS) return false;
    this.flipConfirmation = { side, count: state.count + 1, lastTickAt: tickAt };
    return this.flipConfirmation.count >= config.FLIP_CONFIRMATION_UPDATES;
  }

  sweep(side, bookSide, shares, { now = this.now(), consume = false } = {}) {
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
    const execution = this.sweep(side, 'asks', config.ENTRY_SHARES, { now });
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
      this.flipsThisWindow = 0;
      this.resetFlipConfirmation();
    }

    this.model = this.modelSnapshot(now);
    if (!this.model.ready) {
      this.resetFlipConfirmation();
      this.signal = { side: null, reason: this.model.reason, modelReady: false };
      return false;
    }
    const currentPosition = this.positions.find((position) =>
      position.status === 'OPEN' && Number(position.windowStart) === windowStart);
    if (currentPosition) return this.evaluateFlip(currentPosition, now);

    const elapsedMs = now - windowStart;
    if (elapsedMs >= config.WINDOW_MS_5M) {
      this.resetFlipConfirmation();
      this.signal = { side: null, reason: 'Window closed; any open position waits for official resolution.' };
      return false;
    }
    if (this.entryTriggeredThisWindow) {
      this.signal = { ...this.signal, reason: 'This window already used its entry; waiting for official resolution.' };
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
        reason: `No complete 100-share ask sweep has at least $${config.MIN_NET_EDGE_PER_SHARE.toFixed(2)} net edge per share.`,
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
    const execution = this.sweep(selected.side, 'asks', config.ENTRY_SHARES, { now, consume: true });
    if (!execution?.complete) {
      this.signal = { side: selected.side, reason: 'The full 100-share ask sweep is no longer available.' };
      return false;
    }
    return this.openPosition(selected, execution, market, now, windowStart);
  }

  evaluateFlip(position, now) {
    const windowEnd = Number(position.windowStart) + config.WINDOW_MS_5M;
    if (now >= windowEnd) {
      this.resetFlipConfirmation();
      this.signal = { side: position.side, reason: 'Window ended; holding this position for official resolution.' };
      return false;
    }
    if (this.flipsThisWindow >= config.MAX_FLIPS_PER_WINDOW) {
      this.resetFlipConfirmation();
      this.signal = { side: position.side, reason: 'Maximum one profitable flip reached; holding for official resolution.' };
      return false;
    }

    const oppositeSide = position.side === 'UP' ? 'DOWN' : 'UP';
    const liquidation = this.sweep(position.side, 'bids', position.shares, { now });
    if (!liquidation?.complete) {
      this.resetFlipConfirmation();
      this.signal = { side: position.side, reason: 'Holding: fresh visible bid depth cannot sell all shares.' };
      return false;
    }
    const realizedIfClosed = liquidation.netProceeds - Number(position.totalCost) - Number(position.fees || 0);
    if (realizedIfClosed <= EPSILON) {
      this.resetFlipConfirmation();
      this.signal = {
        side: position.side,
        reason: `Holding: a full sell sweep would not be profitable after fees (${realizedIfClosed.toFixed(2)}).`,
        liquidationPnl: realizedIfClosed,
      };
      return false;
    }

    const oppositeProbability = oppositeSide === 'UP'
      ? this.model.probabilityUp : this.model.probabilityDown;
    const candidate = this.buildEntryCandidate(oppositeSide, oppositeProbability, this.market || {}, now);
    if (!candidate || candidate.expectedEdgePerShare < config.MIN_FLIP_NET_EDGE_PER_SHARE) {
      this.resetFlipConfirmation();
      this.signal = {
        side: position.side,
        reason: `Holding: opposite side needs at least $${config.MIN_FLIP_NET_EDGE_PER_SHARE.toFixed(2)} net edge per share.`,
        oppositeSide,
        oppositeEdgePerShare: candidate?.expectedEdgePerShare ?? null,
      };
      return false;
    }
    if (this.cash + liquidation.netProceeds + EPSILON < candidate.allInCost) {
      this.resetFlipConfirmation();
      this.signal = { side: position.side, reason: 'Holding: demo cash after the sell cannot fund the full opposite entry.' };
      return false;
    }
    if (!this.recordFlipConfirmation(oppositeSide, this.model, now)) {
      this.signal = {
        side: position.side,
        reason: `Opposite ${oppositeSide} signal is profitable; confirming fresh Binance update ${this.flipConfirmation.count}/${config.FLIP_CONFIRMATION_UPDATES}.`,
        oppositeSide,
        oppositeEdgePerShare: candidate.expectedEdgePerShare,
        confirmation: { ...this.flipConfirmation },
      };
      return false;
    }

    const sale = this.sweep(position.side, 'bids', position.shares, { now, consume: true });
    if (!sale?.complete) {
      this.resetFlipConfirmation();
      this.signal = { side: position.side, reason: 'Flip cancelled: full visible bid depth disappeared before selling.' };
      return false;
    }
    this.closePosition(position, sale, now, oppositeSide);
    const purchase = this.sweep(oppositeSide, 'asks', config.ENTRY_SHARES, { now, consume: true });
    if (!purchase?.complete) {
      this.resetFlipConfirmation();
      this.signal = { side: null, reason: 'Flip sell completed, but the full opposite ask sweep became unavailable.' };
      return true;
    }
    const flippedCandidate = {
      ...candidate,
      grossCost: purchase.gross,
      entryFees: purchase.fees,
      allInCost: purchase.totalCost,
      fills: purchase.fills,
    };
    this.flipsThisWindow += 1;
    this.openPosition(flippedCandidate, purchase, this.market || {}, now, Number(position.windowStart), true);
    this.resetFlipConfirmation();
    this.signal = {
      side: oppositeSide,
      reason: `Profitable flip: sold ${position.side} and bought ${oppositeSide} after two fresh Binance confirmations.`,
      expectedEdgePerShare: candidate.expectedEdgePerShare,
      probability: oppositeProbability,
      flipCount: this.flipsThisWindow,
    };
    return true;
  }

  openPosition(candidate, execution, market, now, windowStart, isFlip = false) {
    const id = `${windowStart}-btc-${candidate.side.toLowerCase()}-${++this.positionSequence}`;
    const position = {
      id,
      strategyId: 'btc-5m-binance-mispricing-2candle-flip',
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
      exitProceeds: 0,
      exitFees: 0,
      proceeds: 0,
      realizedPnl: null,
      feeContext: WickBot._test.feeContext(market),
      paperOnly: true,
      openedByFlip: isFlip,
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
      grossCost: execution.gross,
      fees: execution.fees,
      fills: execution.fills,
      createdAt: now,
      filledAt: now,
      paperOnly: true,
    };
    this.cash -= execution.totalCost;
    this.positions.unshift(position);
    this.orders.unshift(entryOrder);
    this.windowOrders.unshift(entryOrder);
    this.totalOrderAttempts += 1;
    this.entryTriggeredThisWindow = true;
    this.entryOrderPlaced = true;
    this.entryOrderId = entryOrder.id;
    this.entryTriggerLatched = true;
    this.entryTriggerAt = now;
    this.entryTriggerSide = candidate.side;
    this.entryTriggerReason = `${candidate.side} qualifying model signal`;
    if (!isFlip) {
      this.signal = {
        side: candidate.side,
        reason: `${candidate.side} selected at ${(candidate.probability * 100).toFixed(1)}% model probability and $${candidate.expectedEdgePerShare.toFixed(3)} net edge/share.`,
        expectedEdgePerShare: candidate.expectedEdgePerShare,
        probability: candidate.probability,
        entryOrderId: entryOrder.id,
      };
    }
    this.events.unshift({
      ts: now,
      at: now,
      event: isFlip ? 'FLIP_ENTRY_FILLED' : 'ENTRY_FILLED',
      type: isFlip ? 'FLIP_ENTRY_FILLED' : 'ENTRY_FILLED',
      message: `Paper bought ${config.ENTRY_SHARES} ${candidate.side} shares at an average ${position.entryPrice.toFixed(3)}${isFlip ? ' after a profitable flip' : ''}.`,
      details: { positionId: id, grossCost: execution.gross, fees: execution.fees, fills: execution.fills },
    });
    if (this.events.length > 200) this.events.length = 200;
    return true;
  }

  closePosition(position, execution, now, oppositeSide) {
    const order = {
      id: `${position.id}-flip-exit-${now}`,
      positionId: position.id,
      action: 'SELL',
      side: position.side,
      orderType: 'PAPER_BID_SWEEP',
      status: 'FILLED',
      requestedShares: position.shares,
      filledShares: execution.filledShares,
      remainingShares: 0,
      averagePrice: execution.averagePrice,
      grossProceeds: execution.gross,
      fees: execution.fees,
      fills: execution.fills,
      createdAt: now,
      filledAt: now,
      paperOnly: true,
    };
    const netProceeds = execution.netProceeds;
    position.status = 'CLOSED';
    position.settlementStatus = 'CLOSED';
    position.closedAt = now;
    position.exitReason = 'PROFITABLE_MODEL_FLIP';
    position.exitType = 'PAPER_BID_SWEEP';
    position.exitSide = oppositeSide;
    position.exitPrice = execution.averagePrice;
    position.exitProceeds = execution.gross;
    position.exitFees = execution.fees;
    position.proceeds = execution.gross;
    position.realizedPnl = netProceeds - Number(position.totalCost) - Number(position.fees || 0);
    position.outcome = 'EXIT';
    position.strategyOutcome = null;
    position.markPrice = execution.averagePrice;
    position.unrealizedPnl = 0;
    position.exitFills = execution.fills;
    this.cash += netProceeds;
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.totalOrderAttempts += 1;
    this.events.unshift({
      ts: now,
      at: now,
      event: 'PROFITABLE_MODEL_FLIP_EXIT',
      type: 'PROFITABLE_MODEL_FLIP_EXIT',
      message: `Paper sold all ${execution.filledShares} ${position.side} shares for a net exit profit of $${position.realizedPnl.toFixed(2)} before buying ${oppositeSide}.`,
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
    const currentPosition = this.positions.find((position) =>
      position.status === 'OPEN' && Number(position.windowStart) === windowStart) || null;
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
    return {
      ...state,
      now,
      status: state.status === 'blocked_or_error' ? 'ERROR' : 'RUNNING',
      statusReason: this.signal?.reason || state.statusReason || 'Paper strategy is scanning.',
      strategy: {
        ...state.strategy,
        id: 'btc-5m-binance-mispricing-2candle-flip',
        name: 'BTC 5-minute Binance mispricing with profitable flip',
        version: 'btc-5m-binance-mispricing-2candle-v2',
        execution: 'PAPER ONLY',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        baseShares: config.ENTRY_SHARES,
        volatilityLookbackCandles: config.VOLATILITY_CANDLES,
        minimumNetEdgePerShare: config.MIN_NET_EDGE_PER_SHARE,
        minimumFlipNetEdgePerShare: config.MIN_FLIP_NET_EDGE_PER_SHARE,
        entryDelaySeconds: config.ENTRY_DELAY_MS / 1000,
        flipConfirmationUpdates: config.FLIP_CONFIRMATION_UPDATES,
        flipConfirmationMinIntervalMs: config.FLIP_CONFIRMATION_MIN_INTERVAL_MS,
        flipConfirmationMaxIntervalMs: config.FLIP_CONFIRMATION_MAX_INTERVAL_MS,
        flipConfirmation: { ...this.flipConfirmation },
        flipsThisWindow: this.flipsThisWindow,
        maximumFlipsPerWindow: config.MAX_FLIPS_PER_WINDOW,
        maximumOpenPositionsPerWindow: 1,
        unresolvedPositionsBlockNextWindow: false,
        entries: {
          orderType: 'PAPER_ASK_SWEEP',
          sharesPerSide: config.ENTRY_SHARES,
          entryDelayMs: config.ENTRY_DELAY_MS,
          minimumNetEdgePerShare: config.MIN_NET_EDGE_PER_SHARE,
          triggeredThisWindow: this.entryTriggeredThisWindow,
          orderStatus: currentPosition ? 'FILLED' : 'NOT_PLACED',
          signal: this.signal,
        },
        exit: {
          orderType: 'PAPER_BID_SWEEP_ON_PROFITABLE_FLIP',
          stopLoss: null,
          flip: {
            enabled: true,
            maximumPerWindow: config.MAX_FLIPS_PER_WINDOW,
            minimumNetEdgePerShare: config.MIN_FLIP_NET_EDGE_PER_SHARE,
            confirmationUpdates: config.FLIP_CONFIRMATION_UPDATES,
            minimumUpdateIntervalMs: config.FLIP_CONFIRMATION_MIN_INTERVAL_MS,
            maximumUpdateIntervalMs: config.FLIP_CONFIRMATION_MAX_INTERVAL_MS,
          },
          windowEnd: 'Without an eligible profitable flip, hold the position to official resolution.',
        },
        timing: 'Scan immediately and every 500 ms; require fresh data for entries and flips.',
        sizing: `${config.ENTRY_SHARES} shares per entry; at most one profitable opposite-side flip per window.`,
        trigger: 'Buy the side with the higher qualifying Binance-derived net edge.',
        exitPolicy: 'Only sell all shares to flip when the exit is profitable after fees and the opposite entry qualifies; otherwise wait for official resolution.',
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
