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
    ? (bullish ? 500 : upBidSize)
    : (bullish ? 10 : 500);
  const actualAskSize = 500;
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

function neutralStep(bot, feed, nowRef, now) {
  nowRef.value = now;
  feed.tradeFlow.imbalance = 0;
  feed.tradeFlow.buyNotional = 500;
  feed.tradeFlow.sellNotional = 500;
  feed.tradeFlow.signedNotional = 0;
  feed.tradeFlow.priceChangePct = 0;
  feed.tradeFlow.buyCount = 4;
  feed.tradeFlow.sellCount = 4;
  bot.applyBookSnapshot({
    asset_id: 'up-token',
    timestamp: String(now),
    bids: [{ price: '0.59', size: '100' }],
    asks: [{ price: '0.61', size: '100' }],
  }, now);
  bot.applyBookSnapshot({
    asset_id: 'down-token',
    timestamp: String(now),
    bids: [{ price: '0.39', size: '100' }],
    asks: [{ price: '0.41', size: '100' }],
  }, now);
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

test('three aligned one-second checks open one 100-share UP position', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, true);
  step(bot, feed, nowRef, WINDOW_START + 2000, true);

  const position = bot.currentPosition('UP', WINDOW_START);
  assert.ok(position);
  assert.equal(position.shares, 100);
  assert.equal(bot.currentPosition('DOWN', WINDOW_START), null);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 1);
  assert.equal(bot.pressure.confirmedSide, 'UP');
  assert.equal(bot.pressure.confirmationCount, 3);
  assert.ok(position.fees > 0);
});

test('a persistent confirmed signal does not repeat the same entry', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }

  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 100);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 1);
});

test('opposite confirmed signals accumulate both sides without selling', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const up = bot.currentPosition('UP', WINDOW_START);
  assert.equal(up.shares, 100);

  for (let second = 3; second < 6; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, false);
  }
  const down = bot.currentPosition('DOWN', WINDOW_START);
  assert.ok(down);
  assert.equal(down.shares, 100);
  assert.equal(up.status, 'OPEN');
  assert.equal(up.shares, 100);
  assert.equal(bot.orders.filter(order => order.orderType === 'PAPER_MARKET_SWEEP' && order.action === 'SELL').length, 0);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 2);
  assert.equal(bot.signal.action, 'BUY_DOWN');
});

test('a new confirmed signal episode adds another 100 shares without a cap', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  neutralStep(bot, feed, nowRef, WINDOW_START + 3000);
  for (let second = 4; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }

  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 200);
  assert.equal(bot.totalInventoryForSide('UP'), 200);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 2);
});

test('the 0.99 take-profit closes all accumulated shares at one dollar each', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const position = bot.currentPosition('UP', WINDOW_START);
  const closeAt = WINDOW_START + 3000;
  nowRef.value = closeAt;
  bot.applyBookSnapshot({
    asset_id: 'up-token',
    timestamp: String(closeAt),
    bids: [{ price: '0.99', size: '500' }],
    asks: [],
  }, closeAt);

  bot.processStrategyEntry(closeAt);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.shares, 0);
  assert.equal(position.exitReason, 'TAKE_PROFIT');
  assert.equal(position.exitBid, 0.99);
  assert.equal(position.exitPrice, 1);
  assert.equal(position.exitProceeds, 100);
  assert.equal(position.exitFees, 0);
  assert.equal(position.takeProfitOrder.status, 'FILLED');
});

test('the 0.01 stop-loss closes all accumulated shares at zero', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const position = bot.currentPosition('UP', WINDOW_START);
  const closeAt = WINDOW_START + 3000;
  nowRef.value = closeAt;
  bot.applyBookSnapshot({
    asset_id: 'up-token',
    timestamp: String(closeAt),
    bids: [{ price: '0.01', size: '500' }],
    asks: [{ price: '0.99', size: '500' }],
  }, closeAt);

  bot.processStrategyEntry(closeAt);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.shares, 0);
  assert.equal(position.exitReason, 'STOP_LOSS');
  assert.equal(position.exitBid, 0.01);
  assert.equal(position.exitPrice, 0);
  assert.equal(position.exitProceeds, 0);
  assert.equal(position.outcome, 'LOSS');
  assert.equal(position.takeProfitOrder.status, 'CANCELLED_STOP_LOSS');
});

test('positions not stopped or taken profit move to resolution after window end', async () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const position = bot.currentPosition('UP', WINDOW_START);
  const nextWindow = WINDOW_START + config.WINDOW_MS_5M;
  const closeAt = nextWindow + 1000;

  await bot.closePreviousWindows(nextWindow, closeAt);
  bot.market = {
    ...bot.market,
    start: nextWindow,
    end: nextWindow + config.WINDOW_MS_5M,
    slug: `btc-updown-5m-${nextWindow / 1000}`,
  };
  bot.openStrategyWindow(nextWindow, closeAt);
  const state = bot.snapshot();

  assert.equal(position.status, 'PENDING_RESOLUTION');
  assert.equal(position.shares, 100);
  assert.equal(state.positionsBySide.UP, null);
  assert.equal(state.pendingResolutionPositions.length, 1);
  assert.equal(state.pendingResolutionPositions[0].id, position.id);
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

test('unresolved shares remain visible but do not cap new signals', () => {
  const { bot, feed, nowRef } = makeBot();
  bot.positions.push({
    id: 'old-up',
    side: 'UP',
    status: 'PENDING_RESOLUTION',
    shares: 150,
    windowStart: WINDOW_START - config.WINDOW_MS_5M,
  });
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const current = bot.currentPosition('UP', WINDOW_START);
  assert.equal(current.shares, 100);
  assert.equal(bot.totalInventoryForSide('UP'), 250);
});

test('snapshot identifies the paper-only pressure strategy and exposes flow scores', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const state = bot.snapshot();
  assert.equal(state.mode, 'DEMO ONLY');
  assert.equal(state.strategy.id, 'btc-5m-combined-orderflow-accumulation');
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.entrySharesPerSignal, 100);
  assert.equal(state.strategy.maxInventoryPerSide, null);
  assert.equal(state.strategy.exit.takeProfit.triggerPrice, 0.99);
  assert.equal(state.strategy.exit.stopLoss.triggerPrice, 0.01);
  assert.equal(state.pressure.requiredConfirmations, 3);
  assert.ok(state.pressure.binance.score > 0);
  assert.ok(state.pressure.polymarket.score > 0);
});
