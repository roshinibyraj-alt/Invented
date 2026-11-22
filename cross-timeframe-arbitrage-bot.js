'use strict';

const config = require('./config');
const WickBot = require('./wick-bot');
const defaultMarketData = require('./wick-market-data');
const BinanceBeatFeed = require('./binance-beat-feed');

const { quoteFromBook, takerFeeFor, feeContext } = WickBot._test;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const STRATEGY = Object.freeze({
  id: 'btc-fixed-direction-5m-down-15m-up-paper',
  name: 'BTC fixed-direction 5m/15m paper strategy',
  version: 'btc-fixed-directions-v10-no-ask-sum',
  quantity: 300,
  sweepPriceCeiling: 0.99,
  takeProfitTrigger: 0.99,
  takeProfitPayout: 1.00,
  maxQuoteAgeMs: 15_000,
  pairMarketRefreshMs: 15_000,
  beatVolatilityWindowMs: 60_000,
  minimumBeatToleranceUsd: 2,
  maximumBeatToleranceUsd: 100,
});
const SIDES = ['UP', 'DOWN'];
const TIMEFRAMES = ['5m', '15m'];
const EPSILON = 1e-8;

function marketKey(market) {
  return String(market?.id || market?.conditionId || market?.slug || market?.start || '');
}

function readMarketTime(market, key, fallback) {
  const rawValue = market?.raw?.[key];
  const parsed = rawValue == null ? NaN : Date.parse(rawValue);
  return Number.isFinite(parsed) ? parsed : Number(fallback);
}

function actualMarketStart(market) {
  return readMarketTime(market, 'eventStartTime', market?.start);
}

function actualMarketEnd(market) {
  return readMarketTime(market, 'endDate', market?.end);
}

function fiveMinuteSlotIndex(market5m, market15m) {
  const fiveStart = actualMarketStart(market5m);
  const fifteenStart = actualMarketStart(market15m);
  if (!Number.isFinite(fiveStart) || !Number.isFinite(fifteenStart)) return null;
  const offset = fiveStart - fifteenStart;
  const slot = Math.round(offset / FIVE_MINUTES_MS);
  if (slot < 0 || slot > 2 || Math.abs(offset - slot * FIVE_MINUTES_MS) > 1000) return null;
  return slot;
}

function normalizeTimestamp(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (Number.isFinite(number)) return number > 0 && number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeLevels(levels, descending) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price)
      && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}

function synchronizedMarkets(market5m, market15m) {
  if (!market5m || !market15m) return false;
  const end5 = actualMarketEnd(market5m);
  const end15 = actualMarketEnd(market15m);
  return Number.isFinite(end5) && Number.isFinite(end15) && end5 === end15;
}

function validPairMarkets(market5m, market15m) {
  if (!market5m || !market15m) return false;
  const start5 = actualMarketStart(market5m);
  const end5 = actualMarketEnd(market5m);
  const start15 = actualMarketStart(market15m);
  const end15 = actualMarketEnd(market15m);
  const expectedEnd5 = start5 + FIVE_MINUTES_MS;
  const expectedEnd15 = start15 + FIFTEEN_MINUTES_MS;
  return [start5, end5, start15, end15].every(Number.isFinite)
    && Math.abs(end5 - expectedEnd5) <= 1000
    && Math.abs(end15 - expectedEnd15) <= 1000
    && start15 <= start5 + 1000
    && end15 >= end5 - 1000;
}

function getQuotePairSum(upQuote, downQuote) {
  const up = Number(upQuote?.bestAsk);
  const down = Number(downQuote?.bestAsk);
  if (!(up > 0 && up < 1 && down > 0 && down < 1)) return null;
  return up + down;
}

function detectOpportunity({
  market5m,
  market15m,
  quotes,
}) {
  if (!validPairMarkets(market5m, market15m)) {
    return { exists: false, case: null, reason: 'The current 5-minute market is not contained in the active 15-minute market.' };
  }
  const fiveMinuteSlot = fiveMinuteSlotIndex(market5m, market15m);
  const upQuote = quotes?.['15m']?.UP;
  const downQuote = quotes?.['5m']?.DOWN;
  const upPrice = Number(upQuote?.bestAsk);
  const downPrice = Number(downQuote?.bestAsk);
  if (!(upPrice > 0 && upPrice < 1) || !(downPrice > 0 && downPrice < 1)) {
    return {
      exists: false,
      case: 'FIXED',
      direction: { upMarket: '15m', downMarket: '5m' },
      selectionMode: 'FIXED_TIMEFRAME_SIDES',
      reason: 'Waiting for fresh asks on 15m UP and 5m DOWN; combined asks do not gate entry.',
    };
  }
  const sum = upPrice + downPrice;
  const selected = {
    case: 'FIXED',
    direction: { upMarket: '15m', downMarket: '5m' },
    legs: [
      { timeframe: '15m', side: 'UP', market: market15m, quote: upQuote },
      { timeframe: '5m', side: 'DOWN', market: market5m, quote: downQuote },
    ],
    prices: { upPrice, downPrice, sumPrice: sum },
    selectionMode: 'FIXED_TIMEFRAME_SIDES',
    askSumTarget: null,
    askSumThresholds: [],
    qualifyingThresholds: [],
    askSumUnderTarget: null,
    endTime: actualMarketEnd(market5m),
    fiveMinuteSlot,
  };
  return {
    ...selected,
    exists: true,
    waitingForAskSum: false,
    reason: `Fixed entry for 5-minute slot ${fiveMinuteSlot + 1}: buy ${STRATEGY.quantity} UP shares in the active 15m market and ${STRATEGY.quantity} DOWN shares in this 5m market. Combined asks are informational only.`,
  };
}

class CrossTimeframeArbitrageBot extends WickBot {
  constructor({
    marketData = defaultMarketData,
    binanceFeed = null,
    now = Date.now,
    initialCapital = config.DEMO_CAPITAL,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    super({
      timeframe: '5m',
      windowMs: FIVE_MINUTES_MS,
      capital: initialCapital,
      strategyId: STRATEGY.id,
      strategyName: STRATEGY.name,
      rules: { sharesPerSide: STRATEGY.quantity },
      marketData,
    });
    this.strategyId = STRATEGY.id;
    this.strategyName = STRATEGY.name;
    this.rules = { sharesPerSide: STRATEGY.quantity, quantityPerLeg: STRATEGY.quantity };
    this.marketData = marketData;
    this.now = now;
    this.WebSocketImpl = WebSocketImpl;
    this.binanceFeed = binanceFeed || new BinanceBeatFeed({ WebSocketImpl, now });
    this.currentVolatility = null;
    this.pairMarkets = { '5m': null, '15m': null };
    this.pairBooks = this.emptyBookPair();
    this.pairQuotes = this.emptyQuotePair();
    this.books = { UP: null, DOWN: null };
    this.tokenRefs = new Map();
    this.pairKey = null;
    this.pairMarketRefreshAt = 0;
    this.marketStream = null;
    this.streamGeneration = 0;
    this.currentBeatPrices = { '5m': null, '15m': null };
    this.lastBeatWindow = { '5m': null, '15m': null };
    this.processedFiveMinuteEntries = new Set();
    this.pairs = [];
    this.pairSequence = 0;
    this.orderSequence = 0;
    this.lastEvaluationAt = null;
    this.opportunity = {
      status: 'WAITING',
      reason: 'Waiting for the current BTC 5-minute market and its active 15-minute market.',
    };
    this.signal = { action: 'WAIT', reason: this.opportunity.reason };
    this.websocket = {
      status: 'WAITING',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
  }

  emptyBookPair() {
    return Object.fromEntries(TIMEFRAMES.map((timeframe) => [
      timeframe,
      Object.fromEntries(SIDES.map((side) => [side, { bids: [], asks: [], updatedAt: null }])),
    ]));
  }

  emptyQuotePair() {
    return Object.fromEntries(TIMEFRAMES.map((timeframe) => [
      timeframe,
      Object.fromEntries(SIDES.map((side) => [side, { status: 'MISSING' }])),
    ]));
  }

  stop() {
    super.stop();
    this.closeMarketStream();
    this.binanceFeed?.stop?.();
  }

  start() {
    this.binanceFeed?.start?.();
    super.start();
  }

  openStrategyWindow(start, now) {
    super.openStrategyWindow(start, now);
    this.opportunity = {
      status: 'WAITING',
      reason: 'Checking the current 5-minute window against its active 15-minute market.',
      windowStart: start,
    };
    this.signal = { action: 'WAIT', reason: this.opportunity.reason };
  }

  async refreshLiveQuotes(now = this.now()) {
    if (!this.market) return;
    if (Number(this.lastBeatWindow['5m']) !== Number(this.market.start)) {
      this.lastBeatWindow['5m'] = Number(this.market.start);
      this.currentBeatPrices['5m'] = null;
    }
    this.pairMarkets['5m'] = this.market;
    const fifteenStart = Math.floor(Number(this.market.start) / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
    const fifteenMarket = this.pairMarkets['15m'];
    if (!fifteenMarket || Number(fifteenMarket.start) !== fifteenStart
      || now - this.pairMarketRefreshAt >= STRATEGY.pairMarketRefreshMs) {
      this.pairMarketRefreshAt = now;
      try {
        this.pairMarkets['15m'] = await this.marketData.getBtcMarket(fifteenStart, FIFTEEN_MINUTES_MS);
        this.pairMarketError = null;
      } catch (error) {
        this.pairMarkets['15m'] = null;
        this.pairMarketError = error?.message || 'The BTC 15-minute market could not be loaded.';
      }
    }

    const five = this.pairMarkets['5m'];
    const fifteen = this.pairMarkets['15m'];
    if (fifteen && Number(this.lastBeatWindow['15m']) !== Number(fifteen.start)) {
      this.lastBeatWindow['15m'] = Number(fifteen.start);
      this.currentBeatPrices['15m'] = null;
    }
    for (const timeframe of TIMEFRAMES) {
      const market = this.pairMarkets[timeframe];
      if (market) void this.getBeatPrice(market, now);
    }
    const nextKey = five && fifteen
      ? `${marketKey(five)}|${marketKey(fifteen)}`
      : five ? `${marketKey(five)}|NO_15M_MARKET` : null;

    if (nextKey !== this.pairKey) {
      this.closeMarketStream();
      this.pairKey = nextKey;
      this.pairBooks = this.emptyBookPair();
      this.pairQuotes = this.emptyQuotePair();
      this.rebuildTokenRefs();
      if (five) {
        this.startMarketStream();
      }
    }

    for (const side of SIDES) {
      const quote = this.pairQuotes['5m'][side];
      this.liveQuotes[side] = quote ? { ...quote } : { status: 'MISSING' };
      this.books[side] = this.pairBooks['5m'][side];
    }
    this.updatePositionMarks(now);
  }

  rebuildTokenRefs() {
    this.tokenRefs.clear();
    for (const timeframe of TIMEFRAMES) {
      const market = this.pairMarkets[timeframe];
      if (!market?.tokens) continue;
      for (const side of SIDES) {
        const tokenId = market.tokens[side];
        if (tokenId) this.tokenRefs.set(String(tokenId), { timeframe, side });
      }
    }
  }

  applyBookSnapshot(timeframe, side, book, now = this.now()) {
    if (!TIMEFRAMES.includes(timeframe) || !SIDES.includes(side) || !book) return false;
    const updatedAt = normalizeTimestamp(book.timestamp, now);
    this.pairBooks[timeframe][side] = {
      bids: normalizeLevels(book.bids, true),
      asks: normalizeLevels(book.asks, false),
      updatedAt,
    };
    this.pairQuotes[timeframe][side] = quoteFromBook(this.pairBooks[timeframe][side], updatedAt);
    this.updatePositionMarks(now, timeframe, side);
    this.syncBaseQuotes();
    return true;
  }

  applyPriceChange(timeframe, side, price, size, updatedAt, bookSide) {
    const book = this.pairBooks[timeframe]?.[side];
    if (!book) return false;
    const value = Number(price);
    const quantity = Number(size);
    if (!(value > 0 && value < 1) || !Number.isFinite(quantity) || quantity < 0) return false;
    const isBid = String(bookSide).toUpperCase() === 'BUY';
    const levels = isBid ? book.bids : book.asks;
    const existing = levels.find((level) => Math.abs(level.price - value) < EPSILON);
    if (quantity <= EPSILON) {
      if (existing) levels.splice(levels.indexOf(existing), 1);
    } else if (existing) {
      existing.size = quantity;
    } else {
      levels.push({ price: value, size: quantity });
    }
    levels.sort((a, b) => isBid ? b.price - a.price : a.price - b.price);
    book.updatedAt = updatedAt;
    this.pairQuotes[timeframe][side] = quoteFromBook(book, updatedAt);
    this.updatePositionMarks(this.now(), timeframe, side);
    this.syncBaseQuotes();
    return true;
  }

  handleMarketMessage(event) {
    if (Array.isArray(event)) {
      for (const item of event) this.handleMarketMessage(item);
      return;
    }
    if (!event || typeof event !== 'object') return;
    const now = this.now();
    const type = String(event.event_type || event.eventType || '').toLowerCase();
    const eventTime = normalizeTimestamp(event.timestamp, now);
    const apply = (change) => {
      const tokenId = String(change?.asset_id || change?.assetId || event.asset_id || event.assetId || '');
      const ref = this.tokenRefs.get(tokenId);
      if (!ref) return;
      if (String(change?.side || '').toUpperCase() === 'BUY') {
        this.applyPriceChange(ref.timeframe, ref.side, change.price, change.size, eventTime, 'BUY');
      } else if (String(change?.side || '').toUpperCase() === 'SELL') {
        this.applyPriceChange(ref.timeframe, ref.side, change.price, change.size, eventTime, 'SELL');
      }
    };

    if (type === 'book') {
      const tokenId = String(event.asset_id || event.assetId || '');
      const ref = this.tokenRefs.get(tokenId);
      if (ref) this.applyBookSnapshot(ref.timeframe, ref.side, event, eventTime);
    } else if (type === 'price_change' || type === 'price_changes') {
      const changes = Array.isArray(event.price_changes) ? event.price_changes : [event];
      for (const change of changes) apply(change);
    }
    this.websocket.lastMessageAt = now;
  }

  startMarketStream() {
    this.closeMarketStream();
    const tokenIds = [...this.tokenRefs.keys()];
    if (!tokenIds.length || typeof this.marketData.connectMarketStream !== 'function') {
      this.websocket = {
        ...this.websocket,
        status: 'ERROR',
        error: 'Polymarket market WebSocket is unavailable.',
      };
      return;
    }
    const generation = this.streamGeneration;
    this.websocket = { ...this.websocket, status: 'CONNECTING', error: null };
    this.marketStream = this.marketData.connectMarketStream(tokenIds, {
      WebSocketImpl: this.WebSocketImpl,
      heartbeatMs: 10_000,
      reconnectMinMs: 1_000,
      reconnectMaxMs: 15_000,
      onStatus: (update) => {
        if (generation !== this.streamGeneration) return;
        const wasConnected = this.websocket.status === 'CONNECTED';
        const connectedNow = update.status === 'CONNECTED' && !wasConnected;
        this.websocket = {
          ...this.websocket,
          ...update,
          ...(connectedNow ? { connectedAt: this.now(), lastMessageAt: null } : {}),
        };
        if (connectedNow) {
          this.pairBooks = this.emptyBookPair();
          this.pairQuotes = this.emptyQuotePair();
          this.syncBaseQuotes();
        } else if (update.heartbeat) {
          const heartbeatAt = this.now();
          this.websocket.lastMessageAt = heartbeatAt;
          this.refreshBookHeartbeats(heartbeatAt);
        }
      },
      onMessage: (message) => {
        if (generation === this.streamGeneration) this.handleMarketMessage(message);
      },
    });
  }

  refreshBookHeartbeats(now) {
    for (const timeframe of TIMEFRAMES) {
      for (const side of SIDES) {
        const book = this.pairBooks[timeframe]?.[side];
        if (!book || !this.pairQuotes[timeframe]?.[side]) continue;
        book.updatedAt = now;
        this.pairQuotes[timeframe][side] = quoteFromBook(book, now);
        this.updatePositionMarks(now, timeframe, side);
      }
    }
    this.syncBaseQuotes();
  }

  closeMarketStream() {
    this.streamGeneration += 1;
    this.marketStream?.close?.();
    this.marketStream = null;
  }

  syncBaseQuotes() {
    for (const side of SIDES) {
      this.liveQuotes[side] = this.pairQuotes['5m'][side] || { status: 'MISSING' };
      this.books[side] = this.pairBooks['5m'][side];
    }
  }

  updatePositionMarks(now = this.now(), timeframe = null, side = null) {
    for (const position of this.positions) {
      if (position.status !== 'OPEN') continue;
      if (timeframe && (position.timeframe !== timeframe || position.side !== side)) continue;
      const quote = this.pairQuotes[position.timeframe]?.[position.side];
      if (quote?.bestBid != null && Number.isFinite(Number(quote.updatedAt))) {
        const bestBid = Number(quote.bestBid);
        position.markBid = bestBid;
        position.markPrice = bestBid;
        position.markUpdatedAt = Number(quote.updatedAt);
        position.markStatus = now - position.markUpdatedAt <= STRATEGY.maxQuoteAgeMs ? 'LIVE' : 'STALE';
        if (position.markStatus === 'LIVE' && bestBid >= STRATEGY.takeProfitTrigger - EPSILON) {
          this.finalizeTakeProfit(position, bestBid, now);
        }
      }
    }
  }

  finalizeTakeProfit(position, triggerBid, now = this.now()) {
    if (position.status !== 'OPEN' || Number(triggerBid) < STRATEGY.takeProfitTrigger - EPSILON) return false;
    const shares = Number(position.shares) || 0;
    const proceeds = shares * STRATEGY.takeProfitPayout;
    const totalCost = Number(position.initialTotalCost ?? position.totalCost) || 0;
    const entryFees = Number(position.initialFees ?? position.fees) || 0;
    const exitFees = Number(position.exitFees) || 0;
    position.takeProfitTrigger = STRATEGY.takeProfitTrigger;
    position.takeProfitPayout = STRATEGY.takeProfitPayout;
    position.takeProfitProceeds = proceeds;
    position.resolutionProceeds = 0;
    position.proceeds = proceeds + (Number(position.exitProceeds) || 0) + (Number(position.mergeProceeds) || 0);
    position.payout = STRATEGY.takeProfitPayout;
    position.realizedPnl = position.proceeds - totalCost - entryFees - exitFees
      + (Number(position.estimatedMakerRebate) || 0);
    position.status = 'SETTLED_EXIT';
    position.settledAt = now;
    position.settlementBasis = 'TAKE_PROFIT_099';
    position.exitReason = 'TAKE_PROFIT_099';
    position.exitType = 'TAKE_PROFIT';
    position.exitPrice = STRATEGY.takeProfitPayout;
    position.exitBid = Number(triggerBid);
    position.exitFees = exitFees;
    position.exitFills = [{
      price: STRATEGY.takeProfitPayout,
      triggerBid: Number(triggerBid),
      shares,
      at: now,
      orderType: 'PAPER_TAKE_PROFIT',
    }];
    position.markValue = 0;
    position.unrealizedPnl = 0;
    position.markStatus = 'CLOSED';
    this.cash += proceeds;
    const outcome = position.realizedPnl > EPSILON ? 'WIN'
      : position.realizedPnl < -EPSILON ? 'LOSS' : 'BREAK_EVEN';
    this.recordStrategyOutcome(position, outcome, now, 'TAKE_PROFIT_099');
    this.log('PAPER_TAKE_PROFIT_FILLED', {
      positionId: position.id,
      pairId: position.pairId,
      timeframe: position.timeframe,
      side: position.side,
      shares,
      triggerBid: Number(triggerBid),
      assumedExitPrice: STRATEGY.takeProfitPayout,
      proceeds,
      entryFees,
      realizedPnl: position.realizedPnl,
    });
    this.updatePairSettlement(position.pairId, now);
    return true;
  }

  updatePairSettlement(pairId, now = this.now()) {
    if (!pairId) return null;
    const pair = this.pairs.find((item) => item.id === pairId);
    if (!pair) return null;
    const legs = this.positions.filter((item) => item.pairId === pairId);
    pair.settledLegs = legs.filter((item) => item.status === 'SETTLED_EXIT').length;
    pair.legResults = legs.map((item) => ({
      timeframe: item.timeframe,
      side: item.side,
      status: item.status,
      exitReason: item.exitReason || null,
      exitPrice: item.exitPrice ?? null,
      realizedPnl: item.realizedPnl ?? null,
    }));
    if (pair.settledLegs === legs.length && legs.length === 2) {
      pair.status = 'SETTLED';
      pair.settledAt = Math.max(...legs.map((item) => Number(item.settledAt) || now));
      pair.realizedPnl = legs.reduce((sum, item) => sum + (Number(item.realizedPnl) || 0), 0);
      pair.outcome = pair.realizedPnl > EPSILON ? 'WIN'
        : pair.realizedPnl < -EPSILON ? 'LOSS' : 'BREAK_EVEN';
      this.log('PAPER_PAIR_SETTLED', {
        pairId: pair.id,
        outcome: pair.outcome,
        realizedPnl: pair.realizedPnl,
        legResults: legs.map((item) => ({
          timeframe: item.timeframe,
          side: item.side,
          exitReason: item.exitReason,
          winner: item.resolutionWinner || null,
          pnl: item.realizedPnl,
        })),
      });
    } else if (pair.settledLegs > 0) {
      pair.status = 'PARTIALLY_SETTLED';
    }
    return pair;
  }

  async getBeatPrice(market, now) {
    const start = actualMarketStart(market);
    if (!Number.isFinite(start) || Math.abs(start - Number(market.start)) > 1000) {
      return { value: null, source: null, error: 'Market-start timestamp does not match its window.' };
    }
    const binanceBeat = this.binanceFeed?.status === 'CONNECTED'
      ? this.binanceFeed?.getBeatPriceAt?.(start)
      : null;
    if (binanceBeat?.value > 0) {
      this.setCurrentBeatPrice(market, binanceBeat);
      return binanceBeat;
    }
    const waiting = {
      value: null,
      source: 'BINANCE_WS_ONLY',
      error: this.binanceFeed?.status === 'CONNECTED'
        ? 'No Binance WebSocket tick was captured within 2 seconds of this market start.'
        : 'Waiting for the Binance WebSocket connection.',
    };
    this.setCurrentBeatPrice(market, waiting);
    return waiting;
  }

  async closePreviousWindows(_currentStart, now = this.now()) {
    const activeOrderStatuses = ['PENDING', 'LIVE', 'MARKET_PENDING', 'PARTIALLY_FILLED', 'RESTING'];
    const expiredOrders = this.orders.filter((order) => order.action === 'BUY'
      && activeOrderStatuses.includes(order.status)
      && (order.status !== 'PARTIALLY_FILLED' || Number(order.remainingShares) > 0)
      && Number(order.windowEnd || (Number(order.windowStart) + this.windowMs)) <= now);
    const expiringPositions = this.positions.filter((position) => position.status === 'OPEN'
      && Number(position.windowEnd) > 0 && Number(position.windowEnd) <= now);
    if (!expiredOrders.length && !expiringPositions.length) return 0;

    for (const order of expiredOrders) {
      order.status = 'CANCELLED_WINDOW_END';
      order.expiredAt = now;
      order.remainingShares = 0;
    }
    const previousStarts = new Set([
      ...expiredOrders.map((order) => order.windowStart),
      ...expiringPositions.map((position) => position.windowStart),
    ]);
    for (const windowStart of previousStarts) {
      if (Number.isFinite(Number(windowStart)) && !this.completedWindows.has(windowStart)) {
        this.completedWindows.set(windowStart, {
          completedAt: now,
          reason: expiringPositions.some((position) => position.windowStart === windowStart)
            ? 'PENDING_POLYMARKET_RESOLUTION'
            : 'WINDOW_END',
        });
      }
    }
    for (const position of expiringPositions) {
      position.status = 'PENDING_RESOLUTION';
      position.pendingResolutionSince = now;
      position.markStatus = 'PENDING_RESOLUTION';
      position.markValue = null;
      position.unrealizedPnl = null;
      if (position.takeProfitOrder?.status === 'RESTING') {
        position.takeProfitOrder.status = 'CANCELLED_WINDOW_END';
        position.takeProfitOrder.cancelledAt = now;
      }
      this.log('PAPER_POSITION_AWAITING_POLYMARKET_RESOLUTION', {
        id: position.id,
        windowStart: position.windowStart,
        windowEnd: position.windowEnd,
        side: position.side,
        shares: position.shares,
        marketId: position.marketId,
        strategyOutcome: position.strategyOutcome,
      });
    }
    for (const windowStart of previousStarts) {
      this.log('PAPER_WINDOW_ROLLED_OVER', {
        windowStart,
        currentStart: this.orderWindowStart,
        closedPositions: expiringPositions.filter((position) => position.windowStart === windowStart).length,
        cancelledOrders: expiredOrders.filter((order) => order.windowStart === windowStart).length,
      });
    }
    return expiringPositions.length;
  }

  setCurrentBeatPrice(market, value) {
    for (const timeframe of TIMEFRAMES) {
      const current = this.pairMarkets[timeframe];
      if (current && marketKey(current) === marketKey(market)) {
        this.currentBeatPrices[timeframe] = value;
        return;
      }
    }
  }

  async processStrategyEntry(now = this.now()) {
    this.lastEvaluationAt = now;
    const market5m = this.pairMarkets['5m'] || this.market;
    const market15m = this.pairMarkets['15m'];
    if (!market5m || !market15m) {
      const reason = this.pairMarketError || 'Waiting for the active BTC 15-minute market.';
      this.setWaitingOpportunity(reason, 'WAITING_FOR_MARKETS');
      return false;
    }
    if (!validPairMarkets(market5m, market15m)) {
      this.setWaitingOpportunity('The active 15-minute market does not contain the current 5-minute window.', 'INVALID_MARKET_TIMES');
      return false;
    }
    const fiveMinuteSlot = fiveMinuteSlotIndex(market5m, market15m);
    if (fiveMinuteSlot == null) {
      this.setWaitingOpportunity(
        'The active 5-minute market is outside the three slots in its 15-minute window.',
        'OUTSIDE_FIVE_MINUTE_SLOTS',
      );
      return false;
    }
    if (now >= actualMarketEnd(market5m)) {
      this.setWaitingOpportunity('The 5-minute window ended before the fixed-side entry could fill.', 'WINDOW_EXPIRED');
      return false;
    }

    const volatility = this.binanceFeed?.getVolatilityBand?.(now) || {
      ready: false,
      bandUsd: null,
      rangeUsd: null,
      sampleCount: 0,
      lastTickAgeMs: null,
    };
    this.currentVolatility = volatility;
    const lastPolymarketMessageAt = Number(this.websocket.lastMessageAt);
    if (this.websocket.status !== 'CONNECTED'
      || !Number.isFinite(lastPolymarketMessageAt)
      || now - lastPolymarketMessageAt > STRATEGY.maxQuoteAgeMs) {
      this.setWaitingOpportunity('Waiting for fresh Polymarket WebSocket book updates.', 'WAITING_FOR_POLYMARKET_WS', {
        volatility,
      });
      return false;
    }

    const quotes = this.getFreshPairQuotes(now);
    const opportunity = detectOpportunity({
      market5m,
      market15m,
      quotes,
    });
    this.opportunity = {
      ...opportunity,
      status: opportunity.exists ? 'ENTRY_SELECTED' : 'WAITING_FOR_BOOKS',
      checkedAt: now,
      volatility,
      fiveMinuteSlot,
      entryTiers: [],
    };
    this.signal = {
      action: opportunity.exists ? 'FIXED_ENTRY_READY' : 'WAIT',
      case: 'FIXED',
      selectionMode: opportunity.selectionMode || null,
      reason: opportunity.reason,
    };

    if (!opportunity.exists) {
      return false;
    }

    const entryKey = `${marketKey(market5m)}:${Number(actualMarketStart(market5m))}`;
    if (this.processedFiveMinuteEntries.has(entryKey)
      || this.pairs.some((pair) => pair.market5mId === marketKey(market5m))) {
      this.opportunity = {
        ...this.opportunity,
        status: 'WINDOW_ENTRY_COMPLETE',
        reason: 'The fixed 5m DOWN + 15m UP entry is already recorded for this 5-minute window.',
      };
      this.signal = { action: 'WINDOW_ENTRY_COMPLETE', reason: this.opportunity.reason };
      return false;
    }

    const entered = this.executePaperPair(opportunity, now);
    if (!entered) return false;
    this.processedFiveMinuteEntries.add(entryKey);
    while (this.processedFiveMinuteEntries.size > 1500) {
      this.processedFiveMinuteEntries.delete(this.processedFiveMinuteEntries.values().next().value);
    }
    return true;
  }

  setWaitingOpportunity(reason, status, extra = {}) {
    this.opportunity = { status, reason, checkedAt: this.now(), ...extra };
    this.signal = { action: 'WAIT', reason };
  }

  getFreshPairQuotes(now) {
    const result = {};
    for (const timeframe of TIMEFRAMES) {
      result[timeframe] = {};
      for (const side of SIDES) {
        if (!((timeframe === '15m' && side === 'UP') || (timeframe === '5m' && side === 'DOWN'))) {
          result[timeframe][side] = null;
          continue;
        }
        const quote = this.pairQuotes[timeframe]?.[side];
        const updatedAt = Number(quote?.updatedAt);
        const fresh = quote && Number.isFinite(updatedAt)
          && now - updatedAt <= STRATEGY.maxQuoteAgeMs
          && Number(quote.bestAsk) > 0 && Number(quote.bestAsk) < 1;
        result[timeframe][side] = fresh ? quote : null;
      }
    }
    return result;
  }

  simulateBuy(leg, quantity, now, orderType) {
    const book = this.pairBooks[leg.timeframe]?.[leg.side];
    const quote = this.pairQuotes[leg.timeframe]?.[leg.side];
    if (!book || !quote || !Array.isArray(book.asks) || !book.asks.length) return null;
    const bestAsk = Number(quote.bestAsk);
    const priceCap = STRATEGY.sweepPriceCeiling;
    const requestedShares = Number(quantity);
    let remaining = requestedShares;
    let grossCost = 0;
    let fees = 0;
    const fills = [];
    for (const level of [...book.asks].sort((a, b) => a.price - b.price)) {
      if (remaining <= EPSILON) break;
      if (level.price > priceCap + EPSILON) break;
      const available = Number(level.size);
      if (!(available > 0)) continue;
      const shares = Math.min(remaining, available);
      const levelGross = shares * level.price;
      const levelFees = takerFeeFor(leg.market, level.price, shares);
      fills.push({ price: level.price, shares, at: now });
      grossCost += levelGross;
      fees += levelFees;
      remaining -= shares;
    }
    const filledShares = requestedShares - remaining;
    if (filledShares + EPSILON < requestedShares) {
      return {
        complete: false,
        requestedShares,
        filledShares,
        remainingShares: remaining,
        bestAsk,
        priceCap,
        grossCost,
        fees,
        averagePrice: filledShares > EPSILON ? grossCost / filledShares : null,
        fills,
      };
    }
    return {
      complete: true,
      requestedShares,
      filledShares,
      remainingShares: 0,
      bestAsk,
      priceCap,
      grossCost,
      fees,
      averagePrice: grossCost / filledShares,
      fills,
    };
  }

  executePaperPair(opportunity, now) {
    const orderType = 'PAPER_MARKET_FOK';
    const executions = opportunity.legs.map((leg) =>
      this.simulateBuy(leg, STRATEGY.quantity, now, orderType));
    if (executions.some((execution) => !execution?.complete)) {
      const missing = executions.findIndex((execution) => !execution?.complete);
      const execution = executions[missing];
      this.opportunity = {
        ...this.opportunity,
        status: 'WAITING_FOR_FULL_DEPTH',
        reason: `The ${opportunity.legs[missing].timeframe} ${opportunity.legs[missing].side} book does not support the complete ${STRATEGY.quantity}-share pair entry within its price cap.`,
        depth: execution ? { filledShares: execution.filledShares, requestedShares: execution.requestedShares } : null,
      };
      return false;
    }

    const grossCost = executions.reduce((sum, execution) => sum + execution.grossCost, 0);
    const fees = executions.reduce((sum, execution) => sum + execution.fees, 0);
    const totalCost = grossCost + fees;
    if (totalCost > this.cash + EPSILON) {
      this.opportunity = { ...this.opportunity, status: 'INSUFFICIENT_PAPER_CASH', reason: 'Paper cash cannot cover both complete legs and modeled fees.' };
      return false;
    }

    const pairId = `${Math.round(Number(opportunity.endTime))}-pair-${++this.pairSequence}`;
    const entryNumber = fiveMinuteSlotIndex(this.pairMarkets['5m'], this.pairMarkets['15m']) + 1;
    const positionIds = [];
    const orderIds = [];
    for (let index = 0; index < opportunity.legs.length; index += 1) {
      const leg = opportunity.legs[index];
      const execution = executions[index];
      const orderId = `${pairId}-${leg.timeframe}-${leg.side.toLowerCase()}-buy`;
      const position = this.createPairPosition(pairId, leg, execution, now, orderType);
      positionIds.push(position.id);
      const order = {
        id: orderId,
        pairId,
        strategyId: this.strategyId,
        marketId: leg.market.id || leg.market.conditionId || leg.market.slug,
        marketSlug: leg.market.slug,
        timeframe: leg.timeframe,
        action: 'BUY',
        positionId: position.id,
        side: leg.side,
        orderType,
        timeInForce: 'FOK',
        status: 'FILLED',
        requestedShares: STRATEGY.quantity,
        filledShares: execution.filledShares,
        remainingShares: 0,
        averagePrice: execution.averagePrice,
        bestAskAtSubmission: execution.bestAsk,
        priceCap: execution.priceCap,
        grossCost: execution.grossCost,
        fees: execution.fees,
        fills: execution.fills,
        createdAt: now,
        filledAt: now,
        windowStart: actualMarketStart(leg.market),
        windowEnd: Number(opportunity.endTime),
        entryNumber,
        askSumTarget: null,
        paperOnly: true,
      };
      orderIds.push(orderId);
      this.orders.unshift(order);
      this.windowOrders.unshift(order);
    }

    this.cash -= totalCost;
    this.totalOrderAttempts += 2;
    const pair = {
      id: pairId,
      strategyId: this.strategyId,
      status: 'OPEN',
      case: opportunity.case,
      direction: { ...opportunity.direction },
      windowStart: Number(this.market.start),
      windowEnd: Number(opportunity.endTime),
      entryNumber,
      market5mId: marketKey(this.pairMarkets['5m']),
      market15mId: marketKey(this.pairMarkets['15m']),
      beatPrices: null,
      beatGapUsd: null,
      beatToleranceUsd: null,
      selectionMode: opportunity.selectionMode,
      volatility: opportunity.volatility || this.currentVolatility,
      beatPriceSources: {
        '5m': opportunity.beatPriceSources?.['5m'] || opportunity.beatPrices?.['5m']?.source || null,
        '15m': opportunity.beatPriceSources?.['15m'] || opportunity.beatPrices?.['15m']?.source || null,
      },
      sharesPerLeg: STRATEGY.quantity,
      bestAskSum: opportunity.prices.sumPrice,
      askSumTarget: null,
      askSumUnderTarget: null,
      upPrice: executions[0].averagePrice,
      downPrice: executions[1].averagePrice,
      averagePriceSum: executions.reduce((sum, execution) => sum + execution.averagePrice, 0),
      grossCost,
      fees,
      totalCost,
      orderType,
      orderIds,
      positionIds,
      createdAt: now,
      settledAt: null,
      realizedPnl: null,
      outcome: null,
    };
    this.pairs.unshift(pair);
    this.pairs.length = Math.min(this.pairs.length, 250);
    this.opportunity = {
      ...this.opportunity,
      status: 'PAIR_ENTERED',
      reason: `Paper entry filled: ${STRATEGY.quantity} 15m UP shares and ${STRATEGY.quantity} 5m DOWN shares; combined asks did not gate entry. Total cost $${totalCost.toFixed(3)} including $${fees.toFixed(3)} fees.`,
      pairId,
      grossCost,
      fees,
      totalCost,
      orderIds,
    };
    this.signal = { action: 'PAIR_ENTERED', case: opportunity.case, pairId, reason: this.opportunity.reason };
    this.log('PAPER_PAIR_ENTRY_FILLED', {
      pairId,
      case: opportunity.case,
      direction: opportunity.direction,
      windowEnd: opportunity.endTime,
      beatGapUsd: null,
      beatToleranceUsd: null,
      sharesPerLeg: STRATEGY.quantity,
      bestAskSum: opportunity.prices.sumPrice,
      entryNumber: pair.entryNumber,
      grossCost,
      fees,
      totalCost,
      askSumTarget: null,
      askSumUnderTarget: opportunity.askSumUnderTarget,
      orderType,
    });
    this.events.unshift({
      ts: now,
      event: 'PAPER_PAIR_ENTRY_FILLED',
      type: 'PAPER_PAIR_ENTRY_FILLED',
      message: this.opportunity.reason,
      details: {
        pairId,
        case: opportunity.case,
        direction: opportunity.direction,
        entryNumber: pair.entryNumber,
        askSumTarget: null,
        askSumUnderTarget: opportunity.askSumUnderTarget,
        selectionMode: opportunity.selectionMode,
        grossCost,
        fees,
        totalCost,
      },
    });
    if (this.events.length > 200) this.events.length = 200;
    return true;
  }

  createPairPosition(pairId, leg, execution, now, orderType) {
    const id = `${pairId}-${leg.timeframe}-${leg.side.toLowerCase()}-position`;
    const position = {
      id,
      pairId,
      strategyId: this.strategyId,
      marketId: leg.market.id || leg.market.conditionId || leg.market.slug,
      marketSlug: leg.market.slug,
      marketTitle: leg.market.title || leg.market.slug,
      timeframe: leg.timeframe,
      windowStart: actualMarketStart(leg.market),
      windowEnd: actualMarketEnd(leg.market),
      asset: 'BTC',
      side: leg.side,
      status: 'OPEN',
      shares: execution.filledShares,
      initialShares: execution.filledShares,
      entryPrice: execution.averagePrice,
      avgEntry: execution.averagePrice,
      totalCost: execution.grossCost,
      initialTotalCost: execution.grossCost,
      fees: execution.fees,
      initialFees: execution.fees,
      entryFees: execution.fees,
      estimatedEntryMakerRebate: 0,
      exitFees: 0,
      realizedCostBasis: 0,
      realizedEntryFees: 0,
      openedAt: now,
      filledAt: now,
      markBid: this.pairQuotes[leg.timeframe][leg.side]?.bestBid ?? null,
      markPrice: this.pairQuotes[leg.timeframe][leg.side]?.bestBid ?? null,
      markUpdatedAt: this.pairQuotes[leg.timeframe][leg.side]?.updatedAt ?? null,
      takeProfitTrigger: STRATEGY.takeProfitTrigger,
      takeProfitPayout: STRATEGY.takeProfitPayout,
      takeProfitProceeds: 0,
      unrealizedPnl: null,
      estimatedMakerRebate: 0,
      makerRebateEstimate: 0,
      estimatedEntryMakerRebate: 0,
      estimatedExitMakerRebate: 0,
      entryFills: execution.fills.map((fill) => ({ ...fill, orderType })),
      entrySignals: [{
        at: now,
        pairId,
        timeframe: leg.timeframe,
        side: leg.side,
        shares: execution.filledShares,
        averagePrice: execution.averagePrice,
        fees: execution.fees,
      }],
      exitFills: [],
      exitProceeds: 0,
      proceeds: 0,
      realizedPnl: null,
      feeContext: feeContext(leg.market),
      paperOnly: true,
    };
    this.positions.unshift(position);
    return position;
  }

  finalizeResolution(position, winner, now = this.now()) {
    const finalized = super.finalizeResolution(position, winner, now);
    if (!finalized || !position.pairId) return finalized;
    this.updatePairSettlement(position.pairId, now);
    return finalized;
  }

  completedPairStats() {
    const complete = this.pairs.filter((pair) => pair.status === 'SETTLED');
    const wins = complete.filter((pair) => pair.outcome === 'WIN').length;
    const losses = complete.filter((pair) => pair.outcome === 'LOSS').length;
    const breakEven = complete.length - wins - losses;
    return {
      completed: complete.length,
      wins,
      losses,
      breakEven,
      winRate: complete.length ? (wins / complete.length) * 100 : 0,
      realizedPnl: complete.reduce((sum, pair) => sum + (Number(pair.realizedPnl) || 0), 0),
      pending: this.pairs.filter((pair) => pair.status === 'OPEN' || pair.status === 'PARTIALLY_SETTLED').length,
    };
  }

  marketSnapshot(timeframe, beatPrice = null) {
    const market = this.pairMarkets[timeframe];
    if (!market) return null;
    const actualStart = actualMarketStart(market);
    return {
      id: marketKey(market),
      slug: market.slug,
      title: market.title,
      timeframe,
      start: actualStart,
      end: actualMarketEnd(market),
      expectedStart: Number(market.start),
      expectedEnd: Number(market.start) + (timeframe === '5m' ? FIVE_MINUTES_MS : FIFTEEN_MINUTES_MS),
      beatPrice: beatPrice || null,
      outcomes: Object.fromEntries(SIDES.map((side) => [
        side,
        this.pairQuotes[timeframe]?.[side] || { status: 'MISSING' },
      ])),
    };
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const pairStats = this.completedPairStats();
    const volatility = this.binanceFeed?.getVolatilityBand?.(now) || this.currentVolatility;
    if (volatility) this.currentVolatility = volatility;
    const beatPrices = this.opportunity?.beatPrices || this.currentBeatPrices;
    const market5m = this.marketSnapshot('5m', beatPrices?.['5m'] || null);
    const market15m = this.marketSnapshot('15m', beatPrices?.['15m'] || null);
    const synchronized = synchronizedMarkets(this.pairMarkets['5m'], this.pairMarkets['15m']);
    const eligible = validPairMarkets(this.pairMarkets['5m'], this.pairMarkets['15m']);
    const opportunity = this.opportunity || {};
    return {
      ...state,
      now,
      mode: 'DEMO ONLY',
      status: state.status === 'blocked_or_error' ? 'ERROR' : state.status,
      statusReason: this.opportunity?.reason || state.statusReason,
      strategy: {
        id: STRATEGY.id,
        name: STRATEGY.name,
        version: STRATEGY.version,
        execution: 'PAPER ONLY',
        asset: 'BTC',
        timeframes: ['5m', '15m'],
        sharesPerLeg: STRATEGY.quantity,
        sharesPerFiveMinuteEntry: STRATEGY.quantity,
        sharesAddedToFifteenMinuteMarketPerSlot: STRATEGY.quantity,
        individualAskFloor: null,
        askSumTarget: null,
        entryAskSumThresholds: [],
        maxPairsPerFiveMinuteWindow: 1,
        maxPairsPerFifteenMinuteWindow: 3,
        firstFiveMinuteSlotOnly: false,
        forceEntryAboveAskSumTarget: true,
        entryOnlyBelowAskSumTarget: false,
        sideSelectionMode: 'At every 5m start, buy 300 DOWN shares in the new 5m market and add 300 UP shares to the active 15m market. Combined asks do not gate entry.',
        sweepPriceCeiling: STRATEGY.sweepPriceCeiling,
        beatPriceSource: 'Not used for entry selection.',
        bookPriceSource: 'Polymarket CLOB WebSocket only; wait if missing or stale.',
        beatVolatilityWindowMs: STRATEGY.beatVolatilityWindowMs,
        minimumBeatToleranceUsd: STRATEGY.minimumBeatToleranceUsd,
        maximumBeatToleranceUsd: STRATEGY.maximumBeatToleranceUsd,
        onePairPerFiveMinuteWindow: true,
        onePairPerFirstFiveMinuteSlot: false,
        onePairPerFiveMinuteSlot: true,
        onePairPerFifteenMinuteMarketSlot: true,
        oneEntryPerAskSumThreshold: false,
        synchronizedEndTimeRequired: false,
        takeProfitTrigger: STRATEGY.takeProfitTrigger,
        takeProfitPayoutPerShare: STRATEGY.takeProfitPayout,
        exit: 'Close a leg when its best bid reaches $0.99; model $1.00 per share. Otherwise send it to official resolution at window end.',
        liveOrdersEnabled: false,
      },
      account: {
        ...state.account,
        completedPairs: pairStats.completed,
        pairWins: pairStats.wins,
        pairLosses: pairStats.losses,
        pairBreakEven: pairStats.breakEven,
        pairWinRate: pairStats.winRate,
        pairRealizedPnl: pairStats.realizedPnl,
        pendingPairs: pairStats.pending,
      },
      signal: this.signal,
      opportunity: {
        status: opportunity.status || 'WAITING',
        reason: opportunity.reason || null,
        case: opportunity.case || null,
        direction: opportunity.direction || null,
        prices: opportunity.prices || null,
        beatPrices: opportunity.beatPrices || null,
        checkedAt: this.lastEvaluationAt || opportunity.checkedAt || null,
        pairId: opportunity.pairId || null,
        grossCost: opportunity.grossCost ?? null,
        fees: opportunity.fees ?? null,
        totalCost: opportunity.totalCost ?? null,
        askSumTarget: null,
        askSumThresholds: [],
        qualifyingThresholds: [],
        nextAskSumTarget: null,
        entryTiers: opportunity.entryTiers || [],
        askSumUnderTarget: null,
        selectionMode: opportunity.selectionMode ?? null,
        beatGapUsd: opportunity.beatGapUsd ?? null,
        beatToleranceUsd: opportunity.beatToleranceUsd ?? volatility?.bandUsd ?? null,
        volatility: opportunity.volatility || volatility || null,
        orderIds: opportunity.orderIds || [],
        depth: opportunity.depth || null,
      },
      marketPair: {
        synchronized,
        eligible,
        commonEnd: synchronized ? actualMarketEnd(this.pairMarkets['5m']) : null,
        fiveMinute: market5m,
        fifteenMinute: market15m,
        volatility,
        note: 'At each 5-minute start, the bot buys 300 DOWN shares in that 5m market and adds 300 UP shares to the active 15m market, without a combined-ask filter.',
      },
      binance: {
        status: this.binanceFeed?.status || 'UNAVAILABLE',
        error: this.binanceFeed?.error || null,
        connectedAt: this.binanceFeed?.connectedAt || null,
        reconnectCount: this.binanceFeed?.reconnectCount || 0,
        volatility,
        detail: 'BTCUSDT aggregate-trade WebSocket is informational only; beat prices do not select sides or gate entries.',
      },
      websocket: {
        ...this.websocket,
        detail: 'A single Polymarket market-channel WebSocket monitors all four outcome books.',
      },
      pairHistory: this.pairs.slice(0, 100),
      persistence: {
        status: 'MEMORY ONLY',
        detail: 'A Railway restart starts a fresh paper ledger.',
      },
    };
  }
}

CrossTimeframeArbitrageBot._test = {
  actualMarketEnd,
  actualMarketStart,
  detectOpportunity,
  getQuotePairSum,
  fiveMinuteSlotIndex,
  validPairMarkets,
  synchronizedMarkets,
};

module.exports = CrossTimeframeArbitrageBot;
