'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CcxtPriceFeed = require('../ccxt-feed');

test('normalizes a spot ticker to its bid/ask midpoint and falls back to last', () => {
  assert.equal(CcxtPriceFeed.priceFromTicker({ bid: '80000', ask: '80002', last: '80001' }), 80001);
  assert.equal(CcxtPriceFeed.priceFromTicker({ bid: null, ask: null, last: '80003' }), 80003);
  assert.equal(CcxtPriceFeed.priceFromTicker({ bid: 0, ask: 0, last: null }), null);
});

test('polls an injected CCXT exchange and emits a timestamped BTC sample', async () => {
  let calls = 0;
  let closeCalls = 0;
  const exchange = {
    async fetchTicker(symbol) {
      calls += 1;
      assert.equal(symbol, 'BTC/USD');
      return { bid: 80000, ask: 80002, last: 80001, timestamp: 1234 };
    },
    close() { closeCalls += 1; },
  };
  const feed = new CcxtPriceFeed({
    exchangeId: 'kraken', symbol: 'BTC/USD', pollMs: 500, exchange,
  });

  let stop;
  const sample = await new Promise((resolve, reject) => {
    stop = feed.start((value) => { stop(); resolve(value); }, reject);
  });
  assert.equal(calls, 1);
  assert.equal(sample.price, 80001);
  assert.equal(sample.exchange, 'kraken');
  assert.equal(sample.symbol, 'BTC/USD');
  assert.ok(sample.sampledAt > 0);
  assert.ok(sample.receivedAt > 0);
  assert.equal(sample.exchangeTimestamp, 1234);
  assert.equal(closeCalls, 1);
});

test('chooses USD-denominated Kraken and USDT-denominated Binance defaults', () => {
  assert.equal(CcxtPriceFeed.defaultSymbol('kraken'), 'BTC/USD');
  assert.equal(CcxtPriceFeed.defaultSymbol('coinbase'), 'BTC/USD');
  assert.equal(CcxtPriceFeed.defaultSymbol('binance'), 'BTC/USDT');
});

test('does not poll faster than the exchange rate limit', () => {
  const feed = new CcxtPriceFeed({
    exchangeId: 'kraken', symbol: 'BTC/USD', pollMs: 500,
    exchange: { rateLimit: 1000, async fetchTicker() { return { last: 1 }; } },
  });
  assert.equal(feed.requestedPollMs, 500);
  assert.equal(feed.pollMs, 1000);
});