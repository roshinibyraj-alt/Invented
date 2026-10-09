'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { simulateMarketBuy } = require('../paper-market-order');

function approx(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
}

test('market buy sorts ask levels and charges taker fees per level', () => {
  const plan = simulateMarketBuy({
    asks: [{ price: 0.70, size: 4 }, { price: 0.60, size: 6 }],
  }, 10, 100, 0.07);
  assert.deepEqual(plan.fills.map((fill) => fill.price), [0.60, 0.70]);
  assert.equal(plan.filledShares, 10);
  assert.equal(plan.remainingShares, 0);
  approx(plan.fees, 6 * 0.07 * 0.60 * 0.40 + 4 * 0.07 * 0.70 * 0.30);
  approx(plan.totalCost, 6 * 0.60 + 4 * 0.70 + plan.fees);
});

test('visible depth caps the fill and leaves the rest unfilled', () => {
  const plan = simulateMarketBuy({ asks: [{ price: 0.80, size: 4 }] }, 10, 100, 0.07);
  assert.equal(plan.filledShares, 4);
  assert.equal(plan.remainingShares, 6);
  approx(plan.totalCost, 4 * 0.80 + 4 * 0.07 * 0.80 * 0.20);
});

test('shared cash cap includes the per-level fee', () => {
  const plan = simulateMarketBuy({ asks: [{ price: 0.45, size: 10 }] }, 10, 1, 0.07);
  assert.ok(plan.filledShares > 0 && plan.filledShares < 10);
  assert.equal(plan.remainingShares, 10 - plan.filledShares);
  assert.ok(plan.totalCost <= 1 + 1e-9);
  approx(plan.totalCost, 1);
});

test('empty ask book produces no paper fill', () => {
  const plan = simulateMarketBuy({ asks: [] }, 10, 100, 0.07);
  assert.equal(plan.filledShares, 0);
  assert.equal(plan.remainingShares, 10);
  assert.deepEqual(plan.fills, []);
});
