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

test('both $0.20 resting entries are placed and the first best-ask touch cancels its opposite', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  let orders = bot.orders.filter(order => order.orderType === 'PAPER_LIMIT_BUY');
  assert.equal(orders.length, 2);
  assert.ok(orders.every(order => order.status === 'RESTING'));
  assert.ok(orders.every(order => order.limitPrice === 0.20 && order.requestedShares === 100));
  assert.equal(bot.positions.length, 0);

  const fillAt = WINDOW_START + 1000;
  nowRef.value = fillAt;
  setAskAt(bot, 'UP', fillAt, 0.20, 0.18);
  bot.processStrategyEntry(fillAt);
  const order = bot.orders.find(item => item.orderType === 'PAPER_LIMIT_BUY' && item.side === 'UP');
  const opposite = bot.orders.find(item => item.orderType === 'PAPER_LIMIT_BUY' && item.side === 'DOWN');
  assert.ok(order);
  assert.equal(order.status, 'FILLED');
  assert.equal(order.requestedShares, 100);
  assert.equal(order.filledShares, 100);
  assert.equal(order.remainingShares, 0);
  assert.equal(order.side, 'UP');
  assert.equal(order.averagePrice, 0.20);
  assert.equal(order.fees, 0);
  assert.equal(opposite.status, 'CANCELLED_OTHER_SIDE_FILLED');
  assert.equal(opposite.cancelReason, 'OTHER_SIDE_FILLED');
  assert.equal(order.fills.length, 1);
  assert.equal(order.estimatedMakerRebate, 0);
  assert.equal(order.timeInForce, 'GTD_WINDOW');
  assert.equal(order.immediateOrCancel, false);
  const position = bot.currentPosition('UP', WINDOW_START);
  assert.equal(position.shares, 100);
  assert.equal(position.entryPrice, 0.20);
  assert.equal(position.fees, 0);
  assert.equal(position.estimatedEntryMakerRebate, 0);
  assert.equal(bot.cash, 2980);
  assert.equal(bot.firstFilledSide, 'UP');
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
  assert.equal(bot.orders.some(item => item.orderType === 'PAPER_LIMIT_BUY' && item.status === 'RESTING'), true);
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
  bot.submitMarketBuy('DOWN', fillAt, bot.pressure, 'UP');

  const order = bot.orders.find(item => item.action === 'BUY');
  assert.equal(order.status, 'FILLED');
  assert.deepEqual(order.fills.map(fill => [fill.price, fill.shares]), [[0.48, 40], [0.49, 60]]);
  assert.ok(Math.abs(order.grossCost - 48.6) < 1e-9);
  assert.ok(Math.abs(order.averagePrice - 0.486) < 1e-9);
  assert.ok(order.fees > 0);
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 100);
});

test('pressure scores do not affect price-triggered entry placement', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders.filter(order => order.orderType === 'PAPER_LIMIT_BUY' && order.status === 'RESTING').length, 2);
  assert.equal(bot.pressure.candidateSide, null);
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

test('resting limit orders remain active until a fill or the window boundary', () => {
  const { bot, feed, nowRef } = makeBot();
  for (let second = 0; second < 7; second += 1) {
    step(bot, feed, nowRef, WINDOW_START + second * 1000, true);
  }

  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders.filter(order => order.orderType === 'PAPER_LIMIT_BUY' && order.status === 'RESTING').length, 2);
});

test('a filled-side midpoint of $0.10 buys 200 opposite shares once and never sells', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const fillAt = WINDOW_START + 1000;
  nowRef.value = fillAt;
  setAskAt(bot, 'UP', fillAt, 0.20, 0.18);
  setAskAt(bot, 'DOWN', fillAt, 0.41, 0.39);
  bot.processStrategyEntry(fillAt);
  const firstSidePosition = bot.currentPosition('UP', WINDOW_START);
  assert.equal(firstSidePosition.shares, 100);

  const triggerAt = fillAt + 1000;
  nowRef.value = triggerAt;
  setAskAt(bot, 'UP', triggerAt, 0.10, 0.08);
  setAskAt(bot, 'DOWN', triggerAt, 0.41, 0.39);
  bot.processStrategyEntry(triggerAt);
  bot.processStrategyEntry(triggerAt + 1);

  const reversal = bot.orders.find(order => order.orderType === 'PAPER_MARKET_BUY');
  assert.ok(reversal);
  assert.equal(reversal.side, 'DOWN');
  assert.equal(reversal.requestedShares, 200);
  assert.equal(reversal.filledShares, 200);
  assert.ok(reversal.fees > 0);
  assert.equal(bot.currentPosition('UP', WINDOW_START), firstSidePosition);
  assert.equal(firstSidePosition.status, 'OPEN');
  assert.equal(bot.currentPosition('DOWN', WINDOW_START).shares, 200);
  assert.equal(bot.orders.filter(order => order.orderType === 'PAPER_MARKET_BUY').length, 1);
  assert.equal(bot.orders.some(order => order.action === 'SELL'), false);
  assert.equal(bot.priceStrategyState.reversalTriggered, true);
});

test('a high bid never causes an early exit', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const fillAt = WINDOW_START + 1000;
  nowRef.value = fillAt;
  setAskAt(bot, 'UP', fillAt, 0.20, 0.18);
  bot.processStrategyEntry(fillAt);
  const position = bot.currentPosition('UP', WINDOW_START);
  assert.equal(position.shares, 100);
  const closeAt = fillAt + 1000;
  nowRef.value = closeAt;
  setAskAt(bot, 'UP', closeAt, 0.995, 0.99);

  bot.processStrategyEntry(closeAt);

  assert.equal(position.status, 'OPEN');
  assert.equal(position.shares, 100);
  assert.equal(position.exitReason, undefined);
  assert.equal(position.takeProfitOrder, undefined);
  assert.equal(bot.orders.some(order => order.action === 'SELL'), false);
});

test('a low midpoint buys the opposite side without selling the filled position', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const fillAt = WINDOW_START + 1000;
  nowRef.value = fillAt;
  setAskAt(bot, 'DOWN', fillAt, 0.20, 0.18);
  setAskAt(bot, 'UP', fillAt, 0.41, 0.39);
  bot.processStrategyEntry(fillAt);
  const position = bot.currentPosition('DOWN', WINDOW_START);
  const closeAt = fillAt + 1000;
  nowRef.value = closeAt;
  setAskAt(bot, 'DOWN', closeAt, 0.03, 0.01);
  setAskAt(bot, 'UP', closeAt, 0.41, 0.39);

  bot.processStrategyEntry(closeAt);

  assert.equal(position.status, 'OPEN');
  assert.equal(position.shares, 100);
  assert.equal(position.exitReason, undefined);
  assert.equal(position.takeProfitOrder, undefined);
  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 200);
  assert.equal(bot.orders.filter(order => order.orderType === 'PAPER_MARKET_BUY').length, 1);
  assert.equal(bot.orders.some(order => order.action === 'SELL'), false);
});

test('open positions move to official resolution at window end', async () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const fillAt = WINDOW_START + 1000;
  nowRef.value = fillAt;
  setAskAt(bot, 'DOWN', fillAt, 0.20, 0.18);
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

test('reversal market remainders cancel immediately and unfilled limits expire at window end', async () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  step(bot, feed, nowRef, WINDOW_START + 1000, true);
  const fillAt = WINDOW_START + 2000;
  nowRef.value = fillAt;
  updateInputs(bot, feed, nowRef, true);
  setAskAt(bot, 'DOWN', fillAt, 0.48, 0.46, 40);
  bot.submitMarketBuy('DOWN', fillAt, bot.pressure, 'UP');
  const order = bot.orders.find(item => item.orderType === 'PAPER_MARKET_BUY');
  assert.equal(order.status, 'PARTIALLY_FILLED');
  assert.equal(order.unfilledShares, 60);
  assert.equal(order.remainingShares, 0);
  const nextWindow = WINDOW_START + config.WINDOW_MS_5M;
  nowRef.value = nextWindow;
  await bot.closePreviousWindows(nextWindow, nextWindow);
  const previousLimits = bot.orders.filter(item => item.orderType === 'PAPER_LIMIT_BUY'
    && Number(item.windowStart) === WINDOW_START);
  assert.ok(previousLimits.every(item => item.status === 'CANCELLED_WINDOW_END'));
  bot.market = {
    ...bot.market,
    start: nextWindow,
    end: nextWindow + config.WINDOW_MS_5M,
  };
  bot.openStrategyWindow(nextWindow, nextWindow);

  assert.equal(order.status, 'PARTIALLY_FILLED');
  assert.equal(order.cancelReason, 'FAK_REMAINDER_CANCELLED');
  assert.equal(order.remainingShares, 0);
  assert.equal(bot.orders.filter(item => item.orderType === 'PAPER_LIMIT_BUY'
    && Number(item.windowStart) === nextWindow && item.status === 'RESTING').length, 2);
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

test('stale Binance input does not block CLOB price-triggered fills', () => {
  const { bot, feed, nowRef } = makeBot();
  feed.status = 'RECONNECTING';
  step(bot, feed, nowRef, WINDOW_START, true);
  const fillAt = WINDOW_START + 1000;
  nowRef.value = fillAt;
  setAskAt(bot, 'UP', fillAt, 0.20, 0.18);
  bot.processStrategyEntry(fillAt);
  assert.equal(bot.currentPosition('UP', WINDOW_START).shares, 100);
  assert.equal(bot.priceStrategyState.firstFilledSide, 'UP');
});

test('unresolved shares remain visible while the next window places fresh limits', () => {
  const { bot, feed, nowRef } = makeBot();
  bot.positions.push({
    id: 'old-up',
    side: 'UP',
    status: 'PENDING_RESOLUTION',
    shares: 150,
    windowStart: WINDOW_START - config.WINDOW_MS_5M,
  });
  step(bot, feed, nowRef, WINDOW_START, true);
  const currentOrders = bot.orders.filter(order => order.orderType === 'PAPER_LIMIT_BUY'
    && Number(order.windowStart) === WINDOW_START);
  assert.equal(currentOrders.length, 2);
  assert.ok(currentOrders.every(order => order.status === 'RESTING'));
  assert.equal(bot.currentPosition('DOWN', WINDOW_START), null);
  assert.equal(bot.totalInventoryForSide('UP'), 150);
});

test('snapshot identifies the paper-only price strategy and its active orders', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const state = bot.snapshot();
  assert.equal(state.mode, 'DEMO ONLY');
  assert.equal(state.strategy.id, 'btc-5m-two-sided-limit-and-reversal');
  assert.equal(state.strategy.execution, 'PAPER ONLY');
  assert.equal(state.strategy.entrySharesPerSignal, 100);
  assert.equal(state.strategy.version, 'btc-5m-dual-020-resting-limit-midpoint-010-reversal-v13');
  assert.equal(state.strategy.entries.sideMapping, 'REST_BOTH_UP_AND_DOWN_LIMIT_BUYS');
  assert.equal(state.strategy.maxActiveSidesPerWindow, 2);
  assert.equal(state.strategy.maxInventoryPerSide, null);
  assert.equal(state.strategy.usesTakerOrders, true);
  assert.equal(state.strategy.usesMakerOrders, true);
  assert.equal(state.strategy.orderType, 'PAPER_LIMIT_BUY + PAPER_MARKET_BUY');
  assert.equal(state.strategy.entryPriceSource, 'RESTING_LIMIT_AT_FIXED_PRICE');
  assert.equal(state.strategy.entries.limitPrice, 0.20);
  assert.equal(state.strategy.entries.sharesPerSide, 100);
  assert.equal(state.strategy.entries.partialFillsAllowed, false);
  assert.equal(state.strategy.entries.cancelOtherSideOnFill, true);
  assert.equal(state.strategy.entries.reversalTrigger, 'FILLED_SIDE_MIDPOINT_AT_OR_BELOW_0.10');
  assert.equal(state.strategy.entries.reversalShares, 200);
  assert.equal(state.account.completedWindowCount, 0);
  assert.ok(Array.isArray(state.account.equityCurve));
  assert.equal(state.strategy.exit.takeProfit, null);
  assert.equal(state.strategy.exit.stopLoss, null);
  assert.equal(state.strategy.exit.orderType, 'POLYMARKET_RESOLUTION_ONLY');
  assert.match(state.strategy.exit.trigger, /No early sells/);
  assert.equal(state.entryOrders.length, 2);
  assert.equal(state.flowStats.pendingMakerBuys, 2);
});

test('global equity includes fresh bid marks for open positions', () => {
  const { bot, feed, nowRef } = makeBot();
  step(bot, feed, nowRef, WINDOW_START, true);
  const fillAt = WINDOW_START + 1000;
  nowRef.value = fillAt;
  setAskAt(bot, 'UP', fillAt, 0.20, 0.18);
  bot.processStrategyEntry(fillAt);

  const state = bot.snapshot();
  const position = state.openWindowPositions[0];
  assert.equal(position.markStatus, 'LIVE');
  assert.equal(position.markBid, 0.18);
  assert.ok(Math.abs(position.markValue - 18) < 1e-8);
  assert.ok(Math.abs(state.account.markedValue - 18) < 1e-8);
  assert.equal(state.account.unpricedOpenPositions, 0);
  assert.ok(Math.abs(state.account.equity - (state.account.cash + 18)) < 1e-8);
  assert.equal(state.account.equityCurve.at(-1).equity, state.account.equity);
});
