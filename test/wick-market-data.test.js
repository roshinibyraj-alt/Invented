'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const marketData = require('../wick-market-data');

test('Binance candle loader requests the five-minute window and filters unfinished candles', async () => {
  const start = 1_800_000_000_000;
  const rows = Array.from({ length: 6 }, (_, index) => {
    const openTime = start - (6 - index) * 300000;
    return [openTime, '100', '102', '99', '101', '250', openTime + 299999];
  });
  rows[5] = [start, '101', '103', '100', '102', '300', start + 299999];
  const originalFetch = global.fetch;
  let requestedUrl;
  global.fetch = async url => {
    requestedUrl = new URL(url);
    return { ok: true, json: async () => rows };
  };
  try {
    const candles = await marketData.getBinanceCandles('BTC', start, 5);
    assert.equal(requestedUrl.hostname, 'data-api.binance.vision');
    assert.equal(requestedUrl.searchParams.get('symbol'), 'BTCUSDT');
    assert.equal(requestedUrl.searchParams.get('interval'), '5m');
    assert.equal(requestedUrl.searchParams.get('endTime'), String(start - 1));
    assert.equal(candles.length, 5);
    assert.ok(candles.every(candle => candle.closeTime < start));
  } finally {
    global.fetch = originalFetch;
  }
});

test('Binance candle loader rejects unsupported assets', async () => {
  await assert.rejects(marketData.getBinanceCandles('SOL', 1_800_000_000_000, 5), /Unsupported candle asset/);
});
