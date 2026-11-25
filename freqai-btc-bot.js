'use strict';

const DipBounceBot = require('./dip-bounce-bot');

const STRATEGY = Object.freeze({
  id: 'btc-5m-freqai-one-entry-paper-v1',
  name: 'FreqAI BTC 5-minute direction model',
  version: '1',
  execution: 'Paper-only Polymarket taker sweep. Freqtrade/FreqAI runs dry for Binance spot data and does not place orders.',
  market: 'BTC Up/Down 5-minute market only.',
  features: 'Binance 1-minute OHLCV return, candle shape, relative volume, volatility and minute-in-window features.',
  target: 'For each 1-minute sample, classify whether the enclosing BTC 5-minute candle closes above or below its first-minute open.',
  prediction: 'Use the higher FreqAI UP/DOWN class probability. No minimum-confidence or edge gate, so an entry is not rejected for a low score.',
  entry: 'After the first 1-minute sample can close, take one 10-share paper marketable sweep on the model-selected side; if the model has not produced a current-window prediction by 80 seconds, use the live Binance window direction and label it as a warm-up fallback.',
  fill: 'Sweep visible Polymarket asks up to the $1.00 maximum valid outcome price, record actual depth-weighted paper fill and modeled taker fees; partial fills are recorded.',
  exit: 'Hold remaining shares until the exact market resolves; no TP or SL.',
  cadence: 'One filled entry per BTC 5-minute market window, when live feeds and executable book liquidity are available.',
});

const ENTRY_DELAY_MS = 80_000;
const SHARES_PER_WINDOW = 10;
const MAX_BUY_PRICE = 1.00;
const SIDES = ['UP', 'DOWN'];

function fresh(value, now, maxAgeMs) {
  const at = Number(value);
  return Number.isFinite(at) && now >= at - 1000 && now - at <= maxAgeMs;
}

class FreqAIBtcBot extends DipBounceBot {
  constructor(options = {}) {
    super(options);
    this.strategyDefinition = STRATEGY;
    this.strategyId = STRATEGY.id;
    this.records = new Map([...this.records.entries()].filter(([key]) => key === 'BTC:5m'));
    this.freqaiWorker = options.freqaiWorker || null;
    this.binanceFeed = options.binanceFeed || null;
    this.modelStatus = 'WAITING_FOR_MODEL';
    this.lastDecision = null;
    this.statusReason = 'Waiting for the FreqAI model and the current BTC 5-minute market.';
  }

  setMarketDataHelpers({ binanceFeed, freqaiWorker } = {}) {
    if (binanceFeed) this.binanceFeed = binanceFeed;
    if (freqaiWorker) this.freqaiWorker = freqaiWorker;
  }

  getDecision(record, now) {
    const market = record.market;
    if (!market || now < Number(market.start) + ENTRY_DELAY_MS) return null;
    const modelState = this.freqaiWorker?.snapshot?.() || {};
    const prediction = modelState.lastPrediction;
    if (prediction
      && Number(prediction.windowStart) === Number(market.start)
      && fresh(prediction.candleStart, now, 120_000)
      && Number.isFinite(Number(prediction.pUp))
      && Number.isFinite(Number(prediction.pDown))) {
      const pUp = Number(prediction.pUp);
      const pDown = Number(prediction.pDown);
      return {
        side: pUp >= pDown ? 'UP' : 'DOWN',
        pUp,
        pDown,
        source: 'FREQAI',
        candleStart: prediction.candleStart,
        model: prediction.model || 'LightGBMClassifier',
      };
    }

    const candle = this.binanceFeed?.currentCandle;
    if (candle
      && Number(candle.start) === Number(market.start)
      && Number(candle.open) > 0
      && Number(candle.close) > 0
      && fresh(this.binanceFeed?.tickAt, now, 5000)) {
      const side = Number(candle.close) >= Number(candle.open) ? 'UP' : 'DOWN';
      return {
        side,
        pUp: null,
        pDown: null,
        source: 'BINANCE_WARMUP_FALLBACK',
        candleStart: Number(candle.start),
        model: null,
      };
    }
    return null;
  }

  processSide(record, side, quote, sequence) {
    const market = record.market;
    const now = this.now();
    if (!market || record.marketStatus !== 'OPEN'
      || now < Number(market.start) || now >= Number(market.end)) return;
    if (record.triggeredSide) return;

    const state = record.sideStates[side];
    if (now < Number(market.start) + ENTRY_DELAY_MS) {
      state.orderStatus = 'WAITING_FOR_FIRST_MINUTE';
      state.reason = 'Allowing the first 1-minute sample to form before prediction.';
      this.modelStatus = this.freqaiWorker?.snapshot?.().status || 'WAITING';
      return;
    }

    const decision = this.getDecision(record, now);
    if (!decision) {
      this.modelStatus = this.freqaiWorker?.snapshot?.().status || 'WAITING';
      state.orderStatus = 'WAITING_FOR_MODEL';
      state.reason = 'Waiting for a current-window FreqAI prediction or fresh Binance warm-up direction.';
      return;
    }
    this.modelStatus = decision.source === 'FREQAI' ? 'READY' : 'WARMUP_FALLBACK';
    this.lastDecision = {
      ...decision,
      at: now,
      windowStart: Number(market.start),
      windowEnd: Number(market.end),
    };
    if (decision.side !== side) {
      state.orderStatus = 'WAITING_FOR_SELECTED_SIDE_BOOK';
      state.reason = `${decision.source === 'FREQAI' ? 'FreqAI' : 'Warm-up'} selected ${decision.side}; waiting for its live asks.`;
      return;
    }

    const age = Number(quote?.updatedAt);
    if (!fresh(age, now, 2000) || !Array.isArray(quote.asks) || !quote.asks.length) {
      state.orderStatus = 'WAITING_FOR_LIQUIDITY';
      state.reason = `${decision.side} was selected; waiting for a fresh executable ask book.`;
      return;
    }

    const marketId = String(market.id || market.slug);
    const tokenId = String(market.tokens?.[side] || '');
    const requestedShares = SHARES_PER_WINDOW;
    const feeRate = market.feesEnabled === false
      ? 0
      : Number(market.feeSchedule?.rate ?? 0.05);
    if (!Number.isFinite(feeRate) || feeRate < 0) {
      state.orderStatus = 'BLOCKED_INVALID_FEE';
      state.reason = 'Market fee rate is invalid; no paper order was recorded.';
      return;
    }

    let remaining = requestedShares;
    let cost = 0;
    let fees = 0;
    const fills = [];
    for (const level of [...quote.asks].sort((a, b) => Number(a.price) - Number(b.price))) {
      const price = Number(level.price);
      const available = Number(level.size);
      if (!Number.isFinite(price) || price <= 0 || price > MAX_BUY_PRICE
        || !Number.isFinite(available) || available <= 0) continue;
      const shares = Math.min(remaining, available);
      if (shares <= 0) break;
      const fee = shares * feeRate * price * (1 - price);
      fills.push({ price, shares, fee });
      cost += shares * price;
      fees += fee;
      remaining -= shares;
      if (remaining <= 1e-8) break;
    }
    const filledShares = requestedShares - remaining;
    if (filledShares <= 1e-8) {
      state.orderStatus = 'WAITING_FOR_EXECUTABLE_ASKS';
      state.reason = `No visible asks at or below $${MAX_BUY_PRICE.toFixed(2)}; will retry while this window is open.`;
      return;
    }
    const totalCost = cost + fees;
    if (this.availableCash() + 1e-8 < totalCost) {
      state.orderStatus = 'WAITING_FOR_PAPER_CASH';
      state.reason = `Paper cash is short of the $${totalCost.toFixed(2)} entry cost.`;
      return;
    }

    const orderId = `freqai-entry-${++this.orderSequence}`;
    const order = {
      id: orderId,
      strategyId: this.strategyId,
      marketId,
      marketSlug: market.slug || null,
      marketTitle: market.title || null,
      asset: 'BTC',
      timeframe: '5m',
      windowStart: Number(market.start),
      windowEnd: Number(market.end),
      side,
      action: 'BUY_TAKER',
      orderType: 'PAPER_MARKETABLE_SWEEP',
      status: remaining > 1e-8 ? 'PARTIALLY_FILLED' : 'FILLED',
      requestedShares,
      filledShares,
      unfilledShares: remaining,
      averageFillPrice: cost / filledShares,
      limitPrice: MAX_BUY_PRICE,
      fees,
      fills,
      placedAt: now,
      filledAt: now,
      placedSequence: sequence,
      signalSource: decision.source,
      modelProbabilityUp: decision.pUp,
      modelProbabilityDown: decision.pDown,
      modelCandleStart: decision.candleStart,
      model: decision.model,
      fillRule: 'Sweep fresh visible asks up to $0.99; unfilled remainder is cancelled.',
    };
    const position = {
      id: `freqai-position-${++this.positionSequence}`,
      orderId,
      marketId,
      tokenId,
      marketSlug: market.slug || null,
      marketTitle: market.title || null,
      asset: 'BTC',
      timeframe: '5m',
      side,
      windowStart: Number(market.start),
      windowEnd: Number(market.end),
      entryAt: now,
      entryPrice: cost / filledShares,
      requestedShares,
      shares: filledShares,
      originalShares: filledShares,
      totalCost: cost,
      fees,
      estimatedMakerRebate: 0,
      realizedPnl: 0,
      status: 'OPEN',
      markBid: Number.isFinite(Number(quote.bestBid)) ? Number(quote.bestBid) : null,
      markUpdatedAt: quote.updatedAt,
      markStatus: 'LIVE',
      unrealizedPnl: Number.isFinite(Number(quote.bestBid))
        ? Number(quote.bestBid) * filledShares - totalCost - fees
        : null,
      signalSource: decision.source,
      modelProbabilityUp: decision.pUp,
      modelProbabilityDown: decision.pDown,
      modelCandleStart: decision.candleStart,
      model: decision.model,
    };

    this.cash -= totalCost;
    this.orders.unshift(order);
    this.positions.unshift(position);
    record.triggeredSide = side;
    state.entryConsumed = true;
    state.orderId = orderId;
    state.orderStatus = order.status;
    state.requestedShares = requestedShares;
    state.filledShares = filledShares;
    state.limitPrice = MAX_BUY_PRICE;
    const decisionSummary = decision.source === 'FREQAI'
      ? `${(decision.pUp * 100).toFixed(1)}% UP / ${(decision.pDown * 100).toFixed(1)}% DOWN`
      : 'no model score; fresh Binance spot direction';
    state.reason = `${decision.source === 'FREQAI' ? 'FreqAI' : 'Binance warm-up'} selected ${side} (${decisionSummary}); swept ${filledShares.toFixed(2)} shares at $${(cost / filledShares).toFixed(3)} average.`;
    const other = record.sideStates[side === 'UP' ? 'DOWN' : 'UP'];
    other.orderStatus = 'BLOCKED_ONE_ENTRY';
    other.reason = `${side} already filled; one entry maximum per BTC window.`;
    this.cash = Math.max(0, this.cash);
    this.log(
      `${decision.source === 'FREQAI' ? 'FreqAI' : 'Binance warm-up'} chose BTC ${side}: ${filledShares.toFixed(2)} / ${requestedShares} shares at $${(cost / filledShares).toFixed(3)} average; fee $${fees.toFixed(3)}.`,
      {
        asset: 'BTC',
        timeframe: '5m',
        side,
        outcome: 'neutral',
        type: decision.source === 'FREQAI' ? 'FREQAI_ENTRY' : 'WARMUP_ENTRY',
        now,
      },
    );
    this.updateAccountMetrics(now, true);
    this.scheduleLedgerSave();
  }

  checkTakeProfits() {}

  checkStopLosses() {}

  updateSizingAfterClose(position) {
    position.sizingApplied = true;
  }

  snapshot() {
    const state = super.snapshot();
    const worker = this.freqaiWorker?.snapshot?.() || {};
    const prediction = worker.lastPrediction || null;
    const currentMarket = state.markets?.find((market) => market.asset === 'BTC'
      && market.timeframe === '5m' && market.marketStatus === 'OPEN');
    const currentPrediction = currentMarket && prediction
      && Number(prediction.windowStart) === Number(currentMarket.start)
      ? prediction
      : null;
    state.statusReason = this.statusReason;
    state.strategy = { ...STRATEGY };
    state.scanner = {
      ...state.scanner,
      assets: ['BTC'],
      timeframes: ['5m'],
      totalMarkets: 1,
      marketData: 'BTC spot features from FreqAI/Binance; Polymarket CLOB WebSocket for paper execution and marking.',
    };
    state.sizingByAsset = {
      BTC: {
        baseShares: SHARES_PER_WINDOW,
        sharesPerWindow: SHARES_PER_WINDOW,
        maxEntriesPerWindow: 1,
      },
    };
    state.freqai = {
      status: worker.status || this.modelStatus,
      lastError: worker.lastError || null,
      startedAt: worker.startedAt || null,
      restartCount: worker.restartCount || 0,
      prediction: currentPrediction,
      latestPrediction: prediction,
      model: 'Freqtrade FreqAI LightGBMClassifier',
      input: 'Binance 1-minute OHLCV only; no Polymarket order-book pressure features.',
      resolutionLabel: 'Direction of the enclosing BTC 5-minute candle at its official window close.',
      warmupFallback: 'Fresh Binance spot candle direction after 80 seconds only if FreqAI has no current-window prediction.',
    };
    state.currentDecision = this.lastDecision;
    return state;
  }
}

FreqAIBtcBot.STRATEGY = STRATEGY;
FreqAIBtcBot._test = { STRATEGY, ENTRY_DELAY_MS, SHARES_PER_WINDOW, MAX_BUY_PRICE, fresh };
module.exports = FreqAIBtcBot;
