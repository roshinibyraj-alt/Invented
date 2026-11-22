'use strict';

const config = require('./config');
const defaultMarketData = require('./wick-market-data');

const ASSETS = [...config.DIP_BOUNCE_ASSETS];
const TIMEFRAMES = [...config.DIP_BOUNCE_TIMEFRAMES];
const SIDES = ['UP', 'DOWN'];
const WINDOWS_MS = { '5m': 5 * 60_000, '15m': 15 * 60_000 };
const STRATEGY = Object.freeze({
  id: 'multi-asset-dip-bounce-paper',
  name: 'Multi-asset dip-and-bounce paper strategy',
  version: 'dip-bounce-v1',
  assets: ASSETS,
  timeframes: TIMEFRAMES,
  sharesPerEntry: config.DIP_BOUNCE_SHARES,
  dipBelow: config.DIP_BOUNCE_PRICE_DIP,
  reboundTo: config.DIP_BOUNCE_PRICE_BOUNCE,
  limitBuyPrice: config.DIP_BOUNCE_LIMIT_PRICE,
  fillBidAtOrBelow: config.DIP_BOUNCE_FILL_BID,
  takeProfitBid: config.DIP_BOUNCE_TAKE_PROFIT_BID,
  takeProfitPayoutPerShare: config.DIP_BOUNCE_TAKE_PROFIT_PAYOUT,
  stopLoss: null,
  windowEnd: 'Unfilled limits are cancelled; open shares wait for official resolution.',
});

function normalizeTimestamp(value, fallback) {
  if (value == null || value === '') return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedLevels(levels, descending) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}

function quoteFromBook(book, updatedAt, sequence) {
  const bids = normalizedLevels(book?.bids, true);
  const asks = normalizedLevels(book?.asks, false);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    status: bestBid != null || bestAsk != null ? 'LIVE' : 'MISSING',
    bestBid,
    bidSize: bids[0]?.size ?? 0,
    bestAsk,
    askSize: asks[0]?.size ?? 0,
    mid: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
    updatedAt,
    sequence,
    bids,
    asks,
  };
}

function emptySideState() {
  return {
    dipSeen: false,
    dipAt: null,
    bounceSeen: false,
    bounceAt: null,
    entryConsumed: false,
    orderId: null,
    orderStatus: 'WAITING_FOR_DIP',
    requestedShares: config.DIP_BOUNCE_SHARES,
    filledShares: 0,
    limitPrice: config.DIP_BOUNCE_LIMIT_PRICE,
    lastObservedMid: null,
    lastObservedAt: null,
    reason: 'Waiting for midpoint below $0.40.',
  };
}

function emptyMarketRecord(asset, timeframe) {
  return {
    key: `${asset}:${timeframe}`,
    asset,
    timeframe,
    windowMs: WINDOWS_MS[timeframe],
    targetStart: null,
    market: null,
    marketStatus: 'WAITING',
    lastLookupAt: 0,
    nextLookupAt: 0,
    lookupError: null,
    books: Object.fromEntries(SIDES.map((side) => [side, { bids: [], asks: [] }])),
    quotes: Object.fromEntries(SIDES.map((side) => [side, quoteFromBook({}, null, 0)])),
    sideStates: Object.fromEntries(SIDES.map((side) => [side, emptySideState()])),
  };
}

function marketStart(now, timeframe) {
  const duration = WINDOWS_MS[timeframe];
  return Math.floor(now / duration) * duration;
}

class DipBounceBot {
  constructor({
    marketData = defaultMarketData,
    now = Date.now,
    initialCapital = config.DEMO_CAPITAL,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    this.marketData = marketData;
    this.now = now;
    this.initialCapital = Number(initialCapital);
    this.cash = this.initialCapital;
    this.WebSocketImpl = WebSocketImpl;
    this.records = new Map();
    for (const asset of ASSETS) {
      for (const timeframe of TIMEFRAMES) {
        const record = emptyMarketRecord(asset, timeframe);
        this.records.set(record.key, record);
      }
    }
    this.positions = [];
    this.orders = [];
    this.events = [];
    this.orderSequence = 0;
    this.positionSequence = 0;
    this.marketUpdateSequence = 0;
    this.tokenRefs = new Map();
    this.marketStream = null;
    this.streamSignature = '';
    this.streamGeneration = 0;
    this.websocket = {
      status: 'WAITING',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
    this.resolutionAttempts = new Map();
    this.resolutionInFlight = new Set();
    this.completedWindows = new Set();
    this.status = 'STARTING';
    this.statusReason = 'Loading the current BTC, ETH, SOL, and DOGE markets.';
    this.running = false;
    this.timer = null;
    this.tickInFlight = false;
    this.lastEquitySampleAt = 0;
    this.peakEquity = this.initialCapital;
    this.maxDrawdown = 0;
    this.equityCurve = [{ at: this.now(), equity: this.initialCapital }];
  }

  log(message, { asset = null, timeframe = null, side = null, outcome = 'neutral', type = 'INFO', now = this.now() } = {}) {
    const event = {
      time: now,
      asset,
      timeframe,
      side,
      type,
      outcome,
      message,
    };
    this.events.unshift(event);
    if (this.events.length > 200) this.events.length = 200;
    console.log(`[dip-bounce] ${JSON.stringify(event)}`);
    return event;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.status = 'SCANNING';
    this.statusReason = 'Discovering active markets and connecting to Polymarket CLOB updates.';
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, config.DIP_BOUNCE_POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closeMarketStream();
    this.status = 'STOPPED';
  }

  async tick(now = this.now()) {
    if (this.tickInFlight || !this.running) return;
    this.tickInFlight = true;
    try {
      await Promise.all([...this.records.values()].map((record) => this.refreshMarket(record, now)));
      for (const record of this.records.values()) {
        if (record.market && now >= Number(record.market.end)) this.expireMarket(record, now);
      }
      this.syncMarketStream();
      this.markPositions(now);
      await this.checkResolutions(now);
      this.updateAccountMetrics(now);

      if (this.websocket.status === 'CONNECTED') {
        this.status = 'RUNNING';
        this.statusReason = 'Monitoring all active asset windows through the Polymarket CLOB WebSocket.';
      } else if ([...this.records.values()].some((record) => record.marketStatus === 'OPEN')) {
        this.status = 'WAITING_FOR_FEED';
        this.statusReason = 'Markets are loaded; waiting for the Polymarket CLOB WebSocket to connect.';
      } else {
        this.status = 'SCANNING';
        this.statusReason = 'Searching for the current BTC, ETH, SOL, and DOGE 5m/15m windows.';
      }
    } catch (error) {
      this.status = 'ERROR';
      this.statusReason = error?.message || 'The paper bot encountered an unexpected error.';
      this.log(this.statusReason, { outcome: 'bad', type: 'ERROR', now });
    } finally {
      this.tickInFlight = false;
    }
  }

  async refreshMarket(record, now) {
    const expectedStart = marketStart(now, record.timeframe);
    if (record.targetStart !== expectedStart) {
      if (record.market) this.expireMarket(record, now);
      record.targetStart = expectedStart;
      record.market = null;
      record.marketStatus = 'DISCOVERING';
      record.lastLookupAt = 0;
      record.nextLookupAt = 0;
      record.lookupError = null;
      record.books = Object.fromEntries(SIDES.map((side) => [side, { bids: [], asks: [] }]));
      record.quotes = Object.fromEntries(SIDES.map((side) => [side, quoteFromBook({}, null, 0)]));
      record.sideStates = Object.fromEntries(SIDES.map((side) => [side, emptySideState()]));
    }
    if (record.market || now < record.nextLookupAt) return;

    record.lastLookupAt = now;
    record.nextLookupAt = now + config.DIP_BOUNCE_MARKET_RETRY_MS;
    try {
      const market = await this.marketData.getAssetMarket(
        record.asset.toLowerCase(),
        expectedStart,
        record.windowMs,
      );
      if (!market) {
        record.marketStatus = 'MISSING';
        record.lookupError = null;
        return;
      }
      if (!market.tokens?.UP || !market.tokens?.DOWN) {
        throw new Error(`${record.asset} ${record.timeframe} market is missing an UP or DOWN token.`);
      }
      record.market = {
        ...market,
        asset: record.asset,
        timeframe: record.timeframe,
        start: Number(market.start ?? expectedStart),
        end: Number(market.end ?? expectedStart + record.windowMs),
      };
      record.marketStatus = now >= record.market.end ? 'ENDED' : 'OPEN';
      record.lookupError = null;
      if (record.marketStatus === 'OPEN') {
        this.log(`Loaded ${record.asset} ${record.timeframe} market. Watching both sides from this point onward.`, {
          asset: record.asset,
          timeframe: record.timeframe,
          now,
        });
      }
    } catch (error) {
      record.marketStatus = 'ERROR';
      record.lookupError = error?.message || 'Market lookup failed.';
      this.log(record.lookupError, {
        asset: record.asset,
        timeframe: record.timeframe,
        outcome: 'bad',
        type: 'MARKET_ERROR',
        now,
      });
    }
  }

  expireMarket(record, now) {
    const market = record.market;
    if (!market) return;
    const marketId = String(market.id || market.slug);
    let cancelled = 0;
    for (const order of this.orders) {
      if (order.marketId !== marketId || order.status !== 'RESTING') continue;
      order.status = 'CANCELLED_WINDOW_END';
      order.cancelledAt = now;
      order.reservedCash = 0;
      const state = record.sideStates[order.side];
      if (state.orderId === order.id) {
        state.orderStatus = 'CANCELLED_WINDOW_END';
        state.reason = 'The $0.48 paper limit was not touched before the market window ended.';
      }
      cancelled += 1;
    }
    let awaiting = 0;
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.status !== 'OPEN') continue;
      position.status = 'PENDING_RESOLUTION';
      position.pendingResolutionAt = now;
      position.markStatus = position.markBid == null ? 'PENDING_RESOLUTION' : 'LAST_MARK_PENDING_RESOLUTION';
      position.unrealizedPnl = null;
      awaiting += 1;
    }
    if (record.marketStatus !== 'ENDED' || cancelled || awaiting) {
      record.marketStatus = 'ENDED';
      this.completedWindows.add(`${marketId}:${record.timeframe}`);
      this.log(
        `Window ended: ${cancelled} unfilled limit(s) cancelled; ${awaiting} position(s) sent to official resolution.`,
        { asset: record.asset, timeframe: record.timeframe, now },
      );
    }
  }

  syncMarketStream() {
    this.tokenRefs.clear();
    const tokenIds = [];
    for (const record of this.records.values()) {
      if (!record.market || record.marketStatus !== 'OPEN') continue;
      for (const side of SIDES) {
        const tokenId = String(record.market.tokens?.[side] || '');
        if (!tokenId) continue;
        this.tokenRefs.set(tokenId, { recordKey: record.key, side });
        tokenIds.push(tokenId);
      }
    }
    const uniqueTokens = [...new Set(tokenIds)].sort();
    const signature = uniqueTokens.join('|');
    if (signature === this.streamSignature) return;
    this.closeMarketStream();
    this.streamSignature = signature;
    if (!uniqueTokens.length) {
      this.websocket = { ...this.websocket, status: 'WAITING', error: null };
      return;
    }
    if (typeof this.marketData.connectMarketStream !== 'function') {
      this.websocket = {
        ...this.websocket,
        status: 'ERROR',
        error: 'Polymarket CLOB WebSocket support is unavailable.',
      };
      return;
    }
    const generation = ++this.streamGeneration;
    this.websocket = { ...this.websocket, status: 'CONNECTING', error: null };
    try {
      this.marketStream = this.marketData.connectMarketStream(uniqueTokens, {
        WebSocketImpl: this.WebSocketImpl,
        heartbeatMs: 10_000,
        reconnectMinMs: 1_000,
        reconnectMaxMs: 15_000,
        onMessage: (message) => {
          if (generation === this.streamGeneration) this.handleMarketMessage(message);
        },
        onStatus: (status) => {
          if (generation !== this.streamGeneration) return;
          this.websocket = {
            ...this.websocket,
            ...status,
            connectedAt: status.status === 'CONNECTED' ? this.now() : this.websocket.connectedAt,
            error: status.error || null,
          };
        },
      });
    } catch (error) {
      this.websocket = {
        ...this.websocket,
        status: 'ERROR',
        error: error?.message || 'Unable to connect to the Polymarket CLOB WebSocket.',
      };
    }
  }

  closeMarketStream() {
    if (this.marketStream) {
      this.streamGeneration += 1;
      try { this.marketStream.close(); } catch (_) {}
      this.marketStream = null;
    }
    this.streamSignature = '';
  }

  handleMarketMessage(message) {
    if (Array.isArray(message)) {
      for (const item of message) this.handleMarketMessage(item);
      return;
    }
    if (!message || typeof message !== 'object') return;
    const type = String(message.event_type || message.eventType || '').toLowerCase();
    const eventTime = normalizeTimestamp(message.timestamp, this.now());
    const apply = (change) => {
      const tokenId = String(change?.asset_id || change?.assetId || message.asset_id || message.assetId || '');
      const ref = this.tokenRefs.get(tokenId);
      if (!ref) return;
      const record = this.records.get(ref.recordKey);
      if (!record) return;
      const book = record.books[ref.side];
      const side = String(change?.side || '').toUpperCase();
      if (side === 'BUY' || side === 'SELL') {
        const levels = side === 'BUY' ? book.bids : book.asks;
        const price = Number(change.price);
        const size = Number(change.size);
        if (!(price > 0 && price < 1) || !Number.isFinite(size) || size < 0) return;
        const existing = levels.find((level) => Math.abs(level.price - price) < 1e-8);
        if (size === 0) {
          if (existing) levels.splice(levels.indexOf(existing), 1);
        } else if (existing) {
          existing.size = size;
        } else {
          levels.push({ price, size });
        }
      }
      this.applyBook(record, ref.side, book, eventTime);
    };

    if (type === 'book') {
      const ref = this.tokenRefs.get(String(message.asset_id || message.assetId || ''));
      const record = ref && this.records.get(ref.recordKey);
      if (!record) return;
      record.books[ref.side] = {
        bids: normalizedLevels(message.bids, true),
        asks: normalizedLevels(message.asks, false),
      };
      this.applyBook(record, ref.side, record.books[ref.side], eventTime);
    } else if (type === 'price_change' || type === 'price_changes') {
      const changes = Array.isArray(message.price_changes) ? message.price_changes : [message];
      for (const change of changes) apply(change);
    }
    this.websocket.lastMessageAt = this.now();
  }

  applyBook(record, side, book, updatedAt) {
    const sequence = ++this.marketUpdateSequence;
    const quote = quoteFromBook(book, updatedAt, sequence);
    record.quotes[side] = quote;
    const state = record.sideStates[side];
    state.lastObservedMid = quote.mid;
    state.lastObservedAt = updatedAt;
    this.processSide(record, side, quote, sequence);
    this.tryFillOrder(record, side, quote, sequence);
    this.markPositions(this.now(), record.key, side);
    this.checkTakeProfits(record, side, quote, this.now());
  }

  processSide(record, side, quote, sequence) {
    const market = record.market;
    const now = this.now();
    const sideState = record.sideStates[side];
    if (!market || record.marketStatus !== 'OPEN' || now < market.start || now >= market.end) return;
    const isFresh = Number.isFinite(Number(quote.updatedAt))
      && now - Number(quote.updatedAt) <= config.DIP_BOUNCE_MAX_QUOTE_AGE_MS;
    if (!isFresh || !Number.isFinite(Number(quote.mid))) return;

    if (!sideState.entryConsumed && Number(quote.mid) < config.DIP_BOUNCE_PRICE_DIP) {
      if (!sideState.dipSeen) {
        sideState.dipSeen = true;
        sideState.dipAt = now;
        sideState.orderStatus = 'WAITING_FOR_BOUNCE';
        sideState.reason = `Midpoint dipped below $${config.DIP_BOUNCE_PRICE_DIP.toFixed(2)}; waiting for $${config.DIP_BOUNCE_PRICE_BOUNCE.toFixed(2)} rebound.`;
        this.log(`${side} midpoint dipped below $0.40; armed for rebound.`, {
          asset: record.asset, timeframe: record.timeframe, side, now,
        });
      }
    }

    if (!sideState.dipSeen || sideState.entryConsumed
      || Number(quote.mid) < config.DIP_BOUNCE_PRICE_BOUNCE) return;
    sideState.bounceSeen = true;
    sideState.bounceAt = now;

    const orderCost = config.DIP_BOUNCE_LIMIT_PRICE * config.DIP_BOUNCE_SHARES;
    if (this.availableCash() + 1e-8 < orderCost) {
      sideState.orderStatus = 'WAITING_FOR_CASH';
      sideState.reason = `Rebound qualified, but $${orderCost.toFixed(2)} paper collateral is unavailable.`;
      return;
    }

    const order = {
      id: `entry-${++this.orderSequence}`,
      marketId: String(market.id || market.slug),
      marketSlug: market.slug,
      marketTitle: market.title,
      asset: record.asset,
      timeframe: record.timeframe,
      windowStart: market.start,
      windowEnd: market.end,
      side,
      action: 'BUY_LIMIT',
      status: 'RESTING',
      limitPrice: config.DIP_BOUNCE_LIMIT_PRICE,
      requestedShares: config.DIP_BOUNCE_SHARES,
      filledShares: 0,
      placedAt: now,
      placedSequence: sequence,
      reservedCash: orderCost,
      fees: 0,
      fillRule: 'A later CLOB book update has best bid at or below $0.47.',
    };
    this.orders.unshift(order);
    sideState.entryConsumed = true;
    sideState.orderId = order.id;
    sideState.orderStatus = 'RESTING';
    sideState.reason = 'Rebound reached $0.50; resting 100-share paper limit at $0.48.';
    this.log(`${side} rebound reached $0.50; placed a 100-share paper limit at $0.48.`, {
      asset: record.asset, timeframe: record.timeframe, side, now,
    });
  }

  tryFillOrder(record, side, quote, sequence) {
    const sideState = record.sideStates[side];
    const order = this.orders.find((item) => item.id === sideState.orderId);
    if (!order || order.status !== 'RESTING' || sequence <= order.placedSequence) return;
    if (!(Number(quote.bestBid) <= config.DIP_BOUNCE_FILL_BID)) return;
    const shares = config.DIP_BOUNCE_SHARES;
    const cost = config.DIP_BOUNCE_LIMIT_PRICE * shares;
    if (this.cash + 1e-8 < cost) {
      order.status = 'CANCELLED_INSUFFICIENT_CASH';
      order.cancelledAt = this.now();
      order.reservedCash = 0;
      sideState.orderStatus = order.status;
      sideState.reason = 'The paper account no longer has enough free cash to record the fill.';
      this.log(`${side} paper order could not fill: free cash was insufficient.`, {
        asset: record.asset, timeframe: record.timeframe, side, outcome: 'bad', type: 'ORDER_ERROR',
      });
      return;
    }
    const now = this.now();
    order.status = 'FILLED';
    order.filledAt = now;
    order.fillPrice = config.DIP_BOUNCE_LIMIT_PRICE;
    order.filledShares = shares;
    order.reservedCash = 0;
    this.cash -= cost;

    const position = {
      id: `position-${++this.positionSequence}`,
      marketId: order.marketId,
      marketSlug: order.marketSlug,
      marketTitle: order.marketTitle,
      asset: record.asset,
      timeframe: record.timeframe,
      side,
      status: 'OPEN',
      shares,
      entryPrice: config.DIP_BOUNCE_LIMIT_PRICE,
      totalCost: cost,
      fees: 0,
      estimatedMakerRebate: 0,
      entryAt: now,
      windowStart: order.windowStart,
      windowEnd: order.windowEnd,
      markBid: Number.isFinite(Number(quote.bestBid)) ? Number(quote.bestBid) : null,
      markUpdatedAt: quote.updatedAt,
      markStatus: 'LIVE',
      unrealizedPnl: Number.isFinite(Number(quote.bestBid))
        ? Number(quote.bestBid) * shares - cost
        : null,
      realizedPnl: null,
      exitPrice: null,
      exitPayout: null,
      exitReason: null,
    };
    this.positions.unshift(position);
    sideState.orderStatus = 'FILLED';
    sideState.filledShares = shares;
    sideState.reason = 'Filled at the $0.48 limit after a later bid reached $0.47 or lower.';
    this.log(`${side} paper limit filled: ${shares} shares at the fixed $0.48 limit.`, {
      asset: record.asset, timeframe: record.timeframe, side, outcome: 'good', type: 'BUY_FILLED', now,
    });
    this.updateAccountMetrics(now, true);
  }

  checkTakeProfits(record, side, quote, now) {
    if (!record.market || record.marketStatus !== 'OPEN') return;
    for (const position of this.positions) {
      if (position.marketId !== String(record.market.id || record.market.slug)
        || position.side !== side || position.status !== 'OPEN') continue;
      if (!(Number(quote.bestBid) >= config.DIP_BOUNCE_TAKE_PROFIT_BID)) continue;
      const payout = position.shares * config.DIP_BOUNCE_TAKE_PROFIT_PAYOUT;
      this.cash += payout;
      position.status = 'TAKE_PROFIT';
      position.exitAt = now;
      position.exitPrice = config.DIP_BOUNCE_TAKE_PROFIT_BID;
      position.exitPayout = config.DIP_BOUNCE_TAKE_PROFIT_PAYOUT;
      position.exitReason = 'TAKE_PROFIT_099';
      position.realizedPnl = payout - position.totalCost - position.fees + position.estimatedMakerRebate;
      position.markBid = config.DIP_BOUNCE_TAKE_PROFIT_BID;
      position.markUpdatedAt = quote.updatedAt;
      position.markStatus = 'CLOSED';
      position.unrealizedPnl = null;
      const state = record.sideStates[side];
      state.orderStatus = 'TAKE_PROFIT';
      state.reason = 'Take-profit reached at a $0.99 best bid; credited $1.00 per share.';
      this.log(`${side} take-profit hit at $0.99; credited $1.00 per share.`, {
        asset: record.asset,
        timeframe: record.timeframe,
        side,
        outcome: position.realizedPnl >= 0 ? 'good' : 'bad',
        type: 'TAKE_PROFIT',
        now,
      });
      this.updateAccountMetrics(now, true);
    }
  }

  markPositions(now, onlyRecordKey = null, onlySide = null) {
    for (const position of this.positions) {
      if (position.status !== 'OPEN') continue;
      if (onlySide && position.side !== onlySide) continue;
      const record = this.records.get(`${position.asset}:${position.timeframe}`);
      if (!record || (onlyRecordKey && record.key !== onlyRecordKey)) continue;
      if (String(record.market?.id || record.market?.slug) !== position.marketId) continue;
      const quote = record.quotes[position.side];
      const fresh = Number.isFinite(Number(quote.updatedAt))
        && now - Number(quote.updatedAt) <= config.DIP_BOUNCE_MAX_QUOTE_AGE_MS;
      if (!fresh || !Number.isFinite(Number(quote.bestBid))) {
        position.markStatus = 'STALE';
        position.unrealizedPnl = null;
        continue;
      }
      position.markBid = Number(quote.bestBid);
      position.markUpdatedAt = quote.updatedAt;
      position.markStatus = 'LIVE';
      position.unrealizedPnl = position.markBid * position.shares
        - position.totalCost - position.fees + position.estimatedMakerRebate;
    }
  }

  availableCash() {
    const reserved = this.orders.reduce((sum, order) =>
      sum + (order.status === 'RESTING' ? Number(order.reservedCash) || 0 : 0), 0);
    return Math.max(0, this.cash - reserved);
  }

  async checkResolutions(now) {
    const pending = new Map();
    for (const position of this.positions) {
      if (position.status === 'PENDING_RESOLUTION' && position.marketId) {
        pending.set(position.marketId, position);
      }
    }
    await Promise.all([...pending.entries()].map(async ([marketId, sample]) => {
      if (this.resolutionInFlight.has(marketId)) return;
      const lastAttempt = this.resolutionAttempts.get(marketId) || 0;
      if (now - lastAttempt < config.DIP_BOUNCE_RESOLUTION_POLL_MS) return;
      this.resolutionAttempts.set(marketId, now);
      this.resolutionInFlight.add(marketId);
      try {
        const market = await this.marketData.getMarket(marketId);
        const winner = this.marketData.resolvedWinner(market);
        if (winner) this.settleMarket(marketId, winner, now);
      } catch (error) {
        sample.resolutionError = error?.message || 'Resolution check failed.';
      } finally {
        this.resolutionInFlight.delete(marketId);
      }
    }));
  }

  settleMarket(marketId, winner, now) {
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.status !== 'PENDING_RESOLUTION') continue;
      const won = position.side === winner;
      const payout = won ? position.shares : 0;
      this.cash += payout;
      position.status = won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS';
      position.resolvedAt = now;
      position.resolutionWinner = winner;
      position.exitPrice = won ? 1 : 0;
      position.exitPayout = won ? 1 : 0;
      position.exitReason = 'OFFICIAL_RESOLUTION';
      position.realizedPnl = payout - position.totalCost - position.fees + position.estimatedMakerRebate;
      position.markStatus = 'CLOSED';
      position.unrealizedPnl = null;
      this.log(`${position.side} resolved ${won ? 'WIN' : 'LOSS'}; official market winner was ${winner}.`, {
        asset: position.asset,
        timeframe: position.timeframe,
        side: position.side,
        outcome: won ? 'good' : 'bad',
        type: 'RESOLUTION',
        now,
      });
    }
    this.updateAccountMetrics(now, true);
  }

  updateAccountMetrics(now, forceSample = false) {
    const openOrPending = this.positions.filter((position) =>
      position.status === 'OPEN' || position.status === 'PENDING_RESOLUTION');
    const markedValue = openOrPending.reduce((sum, position) =>
      sum + (Number.isFinite(Number(position.markBid)) ? Number(position.markBid) * position.shares : 0), 0);
    const equity = this.cash + markedValue;
    this.peakEquity = Math.max(this.peakEquity, equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.peakEquity - equity);
    if (forceSample || now - this.lastEquitySampleAt >= 15_000) {
      this.equityCurve.push({ at: now, equity });
      if (this.equityCurve.length > 1000) this.equityCurve.splice(0, this.equityCurve.length - 1000);
      this.lastEquitySampleAt = now;
    }
  }

  accountSnapshot() {
    const positions = this.positions;
    const active = positions.filter((position) => ['OPEN', 'PENDING_RESOLUTION'].includes(position.status));
    const closed = positions.filter((position) =>
      position.realizedPnl !== null && position.realizedPnl !== undefined
      && Number.isFinite(Number(position.realizedPnl)));
    const wins = closed.filter((position) => Number(position.realizedPnl) > 0).length;
    const losses = closed.filter((position) => Number(position.realizedPnl) < 0).length;
    const markedValue = active.reduce((sum, position) =>
      sum + (Number.isFinite(Number(position.markBid)) ? Number(position.markBid) * position.shares : 0), 0);
    const unrealizedPnl = active.filter((position) => position.status === 'OPEN'
      && position.markStatus === 'LIVE' && Number.isFinite(Number(position.unrealizedPnl)))
      .reduce((sum, position) => sum + Number(position.unrealizedPnl), 0);
    const realizedPnl = closed.reduce((sum, position) => sum + Number(position.realizedPnl), 0);
    const equity = this.cash + markedValue;
    const settledMarkets = new Set(closed
      .filter((position) => position.exitReason === 'OFFICIAL_RESOLUTION')
      .map((position) => position.marketId)).size;
    return {
      initialCapital: this.initialCapital,
      cash: this.cash,
      availableCash: this.availableCash(),
      reservedCash: this.cash - this.availableCash(),
      equity,
      realizedPnl,
      unrealizedPnl,
      markedValue,
      openPositions: active.filter((position) => position.status === 'OPEN').length,
      pendingResolution: active.filter((position) => position.status === 'PENDING_RESOLUTION').length,
      settledPositions: closed.length,
      settledMarkets,
      wins,
      losses,
      winRate: closed.length ? wins / closed.length * 100 : 0,
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPercent: this.peakEquity ? this.maxDrawdown / this.peakEquity * 100 : 0,
      peakEquity: this.peakEquity,
      totalFees: positions.reduce((sum, position) => sum + (Number(position.fees) || 0), 0),
      equityCurve: [...this.equityCurve],
    };
  }

  snapshot() {
    const now = this.now();
    const markets = [...this.records.values()].map((record) => {
      const market = record.market;
      return {
        key: record.key,
        asset: record.asset,
        timeframe: record.timeframe,
        title: market?.title || `${record.asset} ${record.timeframe} window`,
        slug: market?.slug || null,
        id: market?.id || null,
        start: market?.start ?? record.targetStart,
        end: market?.end ?? (record.targetStart == null ? null : record.targetStart + record.windowMs),
        marketStatus: record.marketStatus,
        lookupError: record.lookupError,
        feedStatus: this.websocket.status,
        secondsRemaining: market ? Math.max(0, (market.end - now) / 1000) : null,
        sideStates: Object.fromEntries(SIDES.map((side) => {
          const quote = record.quotes[side];
          const sideState = record.sideStates[side];
          const age = quote.updatedAt == null ? null : Math.max(0, now - quote.updatedAt);
          return [side, {
            bestBid: quote.bestBid,
            bestAsk: quote.bestAsk,
            mid: quote.mid,
            updatedAt: quote.updatedAt,
            ageMs: age,
            fresh: age != null && age <= config.DIP_BOUNCE_MAX_QUOTE_AGE_MS,
            dipSeen: sideState.dipSeen,
            dipAt: sideState.dipAt,
            bounceSeen: sideState.bounceSeen,
            bounceAt: sideState.bounceAt,
            orderStatus: sideState.orderStatus,
            limitPrice: sideState.limitPrice,
            requestedShares: sideState.requestedShares,
            filledShares: sideState.filledShares,
            reason: sideState.reason,
          }];
        })),
      };
    });
    const account = this.accountSnapshot();
    const liveMarkets = markets.filter((market) => market.marketStatus === 'OPEN').length;
    return {
      now,
      mode: 'DEMO ONLY',
      status: this.status,
      statusReason: this.statusReason,
      strategy: {
        ...STRATEGY,
        execution: 'PAPER ONLY',
        entry: 'Midpoint below $0.40 arms a side; midpoint at or above $0.50 places one resting $0.48 paper buy for 100 shares.',
        fill: 'Only a later CLOB update with best bid at or below $0.47 confirms a full-size simulated fill at $0.48.',
        takeProfit: 'Best bid at or above $0.99 closes at a modeled $1.00 payout per share.',
        stopLoss: null,
        resolution: 'No stop-loss. Anything not at take-profit by its own window end waits for official resolution.',
        expiry: 'Unfilled limit orders cancel at their market window end.',
      },
      account,
      websocket: { ...this.websocket },
      scanner: {
        assets: [...ASSETS],
        timeframes: [...TIMEFRAMES],
        activeMarkets: liveMarkets,
        totalMarkets: this.records.size,
        marketData: 'Polymarket Gamma metadata and CLOB market WebSocket only; no Binance fallback.',
        lastMessageAgeMs: this.websocket.lastMessageAt == null
          ? null : Math.max(0, now - this.websocket.lastMessageAt),
      },
      markets,
      positions: this.positions.slice(0, 300).map((position) => ({ ...position })),
      orders: this.orders.slice(0, 300).map((order) => ({ ...order })),
      events: this.events.slice(0, 200).map((event) => ({ ...event })),
    };
  }
}

module.exports = DipBounceBot;
module.exports._test = {
  ASSETS,
  TIMEFRAMES,
  STRATEGY,
  marketStart,
  quoteFromBook,
  normalizeTimestamp,
  emptyMarketRecord,
};
