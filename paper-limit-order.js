'use strict';

const EPSILON = 1e-9;

function simulateLimitBuy(book, targetShares, limitPrice, availableUsd, takerFeeRate = 0) {
  const target = Number(targetShares);
  const limit = Number(limitPrice);
  const budget = Number(availableUsd);
  const feeRate = Number(takerFeeRate);
  const asks = (book && Array.isArray(book.asks) ? book.asks : [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0
      && level.price <= limit + EPSILON
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);

  if (!Number.isFinite(target) || target <= 0
    || !Number.isFinite(limit) || limit <= 0 || limit > 1
    || !Number.isFinite(budget) || budget < 0
    || !Number.isFinite(feeRate) || feeRate < 0) {
    return emptyPlan(target);
  }
  if (budget <= 0) return emptyPlan(target, 'shared_cash');

  let remainingShares = target;
  let remainingBudget = budget;
  let notional = 0;
  let fees = 0;
  const fills = [];

  for (const level of asks) {
    if (remainingShares <= EPSILON || remainingBudget <= EPSILON) break;
    const feePerShare = feeRate * level.price * (1 - level.price);
    const totalPerShare = level.price + feePerShare;
    const shares = Math.min(level.size, remainingShares, remainingBudget / totalPerShare);
    if (shares <= EPSILON) continue;

    const levelNotional = shares * level.price;
    const levelFee = shares * feePerShare;
    fills.push({
      price: level.price,
      shares,
      notional: levelNotional,
      fee: levelFee,
      totalCost: levelNotional + levelFee,
    });
    notional += levelNotional;
    fees += levelFee;
    remainingShares -= shares;
    remainingBudget = Math.max(0, remainingBudget - levelNotional - levelFee);
  }

  const filledShares = target - remainingShares;
  const visibleDepth = asks.reduce((sum, level) => sum + level.size, 0);
  const limitingFactor = remainingShares <= EPSILON ? null
    : remainingBudget <= EPSILON ? 'shared_cash'
      : visibleDepth + EPSILON < target ? 'visible_depth' : 'shared_cash';
  return {
    targetShares: target,
    limitPrice: limit,
    filledShares,
    remainingShares: Math.max(0, remainingShares),
    notional,
    fees,
    totalCost: notional + fees,
    averagePrice: filledShares > EPSILON ? notional / filledShares : null,
    fills,
    limitingFactor,
  };
}

function queueAheadAtLimit(book, limitPrice) {
  const limit = Number(limitPrice);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return (book && Array.isArray(book.bids) ? book.bids : [])
    .reduce((sum, level) => {
      const price = Number(level.price);
      const size = Number(level.size);
      return Number.isFinite(price) && Math.abs(price - limit) <= EPSILON
        && Number.isFinite(size) && size > 0 ? sum + size : sum;
    }, 0);
}

function emptyPlan(targetShares, limitingFactor = 'no_marketable_asks') {
  const target = Number.isFinite(Number(targetShares)) ? Number(targetShares) : 0;
  return {
    targetShares: target,
    limitPrice: null,
    filledShares: 0,
    remainingShares: Math.max(0, target),
    notional: 0,
    fees: 0,
    totalCost: 0,
    averagePrice: null,
    fills: [],
    limitingFactor,
  };
}

module.exports = { simulateLimitBuy, queueAheadAtLimit };
