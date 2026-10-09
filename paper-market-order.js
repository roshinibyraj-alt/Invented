'use strict';

const EPSILON = 1e-9;

function simulateMarketBuy(book, targetShares, availableUsd, takerFeeRate) {
  const target = Number(targetShares);
  let cash = Number(availableUsd);
  const feeRate = Number(takerFeeRate);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(cash) || cash <= 0
    || !Number.isFinite(feeRate) || feeRate < 0) {
    return { targetShares: target, filledShares: 0, remainingShares: Math.max(0, target || 0), fees: 0, totalCost: 0, fills: [] };
  }
  const asks = (Array.isArray(book?.asks) ? book.asks : [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price <= 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
  let remaining = target, filledShares = 0, fees = 0, totalCost = 0;
  const fills = [];
  for (const level of asks) {
    if (remaining <= EPSILON || cash <= EPSILON) break;
    const feePerShare = feeRate * level.price * (1 - level.price);
    const shares = Math.min(remaining, level.size, cash / (level.price + feePerShare));
    if (shares <= EPSILON) continue;
    const notional = shares * level.price;
    const fee = shares * feePerShare;
    fills.push({ price: level.price, shares, notional, fee, totalCost: notional + fee, maker: false, source: 'CLOB_ASK_SWEEP' });
    filledShares += shares;
    remaining -= shares;
    fees += fee;
    totalCost += notional + fee;
    cash -= notional + fee;
  }
  return { targetShares: target, filledShares, remainingShares: Math.max(0, remaining), fees, totalCost, fills };
}

module.exports = { simulateMarketBuy };
