'use strict';

const MispricingBot = require('./mispricing-bot');
const WickBot = require('./wick-bot');
const config = require('./config');
const { makerRebateFor, feeContext } = WickBot._test;

const EPSILON = 1e-8;
const ACTIVE_ORDER_STATES = new Set(['RESTING', 'PARTIALLY_FILLED']);
const ORDER_TYPE = 'PAPER_POST_ONLY_LIMIT';
const SIDES = ['UP', 'DOWN'];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

class MarketMakerBot extends MispricingBot {
  constructor(options = {}) {
    super(options);
    this.strategyId = 'btc-5m-inventory-aware-market-maker';
    this.strategyName = 'BTC 5-minute inventory-aware paper market maker';
    this.rules = {
      sharesPerSide: config.MAKER_QUOTE_SHARES,
      quoteSize: config.MAKER_QUOTE_SHARES,
      maxInventoryPerSide: config.MAKER_MAX_INVENTORY_PER_SIDE,
    };
    this.strategyWindowStart = null;
    this.makerQuotes = this.emptyMakerQuotes();
    this.fairValues = null;
    this.marketMakerState = {
      status: 'WAITING',
      reason: 'Waiting for fresh Binance and Polymarket data.',
    };
    this.makerStats = {
      ordersPlaced: 0,
      ordersCancelled: 0,
      makerBuyShares: 0,
      makerSellShares: 0,
      lastTradeAt: null,
      lastFillAt: null,
      lastFillSide: null,
    };
    this.seenMakerTrades = new Map();
  }

  emptyMakerQuotes() {
    return Object.fromEntries(SIDES.map((side) => [side, {
      fairValue: null,
      bidPrice: null,
      askPrice: null,
      bidOrderId: null,
      askOrderId: null,
      bidStatus: 'WAITING',
      askStatus: 'WAITING',
      inventoryShares: 0,
      halfSpread: null,
      inventorySkew: 0,
      reason: 'Waiting for fresh market data.',
    }]));
  }

  openStrategyWindow(start, now) {
    super.openStrategyWindow(start, now);
    this.strategyWindowStart = start;
    this.makerQuotes = this.emptyMakerQuotes();
    this.fairValues = null;
    this.marketMakerState = {
      status: 'SCANNING',
      reason: 'Waiting for the first valid fair value and order book.',
    };
  }

  async closePreviousWindows(currentStart, now = this.now()) {
    const expiredOrders = this.orders.filter((order) =>
      order.orderType === ORDER_TYPE
      && ACTIVE_ORDER_STATES.has(order.status)
      && Number(order.windowStart) + this.windowMs <= currentStart);
    for (const order of expiredOrders) {
      this.cancelMakerOrder(order, now, 'CANCELLED_WINDOW_END', 'Market window ended.');
    }
    return super.closePreviousWindows(currentStart, now);
  }

  handleMarketMessage(event) {
    if (Array.isArray(event)) {
      for (const item of event) this.handleMarketMessage(item);
      return;
    }
    if (!event || typeof event !== 'object') return;
    const type = event.event_type || event.eventType;
    super.handleMarketMessage(event);
    if (type === 'last_trade_price') this.processMakerTrade(event, this.now());
  }

  processStrategyEntry(now = this.now()) {
    const windowStart = this.getActiveWindowStart();
    if (windowStart == null) {
      this.marketMakerState = {
        status: 'WAITING',
        reason: 'Waiting for the current BTC 5-minute market.',
      };
      this.signal = { side: null, reason: this.marketMakerState.reason };
      return false;
    }
    if (this.strategyWindowStart !== windowStart) {
      this.strategyWindowStart = windowStart;
      this.makerQuotes = this.emptyMakerQuotes();
    }

    this.model = this.modelSnapshot(now);
    if (!this.model.ready) {
      this.cancelWindowOrders(windowStart, now, 'CANCELLED_STALE_INPUTS', 'Market inputs are stale.');
      for (const side of SIDES) {
        this.makerQuotes[side].bidStatus = 'CANCELLED_STALE_INPUTS';
        this.makerQuotes[side].askStatus = 'CANCELLED_STALE_INPUTS';
        this.makerQuotes[side].reason = 'Quotes are cancelled until fresh Binance and Polymarket data return.';
      }
      this.marketMakerState = {
        status: 'WAITING_FOR_DATA',
        reason: this.model.reason,
      };
      this.signal = { side: null, reason: this.marketMakerState.reason, modelReady: false };
      return false;
    }

    const millisecondsRemaining = Math.max(
      0,
      windowStart + config.WINDOW_MS_5M - now,
    );
    if (millisecondsRemaining <= config.MAKER_WINDOW_CUTOFF_MS) {
      this.cancelWindowOrders(windowStart, now, 'CANCELLED_WINDOW_CUTOFF', 'Quote cutoff before resolution.');
      for (const side of SIDES) {
        this.makerQuotes[side].bidStatus = 'CANCELLED_WINDOW_CUTOFF';
        this.makerQuotes[side].askStatus = 'CANCELLED_WINDOW_CUTOFF';
        this.makerQuotes[side].reason = 'All quotes are cancelled for the final 30 seconds.';
      }
      this.marketMakerState = {
        status: 'CUTOFF',
        reason: 'Quotes are cancelled for the final 30 seconds; inventory waits for official resolution.',
      };
      this.signal = { side: null, reason: this.marketMakerState.reason, modelReady: true };
      return false;
    }

    const inventory = this.totalInventoryBySide();
    const netInventory = inventory.UP - inventory.DOWN;
    const normalizedInventory = clamp(
      netInventory / config.MAKER_MAX_INVENTORY_PER_SIDE,
      -1,
      1,
    );
    const inventorySkew = normalizedInventory * config.MAKER_MAX_INVENTORY_SKEW;
    const baseFairUp = this.model.probabilityUp;
    const baseFairDown = this.model.probabilityDown;
    const fairUp = clamp(baseFairUp - inventorySkew, 0.01, 0.99);
    const fairDown = clamp(baseFairDown + inventorySkew, 0.01, 0.99);
    const halfSpread = clamp(
      config.MAKER_BASE_HALF_SPREAD
        + Number(this.model.volatility5m || 0) * config.MAKER_VOLATILITY_SPREAD_MULTIPLIER,
      config.MAKER_BASE_HALF_SPREAD,
      config.MAKER_MAX_HALF_SPREAD,
    );
    this.fairValues = {
      UP: fairUp,
      DOWN: fairDown,
      baseUP: baseFairUp,
      baseDOWN: baseFairDown,
      inventorySkew,
      netInventory,
      halfSpread,
      volatility5m: this.model.volatility5m,
    };

    let changed = false;
    for (const side of SIDES) {
      const fairValue = side === 'UP' ? fairUp : fairDown;
      changed = this.reconcileSideQuotes({
        side,
        fairValue,
        halfSpread,
        inventorySkew,
        now,
        windowStart,
      }) || changed;
    }

    const activeCount = this.orders.filter((order) =>
      order.orderType === ORDER_TYPE
      && order.windowStart === windowStart
      && ACTIVE_ORDER_STATES.has(order.status)).length;
    this.marketMakerState = {
      status: activeCount ? 'QUOTING' : 'NO_QUOTES',
      reason: activeCount
        ? 'Resting maker quotes are active; fills require observed Polymarket trade prints.'
        : 'No safe passive quotes are available at the current fair value and book.',
    };
    this.signal = {
      side: null,
      reason: this.marketMakerState.reason,
      modelReady: true,
      fairValueUP: fairUp,
      fairValueDOWN: fairDown,
      netInventory,
      halfSpread,
    };
    return changed;
  }

  reconcileSideQuotes({ side, fairValue, halfSpread, inventorySkew, now, windowStart }) {
    const sideState = this.makerQuotes[side];
    const inventoryShares = this.totalInventoryForSide(side);
    sideState.fairValue = fairValue;
    sideState.halfSpread = halfSpread;
    sideState.inventorySkew = inventorySkew;
    sideState.inventoryShares = inventoryShares;

    const quote = this.getFreshQuote(side, now);
    const bestBid = Number(quote?.bestBid);
    const bestAsk = Number(quote?.bestAsk);
    if (!quote || !Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid >= bestAsk) {
      this.cancelSideOrders(side, windowStart, now, 'CANCELLED_STALE_BOOK', 'Waiting for a fresh, two-sided order book.');
      sideState.bidPrice = null;
      sideState.askPrice = null;
      sideState.bidStatus = 'WAITING';
      sideState.askStatus = 'WAITING';
      sideState.reason = 'A fresh, non-crossed two-sided book is required.';
      return false;
    }

    const bidPrice = this.passiveBidPrice(fairValue, halfSpread, bestAsk);
    const askPrice = this.passiveAskPrice(fairValue, halfSpread, bestBid);
    sideState.bidPrice = bidPrice;
    sideState.askPrice = askPrice;
    sideState.reason = 'Quotes are kept at least one tick away from crossing the visible opposite side.';

    const changedBid = this.reconcileMakerOrder({
      side,
      action: 'BUY',
      targetPrice: bidPrice,
      now,
      windowStart,
    });
    const changedAsk = this.reconcileMakerOrder({
      side,
      action: 'SELL',
      targetPrice: askPrice,
      now,
      windowStart,
    });

    const bidOrder = this.activeMakerOrder(side, 'BUY', windowStart);
    const askOrder = this.activeMakerOrder(side, 'SELL', windowStart);
    sideState.bidOrderId = bidOrder?.id || null;
    sideState.askOrderId = askOrder?.id || null;
    sideState.bidStatus = bidOrder?.status || (bidPrice == null ? 'NO_SAFE_QUOTE' : 'NOT_POSTED');
    sideState.askStatus = askOrder?.status || (askPrice == null ? 'NO_INVENTORY' : 'NOT_POSTED');
    if (!bidOrder
      && this.totalInventoryForSide(side) >= config.MAKER_MAX_INVENTORY_PER_SIDE) {
      sideState.bidStatus = 'INVENTORY_CAP';
      sideState.reason = 'The unresolved inventory cap includes this and older windows.';
    }
    return changedBid || changedAsk;
  }

  passiveBidPrice(fairValue, halfSpread, bestAsk) {
    const tick = config.MAKER_TICK_SIZE;
    const fairBid = this.roundDownToTick(fairValue - halfSpread);
    const maximumPassiveBid = this.roundDownToTick(bestAsk - tick);
    const price = Math.min(fairBid, maximumPassiveBid);
    return price >= tick && price <= 1 - tick ? price : null;
  }

  passiveAskPrice(fairValue, halfSpread, bestBid) {
    const tick = config.MAKER_TICK_SIZE;
    const fairAsk = this.roundUpToTick(fairValue + halfSpread);
    const minimumPassiveAsk = this.roundUpToTick(bestBid + tick);
    const price = Math.max(fairAsk, minimumPassiveAsk);
    return price >= tick && price <= 1 - tick ? price : null;
  }

  roundDownToTick(price) {
    const tick = config.MAKER_TICK_SIZE;
    return Number((Math.floor((Number(price) + EPSILON) / tick) * tick).toFixed(8));
  }

  roundUpToTick(price) {
    const tick = config.MAKER_TICK_SIZE;
    return Number((Math.ceil((Number(price) - EPSILON) / tick) * tick).toFixed(8));
  }

  reconcileMakerOrder({ side, action, targetPrice, now, windowStart }) {
    const active = this.activeMakerOrder(side, action, windowStart);
    const quote = this.getFreshQuote(side, now);
    const tick = config.MAKER_TICK_SIZE;
    const passive = targetPrice != null && quote
      && (action === 'BUY'
        ? targetPrice <= Number(quote.bestAsk) - tick + EPSILON
        : targetPrice >= Number(quote.bestBid) + tick - EPSILON);

    let position = this.currentPosition(side, windowStart);
    if (action === 'BUY') {
      const capacity = config.MAKER_MAX_INVENTORY_PER_SIDE - this.totalInventoryForSide(side);
      if (active && passive && capacity >= active.remainingShares
        && Math.abs(active.limitPrice - targetPrice)
          < config.MAKER_REPRICE_TICKS * tick - EPSILON) {
        return false;
      }
      if (active) this.cancelMakerOrder(active, now, 'CANCELLED_REPLACED', 'Quote target changed.');
      if (!passive || capacity < config.MAKER_MIN_QUOTE_SHARES) return Boolean(active);

      const reservedCash = this.reservedBuyNotional(windowStart);
      const affordableShares = Math.floor(
        Math.max(0, this.cash - reservedCash) / targetPrice * 100,
      ) / 100;
      const shares = Math.min(
        config.MAKER_QUOTE_SHARES,
        capacity,
        affordableShares,
      );
      if (shares < config.MAKER_MIN_QUOTE_SHARES) return Boolean(active);
      this.createMakerOrder(side, action, targetPrice, shares, now, windowStart);
      return true;
    }

    const sellableShares = Number(position?.shares || 0);
    if (active && passive && sellableShares >= active.remainingShares - EPSILON
      && Math.abs(active.limitPrice - targetPrice)
        < config.MAKER_REPRICE_TICKS * tick - EPSILON) {
      return false;
    }
    if (active) this.cancelMakerOrder(active, now, 'CANCELLED_REPLACED', 'Sell quote target or inventory changed.');
    if (!passive || sellableShares < config.MAKER_MIN_QUOTE_SHARES) return Boolean(active);
    position = this.currentPosition(side, windowStart);
    if (!position || Number(position.shares) <= 0) return Boolean(active);
    this.createMakerOrder(side, action, targetPrice, Number(position.shares), now, windowStart);
    position.makerSellOrderId = this.activeMakerOrder(side, action, windowStart)?.id || null;
    return true;
  }

  createMakerOrder(side, action, price, shares, now, windowStart) {
    const bookSide = action === 'BUY' ? 'bids' : 'asks';
    const queueLevel = (this.books[side]?.[bookSide] || [])
      .find((level) => Math.abs(Number(level.price) - price) < EPSILON);
    const visibleQueue = Number(queueLevel?.availableSize ?? queueLevel?.size) || 0;
    const order = {
      id: `${windowStart}-btc-${side.toLowerCase()}-${action.toLowerCase()}-${++this.positionSequence}`,
      strategyId: this.strategyId,
      action,
      side,
      orderType: ORDER_TYPE,
      status: 'RESTING',
      postOnly: true,
      paperOnly: true,
      requestedShares: shares,
      filledShares: 0,
      remainingShares: shares,
      limitPrice: price,
      averagePrice: null,
      grossCost: 0,
      grossProceeds: 0,
      fees: 0,
      estimatedMakerRebate: 0,
      queueAheadShares: visibleQueue + config.MAKER_QUEUE_BUFFER_SHARES,
      initialQueueAheadShares: visibleQueue + config.MAKER_QUEUE_BUFFER_SHARES,
      fills: [],
      createdAt: now,
      windowStart,
      windowEnd: windowStart + this.windowMs,
      fillRule: 'TRADE_PRINT_AT_OR_THROUGH_PRICE_AFTER_ESTIMATED_QUEUE',
    };
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.totalOrderAttempts += 1;
    this.makerStats.ordersPlaced += 1;
    const key = action === 'BUY' ? 'bidOrderId' : 'askOrderId';
    this.makerQuotes[side][key] = order.id;
    this.log('PAPER_MAKER_ORDER_POSTED', {
      orderId: order.id,
      side,
      action,
      limitPrice: price,
      shares,
      queueAheadShares: order.queueAheadShares,
      postOnly: true,
    });
  }

  activeMakerOrder(side, action, windowStart) {
    return this.orders.find((order) =>
      order.orderType === ORDER_TYPE
      && order.side === side
      && order.action === action
      && Number(order.windowStart) === Number(windowStart)
      && ACTIVE_ORDER_STATES.has(order.status)
      && Number(order.remainingShares) > EPSILON) || null;
  }

  cancelMakerOrder(order, now, status = 'CANCELLED_REPLACED', reason = '') {
    if (!order || !ACTIVE_ORDER_STATES.has(order.status)) return false;
    order.status = status;
    order.cancelledAt = now;
    order.cancelReason = reason;
    order.remainingShares = 0;
    const key = order.action === 'BUY' ? 'bidOrderId' : 'askOrderId';
    if (this.makerQuotes[order.side]?.[key] === order.id) this.makerQuotes[order.side][key] = null;
    const position = this.positions.find((item) => item.id === order.positionId);
    if (position?.makerSellOrderId === order.id) position.makerSellOrderId = null;
    this.makerStats.ordersCancelled += 1;
    this.log('PAPER_MAKER_ORDER_CANCELLED', {
      orderId: order.id,
      side: order.side,
      action: order.action,
      limitPrice: order.limitPrice,
      reason,
    });
    return true;
  }

  cancelSideOrders(side, windowStart, now, status, reason) {
    let count = 0;
    for (const order of this.orders) {
      if (order.side !== side
        || Number(order.windowStart) !== Number(windowStart)
        || order.orderType !== ORDER_TYPE
        || !ACTIVE_ORDER_STATES.has(order.status)) continue;
      if (this.cancelMakerOrder(order, now, status, reason)) count += 1;
    }
    return count;
  }

  cancelWindowOrders(windowStart, now, status, reason) {
    let count = 0;
    for (const order of this.orders) {
      if (Number(order.windowStart) !== Number(windowStart)
        || order.orderType !== ORDER_TYPE
        || !ACTIVE_ORDER_STATES.has(order.status)) continue;
      if (this.cancelMakerOrder(order, now, status, reason)) count += 1;
    }
    return count;
  }

  totalInventoryBySide() {
    return Object.fromEntries(SIDES.map((side) => [side, this.totalInventoryForSide(side)]));
  }

  totalInventoryForSide(side) {
    return this.positions.reduce((total, position) => {
      if (position.side !== side
        || !['OPEN', 'PENDING_RESOLUTION'].includes(position.status)) return total;
      return total + Math.max(0, Number(position.shares) || 0);
    }, 0);
  }

  currentPosition(side, windowStart) {
    return this.positions.find((position) => position.status === 'OPEN'
      && position.side === side
      && Number(position.windowStart) === Number(windowStart)) || null;
  }

  reservedBuyNotional(windowStart, excludedOrderId = null) {
    return this.orders.reduce((total, order) => {
      if (order.orderType !== ORDER_TYPE
        || order.action !== 'BUY'
        || Number(order.windowStart) !== Number(windowStart)
        || order.id === excludedOrderId
        || !ACTIVE_ORDER_STATES.has(order.status)) return total;
      return total + Number(order.limitPrice) * Number(order.remainingShares);
    }, 0);
  }

  processMakerTrade(event, receivedAt = this.now()) {
    const side = this.sideForToken(event.asset_id || event.assetId);
    const tradePrice = Number(event.price);
    const tradeSize = Number(event.size);
    const takerSide = String(event.side || '').toUpperCase();
    const tradeAt = Number(event.timestamp);
    const windowStart = this.getActiveWindowStart();
    if (!side || !windowStart
      || !(tradePrice > 0 && tradePrice < 1)
      || !(tradeSize > 0)
      || !['BUY', 'SELL'].includes(takerSide)
      || !Number.isFinite(tradeAt)
      || tradeAt > receivedAt + 1000
      || receivedAt - tradeAt > config.MAKER_MAX_TRADE_AGE_MS) return false;

    const txHash = event.transaction_hash || event.transactionHash || '';
    const tradeKey = [
      txHash,
      event.asset_id || event.assetId,
      tradeAt,
      tradePrice,
      tradeSize,
      takerSide,
    ].join(':');
    if (this.seenMakerTrades.has(tradeKey)) return false;
    this.seenMakerTrades.set(tradeKey, tradeAt);
    while (this.seenMakerTrades.size > 4096) {
      this.seenMakerTrades.delete(this.seenMakerTrades.keys().next().value);
    }
    this.makerStats.lastTradeAt = tradeAt;
    let changed = false;
    for (const action of ['BUY', 'SELL']) {
      const order = this.activeMakerOrder(side, action, windowStart);
      if (!order || tradeAt < order.createdAt) continue;
      const qualifies = action === 'BUY'
        ? takerSide === 'SELL' && tradePrice <= order.limitPrice + EPSILON
        : takerSide === 'BUY' && tradePrice >= order.limitPrice - EPSILON;
      if (!qualifies) continue;

      let availableVolume = tradeSize;
      const samePrice = Math.abs(tradePrice - order.limitPrice) < EPSILON;
      if (samePrice && order.queueAheadShares > 0) {
        const aheadConsumed = Math.min(order.queueAheadShares, availableVolume);
        order.queueAheadShares -= aheadConsumed;
        availableVolume -= aheadConsumed;
      } else if (!samePrice) {
        // A trade print beyond the limit is evidence the intervening queue was consumed.
        order.queueAheadShares = 0;
      }
      if (!(availableVolume > EPSILON)) continue;
      const fill = this.applyMakerFill(order, availableVolume, receivedAt, {
        tradePrice,
        tradeAt,
      });
      changed = fill || changed;
    }

    if (changed) this.processStrategyEntry(receivedAt);
    return changed;
  }

  applyMakerFill(order, availableShares, now, trade) {
    const position = order.action === 'SELL'
      ? this.currentPosition(order.side, order.windowStart)
      : null;
    if (order.action === 'SELL' && !position) {
      this.cancelMakerOrder(order, now, 'CANCELLED_NO_INVENTORY', 'No sellable shares remain.');
      return false;
    }

    let shares = Math.min(Number(order.remainingShares), Number(availableShares));
    if (order.action === 'BUY') {
      const reservedOther = this.reservedBuyNotional(order.windowStart, order.id);
      const affordable = Math.floor(
        Math.max(0, this.cash - reservedOther) / Number(order.limitPrice) * 100,
      ) / 100;
      shares = Math.min(shares, affordable);
    } else {
      shares = Math.min(shares, Number(position.shares));
    }
    if (!(shares > EPSILON)) return false;

    const price = Number(order.limitPrice);
    const gross = shares * price;
    const rebate = makerRebateFor(this.market || {}, price, shares).estimate;
    const fill = {
      price,
      shares,
      at: now,
      tradeAt: trade.tradeAt,
      tradePrice: trade.tradePrice,
      tradeSize: Number(availableShares),
      tradeSide: order.action === 'BUY' ? 'SELL' : 'BUY',
      estimatedQueueAheadRemaining: order.queueAheadShares,
    };
    order.fills.push(fill);
    order.filledShares += shares;
    order.remainingShares = Math.max(0, Number(order.remainingShares) - shares);
    order.averagePrice = (
      (Number(order.averagePrice || 0) * (order.filledShares - shares))
      + price * shares
    ) / order.filledShares;
    order.estimatedMakerRebate += rebate;
    order.status = order.remainingShares > EPSILON ? 'PARTIALLY_FILLED' : 'FILLED';
    if (order.status === 'FILLED') order.filledAt = now;

    if (order.action === 'BUY') {
      this.applyMakerBuy(order, shares, gross, rebate, now, fill);
      this.makerStats.makerBuyShares += shares;
    } else {
      this.applyMakerSell(order, position, shares, gross, rebate, now, fill);
      this.makerStats.makerSellShares += shares;
    }
    this.makerStats.lastFillAt = now;
    this.makerStats.lastFillSide = order.side;
    return true;
  }

  applyMakerBuy(order, shares, gross, rebate, now, fill) {
    const side = order.side;
    let position = this.currentPosition(side, order.windowStart);
    const previousShares = Number(position?.shares) || 0;
    const previousCost = Number(position?.totalCost) || 0;
    if (!position) {
      const id = `${order.windowStart}-btc-${side.toLowerCase()}-maker-${++this.positionSequence}`;
      position = {
        id,
        strategyId: this.strategyId,
        marketId: this.market?.id || this.market?.conditionId || this.market?.slug || null,
        marketSlug: this.market?.slug || null,
        marketTitle: this.market?.title || this.market?.slug || 'BTC 5-minute Up/Down',
        windowStart: order.windowStart,
        windowEnd: order.windowEnd,
        asset: 'BTC',
        side,
        status: 'OPEN',
        shares: 0,
        initialShares: 0,
        entryPrice: null,
        totalCost: 0,
        initialTotalCost: 0,
        fees: 0,
        initialFees: 0,
        entryFees: 0,
        openedAt: now,
        filledAt: now,
        markPrice: null,
        unrealizedPnl: null,
        estimatedMakerRebate: 0,
        makerRebateEstimate: 0,
        entryFills: [],
        entrySignals: [],
        exitProceeds: 0,
        exitFees: 0,
        realizedCostBasis: 0,
        realizedPnl: null,
        proceeds: 0,
        feeContext: feeContext(this.market || {}),
        paperOnly: true,
      };
      this.positions.unshift(position);
    }

    position.shares = previousShares + shares;
    position.initialShares = (Number(position.initialShares) || 0) + shares;
    position.totalCost = previousCost + gross;
    position.initialTotalCost = (Number(position.initialTotalCost) || 0) + gross;
    position.entryPrice = position.initialTotalCost / position.initialShares;
    position.filledAt = now;
    position.estimatedMakerRebate += rebate;
    position.makerRebateEstimate += rebate;
    position.entryFills.push({ ...fill, orderId: order.id, maker: true });
    position.proceeds = Number(position.exitProceeds) || 0;
    order.positionId = position.id;
    this.cash -= gross;

    this.log('PAPER_MAKER_BUY_FILLED', {
      positionId: position.id,
      orderId: order.id,
      side,
      shares,
      price: order.limitPrice,
      accumulatedShares: position.shares,
      estimatedMakerRebate: rebate,
      fee: 0,
      tradePrice: fill.tradePrice,
    });
  }

  applyMakerSell(order, position, shares, gross, rebate, now, fill) {
    const previousShares = Number(position.shares);
    const previousCost = Number(position.totalCost);
    const costBasis = previousShares > 0 ? previousCost * shares / previousShares : 0;
    position.shares = Math.max(0, previousShares - shares);
    position.totalCost = Math.max(0, previousCost - costBasis);
    position.realizedCostBasis = (Number(position.realizedCostBasis) || 0) + costBasis;
    position.exitProceeds = (Number(position.exitProceeds) || 0) + gross;
    position.proceeds = position.exitProceeds;
    position.exitFees = 0;
    position.estimatedMakerRebate += rebate;
    position.makerRebateEstimate += rebate;
    position.exitFills = [...(position.exitFills || []), { ...fill, orderId: order.id, maker: true }];
    position.exitPrice = order.averagePrice;
    position.exitBid = order.averagePrice;
    position.makerSellOrderId = order.status === 'FILLED' ? null : order.id;
    order.positionId = position.id;
    order.grossProceeds += gross;
    this.cash += gross;

    const allBuyCost = Number(position.initialTotalCost) || 0;
    const remainingCost = Number(position.totalCost) || 0;
    position.realizedPnl = position.exitProceeds
      - Math.max(0, allBuyCost - remainingCost)
      + position.estimatedMakerRebate;
    if (position.shares <= EPSILON) {
      position.shares = 0;
      position.totalCost = 0;
      position.status = 'SETTLED_EXIT';
      position.closedAt = now;
      position.settledAt = now;
      position.settlementBasis = 'PAPER_MAKER_SELL';
      position.exitReason = 'MAKER_SELL';
      position.exitType = ORDER_TYPE;
      position.realizedPnl = position.exitProceeds - allBuyCost + position.estimatedMakerRebate;
      position.outcome = position.realizedPnl > 0 ? 'WIN'
        : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN';
      this.recordStrategyOutcome(position, position.outcome, now, 'MAKER_SELL');
    }

    this.log('PAPER_MAKER_SELL_FILLED', {
      positionId: position.id,
      orderId: order.id,
      side: position.side,
      shares,
      price: order.limitPrice,
      remainingShares: position.shares,
      estimatedMakerRebate: rebate,
      fee: 0,
      realizedPnl: position.realizedPnl,
      tradePrice: fill.tradePrice,
    });
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const model = this.model || this.modelSnapshot(now);
    const windowStart = this.getActiveWindowStart();
    const windowEnd = windowStart == null ? null : windowStart + this.windowMs;
    const openWindowPositions = this.positions.filter((position) =>
      position.status === 'OPEN' && Number(position.windowStart) === Number(windowStart));
    const positionsBySide = Object.fromEntries(SIDES.map((side) => [
      side,
      openWindowPositions.find((position) => position.side === side) || null,
    ]));
    const marketMakerQuotes = Object.fromEntries(SIDES.map((side) => {
      const current = this.makerQuotes[side] || {};
      const bidOrder = current.bidOrderId
        ? this.orders.find((order) => order.id === current.bidOrderId)
        : null;
      const askOrder = current.askOrderId
        ? this.orders.find((order) => order.id === current.askOrderId)
        : null;
      return [side, {
        ...current,
        bid: this.orderView(bidOrder),
        ask: this.orderView(askOrder),
        inventoryShares: this.totalInventoryForSide(side),
        maxInventoryShares: config.MAKER_MAX_INVENTORY_PER_SIDE,
      }];
    }));

    return {
      ...state,
      now,
      strategy: {
        id: this.strategyId,
        name: this.strategyName,
        version: 'btc-5m-inventory-aware-market-maker-v1',
        execution: 'PAPER ONLY',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        model: 'Binance probability model using the last two completed 5-minute candles.',
        quoteMode: 'Inventory-aware passive limit quotes on both outcomes.',
        orderType: ORDER_TYPE,
        postOnly: true,
        quoteSizeShares: config.MAKER_QUOTE_SHARES,
        maxInventoryPerSide: config.MAKER_MAX_INVENTORY_PER_SIDE,
        maxTotalInventoryShares: config.MAKER_MAX_INVENTORY_PER_SIDE * 2,
        baseHalfSpread: config.MAKER_BASE_HALF_SPREAD,
        maxHalfSpread: config.MAKER_MAX_HALF_SPREAD,
        volatilitySpreadMultiplier: config.MAKER_VOLATILITY_SPREAD_MULTIPLIER,
        maxInventorySkew: config.MAKER_MAX_INVENTORY_SKEW,
        tickSize: config.MAKER_TICK_SIZE,
        windowCutoffMs: config.MAKER_WINDOW_CUTOFF_MS,
        fairValues: this.fairValues,
        entryPriceCeiling: null,
        accumulatesInventory: true,
        usesTakerOrders: false,
        inventoryIncludesUnresolvedPositions: true,
        fillRule: 'A paper fill requires a fresh last_trade_price print from the opposite taker side at or through the resting limit after the estimated queue is consumed. Price touches alone do not fill.',
        makerRebateRateEstimate: config.CRYPTO_MAKER_REBATE_RATE,
        estimatedMakerRebateOnly: true,
        exits: {
          takeProfit: null,
          stopLoss: null,
          windowEnd: 'Cancel resting quotes 30 seconds before expiry; remaining inventory waits for official resolution.',
        },
        trigger: 'Quote both outcomes around the Binance fair value; skew prices away from accumulated inventory and widen the spread with volatility.',
      },
      account: {
        ...state.account,
        tradeCount: this.positions.filter((position) => position.status !== 'CANCELLED_UNFILLED').length,
        openPositions: this.positions.filter((position) => position.status === 'OPEN').length,
        pendingResolutionPositions: this.positions.filter((position) =>
          position.status === 'PENDING_RESOLUTION').length,
      },
      statusReason: this.marketMakerState.reason || state.statusReason,
      model,
      signal: this.signal,
      marketMakerState: this.marketMakerState,
      fairValues: this.fairValues,
      makerQuotes: marketMakerQuotes,
      makerStats: { ...this.makerStats },
      positionsBySide,
      openWindowPositions,
      inventory: {
        ...state.inventory,
        UP: {
          ...state.inventory?.UP,
          shares: this.totalInventoryForSide('UP'),
          maxShares: config.MAKER_MAX_INVENTORY_PER_SIDE,
        },
        DOWN: {
          ...state.inventory?.DOWN,
          shares: this.totalInventoryForSide('DOWN'),
          maxShares: config.MAKER_MAX_INVENTORY_PER_SIDE,
        },
        netShares: this.totalInventoryForSide('UP') - this.totalInventoryForSide('DOWN'),
      },
      window: windowStart == null ? null : {
        ...state.window,
        start: windowStart,
        end: windowEnd,
        secondsRemaining: Math.max(0, (windowEnd - now) / 1000),
      },
      trades: state.positions || [],
      persistence: { status: 'MEMORY ONLY', detail: 'Railway restarts reset paper history.' },
    };
  }

  orderView(order) {
    if (!order) return null;
    return {
      id: order.id,
      action: order.action,
      side: order.side,
      status: order.status,
      price: order.limitPrice,
      requestedShares: order.requestedShares,
      filledShares: order.filledShares,
      remainingShares: order.remainingShares,
      queueAheadShares: order.queueAheadShares,
      createdAt: order.createdAt,
      postOnly: order.postOnly,
    };
  }
}

MarketMakerBot._test = {
  ...MispricingBot._test,
  clamp,
};

module.exports = MarketMakerBot;
