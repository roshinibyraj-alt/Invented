'use strict';

const MispricingBot = require('./mispricing-bot');
const WickBot = require('./wick-bot');
const config = require('./config');
const { sweepLevels } = MispricingBot._test;
const { feeContext, makerRebateFor } = WickBot._test;

const EPSILON = 1e-8;
const SIDES = ['UP', 'DOWN'];
const ORDER_TYPE = 'PAPER_MARKET_SWEEP';

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
    this.strategyName = 'BTC 5-minute combined order-flow accumulation paper strategy';
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
      if (agreement && combinedScore >= config.FLOW_SIGNAL_THRESHOLD) candidateSide = 'UP';
      if (agreement && combinedScore <= -config.FLOW_SIGNAL_THRESHOLD) candidateSide = 'DOWN';
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

    const thresholdExits = this.processThresholdExits(now);
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
    return changed || thresholdExits > 0;
  }

  handleConfirmedSignal(side, now) {
    const bought = this.submitBuy(side, now, this.pressure);
    this.signal = {
      side,
      action: side === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
      reason: `${side} pressure confirmed; submitted a ${config.FLOW_ENTRY_SHARES}-share paper buy. Existing UP and DOWN shares remain open unless their own TP or stop-loss triggers.`,
      combinedScore: this.pressure.combinedScore,
      binanceScore: this.pressure.binance?.score,
      polymarketScore: this.pressure.polymarket?.score,
      buyFilledShares: bought.filledShares || 0,
    };
    return bought.filledShares > 0;
  }

  processThresholdExits(now = this.now()) {
    const windowStart = this.getActiveWindowStart();
    let exitedPositions = 0;
    for (const position of this.positions) {
      if (position.status !== 'OPEN'
        || Number(position.windowStart) !== Number(windowStart)
        || !(Number(position.shares) > EPSILON)) continue;
      const quote = this.getFreshQuote(position.side, now);
      if (!quote || quote.bestBid == null) continue;
      const bestBid = Number(quote.bestBid);
      if (!Number.isFinite(bestBid)) continue;
      if (bestBid + EPSILON >= config.FLOW_TAKE_PROFIT_TRIGGER) {
        this.closePositionAtThreshold(position, now, {
          reason: 'TAKE_PROFIT',
          triggerPrice: config.FLOW_TAKE_PROFIT_TRIGGER,
          triggerBid: bestBid,
          payoutPerShare: config.FLOW_TAKE_PROFIT_PAYOUT,
        });
        exitedPositions += 1;
      } else if (bestBid <= config.FLOW_STOP_LOSS_TRIGGER + EPSILON) {
        this.closePositionAtThreshold(position, now, {
          reason: 'STOP_LOSS',
          triggerPrice: config.FLOW_STOP_LOSS_TRIGGER,
          triggerBid: bestBid,
          payoutPerShare: config.FLOW_STOP_LOSS_PAYOUT,
        });
        exitedPositions += 1;
      }
    }
    return exitedPositions;
  }

  paperSweep(side, action, requestedShares, now = this.now(), enforceCash = false) {
    const quote = this.flowQuote(side, now);
    const book = this.books?.[side];
    const isBuy = action === 'BUY';
    const levels = book?.[isBuy ? 'asks' : 'bids'];
    const quotedBest = Number(isBuy ? quote?.bestAsk : quote?.bestBid);
    if (!quote || !Array.isArray(levels) || !levels.length
      || !Number.isFinite(quotedBest)
      || Math.abs(Number(levels[0]?.price) - quotedBest) > EPSILON) return null;

    let targetShares = Number(requestedShares);
    let execution = null;
    for (let attempt = 0; attempt < 8 && targetShares > EPSILON; attempt += 1) {
      execution = sweepLevels(levels, targetShares, {
        side: action,
        market: this.market || {},
      });
      if (!(execution.filledShares > EPSILON)) return null;
      const totalCost = execution.gross + execution.fees;
      if (!enforceCash || totalCost <= this.cash + EPSILON) break;
      targetShares = Math.floor(targetShares * Math.max(0, this.cash / totalCost) * 100) / 100;
      execution = null;
    }
    if (!execution || !(execution.filledShares > EPSILON)) return null;
    const totalCost = execution.gross + execution.fees;
    if (enforceCash && totalCost > this.cash + EPSILON) return null;

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
    return {
      ...execution,
      totalCost: isBuy ? totalCost : null,
      netProceeds: isBuy ? null : execution.gross - execution.fees,
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

  submitBuy(side, now, signal) {
    const requestedShares = config.FLOW_ENTRY_SHARES;
    if (!(requestedShares > EPSILON)) return { filledShares: 0, reason: 'INVALID_ENTRY_SIZE' };
    const execution = this.paperSweep(side, 'BUY', requestedShares, now, true);
    if (!execution) {
      this.log('PAPER_FLOW_BUY_SKIPPED', {
        side,
        requestedShares,
        reason: 'NO_FRESH_ASK_DEPTH_OR_INSUFFICIENT_CASH',
      });
      return { filledShares: 0, reason: 'NO_FRESH_ASK_DEPTH_OR_INSUFFICIENT_CASH' };
    }

    const windowStart = this.getActiveWindowStart();
    const position = this.currentPosition(side, windowStart)
      || this.createPosition(side, windowStart, now);
    const shares = Number(execution.filledShares);
    position.shares += shares;
    position.initialShares += shares;
    position.totalCost += execution.gross;
    position.initialTotalCost += execution.gross;
    position.fees += execution.fees;
    position.initialFees += execution.fees;
    position.entryFees = position.initialFees;
    position.entryPrice = position.initialTotalCost / position.initialShares;
    position.avgEntry = position.entryPrice;
    position.filledAt = now;
    position.lastAddedAt = now;
    position.entryFills.push(...execution.fills.map((fill) => ({ ...fill, at: now })));
    position.takeProfitPrice = config.FLOW_TAKE_PROFIT_TRIGGER;
    position.stopLossPrice = config.FLOW_STOP_LOSS_TRIGGER;
    this.createTakeProfitOrder(position, now);
    position.entrySignals.push({
      at: now,
      side,
      shares,
      averagePrice: execution.averagePrice,
      combinedScore: signal?.combinedScore ?? null,
      binanceScore: signal?.binance?.score ?? null,
      polymarketScore: signal?.polymarket?.score ?? null,
    });
    this.cash -= execution.totalCost;

    const order = this.recordOrder({
      side,
      action: 'BUY',
      requestedShares,
      execution,
      now,
      positionId: position.id,
    });
    position.lastEntryOrderId = order.id;
    this.log('PAPER_FLOW_BUY_FILLED', {
      positionId: position.id,
      orderId: order.id,
      side,
      requestedShares,
      filledShares: shares,
      averagePrice: execution.averagePrice,
      totalCost: execution.totalCost,
      fees: execution.fees,
      positionShares: position.shares,
      combinedScore: signal?.combinedScore ?? null,
      takeProfitPrice: position.takeProfitPrice,
      stopLossPrice: position.stopLossPrice,
    });
    return { ...execution, orderId: order.id };
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
      exitFees: 0,
      realizedCostBasis: 0,
      realizedEntryFees: 0,
      openedAt: now,
      filledAt: now,
      markPrice: null,
      unrealizedPnl: null,
      estimatedMakerRebate: 0,
      makerRebateEstimate: 0,
      entryFills: [],
      entrySignals: [],
      exitFills: [],
      exitProceeds: 0,
      proceeds: 0,
      realizedPnl: null,
      takeProfitPrice: config.FLOW_TAKE_PROFIT_TRIGGER,
      stopLossPrice: config.FLOW_STOP_LOSS_TRIGGER,
      takeProfitOrderSequence: 0,
      feeContext: feeContext(this.market || {}),
      paperOnly: true,
    };
    this.positions.unshift(position);
    return position;
  }

  createTakeProfitOrder(position, now) {
    const previous = position.takeProfitOrder;
    const sequence = Number(position.takeProfitOrderSequence || 0) + 1;
    const order = {
      id: `${position.id}-take-profit-${sequence}`,
      strategyId: this.strategyId,
      positionId: position.id,
      action: 'SELL',
      side: position.side,
      orderType: 'PAPER_LIMIT_TAKE_PROFIT',
      status: 'RESTING',
      requestedShares: position.shares,
      filledShares: 0,
      remainingShares: position.shares,
      limitPrice: config.FLOW_TAKE_PROFIT_TRIGGER,
      createdAt: now,
      windowStart: position.windowStart,
      paperOnly: true,
      fillRule: 'FULL_POSITION_ON_FRESH_BEST_BID_AT_OR_ABOVE_0_99_COUNTS_AS_1_DOLLAR_PER_SHARE',
      sellFee: 0,
    };
    if (previous?.status === 'RESTING') {
      previous.status = 'CANCELLED_REPLACED';
      previous.cancelledAt = now;
      previous.replacedByOrderId = order.id;
      previous.remainingShares = 0;
    }
    position.takeProfitOrderSequence = sequence;
    position.takeProfitOrder = order;
    position.takeProfitOrderId = order.id;
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    return order;
  }

  closePositionAtThreshold(position, now, { reason, triggerPrice, triggerBid, payoutPerShare }) {
    const shares = Number(position.shares);
    if (!(shares > EPSILON) || position.status !== 'OPEN') return false;
    const gross = shares * payoutPerShare;
    const rebate = reason === 'TAKE_PROFIT'
      ? makerRebateFor(this.market || {}, triggerPrice, shares).estimate
      : 0;
    const exitOrder = reason === 'TAKE_PROFIT'
      ? position.takeProfitOrder
      : {
        id: `${position.id}-stop-loss`,
        strategyId: this.strategyId,
        positionId: position.id,
        action: 'SELL',
        side: position.side,
        orderType: 'PAPER_STOP_LOSS',
        createdAt: now,
        windowStart: position.windowStart,
        paperOnly: true,
      };
    if (!exitOrder) return false;

    if (reason === 'STOP_LOSS' && position.takeProfitOrder?.status === 'RESTING') {
      position.takeProfitOrder.status = 'CANCELLED_STOP_LOSS';
      position.takeProfitOrder.cancelledAt = now;
      position.takeProfitOrder.remainingShares = 0;
    }
    exitOrder.status = 'FILLED';
    exitOrder.requestedShares = shares;
    exitOrder.filledShares = shares;
    exitOrder.remainingShares = 0;
    exitOrder.averagePrice = payoutPerShare;
    exitOrder.grossProceeds = gross;
    exitOrder.fees = 0;
    exitOrder.sellFee = 0;
    exitOrder.estimatedMakerRebate = rebate;
    exitOrder.triggerPrice = triggerPrice;
    exitOrder.triggerBestBid = triggerBid;
    exitOrder.exitReason = reason;
    exitOrder.filledAt = now;
    exitOrder.fills = [{ price: payoutPerShare, shares }];
    if (reason === 'STOP_LOSS') {
      this.orders.unshift(exitOrder);
      this.windowOrders.unshift(exitOrder);
    }

    position.exitReason = reason;
    position.exitType = reason === 'TAKE_PROFIT' ? 'PAPER_LIMIT_TAKE_PROFIT' : 'PAPER_STOP_LOSS';
    position.exitPrice = payoutPerShare;
    position.exitBid = triggerBid;
    position.exitProceeds = gross;
    position.takeProfitProceeds = reason === 'TAKE_PROFIT' ? gross : 0;
    position.exitFees = 0;
    position.estimatedMakerRebate = rebate;
    position.proceeds = gross + rebate;
    position.realizedPnl = position.proceeds
      - Number(position.totalCost || 0)
      - Number(position.fees || 0);
    position.exitFills = [{ price: payoutPerShare, shares, at: now }];
    position.status = 'SETTLED_EXIT';
    position.settlementStatus = reason === 'TAKE_PROFIT' ? 'TAKE_PROFIT_FILLED' : 'STOP_LOSS_FILLED';
    position.closedAt = now;
    position.settledAt = now;
    position.settlementBasis = reason === 'TAKE_PROFIT' ? 'PAPER_TAKE_PROFIT' : 'PAPER_STOP_LOSS';
    position.shares = 0;
    position.totalCost = 0;
    position.fees = 0;
    position.markPrice = triggerBid;
    position.markValue = 0;
    position.markStatus = 'CLOSED';
    position.unrealizedPnl = 0;
    position.outcome = position.realizedPnl > 0 ? 'WIN'
      : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN';
    this.cash += gross + rebate;
    this.totalOrderAttempts += 1;
    this.recordStrategyOutcome(position, position.outcome, now, reason);
    this.log(`PAPER_FLOW_${reason}_FILLED`, {
      positionId: position.id,
      orderId: exitOrder.id,
      side: position.side,
      shares,
      triggerPrice,
      triggerBid,
      payoutPerShare,
      grossProceeds: gross,
      fees: 0,
      estimatedMakerRebate: rebate,
      realizedPnl: position.realizedPnl,
    });
    this.events.unshift({
      ts: now,
      at: now,
      event: `PAPER_${reason}_FILLED`,
      type: `PAPER_${reason}_FILLED`,
      message: reason === 'TAKE_PROFIT'
        ? `UP/DOWN $${triggerPrice.toFixed(2)} take-profit touched; ${shares} ${position.side} shares closed at $1.00 per share.`
        : `UP/DOWN $${triggerPrice.toFixed(2)} stop-loss touched; ${shares} ${position.side} shares closed at $0.00 per share.`,
      details: {
        positionId: position.id,
        orderId: exitOrder.id,
        side: position.side,
        shares,
        triggerPrice,
        triggerBid,
        payoutPerShare,
        realizedPnl: position.realizedPnl,
        estimatedMakerRebate: rebate,
      },
    });
    if (this.events.length > 200) this.events.length = 200;
    return true;
  }

  recordOrder({ side, action, requestedShares, execution, now, positionId, exitReason }) {
    const filledShares = Number(execution.filledShares) || 0;
    const order = {
      id: `${this.getActiveWindowStart()}-btc-${side.toLowerCase()}-${action.toLowerCase()}-flow-${++this.orderSequence}`,
      strategyId: this.strategyId,
      positionId,
      action,
      side,
      orderType: ORDER_TYPE,
      status: execution.complete ? 'FILLED' : 'PARTIALLY_FILLED',
      requestedShares,
      filledShares,
      remainingShares: 0,
      unfilledShares: Math.max(0, requestedShares - filledShares),
      averagePrice: execution.averagePrice,
      grossCost: action === 'BUY' ? execution.gross : 0,
      grossProceeds: action === 'SELL' ? execution.gross : 0,
      fees: execution.fees,
      fills: execution.fills.map((fill) => ({ ...fill })),
      createdAt: now,
      filledAt: now,
      windowStart: this.getActiveWindowStart(),
      paperOnly: true,
      immediateOrCancel: true,
      exitReason: exitReason || null,
    };
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.totalOrderAttempts += 1;
    return order;
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
        version: 'btc-5m-combined-orderflow-accumulation-v1',
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
        maxInventoryPerSide: null,
        maxTotalInventoryShares: null,
        orderType: ORDER_TYPE,
        usesTakerOrders: true,
        accumulatesInventory: true,
        entries: {
          orderType: ORDER_TYPE,
          sharesPerSignal: config.FLOW_ENTRY_SHARES,
          oneEntryPerConfirmedSignalEpisode: true,
          inventoryLimit: 'Available paper cash and visible ask depth only.',
        },
        exit: {
          orderType: 'PAPER_LIMIT_TAKE_PROFIT_AND_STOP_LOSS',
          trigger: `A fresh ${config.FLOW_TAKE_PROFIT_TRIGGER.toFixed(2)} best bid closes all accumulated shares at $${config.FLOW_TAKE_PROFIT_PAYOUT.toFixed(2)} each; a fresh ${config.FLOW_STOP_LOSS_TRIGGER.toFixed(2)}-or-lower best bid closes them at $${config.FLOW_STOP_LOSS_PAYOUT.toFixed(2)} each.`,
          fills: 'Threshold touches close the full side position in the paper ledger; no opposite-signal sale.',
          fees: 'Entry taker fees are modeled; terminal threshold exits have no modeled sell fee.',
          takeProfit: {
            triggerPrice: config.FLOW_TAKE_PROFIT_TRIGGER,
            payoutPerShare: config.FLOW_TAKE_PROFIT_PAYOUT,
            orderType: 'PAPER_LIMIT_TAKE_PROFIT',
          },
          stopLoss: {
            triggerPrice: config.FLOW_STOP_LOSS_TRIGGER,
            payoutPerShare: config.FLOW_STOP_LOSS_PAYOUT,
            orderType: 'PAPER_STOP_LOSS',
          },
          oppositeSignal: 'Buy the signalled side and keep existing shares open.',
          windowEnd: 'Any unsold shares wait for official resolution of their original market.',
        },
        timing: 'Recalculate flow every second using the preceding five seconds of Binance and Polymarket data.',
        sizing: `${config.FLOW_ENTRY_SHARES} shares requested per new confirmed signal; UP and DOWN accumulate independently without a per-side share cap.`,
        trigger: `Require Binance and Polymarket directional pressure to agree, each component to exceed ${config.FLOW_COMPONENT_MIN.toFixed(2)}, and combined pressure to reach ±${config.FLOW_SIGNAL_THRESHOLD.toFixed(2)} for ${config.FLOW_CONFIRMATION_COUNT} consecutive checks.`,
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
