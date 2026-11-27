'use strict';

const { valuationSummary, settledBalanceHistory } = require('./paper-valuation');

const DipBounceBot = require('./dip-bounce-bot');
const { RestingOrderEngine, SHARES, THRESHOLD, active, fresh } = require('./resting-order-engine');

const STRATEGY = Object.freeze({
  id: 'invented-freqai58-resting-minus10-flat100-v1',
  name: 'Invented BTC FreqAI 58% resting limits',
  version: 'resting-flat100-v1',
  market: 'BTC Up/Down 5-minute market only.',
  execution: 'Paper-only fixed-price maker limits. No real orders.',
  features: 'Existing Binance 1-minute OHLCV features and existing trained FreqAI model; prediction targets unchanged.',
  target: 'Existing enclosing BTC 5-minute candle direction; no change to model labels or training settings.',
  prediction: 'Fresh current-window FreqAI probability strictly above 58%. No Binance fallback.',
  entry: 'After a minimum of 45 seconds: 100 shares at signal-side best ask minus $0.10, rounded down to the market tick.',
  fill: 'Require subsequent fresh asks strictly below the limit, backed by displayed depth. Maker fees zero. No assumed rebate income.',
  cadence: 'Keep limits fixed. An opposite score above 58% cancels the unfilled remainder and places 100 shares on the opposite side. Full fills consume the window.',
  sizing: 'Always 100 shares per new limit. No recovery or win/loss progression.',
  exit: 'No signal sales, recovery flips, TP or SL. Hold fills to official resolution. Unfilled orders expire at their own window end.',
});

function currentPrediction(raw, market, now) {
  if (!raw || !market || Number(raw.windowStart) !== Number(market.start)) return null;
  const close = Number(raw.candleCloseAt), written = Number(raw.writtenAt);
  if (!Number.isFinite(close) || !Number.isFinite(written)
    || close <= Number(market.start) || close > Number(market.end) + 60_000
    || now >= Number(market.end)) return null;
  if (raw.provisional === true) {
    const observed = Number(raw.observedAt ?? written);
    const liveMinuteStart = Math.floor(now / 60_000) * 60_000;
    if (!Number.isFinite(observed)
      || Number(raw.candleStart) < Number(market.start) - 1000
      || Math.abs(Number(raw.candleStart) - liveMinuteStart) > 1000
      || close <= now || close - Number(raw.candleStart) > 60_000
      || observed < now - 12_000 || observed > now + 5000
      || written < observed - 2000 || written > now + 5000) return null;
  } else if (close < Number(market.start) - 1000 || close > now + 1000
    || now - close > 70_000 || written < close - 10_000 || written > now + 5000) return null;
  const up = Number(raw.pUp), down = Number(raw.pDown);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up < 0 || down < 0 || up + down <= 0) return null;
  const pUp = up / (up + down), pDown = down / (up + down);
  return { ...raw, pUp, pDown, side: pUp >= pDown ? 'UP' : 'DOWN', probability: Math.max(pUp, pDown) };
}

class FreqAIRestingBTCBot extends DipBounceBot {
  constructor(options = {}) {
    super(options);
    this.records = new Map([...this.records].filter(([key]) => key === 'BTC:5m'));
    this.strategyDefinition = STRATEGY;
    this.strategyId = STRATEGY.id;
    this.freqaiWorker = options.freqaiWorker || null;
    this.binanceFeed = null;
    this.lastDecision = null;
    this.restingEngine = new RestingOrderEngine(this);
    this.statusReason = 'Waiting for current-window FreqAI above 58%; fixed 100-share limits after 45 seconds.';
  }

  setMarketDataHelpers({ freqaiWorker, binanceFeed } = {}) {
    if (freqaiWorker) this.freqaiWorker = freqaiWorker;
    if (binanceFeed) this.binanceFeed = binanceFeed;
  }

  restoreLedger(ledger) {
    const snapshot = ledger?.snapshot || ledger;
    for (const order of snapshot?.orders || []) {
      if (order.requestedShares !== SHARES || !(order.limitPrice > 0 && order.limitPrice < 1)
        || !Number.isFinite(order.remainingShares) || order.remainingShares < 0
        || order.remainingShares > SHARES || !['UP', 'DOWN'].includes(order.side)
        || !Number.isFinite(order.windowEnd) || !order.depthBudget) {
        throw new Error('Invalid saved resting order; refusing silent replacement.');
      }
    }
    super.restoreLedger(ledger);
    this.restingEngine.expire(this.now());
    this.scheduleLedgerSave();
  }

  processSide(record) {
    const now = this.now();
    const raw = this.freqaiWorker?.snapshot?.()?.lastPrediction;
    this.restingEngine.process(record, currentPrediction(raw, record.market, now), now);
  }

  async tick(now = this.now()) {
    if (!this.running || this.tickInFlight) return;
    this.restingEngine.expire(now);
    await super.tick(now);
    const record = this.records.get('BTC:5m');
    if (record?.market) this.processSide(record);
  }

  expireMarket(record, now) {
    this.restingEngine.expire(now);
    super.expireMarket(record, now);
  }

  // Deliberately bypass every legacy signal-sale/TP/SL/sizing path.
  checkTakeProfits() {}
  checkStopLosses() {}
  updateSizingAfterClose(position) { position.sizingApplied = true; }

  availableCash() {
    const reserved = this.orders.filter(active).reduce((sum, o) => sum + o.remainingShares * o.limitPrice, 0);
    return Math.max(0, this.cash - reserved);
  }

  markPositions(now, onlyRecordKey = null, onlySide = null) {
    for (const p of this.positions) {
      if (p.status !== 'OPEN' || (onlySide && p.side !== onlySide)) continue;
      const record = this.records.get(`${p.asset}:${p.timeframe}`);
      if (onlyRecordKey && record?.key !== onlyRecordKey) continue;
      const q = record?.quotes?.[p.side];
      const sameMarket = String(record?.market?.id || record?.market?.slug) === p.marketId
        && Number(record?.market?.start) === Number(p.windowStart);
      if (!sameMarket || !fresh(q, now) || q.bestBid == null || !Number.isFinite(Number(q.bestBid))) {
        p.markBid = null; p.markStatus = 'STALE'; p.unrealizedPnl = null;
      } else {
        p.markBid = Number(q.bestBid); p.markUpdatedAt = q.updatedAt;
        p.markStatus = 'LIVE'; p.unrealizedPnl = p.markBid * p.shares - p.totalCost - p.fees;
      }
    }
  }

  accountSnapshot() {
    const a = super.accountSnapshot();
    const unknown = this.positions.some(p => ['OPEN', 'PENDING_RESOLUTION'].includes(p.status)
      && (p.status === 'PENDING_RESOLUTION' || p.markStatus !== 'LIVE'
        || p.markBid == null || !fresh({ updatedAt: p.markUpdatedAt }, this.now())));
    if (unknown) { a.equity = null; a.unrealizedPnl = null; a.markedValue = null; }
    a.settledBalance = this.initialCapital + a.realizedPnl;
    a.valuation = valuationSummary(this.positions, this.now(), 2000);
    return a;
  }

  updateAccountMetrics(now, force = false) {
    // Do not chart stale or unresolved marks as a synthetic loss to zero.
    if (this.accountSnapshot().equity == null) return;
    super.updateAccountMetrics(now, force);
  }

  settleMarket(marketId, winner, now) {
    super.settleMarket(marketId, winner, now);
    this.scheduleLedgerSave();
  }

  snapshot() {
    const s = super.snapshot();
    const history = settledBalanceHistory(this.positions, this.initialCapital,
      s.account.settledBalance, this.now(), this.equityCurve[0]?.at);
    s.account.settledBalanceCurve = history.points;
    s.account.settlementHistoryIncomplete = history.incomplete;
    const worker = this.freqaiWorker?.snapshot?.() || {};
    const market = this.records.get('BTC:5m')?.market;
    const p = currentPrediction(worker.lastPrediction, market, this.now());
    s.strategy = { ...STRATEGY };
    s.freqai = {
      status: worker.status || 'WAITING_FOR_MODEL', lastError: worker.lastError || null,
      prediction: p, latestPrediction: worker.lastPrediction || null,
      model: 'Freqtrade FreqAI LightGBMClassifier',
      input: 'Existing Binance 1-minute OHLCV model; no Polymarket pressure inputs.',
      warmupFallback: 'Disabled; fresh current-window FreqAI is required.',
    };
    s.currentDecision = this.lastDecision;
    s.sizingByAsset = { BTC: { baseShares: SHARES, currentShares: SHARES,
      minimumProbability: THRESHOLD, entryDelayMs: 45000, recoveryEnabled: false } };
    s.restingOrderSummary = {
      active: this.orders.filter(active).length, reservedCash: this.cash - this.availableCash(),
      availableCash: this.availableCash(),
    };
    s.orders = this.orders.map(o => ({ ...o, depthBudget: undefined }));
    s.scanner = { ...s.scanner, assets: ['BTC'], timeframes: ['5m'], totalMarkets: 1 };
    return s;
  }

  exportLedger() {
    const ledger = super.exportLedger();
    // API snapshots omit depth budgets; durable ledgers must retain them to
    // prevent consuming unchanged book liquidity again after a restart.
    ledger.snapshot.orders = this.orders.map(o => structuredClone(o));
    return ledger;
  }
}

FreqAIRestingBTCBot.STRATEGY = STRATEGY;
FreqAIRestingBTCBot._test = { currentPrediction };
module.exports = FreqAIRestingBTCBot;
