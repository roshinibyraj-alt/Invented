'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OrderFlowBot = require('../order-flow-bot');
const BinanceTickFeed = require('../binance-tick-feed');
const config = require('../config');

const WINDOW_START = 1_800_000_000_000;

function makeFeed(nowRef) {
  return {
    status: 'CONNECTED',
    historyStatus: 'NOT_USED',
    error: null,
    price: 100,
    tickAt: nowRef.value,
    tradeFlow: {
      windowMs: config.FLOW_WINDOW_MS,
      tradeCount: 8,
      buyCount: 7,
      sellCount: 1,
      buyNotional: 900,
      sellNotional: 100,
      signedNotional: 800,
      totalNotional: 1000,
      imbalance: 0.8,
      priceChangePct: 0.0004,
      lastTradeAt: nowRef.value,
    },
    snapshot() {
      this.tickAt = nowRef.value;
      this.tradeFlow.lastTradeAt = nowRef.value;
      return { ...this, tradeFlow: { ...this.tradeFlow } };
    },
    start() {},
    stop() {},
  };
}

function makeBot() {
  const nowRef = { value: WINDOW_START };
  const feed = makeFeed(nowRef);
  const bot = new OrderFlowBot({
    now: () => nowRef.value,
    priceFeed: feed,
    marketData: {},
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
  return { bot, feed, nowRef };
}

function setBook(bot, side, now, bullish, upBidSize = 100) {
  const actualBidSize = side === 'UP'
    ? (bullish ? 100 : upBidSize)
    : (bullish ? 10 : 100);
  const actualAskSize = side === 'UP'
    ? 100
    : (bullish ? 100 : 30);
  bot.applyBookSnapshot({
    asset_id: side === 'UP' ? 'up-token' : 'down-token',
    timestamp: String(now),
    bids: [{ price: side === 'UP' ? '0.59' : '0.39', size: String(actualBidSize) }],
    asks: [{ price: side === 'UP' ? '0.61' : '0.41', size: String(actualAskSize) }],
  }, now);
}

function updateInputs(bot, feed, nowRef, bullish, upBidSize = 100) {
  feed.tradeFlow.imbalance = bullish ? 0.8 : -0.8;
  feed.tradeFlow.buyNotional = bullish ? 900 : 100;
  feed.tradeFlow.sellNotional = bullish ? 100 : 900;
  feed.tradeFlow.signedNotional = feed.tradeFlow.buyNotional - feed.tradeFlow.sellNotional;
  feed.tradeFlow.priceChangePct = bullish ? 0.0004 : -0.0004;
  feed.tradeFlow.buyCount = bullish ? 7 : 1;
  feed.tradeFlow.sellCount = bullish ? 1 : 7;
  setBook(bot, 'UP', nowRef.value, bullish, upBidSize, 100);
  setBook(bot, 'DOWN', nowRef.value, bullish);
}

function step(bot, feed, nowRef, now, bullish) {
  nowRef.value = now;
  updateInputs(bot, feed, nowRef, bullish);
  return bot.processStrategyEntry(now);
}

test('Binance aggregate trades classify aggressive buyer and seller flow', () => {
  let now = WINDOW_START;
  const feed = new BinanceTickFeed({
    now: () => now,
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
    WebSocketImpl: class {},
  });
  feed.handleMessage(JSON.stringify({ p: '100', q: '2', T: now, m: false }));
  now += 500;
  feed.handleMessage(JSON.stringify({ p: '100.1', q: '1.5', T: now, m: true }));

  const flow = feed.tradeFlow(now);
  assert.equal(flow.tradeCount, 2);
  assert.equal(flow.buyCount, 1);
  assert.equal(flow.sellCount, 1);
  assert.ok(Math.abs(flow.imbalance - (200 - 150.15) / (200 + 150.15)) < 1e-12);
  assert.ok(flow.priceChangePct > 0);
});

test('three aligned one-second checks open one 20-share UP clip', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, true);
  step(bot, feed, nowRef, WINDOW_START + 2000, true);

  const position = bot.currentPosition('UP', WINDOW_START);
  assert.ok(position);
  assert.equal(position.shares, config.FLOW_ENTRY_SHARES);
  assert.equal(bot.currentPosition('DOWN', WINDOW_START), null);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 1);
  assert.equal(bot.pressure.confirmedSide, 'UP');
  assert.equal(bot.pressure.confirmationCount, 3);
  assert.ok(position.fees > 0);
});

test('a persistent confirmed signal does not place repeated clips', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }

  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, config.FLOW_ENTRY_SHARES);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 1);
});

test('three confirmed DOWN checks sell UP and buy DOWN independently', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const up = bot.currentPosition('UP', WINDOW_START);
  assert.equal(up.shares, 20);

  for (let second = 3; second < 6; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, false);
  }
  const down = bot.currentPosition('DOWN', WINDOW_START);
  assert.ok(down);
  assert.equal(down.shares, 20);
  assert.equal(up.status, 'SETTLED_EXIT');
  assert.equal(up.shares, 0);
  assert.equal(bot.orders.filter(order => order.action === 'SELL').length, 1);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 2);
  assert.ok(up.exitFees > 0);
  assert.equal(bot.signal.action, 'BUY_DOWN');
});

test('a partial reversal sale is retried when fresh bid depth returns', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const up = bot.currentPosition('UP', WINDOW_START);
  for (let second = 3; second < 6; second += 1) {
    nowRef.value = WINDOW_START + second * 1000;
    updateInputs(bot, feed, nowRef, false, 5);
    bot.processStrategyEntry(nowRef.value);
  }
  assert.equal(up.shares, 15);
  assert.equal(up.exitRequested, true);

  nowRef.value = WINDOW_START + 6000;
  updateInputs(bot, feed, nowRef, false, 100);
  bot.processStrategyEntry(nowRef.value);
  assert.equal(up.shares, 0);
  assert.equal(up.status, 'SETTLED_EXIT');
  assert.equal(bot.orders.filter(order => order.action === 'SELL').length, 2);
});

test('stale Binance input cannot qualify a trade', () => {
  const { bot, feed, nowRef } = makeBot();
  feed.status = 'RECONNECTING';
  for (let second = 0; second < 5; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.pressure.status, 'WAITING_FOR_DATA');
});

test('outstanding UP inventory across unresolved windows enforces the cap', () => {
  const { bot, feed, nowRef } = makeBot();
  bot.positions.push({
    id: 'old-up',
    side: 'UP',
    status: 'PENDING_RESOLUTION',
    shares: 90,
    windowStart: WINDOW_START - config.WINDOW_MS_5M,
  });
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const current = bot.currentPosition('UP', WINDOW_START);
  assert.equal(current.shares, 10);
  assert.equal(bot.totalInventoryForSide('UP'), 100);
});

test('snapshot identifies the paper-only pressure strategy and exposes flow scores', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const state = bot.snapshot();
  assert.equal(state.mode, 'DEMO ONLY');
  assert.equal(state.strategy.id, 'btc-5m-combined-orderflow-reversal');
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.entrySharesPerSignal, 20);
  assert.equal(state.strategy.maxInventoryPerSide, 100);
  assert.equal(state.pressure.requiredConfirmations, 3);
  assert.ok(state.pressure.binance.score > 0);
  assert.ok(state.pressure.polymarket.score > 0);
});
