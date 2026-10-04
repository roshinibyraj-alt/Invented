'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const Bot = require('../paired-limit-bot');
const { makeWindowState } = require('../paired-limit-bot');
const { currentWindowOpenTs, slugForTs } = require('../polymarket-market');

class FakeDemoTrader {
  constructor() {
    this.demoMode = true;
    this.calls = [];
    this.orders = new Map();
    this.nextId = 1;
  }

  async placeGtcOrder(tokenId, side, price, size) {
    this.calls.push({ method: 'placeGtcOrder', tokenId, side, price, size });
    const id = 'fake-' + this.nextId++;
    this.orders.set(id, {
      id, tokenId, side, price, original_size: size, size_matched: 0,
      status: 'LIVE', makerRebateEstimate: 0,
    });
    return { id, status: 'LIVE' };
  }

  async getOrder(id) {
    const order = this.orders.get(id);
    return order ? { ...order } : null;
  }

  async cancelOrder(id) {
    this.calls.push({ method: 'cancelOrder', id });
    const order = this.orders.get(id);
    if (order && order.status === 'LIVE') order.status = 'CANCELED';
    return { canceled: [id] };
  }

  fill(id, shares, matchedAt = Date.now()) {
    const order = this.orders.get(id);
    order.size_matched = shares;
    order.status = shares >= order.original_size ? 'MATCHED' : 'LIVE';
    order.matchedAt = matchedAt;
    order.makerRebateEstimate = 0;
  }

  async getOrderBook() { return { bids: [], asks: [] }; }
  async getBalance() { return null; }
  updateQuote() {}
}

function fixture({ trader = new FakeDemoTrader(), cash } = {}) {
  const bot = new Bot(trader);
  if (cash != null) bot.cash = cash;
  const openTs = currentWindowOpenTs();
  const slug = slugForTs(openTs);
  const w = makeWindowState(slug, openTs);
  w.window = {
    slug, openTs, closeTs: openTs + 300,
    tokenUp: 'up-token', tokenDown: 'down-token',
  };
  bot.w = w;
  return { bot, trader, w };
}

async function postPair(fx) {
  const posted = await fx.bot._placeEntryOrders(fx.w);
  assert.equal(posted, true);
  assert.deepEqual(Object.keys(fx.w.entryOrders).sort(), ['DOWN', 'UP']);
}

test('configuration selects $10,000 demo capital, $0.30 limits, and 500/250 share sizing', () => {
  assert.equal(cfg.DEMO_CAPITAL, 10000);
  assert.equal(cfg.ENTRY_LIMIT_PRICE_USD, 0.30);
  assert.equal(cfg.BASE_SHARES, 500);
  assert.equal(cfg.SHARES_INCREMENT_AFTER_LOSS, 250);
});

test('posts both sides as resting GTC BUY limits at the configured price and size', async () => {
  const fx = fixture();
  await postPair(fx);

  assert.equal(fx.trader.calls.length, 2);
  assert.deepEqual(fx.trader.calls.map(({ side, price, size }) => ({ side, price, size })), [
    { side: 'BUY', price: 0.30, size: 500 },
    { side: 'BUY', price: 0.30, size: 500 },
  ]);
  assert.equal(fx.bot.cash, 10000);
  assert.equal(fx.w.status, 'entry_orders_open');
});

test('first fill creates a position and cancels the opposite resting order', async () => {
  const fx = fixture();
  await postPair(fx);
  fx.trader.fill(fx.w.entryOrders.UP.orderId, 500);

  await fx.bot._checkEntryOrders(fx.w);

  assert.equal(fx.w.entrySide, 'UP');
  assert.equal(fx.w.entryOrders.DOWN.status, 'CANCELED');
  assert.equal(fx.trader.calls.filter((call) => call.method === 'cancelOrder').length, 1);
  assert.equal(fx.bot.pending.length, 1);
  assert.equal(fx.bot.pending[0].shares, 500);
  assert.equal(fx.bot.cash, 10000 - 500 * 0.30);
  assert.ok(fx.bot.log.some((entry) => entry.event === 'OCO_CANCEL'));
});

test('opposite order is canceled if a feed sees the first fill before pair submission finishes', async () => {
  const fx = fixture();
  fx.w.entryOrdersStarted = true;
  fx.w.orderShares = 500;
  const up = await fx.trader.placeGtcOrder('up-token', 'BUY', 0.30, 500);
  fx.w.entryOrders.UP = {
    side: 'UP', tokenId: 'up-token', orderId: up.id, price: 0.30,
    shares: 500, matchedShares: 0, rebateRecorded: 0, status: 'LIVE',
    placedAt: Date.now(), cancelPending: false,
  };
  fx.trader.fill(up.id, 500);
  await fx.bot._checkEntryOrders(fx.w);
  assert.equal(fx.w.entrySide, 'UP');
  assert.equal(fx.w.entryOrders.DOWN, undefined);

  const down = await fx.trader.placeGtcOrder('down-token', 'BUY', 0.30, 500);
  fx.w.entryOrders.DOWN = {
    side: 'DOWN', tokenId: 'down-token', orderId: down.id, price: 0.30,
    shares: 500, matchedShares: 0, rebateRecorded: 0, status: 'LIVE',
    placedAt: Date.now(), cancelPending: false,
  };
  await fx.bot._checkEntryOrders(fx.w);
  assert.equal(fx.w.entryOrders.DOWN.status, 'CANCELED');
});

test('partial fill is tracked at the limit cost while the unfilled opposite side is canceled', async () => {
  const fx = fixture();
  await postPair(fx);
  fx.trader.fill(fx.w.entryOrders.DOWN.orderId, 125);

  await fx.bot._checkEntryOrders(fx.w);

  assert.equal(fx.w.entrySide, 'DOWN');
  assert.equal(fx.w.entryOrders.DOWN.status, 'PARTIALLY_FILLED');
  assert.equal(fx.w.entryOrders.UP.status, 'CANCELED');
  assert.equal(fx.bot.pending[0].shares, 125);
  assert.equal(fx.bot.pending[0].openShares, 125);
  assert.equal(fx.bot.cash, 10000 - 125 * 0.30);
});

test('an opposite fill that races cancellation is recorded instead of hidden', async () => {
  const fx = fixture();
  await postPair(fx);
  const sameTime = Date.now();
  fx.trader.fill(fx.w.entryOrders.UP.orderId, 500, sameTime);
  fx.trader.fill(fx.w.entryOrders.DOWN.orderId, 500, sameTime + 1);

  await fx.bot._checkEntryOrders(fx.w);

  assert.equal(fx.w.entrySide, 'UP');
  assert.equal(fx.bot.pending.length, 2);
  assert.ok(fx.bot.log.some((entry) => entry.event === 'OCO_RACE_FILL'));
});

test('loss adds 250 shares to the next pair, then a win resets to 500', async () => {
  const fx = fixture();
  await postPair(fx);
  fx.trader.fill(fx.w.entryOrders.UP.orderId, 500);
  await fx.bot._checkEntryOrders(fx.w);

  fx.bot._settlePositionAtClobPrice(fx.bot.pending[0], 0.50, 0.01);
  assert.equal(fx.bot.currentOrderShares, 750);

  const nextOpenTs = fx.w.openTs + 300;
  const next = makeWindowState(slugForTs(nextOpenTs), nextOpenTs);
  next.window = {
    slug: next.slug, openTs: nextOpenTs, closeTs: nextOpenTs + 300,
    tokenUp: 'next-up-token', tokenDown: 'next-down-token',
  };
  fx.bot.w = next;
  const nextPair = await fx.bot._placeEntryOrders(next);
  assert.equal(nextPair, true);
  assert.equal(next.orderShares, 750);

  fx.trader.fill(next.entryOrders.DOWN.orderId, 750);
  await fx.bot._checkEntryOrders(next);
  fx.bot._settlePositionAtClobPrice(fx.bot.pending[0], 0.99, 0.98);
  assert.equal(fx.bot.currentOrderShares, 500);
});

test('both CLOB threshold and official-result paths settle with the preserved outcomes', async () => {
  const threshold = fixture();
  await postPair(threshold);
  threshold.trader.fill(threshold.w.entryOrders.UP.orderId, 500);
  await threshold.bot._checkEntryOrders(threshold.w);
  threshold.bot._settlePositionAtClobPrice(threshold.bot.pending[0], 0.99, 0.98);
  assert.equal(threshold.bot.trades[0].outcome, 'WIN');
  assert.equal(threshold.bot.trades[0].reason, 'CLOB_THRESHOLD');

  const official = fixture();
  await postPair(official);
  official.trader.fill(official.w.entryOrders.DOWN.orderId, 500);
  await official.bot._checkEntryOrders(official.w);
  const position = official.bot.pending[0];
  position.closeTs = Math.floor(Date.now() / 1000) - 1;
  official.w.closed = true;
  official.w.status = 'awaiting_resolution';
  official.bot.outcomes.set(position.openTs, { winner: 'DOWN', source: 'official' });

  await official.bot._settleClosedPositions(Date.now());
  assert.equal(official.bot.trades[0].outcome, 'WIN');
  assert.equal(official.bot.trades[0].reason, 'RESOLUTION');
});

test('pair cost is checked against demo cash before either order is placed', async () => {
  const fx = fixture({ cash: 299.99 });
  const posted = await fx.bot._placeEntryOrders(fx.w);
  assert.equal(posted, false);
  assert.equal(fx.trader.calls.length, 0);
  assert.equal(fx.w.status, 'insufficient_cash');
});

test('non-DemoTrader instances remain blocked and cannot submit orders', async () => {
  const trader = new FakeDemoTrader();
  trader.demoMode = false;
  const fx = fixture({ trader });
  assert.equal(fx.bot.executionHalt, true);
  fx.bot.start();
  assert.equal(await fx.bot._placeEntryOrders(fx.w), false);
  assert.equal(fx.trader.calls.length, 0);
});

test('snapshot exposes paired-limit strategy settings and demo capital', () => {
  const fx = fixture();
  const snapshot = fx.bot.snapshot();
  assert.equal(snapshot.mode, 'DEMO');
  assert.equal(snapshot.account.capital, 10000);
  assert.equal(snapshot.strategy.entryLimitPrice, 0.30);
  assert.equal(snapshot.strategy.baseShares, 500);
  assert.equal(snapshot.strategy.sharesIncrementAfterLoss, 250);
  assert.equal(snapshot.strategy.currentOrderShares, 500);
});