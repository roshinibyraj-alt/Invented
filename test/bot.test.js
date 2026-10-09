'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const Bot = require('../bot');
const { makeWindowState, estimateMakerRebate } = require('../bot');
const { slugForTs } = require('../polymarket-market');
const { simulateLimitBuy, queueAheadAtLimit } = require('../paper-limit-order');

const OPEN_TS = 1_800_000_000;
const OPEN_MS = OPEN_TS * 1000;

class FakeDemoTrader {
  constructor() {
    this.demoMode = true;
    this.books = new Map();
    this.calls = [];
  }

  async getOrderBook(tokenId) {
    this.calls.push({ kind: 'read-book', tokenId });
    return this.books.get(tokenId) || { bids: [], asks: [] };
  }

  updateQuote() {}
}

function fixture() {
  const trader = new FakeDemoTrader();
  const bot = new Bot(trader);
  const slug = slugForTs(OPEN_TS);
  const w = makeWindowState(slug, OPEN_TS);
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

function freezeTime(timestamp, fn) {
  const realNow = Date.now;
  Date.now = () => timestamp;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

async function placePairedOrders(fx, books = {}, timestamp = fx.now) {
  fx.trader.books.set('up-token', books.UP || makeBook());
  fx.trader.books.set('down-token', books.DOWN || makeBook());
  await freezeTime(timestamp, () => fx.bot._maybePlaceLimitEntries(fx.w, timestamp));
}

function refreshBook(fx, side, book, timestamp) {
  const tokenId = side === 'UP' ? 'up-token' : 'down-token';
  fx.bot._booksByToken.set(tokenId, { book, ts: timestamp });
  return tokenId;
}

async function processBooks(fx, timestamp, books = {}) {
  for (const side of ['UP', 'DOWN']) {
    if (books[side]) refreshBook(fx, side, books[side], timestamp);
  }
  freezeTime(timestamp, () => fx.bot._processEntryBooks(fx.w, timestamp));
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

async function makeMarketablePosition(fx, side = 'UP', ask = 0.25, timestamp = fx.now) {
  const upBook = side === 'UP' ? makeBook([[ask, 10]], [[0.20, 100]]) : makeBook([[0.40, 10]], [[0.20, 100]]);
  const downBook = side === 'DOWN' ? makeBook([[ask, 10]], [[0.20, 100]]) : makeBook([[0.40, 10]], [[0.20, 100]]);
  await placePairedOrders(fx, { UP: upBook, DOWN: downBook }, timestamp);
  const arrived = timestamp + cfg.ENTRY_ORDER_LATENCY_MS + 1;
  await processBooks(fx, arrived, {
    [side]: makeBook([[ask, 10]], [[0.20, 100]]),
    [side === 'UP' ? 'DOWN' : 'UP']: makeBook([[0.40, 10]], [[0.20, 100]]),
  });
  await quote(fx, side, 0.20, ask, arrived + 1);
  return fx.w.sides[side].tranches[0].position;
}

function approx(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
}

test('new strategy uses shared $1,000 cash, 10 base shares, 1.4x martingale, $0.30 entry, and $0.99 TP', () => {
  assert.equal(cfg.DEMO_CAPITAL, 1000);
  assert.equal(cfg.BASE_SHARES, 10);
  assert.equal(cfg.MARTINGALE_MULTIPLIER, 1.4);
  assert.equal(cfg.ENTRY_LIMIT_PRICE_USD, 0.30);
  assert.equal(cfg.TAKE_PROFIT_BID_USD, 0.99);
  assert.equal(cfg.ENTRY_ORDER_LATENCY_MS, 250);
  approx(estimateMakerRebate(10, 0.99), 0.001386);
});

test('limit utility only consumes asks at or below the limit and estimates visible queue', () => {
  const book = makeBook([[0.25, 2], [0.30, 5], [0.31, 100]], [[0.30, 7]]);
  const plan = simulateLimitBuy(book, 10, 0.30, 1000, cfg.TAKER_FEE_RATE);
  approx(plan.filledShares, 7);
  approx(plan.averagePrice, (2 * 0.25 + 5 * 0.30) / 7);
  assert.equal(plan.remainingShares, 3);
  approx(queueAheadAtLimit(book, 0.30), 7);
});

test('posts both sides at $0.30 and a crossing ask fills only after modeled arrival; opposite is cancelled', async () => {
  const fx = fixture();
  const placedAt = OPEN_MS + 1000;
  await placePairedOrders(fx, {
    UP: makeBook([[0.25, 10]], [[0.20, 50]]),
    DOWN: makeBook([[0.40, 10]], [[0.20, 50]]),
  }, placedAt);
  const up = fx.w.sides.UP.tranches[0];
  const down = fx.w.sides.DOWN.tranches[0];
  assert.equal(up.entryOrder.orderType, 'LIMIT');
  assert.equal(up.entryOrder.limitPrice, 0.30);
  assert.equal(down.entryOrder.status, 'waiting_to_post');
  assert.equal(fx.bot.stats.entries, 0);

  const arrival = placedAt + cfg.ENTRY_ORDER_LATENCY_MS + 1;
  await processBooks(fx, arrival, {
    UP: makeBook([[0.25, 10]], [[0.20, 50]]),
    DOWN: makeBook([[0.40, 10]], [[0.20, 50]]),
  });
  assert.equal(up.entryOrder.status, 'filled');
  assert.equal(up.position.shares, 10);
  approx(up.position.entryPrice, 0.25);
  assert.equal(down.entryOrder.status, 'cancelled_opposite');
  assert.equal(fx.w.entryWinnerSide, 'UP');
  assert.equal(fx.bot.stats.entries, 1);
  assert.ok(fx.bot.log.some((row) => row.event === 'FIRST_SIDE_FILLED'));
});

test('simultaneously marketable books use a stable deterministic side priority', async () => {
  const fx = fixture();
  const placedAt = OPEN_MS + 1000;
  const crossing = makeBook([[0.28, 10]], [[0.25, 50]]);
  await placePairedOrders(fx, { UP: crossing, DOWN: crossing }, placedAt);
  const arrival = placedAt + cfg.ENTRY_ORDER_LATENCY_MS + 1;
  await processBooks(fx, arrival, { UP: crossing, DOWN: crossing });
  assert.equal(fx.w.entryWinnerSide, 'UP');
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'filled');
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'cancelled_opposite');
});

test('an ask above $0.30 does not fill; only a later eligible SELL print can fill the resting order', async () => {
  const fx = fixture();
  const placedAt = OPEN_MS + 1000;
  await placePairedOrders(fx, {
    UP: makeBook([[0.31, 10]], [[0.30, 4]]),
    DOWN: makeBook([[0.50, 10]], [[0.20, 20]]),
  }, placedAt);
  const arrival = placedAt + cfg.ENTRY_ORDER_LATENCY_MS + 1;
  await processBooks(fx, arrival, {
    UP: makeBook([[0.31, 10]], [[0.30, 4]]),
    DOWN: makeBook([[0.50, 10]], [[0.20, 20]]),
  });
  const upOrder = fx.w.sides.UP.tranches[0].entryOrder;
  assert.equal(upOrder.status, 'resting');
  assert.equal(upOrder.filledShares, 0);
  assert.equal(fx.w.entryWinnerSide, null);

  sendTrade(fx, 'UP', 'BUY', 0.30, 20, arrival + 10, 'wrong-aggressor');
  assert.equal(upOrder.filledShares, 0);
  sendTrade(fx, 'UP', 'SELL', 0.30, 4, arrival + 20, 'at-limit-behind-queue');
  assert.equal(upOrder.filledShares, 0);
  sendTrade(fx, 'UP', 'SELL', 0.30, 7, arrival + 30, 'at-limit-after-queue');
  approx(upOrder.filledShares, 7);
  approx(fx.w.sides.UP.tranches[0].position.entryPrice, 0.30);
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'cancelled_opposite');
});

test('partial maker fill locks the side, keeps its remainder resting, and never opens the opposite outcome', async () => {
  const fx = fixture();
  const placedAt = OPEN_MS + 1000;
  await placePairedOrders(fx, {}, placedAt);
  const arrival = placedAt + cfg.ENTRY_ORDER_LATENCY_MS + 1;
  await processBooks(fx, arrival, {
    UP: makeBook([], [[0.30, 0]]),
    DOWN: makeBook([], [[0.30, 0]]),
  });
  sendTrade(fx, 'DOWN', 'SELL', 0.30, 2, arrival + 10, 'down-first');
  const down = fx.w.sides.DOWN.tranches[0];
  assert.equal(fx.w.entryWinnerSide, 'DOWN');
  assert.equal(down.entryOrder.status, 'partially_filled');
  approx(down.entryOrder.filledShares, 2);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'cancelled_opposite');
  sendTrade(fx, 'UP', 'SELL', 0.30, 10, arrival + 20, 'up-after-cancel');
  assert.equal(fx.w.sides.UP.tranches[0].position, null);
});

test('TP triggers at $0.99 and credits $1/share; only its marketable entry pays the modeled fee', async () => {
  const fx = fixture();
  const position = await makeMarketablePosition(fx);
  assert.equal(position.shares, 10);
  assert.equal(position.takeProfitOrder.limitPrice, 0.99);
  const tpAt = fx.now + cfg.ENTRY_ORDER_LATENCY_MS + 400;
  await quote(fx, 'UP', 0.98, 1, tpAt);
  assert.equal(position.takeProfitOrder.status, 'resting');
  sendTrade(fx, 'UP', 'BUY', 0.99, 10, tpAt + 10, 'tp-hit');
  assert.equal(fx.bot.trades.length, 1);
  const closed = fx.bot.trades[0];
  assert.equal(closed.exitPrice, 1);
  assert.equal(closed.exitProceeds, 10);
  approx(closed.fees, 0.13125, 0.0001);
  assert.equal(closed.pnl, 7.37);
  assert.equal(fx.bot.lossStreak, 0);
  assert.equal(fx.bot.snapshot().martingale.nextShares, 10);
});

test('a single shared loss increases both sides to 14 shares, then a win resets to 10', () => {
  const { bot } = fixture();
  const makePosition = (side, pnl) => ({
    slug: 'window', openTs: OPEN_TS, side, trancheId: 'SINGLE', cycle: 1,
    shares: 10, entryPrice: 0.30, entryNotional: 3, entryFee: 0,
    exitPrice: pnl < 0 ? 0 : 1, exitProceeds: pnl < 0 ? 0 : 10,
    netExitProceeds: pnl < 0 ? 0 : 10, clobExitPrice: null,
    clobExitProceeds: 0, clobExitShares: 0, fees: 0,
    realizedPnl: pnl, resolutionOutcome: null,
    resolutionPricePerShare: null, finalized: false,
  });
  bot._finalizeTrade(makePosition('DOWN', -3), 'CLOB_CLOSE_PRICE');
  assert.equal(bot.snapshot().martingale.lossStreak, 1);
  assert.equal(bot.snapshot().martingale.nextShares, 14);
  assert.equal(bot.snapshot().martingale.UP.nextShares, 14);
  assert.equal(bot.snapshot().martingale.DOWN.nextShares, 14);
  bot._finalizeTrade(makePosition('UP', 7), 'TAKE_PROFIT');
  assert.equal(bot.snapshot().martingale.lossStreak, 0);
  assert.equal(bot.snapshot().martingale.nextShares, 10);
});

test('at window close, open position is settled by CLOB bids and both unfilled orders are canceled', async () => {
  const fx = fixture();
  const position = await makeMarketablePosition(fx, 'UP', 0.25, fx.now);
  const closeMs = (OPEN_TS + 300) * 1000;
  await quote(fx, 'UP', 0.985, 0.99, closeMs - 2500);
  await quote(fx, 'DOWN', 0.015, 0.99, closeMs - 1500);
  await freezeTime(closeMs, () => fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED'));
  assert.equal(position.finalized, true);
  assert.equal(fx.w.closeResolution.winner, 'UP');
  assert.equal(fx.bot.trades.length, 1);
  assert.equal(fx.bot.trades[0].resolutionPricePerShare, 1);
  assert.ok(fx.bot.trades[0].pnl > 0);
  assert.equal(fx.bot.pending.length, 0);
  assert.equal(fx.bot.lossStreak, 0);
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'cancelled_opposite');
});

test('a CLOB-classified losing position advances the shared next-window size', async () => {
  const fx = fixture();
  await makeMarketablePosition(fx, 'DOWN', 0.25, fx.now);
  const closeMs = (OPEN_TS + 300) * 1000;
  await quote(fx, 'UP', 0.985, 0.99, closeMs - 2500);
  await quote(fx, 'DOWN', 0.015, 0.99, closeMs - 1500);
  await freezeTime(closeMs, () => fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED'));
  assert.equal(fx.bot.trades.length, 1);
  assert.equal(fx.bot.trades[0].side, 'DOWN');
  assert.equal(fx.bot.trades[0].pnl, -2.63);
  assert.equal(fx.bot.lossStreak, 1);
  assert.equal(fx.bot.snapshot().martingale.nextShares, 14);
});

test('unfilled paired limits expire without inventing a trade or changing the martingale', async () => {
  const fx = fixture();
  const placedAt = OPEN_MS + 1000;
  await placePairedOrders(fx, {
    UP: makeBook([[0.40, 10]], [[0.25, 20]]),
    DOWN: makeBook([[0.45, 10]], [[0.25, 20]]),
  }, placedAt);
  const closeMs = (OPEN_TS + 300) * 1000;
  await freezeTime(closeMs, () => fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED'));
  assert.equal(fx.bot.trades.length, 0);
  assert.equal(fx.bot.stats.losses, 0);
  assert.equal(fx.bot.lossStreak, 0);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'cancelled_window');
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'cancelled_window');
  assert.equal(fx.bot.snapshot().martingale.nextShares, 10);
});

test('snapshot exposes the limit, first-fill cancellation, shared martingale, and demo-only settlement settings', () => {
  const state = fixture().bot.snapshot();
  assert.equal(state.mode, 'DEMO');
  assert.equal(state.strategy.demoCapital, 1000);
  assert.equal(state.strategy.sharedCapital, true);
  assert.equal(state.strategy.entryLimitPrice, 0.30);
  assert.equal(state.strategy.entryOrderLatencyMs, 250);
  assert.equal(state.strategy.firstFillCancelsOpposite, true);
  assert.equal(state.strategy.takeProfitBid, 0.99);
  assert.equal(state.strategy.takeProfitCreditPerShare, 1);
  assert.equal(state.strategy.hardStopLossBid, null);
  assert.equal(state.strategy.entryOrderType, 'LIMIT');
  assert.equal(state.strategy.martingaleMultiplier, 1.4);
  assert.equal(state.martingale.independent, false);
  assert.equal(state.martingale.scope, 'SHARED_ONE_TRADE_PER_WINDOW');
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
