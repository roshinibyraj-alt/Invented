'use strict';

const MispricingBot = require('./mispricing-bot');
const WickBot = require('./wick-bot');
const config = require('./config');
const { feeContext, takerFeeFor } = WickBot._test;

const EPSILON = 1e-8;
const SIDES = ['UP', 'DOWN'];
const ORDER_TYPE = 'PAPER_MARKET_BUY';

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
    this.strategyId = 'btc-5m-combined-orderflow-accumulation';
    this.strategyName = 'BTC 5-minute independent-side order-flow paper strategy';
    this.rules = {
      sharesPerSide: config.FLOW_ENTRY_SHARES,
      entryShares: config.FLOW_ENTRY_SHARES,
    };
    this.strategyWindowStart = null;
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
    this.clobTrades = { UP: [], DOWN: [] };
    this.seenClobTrades.clear();
    this.lastEvaluationAt = null;
    this.pendingSide = null;
    this.confirmationCount = 0;
    this.confirmedSide = null;
    this.pressure = {
      status: 'SCANNING',
      reason: 'Collecting live order flow for the new BTC window.',
      combinedScore: null,
      candidateSide: null,
      confirmedSide: null,
      confirmationCount: 0,
      requiredConfirmations: config.FLOW_CONFIRMATION_COUNT,
    };
    this.signal = { side: null, action: 'WAIT', reason: this.pressure.reason };
    this.flowState = { status: 'SCANNING', reason: this.pressure.reason };
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
      this.signal = { side: null, action: 'WAIT', reason: this.flowState.reason };
      return false;
    }
    if (this.strategyWindowStart !== windowStart) this.openStrategyWindow(windowStart, now);

    const nextPressure = this.buildPressureSnapshot(now);
    this.pressure = nextPressure;
    const evaluationDue = this.lastEvaluationAt == null
      || now - this.lastEvaluationAt >= config.FLOW_EVAL_INTERVAL_MS;
    let changed = false;
    if (!nextPressure.ready) {
      this.pendingSide = null;
      this.confirmationCount = 0;
      this.flowState = { status: 'WAITING_FOR_DATA', reason: nextPressure.reason };
    } else if (evaluationDue) {
      this.lastEvaluationAt = now;
      if (!nextPressure.candidateSide) {
        this.pendingSide = null;
        this.confirmationCount = 0;
        this.confirmedSide = null;
        this.flowState = { status: 'NEUTRAL', reason: nextPressure.reason };
      } else {
        const side = nextPressure.candidateSide;
        if (this.pendingSide === side) this.confirmationCount += 1;
        else {
          this.pendingSide = side;
          this.confirmationCount = 1;
        }
        if (this.confirmationCount >= config.FLOW_CONFIRMATION_COUNT) {
          const newlyConfirmed = this.confirmedSide !== side;
          this.confirmedSide = side;
          this.flowState = {
            status: newlyConfirmed ? 'CONFIRMED' : 'ACTIVE',
            reason: newlyConfirmed
              ? `${side} pressure confirmed for ${this.confirmationCount} consecutive one-second checks.`
              : `${side} pressure remains confirmed.`,
          };
          if (newlyConfirmed) {
            changed = this.handleConfirmedSignal(side, now) || changed;
          }
        } else {
          this.flowState = {
            status: 'CONFIRMING',
            reason: `Confirming ${side}: ${this.confirmationCount}/${config.FLOW_CONFIRMATION_COUNT} one-second checks.`,
          };
        }
      }
    }

    this.pressure = {
      ...nextPressure,
      status: this.flowState.status,
      reason: this.flowState.reason,
      confirmedSide: this.confirmedSide,
      confirmationCount: this.confirmationCount,
      requiredConfirmations: config.FLOW_CONFIRMATION_COUNT,
    };
    if (!this.confirmedSide || nextPressure.status === 'NEUTRAL') {
      this.signal = {
        side: null,
        action: 'WAIT',
        reason: this.flowState.reason,
        combinedScore: nextPressure.combinedScore,
      };
    }
    return changed;
  }

  handleConfirmedSignal(signalSide, now) {
    const buySide = signalSide === 'UP' ? 'DOWN' : 'UP';
    const windowStart = Number(this.getActiveWindowStart());
    const heldOtherSideShares = this.positions
      .filter((position) => position.status === 'OPEN'
        && Number(position.windowStart) === windowStart
        && position.side === signalSide
        && Number(position.shares) > EPSILON)
      .reduce((total, position) => total + Number(position.shares), 0);

    const submitted = this.submitMarketBuy(
      buySide,
      now,
      this.pressure,
      signalSide,
      config.FLOW_ENTRY_SHARES,
    );
    const filledShares = Number(submitted.filledShares) || 0;
    const averagePrice = Number.isFinite(Number(submitted.averagePrice))
      ? Number(submitted.averagePrice)
      : null;
    const bestAskAtSubmission = Number.isFinite(Number(submitted.bestAskAtSubmission))
      ? Number(submitted.bestAskAtSubmission)
      : null;
    const entryReason = submitted.orderId
      ? filledShares > 0
        ? `${signalSide} signal bought ${filledShares} ${buySide} shares at an average $${averagePrice.toFixed(3)}; taker fee $${Number(submitted.fees || 0).toFixed(3)}.`
        : `${signalSide} signal tried to buy ${buySide}, but no shares filled: ${submitted.reason || 'no visible ask liquidity'}.`
      : `${signalSide} signal tried to buy ${buySide}, but the order was not placed: ${submitted.reason || 'no fresh ask available'}.`;
    this.signal = {
      side: buySide,
      signalSide,
      buySide,
      action: buySide === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
      reason: `${entryReason} Existing shares on either side are held until official resolution; no early sells.`,
      combinedScore: this.pressure.combinedScore,
      binanceScore: this.pressure.binance?.score,
      polymarketScore: this.pressure.polymarket?.score,
      buyFilledShares: filledShares,
      buyUnfilledShares: Number(submitted.unfilledShares) || 0,
      averagePrice,
      bestAskAtSubmission,
      fees: Number(submitted.fees) || 0,
      estimatedMakerRebate: Number(submitted.estimatedMakerRebate) || 0,
      orderId: submitted.orderId || null,
      orderStatus: submitted.status || 'NOT_PLACED',
      oppositeExitStatus: 'DISABLED_HOLD_TO_RESOLUTION',
      oppositeSharesSold: 0,
      heldOtherSideShares,
    };
    return filledShares > 0;
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
    const flow = this.pressure?.evaluatedAt === now
      ? this.pressure
      : this.buildPressureSnapshot(now);
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
        version: 'btc-5m-reversed-pressure-resolution-only-v12',
        execution: 'PAPER ONLY',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        signalSource: 'Binance aggressor trade flow + Polymarket order-book imbalance, microprice, and trade flow.',
        lookbackMs: config.FLOW_WINDOW_MS,
        evaluationIntervalMs: config.FLOW_EVAL_INTERVAL_MS,
        confirmationsRequired: config.FLOW_CONFIRMATION_COUNT,
        combinedSignalThreshold: config.FLOW_SIGNAL_THRESHOLD,
        componentMinimum: config.FLOW_COMPONENT_MIN,
        entrySharesPerSignal: config.FLOW_ENTRY_SHARES,
        entryPriceSource: 'VISIBLE_ASK_MARKET_SWEEP',
        entryPriceFilter: 'NONE',
        entrySlippageCeiling: null,
        maxInventoryPerSide: null,
        maxTotalInventoryShares: null,
        maxActiveSidesPerWindow: 2,
        activeSide: currentOpen.length > 1 ? 'BOTH' : currentOpen[0]?.side || null,
        activeSides: SIDES.filter((side) => positionsBySide[side]),
        orderType: ORDER_TYPE,
        usesTakerOrders: true,
        usesMakerOrders: false,
        accumulatesInventory: true,
        entries: {
          orderType: ORDER_TYPE,
          sharesPerSignal: config.FLOW_ENTRY_SHARES,
          sideMapping: 'BUY_OPPOSITE_OF_PRESSURE_SIGNAL',
          execution: 'Sweep all valid visible asks immediately from best to worse; no entry price floor or ceiling.',
          priceFilter: null,
          slippageCeiling: null,
          timeInForce: 'FAK',
          partialFillsAllowed: true,
          unfilledRemainder: 'Cancelled immediately after the visible ask sweep.',
          oneEntryPerConfirmedSignalEpisode: true,
          sameSideSignalAction: 'ADD_100_SHARES_TO_OPPOSITE_OF_PRESSURE_SIGNAL_ON_EACH_NEWLY_CONFIRMED_EPISODE',
          maxActiveSidesPerWindow: 2,
          oppositeSignalAction: 'BUY_OPPOSITE_OF_PRESSURE_SIGNAL; KEEP_ALL_EXISTING_SHARES_UNTIL_OFFICIAL_RESOLUTION',
          oppositeSignalSellOrderType: null,
          oppositeSignalProfitabilityRule: 'Opposite signals never sell. Existing shares remain open until official resolution of their original market.',
          cancelUnfilledOnNextSignal: false,
          cancelUnfilledAtWindowEnd: false,
          paperFillRule: 'Immediately sweep all valid visible asks for up to 100 shares with no entry price floor or ceiling; partial fills are allowed and any remainder is cancelled. Model taker fees on each fill level.',
          inventoryLimit: 'Available paper cash only; order quantities are reduced to affordable visible liquidity.',
        },
        exit: {
          orderType: 'POLYMARKET_RESOLUTION_ONLY',
          trigger: 'No early sells. There is no take-profit, stop-loss, or opposite-signal exit.',
          fills: 'Every filled position stays open for the full window and then waits for official resolution of its original market.',
          fees: 'Only entry taker fees are modeled. No sell order or sell fee is created.',
          takeProfit: null,
          stopLoss: null,
          oppositeSignal: 'Opposite signals add a new reversed-side buy; they never sell existing shares.',
          windowEnd: 'At window end, open shares move to pending resolution and settle only from the official result of their original market.',
        },
        timing: 'Recalculate flow every second using the preceding five seconds of Binance and Polymarket data; immediately sweep visible asks on the opposite side for every newly confirmed UP or DOWN signal. Never sell before official resolution.',
        sizing: `${config.FLOW_ENTRY_SHARES} shares per newly confirmed pressure-signal episode, bought on the opposite outcome side. UP and DOWN positions may both stay open in one window.`,
        trigger: `Require Binance and Polymarket directional pressure to agree, each component to exceed ${config.FLOW_COMPONENT_MIN.toFixed(2)}, and combined pressure to reach ±${config.FLOW_SIGNAL_THRESHOLD.toFixed(2)} for ${config.FLOW_CONFIRMATION_COUNT} consecutive checks. No entry price floor or ceiling applies.`,
        currentSignal: this.signal,
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
        detail: 'Binance aggregate trades and Polymarket UP/DOWN CLOB books/trades are combined for paper signals.',
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
      flowStats: {
        ordersPlaced: strategyOrders.length,
        buys: strategyOrders.filter((order) => order.action === 'BUY').length,
        sells: strategyOrders.filter((order) => order.action === 'SELL').length,
        activeWindowOrders: activeOrders.length,
        pendingMakerBuys: activeOrders.filter((order) =>
          order.action === 'BUY' && order.orderType === ORDER_TYPE && order.status === 'RESTING').length,
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
