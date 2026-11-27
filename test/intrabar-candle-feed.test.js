'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BinanceTickFeed = require('../binance-tick-feed');

test('publishes fresh streamed one-minute OHLCV atomically for the FreqAI worker', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-live-candle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const minuteStart = 1_800_000_060_000;
  let now = minuteStart + 6000;
  const output = path.join(dir, 'freqai', 'intrabar.json');
  const feed = new BinanceTickFeed({ now: () => now, fetchImpl: null, WebSocketImpl: null,
    intrabarCandlePath: output });
  feed.handleMessage(JSON.stringify({ p: '100', q: '.5', T: minuteStart + 1000, m: false }));
  now += 5000;
  feed.handleMessage(JSON.stringify({ p: '102', q: '.25', T: minuteStart + 6000, m: true }));
  assert.equal(feed.publishIntrabarCandle(), true);
  const candle = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual({
    start: candle.start, open: candle.open, high: candle.high, low: candle.low,
    close: candle.close, volume: candle.volume, observedAt: candle.observedAt,
  }, { start: minuteStart, open: 100, high: 102, low: 100, close: 102,
    volume: .75, observedAt: now });
  assert.equal(fs.readdirSync(path.dirname(output)).some(name => name.endsWith('.tmp')), false);
  feed.stop();
});

test('refuses stale or previous-minute Binance candles', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-live-candle-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const minuteStart = 1_800_000_060_000;
  let now = minuteStart + 25_000;
  const feed = new BinanceTickFeed({ now: () => now, fetchImpl: null, WebSocketImpl: null,
    intrabarCandlePath: path.join(dir, 'intrabar.json') });
  feed.handleMessage(JSON.stringify({ p: '100', q: '.5', T: minuteStart + 1000, m: false }));
  now = minuteStart + 70_000;
  assert.equal(feed.publishIntrabarCandle(), false);
  assert.equal(fs.existsSync(path.join(dir, 'intrabar.json')), false);
  feed.stop();
});

test('uses Binance one-minute kline open and cumulative volume when refreshing the active bar', async () => {
  const start = 1_800_000_060_000;
  let now = start + 20_000;
  const feed = new BinanceTickFeed({
    now: () => now, WebSocketImpl: null, fetchImpl: async url => ({
      ok: true,
      json: async () => url.includes('interval=1m')
        ? [[start, '99', '103', '98', '102', '12']]
        : [],
    }),
  });
  feed.handleMessage(JSON.stringify({ p: '101', q: '.5', T: start + 10_000, m: false }));
  await feed.refreshMinuteHistory();
  assert.deepEqual({
    start: feed.currentMinuteCandle.start,
    open: feed.currentMinuteCandle.open,
    high: feed.currentMinuteCandle.high,
    low: feed.currentMinuteCandle.low,
    close: feed.currentMinuteCandle.close,
    volume: feed.currentMinuteCandle.volume,
  }, { start, open: 99, high: 103, low: 98, close: 101, volume: 12 });
  feed.stop();
});
