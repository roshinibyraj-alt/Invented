'use strict';
const PreviousBot = require('./freqai-resting-btc-bot');
const DipBounceBot = require('./dip-bounce-bot');
const { planTakerBuy } = require('./taker-fill');
const { currentPrediction } = PreviousBot._test;
const STRATEGY = Object.freeze({
  ...PreviousBot.STRATEGY,
  id: 'invented-freqai58-taker-flat100-intrabar5s-v2',
  name: 'Invented BTC FreqAI 58% immediate taker',
  version: 'taker-flat100-intrabar5s-v2',
  scoring: 'The existing LightGBM model is re-evaluated about every five seconds on the in-progress Binance 1-minute candle. These provisional probabilities were trained from completed candles and are experimental, not calibrated.',
  execution: 'Paper-only immediate taker buys; no live orders.',
  entry: 'After 45 seconds, a fresh current-window score strictly above 58% immediately buys up to 100 shares at available asks.',
  fill: 'Immediate visible-ask sweep with volume-weighted entry price and market-specific taker fees. Any unfilled remainder is cancelled.',
  cadence: 'One executed entry per window, including partial fills. No resting orders, repricing, or opposite-signal replacement.',
  sizing: 'Flat 100 shares requested per window; actual quantity depends on executable liquidity.',
  exit: 'No flips, recovery sizing, TP or SL. Hold filled shares to official resolution.',
});

class FreqAITakerBTCBot extends PreviousBot {
  constructor(options = {}) {
    super(options);
    this.strategyId = STRATEGY.id;
    this.strategyDefinition = STRATEGY;
    // The inherited lifecycle calls expiry; taker orders have no live remainder.
    this.restingEngine = { expire() {} };
    this.statusReason = 'Waiting for fresh above-58% FreqAI after 45 seconds; immediate 100-share taker buy.';
  }

  availableCash() { return this.cash; }

  restoreLedger(ledger) {
    for (const o of (ledger?.snapshot || ledger)?.orders || []) {
      if (o.execution !== 'TAKER' || o.requestedShares !== 100
        || !['FILLED', 'PARTIALLY_FILLED'].includes(o.status)
        || !(o.filledShares > 0 && o.filledShares <= 100) || o.remainingShares !== 0) {
        throw new Error('Invalid saved taker order.');
      }
    }
    DipBounceBot.prototype.restoreLedger.call(this, ledger);
    this.scheduleLedgerSave();
  }

  processSide(record) {
    const now = this.now(), m = record.market;
    if (!m) return;
    const p = currentPrediction(this.freqaiWorker?.snapshot?.()?.lastPrediction, m, now);
    if (!p || !(p.probability > 0.58)) return;
    const marketId = String(m.id || m.slug), windowStart = Number(m.start);
    if (this.orders.some(o => o.marketId === marketId && o.windowStart === windowStart)) return;
    const fill = planTakerBuy(record, p.side, now, this.availableCash());
    if (!fill) return;
    const order = {
      ...fill, id: `taker-${++this.orderSequence}`, type: 'BUY_TAKER', action: 'BUY_TAKER',
      execution: 'TAKER', asset: 'BTC', timeframe: '5m', marketId,
      marketSlug: m.slug, marketTitle: m.title, tokenId: String(m.tokens[p.side]),
      side: p.side, windowStart, windowEnd: Number(m.end), requestedShares: 100,
      filledShares: fill.shares, fillPrice: fill.entryPrice,
      remainingShares: 0, cancelledShares: fill.unfilledShares, reservedCash: 0,
      placedAt: now, filledAt: now, signalProbability: p.probability,
      prediction: { ...p }, fillRule: STRATEGY.fill,
    };
    this.orders.unshift(order);
    this.cash -= fill.totalCost + fill.fees;
    this.positions.unshift({
      ...fill, id: `position-${++this.positionSequence}`, orderId: order.id,
      asset: 'BTC', timeframe: '5m', marketId, marketSlug: m.slug, marketTitle: m.title,
      tokenId: order.tokenId, side: p.side, status: 'OPEN', entryAt: now,
      windowStart, windowEnd: Number(m.end), requestedShares: 100,
      signalSource: 'FREQAI', modelProbabilityUp: p.pUp, modelProbabilityDown: p.pDown,
      selectedProbability: p.probability, estimatedMakerRebate: 0,
      markStatus: fill.markBid == null ? 'STALE' : 'LIVE',
      unrealizedPnl: fill.markBid == null ? null : fill.markBid * fill.shares - fill.totalCost - fill.fees,
      realizedPnl: null, exitPrice: null, exitPayout: null, exitReason: null, sizingApplied: false,
    });
    this.lastDecision = { ...p, at: now, source: 'FREQAI', requestedShares: 100,
      filledShares: fill.shares, fillPrice: fill.entryPrice, windowStart };
    record.triggeredSide = p.side;
    Object.assign(record.sideStates[p.side], { entryConsumed: true, orderId: order.id,
      orderStatus: order.status, requestedShares: 100, filledShares: fill.shares,
      reason: `Immediate taker: ${fill.shares}/100 at $${fill.entryPrice.toFixed(4)}; fees $${fill.fees.toFixed(5)}. No resting remainder.` });
    this.log(record.sideStates[p.side].reason, {
      type: 'BUY_TAKER', asset: 'BTC', timeframe: '5m', side: p.side, now,
    });
    this.updateAccountMetrics(now, true);
    this.scheduleLedgerSave();
  }

  snapshot() {
    const s = super.snapshot();
    s.strategy = { ...STRATEGY };
    delete s.restingOrderSummary;
    s.takerOrderSummary = { entries: this.orders.length, reservedCash: 0, availableCash: this.cash };
    s.sizingByAsset.BTC.oneEntryPerWindow = true;
    return s;
  }
}
FreqAITakerBTCBot.STRATEGY = STRATEGY;
module.exports = FreqAITakerBTCBot;
