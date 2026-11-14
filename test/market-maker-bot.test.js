'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MarketMakerBot = require('../market-maker-bot');
const config = require('../config');

const WINDOW_START = 1_800_000_000_000;

function makeCandles() {
  return [
    { start: WINDOW_START - 10 * 60_000, open: 101, close: 100, closed: true },
    { start: WINDOW_START - 5 * 60_000, open: 100, close: 101, closed: true },
  ];
}

function makeFeed(getNow, price = 100.1) {
  return {
    status: 'CONNECTED',
    historyStatus: 'READY',
    error: null,
    price,
    tickAt: getNow(),
    currentCandle: {
      start: WINDOW_START,
      open: 100,
      high: Math.max(100, price),
      low: Math.min(100, price),
      close: price,
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

function setBook(bot, side, bestBid, bestAsk, now, bidSize = 300, askSize = 250) {
  bot.applyBookSnapshot({
    asset_id: side === 'UP' ? 'up-token' : 'down-token',
    timestamp: String(now),
    bids: [{ price: bestBid.toFixed(2), size: String(bidSize) }],
    asks: [{ price: bestAsk.toFixed(2), size: String(askSize) }],
  }, now);
}

function makeBot({
  initialPrice = 100.1,
  upAsk = 0.39,
  downAsk = 0.39,
  askSize = 250,
} = {}) {
  let now = WINDOW_START;
  const feed = makeFeed(() => now, initialPrice);
  const bot = new MarketMakerBot({
    now: () => now,
    marketData: {},
    priceFeed: feed,
  });
  bot.market = {
    id: 'btc-market',
    conditionId: 'btc-condition',
    slug: `btc-updown-5m-${WINDOW_START / 1000}`,
    title: 'BTC Up or Down',
    start: WINDOW_START,
    end: WINDOW_START + config.WINDOW_MS_5M,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    feesEnabled: true,
    takerFeeRate: 0.07,
  };
  bot.orderWindowStart = WINDOW_START;
  const refreshBooks = (at, upPrice = upAsk, downPrice = downAsk, size = askSize) => {
    setBook(bot, 'UP', 0.30, upPrice, at, 300, size);
    setBook(bot, 'DOWN', 0.30, downPrice, at, 300, size);
  };
  refreshBooks(now);

  return {
    bot,
    feed,
    setNow(value) {
      now = value;
    },
    setPrice(value) {
      feed.price = value;
      feed.currentCandle.close = value;
      feed.currentCandle.high = Math.max(feed.currentCandle.high, value);
      feed.currentCandle.low = Math.min(feed.currentCandle.low, value);
    },
    refreshBooks,
  };
}

function buyOrders(bot) {
  return bot.orders.filter((order) => order.action === 'BUY');
}

function prepareCheck(fixture, elapsedMs, options = {}) {
  const now = WINDOW_START + elapsedMs;
  fixture.setNow(now);
  if (options.price != null) fixture.setPrice(options.price);
  fixture.refreshBooks(
    now,
    options.upAsk ?? 0.39,
    options.downAsk ?? 0.39,
    options.askSize ?? 250,
  );
  fixture.bot.processStrategyEntry(now);
  return now;
}

function tradeEvent({ side = 'UP', action = 'BUY', price, size, timestamp }) {
  return {
    event_type: 'last_trade_price',
    asset_id: side === 'UP' ? 'up-token' : 'down-token',
    market: 'btc-condition',
    price: String(price),
    size: String(size),
    side: action,
    timestamp: String(timestamp),
  };
}

test('buys exactly 100 UP shares at the first qualifying 10-second check', () => {
  const fixture = makeBot();
  const now = prepareCheck(fixture, 10_000);
  const { bot } = fixture;

  assert.ok(bot.model.probabilityUp > 0.5);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, 'UP');
  assert.equal(bot.positions[0].shares, 100);
  assert.equal(bot.positions[0].entryFees > 0, true);
  assert.equal(buyOrders(bot).length, 1);
  assert.equal(buyOrders(bot)[0].orderType, 'PAPER_TAKER_ASK_SWEEP');
  assert.equal(buyOrders(bot)[0].filledShares, 100);
  assert.equal(buyOrders(bot)[0].createdAt, now);
  assert.equal(bot.positions[0].takeProfitOrder, null);
  assert.equal(bot.sideSignals.UP.status, 'ENTRY_ADDED');
  assert.equal(bot.sideSignals.DOWN.status, 'MODEL_NOT_ABOVE_50');
});

test('repeats a 100-share buy at each later check, not between checks', () => {
  const fixture = makeBot();
  prepareCheck(fixture, 10_000);
  assert.equal(buyOrders(fixture.bot).length, 1);

  prepareCheck(fixture, 15_000);
  assert.equal(buyOrders(fixture.bot).length, 1);

  prepareCheck(fixture, 20_000);
  assert.equal(buyOrders(fixture.bot).length, 2);
  assert.equal(fixture.bot.positions[0].shares, 200);
  assert.equal(fixture.bot.positions[0].entrySignals.length, 2);
  assert.ok(buyOrders(fixture.bot).every((order) => order.filledShares === 100));
});

test('applies the same fair-value and ask rule to DOWN', () => {
  const fixture = makeBot({ initialPrice: 99.9 });
  prepareCheck(fixture, 10_000, { price: 99.9 });
  const { bot } = fixture;

  assert.ok(bot.model.probabilityDown > 0.5);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, 'DOWN');
  assert.equal(bot.positions[0].shares, 100);
  assert.equal(bot.sideSignals.DOWN.status, 'ENTRY_ADDED');
  assert.equal(bot.sideSignals.UP.status, 'MODEL_NOT_ABOVE_50');
});

test('does not buy when the ask is exactly $0.40', () => {
  const fixture = makeBot();
  prepareCheck(fixture, 10_000, { upAsk: 0.40 });

  assert.equal(fixture.bot.positions.length, 0);
  assert.equal(buyOrders(fixture.bot).length, 0);
  assert.equal(fixture.bot.sideSignals.UP.status, 'ASK_ABOVE_LIMIT');
});

test('requires all 100 shares to be visible below $0.40 and never records a partial entry', () => {
  const fixture = makeBot();
  prepareCheck(fixture, 10_000, { askSize: 99 });

  assert.equal(fixture.bot.positions.length, 0);
  assert.equal(buyOrders(fixture.bot).length, 0);
  assert.equal(fixture.bot.sideSignals.UP.status, 'WAITING_FOR_FULL_DEPTH');
});

test('does not buy when neither model probability is strictly above 50%', () => {
  const fixture = makeBot({ initialPrice: 100 });
  prepareCheck(fixture, 10_000, { price: 100 });

  assert.ok(Math.abs(fixture.bot.model.probabilityUp - 0.5) < 1e-8);
  assert.equal(fixture.bot.positions.length, 0);
  assert.equal(buyOrders(fixture.bot).length, 0);
});

test('does not sweep asks at or above $0.40 to complete a qualifying entry', () => {
  const fixture = makeBot();
  const now = WINDOW_START + 10_000;
  fixture.setNow(now);
  fixture.refreshBooks(now);
  fixture.bot.applyBookSnapshot({
    asset_id: 'up-token',
    timestamp: String(now),
    bids: [{ price: '0.30', size: '300' }],
    asks: [
      { price: '0.39', size: '50' },
      { price: '0.40', size: '100' },
    ],
  }, now);
  fixture.bot.processStrategyEntry(now);

  assert.equal(fixture.bot.positions.length, 0);
  assert.equal(buyOrders(fixture.bot).length, 0);
  assert.equal(fixture.bot.sideSignals.UP.status, 'WAITING_FOR_FULL_DEPTH');
});

test('does not place passive buys and posts passive asks only for held shares', () => {
  const fixture = makeBot();
  prepareCheck(fixture, 10_000);
  const { bot } = fixture;

  assert.equal(buyOrders(bot).filter((order) => order.orderType === 'PAPER_POST_ONLY_LIMIT').length, 0);
  const sellOrder = bot.orders.find((order) =>
    order.orderType === 'PAPER_POST_ONLY_LIMIT' && order.action === 'SELL' && order.side === 'UP');
  assert.ok(sellOrder);
  assert.equal(sellOrder.requestedShares, 100);

  const now = WINDOW_START + 10_100;
  assert.equal(bot.processMakerTrade(tradeEvent({
    price: sellOrder.limitPrice,
    size: sellOrder.queueAheadShares + 5,
    timestamp: now,
  }), now), true);
  assert.equal(bot.positions[0].shares, 95);
  assert.equal(bot.positions[0].exitFees, 0);
  assert.equal(Number.isFinite(bot.positions[0].makerRebateEstimate), true);
});

test('continues scheduled signal checks through the final 30 seconds', () => {
  const fixture = makeBot();
  prepareCheck(fixture, config.WINDOW_MS_5M - config.MAKER_WINDOW_CUTOFF_MS);

  assert.equal(fixture.bot.positions.length, 1);
  assert.equal(fixture.bot.positions[0].shares, 100);
  assert.equal(fixture.bot.sideSignals.UP.status, 'ENTRY_ADDED');
  assert.equal(fixture.bot.orders.some((order) =>
    order.orderType === 'PAPER_POST_ONLY_LIMIT' && order.status === 'RESTING'), false);
});

test('resets the entry check cadence and per-window counts at a new window', async () => {
  const fixture = makeBot();
  prepareCheck(fixture, 10_000);
  const previousPosition = fixture.bot.positions[0];
  const nextWindowStart = WINDOW_START + config.WINDOW_MS_5M;
  await fixture.bot.closePreviousWindows(nextWindowStart, nextWindowStart);

  fixture.bot.market.start = nextWindowStart;
  fixture.bot.market.end = nextWindowStart + config.WINDOW_MS_5M;
  fixture.bot.market.slug = `btc-updown-5m-${nextWindowStart / 1000}`;
  fixture.bot.openStrategyWindow(nextWindowStart, nextWindowStart);
  fixture.feed.currentCandle.start = nextWindowStart;
  fixture.feed.currentCandle.open = 100;
  prepareCheck(fixture, config.WINDOW_MS_5M + 10_000);

  assert.equal(previousPosition.status, 'PENDING_RESOLUTION');
  assert.equal(fixture.bot.sideEntryCountsThisWindow.UP, 1);
  assert.equal(fixture.bot.positions.filter((position) => position.status === 'OPEN').length, 1);
  assert.equal(fixture.bot.positions.find((position) => position.status === 'OPEN').windowStart, nextWindowStart);
});

test('strategy snapshot shows the 100-share, 10-second signal rules as paper-only', () => {
  const bot = makeBot().bot;
  const state = bot.snapshot();

  assert.equal(state.strategy.id, 'btc-5m-fair-value-40c-accumulator');
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.entryShares, 100);
  assert.equal(state.strategy.entryIntervalMs, 10_000);
  assert.equal(state.strategy.fairValueThresholdExclusive, 0.5);
  assert.equal(state.strategy.maximumEntryAskExclusive, 0.40);
  assert.equal(state.strategy.usesTakerOrders, true);
  assert.equal(state.strategy.maxInventoryPerSide, null);
  assert.equal(state.mode, 'DEMO ONLY');
});
