'use strict';

const config = require('./config');
const WickBot = require('./wick-bot');
const defaultMarketData = require('./wick-market-data');
const BeatPriceProvider = require('./beat-price-provider');
const BinanceBeatFeed = require('./binance-beat-feed');

const { quoteFromBook, takerFeeFor, feeContext } = WickBot._test;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const STRATEGY = Object.freeze({
  id: 'btc-every-5m-paired-5m-15m-paper',
  name: 'BTC every-5m paired 5m/15m paper strategy',
  version: 'btc-every-5m-paired-paper-v3',
  quantity: 100,
  askSumTarget: 0.50,
  sweepPriceCeiling: 0.99,
  maxQuoteAgeMs: 5000,
  pairMarketRefreshMs: 15_000,
  bookRefreshMs: 10_000,
  beatRetryMs: 30_000,
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
  beatToleranceUsd = 0,
  allowBeatDirection = true,
  fallbackReason = 'Beat or volatility reference unavailable',
}) {
  if (!validPairMarkets(market5m, market15m)) {
    return { exists: false, case: null, reason: 'The current 5-minute market is not contained in the active 15-minute market.' };
  }
  const values = [beat5m?.value, beat15m?.value].map((value) =>
    value == null || value === '' ? NaN : Number(value));
  const beatsAvailable = values.every((value) => Number.isFinite(value) && value > 0);
  const useBeatDirection = allowBeatDirection && beatsAvailable;
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

  if (!useBeatDirection) {
    addCandidate('F', '5m', '15m');
    addCandidate('F', '15m', '5m');
  } else if (beatGapUsd <= toleranceUsd + EPSILON) {
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
      case: useBeatDirection
        ? beatGapUsd <= toleranceUsd + EPSILON ? 'C' : values[1] > values[0] ? 'A' : 'B'
        : 'F',
      direction: null,
      prices: null,
      selectionMode: useBeatDirection ? 'BEAT_GAP' : 'ASK_SUM_FALLBACK',
      beatPrices: {
        beat5m: Number.isFinite(values[0]) ? values[0] : null,
        beat15m: Number.isFinite(values[1]) ? values[1] : null,
      },
      beatGapUsd,
      beatToleranceUsd: useBeatDirection ? toleranceUsd : null,
      reason: 'Fresh asks for the selected UP and DOWN legs are unavailable.',
    };
  }
  const askSumUnderTarget = selected.prices.sumPrice < Number(askSumTarget) - EPSILON;
  const selectionMode = useBeatDirection ? 'BEAT_GAP' : 'ASK_SUM_FALLBACK';
  return {
    exists: true,
    ...selected,
    selectionMode,
    beatPrices: {
      beat5m: Number.isFinite(values[0]) ? values[0] : null,
      beat15m: Number.isFinite(values[1]) ? values[1] : null,
    },
    beatGapUsd,
    beatToleranceUsd: useBeatDirection ? toleranceUsd : null,
    askSumTarget: Number(askSumTarget),
    askSumUnderTarget,
    forcedEntry: !askSumUnderTarget,
    endTime: actualMarketEnd(market5m),
    reason: `${useBeatDirection
      ? `Beat gap $${beatGapUsd.toFixed(2)} versus $${toleranceUsd.toFixed(2)} volatility band`
      : `${fallbackReason}; selected the lower combined asks`}; paired asks sum to $${selected.prices.sumPrice.toFixed(3)}${askSumUnderTarget ? ', below the $0.50 target.' : ', above the $0.50 target; entering anyway.'}`,
  };
}

class CrossTimeframeArbitrageBot extends WickBot {
  constructor({
    marketData = defaultMarketData,
    beatPriceProvider = null,
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
    this.beatPriceProvider = beatPriceProvider || new BeatPriceProvider();
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
    this.lastBookRefreshAt = 0;
    this.marketStream = null;
    this.streamGeneration = 0;
    this.beatPriceCache = new Map();
    this.currentBeatPrices = { '5m': null, '15m': null };
    this.lastBeatWindow = { '5m': null, '15m': null };
    this.processedPairEnds = new Set();
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
      this.lastBookRefreshAt = 0;
      if (five) {
        await this.refreshPairBooks(now);
        this.startMarketStream();
      }
    } else if (now - this.lastBookRefreshAt >= STRATEGY.bookRefreshMs
      || this.pairHasStaleBooks(now)) {
      await this.refreshPairBooks(now);
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

  pairHasStaleBooks(now) {
    return TIMEFRAMES.some((timeframe) => SIDES.some((side) => {
      const updatedAt = Number(this.pairBooks[timeframe][side]?.updatedAt);
      return !Number.isFinite(updatedAt) || now - updatedAt > STRATEGY.maxQuoteAgeMs;
    }));
  }

  async refreshPairBooks(now) {
    const requests = [];
    for (const timeframe of TIMEFRAMES) {
      const market = this.pairMarkets[timeframe];
      if (!market?.tokens) continue;
      for (const side of SIDES) {
        const tokenId = market.tokens[side];
        if (!tokenId) continue;
        requests.push({ timeframe, side, tokenId });
      }
    }
    const results = await Promise.allSettled(requests.map(({ tokenId }) => this.marketData.getBook(tokenId)));
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled' || !result.value) return;
      const { timeframe, side } = requests[index];
      this.applyBookSnapshot(timeframe, side, result.value, now);
    });
    this.lastBookRefreshAt = now;
    this.syncBaseQuotes();
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
        this.websocket = { ...this.websocket, ...update };
        if (update.status === 'CONNECTED') this.websocket.connectedAt = this.now();
      },
      onMessage: (message) => {
        if (generation === this.streamGeneration) this.handleMarketMessage(message);
      },
    });
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
        position.markBid = Number(quote.bestBid);
        position.markPrice = Number(quote.bestBid);
        position.markUpdatedAt = Number(quote.updatedAt);
        position.markStatus = now - position.markUpdatedAt <= STRATEGY.maxQuoteAgeMs ? 'LIVE' : 'STALE';
      }
    }
  }

  async getBeatPrice(market, now) {
    const start = actualMarketStart(market);
    if (!Number.isFinite(start) || Math.abs(start - Number(market.start)) > 1000) {
      return { value: null, source: null, error: 'Market-start timestamp does not match its window.' };
    }
    const key = `${marketKey(market)}:${start}`;
    let cached = this.beatPriceCache.get(key);
    const binanceBeat = this.binanceFeed?.getBeatPriceAt?.(start);
    if (binanceBeat?.value > 0) {
      if (!cached) {
        cached = { at: now, value: binanceBeat, loading: null };
        this.beatPriceCache.set(key, cached);
      } else {
        cached.at = now;
        cached.value = binanceBeat;
        cached.loading = null;
      }
      this.setCurrentBeatPrice(market, binanceBeat);
      return binanceBeat;
    }
    if (cached?.value?.value > 0) return cached.value;
    if (cached?.loading) return cached.loading;
    if (cached && now - cached.at < STRATEGY.beatRetryMs) return cached.value;

    const entry = { at: now, value: null, loading: null };
    entry.loading = Promise.resolve()
      .then(async () => {
        const liveBeat = this.binanceFeed?.getBeatPriceAt?.(start);
        if (liveBeat?.value > 0) return liveBeat;
        const fallback = await this.beatPriceProvider.getAtTimestamp(start);
        return this.binanceFeed?.getBeatPriceAt?.(start) || fallback;
      })
      .then((value) => {
        const liveBeat = this.binanceFeed?.getBeatPriceAt?.(start);
        entry.value = liveBeat?.value > 0
          ? liveBeat
          : entry.value?.source === 'BINANCE_WS_ESTIMATE'
            ? entry.value
            : value || { value: null, source: null, error: 'No beat price was returned.' };
        entry.at = this.now();
        entry.loading = null;
        this.setCurrentBeatPrice(market, entry.value);
        return entry.value;
      })
      .catch((error) => {
        entry.value = { value: null, source: null, error: error?.message || 'Beat-price request failed.' };
        entry.at = this.now();
        entry.loading = null;
        this.setCurrentBeatPrice(market, entry.value);
        return entry.value;
      });
    this.beatPriceCache.set(key, entry);
    return entry.loading;
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

    const volatility = this.binanceFeed?.getVolatilityBand?.(now) || {
      ready: false,
      bandUsd: null,
      rangeUsd: null,
      sampleCount: 0,
      lastTickAgeMs: null,
    };
    this.currentVolatility = volatility;
    const [beat5m, beat15m] = await Promise.all([
      this.getBeatPrice(market5m, now),
      this.getBeatPrice(market15m, now),
    ]);

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
      beatToleranceUsd: volatility.bandUsd,
      allowBeatDirection: Boolean(volatility.ready),
      fallbackReason: !volatility.ready
        ? 'Binance volatility band is not ready'
        : 'Market-start beat price is unavailable',
    });
    this.opportunity = {
      ...opportunity,
      status: opportunity.exists ? 'ENTRY_SELECTED' : 'NO_OPPORTUNITY',
      checkedAt: now,
      beatPrices: {
        '5m': beat5m,
        '15m': beat15m,
      },
      volatility,
    };
    this.signal = {
      action: opportunity.exists ? 'PAIR_SELECTED' : 'WAIT',
      case: opportunity.case || null,
      selectionMode: opportunity.selectionMode || null,
      reason: opportunity.reason,
    };

    if (!opportunity.exists) return false;
    if (this.processedPairEnds.has(Number(opportunity.endTime))) {
      const existingPair = this.pairs.find((pair) => Number(pair.windowEnd) === Number(opportunity.endTime));
      this.opportunity = {
        ...this.opportunity,
        status: 'PAIR_ALREADY_ENTERED',
        reason: 'One paired entry is already recorded for this 5-minute window.',
        pairId: existingPair?.id || null,
        grossCost: existingPair?.grossCost ?? null,
        fees: existingPair?.fees ?? null,
        totalCost: existingPair?.totalCost ?? null,
        orderIds: existingPair?.orderIds || [],
      };
      return false;
    }
    return this.executePaperPair(opportunity, now);
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
      askSumTarget: STRATEGY.askSumTarget,
      askSumUnderTarget: opportunity.askSumUnderTarget,
      forcedEntry: opportunity.forcedEntry,
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
    this.processedPairEnds.add(Number(opportunity.endTime));
    while (this.processedPairEnds.size > 500) {
      this.processedPairEnds.delete(this.processedPairEnds.values().next().value);
    }
    this.opportunity = {
      ...this.opportunity,
      status: 'PAIR_ENTERED',
      reason: `Paper pair filled: ${STRATEGY.quantity} shares per leg; ask-sum target ${opportunity.askSumUnderTarget ? 'met' : 'overridden'}; combined cost $${totalCost.toFixed(3)} including $${fees.toFixed(3)} fees.`,
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
      grossCost,
      fees,
      totalCost,
      askSumTarget: STRATEGY.askSumTarget,
      askSumUnderTarget: opportunity.askSumUnderTarget,
      forcedEntry: opportunity.forcedEntry,
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
        askSumUnderTarget: opportunity.askSumUnderTarget,
        forcedEntry: opportunity.forcedEntry,
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
    const pair = this.pairs.find((item) => item.id === position.pairId);
    if (!pair) return finalized;
    const legs = this.positions.filter((item) => item.pairId === pair.id);
    pair.settledLegs = legs.filter((item) => item.status === 'SETTLED_EXIT').length;
    if (pair.settledLegs === 2) {
      pair.status = 'SETTLED';
      pair.settledAt = Math.max(...legs.map((item) => Number(item.settledAt) || now));
      pair.realizedPnl = legs.reduce((sum, item) => sum + (Number(item.realizedPnl) || 0), 0);
      pair.outcome = pair.realizedPnl > EPSILON ? 'WIN'
        : pair.realizedPnl < -EPSILON ? 'LOSS' : 'BREAK_EVEN';
      this.completedWindows.set(pair.windowStart, {
        completedAt: pair.settledAt,
        reason: 'PAIRED_MARKETS_RESOLVED',
        outcome: pair.outcome,
        realizedPnl: pair.realizedPnl,
      });
      this.log('PAPER_PAIR_SETTLED', {
        pairId: pair.id,
        outcome: pair.outcome,
        realizedPnl: pair.realizedPnl,
        legResults: legs.map((item) => ({ timeframe: item.timeframe, side: item.side, winner: item.resolutionWinner, pnl: item.realizedPnl })),
      });
    } else {
      pair.status = 'PARTIALLY_SETTLED';
      pair.settledLegs = pair.settledLegs || 1;
    }
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
        forceEntryAboveAskSumTarget: true,
        sweepPriceCeiling: STRATEGY.sweepPriceCeiling,
        beatPriceSource: 'Binance BTCUSDT aggregate-trade WebSocket estimate, with Chainlink/CoinGecko historical fallback.',
        beatVolatilityWindowMs: STRATEGY.beatVolatilityWindowMs,
        minimumBeatToleranceUsd: STRATEGY.minimumBeatToleranceUsd,
        maximumBeatToleranceUsd: STRATEGY.maximumBeatToleranceUsd,
        onePairPerFiveMinuteWindow: true,
        synchronizedEndTimeRequired: false,
        exit: 'Hold each leg until its own official Polymarket resolution.',
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
        askSumUnderTarget: opportunity.askSumUnderTarget ?? null,
        forcedEntry: opportunity.forcedEntry ?? null,
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
        note: 'Each 5-minute market pairs with the active 15-minute market that contains it. The same 15-minute market may be used for three consecutive 5-minute entries.',
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
  validPairMarkets,
  synchronizedMarkets,
};

module.exports = CrossTimeframeArbitrageBot;
