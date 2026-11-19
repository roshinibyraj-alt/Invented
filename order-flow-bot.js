'use strict';

const MispricingBot = require('./mispricing-bot');
const WickBot = require('./wick-bot');
const config = require('./config');
const { feeContext, makerRebateFor, takerFeeFor } = WickBot._test;

const EPSILON = 1e-8;
const SIDES = ['UP', 'DOWN'];
const ORDER_TYPE = 'PAPER_MARKET_BUY';
const MIN_ENTRY_ASK = 0.05;

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

  handleConfirmedSignal(signalSide, now) {
    const buySide = signalSide;
    const oppositeSide = signalSide === 'UP' ? 'DOWN' : 'UP';

    const windowStart = Number(this.getActiveWindowStart());
    const positionsToExit = this.positions.filter((position) =>
      position.status === 'OPEN'
      && Number(position.windowStart) === windowStart
      && position.side === oppositeSide
      && Number(position.shares) > EPSILON);
    const sharesToExit = positionsToExit.reduce((total, position) =>
      total + Number(position.shares), 0);
    let oppositeExitStatus = 'NO_OPPOSITE_POSITION';
    let oppositeExitReason = '';
    let oppositeExitPnl = null;
    let oppositeExitBid = null;
    let oppositeSharesSold = 0;

    if (positionsToExit.length) {
      const quote = this.flowQuote(oppositeSide, now);
      const bestBid = Number(quote?.bestBid);
      if (!quote || !Number.isFinite(bestBid) || !(bestBid > 0 && bestBid < 1)) {
        oppositeExitStatus = 'HELD_NO_FRESH_BID';
        oppositeExitReason = `The ${oppositeSide} position was held because no fresh best bid was available for its profit check.`;
        this.log('PAPER_FLOW_OPPOSITE_SIGNAL_WAITING_FOR_BID', {
          signalSide,
          oppositeSide,
          requestedShares: sharesToExit,
        });
      } else {
        oppositeExitBid = bestBid;
        const sellFeeEstimate = positionsToExit.reduce((total, position) =>
          total + takerFeeFor(this.market || {}, bestBid, Number(position.shares) || 0), 0);
        oppositeExitPnl = positionsToExit.reduce((total, position) => {
          const shares = Number(position.shares) || 0;
          const grossProceeds = shares * bestBid;
          const sellFee = takerFeeFor(this.market || {}, bestBid, shares);
          const cost = Number(position.totalCost) || 0;
          const entryFees = Number(position.fees) || 0;
          const entryRebate = Number(position.estimatedMakerRebate) || 0;
          return total + grossProceeds - sellFee - cost - entryFees + entryRebate;
        }, 0);
        if (oppositeExitPnl > EPSILON) {
          for (const position of positionsToExit) {
            if (this.closePositionOnOppositeSignal(position, now, bestBid, signalSide)) {
              oppositeSharesSold += Number(position.initialShares || position.shares) || 0;
            }
          }
          if (oppositeSharesSold > EPSILON) {
            oppositeExitStatus = 'SOLD_PROFITABLE_OPPOSITE';
            oppositeExitReason = `Sold ${oppositeSharesSold} ${oppositeSide} shares at $${bestBid.toFixed(3)} for estimated net profit of $${oppositeExitPnl.toFixed(2)}.`;
          } else {
            oppositeExitStatus = 'HELD_SELL_NOT_COMPLETED';
            oppositeExitReason = `The ${oppositeSide} position stayed open because its sell did not complete.`;
          }
        } else {
          oppositeExitStatus = 'HELD_NOT_PROFITABLE';
          oppositeExitReason = `Held ${sharesToExit} ${oppositeSide} shares; selling at $${bestBid.toFixed(3)} would not produce a net profit after estimated fees (projected $${oppositeExitPnl.toFixed(2)}).`;
          this.log('PAPER_FLOW_OPPOSITE_SIGNAL_BLOCKED_UNPROFITABLE', {
          signalSide,
          currentSide: oppositeSide,
          shares: sharesToExit,
          bestBid,
          estimatedSellFee: sellFeeEstimate,
            projectedNetPnl: oppositeExitPnl,
          });
        }
      }
    }

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
      action: submitted.status === 'BLOCKED_PRICE_FLOOR'
        ? 'BUY_BLOCKED_PRICE_FLOOR'
        : buySide === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
      reason: [entryReason, oppositeExitReason].filter(Boolean).join(' '),
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
      oppositeExitStatus,
      oppositeSharesSold,
      oppositeExitPnl,
      currentPositionNetPnl: oppositeExitPnl,
      oppositeExitBid,
    };
    return filledShares > 0 || oppositeSharesSold > EPSILON;
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
    if (bestAsk < MIN_ENTRY_ASK) {
      const reason = `Best ask $${bestAsk.toFixed(3)} is below the $${MIN_ENTRY_ASK.toFixed(2)} minimum; buy skipped.`;
      this.log('PAPER_FLOW_BUY_BLOCKED_PRICE_FLOOR', {
        signalSide,
        side,
        bestAskAtSubmission: bestAsk,
        minimumAsk: MIN_ENTRY_ASK,
      });
      this.events.unshift({
        ts: now,
        at: now,
        event: 'PAPER_BUY_BLOCKED_PRICE_FLOOR',
        type: 'PAPER_BUY_BLOCKED_PRICE_FLOOR',
        message: `${signalSide || side} signal skipped: ${reason}`,
        details: { signalSide, side, bestAskAtSubmission: bestAsk, minimumAsk: MIN_ENTRY_ASK },
      });
      if (this.events.length > 200) this.events.length = 200;
      return {
        filledShares: 0,
        unfilledShares: requestedShares,
        bestAskAtSubmission: bestAsk,
        fees: 0,
        estimatedMakerRebate: 0,
        status: 'BLOCKED_PRICE_FLOOR',
        reason,
      };
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
      fillRule: 'SWEEP_VISIBLE_ASKS_UP_TO_REQUESTED_SHARES; PARTIAL_FILL_ALLOWED; CANCEL_UNFILLED_REMAINDER; MODELED_TAKER_FEES; NEVER_BUY_BELOW_0_05',
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
      if (!(price >= MIN_ENTRY_ASK && price < 1 && availableSize > 0)) continue;

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
      position.takeProfitPrice = config.FLOW_TAKE_PROFIT_TRIGGER;
      position.stopLossPrice = config.FLOW_STOP_LOSS_TRIGGER;
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
      this.createTakeProfitOrder(position, now);
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

  closePositionOnOppositeSignal(position, now, bestBid, signalSide) {
    const shares = Number(position.shares);
    const exitPrice = Number(bestBid);
    if (!(shares > EPSILON) || position.status !== 'OPEN'
      || !(exitPrice > 0 && exitPrice < 1)) return false;

    const gross = shares * exitPrice;
    const sellFee = takerFeeFor(this.market || {}, exitPrice, shares);
    const entryCost = Number(position.totalCost) || 0;
    const entryFees = Number(position.fees) || 0;
    const entryRebate = Number(position.estimatedMakerRebate) || 0;
    const exitOrder = {
      id: `${position.id}-opposite-signal-exit-${now}`,
      strategyId: this.strategyId,
      positionId: position.id,
      action: 'SELL',
      side: position.side,
      orderType: 'PAPER_MARKET_OPPOSITE_SIGNAL_EXIT',
      status: 'FILLED',
      requestedShares: shares,
      filledShares: shares,
      remainingShares: 0,
      averagePrice: exitPrice,
      grossProceeds: gross,
      fees: sellFee,
      sellFee,
      estimatedMakerRebate: 0,
      exitReason: 'OPPOSITE_SIGNAL_PROFIT_EXIT',
      triggerBestBid: exitPrice,
      signalSide,
      createdAt: now,
      filledAt: now,
      windowStart: position.windowStart,
      paperOnly: true,
      fills: [{ price: exitPrice, shares }],
    };

    if (position.takeProfitOrder?.status === 'RESTING') {
      position.takeProfitOrder.status = 'CANCELLED_OPPOSITE_SIGNAL_EXIT';
      position.takeProfitOrder.cancelledAt = now;
      position.takeProfitOrder.remainingShares = 0;
    }
    this.orders.unshift(exitOrder);
    this.windowOrders.unshift(exitOrder);

    position.exitReason = 'OPPOSITE_SIGNAL_PROFIT_EXIT';
    position.exitType = 'PAPER_MARKET_OPPOSITE_SIGNAL_EXIT';
    position.exitPrice = exitPrice;
    position.exitBid = exitPrice;
    position.exitProceeds = gross;
    position.takeProfitProceeds = 0;
    position.exitFees = sellFee;
    position.realizedCostBasis = entryCost;
    position.realizedEntryFees = entryFees;
    position.proceeds = gross - sellFee + entryRebate;
    position.realizedPnl = position.proceeds - entryCost - entryFees;
    position.exitFills = [{ price: exitPrice, shares, at: now }];
    position.status = 'SETTLED_EXIT';
    position.settlementStatus = 'OPPOSITE_SIGNAL_PROFIT_EXIT_FILLED';
    position.closedAt = now;
    position.settledAt = now;
    position.settlementBasis = 'PAPER_OPPOSITE_SIGNAL_EXIT';
    position.shares = 0;
    position.totalCost = 0;
    position.fees = 0;
    position.markPrice = exitPrice;
    position.markValue = 0;
    position.markStatus = 'CLOSED';
    position.unrealizedPnl = 0;
    position.outcome = position.realizedPnl > EPSILON ? 'WIN'
      : position.realizedPnl < -EPSILON ? 'LOSS' : 'BREAK_EVEN';
    this.cash += gross - sellFee;
    this.totalOrderAttempts += 1;
    this.recordStrategyOutcome(position, position.outcome, now, 'OPPOSITE_SIGNAL_PROFIT_EXIT');

    this.log('PAPER_FLOW_OPPOSITE_SIGNAL_PROFIT_EXIT_FILLED', {
      orderId: exitOrder.id,
      positionId: position.id,
      oldSide: position.side,
      signalSide,
      shares,
      exitPrice,
      grossProceeds: gross,
      sellFee,
      estimatedEntryMakerRebate: entryRebate,
      realizedPnl: position.realizedPnl,
    });
    this.events.unshift({
      ts: now,
      at: now,
      event: 'PAPER_OPPOSITE_SIGNAL_PROFIT_EXIT',
      type: 'PAPER_OPPOSITE_SIGNAL_PROFIT_EXIT',
      message: `${shares} ${position.side} shares sold at the $${exitPrice.toFixed(3)} best bid after a profitable ${signalSide} signal; modeled taker fee $${sellFee.toFixed(3)}. The ${signalSide} signal also places its own independent buy.`,
      details: {
        orderId: exitOrder.id,
        positionId: position.id,
        oldSide: position.side,
        signalSide,
        shares,
        exitPrice,
        grossProceeds: gross,
        sellFee,
        realizedPnl: position.realizedPnl,
      },
    });
    if (this.events.length > 200) this.events.length = 200;
    return true;
  }

  closePositionAtThreshold(position, now, { reason, triggerPrice, triggerBid, payoutPerShare }) {
    const shares = Number(position.shares);
    if (!(shares > EPSILON) || position.status !== 'OPEN') return false;
    const gross = shares * payoutPerShare;
    const exitRebate = reason === 'TAKE_PROFIT'
      ? makerRebateFor(this.market || {}, triggerPrice, shares).estimate
      : 0;
    const rebate = Number(position.estimatedMakerRebate || 0) + exitRebate;
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
    exitOrder.estimatedMakerRebate = exitRebate;
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
    position.estimatedExitMakerRebate = exitRebate;
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
    this.cash += gross + exitRebate;
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
      estimatedExitMakerRebate: exitRebate,
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
        estimatedExitMakerRebate: exitRebate,
      },
    });
    if (this.events.length > 200) this.events.length = 200;
    return true;
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
        version: 'btc-5m-independent-side-profit-exit-v9',
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
        minimumEntryAsk: MIN_ENTRY_ASK,
        entrySlippageCeiling: null,
        maxInventoryPerSide: null,
        maxTotalInventoryShares: null,
        maxActiveSidesPerWindow: 2,
        activeSide: currentOpen.length > 1 ? 'BOTH' : currentOpen[0]?.side || null,
        activeSides: SIDES.filter((side) => positionsBySide[side]),
        orderType: `${ORDER_TYPE} + PAPER_MARKET_OPPOSITE_SIGNAL_EXIT`,
        usesTakerOrders: true,
        usesMakerOrders: true,
        accumulatesInventory: true,
        entries: {
          orderType: ORDER_TYPE,
          sharesPerSignal: config.FLOW_ENTRY_SHARES,
          sideMapping: 'BUY_SIGNALLED_SIDE_INDEPENDENTLY',
          execution: 'Sweep visible asks immediately from best to worse.',
          minimumAsk: MIN_ENTRY_ASK,
          slippageCeiling: null,
          timeInForce: 'FAK',
          partialFillsAllowed: true,
          unfilledRemainder: 'Cancelled immediately after the visible ask sweep.',
          oneEntryPerConfirmedSignalEpisode: true,
          sameSideSignalAction: 'ADD_100_SHARES_ON_EACH_NEWLY_CONFIRMED_SIGNAL_EPISODE',
          maxActiveSidesPerWindow: 2,
          oppositeSignalAction: 'BUY_SIGNALLED_SIDE_INDEPENDENTLY; ALSO_SELL_ALL_OPPOSITE_SHARES_IF_NET_PROFITABLE_AFTER_TAKER_FEE',
          oppositeSignalSellOrderType: 'PAPER_MARKET_OPPOSITE_SIGNAL_EXIT',
          oppositeSignalProfitabilityRule: 'A signal always triggers its own side buy independently. If the opposite side has current-window shares, sell all of them only when liquidation at its fresh best bid is net-profitable after modeled sell fees and entry costs.',
          cancelUnfilledOnNextSignal: false,
          cancelUnfilledAtWindowEnd: false,
          paperFillRule: 'Immediately sweep current visible ask levels for up to 100 shares; partial fills are allowed, and any remainder is cancelled. Do not buy when the best ask is below $0.05. Model taker fees on each fill level.',
          inventoryLimit: 'Available paper cash only; order quantities are reduced to affordable visible liquidity.',
        },
        exit: {
          orderType: 'PAPER_MARKET_OPPOSITE_SIGNAL_EXIT + PAPER_LIMIT_TAKE_PROFIT_AND_STOP_LOSS',
          trigger: `A fresh ${config.FLOW_TAKE_PROFIT_TRIGGER.toFixed(2)} best bid is the final take-profit and closes that side at $${config.FLOW_TAKE_PROFIT_PAYOUT.toFixed(2)} per share; a fresh ${config.FLOW_STOP_LOSS_TRIGGER.toFixed(2)}-or-lower best bid closes it at $${config.FLOW_STOP_LOSS_PAYOUT.toFixed(2)} per share.`,
          fills: 'Each confirmed signal buys its own signalled side. On that trigger, the opposite side is also sold if its accumulated current-window shares can be exited for net profit after modeled fees. The buy is not blocked by a missing or unprofitable opposite-side sale. Final TP and stop-loss touches close only the affected side.',
          fees: 'Market entries and opposite-signal profit exits use modeled taker fees. Limit take-profits may earn an estimated maker rebate; threshold stop-loss exits have no modeled sell fee.',
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
          oppositeSignal: 'Each new confirmed UP or DOWN signal buys 100 shares of that signalled side, even if the other side also has an open position. During the trigger, sell all accumulated shares on the opposite side only when liquidation at the fresh best bid is net-profitable after modeled fees. If the opposite position is not profitable or has no fresh bid, keep it open and still submit the signalled-side buy.',
          windowEnd: 'Any unsold shares wait for official resolution of their original market.',
        },
        timing: 'Recalculate flow every second using the preceding five seconds of Binance and Polymarket data; immediately sweep visible asks on every newly confirmed UP or DOWN signal. Each signal buys its own side and independently checks whether the opposite side can be sold for net profit.',
        sizing: `${config.FLOW_ENTRY_SHARES} shares per newly confirmed signal episode on that signal's side. UP and DOWN positions may both stay open in one window.`,
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
