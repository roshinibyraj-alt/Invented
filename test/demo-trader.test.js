'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DemoTrader = require('../demo-trader');

test('reads public CLOB books and stores quotes without exposing order execution', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/clob\.polymarket\.com\/book\?token_id=/);
    return {
      ok: true,
      json: async () => ({ bids: [{ price: '0.44', size: '3' }], asks: [{ price: '0.46', size: '7' }] }),
    };
  };
  try {
    const trader = new DemoTrader();
    const book = await trader.getOrderBook('token');
    assert.equal(book.bids[0].price, '0.44');
    assert.equal(book.asks[0].size, '7');
    trader.updateQuote('token', { bid: 0.44, ask: 0.46 });
    assert.deepEqual(trader.quotes.get('token'), {
      bid: 0.44, ask: 0.46, updatedAt: trader.quotes.get('token').updatedAt,
    });
    assert.equal(trader.demoMode, true);
    assert.equal(trader.simulateLimitBuy, undefined);
    assert.equal(trader.placeFakMarketOrder, undefined);
    assert.equal(trader.placeGtcOrder, undefined);
    assert.equal(trader.cancelOrder, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('unavailable public book returns null and never fabricates depth from a cached quote', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('book unavailable'); };
  try {
    const trader = new DemoTrader();
    trader.updateQuote('token', { bid: 0.68, ask: 0.70 });
    assert.equal(await trader.getOrderBook('token'), null);
    assert.equal(trader.simulateLimitBuy, undefined);
    assert.equal(trader.placeFakMarketOrder, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});
