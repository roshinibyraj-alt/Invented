'use strict';

function roundToTick(value, tickSize, direction) {
  const tick = Number(tickSize);
  if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) {
    throw new Error('Invalid order price or tick size');
  }
  const places = Math.max(0, String(tickSize).split('.')[1]?.length || 0);
  const units = direction === 'down'
    ? Math.floor(value / tick + 1e-9)
    : Math.ceil(value / tick - 1e-9);
  return Number((units * tick).toFixed(places));
}

function marketLimitPrice(side, bookPrice, referencePrice, slippage, tickSize) {
  const tick = Number(tickSize);
  const book = Number(bookPrice);
  const reference = Number(referencePrice);
  const tolerance = Number(slippage);
  if (![tick, book, reference, tolerance].every(Number.isFinite)
      || tick <= 0 || book <= 0 || reference <= 0 || tolerance < 0) {
    return null;
  }
  if (side === 'BUY') {
    // A share-sized FAK buy may cross available asks up to $0.99 per share.
    const cap = Math.min(0.99, 1 - tick);
    const price = roundToTick(cap, tickSize, 'down');
    return price >= book && price >= tick ? price : null;
  }
  if (side === 'SELL') {
    const floor = Math.max(tick, book - tolerance, reference - tolerance);
    const price = roundToTick(floor, tickSize, 'up');
    return price <= book && price <= 1 - tick ? price : null;
  }
  throw new Error(`Unknown order side: ${side}`);
}

function buyShareCount(value) {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
    return null;
  }
  const shares = Number(value);
  return Number.isSafeInteger(shares) && shares >= 1 ? shares : null;
}

function parseMarketResponse(response, side, requestedAmount) {
  const status = String(response?.status || 'unknown').toLowerCase();
  const orderId = response?.orderID || null;
  if (response?.success === false && !orderId) {
    return {
      filled: false,
      status: response.errorMsg || status || 'REJECTED',
      shares: 0,
      orderId: null,
    };
  }
  if (response?.success !== true || status !== 'matched') {
    throw new Error(`Market order needs manual reconciliation (status=${status}, order=${orderId || 'unknown'})`);
  }

  // Order response amounts are decimal asset quantities, unlike balance
  // allowance amounts, which the CLOB reports in 1e-6 units.
  const making = Number(response.makingAmount);
  const taking = Number(response.takingAmount);
  if (!Number.isFinite(making) || !Number.isFinite(taking)
      || making <= 0 || taking <= 0) {
    throw new Error(`Matched market order has no usable fill amounts (order=${orderId || 'unknown'})`);
  }
  const shares = side === 'BUY' ? taking : making;
  const dollars = side === 'BUY' ? making : taking;
  if (dollars < 0.01 || shares < 0.01
      || (side === 'BUY' && dollars > requestedAmount + 1e-6)
      || (side === 'SELL' && shares > requestedAmount + 1e-6)) {
    throw new Error(`Matched market order has implausible fill amounts (order=${orderId || 'unknown'})`);
  }
  return {
    filled: true,
    status,
    orderId,
    shares,
    avgPrice: dollars / shares,
    ...(side === 'BUY' ? { cost: dollars } : { proceeds: dollars }),
  };
}

function parseShareBuyResponse(response, requestedShares, limitPrice) {
  const shares = buyShareCount(requestedShares);
  const price = Number(limitPrice);
  if (shares === null || !Number.isFinite(price) || price <= 0 || price > 0.99) {
    throw new Error('Invalid share-sized buy request');
  }
  const fill = parseMarketResponse(response, 'BUY', shares * price);
  if (!fill.filled) return { ...fill, requestedShares: shares };
  if (fill.shares > shares + 1e-6) {
    throw new Error(`Matched share order exceeded requested size (order=${fill.orderId || 'unknown'})`);
  }
  return { ...fill, requestedShares: shares };
}

module.exports = {
  marketLimitPrice,
  buyShareCount,
  parseMarketResponse,
  parseShareBuyResponse,
  roundToTick,
};