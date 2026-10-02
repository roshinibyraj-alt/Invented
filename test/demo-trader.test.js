'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DemoTrader = require('../demo-trader');

test('demo GTC buy fills all 500 shares on an ask touch without using visible depth', async () => {
  const originalFetch = global.fetch;
  let book = { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.31', size: '0.01' }] };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeGtcOrder('token', 'BUY', 0.30, 500);
    assert.equal(order.status, 'LIVE');
    assert.equal(order.makerOnly, true);
    assert.equal(order.makerFee, 0);
    book = { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.30', size: '0.01' }] };
    const state = await trader.getOrder(order.id);
    assert.equal(Number(state.size_matched), 500);
    assert.equal(state.status, 'MATCHED');
    assert.equal(state.makerFee, 0);
    assert.equal(state.makerRebateEstimate, 1.47);
  } finally { global.fetch = originalFetch; }
});

test('demo GTC take-profit fills all shares on a bid touch without using visible depth', async () => {
  const originalFetch = global.fetch;
  let book = { bids: [{ price: '0.69', size: '0.01' }], asks: [{ price: '0.70', size: '0.01' }] };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeGtcOrder('token', 'SELL', 0.70, 500);
    assert.equal(order.status, 'LIVE');
    assert.equal(order.makerOnly, true);
    assert.equal(order.makerFee, 0);
    let state = await trader.getOrder(order.id);
    assert.equal(Number(state.size_matched), 0);
    assert.equal(state.status, 'LIVE');
    book = { bids: [{ price: '0.70', size: '0.01' }], asks: [{ price: '0.71', size: '0.01' }] };
    state = await trader.getOrder(order.id);
    assert.equal(Number(state.size_matched), 500);
    assert.equal(state.status, 'MATCHED');
    assert.equal(state.makerFee, 0);
    assert.equal(state.makerRebateEstimate, 1.47);
  } finally { global.fetch = originalFetch; }
});

test('demo can cancel a resting entry or take-profit order without changing a filled order', async () => {
  const originalFetch = global.fetch;
  const book = { bids: [{ price: '0.29', size: '0.01' }], asks: [{ price: '0.31', size: '0.01' }] };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeGtcOrder('token', 'BUY', 0.30, 500);
    await trader.cancelOrder(order.id);
    assert.equal((await trader.getOrder(order.id)).status, 'CANCELED');
  } finally { global.fetch = originalFetch; }
});

test('demo marketable BUY respects the observed maximum price and visible depth', async () => {
  const originalFetch = global.fetch;
  const book = {
    bids: [{ price: '0.48', size: '20' }],
    asks: [{ price: '0.50', size: '4' }, { price: '0.51', size: '100' }],
  };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeFakMarketOrder('token', 'BUY', 5, { priceLimit: 0.50 });
    assert.equal(order.status, 'matched');
    assert.equal(Number(order.raw.takingAmount), 4);
    assert.equal(Number(order.raw.makingAmount), 2);
  } finally { global.fetch = originalFetch; }
});

test('demo marketable BUY sweeps depth to the price cap and targets shares at that cap', async () => {
  const originalFetch = global.fetch;
  const book = {
    bids: [{ price: '0.48', size: '20' }],
    asks: [
      { price: '0.50', size: '4' },
      { price: '0.74', size: '496' },
      { price: '0.76', size: '1000' },
    ],
  };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeFakMarketOrder('token', 'BUY', 500 * 0.75, { priceLimit: 0.75 });
    assert.equal(order.status, 'matched');
    assert.equal(Number(order.raw.takingAmount), 500);
    assert.equal(Number(order.raw.makingAmount), 369.04);
    assert.equal(order.avgPrice, 369.04 / 500);
  } finally { global.fetch = originalFetch; }
});

test('demo marketable SELL respects the observed minimum price and visible depth', async () => {
  const originalFetch = global.fetch;
  const book = {
    bids: [{ price: '0.50', size: '4' }, { price: '0.49', size: '100' }],
    asks: [{ price: '0.52', size: '20' }],
  };
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = await trader.placeFakMarketOrder('token', 'SELL', 10, { priceLimit: 0.50 });
    assert.equal(order.status, 'matched');
    assert.equal(Number(order.raw.makingAmount), 4);
    assert.equal(Number(order.raw.takingAmount), 2);
  } finally { global.fetch = originalFetch; }
});