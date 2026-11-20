'use strict';

const MispricingBot = require('./mispricing-bot');
const WickBot = require('./wick-bot');
const config = require('./config');
const { feeContext, takerFeeFor } = WickBot._test;

const EPSILON = 1e-8;
const SIDES = ['UP', 'DOWN'];
const ORDER_TYPE = 'PAPER_MARKET_BUY';
const LIMIT_ORDER_TYPE = 'PAPER_LIMIT_BUY';

function clamp(value, minimum = -1, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function orderBookPressure(book, tradeImbalance) {
  const bids = (book?.bids || []).slice(0, config.FLOW_DEPTH_LEVELS);
  const asks = (book?.asks || []).slice(0, config.FLOW_DEPTH_LEVELS);
  const bidDepth = bids.reduce((sum, level) => sum + Number(level.availableSize ?? level.size ?? 0), 0);
  const askDepth = asks.reduce((sum, level) => sum + Number(level.availableSize ?? level.size ?? 0), 0);
  const depthTotal = bidDepth + askDepth;
  const depthImbalance = depthTotal > 0 ? (bidDepth - askDepth) / depthTotal : 0;

  const bestBid = book?.bids?.[0];
  const bestAsk = book?.asks?.[0];
  let micropriceImbalance = 0;
  if (bestBid && bestAsk && bestAsk.price > bestBid.price) {
    const bidSize = Number(bestBid.availableSize ?? bestBid.size ?? 0);
    const askSize = Number(bestAsk.availableSize ?? bestAsk.size ?? 0);
    const total = bidSize + askSize;
    if (total > 0) {
      const midpoint = (Number(bestBid.price) + Number(bestAsk.price)) / 2;
      const microprice = (
        Number(bestAsk.price) * bidSize + Number(bestBid.price) * askSize
      ) / total;
      micropriceImbalance = clamp(
        (microprice - midpoint) / ((Number(bestAsk.price) - Number(bestBid.price)) / 2),
      );
    }
  }

  const score = clamp(
    0.40 * depthImbalance
    + 0.40 * clamp(tradeImbalance)
    + 0.20 * micropriceImbalance,
  );
  return {
    score,
    depthImbalance: clamp(depthImbalance),
    tradeImbalance: clamp(tradeImbalance),
    micropriceImbalance,
    bidDepth,
    askDepth,
    tradeCount: 0,
  };
}

class OrderFlowBot extends MispricingBot {
  constructor(options = {}) {
    super(options);
    this.strategyId = 'btc-5m-two-sided-limit-and-reversal';
    this.strategyName = 'BTC 5-minute two-sided limit-entry paper strategy';
    this.rules = {
      sharesPerSide: config.PRICE_LIMIT_SHARES,
      entryShares: config.PRICE_LIMIT_SHARES,
      limitPrice: config.PRICE_LIMIT_ENTRY,
      reversalTriggerMid: config.PRICE_REVERSAL_TRIGGER_MID,
      reversalShares: config.PRICE_REVERSAL_SHARES,
    };
    this.strategyWindowStart = null;
    this.firstFilledSide = null;
    this.reversalTriggered = false;
    this.priceStrategyState = {
      status: 'WAITING_FOR_WINDOW',
      reason: 'Waiting for the current BTC 5-minute market.',
      firstFilledSide: null,
      reversalTriggered: false,
    };
    this.clobTrades = { UP: [], DOWN: [] };
    this.seenClobTrades = new Set();
    this.lastEvaluationAt = null;
    this.pendingSide = null;
    this.confirmationCount = 0;
    this.confirmedSide = null;
    this.pressure = {
      status: 'WAITING_FOR_DATA',
      reason: 'Waiting for fresh Binance trades and Polymarket books.',
      combinedScore: null,
      candidateSide: null,
      confirmedSide: null,
      confirmationCount: 0,
      requiredConfirmations: config.FLOW_CONFIRMATION_COUNT,
    };
    this.signal = { side: null, action: 'WAIT', reason: this.pressure.reason };
    this.flowState = { status: 'WAITING_FOR_DATA', reason: this.pressure.reason };
    this.orderSequence = 0;
  }

  openStrategyWindow(start, now) {
    super.openStrategyWindow(start, now);
    this.strategyWindowStart = start;
    this.firstFilledSide = null;
    this.reversalTriggered = false;
    this.clobTrades = { UP: [], DOWN: [] };
    this.seenClobTrades.clear();
    this.lastEvaluationAt = null;
    this.pendingSide = null;
    this.confirmationCount = 0;
    this.confirmedSide = null;
    this.pressure = {
      status: 'PRICE_ONLY',
      reason: 'Pressure scores are not used by this price-trigger strategy.',
      combinedScore: null,
      candidateSide: null,
      confirmedSide: null,
      confirmationCount: 0,
      requiredConfirmations: 0,
    };
    this.priceStrategyState = {
      status: 'RESTING_LIMITS',
      reason: `UP and DOWN $${this.rules.limitPrice.toFixed(2)} limit buys are resting.`,
      firstFilledSide: null,
      reversalTriggered: false,
    };
    this.signal = {
      side: null,
      action: 'RESTING_LIMIT_BUYS',
      reason: this.priceStrategyState.reason,
    };
    this.flowState = { status: 'PRICE_MONITORING', reason: this.priceStrategyState.reason };
    this.placeRestingEntryOrders(start, now);
  }

  handleMarketMessage(event) {
    if (Array.isArray(event)) {
      for (const item of event) this.handleMarketMessage(item);
      return;
    }
    if (!event || typeof event !== 'object') return;
    super.handleMarketMessage(event);
    const type = event.event_type || event.eventType;
    if (type === 'last_trade_price') this.recordClobTrade(event, this.now());
  }

  recordClobTrade(event, receivedAt = this.now()) {
    const side = this.sideForToken(event.asset_id || event.assetId);
    const price = Number(event.price);
    const shares = Number(event.size);
    const action = String(event.side || '').toUpperCase();
    let at = Number(event.timestamp);
    if (Number.isFinite(at) && at > 0 && at < 1e12) at *= 1000;
    if (!Number.isFinite(at) || at <= 0) at = receivedAt;
    if (!side || !['BUY', 'SELL'].includes(action)
      || !(price > 0 && price < 1)
      || !(shares > 0)
      || at > receivedAt + 1000
      || receivedAt - at > config.FLOW_WINDOW_MS) return false;

    const key = [
      event.transaction_hash || event.transactionHash || '',
      side,
      at,
      price,
      shares,
      action,
    ].join(':');
    if (this.seenClobTrades.has(key)) return false;
    this.seenClobTrades.add(key);
    while (this.seenClobTrades.size > 4096) {
      this.seenClobTrades.delete(this.seenClobTrades.values().next().value);
    }
    this.clobTrades[side].push({ side, action, price, shares, at });
    this.pruneClobTrades(receivedAt);
    return true;
  }

  pruneClobTrades(now = this.now()) {
    const cutoff = now - config.FLOW_WINDOW_MS;
    for (const side of SIDES) {
      this.clobTrades[side] = this.clobTrades[side]
        .filter((trade) => trade.at >= cutoff && trade.at <= now + 1000);
    }
  }

  flowQuote(side, now = this.now()) {
    const quote = this.liveQuotes?.[side];
    const book = this.books?.[side];
    const quoteAt = Number(quote?.updatedAt);
    const bookAt = Number(book?.updatedAt);
    if (!quote || quote.status !== 'LIVE'
      || !Number.isFinite(quoteAt) || quoteAt > now
      || now - quoteAt > config.FLOW_MAX_BOOK_AGE_MS
      || !Number.isFinite(bookAt) || bookAt > now
      || now - bookAt > config.FLOW_MAX_BOOK_AGE_MS) return null;
    const bestBid = Number(quote.bestBid);
    const bestAsk = Number(quote.bestAsk);
    if (!(bestBid > 0 && bestAsk < 1 && bestBid < bestAsk)) return null;
    return quote;
  }

  sideTradeFlow(side, now) {
    const trades = (this.clobTrades[side] || [])
      .filter((trade) => now - trade.at <= config.FLOW_WINDOW_MS);
    const buyShares = trades
      .filter((trade) => trade.action === 'BUY')
      .reduce((sum, trade) => sum + trade.shares, 0);
    const sellShares = trades
      .filter((trade) => trade.action === 'SELL')
      .reduce((sum, trade) => sum + trade.shares, 0);
    const total = buyShares + sellShares;
    return {
      buyShares,
      sellShares,
      tradeCount: trades.length,
      imbalance: total > 0 ? (buyShares - sellShares) / total : 0,
    };
  }

  buildPressureSnapshot(now = this.now()) {
    const feed = this.priceFeed.snapshot?.() || {};
    const flow = feed.tradeFlow || {};
    const tickAt = Number(feed.tickAt);
    const tickAgeMs = Number.isFinite(tickAt) ? Math.max(0, now - tickAt) : null;
    const binanceTradeCount = Number(flow.tradeCount) || 0;
    const buyNotional = Number(flow.buyNotional) || 0;
    const sellNotional = Number(flow.sellNotional) || 0;
    const totalNotional = buyNotional + sellNotional;
    const binanceImbalance = totalNotional > 0
      ? clamp((buyNotional - sellNotional) / totalNotional)
      : null;
    const priceChangePct = Number.isFinite(Number(flow.priceChangePct))
      ? Number(flow.priceChangePct)
      : null;
    const momentumScore = priceChangePct == null
      ? 0
      : clamp(priceChangePct / config.FLOW_PRICE_MOMENTUM_SCALE);
    const binanceScore = binanceImbalance == null
      ? null
      : clamp(0.75 * binanceImbalance + 0.25 * momentumScore);
    const binanceReady = feed.status === 'CONNECTED'
      && tickAgeMs != null
      && tickAgeMs <= config.MAX_DATA_AGE_MS
      && binanceTradeCount >= config.FLOW_MIN_BINANCE_TRADES
      && binanceImbalance != null;

    this.pruneClobTrades(now);
    const books = {};
    const outcomeScores = {};
    const clobFlows = {};
    for (const side of SIDES) {
      const quote = this.flowQuote(side, now);
      const book = this.books?.[side];
      if (!quote || !book?.bids?.length || !book?.asks?.length) {
        books[side] = { ready: false, ageMs: null };
        outcomeScores[side] = null;
        clobFlows[side] = this.sideTradeFlow(side, now);
        continue;
      }
      const flowForSide = this.sideTradeFlow(side, now);
      const score = orderBookPressure(book, flowForSide.imbalance);
      score.tradeCount = flowForSide.tradeCount;
      books[side] = {
        ready: true,
        ageMs: Math.max(0, now - Number(book.updatedAt)),
        bestBid: Number(quote.bestBid),
        bestAsk: Number(quote.bestAsk),
        score,
      };
      outcomeScores[side] = score.score;
      clobFlows[side] = flowForSide;
    }
    const clobReady = SIDES.every((side) => books[side]?.ready);
    const clobScore = clobReady
      ? clamp((outcomeScores.UP - outcomeScores.DOWN) / 2)
      : null;
    const combinedScore = binanceReady && clobReady
      ? clamp((binanceScore + clobScore) / 2)
      : null;
    let candidateSide = null;
    let agreement = false;
    if (binanceReady && clobReady) {
      agreement = Math.abs(binanceScore) >= config.FLOW_COMPONENT_MIN
        && Math.abs(clobScore) >= config.FLOW_COMPONENT_MIN
        && Math.sign(binanceScore) === Math.sign(clobScore);
      const pressureSide = agreement && combinedScore >= config.FLOW_SIGNAL_THRESHOLD
        ? 'UP'
        : agreement && combinedScore <= -config.FLOW_SIGNAL_THRESHOLD ? 'DOWN' : null;
      if (pressureSide) candidateSide = pressureSide;
    }

    let reason = 'Both feeds need fresh data before a signal can qualify.';
    if (feed.status !== 'CONNECTED') reason = `Binance stream is ${String(feed.status || 'waiting').toLowerCase()}.`;
    else if (tickAgeMs == null || tickAgeMs > config.MAX_DATA_AGE_MS) reason = 'Waiting for a fresh Binance tick.';
    else if (binanceTradeCount < config.FLOW_MIN_BINANCE_TRADES) {
      reason = `Waiting for at least ${config.FLOW_MIN_BINANCE_TRADES} recent Binance trades.`;
    } else if (!clobReady) reason = 'Waiting for fresh, two-sided UP and DOWN books.';
    else if (!agreement) reason = 'Binance and Polymarket pressure do not yet agree.';
    else if (!candidateSide) reason = `Combined pressure is below the ±${config.FLOW_SIGNAL_THRESHOLD.toFixed(2)} trigger.`;
    else reason = `${candidateSide} pressure qualifies; confirming consecutive one-second checks.`;

    return {
      status: !binanceReady || !clobReady ? 'WAITING_FOR_DATA' : candidateSide ? 'CANDIDATE' : 'NEUTRAL',
      reason,
      ready: binanceReady && clobReady,
      evaluatedAt: now,
      windowMs: config.FLOW_WINDOW_MS,
      binance: {
        ready: binanceReady,
        status: feed.status || 'WAITING',
        tickAgeMs,
        tradeCount: binanceTradeCount,
        buyCount: Number(flow.buyCount) || 0,
        sellCount: Number(flow.sellCount) || 0,
        buyNotional,
        sellNotional,
        signedNotional: buyNotional - sellNotional,
        imbalance: binanceImbalance,
        priceChangePct,
        momentumScore,
        score: binanceScore,
      },
      polymarket: {
        ready: clobReady,
        score: clobScore,
        outcomes: books,
        trades: clobFlows,
      },
      combinedScore,
      agreement,
      threshold: config.FLOW_SIGNAL_THRESHOLD,
      componentMinimum: config.FLOW_COMPONENT_MIN,
      candidateSide,
      confirmedSide: this.confirmedSide,
      confirmationCount: this.confirmationCount,
      requiredConfirmations: config.FLOW_CONFIRMATION_COUNT,
    };
  }

  processStrategyEntry(now = this.now()) {
    const windowStart = this.getActiveWindowStart();
    if (windowStart == null) {
      this.flowState = { status: 'WAITING', reason: 'Waiting for the current BTC 5-minute market.' };
      this.priceStrategyState = {
        status: 'WAITING_FOR_WINDOW',
        reason: this.flowState.reason,
        firstFilledSide: null,
        reversalTriggered: false,
      };
      this.signal = { side: null, action: 'WAIT', reason: this.flowState.reason };
      return false;
    }
    if (this.strategyWindowStart !== windowStart) this.openStrategyWindow(windowStart, now);

    let changed = this.processRestingEntryOrders(now);
    changed = this.processMidpointReversal(now) || changed;
    const reason = this.priceStrategyState?.reason || 'Monitoring Polymarket prices.';
    this.flowState = { status: this.priceStrategyState?.status || 'PRICE_MONITORING', reason };
    this.pressure = {
      ...this.pressure,
      status: 'PRICE_ONLY',
      reason: 'Order-flow scores are informational only; entries use CLOB prices.',
      evaluatedAt: now,
      candidateSide: null,
      confirmedSide: null,
      confirmationCount: 0,
      requiredConfirmations: 0,
    };
    return changed;
  }

  placeRestingEntryOrders(windowStart, now) {
    for (const side of SIDES) {
      const order = {
        id: `${windowStart}-btc-${side.toLowerCase()}-limit-buy-${++this.orderSequence}`,
        strategyId: this.strategyId,
        action: 'BUY',
        side,
        orderType: LIMIT_ORDER_TYPE,
        status: 'RESTING',
        requestedShares: this.rules.sharesPerSide,
        filledShares: 0,
        remainingShares: this.rules.sharesPerSide,
        cancelledShares: 0,
        limitPrice: this.rules.limitPrice,
        referencePrice: this.rules.limitPrice,
        averagePrice: null,
        grossCost: 0,
        fees: 0,
        estimatedMakerRebate: 0,
        createdAt: now,
        windowStart,
        paperOnly: true,
        timeInForce: 'GTD_WINDOW',
        immediateOrCancel: false,
        fillRule: 'FULL_100_SHARE_FILL_WHEN_FRESH_BEST_ASK_IS_AT_OR_BELOW_LIMIT; PRICE_IMPROVEMENT_AT_BEST_ASK; NO_TAKER_FEE',
      };
      this.orders.unshift(order);
      this.windowOrders.unshift(order);
      this.totalOrderAttempts += 1;
    }
    this.log('PAPER_TWO_SIDED_LIMIT_BUYS_PLACED', {
      windowStart,
      limitPrice: this.rules.limitPrice,
      sharesPerSide: this.rules.sharesPerSide,
      sides: SIDES,
    });
    this.priceStrategyState = {
      status: 'RESTING_LIMITS',
      reason: `UP and DOWN ${this.rules.sharesPerSide}-share limit buys are resting at $${this.rules.limitPrice.toFixed(2)}.`,
      firstFilledSide: null,
      reversalTriggered: false,
    };
    return true;
  }

  processRestingEntryOrders(now) {
    if (this.firstFilledSide) return false;
    const windowStart = Number(this.getActiveWindowStart());
    const eligible = this.orders
      .filter((order) => order.strategyId === this.strategyId
        && order.orderType === LIMIT_ORDER_TYPE
        && order.status === 'RESTING'
        && Number(order.windowStart) === windowStart)
      .map((order) => ({ order, quote: this.flowQuote(order.side, now) }))
      .filter(({ quote }) => quote && Number(quote.bestAsk) <= this.rules.limitPrice)
      .sort((a, b) => Number(a.quote.updatedAt) - Number(b.quote.updatedAt)
        || SIDES.indexOf(a.order.side) - SIDES.indexOf(b.order.side));
    const first = eligible[0];
    if (!first) return false;
    const { order, quote } = first;
    const fillPrice = Math.min(this.rules.limitPrice, Number(quote.bestAsk));
    const filledShares = Number(order.requestedShares);
    const grossCost = filledShares * fillPrice;
    if (grossCost > Math.max(0, Number(this.cash) || 0) + EPSILON) {
      this.priceStrategyState = {
        status: 'INSUFFICIENT_CASH',
        reason: `The ${order.side} ask reached $${fillPrice.toFixed(2)}, but paper cash cannot cover the 100-share limit fill.`,
        firstFilledSide: null,
        reversalTriggered: false,
      };
      return false;
    }

    const position = this.currentPosition(order.side, windowStart)
      || this.createPosition(order.side, windowStart, now);
    const fill = { price: fillPrice, shares: filledShares, at: now, orderId: order.id };
    position.shares += filledShares;
    position.initialShares += filledShares;
    position.totalCost += grossCost;
    position.initialTotalCost += grossCost;
    position.entryPrice = position.initialTotalCost / position.initialShares;
    position.avgEntry = position.entryPrice;
    position.filledAt = now;
    position.lastAddedAt = now;
    position.entryFills.push(fill);
    position.entrySignals.push({
      at: now,
      signalSide: null,
      side: order.side,
      shares: filledShares,
      averagePrice: fillPrice,
      fees: 0,
      estimatedMakerRebate: 0,
      orderId: order.id,
      reason: 'RESTING_LIMIT_ASK_TOUCH',
    });
    position.markPrice = Number(quote.bestBid);
    position.markStatus = 'LIVE';
    position.feeContext = feeContext(this.market || {});
    this.cash -= grossCost;

    order.status = 'FILLED';
    order.filledShares = filledShares;
    order.remainingShares = 0;
    order.averagePrice = fillPrice;
    order.grossCost = grossCost;
    order.fees = 0;
    order.filledAt = now;
    order.fills = [fill];
    order.positionId = position.id;
    this.firstFilledSide = order.side;
    this.cancelOtherRestingOrder(order.side, now, windowStart);
    this.log('PAPER_LIMIT_BUY_FILLED', {
      orderId: order.id,
      positionId: position.id,
      side: order.side,
      limitPrice: order.limitPrice,
      bestAskAtFill: quote.bestAsk,
      shares: filledShares,
      averagePrice: fillPrice,
      grossCost,
      fees: 0,
    });
    this.events.unshift({
      ts: now,
      at: now,
      event: 'PAPER_LIMIT_BUY_FILLED',
      type: 'PAPER_LIMIT_BUY_FILLED',
      message: `${filledShares} ${order.side} shares filled by the $${order.limitPrice.toFixed(2)} resting limit when the fresh best ask reached $${Number(quote.bestAsk).toFixed(3)}.`,
      details: {
        orderId: order.id,
        positionId: position.id,
        side: order.side,
        shares: filledShares,
        limitPrice: order.limitPrice,
        bestAskAtFill: quote.bestAsk,
        averagePrice: fillPrice,
      },
    });
    if (this.events.length > 200) this.events.length = 200;
    this.priceStrategyState = {
      status: 'POSITION_OPEN',
      reason: `${filledShares} ${order.side} shares filled at $${fillPrice.toFixed(2)}; watching its midpoint for $${this.rules.reversalTriggerMid.toFixed(2)} or lower.`,
      firstFilledSide: order.side,
      reversalTriggered: false,
      fillPrice,
      filledShares,
    };
    this.signal = {
      side: order.side,
      action: 'LIMIT_ENTRY_FILLED',
      reason: this.priceStrategyState.reason,
    };
    return true;
  }

  cancelOtherRestingOrder(filledSide, now, windowStart) {
    for (const order of this.orders) {
      if (order.strategyId !== this.strategyId
        || order.orderType !== LIMIT_ORDER_TYPE
        || order.status !== 'RESTING'
        || Number(order.windowStart) !== Number(windowStart)
        || order.side === filledSide) continue;
      order.status = 'CANCELLED_OTHER_SIDE_FILLED';
      order.cancelledShares = Number(order.remainingShares) || 0;
      order.remainingShares = 0;
      order.cancelledAt = now;
      order.cancelReason = 'OTHER_SIDE_FILLED';
      this.log('PAPER_OPPOSITE_LIMIT_BUY_CANCELLED', {
        orderId: order.id,
        side: order.side,
        filledSide,
        cancelledShares: order.cancelledShares,
      });
    }
  }

  processMidpointReversal(now) {
    if (!this.firstFilledSide || this.reversalTriggered) return false;
    const quote = this.flowQuote(this.firstFilledSide, now);
    if (!quote) return false;
    const midpoint = (Number(quote.bestBid) + Number(quote.bestAsk)) / 2;
    this.priceStrategyState = {
      ...this.priceStrategyState,
      firstSideMidpoint: midpoint,
      reversalTriggered: false,
    };
    if (!Number.isFinite(midpoint) || midpoint > this.rules.reversalTriggerMid) return false;

    this.reversalTriggered = true;
    const oppositeSide = this.firstFilledSide === 'UP' ? 'DOWN' : 'UP';
    const submitted = this.submitMarketBuy(
      oppositeSide,
      now,
      { combinedScore: null, binance: {}, polymarket: {} },
      'MIDPOINT_010_TRIGGER',
      this.rules.reversalShares,
    );
    const filledShares = Number(submitted.filledShares) || 0;
    const reason = filledShares > 0
      ? `${this.firstFilledSide} midpoint reached $${midpoint.toFixed(3)}; immediately market-bought ${filledShares} ${oppositeSide} shares.`
      : `${this.firstFilledSide} midpoint reached $${midpoint.toFixed(3)}; the opposite market buy was attempted but did not fill (${submitted.reason || 'no visible ask liquidity'}).`;
    this.priceStrategyState = {
      ...this.priceStrategyState,
      status: filledShares > 0 ? 'REVERSAL_BOUGHT' : 'REVERSAL_ATTEMPTED',
      reason,
      firstFilledSide: this.firstFilledSide,
      firstSideMidpoint: midpoint,
      reversalTriggered: true,
      reversalSide: oppositeSide,
      reversalRequestedShares: this.rules.reversalShares,
      reversalFilledShares: filledShares,
      reversalOrderId: submitted.orderId || null,
      reversalOrderStatus: submitted.status || 'NOT_PLACED',
    };
    this.signal = {
      side: oppositeSide,
      signalSide: this.firstFilledSide,
      buySide: oppositeSide,
      action: filledShares > 0 ? 'BUY_OPPOSITE_200' : 'REVERSAL_BUY_ATTEMPTED',
      reason,
      buyFilledShares: filledShares,
      buyUnfilledShares: Number(submitted.unfilledShares) || 0,
      averagePrice: submitted.averagePrice ?? null,
      fees: Number(submitted.fees) || 0,
      orderId: submitted.orderId || null,
      orderStatus: submitted.status || 'NOT_PLACED',
    };
    this.log('PAPER_MIDPOINT_REVERSAL_TRIGGERED', {
      positionSide: this.firstFilledSide,
      midpoint,
      oppositeSide,
      requestedShares: this.rules.reversalShares,
      filledShares,
      orderId: submitted.orderId || null,
      orderStatus: submitted.status || 'NOT_PLACED',
    });
    return true;
  }

  submitMarketBuy(
    side,
    now,
    signal,
    signalSide = null,
    requestedShares = config.FLOW_ENTRY_SHARES,
  ) {
    requestedShares = Number(requestedShares);
    if (!(requestedShares > EPSILON)) return { filledShares: 0, reason: 'INVALID_ENTRY_SIZE' };
    const quote = this.flowQuote(side, now);
    const book = this.books?.[side];
    const asks = book?.asks;
    const bestAsk = Number(quote?.bestAsk);
    if (!quote || !Array.isArray(asks) || !asks.length
      || !Number.isFinite(bestAsk) || !(bestAsk > 0 && bestAsk < 1)) {
      return { filledShares: 0, reason: 'NO_FRESH_ASK_BOOK' };
    }
    const windowStart = this.getActiveWindowStart();
    const order = {
      id: `${windowStart}-btc-${side.toLowerCase()}-buy-market-${++this.orderSequence}`,
      strategyId: this.strategyId,
      action: 'BUY',
      side,
      signalSide,
      orderType: ORDER_TYPE,
      status: 'UNFILLED_NO_LIQUIDITY',
      requestedShares,
      filledShares: 0,
      remainingShares: 0,
      unfilledShares: requestedShares,
      cancelledShares: requestedShares,
      bestAskAtSubmission: bestAsk,
      referencePrice: bestAsk,
      averagePrice: null,
      grossCost: 0,
      fees: 0,
      estimatedMakerRebate: 0,
      createdAt: now,
      windowStart,
      paperOnly: true,
      timeInForce: 'FAK',
      immediateOrCancel: true,
      cancelOnNextConfirmedSignal: false,
      fillRule: 'SWEEP_ALL_VALID_VISIBLE_ASKS_UP_TO_REQUESTED_SHARES; PARTIAL_FILL_ALLOWED; CANCEL_UNFILLED_REMAINDER; MODELED_TAKER_FEES',
      signal: {
        combinedScore: signal?.combinedScore ?? null,
        binanceScore: signal?.binance?.score ?? null,
        polymarketScore: signal?.polymarket?.score ?? null,
      },
    };
    const fills = [];
    let sharesRemaining = requestedShares;
    let cashRemaining = Math.max(0, Number(this.cash) || 0);
    let grossCost = 0;
    let fees = 0;
    for (const level of asks) {
      if (sharesRemaining <= EPSILON || cashRemaining <= EPSILON) break;
      const price = Number(level.price);
      const availableSize = Number(level.availableSize ?? level.size);
      if (!(price > 0
        && price < 1
        && availableSize > 0)) continue;

      let shares = Math.min(sharesRemaining, availableSize);
      const costAt = quantity => quantity * price + takerFeeFor(this.market || {}, price, quantity);
      if (costAt(shares) > cashRemaining + EPSILON) {
        let low = 0;
        let high = shares;
        for (let iteration = 0; iteration < 48; iteration += 1) {
          const middle = (low + high) / 2;
          if (costAt(middle) <= cashRemaining + EPSILON) low = middle;
          else high = middle;
        }
        shares = low;
      }
      if (!(shares > EPSILON)) continue;

      const levelGross = shares * price;
      const levelFees = takerFeeFor(this.market || {}, price, shares);
      const fill = { price, shares, at: now, orderId: order.id };
      fills.push(fill);
      grossCost += levelGross;
      fees += levelFees;
      cashRemaining = Math.max(0, cashRemaining - levelGross - levelFees);
      sharesRemaining = Math.max(0, sharesRemaining - shares);
      level.availableSize = Math.max(0, availableSize - shares);
    }

    const filledShares = requestedShares - sharesRemaining;
    const averagePrice = filledShares > EPSILON ? grossCost / filledShares : null;
    const unfilledShares = Math.max(0, requestedShares - filledShares);
    const fullFill = unfilledShares <= EPSILON;
    order.status = fullFill
      ? 'FILLED'
      : filledShares > EPSILON ? 'PARTIALLY_FILLED' : 'UNFILLED_NO_LIQUIDITY';
    order.filledShares = filledShares;
    order.remainingShares = 0;
    order.unfilledShares = unfilledShares;
    order.cancelledShares = unfilledShares;
    order.averagePrice = averagePrice;
    order.grossCost = grossCost;
    order.fees = fees;
    order.estimatedMakerRebate = 0;
    order.filledAt = filledShares > EPSILON ? now : null;
    order.cancelledAt = unfilledShares > EPSILON ? now : null;
    order.cancelReason = unfilledShares > EPSILON ? 'FAK_REMAINDER_CANCELLED' : null;
    order.fills = fills;

    let position = null;
    if (filledShares > EPSILON) {
      position = this.currentPosition(side, windowStart)
        || this.createPosition(side, windowStart, now);
      position.shares += filledShares;
      position.initialShares += filledShares;
      position.totalCost += grossCost;
      position.initialTotalCost += grossCost;
      position.fees += fees;
      position.initialFees += fees;
      position.entryFees += fees;
      position.entryPrice = position.initialTotalCost / position.initialShares;
      position.avgEntry = position.entryPrice;
      position.filledAt = now;
      position.lastAddedAt = now;
      position.entryFills.push(...fills);
      position.entrySignals.push({
        at: now,
        signalSide: signalSide || null,
        side,
        shares: filledShares,
        averagePrice,
        fees,
        estimatedMakerRebate: 0,
        combinedScore: signal?.combinedScore ?? null,
        binanceScore: signal?.binance?.score ?? null,
        polymarketScore: signal?.polymarket?.score ?? null,
        orderId: order.id,
      });
      this.cash -= grossCost + fees;
      order.positionId = position.id;
      position.lastEntryOrderId = order.id;
      this.updateQuoteFromBook(side, book, now);
    }

    const noFillReason = filledShares > EPSILON
      ? null
      : this.cash <= EPSILON ? 'INSUFFICIENT_PAPER_CASH' : 'NO_VISIBLE_ASK_LIQUIDITY';
    const resultMessage = filledShares > EPSILON
      ? `${signalSide || side} signal market buy filled ${filledShares} of ${requestedShares} ${side} shares at an average $${averagePrice.toFixed(3)} across visible asks; taker fee $${fees.toFixed(3)}${unfilledShares > EPSILON ? `, unfilled ${unfilledShares} cancelled` : ''}.`
      : `${signalSide || side} signal market buy did not fill: ${noFillReason === 'INSUFFICIENT_PAPER_CASH' ? 'insufficient paper cash' : 'no visible ask liquidity'}.`;
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.totalOrderAttempts += 1;
    this.log(filledShares > EPSILON ? 'PAPER_FLOW_MARKET_BUY_EXECUTED' : 'PAPER_FLOW_MARKET_BUY_UNFILLED', {
      orderId: order.id,
      positionId: position?.id || null,
      signalSide,
      side,
      requestedShares,
      filledShares,
      unfilledShares,
      bestAskAtSubmission: bestAsk,
      averagePrice,
      grossCost,
      fees,
      fills,
      status: order.status,
      reason: noFillReason,
    });
    this.events.unshift({
      ts: now,
      at: now,
      event: filledShares > EPSILON
        ? fullFill ? 'PAPER_MARKET_BUY_FILLED' : 'PAPER_MARKET_BUY_PARTIAL'
        : 'PAPER_MARKET_BUY_UNFILLED',
      type: filledShares > EPSILON
        ? fullFill ? 'PAPER_MARKET_BUY_FILLED' : 'PAPER_MARKET_BUY_PARTIAL'
        : 'PAPER_MARKET_BUY_UNFILLED',
      message: resultMessage,
      details: {
        orderId: order.id,
        positionId: position?.id || null,
        signalSide,
        side,
        requestedShares,
        filledShares,
        unfilledShares,
        bestAskAtSubmission: bestAsk,
        averagePrice,
        grossCost,
        fees,
        estimatedMakerRebate: 0,
        fills,
        status: order.status,
        reason: noFillReason,
      },
    });
    if (this.events.length > 200) this.events.length = 200;
    return {
      filledShares,
      unfilledShares,
      averagePrice,
      bestAskAtSubmission: bestAsk,
      grossCost,
      fees,
      estimatedMakerRebate: 0,
      orderId: order.id,
      status: order.status,
      reason: noFillReason,
    };
  }

  totalInventoryForSide(side) {
    return this.positions.reduce((total, position) => {
      if (position.side !== side || !['OPEN', 'PENDING_RESOLUTION'].includes(position.status)) return total;
      return total + Math.max(0, Number(position.shares) || 0);
    }, 0);
  }

  currentPosition(side, windowStart = this.getActiveWindowStart()) {
    return this.positions.find((position) => position.status === 'OPEN'
      && position.side === side
      && Number(position.windowStart) === Number(windowStart)) || null;
  }

  createPosition(side, windowStart, now) {
    const id = `${windowStart}-btc-${side.toLowerCase()}-flow-${++this.positionSequence}`;
    const position = {
      id,
      strategyId: this.strategyId,
      marketId: this.market?.id || this.market?.conditionId || this.market?.slug || null,
      marketSlug: this.market?.slug || null,
      marketTitle: this.market?.title || this.market?.slug || 'BTC 5-minute Up or Down',
      windowStart,
      windowEnd: windowStart + this.windowMs,
      asset: 'BTC',
      side,
      status: 'OPEN',
      shares: 0,
      initialShares: 0,
      entryPrice: null,
      avgEntry: null,
      totalCost: 0,
      initialTotalCost: 0,
      fees: 0,
      initialFees: 0,
      entryFees: 0,
      estimatedEntryMakerRebate: 0,
      exitFees: 0,
      realizedCostBasis: 0,
      realizedEntryFees: 0,
      openedAt: now,
      filledAt: now,
      markPrice: null,
      unrealizedPnl: null,
      estimatedMakerRebate: 0,
      makerRebateEstimate: 0,
      estimatedEntryMakerRebate: 0,
      estimatedExitMakerRebate: 0,
      entryFills: [],
      entrySignals: [],
      exitFills: [],
      exitProceeds: 0,
      proceeds: 0,
      realizedPnl: null,
      feeContext: feeContext(this.market || {}),
      paperOnly: true,
    };
    this.positions.unshift(position);
    return position;
  }

  completedWindowStats(now = this.now()) {
    const byWindow = new Map();
    for (const position of this.positions) {
      if (position.strategyId !== this.strategyId
        || !(Number(position.initialShares ?? position.shares) > EPSILON)) continue;
      const windowStart = Number(position.windowStart);
      if (!Number.isFinite(windowStart)) continue;
      if (!byWindow.has(windowStart)) byWindow.set(windowStart, []);
      byWindow.get(windowStart).push(position);
    }

    const windows = [...byWindow.entries()]
      .filter(([windowStart, positions]) =>
        windowStart + this.windowMs <= now
        && positions.length > 0
        && positions.every((position) => position.status === 'SETTLED_EXIT'))
      .map(([windowStart, positions]) => {
        const netPnl = positions.reduce((sum, position) =>
          sum + (Number(position.realizedPnl) || 0), 0);
        return {
          windowStart,
          windowEnd: windowStart + this.windowMs,
          positionCount: positions.length,
          netPnl,
          outcome: netPnl > EPSILON ? 'WIN' : netPnl < -EPSILON ? 'LOSS' : 'BREAK_EVEN',
        };
      })
      .sort((a, b) => a.windowEnd - b.windowEnd);
    const wins = windows.filter((window) => window.outcome === 'WIN').length;
    const losses = windows.filter((window) => window.outcome === 'LOSS').length;
    const breakEven = windows.length - wins - losses;
    return {
      completed: windows.length,
      wins,
      losses,
      breakEven,
      winRate: windows.length ? (wins / windows.length) * 100 : 0,
      windows,
    };
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const feed = this.priceFeed.snapshot?.() || {};
    const windowStart = this.getActiveWindowStart();
    const windowEnd = windowStart == null ? null : windowStart + this.windowMs;
    const currentOpen = this.positions.filter((position) =>
      position.status === 'OPEN' && Number(position.windowStart) === Number(windowStart));
    const positionsBySide = Object.fromEntries(SIDES.map((side) => [
      side,
      currentOpen.find((position) => position.side === side) || null,
    ]));
    const pendingResolutionPositions = this.positions.filter((position) =>
      position.status === 'PENDING_RESOLUTION');
    const flow = {
      status: 'PRICE_ONLY',
      reason: 'Pressure scores are not used by this strategy.',
      ready: false,
      evaluatedAt: now,
      candidateSide: null,
      confirmedSide: null,
      confirmationCount: 0,
      requiredConfirmations: 0,
    };
    const totalInventory = Object.fromEntries(SIDES.map((side) => [
      side,
      this.totalInventoryForSide(side),
    ]));
    const strategyOrders = this.orders.filter((order) =>
      order.strategyId === this.strategyId);
    const activeOrders = strategyOrders.filter((order) =>
      Number(order.windowStart) === Number(windowStart)
      && ['FILLED', 'PARTIALLY_FILLED', 'RESTING'].includes(order.status));
    const completedWindowStats = this.completedWindowStats(now);
    const accountState = { ...(state.account || {}) };
    let markedValue = 0;
    let unrealizedPnl = 0;
    let unpricedOpenPositions = 0;
    for (const position of this.positions) {
      if (position.status === 'PENDING_RESOLUTION') {
        position.markValue = null;
        position.unrealizedPnl = null;
        position.markStatus = 'PENDING_RESOLUTION';
        unpricedOpenPositions += 1;
        continue;
      }
      if (position.status !== 'OPEN') continue;

      const quote = this.getFreshQuote(position.side, now);
      const markPrice = Number(quote?.bestBid);
      const updatedAt = Number(quote?.updatedAt);
      const hasFreshMark = Number.isFinite(markPrice)
        && markPrice >= 0
        && markPrice <= 1
        && Number.isFinite(updatedAt)
        && updatedAt <= now
        && now - updatedAt <= config.MAX_DATA_AGE_MS;
      if (!hasFreshMark) {
        position.markValue = null;
        position.unrealizedPnl = null;
        position.markStatus = 'UNAVAILABLE';
        unpricedOpenPositions += 1;
        continue;
      }

      const shares = Number(position.shares) || 0;
      const positionMark = markPrice * shares;
      position.markBid = markPrice;
      position.markPrice = markPrice;
      position.markUpdatedAt = updatedAt;
      position.markAgeMs = Math.max(0, now - updatedAt);
      position.markValue = positionMark;
      position.markStatus = 'LIVE';
      position.unrealizedPnl = positionMark
        - (Number(position.totalCost) || 0)
        - (Number(position.fees) || 0)
        + (Number(position.estimatedMakerRebate) || 0);
      markedValue += positionMark;
      unrealizedPnl += position.unrealizedPnl;
    }
    accountState.markedValue = markedValue;
    accountState.unrealizedPnl = unrealizedPnl;
    accountState.unpricedOpenPositions = unpricedOpenPositions;
    accountState.equity = (Number(accountState.cash) || 0) + markedValue;

    const globalEquityCurve = [...(accountState.equityCurve || [])];
    if (Number.isFinite(Number(accountState.equity))) {
      const lastPoint = globalEquityCurve.at(-1);
      if (!lastPoint || Number(lastPoint.ts) !== now) {
        globalEquityCurve.push({ ts: now, equity: Number(accountState.equity), live: true });
      } else {
        lastPoint.equity = Number(accountState.equity);
        lastPoint.live = true;
      }
    }
    const model = {
      ready: flow.ready,
      reason: flow.reason,
      currentPrice: Number.isFinite(Number(feed.price)) ? Number(feed.price) : null,
      windowOpenPrice: Number(feed.currentCandle?.open) || null,
      secondsRemaining: windowEnd == null ? null : Math.max(0, (windowEnd - now) / 1000),
      volatility5m: null,
      volatilityCandles: [],
      probabilityUp: null,
      probabilityDown: null,
      feedStatus: feed.status || 'WAITING',
      historyStatus: feed.historyStatus || 'NOT_USED',
      tickAt: feed.tickAt ?? null,
      tickAgeMs: feed.tickAt == null ? null : Math.max(0, now - Number(feed.tickAt)),
    };

    return {
      ...state,
      now,
      strategy: {
        id: this.strategyId,
        name: this.strategyName,
        version: 'btc-5m-dual-020-resting-limit-midpoint-010-reversal-v13',
        execution: 'PAPER ONLY',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        signalSource: 'Polymarket CLOB best ask and UP/DOWN midpoint only.',
        entrySharesPerSignal: config.PRICE_LIMIT_SHARES,
        entryPriceSource: 'RESTING_LIMIT_AT_FIXED_PRICE',
        entryPriceFilter: `BEST_ASK_AT_OR_BELOW_${config.PRICE_LIMIT_ENTRY.toFixed(2)}`,
        entrySlippageCeiling: null,
        maxInventoryPerSide: null,
        maxTotalInventoryShares: null,
        maxActiveSidesPerWindow: 2,
        activeSide: currentOpen.length > 1 ? 'BOTH' : currentOpen[0]?.side || null,
        activeSides: SIDES.filter((side) => positionsBySide[side]),
        orderType: `${LIMIT_ORDER_TYPE} + ${ORDER_TYPE}`,
        usesTakerOrders: true,
        usesMakerOrders: true,
        accumulatesInventory: true,
        entries: {
          orderType: LIMIT_ORDER_TYPE,
          sharesPerSide: config.PRICE_LIMIT_SHARES,
          limitPrice: config.PRICE_LIMIT_ENTRY,
          sideMapping: 'REST_BOTH_UP_AND_DOWN_LIMIT_BUYS',
          execution: 'Place a resting limit buy for 100 shares at $0.20 on both sides immediately after the window opens.',
          fillRule: 'A fresh best ask at or below $0.20 confirms all 100 shares filled at the best ask, capped at the $0.20 limit.',
          priceFilter: `BEST_ASK_AT_OR_BELOW_${config.PRICE_LIMIT_ENTRY.toFixed(2)}`,
          timeInForce: 'UNTIL_FIRST_FILL_OR_WINDOW_END',
          partialFillsAllowed: false,
          cancelOtherSideOnFill: true,
          cancelUnfilledAtWindowEnd: true,
          limitEntryFees: 'No taker fee is modeled for the resting limit fill; maker rebate is not estimated.',
          reversalOrderType: ORDER_TYPE,
          reversalTrigger: `FILLED_SIDE_MIDPOINT_AT_OR_BELOW_${config.PRICE_REVERSAL_TRIGGER_MID.toFixed(2)}`,
          reversalShares: config.PRICE_REVERSAL_SHARES,
          reversalExecution: 'Immediately sweep visible asks on the opposite side; partial fills are allowed and the unfilled remainder is cancelled.',
          reversalOncePerWindow: true,
          inventoryLimit: 'Available paper cash; an entry is not recorded if its full 100-share limit fill cannot be funded.',
        },
        exit: {
          orderType: 'POLYMARKET_RESOLUTION_ONLY',
          trigger: 'No early sells. There is no take-profit or stop-loss exit.',
          fills: 'Every filled position stays open for the full window and then waits for official resolution of its original market.',
          fees: 'Resting limit entries have no modeled taker fee; the 200-share reversal market buy has modeled taker fees.',
          takeProfit: null,
          stopLoss: null,
          oppositeSignal: 'A filled-side midpoint at or below $0.10 triggers one opposite-side market buy for 200 shares; no shares are sold.',
          windowEnd: 'At window end, open shares move to pending resolution and settle only from the official result of their original market.',
        },
        timing: 'Place both $0.20 resting limit orders at window open, monitor best asks and the filled side midpoint continuously, and cancel the opposite resting order on the first confirmed fill.',
        sizing: `${config.PRICE_LIMIT_SHARES} shares per resting side; one ${config.PRICE_REVERSAL_SHARES}-share opposite-side taker buy when the filled side midpoint reaches $${config.PRICE_REVERSAL_TRIGGER_MID.toFixed(2)} or lower.`,
        trigger: `Rest 100 UP and 100 DOWN limit buys at $${config.PRICE_LIMIT_ENTRY.toFixed(2)}. A best ask at or below that price fills one side; the filled side midpoint at or below $${config.PRICE_REVERSAL_TRIGGER_MID.toFixed(2)} triggers the opposite-side buy.`,
        currentSignal: this.signal,
        priceState: this.priceStrategyState,
      },
      model,
      binance: {
        ...feed,
        tickAgeMs: model.tickAgeMs,
        price: model.currentPrice,
      },
      pressure: flow,
      signal: this.signal,
      account: {
        ...accountState,
        equityCurve: globalEquityCurve,
        completedWindowCount: completedWindowStats.completed,
        completedWindowWins: completedWindowStats.wins,
        completedWindowLosses: completedWindowStats.losses,
        completedWindowBreakEven: completedWindowStats.breakEven,
        completedWindowWinRate: completedWindowStats.winRate,
      },
      completedWindowStats,
      statusReason: this.flowState?.reason || flow.reason || state.statusReason,
      websocket: {
        ...this.websocket,
        detail: 'Polymarket CLOB UP/DOWN prices control all entries; Binance data is not used by this strategy.',
      },
      quotes: {
        ...state.livePrices,
        UP: { ...state.livePrices?.UP, ...this.liveQuotes.UP },
        DOWN: { ...state.livePrices?.DOWN, ...this.liveQuotes.DOWN },
      },
      positionsBySide,
      openWindowPositions: currentOpen,
      pendingResolutionPositions,
      inventory: {
        ...state.inventory,
        UP: {
          ...state.inventory?.UP,
          shares: Number(state.inventory?.UP?.shares) || 0,
          outstandingShares: totalInventory.UP,
        },
        DOWN: {
          ...state.inventory?.DOWN,
          shares: Number(state.inventory?.DOWN?.shares) || 0,
          outstandingShares: totalInventory.DOWN,
        },
        totalOutstandingShares: totalInventory.UP + totalInventory.DOWN,
      },
      flowState: { ...this.flowState },
      priceStrategyState: { ...this.priceStrategyState },
      entryOrders: strategyOrders.filter((order) =>
        order.orderType === LIMIT_ORDER_TYPE
        && Number(order.windowStart) === Number(windowStart)),
      flowStats: {
        ordersPlaced: strategyOrders.length,
        buys: strategyOrders.filter((order) => order.action === 'BUY').length,
        sells: strategyOrders.filter((order) => order.action === 'SELL').length,
        activeWindowOrders: activeOrders.length,
        pendingMakerBuys: activeOrders.filter((order) =>
          order.action === 'BUY' && order.orderType === LIMIT_ORDER_TYPE && order.status === 'RESTING').length,
        inventoryBySide: totalInventory,
      },
      window: windowStart == null ? null : {
        ...state.window,
        start: windowStart,
        end: windowEnd,
        secondsRemaining: Math.max(0, (windowEnd - now) / 1000),
      },
    };
  }
}

OrderFlowBot._test = {
  orderBookPressure,
  clamp,
};

module.exports = OrderFlowBot;
