'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Bot = require('../freqai-btc-bot');

function setup({ offset = 85_000, prediction = null, candle = null } = {}) {
  const start = 1_800_000_000_000;
  const now = start + offset;
  const worker = { snapshot: () => ({ status: 'READY', lastPrediction: prediction }) };
  const binanceFeed = candle
    ? { currentCandle: { start, open: 100, close: 99, ...candle }, tickAt: now }
    : null;
  const bot = new Bot({
    now: () => now,
    initialCapital: 3000,
    freqaiWorker: worker,
    binanceFeed,
    marketData: {},
  });
  const record = bot.records.get('BTC:5m');
  record.market = {
    id: 'btc-5m-test',
    slug: 'btc-updown-5m-test',
    title: 'Bitcoin Up or Down',
    start,
    end: start + 300_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    feeSchedule: { rate: 0.05 },
  };
  record.marketStatus = 'OPEN';
  const quote = {
    bestBid: 0.39,
    bestAsk: 0.40,
    updatedAt: now,
    asks: [{ price: 0.40, size: 30 }, { price: 0.41, size: 25 }],
  };
  return { bot, record, quote, now, start };
}

test('uses the higher FreqAI probability and buys only once per window', () => {
  const { bot, record, quote, now, start } = setup({
    prediction: {
      windowStart: 1_800_000_000_000,
      candleStart: 1_800_000_060_000,
      candleCloseAt: 1_800_000_120_000,
      pUp: 0.68,
      pDown: 0.32,
      model: 'LightGBMClassifier',
    },
  });

  bot.processSide(record, 'DOWN', quote, 1);
  assert.equal(bot.orders.length, 0);
  bot.processSide(record, 'UP', quote, 2);
  bot.processSide(record, 'DOWN', quote, 3);

  assert.equal(bot.orders.length, 1);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, 'UP');
  assert.equal(bot.positions[0].shares, 50);
  assert.equal(bot.positions[0].signalSource, 'FREQAI');
  assert.equal(bot.positions[0].windowStart, start);
  assert.equal(bot.orders[0].status, 'FILLED');
  assert.equal(bot.orders[0].filledShares, 50);
  assert.ok(bot.cash < 3000);
  assert.equal(bot.positions[0].status, 'OPEN');
  assert.equal(bot.now(), now);
});

test('uses a fresh Binance warm-up direction if FreqAI has no current score', () => {
  const { bot, record, quote } = setup({
    prediction: null,
    candle: { open: 100, close: 99 },
  });
  quote.bestBid = 0.56;
  quote.bestAsk = 0.57;
  quote.asks = [{ price: 0.57, size: 50 }];

  bot.processSide(record, 'DOWN', quote, 1);

  assert.equal(bot.orders.length, 1);
  assert.equal(bot.positions[0].side, 'DOWN');
  assert.equal(bot.positions[0].signalSource, 'BINANCE_WARMUP_FALLBACK');
  assert.equal(bot.modelStatus, 'WARMUP_FALLBACK');
});

test('waits through the first minute and will not invent a fill without asks', () => {
  const { bot, record, quote } = setup({
    offset: 60_000,
    prediction: {
      windowStart: 1_800_000_000_000,
      candleStart: 1_800_000_060_000,
      candleCloseAt: 1_800_000_120_000,
      pUp: 0.6,
      pDown: 0.4,
    },
  });
  bot.processSide(record, 'UP', quote, 1);
  assert.equal(bot.orders.length, 0);
  assert.equal(record.sideStates.UP.orderStatus, 'WAITING_FOR_FIRST_MINUTE');
});

test('does not close an open position through old take-profit or stop-loss rules', () => {
  const { bot, record, quote } = setup({
    prediction: {
      windowStart: 1_800_000_000_000,
      candleStart: 1_800_000_060_000,
      candleCloseAt: 1_800_000_120_000,
      pUp: 0.6,
      pDown: 0.4,
    },
  });
  bot.processSide(record, 'UP', quote, 1);
  const position = bot.positions[0];

  bot.checkTakeProfits(record, 'UP', { bestBid: 0.99 }, bot.now());
  bot.checkStopLosses(record, 'UP', { bestBid: 0 }, bot.now());

  assert.equal(position.status, 'OPEN');
});
