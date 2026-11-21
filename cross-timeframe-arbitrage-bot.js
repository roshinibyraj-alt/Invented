'use strict';

const config = require('./config');
const WickBot = require('./wick-bot');
const defaultMarketData = require('./wick-market-data');
const BinanceBeatFeed = require('./binance-beat-feed');

const { quoteFromBook, takerFeeFor, feeContext } = WickBot._test;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const STRATEGY = Object.freeze({
  id: 'btc-every-5m-paired-5m-15m-paper',
  name: 'BTC first-5m paired 5m/15m paper strategy',
  version: 'btc-every-5m-paired-paper-v7-first-slot-500',
  quantity: 500,
  askSumTarget: 0.80,
  entryAskSumThresholds: Object.freeze([0.80]),
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

function isFirstFiveMinuteSlot(market5m, market15m) {
  const fiveStart = actualMarketStart(market5m);
  const fifteenStart = actualMarketStart(market15m);
  return Number.isFinite(fiveStart)
    && Number.isFinite(fifteenStart)
    && Math.abs(fiveStart - fifteenStart) <= 1000;
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
  beat5m,
  beat15m,
  quotes,
  askSumTarget = STRATEGY.askSumTarget,
  askSumThresholds = STRATEGY.entryAskSumThresholds,
  beatToleranceUsd = 0,
  allowBeatDirection = true,
}) {
  if (!validPairMarkets(market5m, market15m)) {
    return { exists: false, case: null, reason: 'The current 5-minute market is not contained in the active 15-minute market.' };
  }
  const values = [beat5m?.value, beat15m?.value].map((value) =>
    value == null || value === '' ? NaN : Number(value));
  const beatsAvailable = values.every((value) => Number.isFinite(value) && value > 0);
  if (!allowBeatDirection || !beatsAvailable) {
    return {
      exists: false,
      case: null,
      selectionMode: 'BINANCE_WS_ONLY',
      beatPrices: {
        beat5m: Number.isFinite(values[0]) ? values[0] : null,
        beat15m: Number.isFinite(values[1]) ? values[1] : null,
      },
      beatGapUsd: null,
      beatToleranceUsd: null,
      reason: 'Waiting for valid 5m and 15m beat prices from the Binance WebSocket.',
    };
  }
  const useBeatDirection = true;
  const beatGapUsd = beatsAvailable ? Math.abs(values[0] - values[1]) : null;
  const toleranceUsd = Math.max(0, Number(beatToleranceUsd) || 0);
  const candidates = [];
  const addCandidate = (caseId, upMarket, downMarket) => {
    const upQuote = quotes?.[upMarket]?.UP;
    const downQuote = quotes?.[downMarket]?.DOWN;
    const sum = getQuotePairSum(upQuote, downQuote);
    if (sum == null) return;
    candidates.push({
      case: caseId,
      direction: { upMarket, downMarket },
      legs: [
        { timeframe: upMarket, side: 'UP', market: market5m && upMarket === '5m' ? market5m : market15m,
          quote: upQuote },
        { timeframe: downMarket, side: 'DOWN', market: market5m && downMarket === '5m' ? market5m : market15m,
          quote: downQuote },
      ],
      prices: { upPrice: Number(upQuote.bestAsk), downPrice: Number(downQuote.bestAsk), sumPrice: sum },
    });
  };

  if (beatGapUsd <= toleranceUsd + EPSILON) {
    addCandidate('C', '5m', '15m');
    addCandidate('C', '15m', '5m');
  } else if (values[1] > values[0]) {
    addCandidate('A', '5m', '15m');
  } else {
    addCandidate('B', '15m', '5m');
  }

  const selected = candidates.sort((a, b) => a.prices.sumPrice - b.prices.sumPrice)[0];
  if (!selected) {
    return {
      exists: false,
      case: beatGapUsd <= toleranceUsd + EPSILON ? 'C' : values[1] > values[0] ? 'A' : 'B',
      direction: null,
      prices: null,
      selectionMode: 'BEAT_GAP',
      beatPrices: {
        beat5m: Number.isFinite(values[0]) ? values[0] : null,
        beat15m: Number.isFinite(values[1]) ? values[1] : null,
      },
      beatGapUsd,
      beatToleranceUsd: toleranceUsd,
      reason: 'Fresh asks for the selected UP and DOWN legs are unavailable.',
    };
  }
  const thresholds = (Array.isArray(askSumThresholds) ? askSumThresholds : [askSumTarget])
    .map(Number)
    .filter((threshold) => Number.isFinite(threshold) && threshold > 0 && threshold < 2)
    .sort((a, b) => b - a);
  const qualifyingThresholds = thresholds.filter((threshold) =>
    selected.prices.sumPrice < threshold - EPSILON);
  const activeThreshold = qualifyingThresholds[0] ?? thresholds[0] ?? Number(askSumTarget);
  const askSumUnderTarget = qualifyingThresholds.length > 0;
  const selectionMode = 'BEAT_GAP';
  const sharedOpportunity = {
    ...selected,
    selectionMode,
    beatPrices: {
      beat5m: Number.isFinite(values[0]) ? values[0] : null,
      beat15m: Number.isFinite(values[1]) ? values[1] : null,
    },
    beatGapUsd,
    beatToleranceUsd: toleranceUsd,
    askSumTarget: activeThreshold,
    askSumThresholds: thresholds,
    qualifyingThresholds,
    askSumUnderTarget,
    endTime: actualMarketEnd(market5m),
  };
  if (!askSumUnderTarget) {
    const nextThreshold = thresholds[0] ?? Number(askSumTarget);
    return {
      ...sharedOpportunity,
      exists: false,
      waitingForAskSum: true,
      nextAskSumTarget: nextThreshold,
      reason: `Selected combined best asks are $${selected.prices.sumPrice.toFixed(3)}; the next entry triggers below $${nextThreshold.toFixed(2)}.`,
    };
  }
  return {
    ...sharedOpportunity,
    exists: true,
    waitingForAskSum: false,
    reason: `Beat gap $${beatGapUsd.toFixed(2)} versus $${toleranceUsd.toFixed(2)} volatility band; paired asks sum to $${selected.prices.sumPrice.toFixed(3)}, below at least one entry threshold.`,
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
    this.processedEntryThresholds = new Set();
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
    if (!isFirstFiveMinuteSlot(market5m, market15m)) {
      this.setWaitingOpportunity(
        'Entry is limited to the first 5-minute segment of each 15-minute window.',
        'OUTSIDE_FIRST_FIVE_MINUTE_SLOT',
      );
      return false;
    }
    if (now >= actualMarketEnd(market5m)) {
      this.setWaitingOpportunity('The 5-minute window ended without a qualifying ask sum; skipping it.', 'WINDOW_EXPIRED');
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
    if (this.binanceFeed?.status !== 'CONNECTED' || !volatility.ready) {
      const reason = this.binanceFeed?.status !== 'CONNECTED'
        ? 'Waiting for the Binance WebSocket to reconnect.'
        : 'Waiting for fresh Binance WebSocket ticks to rebuild the volatility sample.';
      this.setWaitingOpportunity(reason, 'WAITING_FOR_BINANCE_WS', { volatility });
      return false;
    }
    const [beat5m, beat15m] = await Promise.all([
      this.getBeatPrice(market5m, now),
      this.getBeatPrice(market15m, now),
    ]);
    if (![beat5m?.value, beat15m?.value].every((value) => Number.isFinite(Number(value)) && Number(value) > 0)) {
      this.setWaitingOpportunity('Waiting for Binance WebSocket ticks captured near both market starts.', 'WAITING_FOR_BINANCE_BEATS', {
        beatPrices: { '5m': beat5m, '15m': beat15m },
        volatility,
      });
      return false;
    }

    const lastPolymarketMessageAt = Number(this.websocket.lastMessageAt);
    if (this.websocket.status !== 'CONNECTED'
      || !Number.isFinite(lastPolymarketMessageAt)
      || now - lastPolymarketMessageAt > STRATEGY.maxQuoteAgeMs) {
      this.setWaitingOpportunity('Waiting for fresh Polymarket WebSocket book updates.', 'WAITING_FOR_POLYMARKET_WS', {
        beatPrices: { '5m': beat5m, '15m': beat15m },
        volatility,
      });
      return false;
    }

    const quotes = this.getFreshPairQuotes(now);
    if (!quotes) {
      this.setWaitingOpportunity('Waiting for fresh asks on the selected UP and DOWN legs.', 'WAITING_FOR_BOOKS', {
        beatPrices: { '5m': beat5m, '15m': beat15m },
      });
      return false;
    }
    const opportunity = detectOpportunity({
      market5m,
      market15m,
      beat5m,
      beat15m,
      quotes,
      askSumTarget: STRATEGY.askSumTarget,
      askSumThresholds: STRATEGY.entryAskSumThresholds,
      beatToleranceUsd: volatility.bandUsd,
      allowBeatDirection: true,
    });
    this.opportunity = {
      ...opportunity,
      status: opportunity.exists ? 'ENTRY_SELECTED'
        : opportunity.waitingForAskSum ? 'WAITING_FOR_ASK_SUM' : 'NO_OPPORTUNITY',
      checkedAt: now,
      beatPrices: {
        '5m': beat5m,
        '15m': beat15m,
      },
      volatility,
      entryTiers: this.currentEntryTiers(opportunity.prices?.sumPrice, market5m.start),
    };
    const endTime = Number(opportunity.endTime || actualMarketEnd(market5m));
    const qualifyingThresholds = (opportunity.qualifyingThresholds || [])
      .filter((threshold) => !this.processedEntryThresholds.has(this.entryThresholdKey(endTime, threshold)));
    const nextAskSumTarget = STRATEGY.entryAskSumThresholds
      .find((threshold) => !this.processedEntryThresholds.has(this.entryThresholdKey(endTime, threshold)));
    this.opportunity = {
      ...this.opportunity,
      nextAskSumTarget: nextAskSumTarget ?? null,
      entryTiers: this.currentEntryTiers(opportunity.prices?.sumPrice, market5m.start),
    };
    this.signal = {
      action: qualifyingThresholds.length ? 'PAIR_READY' : 'WAIT',
      case: opportunity.case || null,
      selectionMode: opportunity.selectionMode || null,
      reason: opportunity.reason,
    };

    if (!opportunity.prices) return false;
    if (!qualifyingThresholds.length) {
      const fired = this.currentEntryTiers(opportunity.prices.sumPrice, market5m.start)
        .filter((tier) => tier.status === 'FIRED');
      this.opportunity = {
        ...this.opportunity,
        status: fired.length === STRATEGY.entryAskSumThresholds.length
          ? 'WINDOW_ENTRIES_COMPLETE'
          : fired.length ? 'WAITING_FOR_NEXT_THRESHOLD'
            : opportunity.waitingForAskSum ? 'WAITING_FOR_ASK_SUM' : 'NO_OPPORTUNITY',
        reason: fired.length === STRATEGY.entryAskSumThresholds.length
          ? 'The $0.80 ask-sum entry has fired for this 5-minute window.'
          : fired.length
            ? `Entry at ${fired.map((tier) => `$${tier.threshold.toFixed(2)}`).join(', ')} already fired for this 5-minute window.`
            : opportunity.reason,
      };
      return false;
    }

    let enteredAny = false;
    let blockedAttempt = null;
    for (const threshold of qualifyingThresholds) {
      const entered = this.executePaperPair({
        ...opportunity,
        askSumTarget: threshold,
      }, now);
      if (!entered) {
        blockedAttempt = {
          status: this.opportunity.status,
          reason: this.opportunity.reason,
        };
        break;
      }
      enteredAny = true;
      this.processedEntryThresholds.add(this.entryThresholdKey(endTime, threshold));
      while (this.processedEntryThresholds.size > 1500) {
        this.processedEntryThresholds.delete(this.processedEntryThresholds.values().next().value);
      }
    }

    const entryTiers = this.currentEntryTiers(opportunity.prices.sumPrice, market5m.start);
    const fired = entryTiers.filter((tier) => tier.status === 'FIRED');
    const next = entryTiers.find((tier) => tier.status !== 'FIRED');
    this.opportunity = {
      ...this.opportunity,
      entryTiers,
      nextAskSumTarget: next?.threshold ?? null,
      status: fired.length === STRATEGY.entryAskSumThresholds.length
        ? 'WINDOW_ENTRIES_COMPLETE'
        : blockedAttempt ? blockedAttempt.status
        : enteredAny ? 'PAIR_ENTRY_FILLED'
          : this.opportunity.status,
      reason: fired.length === STRATEGY.entryAskSumThresholds.length
        ? 'The $0.80 ask-sum entry has fired for this 5-minute window.'
        : blockedAttempt
          ? `The $0.80 ask-sum entry is blocked: ${blockedAttempt.reason}`
        : enteredAny
          ? 'The $0.80 ask-sum entry has fired for this 5-minute window.'
          : this.opportunity.reason,
    };
    this.signal = {
      action: enteredAny ? 'PAIR_ENTRY_FILLED' : this.signal.action,
      case: opportunity.case || null,
      selectionMode: opportunity.selectionMode || null,
      reason: this.opportunity.reason,
    };
    return enteredAny;
  }

  entryThresholdKey(windowEnd, threshold) {
    return `${Number(windowEnd)}:${Number(threshold).toFixed(2)}`;
  }

  currentEntryTiers(currentAskSum, windowStart) {
    const sum = Number(currentAskSum);
    return STRATEGY.entryAskSumThresholds.map((threshold) => {
      const pair = this.pairs.find((item) =>
        Number(item.windowStart) === Number(windowStart)
        && Math.abs(Number(item.askSumTarget) - threshold) < EPSILON);
      return {
        threshold,
        status: pair ? 'FIRED'
          : Number.isFinite(sum) && sum < threshold - EPSILON ? 'READY' : 'WAITING',
        pairId: pair?.id || null,
      };
    });
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
    let remaining = STRATEGY.quantity;
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
    const filledShares = STRATEGY.quantity - remaining;
    if (filledShares + EPSILON < STRATEGY.quantity) {
      return {
        complete: false,
        requestedShares: STRATEGY.quantity,
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
      requestedShares: STRATEGY.quantity,
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
    const entryNumber = this.pairs.filter((item) =>
      Number(item.windowStart) === Number(this.market.start)).length + 1;
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
        windowStart: Number(this.market.start),
        windowEnd: Number(opportunity.endTime),
        entryNumber,
        askSumTarget: Number(opportunity.askSumTarget),
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
      beatPrices: { ...opportunity.beatPrices },
      beatGapUsd: opportunity.beatGapUsd,
      beatToleranceUsd: opportunity.beatToleranceUsd,
      selectionMode: opportunity.selectionMode,
      volatility: opportunity.volatility || this.currentVolatility,
      beatPriceSources: {
        '5m': opportunity.beatPriceSources?.['5m'] || opportunity.beatPrices?.['5m']?.source || null,
        '15m': opportunity.beatPriceSources?.['15m'] || opportunity.beatPrices?.['15m']?.source || null,
      },
      sharesPerLeg: STRATEGY.quantity,
      bestAskSum: opportunity.prices.sumPrice,
      askSumTarget: Number(opportunity.askSumTarget),
      askSumUnderTarget: opportunity.askSumUnderTarget,
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
      reason: `Paper pair filled: ${STRATEGY.quantity} shares per leg at the $${Number(opportunity.askSumTarget).toFixed(2)} ask-sum tier; total cost $${totalCost.toFixed(3)} including $${fees.toFixed(3)} fees.`,
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
      beatGapUsd: opportunity.beatGapUsd,
      beatToleranceUsd: opportunity.beatToleranceUsd,
      sharesPerLeg: STRATEGY.quantity,
      bestAskSum: opportunity.prices.sumPrice,
      entryNumber: pair.entryNumber,
      grossCost,
      fees,
      totalCost,
      askSumTarget: Number(opportunity.askSumTarget),
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
        askSumTarget: Number(opportunity.askSumTarget),
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
      windowStart: Number(this.market.start),
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
        askSumTarget: STRATEGY.askSumTarget,
        entryAskSumThresholds: STRATEGY.entryAskSumThresholds,
        maxPairsPerFiveMinuteWindow: 1,
        maxPairsPerFifteenMinuteWindow: 1,
        firstFiveMinuteSlotOnly: true,
        forceEntryAboveAskSumTarget: false,
        entryOnlyBelowAskSumTarget: true,
        sweepPriceCeiling: STRATEGY.sweepPriceCeiling,
        beatPriceSource: 'Binance BTCUSDT aggregate-trade WebSocket only; wait if missing.',
        bookPriceSource: 'Polymarket CLOB WebSocket only; wait if missing or stale.',
        beatVolatilityWindowMs: STRATEGY.beatVolatilityWindowMs,
        minimumBeatToleranceUsd: STRATEGY.minimumBeatToleranceUsd,
        maximumBeatToleranceUsd: STRATEGY.maximumBeatToleranceUsd,
        onePairPerFiveMinuteWindow: true,
        onePairPerFirstFiveMinuteSlot: true,
        oneEntryPerAskSumThreshold: true,
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
        askSumTarget: opportunity.askSumTarget ?? STRATEGY.askSumTarget,
        askSumThresholds: STRATEGY.entryAskSumThresholds,
        qualifyingThresholds: opportunity.qualifyingThresholds || [],
        nextAskSumTarget: opportunity.nextAskSumTarget ?? STRATEGY.entryAskSumThresholds[0],
        entryTiers: opportunity.entryTiers || this.currentEntryTiers(
          opportunity.prices?.sumPrice,
          this.pairMarkets['5m']?.start,
        ),
        askSumUnderTarget: opportunity.askSumUnderTarget ?? null,
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
        note: 'A single pair may enter only during the first 5-minute segment of each 15-minute market.',
      },
      binance: {
        status: this.binanceFeed?.status || 'UNAVAILABLE',
        error: this.binanceFeed?.error || null,
        connectedAt: this.binanceFeed?.connectedAt || null,
        reconnectCount: this.binanceFeed?.reconnectCount || 0,
        volatility,
        detail: 'BTCUSDT aggregate-trade WebSocket; beat price uses the nearest tick within 2 seconds of market start.',
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
  isFirstFiveMinuteSlot,
  validPairMarkets,
  synchronizedMarkets,
};

module.exports = CrossTimeframeArbitrageBot;
