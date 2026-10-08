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

test('resting paper limit BUY fills only visible asks at or below limit and does not reuse unchanged depth', async () => {
  let book = { bids: [], asks: [{ price: '0.39', size: '4' }, { price: '0.40', size: '10' }, { price: '0.41', size: '100' }] };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => book });
  try {
    const trader = new DemoTrader();
    const order = { consumedByPrice: {}, lastBookSignature: null };
    const first = await trader.simulateLimitBuy('token', 10, 0.40, order);
    assert.equal(first.shares, 10);
    assert.ok(Math.abs(first.avgPrice - 0.396) < 1e-9);
    assert.ok(Math.abs(first.notional - 3.96) < 1e-9);
    assert.equal(order.consumedByPrice['0.3900'], 4);
    assert.equal(order.consumedByPrice['0.4000'], 6);

    const unchanged = await trader.simulateLimitBuy('token', 5, 0.40, order);
    assert.equal(unchanged.shares, 0);
    assert.equal(unchanged.unchangedBook, true);

    book = { bids: [], asks: [{ price: '0.39', size: '10' }, { price: '0.40', size: '10' }] };
    const changed = await trader.simulateLimitBuy('token', 5, 0.40, order);
    assert.equal(changed.shares, 5);
    assert.equal(changed.avgPrice, 0.39);
  } finally {
    global.fetch = originalFetch;
  }
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

test('price-only cached quotes do not invent executable depth when the REST book is unavailable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('book unavailable'); };
  try {
    const trader = new DemoTrader();
    trader.updateQuote('token', { bid: 0.68, ask: 0.70 });
    const buy = await trader.placeFakMarketOrder('token', 'BUY', 7, { priceLimit: 0.90 });
    const sell = await trader.placeFakMarketOrder('token', 'SELL', 5, { priceLimit: 0 });
    assert.equal(buy.status, 'unmatched');
    assert.equal(Number(buy.raw.makingAmount), 0);
    assert.equal(sell.status, 'unmatched');
    assert.equal(Number(sell.raw.makingAmount), 0);
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
