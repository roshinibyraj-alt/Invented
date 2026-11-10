'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { predictNextCandle } = require('../candle-predictor');

function candles(direction, count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    openTime: index * 300000,
    closeTime: index * 300000 + 299999,
    open: direction === 'DOWN' ? 101 : 100,
    high: 102,
    low: 99,
    close: direction === 'DOWN' ? 100 : direction === 'FLAT' ? 100 : 101,
    volume: 100,
  }));
}

test('predictor uses five completed candle factors and reports a directional score', () => {
  const prediction = predictNextCandle(candles('UP'));
  assert.equal(prediction.direction, 'BULLISH');
  assert.equal(prediction.side, 'UP');
  assert.equal(prediction.lookback, 5);
  assert.ok(prediction.score > prediction.sensitivity);
  assert.equal(prediction.bars.length, 5);
  assert.equal(prediction.averageBody, 1);
  assert.equal(prediction.averageWick, 2);
  assert.equal(prediction.averageRelativeVolume, 1);
  assert.equal(prediction.latestRelativeVolume, 1);
  assert.equal(prediction.bullishCandles, 5);
});

test('predictor returns DOWN for bearish directional strength', () => {
  const prediction = predictNextCandle(candles('DOWN'));
  assert.equal(prediction.direction, 'BEARISH');
  assert.equal(prediction.side, 'DOWN');
  assert.ok(prediction.score < -prediction.sensitivity);
});

test('neutral doji candles produce no side', () => {
  const prediction = predictNextCandle(candles('FLAT'));
  assert.equal(prediction.direction, 'NEUTRAL');
  assert.equal(prediction.side, null);
  assert.equal(prediction.score, 0);
});

test('predictor uses only the most recent configured candles', () => {
  const input = [...candles('DOWN'), ...candles('UP', 2)];
  const prediction = predictNextCandle(input, { lookback: 2 });
  assert.equal(prediction.bars.length, 2);
  assert.equal(prediction.direction, 'BULLISH');
});

test('predictor rejects missing candles and invalid lookback', () => {
  assert.throws(() => predictNextCandle(candles('UP', 4)), /needs 5 completed candles/);
  assert.throws(() => predictNextCandle(candles('UP'), { lookback: 21 }), /from 2 through 20/);
});
