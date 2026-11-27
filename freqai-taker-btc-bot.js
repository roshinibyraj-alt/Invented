'use strict';
const PreviousBot = require('./freqai-resting-btc-bot');
const DipBounceBot = require('./dip-bounce-bot');
const { planTakerBuy, planTakerSell } = require('./taker-fill');
const { currentPrediction } = PreviousBot._test;
const BASE_SHARES = 100;
const MIN_PROBABILITY = 0.70;
const MAX_BEST_ASK = 0.50;
const STRATEGY = Object.freeze({
  ...PreviousBot.STRATEGY,
  id: 'invented-freqai70-taker-flip100-intrabar5s-v3',
  name: 'Invented BTC FreqAI 70% price-gated taker flips',
  version: 'taker-flip100-intrabar5s-v3',
  scoring: 'The existing LightGBM model is re-evaluated about every five seconds on the in-progress Binance 1-minute candle. These provisional probabilities were trained from completed candles and are experimental, not calibrated.',
  prediction: 'The existing FreqAI score, strictly above 70%, selects UP or DOWN. No Binance fallback.',
  execution: 'Paper-only immediate taker buys and sells; no live orders.',
  entry: 'After the 45-second wait, buy 100 shares when the selected side score is strictly above 70% and its fresh best ask is strictly below $0.50.',
  fill: 'Sweep fresh visible asks for buys and bids for sells, using weighted fills and market-specific taker fees. Unfilled quantities are cancelled; a partially sold position is retried on a later qualifying tick.',
  cadence: 'Repeated same-window reversals are allowed with no flip-count limit. One open side at a time; after the old side is fully sold, buy 100 shares on the qualifying opposite side.',
  sizing: 'Flat 100 shares requested for every entry, including each reversal; actual fills depend on visible liquidity.',
  exit: 'An opposite score above 70% plus its best ask below $0.50 sells the held side and buys 100 on the opposite side. Otherwise hold to official resolution. No TP or SL.',
});

class FreqAITakerBTCBot extends PreviousBot {
  constructor(options = {}) {
    super(options);
    this.strategyId = STRATEGY.id;
    this.strategyDefinition = STRATEGY;
    // The inherited lifecycle calls expiry; taker orders have no live remainder.
    this.restingEngine = { expire() {} };
    this.statusReason = 'Waiting 45 seconds, then require a fresh FreqAI score above 70% and best ask below $0.50.';
  }

  availableCash() { return this.cash; }

  restoreLedger(ledger) {
    for (const o of (ledger?.snapshot || ledger)?.orders || []) {
      const requestedShares = Number(o.requestedShares), filledShares = Number(o.filledShares);
      const isBuy = (o.action || o.type) === 'BUY_TAKER';
      if (o.execution !== 'TAKER'
        || !(requestedShares > 0 && requestedShares <= BASE_SHARES)
        || (isBuy && requestedShares !== BASE_SHARES)
        || !['FILLED', 'PARTIALLY_FILLED'].includes(o.status)
        || !(filledShares > 0 && filledShares <= requestedShares) || o.remainingShares !== 0) {
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
    if (!p || !(p.probability > MIN_PROBABILITY)) return;
    const marketId = String(m.id || m.slug), windowStart = Number(m.start);
    const targetQuote = record.quotes?.[p.side];
    const quoteAge = Number(targetQuote?.updatedAt) <= now
      ? now - Number(targetQuote.updatedAt) : Infinity;
    if (!targetQuote || !Number.isFinite(Number(targetQuote.updatedAt))
      || quoteAge > 2000
      || (targetQuote.tokenId && targetQuote.tokenId !== String(m.tokens[p.side]))
      || (targetQuote.marketId && targetQuote.marketId !== marketId)
      || (targetQuote.windowStart != null && Number(targetQuote.windowStart) !== windowStart)
      || !Number.isFinite(Number(targetQuote.bestAsk))
      || !(Number(targetQuote.bestAsk) < MAX_BEST_ASK)) return;

    const open = this.positions.filter(position => position.status === 'OPEN'
      && position.marketId === marketId && Number(position.windowStart) === windowStart);
    if (open.some(position => position.side === p.side)) return;
    const opposite = open.filter(position => position.side !== p.side);
    let sellOrderIds = [];
    if (opposite.length) {
      for (const position of opposite) {
        const sold = this.sellPosition(record, position, p, now);
        if (sold?.orderId) sellOrderIds.push(sold.orderId);
        if (!sold?.complete) {
          this.lastDecision = { ...p, at: now, action: 'SELL_PARTIAL_WAIT',
            requestedShares: position.shares, source: 'FREQAI' };
          return;
        }
      }
      if (this.positions.some(position => position.status === 'OPEN'
        && position.marketId === marketId && Number(position.windowStart) === windowStart)) return;
    }

    this.buySide(record, p, now, sellOrderIds);
  }

  buySide(record, p, now, sellOrderIds = []) {
    const m = record.market, marketId = String(m.id || m.slug), windowStart = Number(m.start);
    const fill = planTakerBuy(record, p.side, now, this.availableCash());
    if (!fill) return;
    const order = {
      ...fill, id: `taker-${++this.orderSequence}`, type: 'BUY_TAKER', action: 'BUY_TAKER',
      execution: 'TAKER', asset: 'BTC', timeframe: '5m', marketId,
      marketSlug: m.slug, marketTitle: m.title, tokenId: String(m.tokens[p.side]),
      side: p.side, windowStart, windowEnd: Number(m.end), requestedShares: BASE_SHARES,
      filledShares: fill.shares, fillPrice: fill.entryPrice,
      remainingShares: 0, cancelledShares: fill.unfilledShares, reservedCash: 0,
      placedAt: now, filledAt: now, signalProbability: p.probability,
      prediction: { ...p }, fillRule: STRATEGY.fill, reversedFromOrderIds: sellOrderIds,
    };
    this.orders.unshift(order);
    this.cash -= fill.totalCost + fill.fees;
    this.positions.unshift({
      ...fill, id: `position-${++this.positionSequence}`, orderId: order.id,
      asset: 'BTC', timeframe: '5m', marketId, marketSlug: m.slug, marketTitle: m.title,
      tokenId: order.tokenId, side: p.side, status: 'OPEN', entryAt: now,
      windowStart, windowEnd: Number(m.end), requestedShares: BASE_SHARES,
      signalSource: 'FREQAI', modelProbabilityUp: p.pUp, modelProbabilityDown: p.pDown,
      selectedProbability: p.probability, estimatedMakerRebate: 0,
      originalShares: fill.shares, entryFees: fill.fees,
      markStatus: fill.markBid == null ? 'STALE' : 'LIVE',
      unrealizedPnl: fill.markBid == null ? null : fill.markBid * fill.shares - fill.totalCost - fill.fees,
      realizedPnl: null, exitPrice: null, exitPayout: null, exitReason: null, sizingApplied: false,
    });
    this.lastDecision = { ...p, at: now, action: 'BUY', source: 'FREQAI',
      requestedShares: BASE_SHARES, filledShares: fill.shares, fillPrice: fill.entryPrice,
      windowStart, reversedFromOrderIds: sellOrderIds };
    record.triggeredSide = p.side;
    Object.assign(record.sideStates[p.side], { entryConsumed: true, orderId: order.id,
      orderStatus: order.status, requestedShares: BASE_SHARES, filledShares: fill.shares,
      reason: `FreqAI ${(p.probability * 100).toFixed(1)}%; best ask $${Number(record.quotes[p.side].bestAsk).toFixed(3)}. Taker buy ${fill.shares}/${BASE_SHARES} at $${fill.entryPrice.toFixed(4)} average; fees $${fill.fees.toFixed(5)}.` });
    this.log(record.sideStates[p.side].reason, {
      type: 'BUY_TAKER', asset: 'BTC', timeframe: '5m', side: p.side, now,
    });
    this.updateAccountMetrics(now, true);
    this.scheduleLedgerSave();
  }

  sellPosition(record, position, p, now) {
    const m = record.market, marketId = String(m.id || m.slug);
    const requestedShares = Number(position.shares);
    const fill = planTakerSell(record, position.side, requestedShares, now);
    if (!fill) return null;

    const fractionSold = fill.shares / requestedShares;
    const entryFeesBefore = Number(position.entryFees ?? position.fees) || 0;
    const soldCost = Number(position.totalCost) * fractionSold;
    const soldEntryFees = entryFeesBefore * fractionSold;
    const remainingShares = Math.max(0, requestedShares - fill.shares);
    const remainingCost = Math.max(0, Number(position.totalCost) - soldCost);
    const remainingEntryFees = Math.max(0, entryFeesBefore - soldEntryFees);
    const realizedPnl = fill.netProceeds - soldCost - soldEntryFees;
    const order = {
      id: `taker-${++this.orderSequence}`, type: 'SELL_TAKER', action: 'SELL_TAKER',
      execution: 'TAKER', asset: 'BTC', timeframe: '5m', marketId,
      marketSlug: m.slug, marketTitle: m.title, tokenId: String(m.tokens[position.side]),
      side: position.side, windowStart: Number(m.start), windowEnd: Number(m.end),
      positionId: position.id, requestedShares, filledShares: fill.shares,
      remainingShares: 0, cancelledShares: fill.unfilledShares,
      placedAt: now, filledAt: now, fillPrice: fill.exitPrice,
      grossProceeds: fill.grossProceeds, netProceeds: fill.netProceeds,
      fees: fill.fees, fills: fill.fills, status: fill.status,
      signalProbability: p.probability, signalSide: p.side,
      signalAsk: record.quotes[p.side]?.bestAsk, prediction: { ...p },
      exitReason: 'OPPOSITE_SIGNAL', fillRule: STRATEGY.fill,
    };
    this.orders.unshift(order);
    this.cash += fill.netProceeds;

    const closedPosition = position;
    Object.assign(closedPosition, {
      shares: fill.shares, originalShares: fill.shares,
      totalCost: soldCost, fees: soldEntryFees + fill.fees,
      entryFees: soldEntryFees, exitFees: fill.fees,
      status: 'CLOSED_FLIP', exitAt: now, exitPrice: fill.exitPrice,
      exitPayout: fill.netProceeds, exitReason: 'OPPOSITE_SIGNAL',
      realizedPnl, markBid: fill.exitPrice, markUpdatedAt: now,
      markStatus: 'CLOSED', unrealizedPnl: null,
      sizingApplied: true, sellOrderId: order.id,
      exitSignalProbability: p.probability, exitSignalSide: p.side,
    });
    if (remainingShares > 1e-8) {
      const remainder = {
        ...position,
        id: `position-${++this.positionSequence}`,
        shares: remainingShares, originalShares: remainingShares,
        totalCost: remainingCost, fees: remainingEntryFees,
        entryFees: remainingEntryFees, exitFees: 0,
        status: 'OPEN', exitAt: null, exitPrice: null, exitPayout: null,
        exitReason: null, realizedPnl: null, sellOrderId: null,
        markBid: record.quotes[position.side]?.bestBid ?? null,
        markUpdatedAt: record.quotes[position.side]?.updatedAt ?? null,
        markStatus: record.quotes[position.side]?.bestBid == null ? 'STALE' : 'LIVE',
        unrealizedPnl: record.quotes[position.side]?.bestBid == null ? null
          : Number(record.quotes[position.side].bestBid) * remainingShares - remainingCost - remainingEntryFees,
      };
      this.positions.unshift(remainder);
    }
    const state = record.sideStates[position.side];
    state.orderStatus = remainingShares > 1e-8 ? 'PARTIALLY_SOLD' : 'CLOSED_FLIP';
    state.reason = `Opposite ${p.side} score ${(p.probability * 100).toFixed(1)}%; sold ${fill.shares}/${requestedShares} ${position.side} at $${fill.exitPrice.toFixed(4)} average.`;
    this.lastDecision = { ...p, at: now, action: remainingShares > 1e-8
      ? 'SELL_PARTIAL_WAIT' : 'SELL', source: 'FREQAI',
    requestedShares, filledShares: fill.shares, fillPrice: fill.exitPrice,
    soldSide: position.side, windowStart: Number(m.start), sellOrderId: order.id };
    this.log(`${state.reason} Net realized P&L $${realizedPnl.toFixed(4)}; fees $${fill.fees.toFixed(5)}.`, {
      type: remainingShares > 1e-8 ? 'SELL_TAKER_PARTIAL' : 'SELL_TAKER',
      asset: 'BTC', timeframe: '5m', side: position.side,
      outcome: realizedPnl >= 0 ? 'good' : 'bad', now,
    });
    this.updateAccountMetrics(now, true);
    this.scheduleLedgerSave();
    return { orderId: order.id, complete: remainingShares <= 1e-8 };
  }

  snapshot() {
    const s = super.snapshot();
    s.strategy = { ...STRATEGY };
    delete s.restingOrderSummary;
    s.takerOrderSummary = {
      entries: this.orders.filter(o => o.action === 'BUY_TAKER').length,
      exits: this.orders.filter(o => o.action === 'SELL_TAKER').length,
      reversals: this.orders.filter(o => o.action === 'SELL_TAKER').length,
      totalActions: this.orders.length, reservedCash: 0, availableCash: this.cash,
    };
    if (s.sizingByAsset.BTC) {
      Object.assign(s.sizingByAsset.BTC, {
        baseShares: BASE_SHARES,
        currentShares: BASE_SHARES,
        minimumProbability: MIN_PROBABILITY,
        bestAskMaximumExclusive: MAX_BEST_ASK,
        entryDelayMs: 45_000,
        oneEntryPerWindow: false,
        repeatedReversals: true,
        recoveryEnabled: false,
      });
    }
    return s;
  }
}
FreqAITakerBTCBot.STRATEGY = STRATEGY;
module.exports = FreqAITakerBTCBot;
