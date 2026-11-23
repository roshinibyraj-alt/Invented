'use strict';

const config = require('./config');
const defaultMarketData = require('./wick-market-data');

const ASSETS = [...config.DIP_BOUNCE_ASSETS];
const TIMEFRAMES = [...config.DIP_BOUNCE_TIMEFRAMES];
const SIDES = ['UP', 'DOWN'];
const WINDOWS_MS = { '5m': 5 * 60_000, '15m': 15 * 60_000 };
const STRATEGY = Object.freeze({
  id: 'btc-eth-5m-dip-bounce-paper',
  name: 'BTC and ETH 5m dip-and-bounce paper strategy',
  version: 'btc-eth-5m-recovery-reset-v5',
  assets: ASSETS,
  timeframes: TIMEFRAMES,
  sharesPerEntry: config.DIP_BOUNCE_SHARES,
  sizing: {
    baseShares: config.DIP_BOUNCE_SHARES,
    floorShares: config.DIP_BOUNCE_SHARES,
    stepShares: config.DIP_BOUNCE_SIZING_STEP_SHARES,
    progression: 'Per asset: add 100 shares after a loss; subtract 100 after a win. Reset to 100 when recovery-round net P&L reaches +$40.',
    recoveryProfitUsd: config.DIP_BOUNCE_RECOVERY_PROFIT_USD,
  },
  dipBelow: config.DIP_BOUNCE_PRICE_DIP,
  reboundTo: config.DIP_BOUNCE_PRICE_BOUNCE,
  orderType: 'TAKER',
  sweepCap: config.DIP_BOUNCE_TAKER_CAP,
  takeProfitBid: config.DIP_BOUNCE_TAKE_PROFIT_BID,
  takeProfitPayoutPerShare: config.DIP_BOUNCE_TAKE_PROFIT_PAYOUT,
  stopLoss: 0,
  windowEnd: 'Positions not closed by take-profit or the $0.00 stop wait for official resolution.',
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

function emptySideState(requestedShares = config.DIP_BOUNCE_SHARES) {
  return {
    dipSeen: false,
    dipAt: null,
    bounceSeen: false,
    bounceAt: null,
    entryConsumed: false,
    orderId: null,
    orderStatus: 'WAITING_FOR_DIP',
    requestedShares,
    filledShares: 0,
    limitPrice: config.DIP_BOUNCE_TAKER_CAP,
    lastObservedMid: null,
    lastObservedAt: null,
    reason: 'Waiting for midpoint below $0.35.',
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
    triggeredSide: null,
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
    ledgerStore = null,
  } = {}) {
    this.marketData = marketData;
    this.now = now;
    this.initialCapital = Number(initialCapital);
    this.cash = this.initialCapital;
    this.WebSocketImpl = WebSocketImpl;
    this.sizingByAsset = Object.fromEntries(ASSETS.map((asset) => [asset, {
      nextShares: config.DIP_BOUNCE_SHARES,
      lastOutcome: null,
      lastUpdatedAt: null,
      wins: 0,
      losses: 0,
      recoveryNetPnl: 0,
      recoveryActive: false,
      recoveryResetCount: 0,
    }]));
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
    this.statusReason = 'Loading the current BTC and ETH 5-minute markets.';
    this.running = false;
    this.timer = null;
    this.tickInFlight = false;
    this.lastEquitySampleAt = 0;
    this.peakEquity = this.initialCapital;
    this.maxDrawdown = 0;
    this.equityCurve = [{ at: this.now(), equity: this.initialCapital }];
    this.ledgerStore = ledgerStore;
    this.ledgerSaveTimer = null;
    this.ledgerSaveInFlight = null;
    this.ledgerDirty = false;
    this.ledgerPersistenceState = {
      enabled: Boolean(ledgerStore),
      restored: false,
      lastSavedAt: null,
      error: null,
    };
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
    this.scheduleLedgerSave();
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

  restoreLedger(ledger) {
    const snapshot = ledger?.snapshot || ledger;
    if (!snapshot || snapshot.strategy?.id !== STRATEGY.id || !snapshot.account) {
      throw new Error('Saved paper ledger is invalid or belongs to another strategy.');
    }
    const account = snapshot.account;
    const initialCapital = Number(account.initialCapital);
    const cash = Number(account.cash);
    if (!Number.isFinite(initialCapital) || !Number.isFinite(cash)) {
      throw new Error('Saved paper ledger has invalid account balances.');
    }

    this.initialCapital = initialCapital;
    this.cash = cash;
    this.positions = Array.isArray(snapshot.positions) ? snapshot.positions.map((position) => ({ ...position })) : [];
    this.orders = Array.isArray(snapshot.orders) ? snapshot.orders.map((order) => ({ ...order })) : [];
    this.events = Array.isArray(snapshot.events) ? snapshot.events.map((event) => ({ ...event })).slice(0, 200) : [];
    this.sizingByAsset = Object.fromEntries(ASSETS.map((asset) => {
      const saved = snapshot.sizingByAsset?.[asset] || {};
      const nextShares = Number(saved.nextShares);
      return [asset, {
        nextShares: Number.isFinite(nextShares) && nextShares >= config.DIP_BOUNCE_SHARES
          ? nextShares : config.DIP_BOUNCE_SHARES,
        lastOutcome: saved.lastOutcome || null,
        lastUpdatedAt: Number.isFinite(Number(saved.lastUpdatedAt)) ? Number(saved.lastUpdatedAt) : null,
        wins: Number.isFinite(Number(saved.wins)) ? Number(saved.wins) : 0,
        losses: Number.isFinite(Number(saved.losses)) ? Number(saved.losses) : 0,
        recoveryNetPnl: Number.isFinite(Number(saved.recoveryNetPnl)) ? Number(saved.recoveryNetPnl) : 0,
        recoveryActive: Boolean(saved.recoveryActive),
        recoveryResetCount: Number.isFinite(Number(saved.recoveryResetCount)) ? Number(saved.recoveryResetCount) : 0,
      }];
    }));
    this.peakEquity = Number.isFinite(Number(account.peakEquity)) ? Number(account.peakEquity) : cash;
    this.maxDrawdown = Number.isFinite(Number(account.maxDrawdown)) ? Number(account.maxDrawdown) : 0;
    this.equityCurve = Array.isArray(account.equityCurve)
      ? account.equityCurve.map((point) => ({ at: Number(point.at), equity: Number(point.equity) }))
        .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.equity)).slice(-1000)
      : [{ at: this.now(), equity: cash }];
    this.lastEquitySampleAt = this.equityCurve.at(-1)?.at || 0;
    this.orderSequence = this.orders.length;
    this.positionSequence = this.positions.length;
    const now = this.now();
    for (const position of this.positions) {
      const windowEnd = Number(position.windowEnd);
      if (position.status === 'OPEN' && Number.isFinite(windowEnd) && windowEnd <= now) {
        position.status = 'PENDING_RESOLUTION';
        position.pendingResolutionAt = now;
      }
      if (position.status === 'OPEN') {
        position.markStatus = 'STALE';
        position.markBid = null;
        position.markUpdatedAt = null;
        position.unrealizedPnl = null;
      } else if (position.status === 'PENDING_RESOLUTION') {
        position.markStatus = 'PENDING_RESOLUTION';
        position.unrealizedPnl = null;
      }
      if (position.sizingApplied == null) {
        position.sizingApplied = position.status !== 'OPEN' && position.status !== 'PENDING_RESOLUTION';
      }
    }
    this.ledgerPersistenceState.restored = true;
    this.updateAccountMetrics(now, true);
    this.log(`Restored ${this.positions.length} saved paper positions and their account history.`, { type: 'LEDGER_RESTORED', now });
    this.scheduleLedgerSave();
  }

  exportLedger() {
    const snapshot = this.snapshot();
    snapshot.positions = this.positions.map((position) => ({ ...position }));
    snapshot.orders = this.orders.map((order) => ({ ...order }));
    snapshot.events = this.events.map((event) => ({ ...event }));
    return {
      schemaVersion: 1,
      strategyId: STRATEGY.id,
      savedAt: this.now(),
      snapshot,
    };
  }

  scheduleLedgerSave() {
    if (!this.ledgerStore) return;
    this.ledgerDirty = true;
    if (this.ledgerSaveTimer) return;
    this.ledgerSaveTimer = setTimeout(() => {
      this.ledgerSaveTimer = null;
      void this.flushLedger();
    }, 500);
    this.ledgerSaveTimer.unref?.();
  }

  async flushLedger() {
    if (!this.ledgerStore) return;
    if (this.ledgerSaveTimer) clearTimeout(this.ledgerSaveTimer);
    this.ledgerSaveTimer = null;
    if (this.ledgerSaveInFlight) {
      this.ledgerDirty = true;
      await this.ledgerSaveInFlight;
      if (this.ledgerDirty) return this.flushLedger();
      return;
    }
    this.ledgerDirty = false;
    this.ledgerSaveInFlight = Promise.resolve().then(() => this.ledgerStore.save(this.exportLedger()));
    try {
      await this.ledgerSaveInFlight;
      this.ledgerPersistenceState.lastSavedAt = this.now();
      this.ledgerPersistenceState.error = null;
    } catch (error) {
      this.ledgerPersistenceState.error = error?.message || 'Paper history save failed.';
      console.error('[dip-bounce] Could not persist paper history:', this.ledgerPersistenceState.error);
    } finally {
      this.ledgerSaveInFlight = null;
      if (this.ledgerDirty) this.scheduleLedgerSave();
    }
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
        this.statusReason = 'Searching for the current BTC and ETH 5-minute windows.';
      }
    } catch (error) {
      this.status = 'ERROR';
      this.statusReason = error?.message || 'The paper bot encountered an unexpected error.';
      this.log(this.statusReason, { outcome: 'bad', type: 'ERROR', now });
    } finally {
      this.tickInFlight = false;
      this.scheduleLedgerSave();
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
      const nextShares = this.sizingByAsset[record.asset]?.nextShares ?? config.DIP_BOUNCE_SHARES;
      record.sideStates = Object.fromEntries(SIDES.map((side) => [side, emptySideState(nextShares)]));
      record.triggeredSide = null;
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
      this.applyRestoredWindowConsumption(record);
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

  applyRestoredWindowConsumption(record) {
    if (!record.market) return;
    const marketId = String(record.market.id || record.market.slug);
    const previousPosition = this.positions.find((position) =>
      position.marketId === marketId && position.timeframe === record.timeframe);
    if (!previousPosition) return;
    record.triggeredSide = previousPosition.side;
    const consumed = record.sideStates[previousPosition.side];
    consumed.entryConsumed = true;
    consumed.requestedShares = Number(previousPosition.requestedShares) || Number(previousPosition.shares) || config.DIP_BOUNCE_SHARES;
    consumed.filledShares = Number(previousPosition.shares) || 0;
    consumed.orderStatus = previousPosition.status;
    consumed.reason = 'This market window already has a recorded entry; it remains one entry per window after restart.';
    const other = record.sideStates[previousPosition.side === 'UP' ? 'DOWN' : 'UP'];
    other.orderStatus = 'BLOCKED_FIRST_TRIGGER';
    other.reason = `${previousPosition.side} already entered this window before the restart.`;
  }

  expireMarket(record, now) {
    const market = record.market;
    if (!market) return;
    const marketId = String(market.id || market.slug);
    let awaiting = 0;
    for (const position of this.positions) {
      if (position.marketId !== marketId || position.status !== 'OPEN') continue;
      position.status = 'PENDING_RESOLUTION';
      position.pendingResolutionAt = now;
      position.markStatus = position.markBid == null ? 'PENDING_RESOLUTION' : 'LAST_MARK_PENDING_RESOLUTION';
      position.unrealizedPnl = null;
      awaiting += 1;
    }
    if (record.marketStatus !== 'ENDED' || awaiting) {
      record.marketStatus = 'ENDED';
      this.completedWindows.add(`${marketId}:${record.timeframe}`);
      this.log(
        `Window ended: ${awaiting} position(s) sent to official resolution.`,
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
    this.markPositions(this.now(), record.key, side);
    this.checkStopLosses(record, side, quote, this.now());
    this.checkTakeProfits(record, side, quote, this.now());
    this.scheduleLedgerSave();
  }

  processSide(record, side, quote, sequence) {
    const market = record.market;
    const now = this.now();
    const sideState = record.sideStates[side];
    if (!market || record.marketStatus !== 'OPEN' || now < market.start || now >= market.end) return;
    if (record.triggeredSide && record.triggeredSide !== side) {
      sideState.orderStatus = 'BLOCKED_FIRST_TRIGGER';
      sideState.reason = `${record.triggeredSide} triggered first; only one side may enter this window.`;
      return;
    }
    const isFresh = Number.isFinite(Number(quote.updatedAt))
      && now - Number(quote.updatedAt) <= config.DIP_BOUNCE_MAX_QUOTE_AGE_MS;
    if (!isFresh || !Number.isFinite(quote.mid)) return;

    if (!sideState.entryConsumed && Number(quote.mid) < config.DIP_BOUNCE_PRICE_DIP) {
      if (!sideState.dipSeen) {
        sideState.dipSeen = true;
        sideState.dipAt = now;
        sideState.orderStatus = 'WAITING_FOR_BOUNCE';
        sideState.reason = `Midpoint dipped below $${config.DIP_BOUNCE_PRICE_DIP.toFixed(2)}; waiting for $${config.DIP_BOUNCE_PRICE_BOUNCE.toFixed(2)} rebound.`;
        this.log(`${side} midpoint dipped below $0.35; armed for rebound.`, {
          asset: record.asset, timeframe: record.timeframe, side, now,
        });
      }
    }

    if (!sideState.dipSeen || sideState.entryConsumed
      || Number(quote.mid) < config.DIP_BOUNCE_PRICE_BOUNCE) return;
    record.triggeredSide = side;
    sideState.bounceSeen = true;
    sideState.bounceAt = now;
    const otherSideState = record.sideStates[side === 'UP' ? 'DOWN' : 'UP'];
    otherSideState.orderStatus = 'BLOCKED_FIRST_TRIGGER';
    otherSideState.reason = `${side} triggered first; only one side may enter this window.`;

    // Simulate immediate execution against visible asks, not a later pullback.
    const feeRate = market.feesEnabled === false ? 0
      : Number(market.feeSchedule?.rate ?? (record.asset === 'BTC' ? 0.05 : 0.01));
    if (!Number.isFinite(feeRate) || feeRate < 0) return;
    const requestedShares = this.sizingByAsset[record.asset]?.nextShares ?? config.DIP_BOUNCE_SHARES;
    sideState.requestedShares = requestedShares;
    let remaining = requestedShares;
    let cost = 0;
    let fees = 0;
    const fills = [];
    for (const level of quote.asks) {
      if (level.price > config.DIP_BOUNCE_TAKER_CAP || remaining <= 0) break;
      const quantity = Math.min(remaining, level.size);
      const fee = quantity * feeRate * level.price * (1 - level.price);
      fills.push({ price: level.price, shares: quantity, fee });
      cost += quantity * level.price;
      fees += fee;
      remaining -= quantity;
    }
    const shares = requestedShares - remaining;
    if (shares <= 0) {
      sideState.reason = 'Rebound qualified; waiting for executable asks for a taker buy.';
      return;
    }
    const orderCost = cost + fees;
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
      action: 'BUY_TAKER',
      status: remaining > 0 ? 'PARTIALLY_FILLED' : 'FILLED',
      limitPrice: config.DIP_BOUNCE_TAKER_CAP,
      requestedShares,
      filledShares: shares,
      placedAt: now,
      placedSequence: sequence,
      reservedCash: 0,
      fees,
      fills,
      filledAt: now,
      fillPrice: cost / shares,
      unfilledShares: remaining,
      fillRule: 'Immediate visible-ask sweep up to $0.99; any unfilled remainder is cancelled.',
    };
    this.orders.unshift(order);
    sideState.entryConsumed = true;
    sideState.orderId = order.id;
    this.cash -= orderCost;

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
      entryPrice: order.fillPrice,
      totalCost: cost,
      fees,
      estimatedMakerRebate: 0,
      entryAt: now,
      windowStart: order.windowStart,
      windowEnd: order.windowEnd,
      markBid: Number.isFinite(Number(quote.bestBid)) ? Number(quote.bestBid) : null,
      markUpdatedAt: quote.updatedAt,
      markStatus: 'LIVE',
      unrealizedPnl: Number.isFinite(Number(quote.bestBid))
        ? Number(quote.bestBid) * shares - cost - fees
        : null,
      realizedPnl: null,
      exitPrice: null,
      exitPayout: null,
      exitReason: null,
      requestedShares,
      sizingApplied: false,
      nextEntryShares: null,
    };
    this.positions.unshift(position);
    sideState.orderStatus = order.status;
    sideState.filledShares = shares;
    sideState.reason = `Taker buy filled ${shares} shares at $${order.fillPrice.toFixed(4)} average; $${fees.toFixed(4)} entry fees.`;
    this.log(`${side} paper taker filled: ${shares} shares at $${order.fillPrice.toFixed(4)} average, fees $${fees.toFixed(4)}.`, {
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
      this.updateSizingAfterClose(position, true, now);
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

  checkStopLosses(record, side, quote, now) {
    if (!record.market || record.marketStatus !== 'OPEN') return;
    const fresh = Number.isFinite(Number(quote.updatedAt))
      && now - Number(quote.updatedAt) <= config.DIP_BOUNCE_MAX_QUOTE_AGE_MS;
    if (!fresh || (quote.bestBid != null && Number(quote.bestBid) > 0)) return;
    for (const position of this.positions) {
      if (position.marketId !== String(record.market.id || record.market.slug)
        || position.side !== side || position.status !== 'OPEN') continue;
      position.status = 'STOP_LOSS';
      position.exitAt = now;
      position.exitPrice = 0;
      position.exitPayout = 0;
      position.exitReason = 'STOP_LOSS_000';
      position.realizedPnl = -position.totalCost - position.fees + position.estimatedMakerRebate;
      this.updateSizingAfterClose(position, false, now);
      position.markBid = 0;
      position.markUpdatedAt = quote.updatedAt;
      position.markStatus = 'CLOSED';
      position.unrealizedPnl = null;
      const state = record.sideStates[side];
      state.orderStatus = 'STOP_LOSS';
      state.reason = 'The $0.00 stop-loss triggered; position closed at zero payout.';
      this.log(`${side} stop-loss hit at $0.00; closed with zero payout.`, {
        asset: record.asset,
        timeframe: record.timeframe,
        side,
        outcome: 'bad',
        type: 'STOP_LOSS',
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
      this.updateSizingAfterClose(position, won, now);
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

  updateSizingAfterClose(position, won, now) {
    if (position.sizingApplied) return;
    const state = this.sizingByAsset[position.asset];
    if (!state) return;
    const netPnl = Number(position.realizedPnl) || 0;
    if (won) {
      if (state.recoveryActive) state.recoveryNetPnl += netPnl;
      state.nextShares = Math.max(config.DIP_BOUNCE_SHARES, state.nextShares - config.DIP_BOUNCE_SIZING_STEP_SHARES);
    } else {
      if (!state.recoveryActive) state.recoveryNetPnl = 0;
      state.recoveryActive = true;
      state.recoveryNetPnl += netPnl;
      state.nextShares += config.DIP_BOUNCE_SIZING_STEP_SHARES;
    }
    state.lastOutcome = won ? 'WIN' : 'LOSS';
    state.lastUpdatedAt = now;
    if (won) state.wins += 1;
    else state.losses += 1;
    let recovered = false;
    let recoveredNetPnl = null;
    if (state.recoveryActive && state.recoveryNetPnl >= config.DIP_BOUNCE_RECOVERY_PROFIT_USD) {
      recovered = true;
      recoveredNetPnl = state.recoveryNetPnl;
      state.nextShares = config.DIP_BOUNCE_SHARES;
      state.recoveryNetPnl = 0;
      state.recoveryActive = false;
      state.recoveryResetCount += 1;
    }
    position.sizingApplied = true;
    position.sizingOutcome = state.lastOutcome;
    position.nextEntryShares = state.nextShares;
    position.recoveryRoundNetPnl = state.recoveryNetPnl;
    this.log(recovered
      ? `${position.asset} recovered the sizing-round losses and reached +$${recoveredNetPnl.toFixed(2)} net; next entry reset to 100 shares.`
      : `${position.asset} next entry size ${state.nextShares} shares after ${state.lastOutcome.toLowerCase()}; recovery round net ${state.recoveryActive ? `$${state.recoveryNetPnl.toFixed(2)}` : 'not active'}.`, {
      asset: position.asset,
      timeframe: position.timeframe,
      side: position.side,
      outcome: recovered || won ? 'good' : 'bad',
      type: recovered ? 'SIZING_RECOVERY_RESET' : 'SIZING_UPDATE',
      now,
    });
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
        triggeredSide: record.triggeredSide,
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
        entry: 'BTC and ETH 5-minute windows only. Midpoint below $0.35 arms a side; the first side to reach $0.50 triggers one paper taker buy. The opposite side is blocked for that market window.',
        fill: 'Sweep visible asks immediately up to $0.99; record volume-weighted price, available shares and taker fees. No resting remainder.',
        sizing: 'Each asset starts at 100 shares. A loss adds 100; a win subtracts 100, with a 100-share floor. When recovery-round net realized P&L reaches +$40 after fees, reset immediately to 100 shares.',
        takeProfit: 'Best bid at or above $0.99 records a win and credits a modeled $1.00 payout per share; this is a paper payout, not a sell order.',
        stopLoss: '$0.00 best bid; an empty bid book is a zero-payout loss, not a sell order.',
        resolution: 'An open position that has not hit take-profit or the $0.00 stop waits for official resolution at window end.',
        expiry: 'Unfilled taker quantity cancels immediately.',
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
      sizingByAsset: Object.fromEntries(ASSETS.map((asset) => [asset, { ...this.sizingByAsset[asset] }])),
      ledgerPersistence: {
        enabled: this.ledgerPersistenceState.enabled,
        restored: this.ledgerPersistenceState.restored,
        lastSavedAt: this.ledgerPersistenceState.lastSavedAt,
        error: this.ledgerPersistenceState.error,
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
