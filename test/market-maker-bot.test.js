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

function makeFeed(getNow) {
  return {
    status: 'CONNECTED',
    historyStatus: 'READY',
    error: null,
    price: 100,
    tickAt: getNow(),
    currentCandle: {
      start: WINDOW_START,
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
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

function makeBot({ getNow, feed } = {}) {
  const clock = getNow || (() => WINDOW_START);
  const priceFeed = feed || makeFeed(clock);
  const bot = new MarketMakerBot({
    now: clock,
    marketData: {},
    priceFeed,
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
  setBook(bot, 'UP', 0.4, 0.6, clock());
  setBook(bot, 'DOWN', 0.4, 0.6, clock());
  return bot;
}

function setBook(bot, side, bestBid, bestAsk, now, bidSize = 50, askSize = 50) {
  bot.applyBookSnapshot({
    asset_id: side === 'UP' ? 'up-token' : 'down-token',
    timestamp: String(now),
    bids: [{ price: bestBid.toFixed(2), size: String(bidSize) }],
    asks: [{ price: bestAsk.toFixed(2), size: String(askSize) }],
  }, now);
}

function liveOrders(bot, { side, action, windowStart = WINDOW_START } = {}) {
  return bot.orders.filter((order) =>
    order.orderType === 'PAPER_POST_ONLY_LIMIT'
    && (!side || order.side === side)
    && (!action || order.action === action)
    && Number(order.windowStart) === Number(windowStart)
    && ['RESTING', 'PARTIALLY_FILLED'].includes(order.status));
}

function tradeEvent({ side = 'UP', action = 'SELL', price, size, timestamp }) {
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

test('posts passive UP and DOWN bids without executing taker orders', () => {
  const now = WINDOW_START + 1000;
  const bot = makeBot({ getNow: () => now });

  assert.equal(bot.processStrategyEntry(now), true);
  const bids = liveOrders(bot, { action: 'BUY' });
  assert.equal(bids.length, 2);
  assert.ok(bids.every((order) => order.postOnly === true));
  assert.ok(bids.every((order) => order.status === 'RESTING'));
  assert.ok(bids.every((order) => order.requestedShares === config.MAKER_QUOTE_SHARES));
  assert.ok(bids.every((order) => order.limitPrice < 0.6));
  assert.equal(liveOrders(bot, { action: 'SELL' }).length, 0);
  assert.ok(bot.orders.every((order) => order.orderType === 'PAPER_POST_ONLY_LIMIT'));
});

test('skews fair values away from unresolved inventory and enforces the side cap', () => {
  const now = WINDOW_START + 1000;
  const bot = makeBot({ getNow: () => now });
  bot.positions.push({
    id: 'older-up',
    side: 'UP',
    status: 'PENDING_RESOLUTION',
    shares: config.MAKER_MAX_INVENTORY_PER_SIDE,
    windowStart: WINDOW_START - config.WINDOW_MS_5M,
  });

  bot.processStrategyEntry(now);

  assert.equal(bot.fairValues.netInventory, config.MAKER_MAX_INVENTORY_PER_SIDE);
  assert.equal(bot.fairValues.inventorySkew, config.MAKER_MAX_INVENTORY_SKEW);
  assert.ok(bot.fairValues.UP < bot.fairValues.baseUP);
  assert.ok(bot.fairValues.DOWN > bot.fairValues.baseDOWN);
  assert.equal(liveOrders(bot, { side: 'UP', action: 'BUY' }).length, 0);
  assert.equal(liveOrders(bot, { side: 'DOWN', action: 'BUY' }).length, 1);
});

test('reprices only when the target moves and keeps every quote post-only', () => {
  let now = WINDOW_START + 1000;
  const feed = makeFeed(() => now);
  const bot = makeBot({ getNow: () => now, feed });
  bot.processStrategyEntry(now);
  const original = liveOrders(bot, { side: 'UP', action: 'BUY' })[0];
  assert.ok(original);

  now += 500;
  feed.price = 100.025;
  feed.currentCandle.close = 100.025;
  setBook(bot, 'UP', 0.4, 0.6, now);
  bot.processStrategyEntry(now);
  assert.equal(original.status, 'RESTING', 'a one-tick quote change should retain queue priority');

  now += 500;
  feed.price = 100.12;
  feed.currentCandle.close = 100.12;
  setBook(bot, 'UP', 0.4, 0.6, now);
  bot.processStrategyEntry(now);
  const current = liveOrders(bot, { side: 'UP', action: 'BUY' })[0];
  assert.notEqual(current.id, original.id);
  assert.equal(original.status, 'CANCELLED_REPLACED');
  assert.ok(current.limitPrice < bot.liveQuotes.UP.bestAsk);
});

test('a book touch never fills; trade prints must clear the estimated queue', () => {
  let now = WINDOW_START + 1000;
  const bot = makeBot({ getNow: () => now });
  bot.processStrategyEntry(now);
  const bid = liveOrders(bot, { side: 'UP', action: 'BUY' })[0];

  now += 100;
  bot.handleMarketMessage({
    event_type: 'book',
    asset_id: 'up-token',
    timestamp: String(now),
    bids: [{ price: bid.limitPrice.toFixed(2), size: '5' }],
    asks: [{ price: '0.60', size: '10' }],
  });
  assert.equal(bot.positions.length, 0);
  assert.equal(bid.filledShares, 0);

  now += 100;
  assert.equal(bot.processMakerTrade(tradeEvent({
    price: bid.limitPrice,
    size: bid.queueAheadShares,
    timestamp: now,
  }), now), false);
  assert.equal(bid.queueAheadShares, 0);
  assert.equal(bid.filledShares, 0);

  now += 100;
  assert.equal(bot.processMakerTrade(tradeEvent({
    price: bid.limitPrice,
    size: 7,
    timestamp: now,
  }), now), true);
  const position = bot.currentPosition('UP', WINDOW_START);
  assert.equal(position.shares, 7);
  assert.equal(position.entryFees, 0);
  assert.ok(position.estimatedMakerRebate > 0);
  assert.equal(bid.status, 'PARTIALLY_FILLED');
  assert.equal(liveOrders(bot, { side: 'UP', action: 'SELL' }).length, 1);
});

test('replayed trade prints cannot fill the same maker order twice', () => {
  let now = WINDOW_START + 1000;
  const bot = makeBot({ getNow: () => now });
  bot.processStrategyEntry(now);
  const bid = liveOrders(bot, { side: 'UP', action: 'BUY' })[0];
  const event = tradeEvent({
    price: bid.limitPrice,
    size: bid.queueAheadShares + 5,
    timestamp: now + 100,
  });

  now += 100;
  assert.equal(bot.processMakerTrade(event, now), true);
  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 5);
  assert.equal(bot.processMakerTrade(event, now), false);
  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 5);
});

test('maker sell fills reduce owned inventory and never create a short position', () => {
  let now = WINDOW_START + 1000;
  const bot = makeBot({ getNow: () => now });
  bot.processStrategyEntry(now);
  const bid = liveOrders(bot, { side: 'UP', action: 'BUY' })[0];

  now += 100;
  bot.processMakerTrade(tradeEvent({
    price: bid.limitPrice,
    size: bid.queueAheadShares + 10,
    timestamp: now,
  }), now);
  const position = bot.currentPosition('UP', WINDOW_START);
  assert.equal(position.shares, 10);

  const ask = liveOrders(bot, { side: 'UP', action: 'SELL' })[0];
  assert.equal(ask.requestedShares, 10);
  assert.ok(ask.limitPrice > bot.liveQuotes.UP.bestBid);

  now += 100;
  bot.processMakerTrade(tradeEvent({
    price: ask.limitPrice,
    action: 'BUY',
    size: ask.queueAheadShares + 4,
    timestamp: now,
  }), now);
  assert.equal(position.shares, 6);
  assert.equal(position.status, 'OPEN');

  const remainingAsk = liveOrders(bot, { side: 'UP', action: 'SELL' })[0];
  now += 100;
  bot.processMakerTrade(tradeEvent({
    price: remainingAsk.limitPrice,
    action: 'BUY',
    size: remainingAsk.queueAheadShares + 6,
    timestamp: now,
  }), now);
  assert.equal(position.shares, 0);
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.exitFees, 0);
  assert.equal(position.exitProceeds > 0, true);
  assert.equal(position.realizedPnl > 0, true);
});

test('stale prints are ignored and all quotes cancel before window expiry', () => {
  let now = WINDOW_START + 1000;
  const bot = makeBot({ getNow: () => now });
  bot.processStrategyEntry(now);
  const initialOrders = liveOrders(bot);
  assert.equal(initialOrders.length, 2);

  assert.equal(bot.processMakerTrade(tradeEvent({
    side: 'UP',
    action: 'SELL',
    price: initialOrders[0].limitPrice,
    size: 100,
    timestamp: now - config.MAKER_MAX_TRADE_AGE_MS - 1,
  }), now), false);

  now = WINDOW_START + config.WINDOW_MS_5M - config.MAKER_WINDOW_CUTOFF_MS;
  assert.equal(bot.processStrategyEntry(now), false);
  assert.equal(liveOrders(bot).length, 0);
  assert.ok(initialOrders.every((order) => order.status === 'CANCELLED_WINDOW_CUTOFF'));
  assert.equal(bot.marketMakerState.status, 'CUTOFF');
});

test('window rollover cancels resting orders and sends remaining inventory to resolution', async () => {
  let now = WINDOW_START + 1000;
  const bot = makeBot({ getNow: () => now });
  bot.processStrategyEntry(now);
  const bid = liveOrders(bot, { side: 'UP', action: 'BUY' })[0];
  now += 100;
  bot.processMakerTrade(tradeEvent({
    price: bid.limitPrice,
    size: bid.queueAheadShares + 5,
    timestamp: now,
  }), now);
  const position = bot.currentPosition('UP', WINDOW_START);
  assert.equal(position.shares, 5);
  assert.ok(liveOrders(bot, { side: 'UP', action: 'SELL' }).length);

  const nextWindow = WINDOW_START + config.WINDOW_MS_5M;
  await bot.closePreviousWindows(nextWindow, nextWindow);
  assert.equal(position.status, 'PENDING_RESOLUTION');
  assert.equal(liveOrders(bot, { windowStart: WINDOW_START }).length, 0);
  assert.ok(bot.orders
    .filter((order) => Number(order.windowStart) === WINDOW_START)
    .filter((order) => order.orderType === 'PAPER_POST_ONLY_LIMIT')
    .every((order) => order.status === 'CANCELLED_WINDOW_END' || order.status === 'FILLED'));
});

test('strategy snapshot reports inventory limits, passive execution, and no fixed take-profit', () => {
  const bot = makeBot();
  const state = bot.snapshot();
  assert.equal(state.strategy.id, 'btc-5m-inventory-aware-market-maker');
  assert.equal(state.strategy.version, 'btc-5m-inventory-aware-market-maker-v1');
  assert.equal(state.strategy.orderType, 'PAPER_POST_ONLY_LIMIT');
  assert.equal(state.strategy.postOnly, true);
  assert.equal(state.strategy.quoteSizeShares, 20);
  assert.equal(state.strategy.maxInventoryPerSide, 100);
  assert.equal(state.strategy.usesTakerOrders, false);
  assert.equal(state.strategy.exits.takeProfit, null);
  assert.match(state.strategy.fillRule, /last_trade_price/);
  assert.equal(state.mode, 'DEMO ONLY');
});
