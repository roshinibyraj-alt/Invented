'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { simulateMarketBuy } = require('../paper-market-order');

function approx(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
}

test('market buy sweeps asks in price order, weights the average, and charges taker fees per level', () => {
  const plan = simulateMarketBuy({
    asks: [
      { price: 0.70, size: 4 },
      { price: 0.60, size: 6 },
    ],
  }, 10, 100, 0.07);

  assert.equal(plan.filledShares, 10);
  assert.equal(plan.remainingShares, 0);
  assert.equal(plan.fills[0].price, 0.60);
  assert.equal(plan.fills[1].price, 0.70);
  approx(plan.notional, 6.40);
  approx(plan.fees, 0.1596);
  approx(plan.totalCost, 6.5596);
  approx(plan.averagePrice, 0.64);
  assert.equal(plan.limitingFactor, null);
});

test('visible depth limits the fill and cancels the market-order remainder', () => {
  const plan = simulateMarketBuy({
    asks: [{ price: 0.80, size: 4 }],
  }, 10, 100, 0.07);

  assert.equal(plan.filledShares, 4);
  assert.equal(plan.remainingShares, 6);
  assert.equal(plan.limitingFactor, 'visible_depth');
  approx(plan.notional, 3.2);
  approx(plan.fees, 0.0448);
});

test('shared cash caps spend including the per-level fee without overdrawing', () => {
  const plan = simulateMarketBuy({
    asks: [{ price: 0.45, size: 10 }],
  }, 10, 1, 0.07);

  assert.equal(plan.limitingFactor, 'shared_cash');
  assert.ok(plan.filledShares > 0 && plan.filledShares < 10);
  assert.ok(plan.totalCost <= 1 + 1e-9);
  approx(plan.totalCost, 1);
});

test('an empty ask book is not fabricated into a fill', () => {
  const plan = simulateMarketBuy({ asks: [] }, 10, 100, 0.07);
  assert.equal(plan.filledShares, 0);
  assert.equal(plan.remainingShares, 10);
  assert.equal(plan.limitingFactor, 'visible_depth');
  assert.equal(plan.averagePrice, null);
});
