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
    bids: [{ price: side === 'UP' ? '0.47' : '0.39', size: String(actualBidSize) }],
    asks: [{ price: side === 'UP' ? '0.49' : '0.41', size: String(actualAskSize) }],
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

function setAskAt(bot, side, now, ask, bid = ask - 0.02, size = 500) {
  bot.applyBookSnapshot({
    asset_id: side === 'UP' ? 'up-token' : 'down-token',
    timestamp: String(now),
    bids: [{ price: String(bid), size: String(size) }],
    asks: [{ price: String(ask), size: String(size) }],
  }, now);
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

test('three aligned UP checks buy the opposite side and account for taker fees', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, true);
  step(bot, feed, nowRef, WINDOW_START + 2000, true);

  const order = bot.orders.find(order => order.action === 'BUY');
  assert.ok(order);
  assert.equal(order.orderType, 'PAPER_MARKET_BUY');
  assert.equal(order.status, 'FILLED');
  assert.equal(order.requestedShares, 100);
  assert.equal(order.filledShares, 100);
  assert.equal(order.remainingShares, 0);
  assert.equal(order.unfilledShares, 0);
  assert.equal(order.side, 'DOWN');
  assert.equal(order.signalSide, 'UP');
  assert.equal(bot.signal.signalSide, 'UP');
  assert.equal(bot.signal.buySide, 'DOWN');
  assert.equal(order.bestAskAtSubmission, 0.41);
  assert.equal(order.averagePrice, 0.41);
  assert.equal(order.fills.length, 1);
  assert.ok(order.fees > 0);
  assert.equal(order.estimatedMakerRebate, 0);
  assert.equal(order.timeInForce, 'FAK');
  assert.equal(order.immediateOrCancel, true);
  assert.match(order.fillRule, /PARTIAL_FILL_ALLOWED/);
  const position = bot.currentPosition('DOWN', WINDOW_START);
  assert.equal(position.shares, 100);
  assert.equal(position.entryPrice, 0.41);
  assert.equal(position.fees, order.fees);
  assert.equal(position.estimatedEntryMakerRebate, 0);
  assert.ok(Math.abs(bot.cash - (3000 - order.grossCost - order.fees)) < 1e-9);
});

test('a shallow ask book partially fills and cancels the unfilled market-order remainder', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, true);
  const fillAt = WINDOW_START + 2000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'DOWN', fillAt, 0.48, 0.46, 40);
  bot.submitMarketBuy('DOWN', fillAt, bot.pressure, 'UP');

  const order = bot.orders.find(item => item.action === 'BUY');
  assert.equal(order.orderType, 'PAPER_MARKET_BUY');
  assert.equal(order.status, 'PARTIALLY_FILLED');
  assert.equal(order.requestedShares, 100);
  assert.equal(order.filledShares, 40);
  assert.equal(order.remainingShares, 0);
  assert.equal(order.unfilledShares, 60);
  assert.equal(order.cancelledShares, 60);
  assert.equal(order.cancelReason, 'FAK_REMAINDER_CANCELLED');
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 40);
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).fees, order.fees);
  assert.equal(bot.orders.some(item => item.action === 'BUY' && item.status === 'RESTING'), false);
});

test('market entry sweeps multiple ask levels and records the weighted average fill', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, true);
  const fillAt = WINDOW_START + 2000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'DOWN', fillAt, 0.48, 0.46, 40);
  bot.books.DOWN.asks.push({ price: 0.49, size: 500, availableSize: 500 });
  bot.processStrategyEntry(fillAt);

  const order = bot.orders.find(item => item.action === 'BUY');
  assert.equal(order.status, 'FILLED');
  assert.deepEqual(order.fills.map(fill => [fill.price, fill.shares]), [[0.48, 40], [0.49, 60]]);
  assert.ok(Math.abs(order.grossCost - 48.6) < 1e-9);
  assert.ok(Math.abs(order.averagePrice - 0.486) < 1e-9);
  assert.ok(order.fees > 0);
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 100);
});

test('a signal-side ask above $0.49 does not block the reversed entry', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, true);
  const blockedAt = WINDOW_START + 2000;
  nowRef.value = blockedAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'UP', blockedAt, 0.70, 0.68);
  bot.processStrategyEntry(blockedAt);

  const order = bot.orders.find(item => item.action === 'BUY');
  assert.ok(order);
  assert.equal(order.side, 'DOWN');
  assert.equal(order.signalSide, 'UP');
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 100);
  assert.equal(bot.pressure.candidateSide, 'UP');
  assert.equal(bot.pressure.priceBlockedSide, undefined);
});

test('market buys have no entry price floor or ceiling', () => {
  const { bot, nowRef } = makeBot();
  setAskAt(bot, 'UP', nowRef.value, 0.95, 0.93);
  const highPrice = bot.submitMarketBuy('UP', nowRef.value, {}, 'DOWN');
  assert.equal(highPrice.status, 'FILLED');
  assert.equal(highPrice.bestAskAtSubmission, 0.95);
  assert.equal(highPrice.filledShares, 100);

  const fillAt = nowRef.value + 1;
  nowRef.value = fillAt;
  setAskAt(bot, 'DOWN', fillAt, 0.03, 0.01);
  const lowPrice = bot.submitMarketBuy('DOWN', fillAt, {}, 'UP');
  assert.equal(lowPrice.status, 'FILLED');
  assert.equal(lowPrice.bestAskAtSubmission, 0.03);
  assert.equal(lowPrice.filledShares, 100);
});

test('a persistent confirmed signal does not repeat the same reversed entry', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }

  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 100);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 1);
  assert.equal(bot.orders.find(order => order.action === 'BUY').status, 'FILLED');
});

test('an opposite pressure signal buys its reversed side and sells profitable old inventory', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const downEntry = bot.orders.find(order => order.action === 'BUY' && order.side === 'DOWN');
  const fillAt = WINDOW_START + 3000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'DOWN', fillAt, 0.59, 0.58);
  bot.processStrategyEntry(fillAt);
  assert.equal(downEntry.status, 'FILLED');
  const oldPosition = bot.currentPosition('DOWN', WINDOW_START);
  assert.equal(oldPosition.shares, 100);
  // Model a position whose average entry has improved before the reversal signal.
  oldPosition.totalCost = 30;
  oldPosition.initialTotalCost = 30;
  oldPosition.entryPrice = 0.30;
  oldPosition.avgEntry = 0.30;
  bot.cash += 11;

  for (let second = 4; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, false);
  }
  const upOrder = bot.orders.find(order => order.action === 'BUY' && order.side === 'UP');
  assert.ok(upOrder);
  assert.equal(upOrder.status, 'FILLED');
  assert.equal(upOrder.requestedShares, 100);
  assert.equal(bot.currentPosition('DOWN', WINDOW_START), null);
  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 100);
  const profitExit = bot.orders.find(order => order.action === 'SELL'
    && order.orderType === 'PAPER_MARKET_OPPOSITE_SIGNAL_EXIT');
  assert.ok(profitExit);
  assert.equal(profitExit.status, 'FILLED');
  assert.equal(profitExit.side, 'DOWN');
  assert.equal(profitExit.filledShares, 100);
  assert.equal(profitExit.averagePrice, 0.39);
  assert.ok(profitExit.sellFee > 0);
  assert.equal(oldPosition.status, 'SETTLED_EXIT');
  assert.equal(oldPosition.exitReason, 'OPPOSITE_SIGNAL_PROFIT_EXIT');
  assert.equal(oldPosition.settlementBasis, 'PAPER_OPPOSITE_SIGNAL_EXIT');
  assert.ok(oldPosition.realizedPnl > 0);
  assert.equal(bot.snapshot().strategy.entries.sideMapping, 'BUY_OPPOSITE_OF_PRESSURE_SIGNAL');
  assert.equal(bot.snapshot().strategy.maxActiveSidesPerWindow, 2);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 2);
  assert.equal(bot.signal.action, 'BUY_UP');
  assert.equal(bot.signal.buySide, 'UP');
  assert.equal(bot.signal.oppositeExitStatus, 'SOLD_PROFITABLE_OPPOSITE');
  assert.equal(bot.signal.oppositeSharesSold, 100);
  assert.equal(bot.signal.signalSide, 'DOWN');
});

test('an unprofitable opposite position stays open while the new signal side is bought', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const fillAt = WINDOW_START + 3000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'DOWN', fillAt, 0.59, 0.58);
  bot.processStrategyEntry(fillAt);

  for (let second = 4; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, false);
  }

  const position = bot.currentPosition('DOWN', WINDOW_START);
  assert.equal(position.shares, 100);
  assert.equal(position.status, 'OPEN');
  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 100);
  assert.equal(bot.orders.some(order => order.orderType === 'PAPER_MARKET_OPPOSITE_SIGNAL_EXIT'), false);
  assert.equal(bot.orders.some(order => order.action === 'BUY' && order.side === 'DOWN'), true);
  assert.equal(bot.signal.buySide, 'UP');
  assert.equal(bot.signal.oppositeExitStatus, 'HELD_NOT_PROFITABLE');
  assert.ok(bot.signal.currentPositionNetPnl < 0);
  assert.match(bot.signal.reason, /Held 100 DOWN shares/);
  assert.equal(bot.snapshot().strategy.activeSide, 'BOTH');
});

test('a later same-side signal episode adds another 100 shares to the existing side', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const firstOrder = bot.orders.find(order => order.action === 'BUY');
  assert.equal(firstOrder.status, 'FILLED');
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 100);

  neutralStep(bot, feed, nowRef, WINDOW_START + 4000);
  for (let second = 5; second < 8; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const secondOrder = bot.orders.find(order => order.action === 'BUY' && order !== firstOrder);
  assert.equal(secondOrder.status, 'FILLED');
  assert.equal(secondOrder.side, 'DOWN');
  assert.equal(secondOrder.requestedShares, 100);
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 200);
  assert.equal(bot.currentPosition('UP', WINDOW_START), null);
});

test('each separate confirmed signal episode submits a fresh immediate market buy', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  neutralStep(bot, feed, nowRef, WINDOW_START + 3000);
  for (let second = 4; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }

  const orders = bot.orders.filter(order => order.action === 'BUY' && order.side === 'DOWN');
  assert.equal(orders.length, 2);
  assert.ok(orders.every(order => order.orderType === 'PAPER_MARKET_BUY' && order.status === 'FILLED'));
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 200);
  assert.equal(bot.totalInventoryForSide('DOWN'), 200);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 2);
});

test('the 0.99 TP closes market-bought inventory and retains only its own rebate', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const position = bot.currentPosition('DOWN', WINDOW_START);
  assert.equal(position.shares, 100);
  assert.ok(position.fees > 0);
  assert.equal(position.estimatedEntryMakerRebate, 0);
  assert.equal(position.lastEntryOrderId && bot.orders.find(order => order.id === position.lastEntryOrderId).status, 'FILLED');
  const closeAt = WINDOW_START + 3000;
  nowRef.value = closeAt;
  setAskAt(bot, 'DOWN', closeAt, 0.995, 0.99);

  bot.processStrategyEntry(closeAt);

  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.shares, 0);
  assert.equal(position.exitReason, 'TAKE_PROFIT');
  assert.equal(position.exitBid, 0.99);
  assert.equal(position.exitPrice, 1);
  assert.equal(position.exitProceeds, 100);
  assert.equal(position.exitFees, 0);
  assert.ok(position.estimatedExitMakerRebate > 0);
  assert.equal(position.takeProfitOrder.status, 'FILLED');
});

test('the 0.01 stop-loss closes market-bought inventory at zero', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const position = bot.currentPosition('DOWN', WINDOW_START);
  const closeAt = WINDOW_START + 3000;
  nowRef.value = closeAt;
  setAskAt(bot, 'DOWN', closeAt, 0.99, 0.01);

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
  const fillAt = WINDOW_START + 3000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'DOWN', fillAt, 0.59, 0.58);
  bot.processStrategyEntry(fillAt);
  const position = bot.currentPosition('DOWN', WINDOW_START);
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
  assert.equal(state.positionsBySide.DOWN, null);
  assert.equal(state.pendingResolutionPositions.length, 1);
  assert.equal(state.pendingResolutionPositions[0].id, position.id);
});

test('market-order remainders are cancelled immediately and never rest into a new window', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, true);
  const fillAt = WINDOW_START + 2000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'DOWN', fillAt, 0.48, 0.46, 40);
  bot.submitMarketBuy('DOWN', fillAt, bot.pressure, 'UP');
  const order = bot.orders.find(item => item.action === 'BUY');
  assert.equal(order.status, 'PARTIALLY_FILLED');
  assert.equal(order.unfilledShares, 60);
  assert.equal(order.remainingShares, 0);
  const nextWindow = WINDOW_START + config.WINDOW_MS_5M;
  nowRef.value = nextWindow;
  bot.openStrategyWindow(nextWindow, nextWindow);

  assert.equal(order.status, 'PARTIALLY_FILLED');
  assert.equal(order.cancelReason, 'FAK_REMAINDER_CANCELLED');
  assert.equal(order.remainingShares, 0);
  assert.equal(bot.orders.filter(item => item.action === 'BUY' && item.status === 'RESTING').length, 0);
});

test('completed window win rate uses combined net results and excludes unresolved windows', () => {
  const { bot, nowRef } = makeBot();
  const makePosition = (windowStart, side, pnl, status = 'SETTLED_EXIT') => ({
    strategyId: bot.strategyId,
    windowStart,
    windowEnd: windowStart + config.WINDOW_MS_5M,
    side,
    status,
    initialShares: 100,
    realizedPnl: pnl,
  });
  bot.positions.push(
    makePosition(WINDOW_START, 'UP', 12),
    makePosition(WINDOW_START, 'DOWN', -4),
    makePosition(WINDOW_START + config.WINDOW_MS_5M, 'UP', -9),
    makePosition(WINDOW_START + config.WINDOW_MS_5M, 'DOWN', 2),
    makePosition(WINDOW_START + 2 * config.WINDOW_MS_5M, 'UP', 10, 'PENDING_RESOLUTION'),
  );
  nowRef.value = WINDOW_START + 3 * config.WINDOW_MS_5M;

  const stats = bot.completedWindowStats(nowRef.value);
  assert.equal(stats.completed, 2);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  assert.equal(stats.breakEven, 0);
  assert.equal(stats.winRate, 50);
  assert.deepEqual(stats.windows.map(window => window.netPnl), [8, -7]);
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
  const currentOrder = bot.orders.find(order => order.action === 'BUY' && order.side === 'DOWN');
  assert.equal(currentOrder.status, 'FILLED');
  assert.equal(currentOrder.signalSide, 'UP');
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 100);
  assert.equal(bot.totalInventoryForSide('DOWN'), 100);
});

test('snapshot identifies the paper-only pressure strategy and exposes flow scores', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const state = bot.snapshot();
  assert.equal(state.mode, 'DEMO ONLY');
  assert.equal(state.strategy.id, 'btc-5m-combined-orderflow-accumulation');
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.entrySharesPerSignal, 100);
  assert.equal(state.strategy.version, 'btc-5m-independent-side-profit-exit-v11-reversed-no-entry-price-filter');
  assert.equal(state.strategy.entries.sideMapping, 'BUY_OPPOSITE_OF_PRESSURE_SIGNAL');
  assert.equal(state.strategy.maxActiveSidesPerWindow, 2);
  assert.match(state.strategy.entries.oppositeSignalProfitabilityRule, /pressure signal always triggers a buy on the opposite outcome side independently/i);
  assert.equal(state.strategy.maxInventoryPerSide, null);
  assert.equal(state.strategy.usesTakerOrders, true);
  assert.equal(state.strategy.usesMakerOrders, true);
  assert.equal(state.strategy.orderType, 'PAPER_MARKET_BUY + PAPER_MARKET_OPPOSITE_SIGNAL_EXIT');
  assert.equal(state.strategy.entryPriceSource, 'VISIBLE_ASK_MARKET_SWEEP');
  assert.equal(state.strategy.entries.priceFilter, null);
  assert.equal(state.strategy.entries.timeInForce, 'FAK');
  assert.equal(state.strategy.entries.partialFillsAllowed, true);
  assert.equal(state.strategy.entries.cancelUnfilledOnNextSignal, false);
  assert.equal(state.account.completedWindowCount, 0);
  assert.ok(Array.isArray(state.account.equityCurve));
  assert.equal(state.strategy.exit.takeProfit.triggerPrice, 0.99);
  assert.equal(state.strategy.exit.stopLoss.triggerPrice, 0.01);
  assert.equal(state.pressure.requiredConfirmations, 3);
  assert.ok(state.pressure.binance.score > 0);
  assert.ok(state.pressure.polymarket.score > 0);
});

test('global equity includes fresh bid marks for open positions', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }

  const fillAt = WINDOW_START + 3000;
  nowRef.value = fillAt;
  setAskAt(bot, 'DOWN', fillAt, 0.59, 0.58);
  bot.processStrategyEntry(fillAt);

  const state = bot.snapshot();
  const position = state.openWindowPositions[0];
  assert.equal(position.markStatus, 'LIVE');
  assert.equal(position.markBid, 0.58);
  assert.ok(Math.abs(position.markValue - 58) < 1e-8);
  assert.ok(Math.abs(state.account.markedValue - 58) < 1e-8);
  assert.equal(state.account.unpricedOpenPositions, 0);
  assert.ok(Math.abs(state.account.equity - (state.account.cash + 58)) < 1e-8);
  assert.equal(state.account.equityCurve.at(-1).equity, state.account.equity);
});
