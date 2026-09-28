'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  marketLimitPrice, buyShareCount,
  parseMarketResponse, parseShareBuyResponse,
} = require('../order_utils');

test('FAK buy accepts asks up to $0.99 regardless of the demo ask', () => {
  assert.equal(marketLimitPrice('BUY', 0.79, 0.79, 0.30, '0.01'), 0.99);
  assert.equal(marketLimitPrice('BUY', 0.91, 0.50, 0.30, '0.01'), 0.99);
  assert.equal(marketLimitPrice('BUY', 0.50, 0.503, 0.283, '0.005'), 0.99);
  assert.equal(marketLimitPrice('BUY', 0.995, 0.50, 0.30, '0.005'), null);
});

test('real buy size is a positive whole number of shares', () => {
  assert.equal(buyShareCount(6), 6);
  assert.equal(buyShareCount('7'), 7);
  for (const invalid of [true, false, null, '', 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(buyShareCount(invalid), null);
  }
});

test('FAK sell refuses a bid below the observed price floor', () => {
  assert.equal(marketLimitPrice('SELL', 0.50, 0.70, 0.30, '0.01'), 0.40);
  assert.equal(marketLimitPrice('SELL', 0.20, 0.70, 0.30, '0.01'), null);
});

test('matched FAK buy reports actual USD and shares, not requested shares', () => {
  const fill = parseMarketResponse({
    success: true,
    status: 'matched',
    orderID: 'buy-order',
    makingAmount: '1',
    takingAmount: '1.3',
  }, 'BUY', 1);
  assert.equal(fill.filled, true);
  assert.equal(fill.cost, 1);
  assert.equal(fill.shares, 1.3);
  assert.equal(fill.avgPrice, 1 / 1.3);
});

test('matched FAK sell reports actual proceeds', () => {
  const fill = parseMarketResponse({
    success: true,
    status: 'matched',
    orderID: 'sell-order',
    makingAmount: '5.2',
    takingAmount: '5',
  }, 'SELL', 5.2);
  assert.equal(fill.filled, true);
  assert.equal(fill.shares, 5.2);
  assert.equal(fill.proceeds, 5);
});

test('partially filled FAK buy uses spent dollars, not the one-dollar request', () => {
  const fill = parseMarketResponse({
    success: true,
    status: 'matched',
    orderID: 'partial-buy',
    makingAmount: '0.75',
    takingAmount: '1',
  }, 'BUY', 1);
  assert.equal(fill.filled, true);
  assert.equal(fill.cost, 0.75);
  assert.equal(fill.shares, 1);
  assert.equal(fill.avgPrice, 0.75);
});

test('share-sized FAK buy reports actual partial fill and enforces requested share ceiling', () => {
  const fill = parseShareBuyResponse({
    success: true,
    status: 'matched',
    orderID: 'partial-share-buy',
    makingAmount: '4.95',
    takingAmount: '5',
  }, 6, 0.99);
  assert.equal(fill.filled, true);
  assert.equal(fill.requestedShares, 6);
  assert.equal(fill.shares, 5);
  assert.equal(fill.cost, 4.95);

  assert.throws(() => parseShareBuyResponse({
    success: true,
    status: 'matched',
    orderID: 'oversized-share-buy',
    makingAmount: '5.8',
    takingAmount: '6.2',
  }, 6, 0.99), /exceeded requested size/);
  assert.throws(() => parseShareBuyResponse({
    success: true,
    status: 'matched',
    orderID: 'over-limit-share-buy',
    makingAmount: '6.00',
    takingAmount: '6',
  }, 6, 0.99), /implausible fill amounts/);
});

test('partially filled FAK sell reports only the shares actually sold', () => {
  const fill = parseMarketResponse({
    success: true,
    status: 'matched',
    orderID: 'partial-sell',
    makingAmount: '2',
    takingAmount: '1.9',
  }, 'SELL', 5.2);
  assert.equal(fill.filled, true);
  assert.equal(fill.shares, 2);
  assert.equal(fill.proceeds, 1.9);
});

test('exchange rejection is not a fill; uncertain submissions require review', () => {
  const rejected = parseMarketResponse({
    success: false, status: 'unmatched', orderID: '',
    errorMsg: 'INVALID_ORDER_MIN_SIZE',
  }, 'BUY', 1);
  assert.equal(rejected.filled, false);
  assert.match(rejected.status, /MIN_SIZE/);
  assert.throws(() => parseMarketResponse({
    success: true, status: 'delayed', orderID: 'maybe-filled',
  }, 'BUY', 1), /manual reconciliation/);
  assert.throws(() => parseMarketResponse({
    success: true, status: 'matched', orderID: 'unknown-amounts',
  }, 'BUY', 1), /no usable fill amounts/);
  assert.throws(() => parseMarketResponse({
    success: true, status: 'matched', orderID: 'overspend',
    makingAmount: '2', takingAmount: '3',
  }, 'BUY', 1), /implausible fill amounts/);
  assert.throws(() => parseMarketResponse({
    success: true, status: 'matched', orderID: 'tiny',
    makingAmount: '0.000001', takingAmount: '0.000002',
  }, 'BUY', 1), /implausible fill amounts/);
});