'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MispricingBot = require('../mispricing-bot');
const config = require('../config');

const { calculateVolatility, estimateUpProbability, sweepLevels } = MispricingBot._test;
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

function levels(items) {
  return items.map(({ price, size }) => ({
    price,
    size,
    availableSize: size,
  }));
}

function setBook(bot, side, { asks, bids }, updatedAt) {
  const normalizedAsks = levels(asks).sort((a, b) => a.price - b.price);
  const normalizedBids = levels(bids).sort((a, b) => b.price - a.price);
  const book = {
    asks: normalizedAsks,
    bids: normalizedBids,
    updatedAt,
    sourceTimestamp: updatedAt,
  };
  bot.books[side] = book;
  const ask = normalizedAsks[0];
  const bid = normalizedBids[0];
  bot.liveQuotes[side] = {
    status: ask || bid ? 'LIVE' : 'MISSING',
    stale: false,
    bestAsk: ask?.price ?? null,
    askSize: ask?.availableSize ?? 0,
    bestBid: bid?.price ?? null,
    bidSize: bid?.availableSize ?? 0,
    askLevels: normalizedAsks.map((level) => ({ ...level })),
    bidLevels: normalizedBids.map((level) => ({ ...level })),
    updatedAt,
  };
}

function refreshQuotes(bot, now) {
  for (const side of ['UP', 'DOWN']) {
    setBook(bot, side, {
      asks: bot.books[side].asks,
      bids: bot.books[side].bids,
    }, now);
  }
}

function makeBot({ getNow, feed } = {}) {
  const clock = getNow || (() => WINDOW_START);
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
  setBook(bot, 'UP', { asks: [{ price: 0.4, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, clock());
  setBook(bot, 'DOWN', { asks: [{ price: 0.4, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, clock());
  return bot;
}

function setPrice(feed, price) {
  feed.price = price;
  feed.currentCandle.close = price;
}

function setFlipBook(bot, now, { exitBid = 0.6, exitSize = 100, oppositeAsk = 0.4, askSize = 100 } = {}) {
  setBook(bot, 'UP', {
    asks: [{ price: 0.4, size: 100 }],
    bids: [{ price: exitBid, size: exitSize }],
  }, now);
  setBook(bot, 'DOWN', {
    asks: [{ price: oppositeAsk, size: askSize }],
    bids: [{ price: 0.1, size: 100 }],
  }, now);
}

test('volatility uses exactly the latest two closed candle returns', () => {
  const candles = makeCandles();
  const sample = candles.slice(-config.VOLATILITY_CANDLES);
  const expected = Math.sqrt(sample.reduce((sum, candle) => {
    const value = Math.log(candle.close / candle.open);
    return sum + value ** 2;
  }, 0) / config.VOLATILITY_CANDLES);
  assert.equal(config.VOLATILITY_CANDLES, 2);
  assert.equal(calculateVolatility(candles), expected);
  assert.equal(calculateVolatility(candles.slice(-1)), null);
});

test('probability is 50% at the window open and follows price direction', () => {
  const base = {
    windowOpenPrice: 100,
    volatility5m: 0.01,
    secondsRemaining: 150,
  };
  assert.ok(Math.abs(estimateUpProbability({ ...base, currentPrice: 100 }) - 0.5) < 1e-8);
  assert.ok(estimateUpProbability({ ...base, currentPrice: 101 }) > 0.5);
  assert.ok(estimateUpProbability({ ...base, currentPrice: 99 }) < 0.5);
});

test('book sweeps require all requested shares', () => {
  const partial = sweepLevels([{ price: 0.6, size: 99 }], 100, { side: 'SELL', market: {} });
  const full = sweepLevels([{ price: 0.6, size: 100 }], 100, { side: 'SELL', market: {} });
  assert.equal(partial.complete, false);
  assert.equal(partial.filledShares, 99);
  assert.equal(full.complete, true);
  assert.equal(full.filledShares, 100);
});

test('entry buys 100 shares immediately when the full-size net edge qualifies', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  feed.currentCandle.openSource = 'FIRST_TICK';
  const bot = makeBot({ getNow: () => now, feed });
  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, 'UP');
  assert.equal(bot.positions[0].shares, 100);
  assert.equal(bot.positions[0].status, 'OPEN');
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].action, 'BUY');
  assert.equal(bot.orders.some((order) => order.action === 'SELL'), false);
});

test('entry waits instead of recording a partial buy', async () => {
  let now = WINDOW_START;
  const bot = makeBot({ getNow: () => now });
  setBook(bot, 'UP', {
    asks: [{ price: 0.4, size: 99 }],
    bids: [{ price: 0.1, size: 100 }],
  }, now);
  setBook(bot, 'DOWN', {
    asks: [{ price: 0.4, size: 99 }],
    bids: [{ price: 0.1, size: 100 }],
  }, now);

  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders.length, 0);
});

test('an open position does not take profit without a qualifying opposite signal', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  await bot.processStrategyEntry(now);
  const original = bot.positions[0];

  now += 500;
  setPrice(feed, 100.2);
  setBook(bot, 'UP', {
    asks: [{ price: 0.4, size: 100 }],
    bids: [{ price: 0.99, size: 100 }],
  }, now);
  setBook(bot, 'DOWN', {
    asks: [{ price: 0.99, size: 100 }],
    bids: [{ price: 0.1, size: 100 }],
  }, now);

  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(original.status, 'OPEN');
  assert.equal(bot.orders.some((order) => order.action === 'SELL'), false);
});

test('profitable opposite signal flips only after two fresh Binance updates', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  assert.equal(await bot.processStrategyEntry(now), true);
  const original = bot.positions[0];

  now += 500;
  setPrice(feed, 99.8);
  setFlipBook(bot, now);
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(bot.flipConfirmation.count, 1);
  assert.equal(original.status, 'OPEN');

  now += 500;
  refreshQuotes(bot, now);
  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(original.status, 'CLOSED');
  assert.equal(original.exitReason, 'PROFITABLE_MODEL_FLIP');
  assert.ok(original.realizedPnl > 0);
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 1);
  assert.equal(bot.positions.find((position) => position.status === 'OPEN').side, 'DOWN');
  assert.equal(bot.flipsThisWindow, 1);
  assert.equal(bot.orders.filter((order) => order.action === 'SELL').length, 1);
  assert.equal(bot.orders.filter((order) => order.action === 'BUY').length, 2);
});

test('flip confirmations require 500 ms spacing and reset after a 2-second gap', () => {
  const bot = makeBot();
  const first = WINDOW_START + 1_000;
  assert.equal(bot.recordFlipConfirmation('DOWN', { tickAt: first }, first), false);
  assert.equal(bot.recordFlipConfirmation('DOWN', { tickAt: first + 400 }, first + 400), false);
  assert.equal(bot.flipConfirmation.count, 1);
  assert.equal(bot.recordFlipConfirmation('DOWN', { tickAt: first + 500 }, first + 500), true);
  assert.equal(bot.flipConfirmation.count, 2);

  const afterGap = first + 2_501;
  assert.equal(bot.recordFlipConfirmation('DOWN', { tickAt: afterGap }, afterGap), false);
  assert.equal(bot.flipConfirmation.count, 1);
});

test('does not flip when the current position cannot be sold profitably after fees', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  await bot.processStrategyEntry(now);
  const position = bot.positions[0];

  now += 500;
  setPrice(feed, 99.8);
  setFlipBook(bot, now, { exitBid: 0.3 });
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(position.status, 'OPEN');
  assert.equal(bot.flipConfirmation.count, 0);
  assert.match(bot.signal.reason, /would not be profitable after fees/i);
});

test('does not flip when the opposite entry edge is below 10 cents per share', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  await bot.processStrategyEntry(now);
  const position = bot.positions[0];

  now += 500;
  setPrice(feed, 99.99);
  setFlipBook(bot, now);
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(position.status, 'OPEN');
  assert.equal(bot.flipConfirmation.count, 0);
  assert.match(bot.signal.reason, /needs at least \$0\.10 net edge/i);
});

test('does not sell partially when the full current-side bid sweep is unavailable', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  await bot.processStrategyEntry(now);
  const position = bot.positions[0];

  now += 500;
  setPrice(feed, 99.8);
  setFlipBook(bot, now, { exitBid: 0.6, exitSize: 99 });
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(position.status, 'OPEN');
  assert.equal(bot.orders.some((order) => order.action === 'SELL'), false);
  assert.match(bot.signal.reason, /cannot sell all shares/i);
});

test('does not sell if the full opposite-side ask sweep is unavailable', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  await bot.processStrategyEntry(now);
  const position = bot.positions[0];

  now += 500;
  setPrice(feed, 99.8);
  setFlipBook(bot, now, { exitBid: 0.6, oppositeAsk: 0.4, askSize: 99 });
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(position.status, 'OPEN');
  assert.equal(bot.orders.some((order) => order.action === 'SELL'), false);
});

test('only one flip is allowed in a window', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  await bot.processStrategyEntry(now);

  now += 500;
  setPrice(feed, 99.8);
  setFlipBook(bot, now);
  await bot.processStrategyEntry(now);
  now += 500;
  refreshQuotes(bot, now);
  await bot.processStrategyEntry(now);
  const flippedPosition = bot.positions.find((position) => position.status === 'OPEN');
  assert.equal(flippedPosition.side, 'DOWN');

  now += 500;
  setPrice(feed, 100.2);
  setBook(bot, 'UP', {
    asks: [{ price: 0.4, size: 100 }],
    bids: [{ price: 0.1, size: 100 }],
  }, now);
  setBook(bot, 'DOWN', {
    asks: [{ price: 0.4, size: 100 }],
    bids: [{ price: 0.6, size: 100 }],
  }, now);
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(bot.flipsThisWindow, 1);
  assert.equal(flippedPosition.status, 'OPEN');
  assert.equal(bot.orders.filter((order) => order.action === 'SELL').length, 1);
});

test('new window starts immediately despite an older unresolved position', async () => {
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
  feed.currentCandle = { ...feed.currentCandle, start: nextWindowStart };
  now = nextWindowStart;
  refreshQuotes(bot, now);

  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(previousPosition.status, 'PENDING_RESOLUTION');
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 1);
  assert.equal(bot.positions[0].windowStart, nextWindowStart);
});

test('strategy snapshot reports the source flip rules and no take-profit policy', () => {
  const bot = makeBot();
  const state = bot.snapshot();
  assert.equal(state.strategy.volatilityLookbackCandles, 2);
  assert.equal(state.strategy.minimumNetEdgePerShare, 0.05);
  assert.equal(state.strategy.minimumFlipNetEdgePerShare, 0.1);
  assert.equal(state.strategy.flipConfirmationUpdates, 2);
  assert.equal(state.strategy.maximumFlipsPerWindow, 1);
  assert.equal(state.strategy.exit.flip.enabled, true);
  assert.equal(state.strategy.takeProfitNetReturn, undefined);
  assert.equal(state.rearm, undefined);
});
