'use strict';

const MispricingBot = require('./mispricing-bot');
const WickBot = require('./wick-bot');
const config = require('./config');
const { makerRebateFor, feeContext } = WickBot._test;

const EPSILON = 1e-8;
const ACTIVE_ORDER_STATES = new Set(['RESTING', 'PARTIALLY_FILLED']);
const ORDER_TYPE = 'PAPER_RESTING_LIMIT_BUY';
const SIDES = ['UP', 'DOWN'];
const TAKE_PROFIT_BID = 0.99;
const STOP_LOSS_BID = 0.01;
const TAKE_PROFIT_PAYOUT = 1;
const STOP_LOSS_PAYOUT = 0;
const COMPLEMENTARY_TAKE_PROFIT_SUM = 1.01;

function rungTakeProfitPrice(entryPrice) {
  return Number((COMPLEMENTARY_TAKE_PROFIT_SUM - Number(entryPrice)).toFixed(2));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

class MarketMakerBot extends MispricingBot {
  constructor(options = {}) {
    super({ ...options, useBinanceFeed: false });
    this.strategyId = 'btc-5m-fixed-price-ladder';
    this.strategyName = 'BTC 5-minute fixed-price resting buy ladder';
    this.rules = {
      sharesPerOrder: config.MAKER_LADDER_SHARES,
      rungs: config.MAKER_LADDER_RUNGS,
      fillRule: 'A fresh best ask or opposing sell trade print at or below a rung counts the full order as filled.',
      takeProfitRule: 'Each rung sells at its opposite-side equivalent price ($1.01 minus the buy rung).',
      exitPolicy: 'Per-rung limit take-profit; best bid at $0.01 exits at $0/share; otherwise hold for resolution.',
    };
    this.strategyWindowStart = null;
    this.makerQuotes = this.emptyMakerQuotes();
    this.fairValues = null;
    this.marketMakerState = {
      status: 'WAITING',
      reason: 'Waiting for Polymarket CLOB books.',
    };
    this.makerStats = {
      ordersPlaced: 0,
      ordersCancelled: 0,
      makerBuyShares: 0,
      makerSellShares: 0,
      mergedPairs: 0,
      mergedCollateral: 0,
      lastTradeAt: null,
      lastFillAt: null,
      lastFillSide: null,
    };
    this.mergeHistory = [];
    this.mergeSequence = 0;
    this.lastOrderSlot = 0;
    this.lastOrderAt = null;
    this.lastOrderResult = 'Waiting for the current five-minute window.';
    this.rungOutcomes = new Map();
    this.rungRearmQueue = new Map();
    this.seenMakerTrades = new Map();
  }

  emptyMakerQuotes() {
    return Object.fromEntries(SIDES.map((side) => [side, {
      midpoint: null,
      bidPrice: null,
      entryLimitPrice: null,
      askPrice: null,
      bidOrderId: null,
      askOrderId: null,
      bidStatus: 'WAITING',
      askStatus: 'NO_POSITION',
      buyOrderIds: [],
      inventoryShares: 0,
      reason: 'Waiting for a fresh Polymarket order book.',
    }]));
  }

  openStrategyWindow(start, now) {
    super.openStrategyWindow(start, now);
    this.strategyWindowStart = start;
    this.makerQuotes = this.emptyMakerQuotes();
    this.fairValues = null;
    this.lastOrderSlot = 0;
    this.lastOrderAt = null;
    this.lastOrderResult = 'Placing the fixed-price UP and DOWN ladders.';
    this.rungOutcomes.clear();
    this.rungRearmQueue.clear();
    this.entryTriggeredThisWindow = false;
    this.sideEntryCountsThisWindow = { UP: 0, DOWN: 0 };
    this.signalConsumed = { UP: false, DOWN: false };
    this.sideSignals = Object.fromEntries(SIDES.map((side) => [side, {
      status: 'WAITING',
      reason: 'Waiting for the next one-second CLOB price check.',
    }]));
    this.marketMakerState = {
      status: 'POSTING_LADDER',
      reason: 'Waiting for fresh Polymarket books to post the fixed-price ladder.',
    };
    this.signal = { side: null, reason: this.marketMakerState.reason };
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
    if (type === 'last_trade_price') {
      this.processMakerTrade(event, this.now());
    } else if (['book', 'price_change', 'best_bid_ask'].includes(type)) {
      const side = this.sideForToken(event.asset_id || event.assetId);
      if (side) this.processBookPriceCross(side, this.now());
    }
  }

  processStrategyEntry(now = this.now()) {
    const exited = this.processPositionThresholdExits(now);
    return this.processFixedPriceLadder(now) || exited;
  }

  processFixedPriceLadder(now = this.now()) {
    const windowStart = this.getActiveWindowStart();
    if (windowStart == null) {
      this.marketMakerState = {
        status: 'WAITING_FOR_MARKET',
        reason: 'Waiting for the current BTC 5-minute market.',
      };
      this.signal = { side: null, reason: this.marketMakerState.reason };
      return false;
    }
    if (this.strategyWindowStart !== windowStart) this.openStrategyWindow(windowStart, now);

    const windowEnd = windowStart + this.windowMs;
    if (now >= windowEnd) {
      const cancelled = this.cancelWindowOrders(
        windowStart,
        now,
        'CANCELLED_WINDOW_END',
        'The market window ended.',
      );
      this.marketMakerState = {
        status: 'WINDOW_CLOSED',
        reason: 'Window ended; filled shares wait for official resolution.',
      };
      this.signal = { side: null, reason: this.marketMakerState.reason };
      return cancelled > 0;
    }

    let changed = this.expireEntryOrders(now, windowStart);
    const elapsedMs = Math.max(0, now - windowStart);
    for (const side of SIDES) {
      for (const [index, rung] of config.MAKER_LADDER_RUNGS.entries()) {
        const key = `${side}:${index}`;
        const entryOrders = this.orders.filter((order) =>
          Number(order.windowStart) === Number(windowStart)
          && order.side === side
          && order.action === 'BUY'
          && order.purpose === 'ENTRY'
          && Number(order.rungIndex) === index + 1);
        const activeEntry = entryOrders.some((order) => ACTIVE_ORDER_STATES.has(order.status));
        const rearm = this.rungRearmQueue.get(key);
        if (activeEntry) continue;
        if (!rearm && (entryOrders.length > 0 || this.rungOutcomes.has(key))) continue;

        const expiresAt = windowStart + rung.cancelAfterSeconds * 1000;
        if (now >= expiresAt) {
          if (rearm) {
            this.rungRearmQueue.delete(key);
            this.rungOutcomes.set(key, {
              status: 'TAKE_PROFIT_NO_REARM',
              reason: 'The rung take-profit completed after its original re-arm deadline.',
            });
          } else if (entryOrders.length === 0 && !this.rungOutcomes.has(key)) {
            this.rungOutcomes.set(key, {
              status: 'MISSED_DEADLINE',
              reason: 'The cancellation deadline passed before the order could be posted.',
            });
          }
          continue;
        }

        const quote = this.getFreshQuote(side, now);
        const bestAsk = Number(quote?.bestAsk);
        if (!quote || !Number.isFinite(bestAsk)) continue;

        if (bestAsk <= rung.price + EPSILON) {
          if (rearm) {
            this.rungOutcomes.set(key, {
              status: 'REARM_WAITING_PASSIVE',
              reason: 'Waiting for the rung price to become passive before its original deadline.',
            });
          } else {
            this.rungOutcomes.set(key, {
              status: 'REJECTED_POST_ONLY',
              reason: 'The limit would have matched immediately, so it was not treated as a resting order.',
            });
          }
          continue;
        }

        const reservedCash = this.reservedBuyNotional(windowStart);
        const requiredCash = rung.price * config.MAKER_LADDER_SHARES;
        if (this.cash - reservedCash + EPSILON < requiredCash) {
          if (rearm) {
            this.rungOutcomes.set(key, {
              status: 'REARM_WAITING_CASH',
              reason: 'Waiting for enough unreserved paper cash before the original deadline.',
            });
          } else {
            this.rungOutcomes.set(key, {
              status: 'SKIPPED_INSUFFICIENT_CASH',
              reason: `The full ${config.MAKER_LADDER_SHARES}-share order cannot be reserved from available paper cash.`,
            });
          }
          continue;
        }

        const latestCycle = entryOrders.reduce((cycle, order) =>
          Math.max(cycle, Number(order.rungCycle) || 0), 0);
        const rungCycle = rearm?.cycle ?? Math.max(1, latestCycle + 1);
        this.createMakerOrder(
          side,
          'BUY',
          rung.price,
          config.MAKER_LADDER_SHARES,
          now,
          windowStart,
          {
            purpose: 'ENTRY',
            rungIndex: index + 1,
            rungCycle,
            rungPrice: rung.price,
            takeProfitPrice: rungTakeProfitPrice(rung.price),
            cancelAtSeconds: rung.cancelAfterSeconds,
            expiresAt,
            fillRule: 'OPPOSING_TRADE_PRINT_AT_OR_THROUGH_LIMIT_AFTER_ESTIMATED_QUEUE',
          },
        );
        if (rearm) this.rungRearmQueue.delete(key);
        this.rungOutcomes.delete(key);
        changed = true;
      }
    }

    changed = this.ensureRungTakeProfitOrders(now, windowStart) || changed;
    const currentOrders = this.orders.filter((order) =>
      order.orderType === ORDER_TYPE
      && Number(order.windowStart) === Number(windowStart));
    const activeBuyCount = currentOrders.filter((order) =>
      order.action === 'BUY'
      && order.purpose === 'ENTRY'
      && ACTIVE_ORDER_STATES.has(order.status)).length;
    const activeTakeProfitCount = currentOrders.filter((order) =>
      order.action === 'SELL'
      && order.purpose === 'TAKE_PROFIT'
      && ACTIVE_ORDER_STATES.has(order.status)).length;
    const activeCount = activeBuyCount + activeTakeProfitCount;
    const remainingRungs = SIDES.reduce((total, currentSide) =>
      total + config.MAKER_LADDER_RUNGS.reduce((sideTotal, rung, index) => {
        const key = `${currentSide}:${index}`;
        const entryOrders = currentOrders.filter((order) =>
          order.side === currentSide
          && order.action === 'BUY'
          && order.purpose === 'ENTRY'
          && Number(order.rungIndex) === index + 1);
        const activeEntry = entryOrders.some((order) => ACTIVE_ORDER_STATES.has(order.status));
        const openPosition = this.positions.some((position) =>
          position.status === 'OPEN'
          && position.side === currentSide
          && Number(position.windowStart) === Number(windowStart)
          && Number(position.rungIndex) === index + 1);
        const canStillPost = now < windowStart + rung.cancelAfterSeconds * 1000
          && (this.rungRearmQueue.has(key)
            || (entryOrders.length === 0 && !this.rungOutcomes.has(key)));
        return sideTotal + (activeEntry || openPosition || canStillPost ? 1 : 0);
      }, 0), 0);
    const activeFills = currentOrders
      .filter((order) => order.action === 'BUY' && order.purpose === 'ENTRY')
      .reduce((total, order) => total + Number(order.filledShares || 0), 0);
    this.marketMakerState = {
      status: activeCount ? 'RESTING_ORDERS' : remainingRungs > 0 ? 'WAITING_FOR_BOOK' : 'LADDER_COMPLETE',
      reason: activeCount
        ? `${activeBuyCount} resting buy orders and ${activeTakeProfitCount} take-profit sells are active; ${activeFills.toFixed(0)} entry shares bought so far.`
        : remainingRungs > 0
          ? 'Waiting for fresh UP and DOWN order books to post eligible rungs.'
          : 'No ladder orders remain active; any remaining shares wait for official resolution.',
    };
    this.lastOrderAt = changed ? now : this.lastOrderAt;
    this.lastOrderResult = this.marketMakerState.reason;
    this.signal = {
      side: null,
      reason: this.marketMakerState.reason,
      reference: 'FIXED_CLOB_PRICE_LADDER',
      windowElapsedSeconds: elapsedMs / 1000,
    };
    return changed;
  }

  processClobMidpointStrategy(now = this.now()) {
    const windowStart = this.getActiveWindowStart();
    if (windowStart == null) {
      this.marketMakerState = { status: 'WAITING_FOR_MARKET', reason: 'Waiting for the current BTC 5-minute market.' };
      this.signal = { side: null, reason: this.marketMakerState.reason };
      return false;
    }
    if (this.strategyWindowStart !== windowStart) this.openStrategyWindow(windowStart, now);

    if (now >= windowStart + this.windowMs) {
      const cancelled = this.cancelWindowOrders(
        windowStart,
        now,
        'CANCELLED_WINDOW_END',
        'The market window ended.',
      );
      this.marketMakerState = {
        status: 'WINDOW_CLOSED',
        reason: 'Window ended; remaining shares wait for official resolution.',
      };
      this.signal = { side: null, reason: this.marketMakerState.reason };
      return cancelled > 0;
    }

    let changed = this.expireEntryOrders(now, windowStart);
    changed = this.mergeMatchedInventory(windowStart, now) || changed;
    changed = this.ensureTakeProfitOrders(now, windowStart) || changed;

    const slot = Math.floor((now - windowStart) / config.CLOB_ENTRY_INTERVAL_MS);
    if (slot > this.lastOrderSlot) {
      this.lastOrderSlot = slot;
      this.lastOrderAt = now;
      const placedSides = [];
      const results = [];
      for (const side of SIDES) {
        if (this.placeEntryOrder(side, now, windowStart)) {
          placedSides.push(side);
          changed = true;
        } else {
          results.push(`${side}: ${this.sideSignals[side]?.reason || 'no order placed'}`);
        }
      }
      this.lastOrderResult = placedSides.length
        ? `Placed ${config.CLOB_ENTRY_SHARES}-share orders for ${placedSides.join(' and ')}.`
        : results.join(' ');
    }

    changed = this.ensureTakeProfitOrders(now, windowStart) || changed;
    const activeOrders = this.orders.filter((order) =>
      order.orderType === ORDER_TYPE
      && Number(order.windowStart) === Number(windowStart)
      && ACTIVE_ORDER_STATES.has(order.status));
    const activeBuys = activeOrders.filter((order) => order.action === 'BUY').length;
    const activeSells = activeOrders.filter((order) => order.action === 'SELL').length;
    this.marketMakerState = {
      status: activeBuys || activeSells ? 'MAKER_ORDERS_ACTIVE' : 'WAITING_FOR_BOOK',
      reason: activeBuys || activeSells
        ? `${activeBuys} buy orders and ${activeSells} take-profit orders are active.`
        : 'Waiting for fresh UP and DOWN CLOB midpoints.',
    };
    this.signal = {
      side: null,
      reason: this.lastOrderResult,
      reference: 'POLYMARKET_CLOB_MIDPOINT',
      nextOrderAt: windowStart + (this.lastOrderSlot + 1) * config.CLOB_ENTRY_INTERVAL_MS,
    };
    this.updateSideOrderState(windowStart);
    return changed;
  }

  mergeMatchedInventory(windowStart, now = this.now()) {
    const openInWindow = this.positions.filter((position) =>
      position.status === 'OPEN'
      && Number(position.windowStart) === Number(windowStart)
      && Number(position.shares) > EPSILON);
    const upPositions = openInWindow.filter((position) => position.side === 'UP')
      .sort((left, right) => Number(left.openedAt) - Number(right.openedAt));
    const downPositions = openInWindow.filter((position) => position.side === 'DOWN')
      .sort((left, right) => Number(left.openedAt) - Number(right.openedAt));
    if (!upPositions.length || !downPositions.length) return false;
    const availablePairs = Math.floor(
      (Math.min(
        upPositions.reduce((sum, position) => sum + Number(position.shares || 0), 0),
        downPositions.reduce((sum, position) => sum + Number(position.shares || 0), 0),
      ) + EPSILON) * 1_000_000,
    ) / 1_000_000;
    if (!(availablePairs > EPSILON)) return false;

    const upSellOrders = this.activeMakerOrders('UP', 'SELL', windowStart);
    const downSellOrders = this.activeMakerOrders('DOWN', 'SELL', windowStart);
    for (const order of [...upSellOrders, ...downSellOrders]) {
      this.cancelMakerOrder(
        order,
        now,
        'CANCELLED_MERGED',
        'Cancelling take-profit orders before merging matching UP and DOWN shares.',
      );
    }

    let upIndex = 0;
    let downIndex = 0;
    let changed = false;
    while (upIndex < upPositions.length && downIndex < downPositions.length) {
      const up = upPositions[upIndex];
      const down = downPositions[downIndex];
      const shares = Math.floor(
        (Math.min(Number(up.shares), Number(down.shares)) + EPSILON) * 1_000_000,
      ) / 1_000_000;
      if (!(shares > EPSILON)) break;

      const upSharesBefore = Number(up.shares);
      const downSharesBefore = Number(down.shares);
      const upCostBasis = Number(up.totalCost || 0) * shares / upSharesBefore;
      const downCostBasis = Number(down.totalCost || 0) * shares / downSharesBefore;
      const collateralReturned = shares;
      const mergeId = `${windowStart}-btc-merge-${++this.mergeSequence}`;

      for (const [position, costBasis] of [[up, upCostBasis], [down, downCostBasis]]) {
        const remainingEntryRebate = Math.max(
          0,
          (Number(position.entryEstimatedMakerRebate) || 0)
            - (Number(position.realizedEntryMakerRebate) || 0),
        );
        position.realizedEntryMakerRebate = (Number(position.realizedEntryMakerRebate) || 0)
          + remainingEntryRebate * shares / Number(position.shares);
        position.shares = Math.max(0, Number(position.shares) - shares);
        position.totalCost = Math.max(0, Number(position.totalCost || 0) - costBasis);
        position.realizedCostBasis = (Number(position.realizedCostBasis) || 0) + costBasis;
        position.mergeCostBasis = (Number(position.mergeCostBasis) || 0) + costBasis;
        position.mergeProceeds = (Number(position.mergeProceeds) || 0) + collateralReturned / 2;
        position.proceeds = (Number(position.exitProceeds) || 0) + Number(position.mergeProceeds);
        position.lastMergeId = mergeId;
        position.lastMergeAt = now;
        position.realizedPnl = this.calculateRealizedPnl(position);
      }

      this.cash += collateralReturned;
      this.makerStats.mergedPairs += shares;
      this.makerStats.mergedCollateral += collateralReturned;
      const realizedPnl = collateralReturned - upCostBasis - downCostBasis;
      const merge = {
        id: mergeId,
        at: now,
        windowStart,
        marketId: up.marketId || down.marketId || null,
        sharesPerSide: shares,
        collateralReturned,
        upCostBasis,
        downCostBasis,
        totalCostBasis: upCostBasis + downCostBasis,
        realizedPnl,
        upPositionId: up.id,
        downPositionId: down.id,
        paperOnly: true,
      };
      this.mergeHistory.unshift(merge);
      if (this.mergeHistory.length > 500) this.mergeHistory.length = 500;
      this.log('PAPER_COMPLETE_SET_MERGED', {
        ...merge,
        message: `Merged ${shares.toFixed(2)} UP + ${shares.toFixed(2)} DOWN for ${collateralReturned.toFixed(2)} paper collateral; gross P&L before rebates ${realizedPnl.toFixed(2)}; remaining UP ${Math.max(0, Number(up.shares)).toFixed(2)}, DOWN ${Math.max(0, Number(down.shares)).toFixed(2)}.`,
      });

      for (const position of [up, down]) {
        if (Number(position.shares) > EPSILON) continue;
        position.shares = 0;
        position.totalCost = 0;
        position.status = 'SETTLED_EXIT';
        position.closedAt = now;
        position.settledAt = now;
        position.settlementBasis = 'PAPER_COMPLETE_SET_MERGE';
        position.exitReason = 'COMPLETE_SET_MERGE';
        position.exitType = 'PAPER_MERGE';
        position.outcome = position.realizedPnl > 0 ? 'WIN'
          : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN';
        this.recordStrategyOutcome(position, position.outcome, now, 'PAPER_COMPLETE_SET_MERGE');
      }

      changed = true;
      if (Number(up.shares) <= EPSILON) upIndex += 1;
      if (Number(down.shares) <= EPSILON) downIndex += 1;
    }
    return changed;
  }

  calculateRealizedPnl(position) {
    const totalBuyCost = Number(position.initialTotalCost) || 0;
    const remainingCost = Math.max(0, Number(position.totalCost) || 0);
    const realizedCost = Math.max(0, totalBuyCost - remainingCost);
    const realizedCostFraction = totalBuyCost > 0
      ? Math.min(1, realizedCost / totalBuyCost)
      : 0;
    const realizedProceeds = (Number(position.exitProceeds) || 0)
      + (Number(position.mergeProceeds) || 0);
    return realizedProceeds
      - realizedCost
      - (Number(position.initialFees) || 0) * realizedCostFraction
      + (Number(position.realizedEntryMakerRebate) || 0)
      + (Number(position.realizedSellMakerRebate) || 0);
  }

  expireEntryOrders(now, windowStart) {
    let changed = false;
    for (const order of this.orders) {
      if (order.action !== 'BUY'
        || order.purpose !== 'ENTRY'
        || Number(order.windowStart) !== Number(windowStart)
        || !ACTIVE_ORDER_STATES.has(order.status)
        || !Number.isFinite(Number(order.expiresAt))
        || Number(order.expiresAt) > now) continue;
      changed = this.cancelMakerOrder(
        order,
        now,
        'CANCELLED_TIMEOUT',
        `Unfilled remainder cancelled at the ${order.cancelAtSeconds}-second window deadline.`,
      ) || changed;
      if (this.sideSignals[order.side]?.orderId === order.id) {
        this.sideSignals[order.side] = {
          ...this.sideSignals[order.side],
          status: order.filledShares > 0 ? 'PARTIAL_TIMEOUT' : 'CANCELLED_TIMEOUT',
          reason: order.filledShares > 0
            ? `Filled ${Number(order.filledShares).toFixed(2)} shares; cancelled the remaining quantity at the ${order.cancelAtSeconds}-second deadline.`
            : `Unfilled order cancelled at the ${order.cancelAtSeconds}-second deadline.`,
        };
      }
    }
    return changed;
  }

  processEntryBookTouches(now = this.now()) {
    const windowStart = this.getActiveWindowStart();
    if (windowStart == null || now >= windowStart + this.windowMs) return false;

    let changed = this.expireEntryOrders(now, windowStart);
    for (const side of SIDES) {
      const quote = this.getFreshQuote(side, now);
      const bestAsk = Number(quote?.bestAsk);
      if (!quote || !Number.isFinite(bestAsk)) continue;

      for (const order of this.activeMakerOrders(side, 'BUY', windowStart)) {
        if (order.purpose !== 'ENTRY'
          || now < Number(order.createdAt)
          || Number(quote.updatedAt) < Number(order.createdAt)
          || Number(order.expiresAt) <= now
          || bestAsk > Number(order.limitPrice) + EPSILON) continue;

        changed = this.applyMakerFill(order, Number(order.remainingShares), now, {
          confirmation: 'BEST_ASK_TOUCH',
          tradePrice: bestAsk,
          tradeAt: Number(quote.sourceTimestamp) || now,
          tradeSize: Number(quote.askSize) || 0,
        }) || changed;
      }
    }

    if (changed) this.processStrategyEntry(now);
    return changed;
  }

  placeEntryOrder(side, now, windowStart) {
    const state = this.makerQuotes[side];
    const quote = this.getFreshQuote(side, now);
    if (!quote || quote.bestBid == null || quote.bestAsk == null) {
      this.sideSignals[side] = {
        status: 'WAITING_FOR_BOOK',
        reason: `No fresh two-sided ${side} order book; this side skipped its check.`,
      };
      state.midpoint = null;
      state.entryLimitPrice = null;
      state.bidPrice = null;
      return false;
    }
    const bestBid = Number(quote?.bestBid);
    const bestAsk = Number(quote?.bestAsk);
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid >= bestAsk) {
      this.sideSignals[side] = {
        status: 'WAITING_FOR_BOOK',
        reason: `No fresh two-sided ${side} order book; this side skipped its check.`,
      };
      state.midpoint = null;
      state.entryLimitPrice = null;
      return false;
    }

    const midpoint = (bestBid + bestAsk) / 2;
    const limitPrice = this.roundDownToTick(midpoint - config.CLOB_ENTRY_MIDPOINT_OFFSET);
    state.midpoint = midpoint;
    state.entryLimitPrice = limitPrice;
    state.bidPrice = limitPrice;
    state.bidStatus = 'READY';
    state.reason = `${side} limit = midpoint ${midpoint.toFixed(3)} minus $${config.CLOB_ENTRY_MIDPOINT_OFFSET.toFixed(2)}.`;
    if (!(limitPrice >= config.MAKER_TICK_SIZE && limitPrice < bestAsk - EPSILON)) {
      this.sideSignals[side] = {
        status: 'INVALID_LIMIT',
        midpoint,
        limitPrice,
        reason: `Calculated ${side} buy price is outside the valid passive range.`,
      };
      state.bidStatus = 'SKIPPED';
      return false;
    }

    const reservedCash = this.reservedBuyNotional(windowStart);
    const requiredCash = limitPrice * config.CLOB_ENTRY_SHARES;
    if (this.cash - reservedCash + EPSILON < requiredCash) {
      this.sideSignals[side] = {
        status: 'INSUFFICIENT_CASH',
        midpoint,
        limitPrice,
        reason: `Not enough unreserved paper cash for ${config.CLOB_ENTRY_SHARES} shares.`,
      };
      state.bidStatus = 'INSUFFICIENT_CASH';
      return false;
    }

    const order = this.createMakerOrder(
      side,
      'BUY',
      limitPrice,
      config.CLOB_ENTRY_SHARES,
      now,
      windowStart,
      {
        purpose: 'ENTRY',
        expiresAt: now + config.CLOB_ENTRY_TTL_MS,
        referenceMidpoint: midpoint,
      },
    );
    this.sideEntryCountsThisWindow[side] += 1;
    this.sideSignals[side] = {
      status: 'ORDER_RESTING',
      midpoint,
      limitPrice,
      orderId: order.id,
      expiresAt: order.expiresAt,
      reason: `${config.CLOB_ENTRY_SHARES}-share buy resting at ${limitPrice.toFixed(2)}; cancel at ${new Date(order.expiresAt).toLocaleTimeString()}.`,
    };
    state.bidStatus = 'RESTING';
    return true;
  }

  ensureTakeProfitOrders(now, windowStart) {
    let changed = false;
    for (const side of SIDES) {
      const position = this.currentPosition(side, windowStart);
      const activeSells = this.activeMakerOrders(side, 'SELL', windowStart);
      if (!position || !(Number(position.shares) > EPSILON)) {
        for (const order of activeSells) {
          changed = this.cancelMakerOrder(order, now, 'CANCELLED_NO_INVENTORY', 'No shares remain to sell.') || changed;
        }
        continue;
      }

      const active = activeSells.find((order) => order.purpose === 'TAKE_PROFIT');
      if (active
        && Math.abs(Number(active.limitPrice) - config.CLOB_TAKE_PROFIT_PRICE) < EPSILON
        && Math.abs(Number(active.remainingShares) - Number(position.shares)) < EPSILON) {
        position.makerSellOrderId = active.id;
        position.takeProfitOrder = active;
        continue;
      }

      for (const order of activeSells) {
        changed = this.cancelMakerOrder(order, now, 'CANCELLED_RESIZED', 'Replacing the take-profit order to cover current shares.') || changed;
      }
      const order = this.createMakerOrder(
        side,
        'SELL',
        config.CLOB_TAKE_PROFIT_PRICE,
        Number(position.shares),
        now,
        windowStart,
        { purpose: 'TAKE_PROFIT', positionId: position.id },
      );
      position.makerSellOrderId = order.id;
      position.takeProfitOrder = order;
      position.takeProfitOrderId = order.id;
      position.takeProfitPrice = config.CLOB_TAKE_PROFIT_PRICE;
      changed = true;
    }
    return changed;
  }

  ensureRungTakeProfitOrders(now, windowStart) {
    let changed = false;
    for (const side of SIDES) {
      for (const order of this.activeMakerOrders(side, 'SELL', windowStart)) {
        const position = this.positions.find((item) => item.id === order.positionId);
        if (order.purpose === 'TAKE_PROFIT'
          && (!position || position.status !== 'OPEN' || !(Number(position.shares) > EPSILON))) {
          changed = this.cancelMakerOrder(
            order,
            now,
            'CANCELLED_NO_INVENTORY',
            'The rung position no longer has shares to sell.',
          ) || changed;
        }
      }
    }

    const openRungPositions = this.positions.filter((position) =>
      position.status === 'OPEN'
      && Number(position.windowStart) === Number(windowStart)
      && Number(position.rungIndex) >= 1
      && Number(position.shares) > EPSILON);
    for (const position of openRungPositions) {
      const price = Number(position.takeProfitPrice)
        || rungTakeProfitPrice(position.rungPrice ?? position.entryPrice);
      const active = this.activeMakerOrders(position.side, 'SELL', windowStart)
        .find((order) => order.purpose === 'TAKE_PROFIT'
          && order.positionId === position.id);
      if (active
        && Math.abs(Number(active.limitPrice) - price) < EPSILON
        && Math.abs(Number(active.remainingShares) - Number(position.shares)) < EPSILON) {
        position.makerSellOrderId = active.id;
        position.takeProfitOrderId = active.id;
        position.takeProfitOrder = active;
        position.takeProfitPrice = price;
        continue;
      }

      if (active) {
        changed = this.cancelMakerOrder(
          active,
          now,
          'CANCELLED_RESIZED',
          'Replacing the rung take-profit order to cover current shares.',
        ) || changed;
      }
      const order = this.createMakerOrder(
        position.side,
        'SELL',
        price,
        Number(position.shares),
        now,
        windowStart,
        {
          purpose: 'TAKE_PROFIT',
          positionId: position.id,
          rungIndex: position.rungIndex,
          rungCycle: position.rungCycle,
          takeProfitPrice: price,
          fillRule: 'FULL_REMAINDER_ON_FRESH_BEST_BID_OR_BUY_TRADE_AT_OR_ABOVE_LIMIT',
        },
      );
      position.makerSellOrderId = order.id;
      position.takeProfitOrderId = order.id;
      position.takeProfitOrder = order;
      position.takeProfitPrice = price;
      changed = true;
    }
    return changed;
  }

  updateSideOrderState(windowStart) {
    for (const side of SIDES) {
      const state = this.makerQuotes[side];
      const activeBuys = this.activeMakerOrders(side, 'BUY', windowStart)
        .filter((order) => order.purpose === 'ENTRY');
      const activeSells = this.activeMakerOrders(side, 'SELL', windowStart)
        .filter((order) => order.purpose === 'TAKE_PROFIT');
      state.buyOrderIds = activeBuys.map((order) => order.id);
      state.bidOrderId = activeBuys.at(-1)?.id || null;
      state.askOrderId = activeSells[0]?.id || null;
      state.bidStatus = activeBuys.at(-1)?.status || (this.sideSignals[side]?.status || 'WAITING');
      state.askStatus = activeSells[0]?.status || 'NO_POSITION';
      state.inventoryShares = this.totalInventoryForSide(side);
    }
  }

  processLegacyFairValueStrategy(now = this.now()) {
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
      this.entryTriggeredThisWindow = false;
      this.sideEntryCountsThisWindow = { UP: 0, DOWN: 0 };
      this.signalConsumed = { UP: false, DOWN: false };
      this.sideSignals = Object.fromEntries(SIDES.map((side) => [side, {
        status: 'WAITING',
        reason: `Waiting for the next ${config.SIGNAL_ENTRY_INTERVAL_MS / 1000}-second entry check.`,
      }]));
      this.lastEntryCheckSlot = 0;
      this.lastEntryCheckAt = null;
      this.lastEntryCheckResult = 'Waiting for the first 10-second entry check.';
    }

    this.model = this.modelSnapshot(now);
    if (!this.model.ready) {
      this.cancelWindowOrders(windowStart, now, 'CANCELLED_STALE_INPUTS', 'Market inputs are stale.');
      for (const side of SIDES) {
        this.makerQuotes[side].bidStatus = 'WAITING_FOR_MODEL';
        this.makerQuotes[side].askStatus = 'CANCELLED_STALE_INPUTS';
        this.makerQuotes[side].reason = 'Entries wait for fresh Binance and Polymarket data.';
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
    if (millisecondsRemaining <= 0) {
      this.cancelWindowOrders(windowStart, now, 'CANCELLED_WINDOW_END', 'Market window ended.');
      this.marketMakerState = {
        status: 'WINDOW_CLOSED',
        reason: 'Window ended; remaining inventory waits for official resolution.',
      };
      this.signal = { side: null, reason: this.marketMakerState.reason, modelReady: true };
      return false;
    }

    const inventory = this.totalInventoryBySide();
    const netInventory = inventory.UP - inventory.DOWN;
    const baseFairUp = this.model.probabilityUp;
    const baseFairDown = this.model.probabilityDown;
    const fairUp = baseFairUp;
    const fairDown = baseFairDown;
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
      inventorySkew: 0,
      netInventory,
      halfSpread,
      volatility5m: this.model.volatility5m,
    };

    const checkSlot = Math.floor((now - windowStart) / config.SIGNAL_ENTRY_INTERVAL_MS);
    let checkResult = null;
    if (checkSlot > this.lastEntryCheckSlot) {
      this.lastEntryCheckSlot = checkSlot;
      this.lastEntryCheckAt = now;
      checkResult = this.runSignalEntryCheck(now, windowStart);
      this.lastEntryCheckResult = checkResult.reason;
    }

    const withinSellQuoteCutoff = millisecondsRemaining <= config.MAKER_WINDOW_CUTOFF_MS;
    let changed = false;
    for (const side of SIDES) {
      if (withinSellQuoteCutoff) {
        changed = this.cancelSideOrders(
          side,
          windowStart,
          now,
          'CANCELLED_WINDOW_CUTOFF',
          'Passive sell quotes stop in the final 30 seconds.',
        ) > 0 || changed;
        this.makerQuotes[side].bidStatus = 'SIGNAL_ONLY';
        this.makerQuotes[side].askStatus = 'CANCELLED_WINDOW_CUTOFF';
        this.makerQuotes[side].reason = 'Signal checks continue; passive sell quotes stop in the final 30 seconds.';
      } else {
        const fairValue = side === 'UP' ? fairUp : fairDown;
        changed = this.reconcileSideQuotes({
          side,
          fairValue,
          halfSpread,
          inventorySkew: 0,
          now,
          windowStart,
        }) || changed;
      }
    }

    const activeCount = this.orders.filter((order) =>
      order.orderType === ORDER_TYPE
      && order.windowStart === windowStart
      && ACTIVE_ORDER_STATES.has(order.status)).length;
    this.marketMakerState = {
      status: checkResult?.enteredSides?.length
        ? 'ENTRY_ADDED'
        : activeCount ? 'MANAGING_SELLS' : 'SCANNING',
      reason: checkResult?.reason || (activeCount
        ? 'No buy signal this check; passive sell orders manage shares already held.'
        : 'Waiting for the next 10-second check: fair value above 50% and best ask below $0.40.'),
    };
    this.signal = {
      ...(checkResult?.enteredSides?.length === 1 ? { side: checkResult.enteredSides[0] } : {}),
      reason: this.marketMakerState.reason,
      modelReady: true,
      fairValueUP: fairUp,
      fairValueDOWN: fairDown,
      netInventory,
      halfSpread,
      nextEntryCheckAt: windowStart
        + (this.lastEntryCheckSlot + 1) * config.SIGNAL_ENTRY_INTERVAL_MS,
    };
    return changed;
  }

  runSignalEntryCheck(now, windowStart) {
    const enteredSides = [];
    const results = [];
    const market = this.market || {};
    for (const side of SIDES) {
      const probability = side === 'UP'
        ? this.model.probabilityUp
        : this.model.probabilityDown;
      if (!(probability > 0.5)) {
        this.sideSignals[side] = {
          status: 'MODEL_NOT_ABOVE_50',
          probability,
          reason: `${side} fair value must be strictly above 50%.`,
        };
        results.push(`${side} fair value is not above 50%`);
        continue;
      }

      const quote = this.getFreshQuote(side, now);
      if (!quote) {
        this.sideSignals[side] = {
          status: 'WAITING_FOR_FRESH_BOOK',
          probability,
          reason: `Waiting for a fresh ${side} order book.`,
        };
        results.push(`${side} book is not fresh`);
        continue;
      }
      const bestAsk = Number(quote.bestAsk);
      if (!(bestAsk < config.SIGNAL_ENTRY_MAX_PRICE)) {
        this.sideSignals[side] = {
          status: 'ASK_ABOVE_LIMIT',
          probability,
          bestAsk,
          reason: `${side} best ask must be below $${config.SIGNAL_ENTRY_MAX_PRICE.toFixed(2)}.`,
        };
        results.push(`${side} ask is not below $${config.SIGNAL_ENTRY_MAX_PRICE.toFixed(2)}`);
        continue;
      }

      const maximumFillPrice = config.SIGNAL_ENTRY_MAX_PRICE - 2 * EPSILON;
      const visibleExecution = this.sweep(
        side,
        'asks',
        config.SIGNAL_ENTRY_SHARES,
        { now, maximumPrice: maximumFillPrice },
      );
      if (!visibleExecution?.complete || !(visibleExecution.gross > 0)) {
        this.sideSignals[side] = {
          status: 'WAITING_FOR_FULL_DEPTH',
          probability,
          bestAsk,
          reason: `Need all ${config.SIGNAL_ENTRY_SHARES} shares visible below $${config.SIGNAL_ENTRY_MAX_PRICE.toFixed(2)}.`,
        };
        results.push(`${side} lacks full ${config.SIGNAL_ENTRY_SHARES}-share ask depth below the limit`);
        continue;
      }

      if (visibleExecution.totalCost > this.cash + EPSILON) {
        this.sideSignals[side] = {
          status: 'INSUFFICIENT_CASH',
          probability,
          bestAsk,
          reason: 'The full 100-share entry exceeds available paper cash.',
        };
        results.push(`${side} entry exceeds available paper cash`);
        continue;
      }

      const execution = this.sweep(
        side,
        'asks',
        config.SIGNAL_ENTRY_SHARES,
        { now, consume: true, maximumPrice: maximumFillPrice },
      );
      if (!execution?.complete || !(execution.gross > 0)) {
        this.sideSignals[side] = {
          status: 'WAITING_FOR_FULL_DEPTH',
          probability,
          bestAsk,
          reason: 'Visible ask depth changed before the full paper entry could be simulated.',
        };
        results.push(`${side} ask depth changed before entry`);
        continue;
      }

      const expectedEdgePerShare = (
        probability * config.SIGNAL_ENTRY_SHARES - execution.totalCost
      ) / config.SIGNAL_ENTRY_SHARES;
      const candidate = {
        side,
        probability,
        bestAsk,
        expectedEdgePerShare,
        grossCost: execution.gross,
        entryFees: execution.fees,
        allInCost: execution.totalCost,
        fills: execution.fills,
        edgeBypassed: false,
      };
      this.openPosition(candidate, execution, market, now, windowStart, {
        createTakeProfit: false,
        orderType: 'PAPER_TAKER_ASK_SWEEP',
        managementText: 'owned shares remain eligible for passive selling and official resolution',
      });
      this.sideSignals[side] = {
        status: 'ENTRY_ADDED',
        probability,
        bestAsk,
        sharesAdded: config.SIGNAL_ENTRY_SHARES,
        sharesHeld: this.totalInventoryForSide(side),
        reason: `${side}: added ${config.SIGNAL_ENTRY_SHARES} shares at this 10-second check.`,
      };
      enteredSides.push(side);
      results.push(`${side} bought ${config.SIGNAL_ENTRY_SHARES} shares`);
    }

    const reason = enteredSides.length
      ? `10-second check added ${config.SIGNAL_ENTRY_SHARES} ${enteredSides.join(' and ')} shares.`
      : `10-second check: ${results.join('; ')}.`;
    return { enteredSides, reason };
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

    const askPrice = this.passiveAskPrice(fairValue, halfSpread, bestBid);
    sideState.bidPrice = null;
    sideState.askPrice = askPrice;
    sideState.bidStatus = 'SIGNAL_ONLY';
    sideState.reason = 'Buys only occur on 10-second fair-value checks; passive asks can sell owned inventory.';

    const activeBid = this.activeMakerOrder(side, 'BUY', windowStart);
    const changedBid = activeBid
      ? this.cancelMakerOrder(
        activeBid,
        now,
        'CANCELLED_STRATEGY_REPLACED',
        'Passive buys are disabled; entries use the fair-value signal check.',
      )
      : false;
    const changedAsk = this.reconcileMakerOrder({
      side,
      action: 'SELL',
      targetPrice: askPrice,
      now,
      windowStart,
    });

    const askOrder = this.activeMakerOrder(side, 'SELL', windowStart);
    sideState.bidOrderId = null;
    sideState.askOrderId = askOrder?.id || null;
    sideState.bidStatus = 'SIGNAL_ONLY';
    sideState.askStatus = askOrder?.status || (askPrice == null ? 'NO_INVENTORY' : 'NOT_POSTED');
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
    if (active && passive
      && Math.abs(sellableShares - active.remainingShares) < EPSILON
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

  createMakerOrder(side, action, price, shares, now, windowStart, details = {}) {
    const bookSide = action === 'BUY' ? 'bids' : 'asks';
    const queueLevel = (this.books[side]?.[bookSide] || [])
      .find((level) => Math.abs(Number(level.price) - price) < EPSILON);
    const visibleQueue = Number(queueLevel?.availableSize ?? queueLevel?.size) || 0;
    const earlierSamePriceOrders = action === 'BUY'
      ? this.activeMakerOrders(side, 'BUY', windowStart)
        .filter((order) => Math.abs(Number(order.limitPrice) - price) < EPSILON)
        .reduce((total, order) => total + Number(order.remainingShares || 0), 0)
      : 0;
    const order = {
      id: `${windowStart}-btc-${side.toLowerCase()}-${action.toLowerCase()}-${++this.positionSequence}`,
      strategyId: this.strategyId,
      action,
      side,
      purpose: details.purpose || (action === 'SELL' ? 'TAKE_PROFIT' : 'ENTRY'),
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
      queueAheadShares: 0,
      initialQueueAheadShares: 0,
      fills: [],
      createdAt: now,
      expiresAt: details.expiresAt ?? null,
      referenceMidpoint: details.referenceMidpoint ?? null,
      windowStart,
      windowEnd: windowStart + this.windowMs,
      fillRule: action === 'BUY' && (details.purpose || 'ENTRY') === 'ENTRY'
        ? 'FULL_REMAINDER_ON_FRESH_BEST_ASK_OR_OPPOSING_SELL_PRINT_AT_OR_BELOW_LIMIT'
        : 'TRADE_PRINT_AT_OR_THROUGH_PRICE_AFTER_ESTIMATED_QUEUE',
      ...details,
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
    return order;
  }

  activeMakerOrders(side, action, windowStart) {
    return this.orders.filter((order) =>
      order.orderType === ORDER_TYPE
      && order.side === side
      && order.action === action
      && Number(order.windowStart) === Number(windowStart)
      && ACTIVE_ORDER_STATES.has(order.status)
      && Number(order.remainingShares) > EPSILON)
      .sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
  }

  activeMakerOrder(side, action, windowStart) {
    return this.activeMakerOrders(side, action, windowStart)[0] || null;
  }

  cancelMakerOrder(order, now, status = 'CANCELLED_REPLACED', reason = '') {
    if (!order || !ACTIVE_ORDER_STATES.has(order.status)) return false;
    order.cancelledShares = Math.max(0, Number(order.remainingShares) || 0);
    order.status = status;
    order.cancelledAt = now;
    order.cancelReason = reason;
    order.remainingShares = 0;
    const key = order.action === 'BUY' ? 'bidOrderId' : 'askOrderId';
    if (this.makerQuotes[order.side]?.[key] === order.id) this.makerQuotes[order.side][key] = null;
    const position = this.positions.find((item) => item.id === order.positionId);
    if (position?.makerSellOrderId === order.id) position.makerSellOrderId = null;
    if (order.action === 'BUY' && this.sideSignals[order.side]?.orderId === order.id) {
      this.sideSignals[order.side] = {
        ...this.sideSignals[order.side],
        status,
        reason: reason || status,
      };
    }
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

  positionForOrder(order) {
    if (order?.positionId) {
      return this.positions.find((position) =>
        position.id === order.positionId && position.status === 'OPEN') || null;
    }
    if (Number(order?.rungIndex) >= 1) {
      return this.positions.find((position) =>
        position.status === 'OPEN'
        && position.side === order.side
        && Number(position.windowStart) === Number(order.windowStart)
        && Number(position.rungIndex) === Number(order.rungIndex)
        && Number(position.rungCycle) === Number(order.rungCycle)) || null;
    }
    return this.currentPosition(order.side, order.windowStart);
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

  processMakerTradeLegacy(event, receivedAt = this.now()) {
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
      const expectedTakerSide = action === 'BUY' ? 'SELL' : 'BUY';
      if (takerSide !== expectedTakerSide) continue;
      const candidates = this.activeMakerOrders(side, action, windowStart)
        .filter((order) => action === 'BUY' && order.purpose === 'ENTRY')
        .sort((left, right) => Number(right.limitPrice) - Number(left.limitPrice));
      let availableVolume = tradeSize;
      for (let index = 0; index < candidates.length && availableVolume > EPSILON; index += 1) {
        const order = candidates[index];
        if (tradeAt < Number(order.createdAt)) continue;
        if (order.expiresAt != null
          && Number.isFinite(Number(order.expiresAt))
          && tradeAt > Number(order.expiresAt)) continue;
        const qualifies = action === 'BUY'
          ? tradePrice <= Number(order.limitPrice) + EPSILON
          : tradePrice >= Number(order.limitPrice) - EPSILON;
        if (!qualifies) continue;

        const samePrice = Math.abs(tradePrice - Number(order.limitPrice)) < EPSILON;
        let consumedAhead = 0;
        if (samePrice && Number(order.queueAheadShares) > 0) {
          consumedAhead = Math.min(Number(order.queueAheadShares), availableVolume);
          order.queueAheadShares = Math.max(0, Number(order.queueAheadShares) - consumedAhead);
          availableVolume -= consumedAhead;
        } else if (!samePrice) {
          order.queueAheadShares = 0;
          for (const later of candidates.slice(index + 1)) {
            const laterIsCrossed = action === 'BUY'
              ? tradePrice <= Number(later.limitPrice) + EPSILON
              : tradePrice >= Number(later.limitPrice) - EPSILON;
            if (laterIsCrossed) later.queueAheadShares = 0;
          }
        }
        if (samePrice && consumedAhead > 0) {
          for (const later of candidates.slice(index + 1)) {
            if (Math.abs(Number(later.limitPrice) - Number(order.limitPrice)) < EPSILON) {
              later.queueAheadShares = Math.max(0, Number(later.queueAheadShares) - consumedAhead);
            }
          }
        }
        if (!(availableVolume > EPSILON)) continue;

        const priorFilledShares = Number(order.filledShares);
        const fill = this.applyMakerFill(order, availableVolume, receivedAt, { tradePrice, tradeAt });
        const newlyFilledShares = Math.max(0, Number(order.filledShares) - priorFilledShares);
        availableVolume = Math.max(0, availableVolume - newlyFilledShares);
        if (samePrice && newlyFilledShares > 0) {
          for (const later of candidates.slice(index + 1)) {
            if (Math.abs(Number(later.limitPrice) - Number(order.limitPrice)) < EPSILON) {
              later.queueAheadShares = Math.max(0, Number(later.queueAheadShares) - newlyFilledShares);
            }
          }
        }
        changed = fill || changed;
      }
    }

    if (changed) this.processStrategyEntry(receivedAt);
    return changed;
  }

  processMakerTrade(event, receivedAt = this.now()) {
    const side = this.sideForToken(event.asset_id || event.assetId);
    const tradePrice = Number(event.price);
    const tradeSize = Number(event.size);
    const takerSide = String(event.side || '').toUpperCase();
    const tradeAt = Number(event.timestamp);
    if (!side
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
    if (takerSide === 'SELL') {
      return this.fillCrossedBuyRungs(side, tradePrice, receivedAt, {
        crossAt: tradeAt,
        tradeAt,
        tradePrice,
        tradeSize,
        tradeSide: 'SELL',
        confirmation: 'OPPOSING_SELL_TRADE_CROSSED_LIMIT_FULL_FILL',
      });
    }
    return this.fillCrossedTakeProfitOrders(side, tradePrice, receivedAt, {
      crossAt: tradeAt,
      tradeAt,
      tradePrice,
      tradeSize,
      tradeSide: 'BUY',
      confirmation: 'BUY_TRADE_CROSSED_TAKE_PROFIT_FULL_FILL',
    });
  }

  processBookPriceCross(side, now = this.now()) {
    const exited = this.processPositionThresholdExits(now, side);
    if (exited) this.processStrategyEntry(now);
    const quote = this.liveQuotes?.[side];
    const bestAsk = Number(quote?.bestAsk);
    const bestBid = Number(quote?.bestBid);
    const quoteAt = Number(quote?.updatedAt);
    const quoteAge = now - quoteAt;
    if (quote?.stale === true
      || quote?.status !== 'LIVE'
      || !(bestAsk > 0 && bestAsk < 1)
      || !(bestBid >= 0 && bestBid < 1)
      || !Number.isFinite(quoteAt)
      || quoteAge < 0
      || quoteAge > config.MAKER_MAX_TRADE_AGE_MS) return exited;
    const filledTakeProfits = this.fillCrossedTakeProfitOrders(side, bestBid, now, {
      crossAt: quoteAt,
      tradeAt: quoteAt,
      tradePrice: bestBid,
      tradeSide: 'QUOTE',
      confirmation: 'FRESH_BEST_BID_CROSSED_TAKE_PROFIT_FULL_FILL',
    });
    const filledEntries = this.fillCrossedBuyRungs(side, bestAsk, now, {
      crossAt: quoteAt,
      tradeAt: quoteAt,
      tradePrice: bestAsk,
      tradeSide: 'QUOTE',
      confirmation: 'FRESH_BEST_ASK_CROSSED_LIMIT_FULL_FILL',
    });
    return filledEntries || filledTakeProfits || exited;
  }

  fillCrossedTakeProfitOrders(side, crossingPrice, now, details = {}) {
    const windowStart = this.getActiveWindowStart();
    const crossAt = Number(details.crossAt ?? now);
    const price = Number(crossingPrice);
    if (!side || windowStart == null
      || now >= windowStart + this.windowMs
      || !(price > 0 && price < 1)
      || !Number.isFinite(crossAt)) return false;

    const candidates = this.activeMakerOrders(side, 'SELL', windowStart)
      .filter((order) => order.purpose === 'TAKE_PROFIT'
        && crossAt >= Number(order.createdAt)
        && crossAt < Number(order.windowEnd)
        && price >= Number(order.limitPrice) - EPSILON)
      .sort((left, right) => Number(left.limitPrice) - Number(right.limitPrice));
    let changed = false;
    for (const order of candidates) {
      const shares = Number(order.remainingShares);
      if (!(shares > EPSILON)) continue;
      const filled = this.applyMakerFill(order, shares, now, {
        tradeAt: details.tradeAt ?? crossAt,
        tradePrice: details.tradePrice ?? price,
        tradeSize: details.tradeSize ?? shares,
        tradeSide: details.tradeSide ?? 'QUOTE',
        confirmation: details.confirmation || 'CLOB_PRICE_CROSSED_RUNG_TAKE_PROFIT_FULL_FILL',
      });
      changed = filled || changed;
    }
    if (changed) this.processStrategyEntry(now);
    return changed;
  }

  processPositionThresholdExits(now = this.now(), onlySide = null) {
    const windowStart = this.getActiveWindowStart();
    if (windowStart == null || now >= windowStart + this.windowMs) return false;
    let changed = false;
    for (const position of this.positions) {
      if (position.status !== 'OPEN'
        || Number(position.windowStart) !== Number(windowStart)
        || (onlySide && position.side !== onlySide)) continue;
      const quote = this.liveQuotes?.[position.side];
      const bestBid = quote?.bestBid == null ? null : Number(quote.bestBid);
      const quoteAt = Number(quote?.updatedAt);
      const quoteAge = now - quoteAt;
      const fresh = Number.isFinite(bestBid)
        && bestBid >= 0 && bestBid <= 1
        && Number.isFinite(quoteAt)
        && quoteAge >= 0
        && quoteAge <= 15_000
        && quote?.stale !== true;
      if (!fresh) continue;
      const hasRungTakeProfit = Number.isFinite(Number(position.rungIndex))
        && Number(position.rungIndex) >= 1;
      if (!hasRungTakeProfit && bestBid >= TAKE_PROFIT_BID - EPSILON) {
        changed = this.closePositionAtThreshold(
          position,
          'TAKE_PROFIT_THRESHOLD',
          TAKE_PROFIT_PAYOUT,
          bestBid,
          now,
        ) || changed;
      } else if (bestBid <= STOP_LOSS_BID + EPSILON) {
        changed = this.closePositionAtThreshold(
          position,
          'STOP_LOSS_THRESHOLD',
          STOP_LOSS_PAYOUT,
          bestBid,
          now,
        ) || changed;
      }
    }
    return changed;
  }

  closePositionAtThreshold(position, exitReason, payoutPerShare, triggerBid, now) {
    if (position.status !== 'OPEN') return false;
    const shares = Math.max(0, Number(position.shares) || 0);
    if (!(shares > EPSILON)) return false;
    const costBasis = Math.max(0, Number(position.totalCost) || 0);
    const remainingEntryRebate = Math.max(
      0,
      (Number(position.entryEstimatedMakerRebate) || 0)
        - (Number(position.realizedEntryMakerRebate) || 0),
    );
    const proceeds = shares * payoutPerShare;
    position.realizedEntryMakerRebate = (Number(position.realizedEntryMakerRebate) || 0)
      + remainingEntryRebate;
    position.realizedCostBasis = (Number(position.realizedCostBasis) || 0) + costBasis;
    position.shares = 0;
    position.totalCost = 0;
    position.exitProceeds = (Number(position.exitProceeds) || 0) + proceeds;
    position.proceeds = Number(position.exitProceeds) + (Number(position.mergeProceeds) || 0);
    position.exitPrice = payoutPerShare;
    position.exitBid = triggerBid;
    position.exitFees = 0;
    position.exitReason = exitReason;
    position.exitType = 'PAPER_THRESHOLD_EXIT';
    position.exitPolicy = 'INTRAWINDOW_BEST_BID_THRESHOLD';
    position.exitFills = [...(position.exitFills || []), {
      at: now,
      shares,
      price: payoutPerShare,
      triggerBid,
      proceeds,
      reason: exitReason,
      paperOnly: true,
    }];
    position.status = 'SETTLED_EXIT';
    position.closedAt = now;
    position.settledAt = now;
    position.settlementBasis = `PAPER_${exitReason}`;
    for (const order of this.activeMakerOrders(position.side, 'SELL', position.windowStart)) {
      if (order.positionId === position.id) {
        this.cancelMakerOrder(
          order,
          now,
          'CANCELLED_EXITED_POSITION',
          'The rung position exited through its stop-loss threshold.',
        );
      }
    }
    position.unrealizedPnl = 0;
    position.markValue = 0;
    position.markStatus = 'CLOSED';
    this.cash += proceeds;
    position.realizedPnl = this.calculateRealizedPnl(position);
    position.outcome = position.realizedPnl > 0 ? 'WIN'
      : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN';
    this.recordStrategyOutcome(position, position.outcome, now, exitReason);
    this.log(exitReason === 'TAKE_PROFIT_THRESHOLD'
      ? 'PAPER_TAKE_PROFIT_EXIT'
      : 'PAPER_STOP_LOSS_EXIT', {
      positionId: position.id,
      side: position.side,
      shares,
      triggerBid,
      payoutPerShare,
      proceeds,
      realizedPnl: position.realizedPnl,
      windowStart: position.windowStart,
      message: exitReason === 'TAKE_PROFIT_THRESHOLD'
        ? `Best bid reached $${TAKE_PROFIT_BID.toFixed(2)}; booked $1.00 per share and closed ${shares.toFixed(2)} ${position.side} shares.`
        : `Best bid reached $${STOP_LOSS_BID.toFixed(2)}; booked $0.00 per share and closed ${shares.toFixed(2)} ${position.side} shares.`,
    });
    return true;
  }

  fillCrossedBuyRungs(side, crossingPrice, now, details = {}) {
    const windowStart = this.getActiveWindowStart();
    const crossAt = Number(details.crossAt ?? now);
    const price = Number(crossingPrice);
    if (!side || windowStart == null
      || !(price > 0 && price < 1)
      || !Number.isFinite(crossAt)) return false;

    const candidates = this.activeMakerOrders(side, 'BUY', windowStart)
      .filter((order) => order.purpose === 'ENTRY'
        && crossAt >= Number(order.createdAt)
        && (order.expiresAt == null || crossAt < Number(order.expiresAt))
        && price <= Number(order.limitPrice) + EPSILON)
      .sort((left, right) => Number(right.limitPrice) - Number(left.limitPrice));
    let changed = false;
    for (const order of candidates) {
      const shares = Number(order.remainingShares);
      if (!(shares > EPSILON)) continue;
      order.queueAheadShares = 0;
      const filled = this.applyMakerFill(order, shares, now, {
        tradeAt: details.tradeAt ?? crossAt,
        tradePrice: details.tradePrice ?? price,
        tradeSize: details.tradeSize ?? shares,
        tradeSide: details.tradeSide ?? 'QUOTE',
        confirmation: details.confirmation || 'CLOB_PRICE_CROSSED_RUNG_FULL_FILL',
      });
      changed = filled || changed;
    }
    if (changed) this.processStrategyEntry(now);
    return changed;
  }

  applyMakerFill(order, availableShares, now, trade) {
    const position = order.action === 'SELL'
      ? this.positionForOrder(order)
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
      tradeSize: Number(trade.tradeSize ?? availableShares),
      tradeSide: trade.tradeSide || (order.action === 'BUY' ? 'SELL' : 'BUY'),
      confirmation: trade.confirmation || 'OPPOSING_TRADE_PRINT',
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
      if (order.purpose === 'ENTRY' && this.sideSignals[order.side]?.orderId === order.id) {
        this.sideSignals[order.side] = {
          ...this.sideSignals[order.side],
          status: order.status,
          filledShares: order.filledShares,
          reason: order.status === 'FILLED'
            ? `${Number(order.filledShares).toFixed(2)} shares filled.`
            : `${Number(order.filledShares).toFixed(2)} shares filled; the remainder is still resting.`,
        };
      }
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
    let position = this.positionForOrder(order);
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
        rungIndex: order.rungIndex ?? null,
        rungCycle: order.rungCycle ?? null,
        rungPrice: order.rungPrice ?? order.limitPrice,
        takeProfitPrice: order.takeProfitPrice
          ?? (Number(order.rungIndex) >= 1 ? rungTakeProfitPrice(order.limitPrice) : null),
        rungDeadlineAt: order.expiresAt ?? null,
        entryOrderId: order.id,
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
        entryEstimatedMakerRebate: 0,
        realizedEntryMakerRebate: 0,
        realizedSellMakerRebate: 0,
        mergeProceeds: 0,
        mergeCostBasis: 0,
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

    position.rungIndex = order.rungIndex ?? position.rungIndex ?? null;
    position.rungCycle = order.rungCycle ?? position.rungCycle ?? null;
    position.rungPrice = order.rungPrice ?? position.rungPrice ?? order.limitPrice;
    position.takeProfitPrice = order.takeProfitPrice
      ?? position.takeProfitPrice
      ?? (Number(order.rungIndex) >= 1 ? rungTakeProfitPrice(order.limitPrice) : null);
    position.rungDeadlineAt = order.expiresAt ?? position.rungDeadlineAt ?? null;
    position.entryOrderId = order.id;
    position.shares = previousShares + shares;
    position.initialShares = (Number(position.initialShares) || 0) + shares;
    position.totalCost = previousCost + gross;
    position.initialTotalCost = (Number(position.initialTotalCost) || 0) + gross;
    position.entryPrice = position.initialTotalCost / position.initialShares;
    position.filledAt = now;
    position.estimatedMakerRebate += rebate;
    position.makerRebateEstimate += rebate;
    position.entryEstimatedMakerRebate = (Number(position.entryEstimatedMakerRebate) || 0) + rebate;
    position.entryFills.push({ ...fill, orderId: order.id, maker: true });
    position.proceeds = (Number(position.exitProceeds) || 0) + (Number(position.mergeProceeds) || 0);
    order.positionId = position.id;
    this.cash -= gross;
    this.cash += rebate;

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
    const remainingEntryRebate = Math.max(
      0,
      (Number(position.entryEstimatedMakerRebate) || 0)
        - (Number(position.realizedEntryMakerRebate) || 0),
    );
    position.realizedEntryMakerRebate = (Number(position.realizedEntryMakerRebate) || 0)
      + (previousShares > 0 ? remainingEntryRebate * shares / previousShares : 0);
    position.realizedSellMakerRebate = (Number(position.realizedSellMakerRebate) || 0) + rebate;
    position.shares = Math.max(0, previousShares - shares);
    position.totalCost = Math.max(0, previousCost - costBasis);
    position.realizedCostBasis = (Number(position.realizedCostBasis) || 0) + costBasis;
    position.exitProceeds = (Number(position.exitProceeds) || 0) + gross;
    position.proceeds = Number(position.exitProceeds) + (Number(position.mergeProceeds) || 0);
    position.exitFees = 0;
    position.estimatedMakerRebate += rebate;
    position.makerRebateEstimate += rebate;
    position.exitFills = [...(position.exitFills || []), { ...fill, orderId: order.id, maker: true }];
    position.exitPrice = order.averagePrice;
    position.exitBid = order.averagePrice;
    position.makerSellOrderId = order.status === 'FILLED' ? null : order.id;
    order.positionId = position.id;
    order.grossProceeds += gross;
    this.cash += gross + rebate;

    position.realizedPnl = this.calculateRealizedPnl(position);
    if (position.shares <= EPSILON) {
      position.shares = 0;
      position.totalCost = 0;
      position.status = 'SETTLED_EXIT';
      position.closedAt = now;
      position.settledAt = now;
      position.settlementBasis = 'PAPER_MAKER_SELL';
      position.exitReason = order.purpose === 'TAKE_PROFIT' && Number(position.rungIndex) >= 1
        ? 'RUNG_TAKE_PROFIT'
        : 'MAKER_SELL';
      position.exitType = ORDER_TYPE;
      position.realizedPnl = this.calculateRealizedPnl(position);
      position.outcome = position.realizedPnl > 0 ? 'WIN'
        : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN';
      this.recordStrategyOutcome(position, position.outcome, now, position.exitReason);
      if (position.exitReason === 'RUNG_TAKE_PROFIT') this.scheduleRungRearm(position, now);
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

  scheduleRungRearm(position, now) {
    const rungIndex = Number(position.rungIndex);
    const rung = config.MAKER_LADDER_RUNGS[rungIndex - 1];
    if (!rung || !Number.isFinite(Number(position.windowStart))) return false;
    const key = `${position.side}:${rungIndex - 1}`;
    const expiresAt = Number(position.rungDeadlineAt)
      || Number(position.windowStart) + rung.cancelAfterSeconds * 1000;
    if (now >= expiresAt) {
      this.rungOutcomes.set(key, {
        status: 'TAKE_PROFIT_NO_REARM',
        reason: 'The take-profit completed after this rung’s original window deadline.',
      });
      return false;
    }

    const nextCycle = Math.max(1, Number(position.rungCycle) || 1) + 1;
    this.rungRearmQueue.set(key, {
      cycle: nextCycle,
      expiresAt,
      previousPositionId: position.id,
    });
    this.rungOutcomes.set(key, {
      status: 'REARM_PENDING',
      reason: `Take-profit completed; rung cycle ${nextCycle} can re-arm until its original deadline.`,
    });
    this.log('PAPER_RUNG_REARM_QUEUED', {
      side: position.side,
      rungIndex,
      rungCycle: nextCycle,
      rungPrice: position.rungPrice,
      takeProfitPrice: position.takeProfitPrice,
      expiresAt,
      positionId: position.id,
    });
    return true;
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const windowStart = this.getActiveWindowStart();
    const windowEnd = windowStart == null ? null : windowStart + this.windowMs;
    const activeMarketWindow = windowStart != null
      && now >= windowStart
      && now < windowEnd;
    const inventoryWindowStart = windowStart != null && now < windowEnd
      ? windowStart
      : Math.floor(now / this.windowMs) * this.windowMs;
    const openWindowPositions = activeMarketWindow
      ? this.positions.filter((position) =>
        position.status === 'OPEN' && Number(position.windowStart) === Number(windowStart))
      : [];
    const positionsBySide = Object.fromEntries(SIDES.map((side) => [
      side,
      openWindowPositions.find((position) => position.side === side) || null,
    ]));
    const lastExitBySide = Object.fromEntries(SIDES.map((side) => {
      const lastExit = this.positions
        .filter((position) => Number(position.windowStart) === Number(windowStart)
          && position.side === side
          && position.status === 'SETTLED_EXIT'
          && ['TAKE_PROFIT_THRESHOLD', 'STOP_LOSS_THRESHOLD'].includes(position.exitReason))
        .sort((left, right) => Number(right.settledAt || 0) - Number(left.settledAt || 0))[0];
      return [side, lastExit ? {
        exitReason: lastExit.exitReason,
        shares: lastExit.initialShares,
        exitPrice: lastExit.exitPrice,
        triggerBid: lastExit.exitBid,
        realizedPnl: lastExit.realizedPnl,
        settledAt: lastExit.settledAt,
      } : null];
    }));
    const summarizePositions = (positions) => {
      const shares = positions.reduce((total, position) =>
        total + Math.max(0, Number(position.shares) || 0), 0);
      const costBasis = positions.reduce((total, position) => {
        const positionShares = Math.max(0, Number(position.shares) || 0);
        const positionCost = Number(position.totalCost);
        return total + (Number.isFinite(positionCost)
          ? Math.max(0, positionCost)
          : Math.max(0, Number(position.entryPrice) || 0) * positionShares);
      }, 0);
      return {
        shares,
        costBasis,
        averageEntry: shares > EPSILON ? costBasis / shares : null,
        positionCount: positions.length,
      };
    };
    const inventoryPositions = this.positions.filter((position) =>
      ['OPEN', 'PENDING_RESOLUTION'].includes(position.status)
      && Number(position.shares) > EPSILON);
    const inventorySummary = Object.fromEntries(SIDES.map((side) => [
      side,
      summarizePositions(inventoryPositions.filter((position) =>
        position.side === side && Number(position.windowStart) === Number(inventoryWindowStart))),
    ]));
    const olderPositionsByWindow = new Map();
    if (inventoryWindowStart != null) {
      for (const position of inventoryPositions) {
        const positionWindowStart = Number(position.windowStart);
        if (!Number.isFinite(positionWindowStart) || positionWindowStart >= Number(inventoryWindowStart)) continue;
        if (!olderPositionsByWindow.has(positionWindowStart)) {
          olderPositionsByWindow.set(positionWindowStart, []);
        }
        olderPositionsByWindow.get(positionWindowStart).push(position);
      }
    }
    const previousWindowInventory = [...olderPositionsByWindow.entries()]
      .sort(([left], [right]) => right - left)
      .map(([previousWindowStart, positions]) => {
        const firstPosition = positions[0] || {};
        return {
          windowStart: previousWindowStart,
          windowEnd: previousWindowStart + this.windowMs,
          marketTitle: firstPosition.marketTitle || firstPosition.marketSlug || 'Previous BTC 5-minute window',
          UP: summarizePositions(positions.filter((position) => position.side === 'UP')),
          DOWN: summarizePositions(positions.filter((position) => position.side === 'DOWN')),
        };
      });
    const makerQuotes = Object.fromEntries(SIDES.map((side) => {
      const current = this.makerQuotes[side] || {};
      const quote = state.quotes?.[side] || {};
      const buyOrders = this.activeMakerOrders(side, 'BUY', windowStart)
        .filter((order) => order.purpose === 'ENTRY');
      const sellOrder = this.activeMakerOrders(side, 'SELL', windowStart)
        .find((order) => order.purpose === 'TAKE_PROFIT') || null;
      return [side, {
        ...current,
        midpoint: quote.mid ?? current.midpoint,
        bestBid: quote.bestBid ?? null,
        bestAsk: quote.bestAsk ?? null,
        buyOrders: buyOrders.map((order) => this.orderView(order)),
        takeProfitOrder: this.orderView(sellOrder),
        inventoryShares: Number(positionsBySide[side]?.shares) || 0,
        totalInventoryShares: this.totalInventoryForSide(side),
        sideSignal: { ...(this.sideSignals[side] || {}) },
      }];
    }));
    const nextOrderAt = windowStart == null ? null : windowStart
      + (this.lastOrderSlot + 1) * config.CLOB_ENTRY_INTERVAL_MS;
    const pendingResolutionPositions = this.positions.filter((position) =>
      position.status === 'PENDING_RESOLUTION');
    const currentlyOpenPositions = this.positions.filter((position) => position.status === 'OPEN');
    let openMarkedValue = 0;
    let openUnrealizedPnl = 0;
    let unpricedOpenCostBasis = 0;
    let pendingResolutionMarkedValue = 0;
    let pendingResolutionUnrealizedPnl = 0;
    let pendingResolutionCostBasis = 0;
    let unpricedPendingCostBasis = 0;
    const remainingEntryRebate = (position) => Math.max(
      0,
      (Number(position.entryEstimatedMakerRebate) || 0)
        - (Number(position.realizedEntryMakerRebate) || 0),
    );
    for (const position of currentlyOpenPositions) {
      const shares = Math.max(0, Number(position.shares) || 0);
      const costBasis = Math.max(0, Number(position.totalCost) || 0);
      const sameWindow = Number(position.windowStart) === Number(this.market?.start);
      const currentQuote = sameWindow ? state.quotes?.[position.side] : null;
      const currentQuoteBid = currentQuote?.bestBid == null ? null : Number(currentQuote.bestBid);
      const currentQuoteAt = Number(currentQuote?.updatedAt);
      const currentQuoteFresh = Number.isFinite(currentQuoteBid)
        && currentQuoteBid >= 0
        && currentQuoteBid <= 1
        && Number.isFinite(currentQuoteAt)
        && now - currentQuoteAt <= 15_000;
      const markBid = currentQuoteFresh
        ? currentQuoteBid
        : position.markBid == null ? null : Number(position.markBid);
      const markUpdatedAt = currentQuoteFresh ? currentQuoteAt : Number(position.markUpdatedAt);
      const markAgeMs = now - markUpdatedAt;
      if (!Number.isFinite(markBid) || markBid < 0 || markBid > 1
        || !Number.isFinite(markAgeMs) || markAgeMs > 15_000) {
        unpricedOpenCostBasis += costBasis;
        continue;
      }
      const markValue = markBid * shares;
      openMarkedValue += markValue;
      openUnrealizedPnl += markValue - costBasis + remainingEntryRebate(position)
        - (Number(position.fees) || 0);
    }
    for (const position of pendingResolutionPositions) {
      const shares = Math.max(0, Number(position.shares) || 0);
      const costBasis = Math.max(0, Number(position.totalCost) || 0);
      pendingResolutionCostBasis += costBasis;
      const markBid = position.markBid == null ? null : Number(position.markBid);
      if (!Number.isFinite(markBid) || markBid < 0 || markBid > 1) {
        unpricedPendingCostBasis += costBasis;
        continue;
      }
      const markValue = markBid * shares;
      pendingResolutionMarkedValue += markValue;
      pendingResolutionUnrealizedPnl += markValue - costBasis + remainingEntryRebate(position)
        - (Number(position.fees) || 0);
    }
    const markedValue = openMarkedValue + pendingResolutionMarkedValue;
    const paperAccount = {
      ...state.account,
      markedValue,
      equity: this.cash + markedValue,
      unrealizedPnl: openUnrealizedPnl + pendingResolutionUnrealizedPnl,
      openPositionCostBasisUnpriced: unpricedOpenCostBasis,
      pendingResolutionMarkedValue,
      pendingResolutionCostBasis,
      unpricedPendingCostBasis,
      pendingResolutionMarkMethod: 'Current positions use a fresh CLOB best bid; unresolved positions use their last available CLOB best bid. Unpriced inventory is excluded from equity and shown at cost basis.',
    };

    return {
      ...state,
      now,
      status: String(state.status || 'RUNNING').toUpperCase(),
      statusReason: this.marketMakerState.reason || state.statusReason,
      strategy: {
        id: this.strategyId,
        name: this.strategyName,
        version: 'btc-5m-clob-midpoint-maker-v3',
        execution: 'PAPER ONLY',
        symbol: 'BTC UP/DOWN',
        timeframe: '5m',
        model: 'Polymarket CLOB prices only; no Binance signal.',
        quoteMode: 'Independent UP and DOWN maker loops using each side’s current CLOB midpoint.',
        orderType: ORDER_TYPE,
        postOnly: true,
        entryShares: config.CLOB_ENTRY_SHARES,
        entryIntervalMs: config.CLOB_ENTRY_INTERVAL_MS,
        entryTtlMs: config.CLOB_ENTRY_TTL_MS,
        midpointOffset: config.CLOB_ENTRY_MIDPOINT_OFFSET,
        priceReference: 'BEST_BID_ASK_MIDPOINT',
        takeProfitPrice: config.CLOB_TAKE_PROFIT_PRICE,
        takeProfitReferenceValue: 1,
        mergeMode: 'Automatically merge matched UP and DOWN shares from the same open five-minute market for $1 collateral per pair.',
        maxInventoryPerSide: null,
        maxTotalInventoryShares: null,
        fees: 0,
        estimatedMakerRebateRate: config.CRYPTO_MAKER_REBATE_RATE,
        estimatedMakerRebateOnly: true,
        currentMidpoints: Object.fromEntries(SIDES.map((side) => [
          side,
          state.quotes?.[side]?.mid ?? null,
        ])),
        lastOrderAt: this.lastOrderAt,
        lastOrderResult: this.lastOrderResult,
        nextOrderAt,
        maxOpenEntryOrdersPerSide: Math.ceil(config.CLOB_ENTRY_TTL_MS / config.CLOB_ENTRY_INTERVAL_MS),
        fillRule: 'Entry fills are confirmed when a fresh best ask reaches or falls below the resting buy limit. Entry fill simulation does not require a trade print or queue clearance. Timeout only cancels unfilled remainder.',
        exits: {
          takeProfit: config.CLOB_TAKE_PROFIT_PRICE,
          stopLoss: null,
          windowEnd: 'Cancel resting orders at the window end; remaining shares await official resolution.',
        },
        mergeRule: 'As soon as both sides have shares in the same open window, merge min(UP, DOWN) shares. Credit $1 per complete pair, preserve the unmatched remainder, and recreate its take-profit order.',
        trigger: `Every second, place ${config.CLOB_ENTRY_SHARES} shares per side at its fresh midpoint minus $${config.CLOB_ENTRY_MIDPOINT_OFFSET.toFixed(2)}. Confirm entry fills when the fresh best ask reaches or falls below the limit. Cancel any unfilled remainder after ${config.CLOB_ENTRY_TTL_MS / 1000} seconds. Sell accumulated shares with a passive $${config.CLOB_TAKE_PROFIT_PRICE.toFixed(2)} limit. Immediately merge matched UP/DOWN shares in the same window for $1 collateral per pair.`,
      },
      account: {
        ...paperAccount,
        tradeCount: this.positions.filter((position) => position.status !== 'CANCELLED_UNFILLED').length,
        openPositions: this.positions.filter((position) => position.status === 'OPEN').length,
        pendingResolutionPositions: this.positions.filter((position) =>
          position.status === 'PENDING_RESOLUTION').length,
        orderAttempts: this.totalOrderAttempts,
      },
      model: {
        ready: false,
        reason: 'This strategy uses Polymarket CLOB prices only.',
      },
      binance: { status: 'NOT_USED', reason: 'Entry strategy uses Polymarket CLOB prices only.' },
      marketMakerState: { ...this.marketMakerState },
      signal: { ...this.signal },
      fairValues: null,
      makerQuotes,
      makerStats: { ...this.makerStats },
      mergeStats: {
        pairsMerged: this.makerStats.mergedPairs,
        collateralReturned: this.makerStats.mergedCollateral,
        mergeCount: this.mergeHistory.length,
      },
      mergeHistory: this.mergeHistory.slice(0, 100),
      positionsBySide,
      inventorySummary,
      previousWindowInventory,
      openWindowPositions,
      position: openWindowPositions[0] || null,
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

  legacyFairValueSnapshot() {
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
        maxInventoryShares: null,
        signalStatus: this.sideSignals[side]?.status || 'WAITING',
        signalReason: this.sideSignals[side]?.reason || 'Waiting for the next entry check.',
      }];
    }));

    return {
      ...state,
      now,
      strategy: {
        id: this.strategyId,
        name: this.strategyName,
        version: 'btc-5m-fair-value-40c-accumulator-v1',
        execution: 'PAPER ONLY',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        model: 'Binance probability model using the last two completed 5-minute candles.',
        quoteMode: '100-share ask sweeps every 10 seconds when fair value is above 50% and best ask is below $0.40; passive sells manage owned inventory.',
        orderType: 'PAPER_TAKER_ASK_SWEEP',
        postOnly: false,
        entryShares: config.SIGNAL_ENTRY_SHARES,
        entryIntervalMs: config.SIGNAL_ENTRY_INTERVAL_MS,
        fairValueThresholdExclusive: 0.5,
        maximumEntryAskExclusive: config.SIGNAL_ENTRY_MAX_PRICE,
        maxInventoryPerSide: null,
        maxTotalInventoryShares: null,
        baseHalfSpread: config.MAKER_BASE_HALF_SPREAD,
        maxHalfSpread: config.MAKER_MAX_HALF_SPREAD,
        volatilitySpreadMultiplier: config.MAKER_VOLATILITY_SPREAD_MULTIPLIER,
        tickSize: config.MAKER_TICK_SIZE,
        windowCutoffMs: config.MAKER_WINDOW_CUTOFF_MS,
        fairValues: this.fairValues,
        entryPriceCeiling: config.SIGNAL_ENTRY_MAX_PRICE,
        accumulatesInventory: true,
        usesTakerOrders: true,
        inventoryIncludesUnresolvedPositions: true,
        fillRule: 'A signal buy requires a fresh book with enough visible asks to fill all 100 shares below $0.40. Passive sell fills still require fresh last_trade_price prints after the estimated queue is consumed.',
        makerRebateRateEstimate: config.CRYPTO_MAKER_REBATE_RATE,
        estimatedMakerRebateOnly: true,
        lastEntryCheckAt: this.lastEntryCheckAt,
        lastEntryCheckResult: this.lastEntryCheckResult,
        nextEntryCheckAt: windowStart == null ? null : windowStart
          + (this.lastEntryCheckSlot + 1) * config.SIGNAL_ENTRY_INTERVAL_MS,
        sideSignals: { ...this.sideSignals },
        exits: {
          takeProfit: null,
          stopLoss: null,
          windowEnd: 'Cancel passive sell quotes 30 seconds before expiry; remaining inventory waits for official resolution.',
        },
        trigger: `Every ${config.SIGNAL_ENTRY_INTERVAL_MS / 1000} seconds, buy ${config.SIGNAL_ENTRY_SHARES} shares on a side only when its fair value is above 50% and its best ask is below $${config.SIGNAL_ENTRY_MAX_PRICE.toFixed(2)}; require full visible ask depth below the price limit.`,
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
          maxShares: null,
        },
        DOWN: {
          ...state.inventory?.DOWN,
          shares: this.totalInventoryForSide('DOWN'),
          maxShares: null,
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

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const windowStart = this.getActiveWindowStart();
    const windowEnd = windowStart == null ? null : windowStart + this.windowMs;
    const activeWindow = windowStart != null && now >= windowStart && now < windowEnd;
    const currentOrders = windowStart == null ? [] : this.orders.filter((order) =>
      order.orderType === ORDER_TYPE
      && Number(order.windowStart) === Number(windowStart));
    const remainingEntryRebate = (position) => Math.max(
      0,
      (Number(position.entryEstimatedMakerRebate ?? position.estimatedMakerRebate) || 0)
        - (Number(position.realizedEntryMakerRebate) || 0),
    );
    let openMarkedValue = 0;
    let openUnrealizedPnl = 0;
    let unpricedOpenCostBasis = 0;
    let pendingResolutionMarkedValue = 0;
    let pendingResolutionUnrealizedPnl = 0;
    let pendingResolutionCostBasis = 0;
    let unpricedPendingCostBasis = 0;
    for (const position of this.positions) {
      const shares = Math.max(0, Number(position.shares) || 0);
      const costBasis = Math.max(0, Number(position.totalCost) || 0);
      const isOpen = position.status === 'OPEN';
      const isPending = position.status === 'PENDING_RESOLUTION';
      if (!isOpen && !isPending) continue;

      const quote = isOpen
        && Number(position.windowStart) === Number(this.market?.start)
        ? state.quotes?.[position.side]
        : null;
      const quoteBid = quote?.bestBid == null ? null : Number(quote.bestBid);
      const quoteAt = Number(quote?.updatedAt);
      const quoteAge = now - quoteAt;
      const quoteIsFresh = quote?.status === 'LIVE'
        && quote?.stale !== true
        && Number.isFinite(quoteBid)
        && quoteBid >= 0 && quoteBid <= 1
        && Number.isFinite(quoteAt)
        && quoteAge >= 0
        && quoteAge <= 15_000;
      if (quoteIsFresh) {
        position.markBid = quoteBid;
        position.markUpdatedAt = quoteAt;
      }

      const markBid = position.markBid == null ? null : Number(position.markBid);
      const markAt = Number(position.markUpdatedAt);
      const markAgeMs = Number.isFinite(markAt) ? Math.max(0, now - markAt) : null;
      const markIsFresh = Number.isFinite(markBid)
        && markBid >= 0 && markBid <= 1
        && markAgeMs != null && markAgeMs <= 15_000;
      const markValue = markIsFresh ? markBid * shares : null;
      const floatingPnl = markIsFresh
        ? markValue - costBasis + remainingEntryRebate(position) - (Number(position.fees) || 0)
        : null;
      position.markPrice = markIsFresh ? markBid : null;
      position.markValue = markValue;
      position.markAgeMs = markAgeMs;
      position.markStatus = markIsFresh ? 'LIVE' : markBid == null ? 'UNAVAILABLE' : 'STALE';
      position.unrealizedPnl = floatingPnl;

      if (isOpen) {
        if (markIsFresh) {
          openMarkedValue += markValue;
          openUnrealizedPnl += floatingPnl;
        } else {
          unpricedOpenCostBasis += costBasis;
        }
      } else {
        pendingResolutionCostBasis += costBasis;
        if (Number.isFinite(markBid) && markBid >= 0 && markBid <= 1) {
          const pendingValue = markBid * shares;
          pendingResolutionMarkedValue += pendingValue;
          pendingResolutionUnrealizedPnl += pendingValue - costBasis
            + remainingEntryRebate(position) - (Number(position.fees) || 0);
        } else {
          unpricedPendingCostBasis += costBasis;
        }
      }
    }
    const allOpenPositions = this.positions.filter((position) => position.status === 'OPEN');
    const openWindowPositions = activeWindow
      ? allOpenPositions.filter((position) =>
        Number(position.windowStart) === Number(windowStart))
      : [];
    const positionsBySide = Object.fromEntries(SIDES.map((side) => {
      const positions = openWindowPositions.filter((position) => position.side === side);
      if (!positions.length) return [side, null];
      const shares = positions.reduce((total, position) =>
        total + Math.max(0, Number(position.shares) || 0), 0);
      const totalCost = positions.reduce((total, position) =>
        total + Math.max(0, Number(position.totalCost) || 0), 0);
      const allMarked = positions.every((position) =>
        position.markPrice != null && Number.isFinite(Number(position.markPrice)));
      const markValue = allMarked
        ? positions.reduce((total, position) =>
          total + Number(position.markPrice) * Number(position.shares), 0)
        : null;
      const allPnlMarked = positions.every((position) =>
        position.unrealizedPnl != null && Number.isFinite(Number(position.unrealizedPnl)));
      return [side, {
        ...positions[0],
        id: `${windowStart}-btc-${side.toLowerCase()}-aggregate`,
        side,
        shares,
        initialShares: positions.reduce((total, position) =>
          total + (Number(position.initialShares) || 0), 0),
        totalCost,
        entryPrice: shares > EPSILON ? totalCost / shares : null,
        averageCost: shares > EPSILON ? totalCost / shares : null,
        markValue,
        markPrice: markValue == null || shares <= EPSILON ? null : markValue / shares,
        unrealizedPnl: allPnlMarked
          ? positions.reduce((total, position) => total + Number(position.unrealizedPnl), 0)
          : null,
        rungIndex: null,
        takeProfitPrice: null,
        rungCount: positions.length,
        takeProfitPrices: [...new Set(positions.map((position) =>
          Number(position.takeProfitPrice)).filter(Number.isFinite))].sort((left, right) => left - right),
      }];
    }));
    const lastExitBySide = Object.fromEntries(SIDES.map((side) => {
      const lastExit = this.positions
        .filter((position) => Number(position.windowStart) === Number(windowStart)
          && position.side === side
          && position.status === 'SETTLED_EXIT'
          && ['RUNG_TAKE_PROFIT', 'TAKE_PROFIT_THRESHOLD', 'STOP_LOSS_THRESHOLD'].includes(position.exitReason))
        .sort((left, right) => Number(right.settledAt || 0) - Number(left.settledAt || 0))[0];
      return [side, lastExit ? {
        exitReason: lastExit.exitReason,
        shares: lastExit.initialShares,
        exitPrice: lastExit.exitPrice,
        triggerBid: lastExit.exitBid,
        realizedPnl: lastExit.realizedPnl,
        settledAt: lastExit.settledAt,
      } : null];
    }));
    const markedValue = openMarkedValue + pendingResolutionMarkedValue;
    const paperAccount = {
      ...state.account,
      markedValue,
      equity: this.cash + markedValue,
      currentCapital: this.cash + markedValue,
      totalPnl: this.cash + markedValue - Number(state.account?.startingCapital ?? state.account?.capital ?? 0),
      unrealizedPnl: openUnrealizedPnl + pendingResolutionUnrealizedPnl,
      openPositionCostBasisUnpriced: unpricedOpenCostBasis,
      pendingResolutionMarkedValue,
      pendingResolutionCostBasis,
      unpricedPendingCostBasis,
      pendingResolutionMarkMethod: 'Current open positions use the fresh CLOB best bid; positions awaiting resolution use their last available bid.',
    };
    const ladder = Object.fromEntries(SIDES.map((side) => [
      side,
      config.MAKER_LADDER_RUNGS.map((rung, index) => {
        const key = `${side}:${index}`;
        const entryOrders = currentOrders.filter((item) =>
          item.side === side
          && item.action === 'BUY'
          && item.purpose === 'ENTRY'
          && Number(item.rungIndex) === index + 1);
        const order = entryOrders.sort((left, right) =>
          (Number(right.rungCycle) || 0) - (Number(left.rungCycle) || 0)
          || Number(right.createdAt) - Number(left.createdAt))[0];
        const takeProfitOrder = currentOrders.find((item) =>
          item.side === side
          && item.action === 'SELL'
          && item.purpose === 'TAKE_PROFIT'
          && Number(item.rungIndex) === index + 1
          && ACTIVE_ORDER_STATES.has(item.status));
        const rearm = this.rungRearmQueue.get(key);
        const attempt = this.rungOutcomes.get(key);
        const expiresAt = windowStart == null
          ? null
          : windowStart + rung.cancelAfterSeconds * 1000;
        const status = takeProfitOrder ? 'TAKE_PROFIT_RESTING'
          : rearm ? 'REARM_PENDING'
            : attempt?.status
          || order?.status
          || (windowStart == null ? 'WAITING_FOR_WINDOW'
            : now >= expiresAt ? 'MISSED_DEADLINE' : 'WAITING');
        const rungCycle = rearm?.cycle ?? order?.rungCycle ?? null;
        return {
          rungIndex: index + 1,
          price: rung.price,
          takeProfitPrice: rungTakeProfitPrice(rung.price),
          cancelAfterSeconds: rung.cancelAfterSeconds,
          cancelAtSeconds: rung.cancelAfterSeconds,
          rungCycle,
          rearmCount: Math.max(0, Number(rungCycle || 1) - 1),
          requestedShares: order?.requestedShares ?? config.MAKER_LADDER_SHARES,
          filledShares: order?.filledShares ?? 0,
          remainingShares: order?.remainingShares ?? 0,
          cancelledShares: order?.cancelledShares ?? 0,
          status,
          orderId: order?.id || null,
          takeProfitOrderId: takeProfitOrder?.id || null,
          takeProfitStatus: takeProfitOrder?.status || null,
          takeProfitShares: takeProfitOrder?.remainingShares ?? 0,
          createdAt: order?.createdAt ?? null,
          expiresAt: order?.expiresAt ?? rearm?.expiresAt ?? expiresAt,
          reason: order?.cancelReason || attempt?.reason || null,
        };
      }),
    ]));
    const activeOrders = currentOrders.filter((order) => ACTIVE_ORDER_STATES.has(order.status));
    const liveStatus = state.status === 'ERROR' || state.status === 'blocked_or_error' ? 'ERROR' : 'RUNNING';

    return {
      ...state,
      mode: 'DEMO ONLY',
      status: liveStatus,
      statusReason: this.marketMakerState.reason || 'Fixed-price ladder is waiting for Polymarket books.',
      strategy: {
        id: this.strategyId,
        name: this.strategyName,
        version: 'btc-5m-fixed-price-ladder-v1',
        execution: 'PAPER ONLY',
        symbol: 'BTC',
        timeframe: '5m',
        orderType: 'POST_ONLY_LIMIT_BUY_AND_SELL',
        sizePerOrder: config.MAKER_LADDER_SHARES,
        orderSize: config.MAKER_LADDER_SHARES,
        rungPrices: config.MAKER_LADDER_RUNGS.map((rung) => rung.price),
        rungs: config.MAKER_LADDER_RUNGS.map((rung, index) => ({
          rungIndex: index + 1,
          price: rung.price,
          takeProfitPrice: rungTakeProfitPrice(rung.price),
          cancelAfterSeconds: rung.cancelAfterSeconds,
          shares: config.MAKER_LADDER_SHARES,
        })),
        independentSides: true,
        fillRule: 'A fresh best ask at or below a buy limit, or an opposing sell trade print through it, counts as a full 100-share paper fill; queue and print size are ignored.',
        timeoutRule: 'Each rung deadline is measured from window start. Re-armed buys use that same original deadline and do not extend it.',
        takeProfitRule: 'Each rung has a resting limit sell at $1.01 minus its buy price; when it fills, that rung can re-arm only before its original deadline.',
        takeProfitPairPriceSum: COMPLEMENTARY_TAKE_PROFIT_SUM,
        takeProfitFillRule: 'A fresh best bid at or above a rung take-profit, or a BUY trade print through it, counts the full remaining paper sell as filled.',
        stopLossBid: STOP_LOSS_BID,
        stopLossPayoutPerShare: STOP_LOSS_PAYOUT,
        exitPolicy: 'Each rung exits with its own resting limit sell at the opposite-side equivalent price. A best bid of $0.01 exits at $0/share; remaining positions wait for official resolution.',
        accumulatesInventory: true,
      },
      model: null,
      binance: null,
      fairValues: null,
      marketMakerState: {
        ...this.marketMakerState,
        activeBuyOrders: activeOrders.filter((order) =>
          order.action === 'BUY' && order.purpose === 'ENTRY').length,
        activeTakeProfitOrders: activeOrders.filter((order) =>
          order.action === 'SELL' && order.purpose === 'TAKE_PROFIT').length,
        filledShares: currentOrders
          .filter((order) => order.action === 'BUY' && order.purpose === 'ENTRY')
          .reduce((total, order) =>
          total + Number(order.filledShares || 0), 0),
      },
      quotes: state.quotes,
      window: windowStart == null ? null : {
        ...state.window,
        start: windowStart,
        end: windowEnd,
        secondsRemaining: Math.max(0, (windowEnd - now) / 1000),
      },
      positionsBySide,
      openWindowPositions,
      lastExitBySide,
      ladder,
      orders: this.orders.slice(0, 200).map((order) => this.orderView(order)),
      trades: state.positions || [],
      account: {
        ...paperAccount,
        openPositions: this.positions.filter((position) => position.status === 'OPEN').length,
        pendingResolutionPositions: this.positions.filter((position) =>
          position.status === 'PENDING_RESOLUTION').length,
        tradeCount: this.positions.length,
      },
      persistence: { status: 'MEMORY ONLY', detail: 'Paper history resets on Railway restart.' },
    };
  }

  orderView(order) {
    if (!order) return null;
    return {
      id: order.id,
      action: order.action,
      side: order.side,
      rungIndex: order.rungIndex ?? null,
      status: order.status,
      price: order.limitPrice,
      requestedShares: order.requestedShares,
      filledShares: order.filledShares,
      remainingShares: order.remainingShares,
      cancelledShares: order.cancelledShares ?? 0,
      queueAheadShares: order.queueAheadShares,
      createdAt: order.createdAt,
      expiresAt: order.expiresAt,
      cancelAtSeconds: order.cancelAtSeconds ?? null,
      rungCycle: order.rungCycle ?? null,
      takeProfitPrice: order.takeProfitPrice ?? null,
      cancelReason: order.cancelReason ?? null,
      purpose: order.purpose,
      referenceMidpoint: order.referenceMidpoint,
      fillRule: order.fillRule,
      estimatedMakerRebate: order.estimatedMakerRebate,
      postOnly: order.postOnly,
    };
  }
}

MarketMakerBot._test = {
  ...MispricingBot._test,
  clamp,
};

module.exports = MarketMakerBot;
