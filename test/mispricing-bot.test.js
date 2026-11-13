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

test('UP and DOWN can both enter independently when each net edge qualifies below 0.50', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  feed.currentCandle.openSource = 'FIRST_TICK';
  const bot = makeBot({ getNow: () => now, feed });
  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(bot.positions.length, 2);
  assert.deepEqual(bot.positions.map((position) => position.side).sort(), ['DOWN', 'UP']);
  assert.ok(bot.positions.every((position) => position.shares === 100));
  assert.ok(bot.positions.every((position) => position.status === 'OPEN'));
  assert.ok(bot.positions.every((position) => position.takeProfitPrice === 0.6));
  assert.equal(bot.orders.filter((order) => order.action === 'BUY').length, 2);
  assert.equal(bot.orders.filter((order) => order.action === 'SELL' && order.status === 'RESTING').length, 2);
});

test('entries require an ask strictly below 0.50 and a qualifying model edge', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  setBook(bot, 'UP', { asks: [{ price: 0.5, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, now);
  setBook(bot, 'DOWN', { asks: [{ price: 0.5, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, now);
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(bot.positions.length, 0);

  now += 500;
  setPrice(feed, 101);
  setBook(bot, 'UP', { asks: [{ price: 0.49, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, now);
  setBook(bot, 'DOWN', { asks: [{ price: 0.8, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, now);
  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, 'UP');
  assert.equal(bot.positions[0].entryPrice, 0.49);
});

test('entry does not sweep asks at or above 0.50 to complete a full position', async () => {
  const now = WINDOW_START;
  const bot = makeBot({ getNow: () => now });
  for (const side of ['UP', 'DOWN']) {
    setBook(bot, side, {
      asks: [{ price: 0.49, size: 99 }, { price: 0.5, size: 100 }],
      bids: [{ price: 0.1, size: 100 }],
    }, now);
  }
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders.length, 0);
});

test('take-profit waits for the full position to sell at or above its target', async () => {
  let now = WINDOW_START;
  const bot = makeBot({ getNow: () => now });
  setBook(bot, 'DOWN', { asks: [{ price: 0.8, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, now);
  await bot.processStrategyEntry(now);
  const position = bot.positions[0];
  const takeProfitOrder = position.takeProfitOrder;
  assert.equal(position.side, 'UP');
  assert.equal(takeProfitOrder.status, 'RESTING');
  assert.equal(takeProfitOrder.limitPrice, 0.6);

  now += 500;
  setBook(bot, 'UP', {
    asks: [{ price: 0.4, size: 100 }],
    bids: [{ price: 0.599, size: 100 }],
  }, now);
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(position.status, 'OPEN');
  assert.equal(takeProfitOrder.status, 'RESTING');

  now += 500;
  setBook(bot, 'UP', {
    asks: [{ price: 0.4, size: 100 }],
    bids: [{ price: 0.6, size: 99 }, { price: 0.59, size: 1 }],
  }, now);
  assert.equal(await bot.processStrategyEntry(now), false);
  assert.equal(position.status, 'OPEN');
  assert.equal(takeProfitOrder.status, 'RESTING');

  now += 500;
  setBook(bot, 'UP', {
    asks: [{ price: 0.4, size: 100 }],
    bids: [{ price: 0.61, size: 100 }],
  }, now);
  assert.equal(await bot.processStrategyEntry(now), true);
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitReason, 'TAKE_PROFIT');
  assert.equal(takeProfitOrder.status, 'FILLED');
  assert.equal(takeProfitOrder.averagePrice, 0.61);
  assert.ok(position.realizedPnl > 0);
});

test('unfilled take-profit is cancelled at window end while the position waits for resolution', async () => {
  const now = WINDOW_START;
  const bot = makeBot({ getNow: () => now });
  setBook(bot, 'DOWN', { asks: [{ price: 0.8, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, now);
  assert.equal(await bot.processStrategyEntry(now), true);
  const position = bot.positions.find((item) => item.side === 'UP');
  assert.equal(position.takeProfitOrder.status, 'RESTING');

  const nextWindow = WINDOW_START + config.WINDOW_MS_5M;
  assert.equal(await bot.closePreviousWindows(nextWindow, nextWindow), 1);
  assert.equal(position.status, 'PENDING_RESOLUTION');
  assert.equal(position.takeProfitOrder.status, 'CANCELLED_WINDOW_END');
});

test('new window starts immediately despite an older unresolved position', async () => {
  let now = WINDOW_START;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  assert.equal(await bot.processStrategyEntry(now), true);
  const previousPositions = [...bot.positions];
  for (const position of previousPositions) position.status = 'PENDING_RESOLUTION';

  const nextWindowStart = WINDOW_START + config.WINDOW_MS_5M;
  bot.market.start = nextWindowStart;
  bot.market.end = nextWindowStart + config.WINDOW_MS_5M;
  bot.market.slug = `btc-updown-5m-${nextWindowStart / 1000}`;
  bot.orderWindowStart = nextWindowStart;
  feed.currentCandle = { ...feed.currentCandle, start: nextWindowStart };
  now = nextWindowStart;
  refreshQuotes(bot, now);

  assert.equal(await bot.processStrategyEntry(now), true);
  assert.ok(previousPositions.every((position) => position.status === 'PENDING_RESOLUTION'));
  const currentWindowPositions = bot.positions.filter((position) =>
    position.status === 'OPEN' && position.windowStart === nextWindowStart);
  assert.equal(currentWindowPositions.length, 2);
});

test('same side re-arms after take-profit while the opposite side remains independent', async () => {
  let now = WINDOW_START;
  const bot = makeBot({ getNow: () => now });
  setBook(bot, 'DOWN', { asks: [{ price: 0.8, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, now);
  assert.equal(await bot.processStrategyEntry(now), true);
  const originalUp = bot.positions.find((position) => position.side === 'UP');

  now += 500;
  setBook(bot, 'UP', {
    asks: [{ price: 0.4, size: 100 }],
    bids: [{ price: 0.6, size: 100 }],
  }, now);
  assert.equal(await bot.processStrategyEntry(now), true);
  const openUpPositions = bot.positions.filter((position) => position.side === 'UP' && position.status === 'OPEN');
  assert.equal(originalUp.status, 'SETTLED_EXIT');
  assert.equal(openUpPositions.length, 1);
  assert.equal(bot.sideEntryCountsThisWindow.UP, 2);

  now += 500;
  setBook(bot, 'DOWN', { asks: [{ price: 0.4, size: 100 }], bids: [{ price: 0.1, size: 100 }] }, now);
  refreshQuotes(bot, now);
  await bot.processStrategyEntry(now);
  assert.equal(bot.positions.filter((position) => position.side === 'DOWN' && position.status === 'OPEN').length, 1);
  assert.equal(bot.positions.filter((position) => position.status === 'OPEN').length, 2);
});

test('strategy snapshot reports dual independent entries and per-position take-profit rules', () => {
  const bot = makeBot();
  const state = bot.snapshot();
  assert.equal(state.strategy.volatilityLookbackCandles, 2);
  assert.equal(state.strategy.minimumNetEdgePerShare, 0.05);
  assert.equal(state.strategy.entryPriceCeilingExclusive, 0.5);
  assert.equal(state.strategy.takeProfitMultiplier, 1.5);
  assert.equal(state.strategy.maximumOpenPositionsPerWindow, 2);
  assert.equal(state.strategy.maximumOpenPositionsPerSide, 1);
  assert.equal(state.strategy.reentryAfterTakeProfit, true);
  assert.equal(state.strategy.exit.orderType, 'PAPER_LIMIT_TAKE_PROFIT');
  assert.equal(state.strategy.exit.flip.enabled, false);
  assert.equal(state.positionsBySide.UP, null);
  assert.equal(state.positionsBySide.DOWN, null);
});
