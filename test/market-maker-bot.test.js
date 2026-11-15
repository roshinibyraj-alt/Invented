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

test('fresh best-ask crossing fills the whole rung regardless of displayed size', () => {
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
    asks: [{ price: '0.40', size: '1' }],
  });
  assert.equal(order.status, 'FILLED');
  assert.equal(order.filledShares, 100);
  assert.equal(fixture.bot.currentPosition('UP', WINDOW_START).shares, 100);
});

test('a sell print through a rung fills all shares even when the print is small', () => {
  const fixture = makeBot();
  const placedAt = fixture.tickAt(500);
  const order = activeOrders(fixture.bot, { side: 'UP' })
    .find((item) => item.limitPrice === 0.40);

  fixture.setNow(placedAt + 100);
  fixture.bot.processMakerTrade(tradeEvent({
    price: 0.39,
    size: 1,
    timestamp: placedAt + 100,
  }), placedAt + 100);
  assert.equal(order.status, 'FILLED');
  assert.equal(order.filledShares, 100);
  assert.equal(order.remainingShares, 0);

  fixture.setNow(WINDOW_START + 10_000);
  fixture.bot.processStrategyEntry(WINDOW_START + 10_000);
  assert.equal(order.status, 'FILLED');
  assert.equal(fixture.bot.currentPosition('UP', WINDOW_START).shares, 100);
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

test('dashboard snapshot exposes rung deadlines, live exit rules, and accumulated positions', () => {
  const fixture = makeBot();
  fixture.tickAt(500);
  const snapshot = fixture.bot.snapshot();

  assert.equal(snapshot.mode, 'DEMO ONLY');
  assert.equal(snapshot.strategy.id, 'btc-5m-fixed-price-ladder');
  assert.equal(snapshot.strategy.sizePerOrder, 100);
  assert.deepEqual(snapshot.ladder.UP.map((rung) => rung.cancelAtSeconds),
    [10, 50, 160, 200, 220, 230, 250, 270]);
  assert.equal(snapshot.ladder.DOWN[0].price, 0.40);
  assert.deepEqual(snapshot.strategy.rungs.map((rung) => rung.takeProfitPrice),
    [0.61, 0.66, 0.71, 0.76, 0.81, 0.86, 0.91, 0.96]);
  assert.equal(snapshot.ladder.UP[2].takeProfitPrice, 0.71);
  assert.equal(snapshot.positionsBySide.UP, null);
  assert.equal(snapshot.strategy.takeProfitPairPriceSum, 1.01);
  assert.match(snapshot.strategy.takeProfitRule, /original rung deadline/);
  assert.equal(snapshot.strategy.stopLossBid, 0.01);
  assert.equal(snapshot.strategy.stopLossPayoutPerShare, 0);
  assert.match(snapshot.strategy.exitPolicy, /official resolution/);
});

test('a rung take-profit sells at its target and re-arms before the original deadline', () => {
  const fixture = makeBot();
  fixture.tickAt(500);
  for (const order of activeOrders(fixture.bot, { side: 'UP' })) {
    if (order.action === 'BUY' && order.limitPrice !== 0.30) {
      fixture.bot.cancelMakerOrder(order, WINDOW_START + 600, 'CANCELLED_TEST', 'Test setup.');
    }
  }

  const entryAt = WINDOW_START + 1_000;
  fixture.setNow(entryAt);
  fixture.setBook('UP', 0.29, 0.30, entryAt);
  fixture.bot.processBookPriceCross('UP', entryAt);
  const entryOrder = fixture.bot.orders.find((order) =>
    order.action === 'BUY' && order.side === 'UP' && order.rungIndex === 3);
  const position = fixture.bot.positions.find((item) =>
    item.side === 'UP' && item.rungIndex === 3 && item.rungCycle === 1);
  const takeProfit = fixture.bot.orders.find((order) =>
    order.action === 'SELL' && order.positionId === position.id);

  assert.equal(entryOrder.status, 'FILLED');
  assert.equal(position.takeProfitPrice, 0.71);
  assert.equal(takeProfit.limitPrice, 0.71);
  assert.equal(takeProfit.requestedShares, 100);

  const takeProfitAt = WINDOW_START + 2_000;
  fixture.setNow(takeProfitAt);
  fixture.setBook('UP', 0.71, 0.72, takeProfitAt);
  fixture.bot.processBookPriceCross('UP', takeProfitAt);
  assert.equal(takeProfit.status, 'FILLED');
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitReason, 'RUNG_TAKE_PROFIT');
  assert.equal(position.exitPrice, 0.71);

  const rearmed = activeOrders(fixture.bot, { side: 'UP' }).find((order) =>
    order.action === 'BUY' && order.rungIndex === 3);
  assert.ok(rearmed);
  assert.equal(rearmed.rungCycle, 2);
  assert.equal(rearmed.limitPrice, 0.30);
  assert.equal(rearmed.expiresAt, WINDOW_START + 160_000);
  assert.equal(rearmed.cancelAtSeconds, 160);
});

test('a missed rung target moves to $0.99 at timeout and books $1 per share', () => {
  const fixture = makeBot();
  fixture.tickAt(500);
  for (const order of activeOrders(fixture.bot, { side: 'UP' })) {
    if (order.action === 'BUY' && order.limitPrice !== 0.40) {
      fixture.bot.cancelMakerOrder(order, WINDOW_START + 600, 'CANCELLED_TEST', 'Test setup.');
    }
  }

  const entryAt = WINDOW_START + 1_000;
  fixture.setNow(entryAt);
  fixture.setBook('UP', 0.39, 0.40, entryAt);
  fixture.bot.processBookPriceCross('UP', entryAt);
  const position = fixture.bot.positions.find((item) =>
    item.side === 'UP' && item.rungIndex === 1);
  const originalTakeProfit = fixture.bot.orders.find((order) =>
    order.action === 'SELL' && order.positionId === position.id);
  assert.equal(position.takeProfitPrice, 0.61);

  const deadline = WINDOW_START + 10_000;
  fixture.setNow(deadline);
  fixture.setBook('UP', 0.61, 0.62, deadline);
  fixture.bot.processBookPriceCross('UP', deadline);

  const fallbackTakeProfit = activeOrders(fixture.bot, { side: 'UP' }).find((order) =>
    order.action === 'SELL' && order.positionId === position.id);
  assert.equal(position.status, 'OPEN');
  assert.equal(originalTakeProfit.status, 'CANCELLED_TAKE_PROFIT_TIMEOUT');
  assert.equal(fallbackTakeProfit.limitPrice, 0.99);
  assert.equal(fallbackTakeProfit.payoutPerShare, 1);
  assert.equal(fallbackTakeProfit.takeProfitStage, 'RUNG_TIMEOUT_FALLBACK');
  assert.equal(position.takeProfitPrice, 0.99);
  assert.equal(position.takeProfitStage, 'RUNG_TIMEOUT_FALLBACK');
  assert.equal(fixture.bot.snapshot().ladder.UP[0].takeProfitPrice, 0.99);
  assert.equal(fixture.bot.snapshot().ladder.UP[0].takeProfitStage, 'RUNG_TIMEOUT_FALLBACK');

  const fallbackAt = deadline + 1_000;
  fixture.setNow(fallbackAt);
  fixture.setBook('UP', 0.99, 0.99, fallbackAt);
  fixture.bot.processBookPriceCross('UP', fallbackAt);

  assert.equal(fallbackTakeProfit.status, 'FILLED');
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitReason, 'RUNG_TIMEOUT_TAKE_PROFIT');
  assert.equal(position.exitPrice, 1);
  assert.equal(position.exitBid, 0.99);
  assert.equal(position.exitProceeds, 100);
  assert.equal(fixture.bot.snapshot().lastExitBySide.UP.exitReason, 'RUNG_TIMEOUT_TAKE_PROFIT');
  assert.equal(fixture.bot.snapshot().ladder.UP[0].takeProfitPrice, 0.99);
  assert.equal(activeOrders(fixture.bot, { side: 'UP' })
    .some((order) => order.action === 'BUY' && order.rungIndex === 1), false);
  assert.equal(fixture.bot.snapshot().ladder.UP[0].status, 'TAKE_PROFIT_NO_REARM');
});

test('UP dashboard totals aggregate positions from separate filled rungs', () => {
  const fixture = makeBot();
  fixture.tickAt(500);
  fixture.setNow(WINDOW_START + 1_000);
  fixture.setBook('UP', 0.34, 0.35, WINDOW_START + 1_000);
  fixture.bot.processBookPriceCross('UP', WINDOW_START + 1_000);

  const displayed = fixture.bot.snapshot().positionsBySide.UP;
  assert.equal(displayed.shares, 200);
  assert.equal(displayed.averageCost, 0.375);
  assert.equal(displayed.rungCount, 2);
});

test('open-position floating P&L updates from the live best bid and is included in equity', () => {
  const fixture = makeBot();
  const placedAt = fixture.tickAt(500);
  fixture.setNow(placedAt + 100);
  fixture.bot.processMakerTrade(tradeEvent({
    price: 0.40,
    size: 1,
    timestamp: placedAt + 100,
  }), placedAt + 100);
  const position = fixture.bot.currentPosition('UP', WINDOW_START);
  fixture.setNow(placedAt + 200);
  fixture.setBook('UP', 0.30, 0.31, placedAt + 200);

  const snapshot = fixture.bot.snapshot();
  const displayed = snapshot.positionsBySide.UP;
  const expectedUnrealized = 30 - position.totalCost
    + position.entryEstimatedMakerRebate - position.fees;
  assert.equal(displayed.markPrice, 0.30);
  assert.ok(Math.abs(displayed.unrealizedPnl - expectedUnrealized) < 1e-8);
  assert.ok(Math.abs(snapshot.account.equity - (snapshot.account.cash + 30)) < 1e-8);
  assert.ok(Math.abs(snapshot.account.unrealizedPnl - displayed.unrealizedPnl) < 1e-8);
});

test('best-bid stop loss closes rung shares at $0 without re-arming', () => {
  const fixture = makeBot();
  fixture.tickAt(500);
  for (const order of activeOrders(fixture.bot, { side: 'UP' })) {
    if (order.action === 'BUY' && order.limitPrice !== 0.40) {
      fixture.bot.cancelMakerOrder(order, WINDOW_START + 600, 'CANCELLED_TEST', 'Test setup.');
    }
  }
  const entryAt = WINDOW_START + 1_000;
  fixture.setNow(entryAt);
  fixture.setBook('UP', 0.39, 0.40, entryAt);
  fixture.bot.processBookPriceCross('UP', entryAt);
  const position = fixture.bot.positions.find((item) =>
    item.side === 'UP' && item.rungIndex === 1);
  const exitAt = WINDOW_START + 2_000;
  fixture.setNow(exitAt);
  fixture.bot.handleMarketMessage({
    event_type: 'book',
    asset_id: 'up-token',
    timestamp: String(exitAt),
    bids: [{ price: '0.01', size: '100' }],
    asks: [{ price: '0.02', size: '100' }],
  });

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitReason, 'STOP_LOSS_THRESHOLD');
  assert.equal(position.exitPrice, 0);
  assert.equal(position.shares, 0);
  assert.ok(position.realizedPnl < 0);
  assert.equal(fixture.bot.snapshot().lastExitBySide.UP.exitReason, 'STOP_LOSS_THRESHOLD');
  assert.equal(activeOrders(fixture.bot, { side: 'UP' })
    .some((order) => order.action === 'SELL' && order.positionId === position.id), false);
});

test('backs off repeated Gamma 429 errors and resumes market scanning', async () => {
  let now = WINDOW_START + 1000;
  let scans = 0;
  const marketData = {
    async getBtcMarket(start, windowMs) {
      scans += 1;
      if (scans < 3) throw new Error('gamma-api.polymarket.com HTTP 429');
      return {
        id: 'btc-market',
        conditionId: 'btc-condition',
        slug: `btc-updown-5m-${start / 1000}`,
        title: 'BTC Up or Down',
        start,
        end: start + windowMs,
        tokens: { UP: 'up-token', DOWN: 'down-token' },
      };
    },
    async getBook() {
      return {
        bids: [{ price: '0.59', size: '50' }],
        asks: [{ price: '0.60', size: '50' }],
      };
    },
    connectMarketStream() { return { close() {} }; },
    async getMarket() { return null; },
    resolvedWinner() { return null; },
  };
  const bot = new MarketMakerBot({ marketData, now: () => now, initialCapital: 3000 });

  await bot.tick(now);
  assert.equal(scans, 1);
  assert.equal(bot.status, 'blocked_or_error');

  now += config.MARKET_SCAN_RETRY_BASE_MS - 1;
  await bot.tick(now);
  assert.equal(scans, 1, 'does not retry within the initial backoff');

  now += 1;
  await bot.tick(now);
  assert.equal(scans, 2);

  now += config.MARKET_SCAN_RETRY_BASE_MS * 2 - 1;
  await bot.tick(now);
  assert.equal(scans, 2, 'backs off longer after another failure');

  now += 1;
  await bot.tick(now);
  assert.equal(scans, 3);
  assert.equal(bot.status, 'scanning');
  assert.equal(bot.error, null);
});
