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

test('new window starts immediately and ignores prior unresolved positions', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  assert.equal(await bot.processStrategyEntry(now), true);
  const previousPosition = bot.positions[0];
  previousPosition.status = 'PENDING_RESOLUTION';

  const nextWindowStart = WINDOW_START + config.WINDOW_MS_5M;
  bot.market.start = nextWindowStart;
  bot.market.end = nextWindowStart + config.WINDOW_MS_5M;
  bot.market.slug = `btc-updown-5m-${nextWindowStart / 1000}`;
  bot.orderWindowStart = nextWindowStart;
  feed.currentCandle = {
    ...feed.currentCandle,
    start: nextWindowStart,
  };
  now = nextWindowStart;
  bot.liveQuotes.UP.updatedAt = now;
  bot.liveQuotes.DOWN.updatedAt = now;
  bot.books.UP.updatedAt = now;
  bot.books.DOWN.updatedAt = now;

  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(previousPosition.status, 'PENDING_RESOLUTION');
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 1);
  assert.equal(bot.positions[0].windowStart, nextWindowStart);
});

test('entry starts immediately when the model and full-size book are ready', async () => {
  let now = WINDOW_START;
  const bot = makeBot({ getNow: () => now });
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

test('take-profit requires all shares, then waits 10 seconds while both feeds stay connected', async () => {
  let now = WINDOW_START + config.ENTRY_DELAY_MS;
  const feed = makeFeed(() => now);
  let binanceStopCount = 0;
  feed.stop = () => { binanceStopCount += 1; };
  const bot = makeBot({ getNow: () => now, feed });
  let polymarketCloseCount = 0;
  bot.marketStream = { close: () => { polymarketCloseCount += 1; } };
  bot.market.tokens = { UP: 'up-token', DOWN: 'down-token' };
  bot.websocket = {
    status: 'CONNECTED',
    connectedAt: now,
    lastMessageAt: now,
    reconnectCount: 0,
    error: null,
  };
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
  const takeProfitFilledAt = now;
  assert.equal(bot.rearmReadyAt, takeProfitFilledAt + config.POST_TP_COOLDOWN_MS);

  now = takeProfitFilledAt + 5_000;
  feed.price = 100.06;
  feed.currentCandle.close = feed.price;
  bot.liveQuotes.UP.updatedAt = now;
  bot.liveQuotes.DOWN.updatedAt = now;
  bot.books.UP.updatedAt = now;
  bot.books.DOWN.updatedAt = now;
  bot.handleMarketMessage({
    event_type: 'book',
    asset_id: 'up-token',
    bids: [{ price: '0.10', size: '100' }],
    asks: [{ price: '0.40', size: '100' }],
    timestamp: String(now),
  });
  assert.equal(bot.liveQuotes.UP.updatedAt, now);
  assert.equal(bot.websocket.status, 'CONNECTED');
  assert.equal(bot.websocket.lastMessageAt, now);
  assert.equal(feed.status, 'CONNECTED');
  assert.equal(binanceStopCount, 0);
  assert.equal(polymarketCloseCount, 0);
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(bot.positions.length, 1);
  assert.match(bot.signal.reason, /waiting 5s/i);

  now = takeProfitFilledAt + config.POST_TP_COOLDOWN_MS;
  bot.liveQuotes.UP.updatedAt = now;
  bot.liveQuotes.DOWN.updatedAt = now;
  bot.books.UP.updatedAt = now;
  bot.books.DOWN.updatedAt = now;
  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.positions.filter((item) => item.status === 'OPEN').length, 1);
});
