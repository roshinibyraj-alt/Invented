'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Bot = require('../freqai-btc-bot');

function setup({ offset = 85_000, prediction = null, candle = null } = {}) {
  const start = 1_800_000_000_000;
  const now = start + offset;
  let latestPrediction = prediction;
  const worker = { snapshot: () => ({ status: 'READY', lastPrediction: latestPrediction }) };
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
  return { bot, record, quote, now, start, worker,
    setPrediction(value) { latestPrediction = value; } };
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
  assert.equal(bot.accountSnapshot().settledPositions, 0);
  assert.equal(bot.now(), now);
});

test('persists one timestamped audit row for each score and marks the initial entry', () => {
  const { bot, record, quote, start } = setup({
    prediction: {
      windowStart: 1_800_000_000_000,
      candleStart: 1_800_000_060_000,
      candleCloseAt: 1_800_000_120_000,
      writtenAt: 1_800_000_085_000,
      pUp: 0.68,
      pDown: 0.32,
      model: 'LightGBMClassifier',
    },
  });
  bot.processSide(record, 'UP', quote, 1);
  bot.processSide(record, 'UP', { ...quote, sequence: 2 }, 2);
  const state = bot.snapshot();
  assert.equal(state.freqai.auditTrail.length, 1);
  assert.equal(state.freqai.auditTrail[0].predictionAt, 1_800_000_085_000);
  assert.equal(state.freqai.auditTrail[0].predictedSide, 'UP');
  assert.equal(state.freqai.auditTrail[0].status, 'ENTRY_EXECUTED');
  assert.equal(state.freqai.auditTrail[0].checks.at(-1).status, 'ENTRY_EXECUTED');
  assert.equal(state.strategy.id, Bot.STRATEGY.id);
  assert.equal(start, 1_800_000_000_000);
});

test('records a qualified reversal and whether its book checks allowed the flip', () => {
  const { bot, record, quote, now, start, setPrediction } = setup({
    prediction: {
      windowStart: 1_800_000_000_000,
      candleStart: 1_800_000_060_000,
      candleCloseAt: 1_800_000_120_000,
      writtenAt: 1_800_000_085_000,
      pUp: 0.70,
      pDown: 0.30,
    },
  });
  bot.processSide(record, 'UP', quote, 1);
  const heldBook = {
    ...quote, bestBid: 0.39, bestAsk: 0.40, updatedAt: now, sequence: 2,
    bids: [{ price: 0.39, size: 500 }],
    asks: [{ price: 0.40, size: 500 }],
  };
  const oppositeBook = {
    ...quote, bestBid: 0.59, bestAsk: 0.60, updatedAt: now, sequence: 3,
    bids: [{ price: 0.59, size: 500 }],
    asks: [{ price: 0.60, size: 1000 }],
  };
  record.quotes.UP = heldBook;
  record.quotes.DOWN = oppositeBook;
  setPrediction({
    windowStart: start,
    candleStart: start + 60_000,
    candleCloseAt: start + 120_000,
    writtenAt: now + 1000,
    pUp: 0.30,
    pDown: 0.70,
  });
  bot.processSide(record, 'DOWN', oppositeBook, 3);
  const audit = bot.snapshot().freqai.auditTrail[0];
  assert.equal(audit.flipQualified, true);
  assert.equal(audit.heldSide, 'UP');
  assert.equal(audit.oppositeProbability, 0.70);
  assert.equal(audit.status, 'FLIP_EXECUTED');
  assert.ok(audit.checks.some((check) => check.status === 'FLIP_SIGNAL_QUALIFIED'));
  assert.equal(bot.positions.some((position) => position.status === 'CLOSED_FLIP'), true);
});

test('records a qualifying reversal blocked by unavailable held-side bids', () => {
  const { bot, record, quote, now, start, setPrediction } = setup({
    prediction: {
      windowStart: 1_800_000_000_000,
      candleStart: 1_800_000_060_000,
      writtenAt: 1_800_000_085_000,
      pUp: 0.70,
      pDown: 0.30,
    },
  });
  bot.processSide(record, 'UP', quote, 1);
  record.quotes.UP = { ...quote, updatedAt: now, sequence: 2, bids: [] };
  const oppositeBook = { ...quote, updatedAt: now, sequence: 3, asks: [{ price: 0.40, size: 500 }] };
  record.quotes.DOWN = oppositeBook;
  setPrediction({
    windowStart: start,
    candleStart: start + 60_000,
    writtenAt: now + 1000,
    pUp: 0.35,
    pDown: 0.65,
  });
  bot.processSide(record, 'DOWN', oppositeBook, 3);
  const audit = bot.snapshot().freqai.auditTrail[0];
  assert.equal(audit.flipQualified, true);
  assert.equal(audit.status, 'WAITING_FOR_HELD_BIDS');
  assert.match(audit.reason, /fresh visible bids/);
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

test('restoring an older open position does not count it as settled', () => {
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
  const ledger = bot.exportLedger();
  ledger.snapshot.positions[0].realizedPnl = 0;

  const restored = new Bot({ now: () => bot.now(), initialCapital: 3000, marketData: {} });
  restored.restoreLedger(ledger);

  assert.equal(restored.positions[0].status, 'OPEN');
  assert.equal(restored.positions[0].realizedPnl, null);
  assert.equal(restored.accountSnapshot().settledPositions, 0);
});
