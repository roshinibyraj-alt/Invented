'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSignal } = require('../candles');

const GRANULARITY = 300;
const STREAK_LEN = 3;

function makeCandles(closes, startTs = 0) {
  return closes.map((close, index) => ({
    openTs: startTs + index * GRANULARITY,
    close,
  }));
}

function evaluate(closes, startTs = 0) {
  const candles = makeCandles(closes, startTs);
  const windowOpenTs = candles[candles.length - 1].openTs + GRANULARITY;
  return evaluateSignal(candles, windowOpenTs);
}

test('three rising close-to-close BTC prices signal a DOWN bet', () => {
  const result = evaluate([100, 101, 102, 103]);
  assert.equal(result.ready, true);
  assert.deepEqual(result.priceMoves, ['UP', 'UP', 'UP']);
  assert.equal(result.side, 'DOWN');
});

test('three falling close-to-close BTC prices signal an UP bet', () => {
  const result = evaluate([103, 102, 101, 100]);
  assert.equal(result.ready, true);
  assert.deepEqual(result.priceMoves, ['DOWN', 'DOWN', 'DOWN']);
  assert.equal(result.side, 'UP');
});

test('mixed and flat close-to-close moves do not count as a streak', () => {
  assert.equal(evaluate([100, 101, 100, 101]).side, null);
  assert.deepEqual(evaluate([100, 101, 101, 102]).priceMoves, ['UP', 'FLAT', 'UP']);
  assert.equal(evaluate([100, 101, 101, 102]).side, null);
});

test('requires four closed prices for three consecutive moves', () => {
  const result = evaluate([100, 101, 102]);
  assert.equal(result.ready, false);
  assert.match(result.reason, /need 4 for 3 price moves/);
});

test('does not signal across a gap in candle data', () => {
  const candles = makeCandles([100, 101, 102, 103]);
  candles[2].openTs += GRANULARITY;
  const windowOpenTs = candles[candles.length - 1].openTs + GRANULARITY;
  const result = evaluateSignal(candles, windowOpenTs);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'gap in candle data');
});

test('waits until the latest closed candle is available', () => {
  const candles = makeCandles([100, 101, 102, 103]);
  const result = evaluateSignal(candles, candles[candles.length - 1].openTs + 2 * GRANULARITY);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'latest closed candle not published yet');
});

test('rejects invalid close prices rather than silently counting them', () => {
  const result = evaluate([100, 101, NaN, 103]);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'invalid candle close price');
});