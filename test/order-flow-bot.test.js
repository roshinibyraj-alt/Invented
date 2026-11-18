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

test('three aligned UP checks buy UP at its midpoint; a one-cent walk fills all shares with maker rebate', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, true);
  step(bot, feed, nowRef, WINDOW_START + 2000, true);

  const order = bot.orders.find(order => order.action === 'BUY');
  assert.ok(order);
  assert.equal(order.orderType, 'PAPER_LIMIT_RESTING_BUY');
  assert.equal(order.status, 'RESTING');
  assert.equal(order.requestedShares, 100);
  assert.equal(order.side, 'UP');
  assert.equal(order.signalSide, 'UP');
  assert.equal(bot.signal.signalSide, 'UP');
  assert.equal(bot.signal.buySide, 'UP');
  assert.equal(order.limitPrice, 0.60);
  assert.equal(order.midpointAtPlacement, 0.60);
  assert.equal(order.timeInForce, 'GTC');
  assert.equal(order.filledShares, 0);
  assert.equal(order.remainingShares, 100);
  assert.equal(order.fees, 0);
  assert.equal(bot.currentPosition('UP', WINDOW_START), null);
  assert.equal(bot.cash, 3000);

  const fillAt = WINDOW_START + 3000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'UP', fillAt, 0.59, 0.58, 1);
  bot.processStrategyEntry(fillAt);

  assert.equal(order.status, 'FILLED');
  assert.equal(order.filledShares, 100);
  assert.equal(order.remainingShares, 0);
  assert.equal(order.averagePrice, 0.60);
  assert.equal(order.fillTriggerMidpoint, 0.59);
  assert.equal(order.midpointAtFill, 0.585);
  assert.equal(order.grossCost, 60);
  assert.equal(order.fees, 0);
  assert.ok(Math.abs(order.estimatedMakerRebate - 0.336) < 1e-9);
  const position = bot.currentPosition('UP', WINDOW_START);
  assert.equal(position.shares, 100);
  assert.equal(position.entryPrice, 0.60);
  assert.equal(position.fees, 0);
  assert.ok(Math.abs(position.estimatedEntryMakerRebate - 0.336) < 1e-9);
  assert.ok(Math.abs(bot.cash - (3000 - 60 + 0.336)) < 1e-9);
});

test('a new confirmed signal cancels the old unfilled order and places a new midpoint limit', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const oldOrder = bot.orders.find(order => order.action === 'BUY' && order.side === 'UP');
  assert.equal(oldOrder.status, 'RESTING');

  neutralStep(bot, feed, nowRef, WINDOW_START + 3000);
  for (let second = 4; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, false);
  }
  const newOrder = bot.orders.find(order => order.action === 'BUY' && order.side === 'DOWN');
  assert.equal(oldOrder.status, 'CANCELLED_REPLACED');
  assert.equal(oldOrder.cancelReason, 'REPLACED_BY_NEW_SIGNAL');
  assert.equal(newOrder.status, 'RESTING');
  assert.equal(newOrder.signalSide, 'DOWN');
  assert.equal(newOrder.limitPrice, 0.40);
  assert.equal(newOrder.requestedShares, 100);
  assert.equal(bot.positions.length, 0);
});

test('a persistent confirmed signal does not repeat the same entry', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }

  assert.equal(bot.currentPosition('UP', WINDOW_START), null);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 1);
  assert.equal(bot.orders.find(order => order.action === 'BUY').status, 'RESTING');
});

test('an opposite confirmed signal sells all old-side shares and submits the same size on the signalled side', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const upEntry = bot.orders.find(order => order.action === 'BUY' && order.side === 'UP');
  const fillAt = WINDOW_START + 3000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'UP', fillAt, 0.59, 0.58);
  bot.processStrategyEntry(fillAt);
  assert.equal(upEntry.status, 'FILLED');
  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 100);

  for (let second = 4; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, false);
  }
  const downOrder = bot.orders.find(order => order.action === 'BUY' && order.side === 'DOWN');
  assert.ok(downOrder);
  assert.equal(downOrder.status, 'RESTING');
  assert.equal(downOrder.signalSide, 'DOWN');
  assert.equal(downOrder.requestedShares, 100);
  assert.equal(downOrder.limitPrice, 0.40);
  assert.equal(bot.currentPosition('UP', WINDOW_START), null);
  assert.equal(bot.currentPosition('DOWN', WINDOW_START), null);
  const flipSell = bot.orders.find(order => order.action === 'SELL'
    && order.orderType === 'PAPER_MARKET_SIGNAL_FLIP');
  assert.ok(flipSell);
  assert.equal(flipSell.status, 'FILLED');
  assert.equal(flipSell.side, 'UP');
  assert.equal(flipSell.filledShares, 100);
  assert.equal(flipSell.averagePrice, 0.59);
  assert.ok(flipSell.sellFee > 0);
  const oldPosition = bot.positions.find(position => position.side === 'UP');
  assert.equal(oldPosition.status, 'SETTLED_EXIT');
  assert.equal(oldPosition.exitReason, 'SIGNAL_FLIP');
  assert.equal(oldPosition.settlementBasis, 'PAPER_SIGNAL_FLIP');
  assert.ok(oldPosition.realizedPnl < 0);
  assert.equal(bot.snapshot().strategy.entries.sideMapping, 'BUY_SIGNALLED_SIDE');
  assert.equal(bot.snapshot().strategy.maxActiveSidesPerWindow, 1);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 2);
  assert.equal(bot.signal.action, 'BUY_DOWN');
  assert.equal(bot.signal.signalSide, 'DOWN');
});

test('a later same-side signal episode adds another 100 shares to the existing side', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const firstOrder = bot.orders.find(order => order.action === 'BUY');
  const firstFillAt = WINDOW_START + 3000;
  nowRef.value = firstFillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'UP', firstFillAt, 0.59, 0.58);
  bot.processStrategyEntry(firstFillAt);
  assert.equal(firstOrder.status, 'FILLED');

  neutralStep(bot, feed, nowRef, WINDOW_START + 4000);
  for (let second = 5; second < 8; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const secondOrder = bot.orders.find(order => order.action === 'BUY' && order !== firstOrder);
  assert.equal(secondOrder.status, 'RESTING');
  assert.equal(secondOrder.side, 'UP');
  assert.equal(secondOrder.requestedShares, 100);

  const secondFillAt = WINDOW_START + 8000;
  nowRef.value = secondFillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'UP', secondFillAt, 0.59, 0.58);
  bot.processStrategyEntry(secondFillAt);
  assert.equal(secondOrder.status, 'FILLED');
  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 200);
  assert.equal(bot.currentPosition('DOWN', WINDOW_START), null);
});

test('a later signal episode replaces the previous unfilled order without changing its 100-share size', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  neutralStep(bot, feed, nowRef, WINDOW_START + 3000);
  for (let second = 4; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }

  const orders = bot.orders.filter(order => order.action === 'BUY' && order.side === 'UP');
  assert.equal(orders.length, 2);
  assert.equal(orders[0].status, 'RESTING');
  assert.equal(orders[1].status, 'CANCELLED_REPLACED');
  assert.equal(orders[1].cancelReason, 'REPLACED_BY_NEW_SIGNAL');
  assert.equal(bot.currentPosition('UP', WINDOW_START), null);
  assert.equal(bot.totalInventoryForSide('UP'), 0);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 2);
});

test('the 0.99 TP closes maker-filled inventory and keeps estimated entry rebate', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const fillAt = WINDOW_START + 3000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'UP', fillAt, 0.59, 0.58);
  bot.processStrategyEntry(fillAt);
  const position = bot.currentPosition('UP', WINDOW_START);
  assert.equal(position.shares, 100);
  assert.equal(position.fees, 0);
  assert.ok(position.estimatedEntryMakerRebate > 0);
  assert.equal(position.lastEntryOrderId && bot.orders.find(order => order.id === position.lastEntryOrderId).status, 'FILLED');
  const closeAt = fillAt + 1000;
  nowRef.value = closeAt;
  setAskAt(bot, 'UP', closeAt, 0.995, 0.99);

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

test('the 0.01 stop-loss closes maker-filled inventory at zero', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const fillAt = WINDOW_START + 3000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'UP', fillAt, 0.59, 0.58);
  bot.processStrategyEntry(fillAt);
  const position = bot.currentPosition('UP', WINDOW_START);
  const closeAt = fillAt + 1000;
  nowRef.value = closeAt;
  setAskAt(bot, 'UP', closeAt, 0.99, 0.01);

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
  setAskAt(bot, 'UP', fillAt, 0.59, 0.58);
  bot.processStrategyEntry(fillAt);
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
  assert.equal(state.positionsBySide.DOWN, null);
  assert.equal(state.pendingResolutionPositions.length, 1);
  assert.equal(state.pendingResolutionPositions[0].id, position.id);
});

test('an unfilled resting entry is cancelled when the strategy opens the next window', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 3; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }
  const order = bot.orders.find(item => item.action === 'BUY');
  const nextWindow = WINDOW_START + config.WINDOW_MS_5M;
  nowRef.value = nextWindow;
  bot.openStrategyWindow(nextWindow, nextWindow);

  assert.equal(order.status, 'CANCELLED_WINDOW_END');
  assert.equal(order.cancelReason, 'WINDOW_ENDED');
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
  const currentOrder = bot.orders.find(order => order.action === 'BUY' && order.side === 'UP');
  assert.equal(currentOrder.status, 'RESTING');
  assert.equal(currentOrder.signalSide, 'UP');
  assert.equal(bot.totalInventoryForSide('UP'), 150);
});

test('snapshot identifies the paper-only pressure strategy and exposes flow scores', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const state = bot.snapshot();
  assert.equal(state.mode, 'DEMO ONLY');
  assert.equal(state.strategy.id, 'btc-5m-combined-orderflow-accumulation');
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.entrySharesPerSignal, 100);
  assert.equal(state.strategy.version, 'btc-5m-combined-orderflow-single-side-flip-v5');
  assert.equal(state.strategy.entries.sideMapping, 'BUY_SIGNALLED_SIDE');
  assert.equal(state.strategy.maxActiveSidesPerWindow, 1);
  assert.equal(state.strategy.maxInventoryPerSide, null);
  assert.equal(state.strategy.usesTakerOrders, true);
  assert.equal(state.strategy.usesMakerOrders, true);
  assert.equal(state.strategy.orderType, 'PAPER_LIMIT_RESTING_BUY + PAPER_MARKET_SIGNAL_FLIP');
  assert.equal(state.strategy.entryLimitPriceSource, 'CURRENT_MIDPOINT');
  assert.equal(state.strategy.entries.limitPriceSource, 'CURRENT_MIDPOINT');
  assert.equal(state.strategy.entries.timeInForce, 'GTC');
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
  setAskAt(bot, 'UP', fillAt, 0.59, 0.58);
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
