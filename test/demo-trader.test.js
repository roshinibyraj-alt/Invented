'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DemoTrader = require('../demo-trader');

function withBook(book, run) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => book });
  return Promise.resolve().then(run).finally(() => { global.fetch = originalFetch; });
}

test('demo BUY spends a fixed USDC budget from eligible CLOB asks', async () => {
  await withBook({
    bids: [],
    asks: [{ price: '0.50', size: '4' }, { price: '0.51', size: '100' }],
  }, async () => {
    const trader = new DemoTrader();
    const order = await trader.placeFakMarketOrder('token', 'BUY', 5, { priceLimit: 0.50 });
    assert.equal(order.status, 'matched');
    assert.equal(Number(order.raw.takingAmount), 4);
    assert.equal(Number(order.raw.makingAmount), 2);
    assert.equal(order.avgPrice, 0.50);
  });
});

test('demo BUY sweeps visible asks only up to the $0.90 entry cap', async () => {
  await withBook({
    bids: [],
    asks: [
      { price: '0.89', size: '100' },
      { price: '0.90', size: '100' },
      { price: '0.91', size: '1000' },
    ],
  }, async () => {
    const trader = new DemoTrader();
    const order = await trader.placeFakMarketOrder('token', 'BUY', 50, { priceLimit: 0.90 });
    assert.equal(order.status, 'matched');
    assert.equal(Number(order.raw.makingAmount), 50);
    assert.ok(order.avgPrice <= 0.90);
  });
});

test('demo SELL respects the TP floor and visible bid depth', async () => {
  await withBook({
    bids: [{ price: '0.70', size: '4' }, { price: '0.69', size: '100' }],
    asks: [],
  }, async () => {
    const trader = new DemoTrader();
    const order = await trader.placeFakMarketOrder('token', 'SELL', 10, { priceLimit: 0.70 });
    assert.equal(order.status, 'matched');
    assert.equal(Number(order.raw.makingAmount), 4);
    assert.equal(Number(order.raw.takingAmount), 2.8);
  });
});

test('demo forced SELL can use any visible best bid when no minimum is supplied', async () => {
  await withBook({
    bids: [{ price: '0.12', size: '25' }],
    asks: [],
  }, async () => {
    const trader = new DemoTrader();
    const order = await trader.placeFakMarketOrder('token', 'SELL', 10, { priceLimit: 0 });
    assert.equal(order.status, 'matched');
    assert.equal(Number(order.raw.makingAmount), 10);
    assert.equal(Number(order.raw.takingAmount), 1.2);
  });
});

test('fresh cached CLOB quotes are the fallback when REST book is unavailable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('book unavailable'); };
  try {
    const trader = new DemoTrader();
    trader.updateQuote('token', { bid: 0.68, ask: 0.70 });
    const buy = await trader.placeFakMarketOrder('token', 'BUY', 7, { priceLimit: 0.90 });
    const sell = await trader.placeFakMarketOrder('token', 'SELL', 5, { priceLimit: 0 });
    assert.equal(buy.status, 'matched');
    assert.equal(Number(buy.raw.makingAmount), 7);
    assert.equal(Number(buy.raw.takingAmount), 10);
    assert.equal(sell.status, 'matched');
    assert.equal(Number(sell.raw.makingAmount), 5);
    assert.ok(Math.abs(Number(sell.raw.takingAmount) - 3.4) < 1e-9);
  } finally {
    global.fetch = originalFetch;
  }
});

test('stale cached quotes are not used when the CLOB book has no liquidity', async () => {
  await withBook({ bids: [], asks: [] }, async () => {
    const trader = new DemoTrader();
    trader.updateQuote('token', { bid: 0.68, ask: 0.70 });
    trader.quotes.get('token').updatedAt -= 10_000;
    const buy = await trader.placeFakMarketOrder('token', 'BUY', 10, { priceLimit: 0.90 });
    const sell = await trader.placeFakMarketOrder('token', 'SELL', 10, { priceLimit: 0 });
    assert.equal(buy.status, 'unmatched');
    assert.equal(sell.status, 'unmatched');
  });
});

test('demo trader exposes no wallet or live-order methods', () => {
  const trader = new DemoTrader();
  assert.equal(trader.demoMode, true);
  assert.equal(trader.placeGtcOrder, undefined);
  assert.equal(trader.cancelOrder, undefined);
});
