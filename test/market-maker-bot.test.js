'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MarketMakerBot = require('../market-maker-bot');
const config = require('../config');

const WINDOW_START = 1_800_000_000_000;

function makeBot({ capital = 3000 } = {}) {
  let now = WINDOW_START;
  const bot = new MarketMakerBot({
    now: () => now,
    marketData: {},
    initialCapital: capital,
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
  const setBook = (side, bestBid, bestAsk, at = now, bidSize = 50) => {
    bot.applyBookSnapshot({
      asset_id: side === 'UP' ? 'up-token' : 'down-token',
      timestamp: String(at),
      bids: [{ price: bestBid.toFixed(2), size: String(bidSize) }],
      asks: [{ price: bestAsk.toFixed(2), size: '50' }],
    }, at);
  };
  setBook('UP', 0.59, 0.60);
  setBook('DOWN', 0.59, 0.60);
  return {
    bot,
    setNow(value) { now = value; },
    setBook,
    tickAt(elapsedMs) {
      now = WINDOW_START + elapsedMs;
      setBook('UP', 0.59, 0.60, now);
      setBook('DOWN', 0.59, 0.60, now);
      bot.processStrategyEntry(now);
      return now;
    },
  };
}

function activeOrders(bot, { side, windowStart = WINDOW_START } = {}) {
  return bot.orders.filter((order) =>
    order.orderType === 'PAPER_RESTING_LIMIT_BUY'
    && (!side || order.side === side)
    && Number(order.windowStart) === Number(windowStart)
    && ['RESTING', 'PARTIALLY_FILLED'].includes(order.status));
}

function tradeEvent({ side = 'UP', takerSide = 'SELL', price, size, timestamp }) {
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

test('posts all eight 100-share post-only rungs independently on both sides', () => {
  const fixture = makeBot();
  fixture.tickAt(500);
  const { bot } = fixture;
  const orders = activeOrders(bot);

  assert.equal(orders.length, 16);
  for (const side of ['UP', 'DOWN']) {
    const sideOrders = orders.filter((order) => order.side === side)
      .sort((left, right) => right.limitPrice - left.limitPrice);
    assert.deepEqual(sideOrders.map((order) => order.limitPrice),
      config.MAKER_LADDER_RUNGS.map((rung) => rung.price));
    assert.ok(sideOrders.every((order) => order.action === 'BUY'));
    assert.ok(sideOrders.every((order) => order.postOnly === true));
    assert.ok(sideOrders.every((order) => order.requestedShares === 100));
    assert.deepEqual(sideOrders.map((order) => order.cancelAtSeconds),
      config.MAKER_LADDER_RUNGS.map((rung) => rung.cancelAfterSeconds));
    assert.deepEqual(sideOrders.map((order) => order.expiresAt),
      config.MAKER_LADDER_RUNGS.map((rung) =>
        WINDOW_START + rung.cancelAfterSeconds * 1000));
  }
  assert.equal(bot.orders.some((order) => order.action === 'SELL'), false);
});

test('uses exact configured prices and expires each rung from window open', () => {
  const fixture = makeBot();
  fixture.tickAt(8_000);
  const upForty = activeOrders(fixture.bot, { side: 'UP' })
    .find((order) => order.limitPrice === 0.40);
  const upThirtyFive = activeOrders(fixture.bot, { side: 'UP' })
    .find((order) => order.limitPrice === 0.35);

  assert.equal(upForty.createdAt, WINDOW_START + 8_000);
  assert.equal(upForty.expiresAt, WINDOW_START + 10_000);
  assert.equal(upThirtyFive.expiresAt, WINDOW_START + 50_000);

  fixture.tickAt(10_000);
  assert.equal(upForty.status, 'CANCELLED_TIMEOUT');
  assert.equal(upForty.cancelledShares, 100);
  assert.equal(upThirtyFive.status, 'RESTING');
});

test('book touches do not create fills; opposing trade prints do', () => {
  const fixture = makeBot();
  const placedAt = fixture.tickAt(500);
  const order = activeOrders(fixture.bot, { side: 'UP' })
    .find((item) => item.limitPrice === 0.40);

  fixture.setNow(placedAt + 100);
  fixture.bot.handleMarketMessage({
    event_type: 'book',
    asset_id: 'up-token',
    timestamp: String(placedAt + 100),
    bids: [{ price: '0.39', size: '200' }],
    asks: [{ price: '0.40', size: '100' }],
  });
  assert.equal(order.status, 'RESTING');
  assert.equal(order.filledShares, 0);
  assert.equal(fixture.bot.positions.length, 0);

  fixture.setNow(placedAt + 200);
  fixture.bot.processMakerTrade(tradeEvent({
    price: 0.40,
    size: order.queueAheadShares + 100,
    timestamp: placedAt + 200,
  }), placedAt + 200);
  assert.equal(order.status, 'FILLED');
  assert.equal(order.filledShares, 100);
  assert.equal(fixture.bot.currentPosition('UP', WINDOW_START).shares, 100);
});

test('partial trade fills consume queue first and preserve the remainder until timeout', () => {
  const fixture = makeBot();
  const placedAt = fixture.tickAt(500);
  const order = activeOrders(fixture.bot, { side: 'UP' })
    .find((item) => item.limitPrice === 0.40);

  fixture.setNow(placedAt + 100);
  fixture.bot.processMakerTrade(tradeEvent({
    price: 0.40,
    size: order.queueAheadShares + 30,
    timestamp: placedAt + 100,
  }), placedAt + 100);
  assert.equal(order.status, 'PARTIALLY_FILLED');
  assert.equal(order.filledShares, 30);
  assert.equal(order.remainingShares, 70);

  fixture.setNow(WINDOW_START + 10_000);
  fixture.bot.processStrategyEntry(WINDOW_START + 10_000);
  assert.equal(order.status, 'CANCELLED_TIMEOUT');
  assert.equal(order.cancelledShares, 70);
  assert.equal(fixture.bot.currentPosition('UP', WINDOW_START).shares, 30);
});

test('rejects a rung that would immediately match instead of resting', () => {
  const fixture = makeBot();
  fixture.setBook('UP', 0.38, 0.39, WINDOW_START);
  fixture.setNow(WINDOW_START + 500);
  fixture.setBook('DOWN', 0.59, 0.60, WINDOW_START + 500);
  fixture.bot.processStrategyEntry(WINDOW_START + 500);
  const ladder = fixture.bot.snapshot().ladder.UP;

  assert.equal(ladder[0].status, 'REJECTED_POST_ONLY');
  assert.equal(ladder[0].orderId, null);
  assert.equal(ladder[1].status, 'RESTING');
});

test('dashboard snapshot exposes rung deadlines, status, and accumulated positions', () => {
  const fixture = makeBot();
  fixture.tickAt(500);
  const snapshot = fixture.bot.snapshot();

  assert.equal(snapshot.mode, 'DEMO ONLY');
  assert.equal(snapshot.strategy.id, 'btc-5m-fixed-price-ladder');
  assert.equal(snapshot.strategy.sizePerOrder, 100);
  assert.deepEqual(snapshot.ladder.UP.map((rung) => rung.cancelAtSeconds),
    [10, 50, 160, 200, 220, 230, 250, 270]);
  assert.equal(snapshot.ladder.DOWN[0].price, 0.40);
  assert.equal(snapshot.positionsBySide.UP, null);
  assert.equal(snapshot.strategy.exitPolicy.includes('no take-profit'), true);
});
