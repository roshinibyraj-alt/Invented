'use strict';

const isFresh = (quote, now) => Number.isFinite(quote?.updatedAt)
  && now >= quote.updatedAt - 1000 && now - quote.updatedAt <= 2000;

function levelsFor(quote, side) {
  return (Array.isArray(quote?.[side]) ? quote[side] : [])
    .filter(({ price, size }) => Number.isFinite(price) && price >= 0.01 && price < 1
      && Number.isFinite(size) && size > 0)
    .sort((a, b) => side === 'asks' ? a.price - b.price : b.price - a.price);
}

function feeRateFor(market) {
  const rate = market.feesEnabled === false ? 0 : Number(market.feeSchedule?.rate ?? 0.05);
  return Number.isFinite(rate) && rate >= 0 && rate < 1 ? rate : null;
}

function windowNet(bot, record) {
  return bot.positions.filter((p) => p.marketId === String(record.market.id || record.market.slug)
    && p.windowStart === Number(record.market.start)
    && !['OPEN', 'PENDING_RESOLUTION'].includes(p.status))
    .reduce((sum, p) => sum + (Number(p.realizedPnl) || 0), 0);
}

// Find the smallest whole-share buy, at least the base, whose $1 payout
// covers this window's net realized deficit, including all modeled fees.
function recoveryShares(quote, deficit, rate, base = 50) {
  let quantity = 0;
  let profit = 0;
  for (const { price, size } of levelsFor(quote, 'asks')) {
    const net = 1 - price - rate * price * (1 - price);
    if (net <= 0) continue;
    const required = Math.max(0, base - quantity, (deficit - profit) / net);
    const take = Math.min(size, Math.ceil(required - 1e-9));
    quantity += take;
    profit += take * net;
    if (quantity >= base && profit + 1e-8 >= deficit) {
      // Fractional depth at intermediate levels may leave a fractional total.
      if (Math.abs(quantity - Math.round(quantity)) < 1e-8) return Math.round(quantity);
      const roundUp = Math.ceil(quantity) - quantity;
      if (take + roundUp <= size) return Math.ceil(quantity);
    }
  }
  return null;
}

function sellForFlip(bot, record, position, now) {
  const quote = record.quotes[position.side];
  const rate = feeRateFor(record.market);
  if (!isFresh(quote, now) || rate == null) return false;
  // A partial sweep may only reuse this side's book after a new book update.
  const version = `${quote.sequence ?? ''}:${quote.updatedAt}`;
  const used = bot.orders.some((order) => order.action === 'SELL_FLIP'
    && order.marketId === position.marketId && order.side === position.side
    && order.bookVersion === version);
  if (used) return false;
  let remaining = position.shares;
  const fills = [];
  for (const level of levelsFor(quote, 'bids')) {
    const shares = Math.min(remaining, level.size);
    fills.push({ price: level.price, shares, fee: shares * rate * level.price * (1 - level.price) });
    remaining -= shares;
    if (remaining <= 1e-8) break;
  }
  const sold = fills.reduce((sum, f) => sum + f.shares, 0);
  if (sold <= 0) return false;
  const proceeds = fills.reduce((sum, f) => sum + f.price * f.shares, 0);
  const sellFees = fills.reduce((sum, f) => sum + f.fee, 0);
  const fraction = sold / position.shares;
  const allocatedCost = position.totalCost * fraction;
  const allocatedFees = position.fees * fraction;
  const allocatedRebate = (position.estimatedMakerRebate || 0) * fraction;
  const closed = remaining <= 1e-8 ? position : {
    ...position, id: `freqai-position-${++bot.positionSequence}`, parentPositionId: position.id,
  };
  if (closed !== position) {
    position.shares = remaining;
    position.originalShares = remaining;
    position.totalCost -= allocatedCost;
    position.fees -= allocatedFees;
    position.estimatedMakerRebate -= allocatedRebate;
    position.unrealizedPnl = null;
    bot.positions.unshift(closed);
  }
  Object.assign(closed, {
    shares: sold, originalShares: sold, totalCost: allocatedCost,
    fees: allocatedFees + sellFees, estimatedMakerRebate: allocatedRebate,
    sellFees, status: 'CLOSED_FLIP', exitReason: 'FREQAI_REVERSAL',
    exitAt: now, exitPrice: proceeds / sold, exitPayout: proceeds / sold,
    realizedPnl: proceeds - sellFees - allocatedCost - allocatedFees + allocatedRebate,
    markStatus: 'CLOSED', unrealizedPnl: null, sizingApplied: true,
  });
  bot.cash += proceeds - sellFees;
  bot.orders.unshift({
    id: `freqai-sell-${++bot.orderSequence}`, marketId: position.marketId,
    tokenId: position.tokenId, marketTitle: position.marketTitle, side: position.side,
    windowStart: position.windowStart, windowEnd: position.windowEnd,
    action: 'SELL_FLIP', orderType: 'PAPER_MARKETABLE_SWEEP',
    requestedShares: sold + remaining, filledShares: sold, unfilledShares: remaining,
    status: remaining <= 1e-8 ? 'FILLED' : 'PARTIALLY_FILLED',
    averageFillPrice: proceeds / sold, limitPrice: 0.01, fees: sellFees, fills,
    placedAt: now, filledAt: now, bookVersion: version,
  });
  bot.log(`Sold ${sold.toFixed(2)} ${position.side} at $${(proceeds / sold).toFixed(4)}; net P&L $${closed.realizedPnl.toFixed(2)}${remaining > 1e-8 ? '; waiting for remaining bid liquidity' : ''}.`, {
    asset: 'BTC', timeframe: '5m', side: position.side, now,
    outcome: closed.realizedPnl >= 0 ? 'good' : 'bad', type: 'SELL_FLIP',
  });
  bot.updateAccountMetrics(now, true);
  bot.scheduleLedgerSave();
  return remaining <= 1e-8;
}

module.exports = { isFresh, feeRateFor, windowNet, recoveryShares, sellForFlip };
