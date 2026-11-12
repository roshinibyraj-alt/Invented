'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MispricingBot = require('../mispricing-bot');
const config = require('../config');

const { calculateVolatility, estimateUpProbability, calculateTakeProfitLimit, sweepLevels } = MispricingBot._test;
const WINDOW_START = 1_800_000_000_000;

function makeCandles() {
  return [
    { start: WINDOW_START - 15 * 60_000, open: 100, close: 101 },
    { start: WINDOW_START - 10 * 60_000, open: 101, close: 100 },
    { start: WINDOW_START - 5 * 60_000, open: 100, close: 101 },
  ];
}

function makeFeed(getNow) {
  return {
    status: 'CONNECTED',
    historyStatus: 'READY',
    error: null,
    price: 100.05,
    tickAt: getNow(),
    currentCandle: {
      start: WINDOW_START,
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100.05,
      openSource: 'BINANCE_KLINE',
    },
    candles: makeCandles(),
    snapshot() {
      this.tickAt = getNow();
      return { ...this, candles: this.candles.map((candle) => ({ ...candle })) };
    },
    start() {},
    stop() {},
  };
}

function book(price, size = 100) {
  return {
    status: 'LIVE',
    stale: false,
    updatedAt: 0,
    bestAsk: price,
    askSize: size,
    askLevels: [{ price, size }],
    bestBid: 0.1,
    bidSize: 100,
    bidLevels: [{ price: 0.1, size: 100 }],
  };
}

function makeBot({ getNow, feed } = {}) {
  const clock = getNow || (() => WINDOW_START + 10_000);
  const priceFeed = feed || makeFeed(clock);
  const bot = new MispricingBot({
    priceFeed,
    now: clock,
    marketData: {},
  });
  bot.market = {
    id: 'btc-market',
    slug: `btc-updown-5m-${WINDOW_START / 1000}`,
    title: 'BTC Up or Down',
    start: WINDOW_START,
    end: WINDOW_START + config.WINDOW_MS_5M,
  };
  bot.orderWindowStart = WINDOW_START;
  bot.liveQuotes = {
    UP: book(0.4),
    DOWN: book(0.4),
  };
  bot.liveQuotes.UP.updatedAt = clock();
  bot.liveQuotes.DOWN.updatedAt = clock();
  bot.books = {
    UP: { updatedAt: clock() },
    DOWN: { updatedAt: clock() },
  };
  return bot;
}

test('volatility uses the latest three closed candle returns', () => {
  const candles = makeCandles();
  const expected = Math.sqrt(candles.reduce((sum, candle) => {
    const value = Math.log(candle.close / candle.open);
    return sum + value ** 2;
  }, 0) / 3);
  assert.equal(calculateVolatility(candles, 3), expected);
  assert.equal(calculateVolatility(candles.slice(1), 3), null);
});

test('probability is 50% at the window open and rises with price', () => {
  const base = {
    windowOpenPrice: 100,
    volatility5m: 0.01,
    secondsRemaining: 150,
  };
  assert.ok(Math.abs(estimateUpProbability({ ...base, currentPrice: 100 }) - 0.5) < 1e-8);
  assert.ok(estimateUpProbability({ ...base, currentPrice: 101 }) > 0.5);
  assert.ok(estimateUpProbability({ ...base, currentPrice: 99 }) < 0.5);
});

test('take-profit limit targets at least 50% net return after fees', () => {
  const target = calculateTakeProfitLimit({
    market: {},
    shares: 100,
    entryGross: 40,
    entryFees: 0,
  });
  assert.equal(target.possible, true);
  const fee = require('../wick-bot')._test.takerFeeFor({}, target.limitPrice, 100);
  const previousTickFee = require('../wick-bot')._test.takerFeeFor({}, target.limitPrice - config.PRICE_TICK, 100);
  assert.ok(target.limitPrice * 100 - fee >= target.targetNetProceeds - 1e-8);
  assert.ok((target.limitPrice - config.PRICE_TICK) * 100 - previousTickFee < target.targetNetProceeds);
});

test('book sweep refuses partial execution', () => {
  const partial = sweepLevels([{ price: 0.6, size: 99 }], 100, { side: 'SELL', minimumPrice: 0.6, market: {} });
  const full = sweepLevels([{ price: 0.6, size: 100 }], 100, { side: 'SELL', minimumPrice: 0.6, market: {} });
  assert.equal(partial.complete, false);
  assert.equal(partial.filledShares, 99);
  assert.equal(full.complete, true);
  assert.equal(full.filledShares, 100);
});

test('unfilled position blocks new entries until official resolution', async () => {
  let now = WINDOW_START + config.ENTRY_DELAY_MS;
  const bot = makeBot({ getNow: () => now });
  bot.positions.push({
    id: 'prior-window-position',
    status: 'PENDING_RESOLUTION',
    side: 'DOWN',
    windowStart: WINDOW_START - config.WINDOW_MS_5M,
    shares: 100,
  });
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 0);
  assert.match(bot.signal.reason, /official resolution/i);
});

test('entry waits 10 seconds, then buys the best qualifying full-size side', async () => {
  let now = WINDOW_START + 9_999;
  const bot = makeBot({ getNow: () => now });
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(bot.positions.length, 0);

  now = WINDOW_START + config.ENTRY_DELAY_MS;
  bot.liveQuotes.UP.updatedAt = now;
  bot.liveQuotes.DOWN.updatedAt = now;
  bot.books.UP.updatedAt = now;
  bot.books.DOWN.updatedAt = now;
  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, 'UP');
  assert.equal(bot.positions[0].shares, 100);
  assert.equal(bot.positions[0].takeProfitOrder.status, 'RESTING');
});

test('a changed opposite signal does not flip an open position', async () => {
  let now = WINDOW_START + config.ENTRY_DELAY_MS;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  await bot.processStrategyEntry(now);
  const originalCash = bot.cash;

  now += 500;
  feed.price = 99.95;
  feed.currentCandle.close = 99.95;
  bot.liveQuotes.UP.updatedAt = now;
  bot.liveQuotes.DOWN.updatedAt = now;
  bot.books.UP.updatedAt = now;
  bot.books.DOWN.updatedAt = now;
  bot.liveQuotes.UP.bidLevels = [{ price: 0.1, size: 100 }];
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 1);
  assert.equal(bot.positions[0].side, 'UP');
  assert.equal(bot.cash, originalCash);
});

test('take-profit requires all shares and then permits a later re-entry', async () => {
  let now = WINDOW_START + config.ENTRY_DELAY_MS;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  await bot.processStrategyEntry(now);
  const position = bot.positions[0];
  const limit = position.takeProfitOrder.limitPrice;

  now += 500;
  bot.liveQuotes.UP.updatedAt = now;
  bot.books.UP.updatedAt = now;
  bot.liveQuotes.UP.bidLevels = [{ price: limit, size: 99 }];
  const cashBeforePartial = bot.cash;
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(position.status, 'OPEN');
  assert.equal(bot.cash, cashBeforePartial);

  now += 500;
  bot.liveQuotes.UP.updatedAt = now;
  bot.books.UP.updatedAt = now;
  bot.liveQuotes.UP.bidLevels = [{ price: limit, size: 100 }];
  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.ok(position.realizedPnl >= (position.initialTotalCost + position.initialFees) * 0.5 - 1e-6);

  now += config.POLL_INTERVAL_MS + 1;
  bot.liveQuotes.UP.updatedAt = now;
  bot.liveQuotes.DOWN.updatedAt = now;
  bot.books.UP.updatedAt = now;
  bot.books.DOWN.updatedAt = now;
  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.positions.filter((item) => item.status === 'OPEN').length, 1);
});
