'use strict';

const cfg = require('./config');
const WickBot = require('./wick-bot');
const marketData = require('./wick-market-data');
const { quoteFromBook, takerFeeFor, feeContext } = WickBot._test;

const ENTRY_WAIT_MS = 60 * 1000;
const ENTRY_CUTOFF_MS = cfg.WINDOW_MS_5M;
const ENTRY_TRIGGERS = Object.freeze([
  Object.freeze({ id: 'btc-080-eth-060-100', btcAskMin: 0.80, ethAskMax: 0.60, shares: 100 }),
  Object.freeze({ id: 'btc-090-eth-070-200', btcAskMin: 0.90, ethAskMax: 0.70, shares: 200 }),
  Object.freeze({ id: 'btc-095-eth-080-400', btcAskMin: 0.95, ethAskMax: 0.80, shares: 400 }),
]);
const BTC_SIGNAL_MIN = ENTRY_TRIGGERS[0].btcAskMin;
const ETH_ENTRY_MAX = ENTRY_TRIGGERS[0].ethAskMax;
const TAKE_PROFIT_LIMIT = 0.99;
const TAKE_PROFIT_CREDIT = 1;
const QUOTE_MAX_AGE_MS = 2000;

function round(value) {
  return Number(Number(value).toFixed(6));
}

class CrossAssetBot extends WickBot {
  constructor({ marketData: data = marketData } = {}) {
    super({
      timeframe: '5m',
      windowMs: cfg.WINDOW_MS_5M,
      capital: cfg.DEMO_CAPITAL,
      strategyId: 'eth-5m-btc-confirmed',
      strategyName: 'BTC-confirmed ETH 5-minute strategy',
      rules: { sharesPerSide: cfg.ENTRY_SHARES },
      marketData: data,
    });
    this.crossAssetData = data;
    this.btcMarket = null;
    this.btcLiveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
    this.entryFiredTriggers = new Set();
    this.entrySignalsByTrigger = Object.create(null);
    this.entrySignal = null;
  }

  getWindowStartToScan(_now, currentStart) {
    return currentStart;
  }

  async loadMarket(start, windowMs) {
    const [btcMarket, ethMarket] = await Promise.all([
      this.crossAssetData.getBtcMarket(start, windowMs),
      this.crossAssetData.getEthMarket(start, windowMs),
    ]);
    this.btcMarket = btcMarket;
    return ethMarket;
  }

  async refreshLiveQuotes(now) {
    await super.refreshLiveQuotes(now);
    if (!this.btcMarket) {
      this.btcLiveQuotes = { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
      return;
    }
    const sides = ['UP', 'DOWN'];
    const results = await Promise.allSettled(
      sides.map(side => this.crossAssetData.getBook(this.btcMarket.tokens[side])),
    );
    for (const [index, side] of sides.entries()) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        this.btcLiveQuotes[side] = quoteFromBook(result.value, now);
      } else {
        const previous = this.btcLiveQuotes[side] || {};
        const stale = !previous.updatedAt || now - previous.updatedAt > 10000;
        this.btcLiveQuotes[side] = {
          ...previous,
          status: previous.updatedAt ? (stale ? 'STALE' : 'LIVE') : 'ERROR',
          stale,
          attemptedAt: now,
          error: result.reason?.message || 'BTC order book unavailable',
        };
      }
    }
  }

  openStrategyWindow(start, now) {
    super.openStrategyWindow(start, now);
    this.entryFiredTriggers = new Set();
    this.entrySignalsByTrigger = Object.create(null);
    this.entrySignal = null;
    this.btcLiveQuotes = this.btcLiveQuotes || { UP: { status: 'MISSING' }, DOWN: { status: 'MISSING' } };
  }

  isFreshAsk(quote, now) {
    return quote?.status === 'LIVE' &&
      Number.isFinite(Number(quote.bestAsk)) &&
      Number.isFinite(Number(quote.updatedAt)) &&
      now - Number(quote.updatedAt) <= QUOTE_MAX_AGE_MS;
  }

  processStrategyEntry(now) {
    this.processTakeProfits(now);
    const start = this.orderWindowStart;
    if (!this.market || this.market.start !== start || this.completedWindows.has(start)) return false;
    const elapsed = now - start;
    if (elapsed < ENTRY_WAIT_MS || elapsed >= ENTRY_CUTOFF_MS) return false;

    let firedCount = 0;
    for (const trigger of ENTRY_TRIGGERS) {
      if (this.entryFiredTriggers.has(trigger.id)) continue;
      const candidates = ['UP', 'DOWN'].filter(side => {
        const btc = this.btcLiveQuotes[side];
        const eth = this.liveQuotes[side];
        return this.isFreshAsk(btc, now) && this.isFreshAsk(eth, now) &&
          Number(btc.bestAsk) >= trigger.btcAskMin &&
          Number(eth.bestAsk) < trigger.ethAskMax;
      }).sort((a, b) => Number(this.btcLiveQuotes[b].bestAsk) - Number(this.btcLiveQuotes[a].bestAsk));
      const side = candidates[0];
      if (!side) continue;

      this.entryFiredTriggers.add(trigger.id);
      this.entryTriggerLatched = true;
      this.entryTriggerAt = now;
      this.entryTriggerSide = side;
      this.entryOrderPlaced = true;
      this.entryAttemptMissed = false;
      const btcAsk = Number(this.btcLiveQuotes[side].bestAsk);
      const ethAsk = Number(this.liveQuotes[side].bestAsk);
      const signal = {
        triggerId: trigger.id,
        requestedShares: trigger.shares,
        side,
        btcAsk,
        ethAsk,
        elapsedMs: elapsed,
        windowStart: start,
        triggeredAt: now,
      };
      this.entrySignalsByTrigger[trigger.id] = signal;
      this.entrySignal = signal;
      this.entryTriggerReason =
        `${trigger.shares}-share trigger: BTC ${side} ask ${btcAsk.toFixed(3)} met $${trigger.btcAskMin.toFixed(2)} while ETH ${side} ask ${ethAsk.toFixed(3)} was below $${trigger.ethAskMax.toFixed(2)}.`;
      this.log('PAPER_BTC_CONFIRMED_ETH_SIGNAL', {
        strategyId: this.strategyId,
        windowStart: start,
        triggerId: trigger.id,
        requestedShares: trigger.shares,
        btcAskMin: trigger.btcAskMin,
        ethAskMax: trigger.ethAskMax,
        side,
        btcAsk,
        ethAsk,
        elapsedMs: elapsed,
        entryCutoffMs: ENTRY_CUTOFF_MS,
      });
      this.placeTakerBuy(now, start, side, trigger, signal);
      firedCount += 1;
    }
    return firedCount > 0;
  }

  placeTakerBuy(now, start, side, trigger, signal) {
    const requestedShares = trigger.shares;
    const order = {
      id: `${this.strategyId}-${start}-${trigger.id}-${side.toLowerCase()}-market-buy`,
      timeframe: this.timeframe,
      windowStart: start,
      marketId: this.market.id,
      marketSlug: this.market.slug,
      asset: 'ETH',
      tokenId: this.market.tokens?.[side] || null,
      side,
      signalSide: side,
      triggerId: trigger.id,
      btcAskMin: trigger.btcAskMin,
      ethAskMax: trigger.ethAskMax,
      action: 'BUY',
      kind: 'ENTRY',
      orderType: 'MARKET',
      entryMode: 'BTC_CONFIRMED_ETH_TAKER_BUY',
      requestedShares,
      filledShares: 0,
      remainingShares: requestedShares,
      cost: 0,
      fee: 0,
      fillEvents: [],
      createdAt: now,
      submittedAt: now,
      status: 'SUBMITTED',
    };
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.totalOrderAttempts += 1;
    this.entryOrderId = order.id;

    const quote = this.liveQuotes[side];
    const asks = (Array.isArray(quote?.askLevels) && quote.askLevels.length
      ? quote.askLevels
      : [{ price: quote?.bestAsk, size: quote?.askSize }])
      .map(level => ({ price: Number(level.price), size: Number(level.size) }))
      .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1 &&
        Number.isFinite(level.size) && level.size > 0)
      .sort((a, b) => a.price - b.price);

    let remaining = requestedShares;
    let totalCost = 0;
    let totalFees = 0;
    const fills = [];
    for (const level of asks) {
      if (remaining <= 1e-9) break;
      const shares = Math.min(remaining, level.size);
      const cost = shares * level.price;
      const fee = takerFeeFor(this.market, level.price, shares);
      if (cost + fee > this.cash + 1e-9) break;
      totalCost += cost;
      totalFees += fee;
      remaining -= shares;
      fills.push({ shares: round(shares), price: round(level.price), cost: round(cost), fee: round(fee) });
    }

    const filledShares = requestedShares - remaining;
    order.filledShares = round(filledShares);
    order.remainingShares = 0;
    order.cost = round(totalCost);
    order.totalCost = order.cost;
    order.fee = round(totalFees);
    order.averagePrice = filledShares ? round(totalCost / filledShares) : null;
    order.fillEvents = fills.map(fill => ({
      filledAt: now,
      shares: fill.shares,
      price: fill.price,
      fee: fill.fee,
      source: 'VISIBLE_ASK_DEPTH',
    }));
    order.cancelledRemainderShares = round(remaining);
    order.status = filledShares <= 1e-9
      ? 'REJECTED_NO_VISIBLE_ASK_DEPTH'
      : remaining > 1e-9 ? 'PARTIALLY_FILLED_REMAINDER_CANCELLED' : 'FILLED';
    order.filledAt = filledShares > 0 ? now : null;

    if (filledShares <= 1e-9) {
      order.reason = 'No fresh visible ask liquidity was available to fill the paper market buy.';
      this.log('PAPER_TAKER_BUY_REJECTED', {
        orderId: order.id,
        side,
        requestedShares,
        reason: order.reason,
      });
      return null;
    }

    const position = {
      id: `${order.id}-position`,
      timeframe: this.timeframe,
      windowMs: this.windowMs,
      windowStart: start,
      marketId: this.market.id,
      slug: this.market.slug,
      title: this.market.title,
      asset: 'ETH',
      side,
      signalSide: side,
      btcSignalAsk: signal.btcAsk,
      ethTriggerAsk: signal.ethAsk,
      tokenId: this.market.tokens?.[side] || null,
      entryKey: order.id,
      entryLabel: `ETH ${side} taker buy · ${round(filledShares)} of ${requestedShares} shares`,
      entryMode: order.entryMode,
      entryType: 'MARKET_TAKER_BUY',
      phase: `btc-confirmed-eth-entry-${trigger.id}`,
      signalTriggerId: trigger.id,
      btcAskMin: trigger.btcAskMin,
      ethAskMax: trigger.ethAskMax,
      entryFillSource: 'VISIBLE_ASK_DEPTH',
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      orderType: 'MARKET',
      fillModel: 'PAPER_VISIBLE_ASK_DEPTH',
      shares: round(filledShares),
      initialShares: round(filledShares),
      requestedShares,
      avgEntry: round(totalCost / filledShares),
      fillPrice: round(totalCost / filledShares),
      cost: round(totalCost),
      totalCost: round(totalCost),
      initialTotalCost: round(totalCost),
      fees: round(totalFees),
      initialFees: round(totalFees),
      exitFees: 0,
      estimatedMakerRebate: 0,
      takeProfitShares: 0,
      takeProfitProceeds: 0,
      takeProfitCostBasis: 0,
      takeProfitFees: 0,
      takeProfitOrder: {
        orderType: 'LIMIT',
        side: 'SELL',
        limitPrice: TAKE_PROFIT_LIMIT,
        creditedPrice: TAKE_PROFIT_CREDIT,
        status: 'RESTING',
        createdAt: now,
      },
      maxObservedBidSizeByPrice: {},
      status: 'OPEN',
      submittedAt: now,
      openedAt: now,
      filledAt: now,
      updatedAt: now,
      simulatedShares: round(filledShares),
      entryFillEvents: order.fillEvents,
      entryQuotes: this.captureQuotePair(now),
      entryQuoteAt: now,
      feeContext: feeContext(this.market),
      markBid: this.liveQuotes[side]?.bestBid ?? null,
      markUpdatedAt: this.liveQuotes[side]?.updatedAt || now,
      markStatus: 'LIVE',
    };
    order.positionId = position.id;
    order.positionIds = [position.id];
    this.positions.unshift(position);
    this.cash = round(this.cash - totalCost - totalFees);
    this.log('PAPER_TAKER_BUY_FILLED', {
      orderId: order.id,
      positionId: position.id,
      triggerId: trigger.id,
      btcAskMin: trigger.btcAskMin,
      ethAskMax: trigger.ethAskMax,
      asset: 'ETH',
      side,
      requestedShares,
      filledShares: position.shares,
      cancelledRemainderShares: order.cancelledRemainderShares,
      averagePrice: position.avgEntry,
      cost: position.totalCost,
      takerFee: position.fees,
      fills: order.fillEvents,
      takeProfitLimit: TAKE_PROFIT_LIMIT,
      takeProfitCreditPerShare: TAKE_PROFIT_CREDIT,
    });
    return position;
  }

  processTakeProfits(now) {
    for (const position of this.positions) {
      if (position.status !== 'OPEN' || position.windowStart !== this.market?.start ||
          position.shares <= 1e-9) continue;
      const quote = this.liveQuotes[position.side];
      if (quote?.status !== 'LIVE' || !Number.isFinite(Number(quote.updatedAt)) ||
          now - Number(quote.updatedAt) > QUOTE_MAX_AGE_MS ||
          Number(quote.bestBid) < TAKE_PROFIT_LIMIT) continue;
      const bids = (Array.isArray(quote.bidLevels) && quote.bidLevels.length
        ? quote.bidLevels
        : [{ price: quote.bestBid, size: quote.bidSize }])
        .map(level => ({ price: Number(level.price), size: Number(level.size) }))
        .filter(level => Number.isFinite(level.price) && level.price >= TAKE_PROFIT_LIMIT &&
          Number.isFinite(level.size) && level.size > 0)
        .sort((a, b) => b.price - a.price);
      let newlyVisible = 0;
      for (const level of bids) {
        const key = level.price.toFixed(6);
        const previous = Number(position.maxObservedBidSizeByPrice[key] || 0);
        newlyVisible += Math.max(0, level.size - previous);
        position.maxObservedBidSizeByPrice[key] = Math.max(previous, level.size);
      }
      const soldShares = Math.min(position.shares, newlyVisible);
      if (soldShares <= 1e-9) continue;

      const beforeShares = position.shares;
      const fraction = soldShares / beforeShares;
      const releasedCost = position.totalCost * fraction;
      const releasedFees = position.fees * fraction;
      const proceeds = soldShares * TAKE_PROFIT_CREDIT;
      position.shares = round(beforeShares - soldShares);
      position.totalCost = round(position.totalCost - releasedCost);
      position.cost = position.totalCost;
      position.fees = round(position.fees - releasedFees);
      position.takeProfitShares = round(position.takeProfitShares + soldShares);
      position.takeProfitProceeds = round(position.takeProfitProceeds + proceeds);
      position.takeProfitCostBasis = round(position.takeProfitCostBasis + releasedCost);
      position.takeProfitFees = round(position.takeProfitFees + releasedFees);
      position.realizedPnl = round(position.takeProfitProceeds -
        position.takeProfitCostBasis - position.takeProfitFees +
        (position.estimatedMakerRebate || 0));
      position.updatedAt = now;
      position.takeProfitOrder.filledShares = position.takeProfitShares;
      position.takeProfitOrder.lastFillAt = now;
      position.takeProfitOrder.lastFillShares = round(soldShares);
      position.takeProfitOrder.lastFillPrice = TAKE_PROFIT_LIMIT;
      position.takeProfitOrder.creditedPrice = TAKE_PROFIT_CREDIT;
      this.cash = round(this.cash + proceeds);

      const fullyClosed = position.shares <= 1e-9;
      if (fullyClosed) {
        position.shares = 0;
        position.totalCost = 0;
        position.cost = 0;
        position.fees = 0;
        position.proceeds = position.takeProfitProceeds;
        position.realizedPnl = round(position.proceeds -
          position.initialTotalCost - position.initialFees +
          (position.estimatedMakerRebate || 0));
        position.status = 'SETTLED_EXIT';
        position.settlementBasis = 'PAPER_TAKE_PROFIT';
        position.exitReason = 'TAKE_PROFIT_0_99_CREDITED_AT_1';
        position.exitType = 'TAKE_PROFIT';
        position.exitPrice = TAKE_PROFIT_LIMIT;
        position.creditedExitPrice = TAKE_PROFIT_CREDIT;
        position.settledAt = now;
        position.takeProfitOrder.status = 'FILLED';
        this.recordStrategyOutcome(position,
          position.realizedPnl > 0 ? 'WIN' : position.realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN',
          now, 'TAKE_PROFIT');
      }
      this.log('PAPER_TAKE_PROFIT_FILLED', {
        positionId: position.id,
        side: position.side,
        shares: round(soldShares),
        limitPrice: TAKE_PROFIT_LIMIT,
        creditedPrice: TAKE_PROFIT_CREDIT,
        proceeds: round(proceeds),
        remainingShares: position.shares,
        fullyClosed,
      });
    }
  }

  snapshot() {
    const state = super.snapshot();
    const now = Date.now();
    const elapsedMs = state.window ? now - Number(state.window.start) : null;
    const waitingForEntry = elapsedMs != null && elapsedMs >= 0 && elapsedMs < ENTRY_WAIT_MS;
    const withinEntryWindow = elapsedMs != null && elapsedMs >= ENTRY_WAIT_MS && elapsedMs < ENTRY_CUTOFF_MS;
    const btcPrices = this.captureQuotePair(now, this.btcLiveQuotes);
    const ethPrices = state.livePrices;
    const sideStatus = (side, trigger) => {
      const btc = btcPrices[side];
      const eth = ethPrices?.[side];
      if (waitingForEntry) return 'FIRST-MINUTE WAIT';
      if (!withinEntryWindow) return 'WINDOW CLOSED';
      const firedSignal = this.entrySignalsByTrigger[trigger.id];
      if (firedSignal) return firedSignal.side === side ? 'FIRED' : 'ALREADY FIRED';
      if (!this.isFreshAsk(btc, now) || !this.isFreshAsk(eth, now)) return 'WAITING FOR FRESH BTC/ETH QUOTES';
      if (Number(btc.bestAsk) < trigger.btcAskMin) return `BTC ${side} below $${trigger.btcAskMin.toFixed(2)}`;
      if (Number(eth.bestAsk) >= trigger.ethAskMax) return `ETH ${side} is not below $${trigger.ethAskMax.toFixed(2)}`;
      return 'TRIGGER READY';
    };
    const triggerStatuses = ENTRY_TRIGGERS.map(trigger => ({
      id: trigger.id,
      btcAskMin: trigger.btcAskMin,
      ethAskMax: trigger.ethAskMax,
      shares: trigger.shares,
      fired: this.entryFiredTriggers.has(trigger.id),
      side: this.entrySignalsByTrigger[trigger.id]?.side || null,
      orderStatus: this.orders.find(order =>
        order.windowStart === this.orderWindowStart && order.triggerId === trigger.id)?.status || null,
      sideStatus: {
        UP: sideStatus('UP', trigger),
        DOWN: sideStatus('DOWN', trigger),
      },
    }));
    const firedSignals = ENTRY_TRIGGERS
      .map(trigger => this.entrySignalsByTrigger[trigger.id])
      .filter(Boolean);
    const summarizedSideStatus = side => triggerStatuses
      .map(trigger => `${trigger.shares} shares: ${trigger.sideStatus[side]}`)
      .join(' · ');
    const signal = this.entrySignal
      ? {
        ...this.entrySignal,
        reason: `${firedSignals.length} of ${ENTRY_TRIGGERS.length} triggers fired. Latest: ${this.entryTriggerReason}`,
        ready: false,
      }
      : {
        side: null,
        reason: waitingForEntry
          ? 'First-minute wait is active; entries start after 60 seconds.'
          : withinEntryWindow
            ? `Waiting for any of three BTC/ETH price triggers. UP: ${summarizedSideStatus('UP')}. DOWN: ${summarizedSideStatus('DOWN')}.`
            : 'The ETH window has ended; no new entries are allowed.',
        ready: triggerStatuses.some(trigger =>
          trigger.sideStatus.UP === 'TRIGGER READY' || trigger.sideStatus.DOWN === 'TRIGGER READY'),
      };
    const strategy = {
      id: this.strategyId,
      name: this.strategyName,
      timeframe: '5m',
      market: 'Polymarket ETH 5-minute UP/DOWN',
      capital: this.capital,
      execution: 'PAPER ONLY',
      entries: {
        orderType: 'MARKET',
        sideSelection: 'Buy the ETH side matching the BTC side that meets the threshold.',
        sharesPerSide: this.rules.sharesPerSide,
        maxSharesPerWindow: ENTRY_TRIGGERS.reduce((sum, trigger) => sum + trigger.shares, 0),
        maxFiresPerWindow: ENTRY_TRIGGERS.length,
        waitSecondsAfterOpen: ENTRY_WAIT_MS / 1000,
        triggers: triggerStatuses,
        signal: {
          ...signal,
          tradeSide: signal.side,
          sideStatus: {
            UP: summarizedSideStatus('UP'),
            DOWN: summarizedSideStatus('DOWN'),
          },
        },
        orderPlaced: this.entryOrderPlaced,
        orderStatus: this.entryOrderId
          ? this.orders.find(order => order.id === this.entryOrderId)?.status || 'UNKNOWN'
          : 'NOT_PLACED',
        cutoffSecondsAfterOpen: ENTRY_CUTOFF_MS / 1000,
        trigger: `During seconds 60–299, each tier fires once when matching BTC/ETH asks qualify: 100 shares at BTC ≥ $0.80 and ETH < $0.60; 200 at BTC ≥ $0.90 and ETH < $0.70; 400 at BTC ≥ $0.95 and ETH < $0.80.`,
        fillPolicy: 'Immediate paper taker buy sweeps only visible ETH ask depth; any unfilled remainder is cancelled.',
      },
      exit: {
        orderType: 'TAKE_PROFIT_OR_POLYMARKET_RESOLUTION',
        takeProfit: { limitPrice: TAKE_PROFIT_LIMIT, creditedPricePerShare: TAKE_PROFIT_CREDIT },
        stopLoss: null,
        windowEnd: 'Any remaining ETH shares settle only after confirmed resolution of that exact ETH market.',
      },
      timing: 'Wait the first 60 seconds, then watch the matching BTC and ETH 5-minute sides through window close; no final-minute cutoff.',
      sizing: '100, 200, or 400 ETH shares per trigger; up to 700 shares in one window.',
      trigger: 'Three independent, once-per-window BTC-confirmed ETH triggers; all matching tiers may fire.',
      executionNote: 'Paper market buys use visible ETH ask depth and the market’s taker fee schedule.',
    };
    return {
      ...state,
      strategy,
      btcPrices: {
        marketSlug: this.btcMarket?.slug || null,
        updatedAt: Math.max(btcPrices.UP.updatedAt || 0, btcPrices.DOWN.updatedAt || 0) || null,
        UP: btcPrices.UP,
        DOWN: btcPrices.DOWN,
      },
      signal: {
        ...signal,
        sideStatus: {
          UP: summarizedSideStatus('UP'),
          DOWN: summarizedSideStatus('DOWN'),
        },
      },
      entryWindow: {
        elapsedMs,
        waitMs: ENTRY_WAIT_MS,
        cutoffMs: ENTRY_CUTOFF_MS,
        waiting: waitingForEntry,
        open: withinEntryWindow,
        secondsUntilOpen: waitingForEntry ? Math.ceil((ENTRY_WAIT_MS - elapsedMs) / 1000) : 0,
        secondsRemaining: withinEntryWindow ? Math.ceil((ENTRY_CUTOFF_MS - elapsedMs) / 1000) : 0,
      },
      scanner: {
        timeframe: '5m',
        lastScanAt: this.lastScanAt,
        source: 'Polymarket BTC and ETH 5-minute Gamma/CLOB order books',
        marketResolution: 'Unexited positions settle only from the confirmed result of their exact ETH market.',
      },
    };
  }
}

CrossAssetBot.constants = {
  ENTRY_WAIT_MS,
  ENTRY_CUTOFF_MS,
  ENTRY_TRIGGERS,
  BTC_SIGNAL_MIN,
  ETH_ENTRY_MAX,
  TAKE_PROFIT_LIMIT,
  TAKE_PROFIT_CREDIT,
  QUOTE_MAX_AGE_MS,
};

module.exports = CrossAssetBot;
