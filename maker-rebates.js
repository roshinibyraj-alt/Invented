'use strict';

// Official schedule checked 2026-11-25:
// docs.polymarket.com/trading/fees and /programs/maker-rebates.
// This is the fee EQUIVALENT, not a fee charged to our passive paper fills.
function feeEquivalent(asset, shares, price) {
  if (!['BTC', 'ETH'].includes(asset)) throw new Error(`Unsupported rebate asset: ${asset}`);
  if (!Number.isFinite(shares) || shares < 0 || !Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error('Invalid maker fill for rebate calculation.');
  }
  return shares * (asset === 'BTC' ? 0.05 : 0.01) * price * (1 - price);
}

function summarizeMakerRebates(orders) {
  const byAsset = {BTC: {buy: 0, sell: 0}, ETH: {buy: 0, sell: 0}};
  for (const order of orders) {
    // Only executed quantities count. Cancellations, reserves and resolution
    // payouts are NOT maker fills. Order totals survive resolution and restart.
    if (order.filledShares > 0) byAsset[order.asset].buy += feeEquivalent(order.asset, order.filledShares, order.limitPrice);
    const makerSold = order.tpSoldShares ?? order.soldShares;
    if (makerSold > 0) byAsset[order.asset].sell += feeEquivalent(order.asset, makerSold, order.tpPrice);
  }
  const equivalent = Object.values(byAsset).reduce((sum, a) => sum + a.buy + a.sell, 0);
  return {
    formula: 'filled shares × market fee rate × fill price × (1 − fill price) × maker rebate rate',
    feeRates: {BTC: 0.05, ETH: 0.01},
    feeEquivalent: equivalent, byAsset,
    scenarios: [0, 0.03, 0.07, 0.10, 0.15].map(rate => ({rate, amount: equivalent * rate})),
    actualReceived: 0,
    includedInEquity: false,
    qualification: 'Paper estimates only. Select an assumed eligible maker rate; wallet eligibility and campaign rates are not verified.',
    source: 'https://docs.polymarket.com/programs/maker-rebates',
  };
}

module.exports = {feeEquivalent, summarizeMakerRebates};
