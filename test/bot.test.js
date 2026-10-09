'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const Bot = require('../bot');
const { makeWindowState, estimateMakerRebate } = require('../bot');
const { slugForTs } = require('../polymarket-market');
const { queueAheadAtLimit } = require('../paper-limit-order');
const { simulateMarketBuy } = require('../paper-market-order');

const OPEN_TS = 1_800_000_000;
const OPEN_MS = OPEN_TS * 1000;

class FakeDemoTrader {
  constructor() {
    this.demoMode = true;
    this.books = new Map();
  }

  async getOrderBook(tokenId) {
    return this.books.get(tokenId) || { bids: [], asks: [] };
  }

  updateQuote() {}
}

function fixture({ rung = 'LOW', attempt = 0 } = {}) {
  const trader = new FakeDemoTrader();
  const bot = new Bot(trader);
  bot.activeRung = rung;
  bot.highRungAttempt = attempt;
  const slug = slugForTs(OPEN_TS);
  const w = makeWindowState(slug, OPEN_TS);
  w.rungAtOpen = rung;
  w.highRungAttemptAtOpen = rung === 'HIGH' ? attempt : 0;
  w.window = {
    slug, openTs: OPEN_TS, closeTs: OPEN_TS + 300,
    tokenUp: 'up-token', tokenDown: 'down-token',
  };
  w.status = 'watching_entries';
  bot.w = w;
  bot.prices = {
    slug, ts: OPEN_MS,
    up: { bid: null, ask: null, mid: null },
    down: { bid: null, ask: null, mid: null },
  };
  return { bot, trader, w, now: OPEN_MS + 1000 };
}

function makeBook(asks = [], bids = []) {
  return {
    asks: asks.map(([price, size]) => ({ price, size })),
    bids: bids.map(([price, size]) => ({ price, size })),
  };
}

async function freezeTime(timestamp, fn) {
  const realNow = Date.now;
  Date.now = () => timestamp;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

async function placeLowOrders(fx, timestamp = fx.now, books = {}) {
  fx.trader.books.set('up-token', books.UP || makeBook([[0.40, 100]], []));
  fx.trader.books.set('down-token', books.DOWN || makeBook([[0.40, 100]], []));
  await freezeTime(timestamp, () => fx.bot._maybePlaceLimitEntries(fx.w, timestamp));
}

async function processBooks(fx, timestamp, books = {}) {
  if (books.UP) fx.bot._booksByToken.set('up-token', { book: books.UP, ts: timestamp });
  if (books.DOWN) fx.bot._booksByToken.set('down-token', { book: books.DOWN, ts: timestamp });
  await freezeTime(timestamp, () => fx.bot._processEntryBooks(fx.w, timestamp));
}

function sendTrade(fx, side, aggressorSide, price, size, timestamp, tx = `tx-${side}-${timestamp}-${price}-${size}`) {
  const tokenId = side === 'UP' ? 'up-token' : 'down-token';
  return freezeTime(timestamp, () => fx.bot._onTrade(fx.w.slug, tokenId, {
    side: aggressorSide, price, size, timestamp, transactionHash: tx,
  }));
}

async function quote(fx, side, bid, ask, timestamp) {
  const tokenId = side === 'UP' ? 'up-token' : 'down-token';
  await freezeTime(timestamp, () => fx.bot._onQuote(fx.w.slug, tokenId, { bid, ask }, 'websocket'));
}

async function restLowOrder(fx, side = 'UP', timestamp = fx.now, queueBook = makeBook([], [])) {
  await placeLowOrders(fx, timestamp);
  const arrival = timestamp + cfg.ENTRY_ORDER_LATENCY_MS + 1;
  const book = side === 'UP' ? { UP: queueBook, DOWN: makeBook([[0.40, 100]], []) }
    : { UP: makeBook([[0.40, 100]], []), DOWN: queueBook };
  await processBooks(fx, arrival, book);
  return { arrival, order: fx.w.sides[side].tranches[0].entryOrder };
}

async function fillLow(fx, side = 'UP', timestamp = fx.now) {
  const { arrival } = await restLowOrder(fx, side, timestamp);
  sendTrade(fx, side, 'SELL', 0.30, 100, arrival + 10, `entry-${side}-${timestamp}`);
  return fx.w.sides[side].tranches[0].position;
}

async function triggerHigh(fx, side = 'UP', timestamp = fx.now, bid = 0.70) {
  const tokenId = side === 'UP' ? 'up-token' : 'down-token';
  fx.trader.books.set(tokenId, makeBook([[0.70, 100]], []));
  await quote(fx, side, bid, Math.min(0.99, bid + 0.01), timestamp);
  const order = fx.w.sides[side].tranches[0].entryOrder;
  return { order, signalAt: timestamp };
}

async function fillHigh(fx, side = 'UP', timestamp = fx.now) {
  await triggerHigh(fx, side, timestamp, 0.72);
  return fx.w.sides[side].tranches[0].position;
}

function approx(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
}

test('strategy config keeps the $0.30 rung martingale and defines the independent $0.70 rung retry/stop', () => {
  assert.equal(cfg.DEMO_CAPITAL, 1000);
  assert.equal(cfg.BASE_SHARES, 10);
  assert.equal(cfg.MARTINGALE_MULTIPLIER, 1.4);
  assert.equal(cfg.ENTRY_LIMIT_PRICE_USD, 0.30);
  assert.equal(cfg.HIGH_RUNG_SIGNAL_BID, 0.70);
  assert.equal(cfg.HIGH_RUNG_ORDER_TYPE, 'MARKET_TAKER');
  assert.equal(cfg.HIGH_RUNG_MAX_ENTRY_PRICE_USD, 0.99);
  assert.equal(cfg.HIGH_RUNG_BASE_SHARES, 30);
  assert.equal(cfg.HIGH_RUNG_RETRY_SHARES, 100);
  assert.equal(cfg.HIGH_RUNG_STOP_LOSS_BID, 0.30);
  assert.equal(cfg.TAKE_PROFIT_BID_USD, 0.99);
  assert.equal(cfg.ENTRY_ORDER_LATENCY_MS, 250);
  approx(estimateMakerRebate(10, 0.99), 0.001386);
});

test('maker queue estimate includes same-price and better-priced bids', () => {
  const book = makeBook([[0.30, 5]], [[0.31, 2], [0.30, 7], [0.29, 90]]);
  approx(queueAheadAtLimit(book, 0.30), 9);
});

test('$0.30 rung posts both exact-price maker limits and does not fill from visible asks', async () => {
  const fx = fixture();
  const placedAt = fx.now;
  await placeLowOrders(fx, placedAt, {
    UP: makeBook([[0.25, 10]], [[0.20, 50]]),
    DOWN: makeBook([[0.40, 10]], [[0.20, 50]]),
  });
  const up = fx.w.sides.UP.tranches[0];
  const down = fx.w.sides.DOWN.tranches[0];
  assert.equal(up.entryOrder.orderType, 'POST_ONLY_LIMIT');
  assert.equal(up.entryOrder.limitPrice, 0.30);
  assert.equal(up.entryOrder.status, 'waiting_to_post');
  assert.equal(down.entryOrder.status, 'waiting_to_post');

  const arrival = placedAt + cfg.ENTRY_ORDER_LATENCY_MS + 1;
  await processBooks(fx, arrival, {
    UP: makeBook([[0.25, 10]], [[0.20, 50]]),
    DOWN: makeBook([[0.40, 10]], [[0.20, 50]]),
  });
  assert.equal(up.entryOrder.status, 'waiting_to_post');
  assert.equal(up.entryOrder.filledShares, 0);
  assert.equal(fx.bot.stats.entries, 0);
  assert.ok(fx.bot.log.some((row) => row.event === 'ENTRY_POST_ONLY_WAITING'));
});

test('$0.30 rung fills exactly at $0.30 only on a later eligible public SELL walkthrough', async () => {
  const fx = fixture();
  const { arrival, order } = await restLowOrder(
    fx, 'UP', fx.now, makeBook([[0.31, 10]], [[0.31, 2], [0.30, 3]]),
  );
  assert.equal(order.status, 'resting');
  assert.equal(order.queueAheadShares, 5);
  sendTrade(fx, 'UP', 'BUY', 0.30, 20, arrival + 10, 'wrong-aggressor');
  sendTrade(fx, 'UP', 'SELL', 0.30, 5, arrival + 20, 'queue-consumed');
  assert.equal(order.filledShares, 0);
  sendTrade(fx, 'UP', 'SELL', 0.29, 10, arrival + 30, 'walked-through-limit');
  assert.equal(order.filledShares, 10);
  const position = fx.w.sides.UP.tranches[0].position;
  assert.equal(position.entryPrice, 0.30);
  assert.equal(position.rung, 'LOW');
  assert.equal(position.entryFee, 0);
  approx(position.makerRebateCredited, estimateMakerRebate(10, 0.30));
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'cancelled_opposite');
  assert.equal(fx.bot.stats.estimatedFees, 0);
  approx(fx.bot.cash, 997 + estimateMakerRebate(10, 0.30));
});

test('first $0.30 side fill cancels the other side and fixes the active side for the window', async () => {
  const fx = fixture();
  const { arrival } = await restLowOrder(fx, 'DOWN', fx.now);
  sendTrade(fx, 'DOWN', 'SELL', 0.30, 2, arrival + 10, 'down-first');
  assert.equal(fx.w.entryWinnerSide, 'DOWN');
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'partially_filled');
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'cancelled_opposite');
  sendTrade(fx, 'UP', 'SELL', 0.30, 10, arrival + 20, 'up-after-cancel');
  assert.equal(fx.w.sides.UP.tranches[0].position, null);
});

test('low-rung TP at $0.99 credits $1/share, no maker fees, and switches next window to high rung', async () => {
  const fx = fixture();
  const position = await fillLow(fx);
  assert.equal(position.shares, 10);
  assert.equal(position.takeProfitOrder.limitPrice, 0.99);
  const postingAt = fx.now + cfg.ENTRY_ORDER_LATENCY_MS + 400;
  await quote(fx, 'UP', 0.98, 1, postingAt);
  await quote(fx, 'UP', 0.98, 1, postingAt + cfg.PAPER_ORDER_LATENCY_MS + 1);
  assert.equal(position.takeProfitOrder.status, 'resting');
  sendTrade(fx, 'UP', 'BUY', 0.99, 10, postingAt + cfg.PAPER_ORDER_LATENCY_MS + 10, 'tp-hit');
  assert.equal(fx.bot.trades.length, 1);
  const closed = fx.bot.trades[0];
  assert.equal(closed.exitPrice, 1);
  assert.equal(closed.exitProceeds, 10);
  assert.equal(closed.fees, 0);
  assert.equal(closed.pnl, 7.03);
  assert.equal(fx.bot.lossStreak, 0);
  assert.equal(fx.bot.activeRung, 'HIGH');
  assert.equal(fx.bot.highRungAttempt, 1);
  assert.equal(fx.bot.snapshot().martingale.nextShares, 30);
  assert.equal(fx.bot.snapshot().account.rebateIncludedInEquity, true);
});

test('low-rung CLOB loss preserves 1.4x martingale and stays on the low rung', async () => {
  const fx = fixture();
  await fillLow(fx, 'UP');
  const closeMs = (OPEN_TS + 300) * 1000;
  await quote(fx, 'UP', 0.015, 0.02, closeMs - 2500);
  await quote(fx, 'DOWN', 0.985, 0.99, closeMs - 1500);
  await freezeTime(closeMs, () => fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED'));
  assert.equal(fx.bot.trades.length, 1);
  assert.equal(fx.bot.trades[0].pnl, -2.97);
  assert.equal(fx.bot.lossStreak, 1);
  assert.equal(fx.bot.activeRung, 'LOW');
  assert.equal(fx.bot.snapshot().martingale.lowRungNextShares, 14);
  assert.equal(fx.bot.snapshot().martingale.nextShares, 14);
});

test('high rung stays idle until a fresh bid reaches $0.70, then sweeps one market buy immediately', async () => {
  const fx = fixture({ rung: 'HIGH', attempt: 1 });
  assert.equal(await placeLowOrders(fx, fx.now), undefined);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder, null);
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder, null);
  await quote(fx, 'UP', 0.69, 0.72, fx.now + 20);
  assert.equal(fx.w.entryOrdersPlacedAt, null);
  fx.trader.books.set('down-token', makeBook([[0.70, 100]], []));
  await quote(fx, 'DOWN', 0.70, 0.72, fx.now + 40);
  const order = fx.w.sides.DOWN.tranches[0].entryOrder;
  assert.equal(order.orderType, 'MARKET_TAKER');
  assert.equal(order.limitPrice, null);
  assert.equal(order.targetShares, 30);
  assert.equal(order.status, 'filled');
  assert.equal(order.averagePrice, 0.70);
  assert.equal(order.rung, 'HIGH');
  approx(fx.w.sides.DOWN.tranches[0].position.entryFee, 0.441);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder, null);
  await quote(fx, 'UP', 0.80, 0.82, fx.now + 50);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder, null);
  assert.equal(fx.w.entrySignalSide, 'DOWN');
});

test('high-rung taker buy uses visible ask prices, charges per-level taker fees, and earns no maker rebate', async () => {
  const fx = fixture({ rung: 'HIGH', attempt: 1 });
  fx.trader.books.set('down-token', makeBook([[0.70, 10], [0.72, 20]], []));
  await quote(fx, 'DOWN', 0.70, 0.72, fx.now);
  const order = fx.w.sides.DOWN.tranches[0].entryOrder;
  const position = fx.w.sides.DOWN.tranches[0].position;
  assert.equal(position.shares, 30);
  approx(position.entryPrice, 21.4 / 30);
  assert.equal(position.rung, 'HIGH');
  assert.equal(position.rungAttempt, 1);
  approx(position.entryFee, 0.42924);
  assert.equal(position.makerRebateCredited, 0);
  approx(fx.bot.stats.estimatedFees, 0.42924);
  assert.equal(order.status, 'filled');
  assert.deepEqual(order.fills.map((fill) => fill.price), [0.70, 0.72]);
  assert.equal(order.fills.every((fill) => fill.maker === false), true);
  assert.equal(fx.bot.log.some((row) => row.event === 'ENTRY_MARKET_TAKER_FILL'), true);
});

test('high rung records no loss when its trigger has no executable ask depth', async () => {
  const fx = fixture({ rung: 'HIGH', attempt: 1 });
  await quote(fx, 'UP', 0.70, 0.72, fx.now);
  const tranche = fx.w.sides.UP.tranches[0];
  assert.equal(tranche.entryOrder.orderType, 'MARKET_TAKER');
  assert.equal(tranche.entryOrder.status, 'cancelled_unfilled');
  assert.equal(tranche.position, null);
  assert.equal(fx.bot.stats.entries, 0);
  assert.equal(fx.bot.stats.losses, 0);
  await quote(fx, 'UP', 0.80, 0.82, fx.now + 20);
  assert.equal(fx.bot.log.filter((row) => row.event === 'HIGH_RUNG_TAKER_TRIGGERED').length, 1);
});

test('market buy cancels unavailable remainder and records only actually executable shares', async () => {
  const result = simulateMarketBuy(makeBook([[0.71, 4]], []), 30, 1000, cfg.TAKER_FEE_RATE);
  assert.equal(result.filledShares, 4);
  assert.equal(result.remainingShares, 26);
  approx(result.fees, 4 * 0.07 * 0.71 * 0.29);
  approx(result.totalCost, 4 * 0.71 + result.fees);
});

test('high-rung ask sweep never pays above the $0.99 ceiling', () => {
  const result = simulateMarketBuy(
    makeBook([[0.99, 2], [0.991, 20]], []), 30, 1000, cfg.TAKER_FEE_RATE,
    cfg.HIGH_RUNG_MAX_ENTRY_PRICE_USD,
  );
  assert.equal(result.filledShares, 2);
  assert.equal(result.remainingShares, 28);
  assert.deepEqual(result.fills.map((fill) => fill.price), [0.99]);
});

test('high-rung stop at a fresh bid of $0.30 or below sells at observed bid, charges taker fee, and arms one 100-share retry', async () => {
  const fx = fixture({ rung: 'HIGH', attempt: 1 });
  const position = await fillHigh(fx);
  await quote(fx, 'UP', 0.30, 0.32, fx.now + 1000);
  assert.equal(position.finalized, true);
  assert.equal(fx.bot.trades[0].reason, 'HIGH_RUNG_STOP_LOSS');
  assert.equal(fx.bot.trades[0].exitPrice, 0.30);
  approx(fx.bot.trades[0].fees, 0.882);
  approx(fx.bot.trades[0].pnl, -12.882, 0.005);
  assert.equal(fx.bot.stats.stopLosses, 1);
  assert.equal(fx.bot.activeRung, 'HIGH');
  assert.equal(fx.bot.highRungAttempt, 2);
  assert.equal(fx.bot.snapshot().martingale.nextShares, 100);
});

test('a high-rung win returns to low; a second high-rung loss also returns to low', () => {
  const { bot } = fixture({ rung: 'HIGH', attempt: 1 });
  const position = (attempt, pnl) => ({
    slug: 'window', openTs: OPEN_TS, side: 'UP', trancheId: 'SINGLE', cycle: attempt,
    rung: 'HIGH', rungAttempt: attempt, shares: 30, entryPrice: 0.70,
    entryNotional: 21, entryFee: 0, exitProceeds: pnl > 0 ? 30 : 0, exitFees: 0,
    netExitProceeds: pnl > 0 ? 30 : 0, clobExitProceeds: 0, clobExitShares: 0,
    realizedPnl: pnl, resolutionOutcome: null, resolutionPricePerShare: null,
    finalized: false,
  });
  bot._finalizeTrade(position(1, 9), 'TAKE_PROFIT');
  assert.equal(bot.activeRung, 'LOW');
  assert.equal(bot.highRungAttempt, 0);
  assert.equal(bot.snapshot().martingale.nextShares, 10);

  bot.activeRung = 'HIGH';
  bot.highRungAttempt = 2;
  bot._finalizeTrade(position(2, -21), 'CLOB_CLOSE_PRICE');
  assert.equal(bot.activeRung, 'LOW');
  assert.equal(bot.highRungAttempt, 0);
  assert.equal(bot.snapshot().martingale.nextShares, 10);
});

test('first high-rung loss advances only the high rung to its 100-share retry', () => {
  const { bot } = fixture({ rung: 'HIGH', attempt: 1 });
  bot._finalizeTrade({
    slug: 'window', openTs: OPEN_TS, side: 'UP', trancheId: 'SINGLE', cycle: 1,
    rung: 'HIGH', rungAttempt: 1, shares: 30, entryPrice: 0.70,
    entryNotional: 21, entryFee: 0, exitProceeds: 0, exitFees: 0, netExitProceeds: 0,
    clobExitProceeds: 0, clobExitShares: 0, realizedPnl: -21,
    finalized: false,
  }, 'CLOB_CLOSE_PRICE');
  assert.equal(bot.activeRung, 'HIGH');
  assert.equal(bot.highRungAttempt, 2);
  assert.equal(bot.snapshot().martingale.nextShares, 100);
  assert.equal(bot.lossStreak, 0);
});

test('unfilled low rung expires without a loss; high attempt 2 creates a single 100-share order only on its trigger', async () => {
  const low = fixture();
  await placeLowOrders(low, low.now, {
    UP: makeBook([[0.40, 20]], [[0.25, 5]]),
    DOWN: makeBook([[0.45, 20]], [[0.25, 5]]),
  });
  await freezeTime((OPEN_TS + 300) * 1000, () => low.bot._finishWindow(low.w, (OPEN_TS + 300) * 1000, 'WINDOW_EXPIRED'));
  assert.equal(low.bot.trades.length, 0);
  assert.equal(low.bot.lossStreak, 0);

  const high = fixture({ rung: 'HIGH', attempt: 2 });
  await quote(high, 'UP', 0.71, 0.73, high.now + 10);
  assert.equal(high.w.sides.UP.tranches[0].entryOrder.targetShares, 100);
  assert.equal(high.w.sides.DOWN.tranches[0].entryOrder, null);
});

test('snapshot reports both rung rules, the active stage, maker-rebate cash treatment, and CLOB-only paper mode', () => {
  const state = fixture().bot.snapshot();
  assert.equal(state.mode, 'DEMO');
  assert.equal(state.strategy.demoCapital, 1000);
  assert.equal(state.strategy.activeRung, 'LOW');
  assert.equal(state.strategy.lowRung.entryLimitPrice, 0.30);
  assert.equal(state.strategy.lowRung.martingaleMultiplier, 1.4);
  assert.equal(state.strategy.highRung.signalBid, 0.70);
  assert.equal(state.strategy.highRung.orderType, 'MARKET_TAKER');
  assert.equal(state.strategy.highRung.maxEntryPrice, 0.99);
  assert.equal(state.strategy.highRung.firstAttemptShares, 30);
  assert.equal(state.strategy.highRung.retryShares, 100);
  assert.equal(state.strategy.highRung.stopLossBid, 0.30);
  assert.equal(state.strategy.takeProfitBid, 0.99);
  assert.equal(state.strategy.takeProfitCreditPerShare, 1);
  assert.equal(state.strategy.entryOrderType, 'POST_ONLY_LIMIT');
  assert.equal(state.strategy.rebateEstimateIsCash, true);
  assert.equal(state.strategy.martingaleScope, 'LOW_RUNG_ONLY');
  assert.equal(state.martingale.scope, 'LOW_RUNG_ONLY');
  assert.equal(state.martingale.nextShares, 10);
  assert.equal(state.strategy.settlementMethod, 'CLOB_CLOSE_PRICE');
});

test('Bot refuses a non-demo order adapter', () => {
  const bot = new Bot({ demoMode: false });
  bot.start();
  assert.equal(bot.executionHalt, true);
  assert.match(bot.error, /DemoTrader/);
  assert.equal(bot.snapshot().mode, 'DEMO');
});
