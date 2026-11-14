'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MarketMakerBot = require('../market-maker-bot');
const config = require('../config');

const WINDOW_START = 1_800_000_000_000;

function setBook(bot, side, bid, ask, now, bidSize = 300, askSize = 300) {
  bot.handleMarketMessage({
    event_type: 'book',
    asset_id: side === 'UP' ? 'up-token' : 'down-token',
    timestamp: String(now),
    bids: [{ price: bid.toFixed(2), size: String(bidSize) }],
    asks: [{ price: ask.toFixed(2), size: String(askSize) }],
  });
}

function makeBot() {
  let now = WINDOW_START;
  const bot = new MarketMakerBot({
    now: () => now,
    marketData: {},
    initialCapital: 100,
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
  bot.openStrategyWindow(WINDOW_START, now);
  const refreshBooks = (at) => {
    setBook(bot, 'UP', 0.40, 0.50, at);
    setBook(bot, 'DOWN', 0.30, 0.44, at);
  };
  refreshBooks(now);

  return {
    bot,
    setNow(value) { now = value; },
    refreshBooks,
    tickAt(elapsedMs) {
      now = WINDOW_START + elapsedMs;
      refreshBooks(now);
      bot.processStrategyEntry(now);
      return now;
    },
  };
}

function tradeEvent({ side = 'UP', takerSide, price, size, timestamp }) {
  return {
    event_type: 'last_trade_price',
    asset_id: side === 'UP' ? 'up-token' : 'down-token',
    market: 'btc-condition',
    price: String(price),
    size: String(size),
    side: takerSide,
    timestamp: String(timestamp),
  };
}

function activeOrders(bot, side, action) {
  return bot.orders.filter((order) =>
    order.side === side
    && order.action === action
    && ['RESTING', 'PARTIALLY_FILLED'].includes(order.status));
}

test('posts independent 5-share bids at each side midpoint minus five cents', () => {
  const fixture = makeBot();
  fixture.tickAt(1_000);
  const { bot } = fixture;

  const up = activeOrders(bot, 'UP', 'BUY')[0];
  const down = activeOrders(bot, 'DOWN', 'BUY')[0];
  assert.ok(up);
  assert.ok(down);
  assert.equal(up.requestedShares, 5);
  assert.equal(down.requestedShares, 5);
  assert.equal(up.limitPrice, 0.40);
  assert.equal(down.limitPrice, 0.32);
  assert.equal(up.referenceMidpoint, 0.45);
  assert.equal(down.referenceMidpoint, 0.37);
  assert.equal(up.expiresAt, up.createdAt + 5_000);
  assert.equal(down.expiresAt, down.createdAt + 5_000);
  assert.equal(bot.priceFeed, null);
  assert.equal(bot.positions.length, 0);
});

test('skips only the side whose book is missing one side', () => {
  const fixture = makeBot();
  const now = WINDOW_START + 1_000;
  fixture.setNow(now);
  fixture.bot.applyBookSnapshot({
    asset_id: 'up-token',
    timestamp: String(now),
    bids: [{ price: '0.40', size: '300' }],
    asks: [],
  }, now);
  setBook(fixture.bot, 'DOWN', 0.30, 0.44, now);
  fixture.bot.processStrategyEntry(now);

  assert.equal(activeOrders(fixture.bot, 'UP', 'BUY').length, 0);
  assert.equal(activeOrders(fixture.bot, 'DOWN', 'BUY').length, 1);
  assert.equal(fixture.bot.makerQuotes.UP.entryLimitPrice, null);
});

test('places once per second with up to five overlapping orders per side', () => {
  const fixture = makeBot();
  fixture.tickAt(1_000);
  fixture.tickAt(1_500);
  assert.equal(botOrderCount(fixture.bot, 'BUY'), 2);

  fixture.tickAt(2_000);
  assert.equal(botOrderCount(fixture.bot, 'BUY'), 4);
  assert.equal(activeOrders(fixture.bot, 'UP', 'BUY').length, 2);
  assert.equal(activeOrders(fixture.bot, 'DOWN', 'BUY').length, 2);

  fixture.tickAt(3_000);
  fixture.tickAt(4_000);
  fixture.tickAt(5_000);
  assert.equal(activeOrders(fixture.bot, 'UP', 'BUY').length, 5);
  assert.equal(activeOrders(fixture.bot, 'DOWN', 'BUY').length, 5);

  fixture.tickAt(6_000);
  const expired = fixture.bot.orders.filter((order) => order.status === 'CANCELLED_TIMEOUT');
  assert.equal(expired.length, 2);
  assert.equal(activeOrders(fixture.bot, 'UP', 'BUY').length, 5);
  assert.equal(activeOrders(fixture.bot, 'DOWN', 'BUY').length, 5);
});

test('confirms full entry fills on a fresh best-ask touch and expires untouched orders', () => {
  const fixture = makeBot();
  const placedAt = fixture.tickAt(1_000);
  const upOrder = activeOrders(fixture.bot, 'UP', 'BUY')[0];
  fixture.setNow(placedAt + 100);
  setBook(fixture.bot, 'UP', 0.39, upOrder.limitPrice, placedAt + 100, 300, 1);

  assert.equal(upOrder.status, 'FILLED');
  assert.equal(upOrder.filledShares, 5);
  assert.equal(fixture.bot.positions[0].shares, 5);
  assert.equal(fixture.bot.positions[0].entryFills[0].confirmation, 'BEST_ASK_TOUCH');

  const untouchedFixture = makeBot();
  const untouchedAt = untouchedFixture.tickAt(1_000);
  const untouched = activeOrders(untouchedFixture.bot, 'UP', 'BUY')[0];
  untouchedFixture.tickAt(6_000);
  assert.equal(untouched.status, 'CANCELLED_TIMEOUT');
  assert.equal(untouched.filledShares, 0);
  assert.equal(untouchedFixture.bot.positions.length, 0);
  assert.equal(untouched.expiresAt, untouchedAt + 5_000);
});

test('entry trade prints alone do not fill; best-ask touch fills without queue checks', () => {
  const fixture = makeBot();
  const placedAt = fixture.tickAt(1_000);
  const upOrder = activeOrders(fixture.bot, 'UP', 'BUY')[0];

  const changed = fixture.bot.processMakerTrade(tradeEvent({
    side: 'UP',
    takerSide: 'SELL',
    price: upOrder.limitPrice,
    size: upOrder.queueAheadShares + 5,
    timestamp: placedAt + 100,
  }), placedAt + 200);
  assert.equal(changed, false);
  assert.equal(fixture.bot.positions.length, 0);
  assert.equal(upOrder.status, 'RESTING');

  fixture.setNow(placedAt + 300);
  setBook(fixture.bot, 'UP', 0.39, upOrder.limitPrice, placedAt + 300, 300, 1);
  assert.equal(upOrder.status, 'FILLED');
  assert.equal(upOrder.filledShares, 5);
  assert.equal(fixture.bot.positions[0].shares, 5);
  assert.equal(fixture.bot.positions[0].fees, 0);
  const takeProfit = activeOrders(fixture.bot, 'UP', 'SELL')[0];
  assert.ok(takeProfit);
  assert.equal(takeProfit.limitPrice, 0.99);
  assert.equal(takeProfit.requestedShares, 5);
});

test('records a $0.99 maker take-profit at the actual limit price', () => {
  const fixture = makeBot();
  const placedAt = fixture.tickAt(1_000);
  const buy = activeOrders(fixture.bot, 'UP', 'BUY')[0];
  fixture.setNow(placedAt + 100);
  setBook(fixture.bot, 'UP', 0.39, buy.limitPrice, placedAt + 100, 300, 1);
  const takeProfit = activeOrders(fixture.bot, 'UP', 'SELL')[0];
  assert.ok(takeProfit);
  assert.equal(takeProfit.limitPrice, 0.99);

  fixture.setNow(placedAt + 400);
  fixture.refreshBooks(placedAt + 400);
  fixture.bot.processMakerTrade(tradeEvent({
    takerSide: 'BUY',
    price: 0.99,
    size: takeProfit.queueAheadShares + 5,
    timestamp: placedAt + 300,
  }), placedAt + 400);

  const position = fixture.bot.positions[0];
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.shares, 0);
  assert.equal(position.exitProceeds, 4.95);
  assert.equal(position.exitFees, 0);
  assert.ok(position.realizedPnl > 0);
});

test('closes the order window at five minutes and exposes the CLOB-only strategy', () => {
  const fixture = makeBot();
  fixture.tickAt(1_000);
  const now = WINDOW_START + config.WINDOW_MS_5M;
  fixture.setNow(now);
  fixture.refreshBooks(now);
  fixture.bot.processStrategyEntry(now);
  const snapshot = fixture.bot.snapshot();

  assert.equal(snapshot.strategy.id, 'btc-5m-clob-midpoint-maker');
  assert.equal(snapshot.strategy.execution, 'PAPER ONLY');
  assert.equal(snapshot.strategy.priceReference, 'BEST_BID_ASK_MIDPOINT');
  assert.equal(snapshot.strategy.entryShares, 5);
  assert.equal(snapshot.strategy.entryIntervalMs, 1_000);
  assert.equal(snapshot.strategy.entryTtlMs, 5_000);
  assert.equal(snapshot.strategy.midpointOffset, 0.05);
  assert.match(snapshot.strategy.fillRule, /best ask reaches or falls below/i);
  assert.equal(snapshot.strategy.takeProfitPrice, 0.99);
  assert.equal(snapshot.binance.status, 'NOT_USED');
  assert.equal(snapshot.marketMakerState.status, 'WINDOW_CLOSED');
  assert.equal(activeOrders(fixture.bot, 'UP', 'BUY').length, 0);
  assert.equal(activeOrders(fixture.bot, 'DOWN', 'BUY').length, 0);
});

test('summarizes accumulated inventory and weighted average entry by side', () => {
  const fixture = makeBot();
  fixture.bot.positions.push({
    id: 'older-up-position',
    side: 'UP',
    status: 'PENDING_RESOLUTION',
    windowStart: WINDOW_START - config.WINDOW_MS_5M,
    shares: 3,
    totalCost: 1.05,
    entryPrice: 0.35,
  });
  fixture.bot.positions.push({
    id: 'current-up-position',
    side: 'UP',
    status: 'OPEN',
    windowStart: WINDOW_START,
    shares: 5,
    totalCost: 2,
    entryPrice: 0.4,
  });
  fixture.bot.positions.push({
    id: 'closed-down-position',
    side: 'DOWN',
    status: 'SETTLED_WIN',
    shares: 10,
    totalCost: 0,
    entryPrice: 0.4,
  });

  const summary = fixture.bot.snapshot().inventorySummary;
  assert.deepEqual(summary.UP, {
    shares: 5,
    costBasis: 2,
    averageEntry: 0.4,
    positionCount: 1,
  });
  assert.deepEqual(summary.DOWN, {
    shares: 0,
    costBasis: 0,
    averageEntry: null,
    positionCount: 0,
  });
  let previous = fixture.bot.snapshot().previousWindowInventory;
  assert.equal(previous.length, 1);
  assert.equal(previous[0].windowStart, WINDOW_START - config.WINDOW_MS_5M);
  assert.equal(previous[0].UP.shares, 3);

  fixture.setNow(WINDOW_START + config.WINDOW_MS_5M);
  const afterWindow = fixture.bot.snapshot();
  assert.equal(afterWindow.inventorySummary.UP.shares, 0);
  previous = afterWindow.previousWindowInventory;
  assert.equal(previous.length, 2);
  assert.equal(previous[0].windowStart, WINDOW_START);
  assert.equal(previous[0].UP.shares, 5);
  assert.equal(previous[1].windowStart, WINDOW_START - config.WINDOW_MS_5M);
  assert.equal(previous[1].UP.shares, 3);
});

function botOrderCount(bot, action) {
  return bot.orders.filter((order) => order.action === action).length;
}
