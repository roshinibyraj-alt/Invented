'use strict';

const EPSILON = 1e-9;

function simulateMarketBuy(book, targetShares, availableUsd, takerFeeRate) {
  const target = Number(targetShares);
  const budget = Number(availableUsd);
  const feeRate = Number(takerFeeRate);
  const asks = (book && Array.isArray(book.asks) ? book.asks : [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price <= 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);

  if (!Number.isFinite(target) || target <= 0
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
    const totalCost = levelNotional + levelFee;
    fills.push({
      price: level.price,
      shares,
      notional: levelNotional,
      fee: levelFee,
      totalCost,
    });
    notional += levelNotional;
    fees += levelFee;
    remainingShares -= shares;
    remainingBudget = Math.max(0, remainingBudget - totalCost);
  }

  const filledShares = target - remainingShares;
  const availableDepth = asks.reduce((total, level) => total + level.size, 0);
  const limitingFactor = remainingShares <= EPSILON ? null
    : remainingBudget <= EPSILON ? 'shared_cash'
      : availableDepth + EPSILON < target ? 'visible_depth' : 'shared_cash';
  return {
    targetShares: target,
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

function emptyPlan(targetShares, limitingFactor = 'no_executable_asks') {
  return {
    targetShares: Number.isFinite(Number(targetShares)) ? Number(targetShares) : 0,
    filledShares: 0,
    remainingShares: Number.isFinite(Number(targetShares)) ? Math.max(0, Number(targetShares)) : 0,
    notional: 0,
    fees: 0,
    totalCost: 0,
    averagePrice: null,
    fills: [],
    limitingFactor,
  };
}

module.exports = { simulateMarketBuy };
