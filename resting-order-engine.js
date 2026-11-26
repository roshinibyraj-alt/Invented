'use strict';

const SHARES = 100;
const THRESHOLD = 0.58;
const active = o => ['RESTING', 'PARTIAL'].includes(o.status);
const round = x => Number(x.toFixed(8));
const fresh = (q, now) => q && Number.isFinite(Number(q.updatedAt))
  && now - Number(q.updatedAt) >= 0 && now - Number(q.updatedAt) <= 2000;

class RestingOrderEngine {
  constructor(bot) { this.bot = bot; }

  sync(order) {
    const record = this.bot.records.get('BTC:5m');
    if (String(record?.market?.id || record?.market?.slug) !== order.marketId
      || Number(record.market.start) !== order.windowStart) return;
    Object.assign(record.sideStates[order.side], {
      orderId: order.id, orderStatus: order.status, limitPrice: order.limitPrice,
      requestedShares: SHARES, filledShares: order.filledShares,
      reason: `${order.status}: ${order.filledShares}/100 filled at fixed $${order.limitPrice.toFixed(3)}. Filled shares hold to resolution.`,
    });
  }

  cancel(order, reason, now) {
    order.status = reason;
    order.cancelledAt = now;
    order.cancelledShares = order.remainingShares;
    order.remainingShares = 0;
    order.reservedCash = 0;
    this.sync(order);
    this.bot.log(`${order.side} limit ${reason.toLowerCase()}; any filled shares stay held.`, {
      type: `LIMIT_${reason}`, asset: 'BTC', timeframe: '5m', side: order.side, now,
    });
    this.bot.scheduleLedgerSave();
  }

  expire(now) {
    for (const order of this.bot.orders) {
      if (active(order) && now >= order.windowEnd) this.cancel(order, 'EXPIRED', now);
    }
  }

  validQuote(record, side, q, now) {
    return fresh(q, now) && Array.isArray(q.asks)
      && (!q.tokenId || q.tokenId === String(record.market.tokens[side]))
      && (!q.marketId || q.marketId === String(record.market.id || record.market.slug))
      && (q.windowStart == null || Number(q.windowStart) === Number(record.market.start));
  }

  process(record, prediction, now) {
    const b = this.bot, m = record.market;
    this.expire(now);
    if (!m || record.marketStatus !== 'OPEN' || now < Number(m.start) + 45000 || now >= Number(m.end)) return;
    const key = String(m.id || m.slug);
    const belongs = o => o.marketId === key && o.windowStart === Number(m.start);
    let order = b.orders.find(o => belongs(o) && active(o));
    const qualifies = prediction && prediction.probability > THRESHOLD;
    if (order && qualifies && prediction.side !== order.side) {
      this.cancel(order, 'CANCELLED_OPPOSITE_SIGNAL', now);
      order = null;
    }
    if (!order && qualifies && !b.orders.some(o => belongs(o) && o.status === 'FILLED')) {
      const q = record.quotes[prediction.side];
      if (!this.validQuote(record, prediction.side, q, now)) return;
      const ask = Number(q.bestAsk);
      const tick = Number(m.raw?.orderPriceMinTickSize ?? m.tickSize ?? 0.001);
      if (!(tick > 0) || !Number.isFinite(tick)) return;
      const limit = round(Math.floor((ask - 0.10 + 1e-10) / tick) * tick);
      if (!(ask > 0 && ask < 1) || !(limit > 0 && limit < ask)) {
        record.sideStates[prediction.side].reason = 'Ask minus $0.10 is not a valid positive limit; waiting.';
        return;
      }
      if (b.availableCash() + 1e-8 < SHARES * limit) {
        record.sideStates[prediction.side].reason = 'Insufficient unreserved paper capital for 100 shares.';
        return;
      }
      order = {
        id: `limit-58-${++b.orderSequence}`, asset: 'BTC', timeframe: '5m',
        type: 'BUY_LIMIT', execution: 'MAKER_LIMIT', marketId: key,
        marketSlug: m.slug, marketTitle: m.title, tokenId: String(m.tokens[prediction.side]),
        side: prediction.side, windowStart: Number(m.start), windowEnd: Number(m.end),
        requestedShares: SHARES, filledShares: 0, remainingShares: SHARES,
        signalAsk: ask, limitPrice: limit, placedAt: now, status: 'RESTING',
        signalProbability: prediction.probability, prediction: { ...prediction },
        reservedCash: SHARES * limit, fees: 0, depthBudget: {}, lastQuoteAt: null,
      };
      b.orders.unshift(order);
      b.lastDecision = { ...prediction, at: now, source: 'FREQAI', limitPrice: limit,
        requestedShares: SHARES, windowStart: order.windowStart, windowEnd: order.windowEnd };
      this.sync(order);
      b.log(`${order.side} ${(prediction.probability * 100).toFixed(1)}%: resting 100-share buy at $${limit.toFixed(3)} (ask $${ask.toFixed(3)} minus $0.10).`, {
        type: 'LIMIT_PLACED', asset: 'BTC', timeframe: '5m', side: order.side, now,
      });
      b.scheduleLedgerSave();
      return; // The placement quote cannot also fill the order.
    }
    if (!order) return;
    const q = record.quotes[order.side];
    if (!this.validQuote(record, order.side, q, now)
      || Number(q.updatedAt) <= order.placedAt
      || Number(q.updatedAt) <= Number(order.lastQuoteAt || 0)) return;
    order.lastQuoteAt = Number(q.updatedAt);
    const levels = new Map();
    for (const level of q.asks) {
      const price = Number(level.price), size = Number(level.size);
      if (price > 0 && price < 1 && size > 0 && Number.isFinite(size)) levels.set(String(price), { price, size });
    }
    // Bid-only updates cannot repeatedly consume the same displayed asks.
    for (const price of Object.keys(order.depthBudget)) {
      if (!levels.has(price)) order.depthBudget[price] = { visible: 0, remaining: 0 };
    }
    let quantity = 0;
    for (const [key, level] of [...levels].sort((a, c) => a[1].price - c[1].price)) {
      const old = order.depthBudget[key];
      const remaining = old ? Math.max(0, Math.min(level.size,
        old.remaining + Math.max(0, level.size - old.visible))) : level.size;
      const budget = order.depthBudget[key] = { visible: level.size, remaining };
      if (level.price >= order.limitPrice || order.remainingShares <= quantity) continue;
      const take = Math.min(budget.remaining, order.remainingShares - quantity);
      budget.remaining = round(budget.remaining - take);
      quantity = round(quantity + take);
    }
    if (quantity > 0) this.fill(order, quantity, q, now);
    b.scheduleLedgerSave();
  }

  fill(order, quantity, q, now) {
    const b = this.bot;
    let p = b.positions.find(p => p.orderId === order.id);
    if (!p) {
      p = {
        id: `position-${++b.positionSequence}`, orderId: order.id,
        asset: 'BTC', timeframe: '5m', marketId: order.marketId,
        marketSlug: order.marketSlug, marketTitle: order.marketTitle, tokenId: order.tokenId,
        side: order.side, windowStart: order.windowStart, windowEnd: order.windowEnd,
        entryAt: now, orderPlacedAt: order.placedAt, entryPrice: order.limitPrice,
        shares: 0, originalShares: 0, totalCost: 0, fees: 0, estimatedMakerRebate: 0,
        fills: [], status: 'OPEN', realizedPnl: null, exitAt: null, exitPrice: null,
        signalSource: 'FREQAI', modelProbabilityUp: order.prediction.pUp,
        modelProbabilityDown: order.prediction.pDown,
        selectedProbability: order.signalProbability,
        modelCandleStart: order.prediction.candleStart,
        fillRule: 'Paper maker: fresh strictly-through ask depth at the fixed limit; queue priority is unknown.',
      };
      b.positions.unshift(p);
    }
    const cost = round(quantity * order.limitPrice);
    b.cash = round(b.cash - cost);
    p.shares = round(p.shares + quantity);
    p.originalShares = p.shares;
    p.totalCost = round(p.totalCost + cost);
    p.fills.push({ price: order.limitPrice, shares: quantity, fee: 0, liquidity: 'MAKER', at: now });
    p.markBid = q.bestBid == null ? null : Number(q.bestBid);
    p.markUpdatedAt = q.updatedAt;
    p.markStatus = p.markBid == null ? 'WAITING_FOR_MARK' : 'LIVE';
    p.unrealizedPnl = p.markBid == null ? null : p.markBid * p.shares - p.totalCost;
    order.filledShares = round(order.filledShares + quantity);
    order.remainingShares = round(SHARES - order.filledShares);
    order.reservedCash = round(order.remainingShares * order.limitPrice);
    order.status = order.remainingShares <= 1e-8 ? 'FILLED' : 'PARTIAL';
    order.lastFillAt = now;
    this.sync(order);
    b.log(`${order.side} maker fill: ${quantity} shares at $${order.limitPrice.toFixed(3)}; ${order.filledShares}/100 filled.`, {
      type: 'LIMIT_FILL', asset: 'BTC', timeframe: '5m', side: order.side, now,
    });
    b.updateAccountMetrics(now, true);
    b.scheduleLedgerSave();
  }
}

module.exports = { RestingOrderEngine, SHARES, THRESHOLD, active, fresh };
