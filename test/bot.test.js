'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const Bot = require('../bot');
const { makeWindowState, estimateMakerRebate } = require('../bot');
const { slugForTs } = require('../polymarket-market');

const OPEN_TS = 1_800_000_000;

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
    slug, ts: OPEN_TS * 1000,
    up: { bid: null, ask: null, mid: null },
    down: { bid: null, ask: null, mid: null },
  };
  return { bot, trader, w, now: OPEN_TS * 1000 + cfg.ENTRY_DELAY_MS + 500 };
}

async function quote(fx, side, bid, ask, timestamp = fx.now) {
  const tokenId = side === 'UP' ? fx.w.window.tokenUp : fx.w.window.tokenDown;
  const realNow = Date.now;
  try {
    Date.now = () => timestamp;
    await fx.bot._onQuote(fx.w.slug, tokenId, { bid, ask }, 'websocket');
  } finally {
    Date.now = realNow;
  }
}

function trade(fx, side, aggressorSide, price, size, timestamp = fx.now + 100, tx = `tx-${side}-${timestamp}-${price}-${size}`) {
  const tokenId = side === 'UP' ? fx.w.window.tokenUp : fx.w.window.tokenDown;
  const realNow = Date.now;
  try {
    Date.now = () => timestamp;
    return fx.bot._onTrade(fx.w.slug, tokenId, {
      side: aggressorSide, price, size, timestamp, transactionHash: tx,
    });
  } finally {
    Date.now = realNow;
  }
}

function makeBook(asks = [], bids = []) {
  return {
    asks: asks.map(([price, size]) => ({ price, size })),
    bids: bids.map(([price, size]) => ({ price, size })),
  };
}

async function fireMarketOrders(fx, books, timestamp = fx.now) {
  fx.trader.books.set('up-token', books.UP || makeBook());
  fx.trader.books.set('down-token', books.DOWN || makeBook());
  const realNow = Date.now;
  try {
    Date.now = () => timestamp;
    await fx.bot._maybePlaceMarketEntries(fx.w, timestamp);
  } finally {
    Date.now = realNow;
  }
}

async function openMarketPosition(fx, side = 'UP', ask = 0.45, size = 10) {
  const otherSide = side === 'UP' ? 'DOWN' : 'UP';
  await fireMarketOrders(fx, {
    [side]: makeBook([[ask, size]], [[Math.max(0.01, ask - 0.05), 100]]),
    [otherSide]: makeBook(),
  });
  const bid = Math.max(0.01, ask - 0.05);
  await quote(fx, side, bid, ask, fx.now + 300);
  return fx.w.sides[side].tranches[0].position;
}

async function openBothMarketPositions(fx, upAsk = 0.45, downAsk = 0.45, size = 10) {
  await fireMarketOrders(fx, {
    UP: makeBook([[upAsk, size]], [[Math.max(0.01, upAsk - 0.05), 100]]),
    DOWN: makeBook([[downAsk, size]], [[Math.max(0.01, downAsk - 0.05), 100]]),
  });
  for (const [side, ask] of [['UP', upAsk], ['DOWN', downAsk]]) {
    await quote(fx, side, Math.max(0.01, ask - 0.05), ask, fx.now + 300);
  }
}

function approx(actual, expected, epsilon = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be near ${expected}`);
}

test('strategy constants use a shared $1,000 bankroll, a 3-second market-entry delay and $0.99 TP', () => {
  assert.equal(cfg.DEMO_CAPITAL, 1000);
  assert.equal(cfg.BASE_SHARES, 10);
  assert.equal(cfg.MARTINGALE_MULTIPLIER, 1.8);
  assert.equal(cfg.ENTRY_REFERENCE_PRICE_USD, 0.45);
  assert.equal(cfg.ENTRY_DELAY_MS, 3000);
  assert.equal(cfg.TAKE_PROFIT_BID_USD, 0.99);
  assert.equal(cfg.TAKER_FEE_RATE, 0.07);
  assert.equal(cfg.REBATE_FEE_EQUIVALENT_RATE, 0.07);
  assert.equal(cfg.MAKER_REBATE_RATE, 0.20);
  assert.equal(cfg.PAPER_ORDER_LATENCY_MS, 250);
  approx(estimateMakerRebate(10, 0.45), 0.03465);
});

test('market entries wait until +3 seconds, ignore the old $0.45 cap, and charge per-level taker fees', async () => {
  const fx = fixture();
  fx.trader.books.set('up-token', makeBook([[0.60, 6], [0.70, 4]], [[0.55, 20]]));
  fx.trader.books.set('down-token', makeBook([[0.90, 10]], [[0.85, 20]]));

  await fireMarketOrders(fx, {
    UP: fx.trader.books.get('up-token'),
    DOWN: fx.trader.books.get('down-token'),
  }, OPEN_TS * 1000 + cfg.ENTRY_DELAY_MS - 1);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder, null);
  assert.equal(fx.w.marketEntryTriggeredAt, null);

  await fireMarketOrders(fx, {
    UP: fx.trader.books.get('up-token'),
    DOWN: fx.trader.books.get('down-token'),
  }, OPEN_TS * 1000 + cfg.ENTRY_DELAY_MS);
  const up = fx.w.sides.UP.tranches[0];
  const down = fx.w.sides.DOWN.tranches[0];
  assert.equal(up.entryOrder.orderType, 'MARKET');
  assert.equal(up.entryOrder.status, 'filled');
  approx(up.position.entryPrice, 0.64);
  approx(up.position.entryNotional, 6.4);
  approx(up.position.entryFee, 0.1596);
  approx(down.position.entryPrice, 0.90);
  approx(down.position.entryFee, 0.063);
  approx(fx.bot.cash, 1000 - 6.4 - 0.1596 - 9 - 0.063);
  approx(fx.bot.stats.estimatedFees, 0.2226);
  assert.equal(fx.bot.snapshot().account.reservedCash, 0);
});

test('market buys only fill visible depth and cancel an unfilled remainder', async () => {
  const fx = fixture();
  await fireMarketOrders(fx, {
    UP: makeBook([[0.80, 4]], [[0.75, 20]]),
    DOWN: makeBook(),
  });
  const up = fx.w.sides.UP.tranches[0];
  assert.equal(up.entryOrder.status, 'partial_fill_remainder_cancelled');
  assert.equal(up.entryOrder.orderType, 'MARKET');
  approx(up.entryOrder.filledShares, 4);
  approx(up.entryOrder.unfilledShares, 6);
  approx(up.position.entryPrice, 0.80);
  approx(up.position.shares, 4);
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'no_fill');
  assert.equal(fx.w.sides.DOWN.tranches[0].position, null);
  assert.ok(fx.bot.log.some((row) => row.event === 'MARKET_BUY_NO_FILL'));
});

test('TP remains a post-only $0.99 sell; entry taker fee is included in P&L and rebates stay separate', async () => {
  const fx = fixture();
  const position = await openMarketPosition(fx);
  assert.equal(position.takeProfitOrder.limitPrice, 0.99);
  assert.equal(position.takeProfitOrder.status, 'resting');
  await quote(fx, 'UP', 0.99, 1.00, fx.now + 700);
  assert.equal(position.openShares, 10);
  trade(fx, 'UP', 'SELL', 0.99, 10, fx.now + 800, 'tp-wrong-side');
  assert.equal(position.openShares, 10);

  trade(fx, 'UP', 'BUY', 0.99, 10, fx.now + 900, 'tp-fill');
  assert.equal(fx.bot.trades.length, 1);
  const closed = fx.bot.trades[0];
  assert.equal(closed.entryPrice, 0.45);
  assert.equal(closed.exitPrice, 0.99);
  assert.equal(closed.exitProceeds, 9.9);
  approx(closed.fees, 0.1733, 1e-4);
  approx(closed.pnl, 5.23, 1e-4);
  approx(closed.makerFeeEquivalent, 0.00693);
  approx(closed.estimatedMakerRebate, 0.001386);
  approx(fx.bot.cash, 1005.22675);
  approx(fx.bot.stats.estimatedFees, 0.17325);
  approx(fx.bot.stats.realizedPnl, 5.22675);
  approx(fx.bot.snapshot().account.equity, 1005.23, 1e-4);
  assert.equal(fx.bot.lossStreak.UP, 0);
});

test('window close cancels both maker orders and settles remaining shares from final-three-second CLOB bids', async () => {
  const fx = fixture();
  await openBothMarketPositions(fx);
  const closeMs = (OPEN_TS + 300) * 1000;
  await quote(fx, 'UP', 0.985, 0.99, closeMs - 2500);
  await quote(fx, 'DOWN', 0.015, 0.99, closeMs - 1500);
  await fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED');
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'filled');
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'filled');
  assert.equal(fx.w.sides.UP.tranches[0].position, null);
  assert.equal(fx.w.sides.DOWN.tranches[0].position, null);
  assert.equal(fx.w.closed, true);
  assert.equal(fx.w.closeResolution.method, 'CLOB_CLOSE_PRICE');
  assert.equal(fx.w.closeResolution.winner, 'UP');
  assert.equal(fx.w.closeResolution.thresholdMatched, true);
  assert.equal(fx.w.closeResolution.source, 'FINAL_3_SECONDS');
  assert.equal(fx.bot.snapshot().account.reservedCash, 0);
  assert.notEqual(fx.bot.snapshot().account.equity, null);
  assert.equal(fx.bot.pending.length, 0);
  assert.equal(fx.bot.trades.length, 2);
  const upTrade = fx.bot.trades.find((item) => item.side === 'UP');
  const downTrade = fx.bot.trades.find((item) => item.side === 'DOWN');
  assert.equal(upTrade.reason, 'CLOB_CLOSE_PRICE');
  assert.equal(upTrade.resolutionOutcome, 'UP');
  assert.equal(upTrade.resolutionPricePerShare, 1);
  assert.ok(upTrade.pnl > 0);
  assert.equal(downTrade.resolutionOutcome, 'UP');
  assert.equal(downTrade.resolutionPricePerShare, 0);
  assert.ok(downTrade.pnl < 0);
  assert.equal(fx.bot.lossStreak.UP, 0);
  assert.equal(fx.bot.lossStreak.DOWN, 1);
  assert.equal(fx.bot.snapshot().martingale.UP.nextShares, 10);
  assert.equal(fx.bot.snapshot().martingale.DOWN.nextShares, 18);
  assert.equal(fx.bot.log.filter((entry) => entry.event === 'WINDOW_CLOB_CLOSE_CLASSIFIED').length, 1);
  assert.equal(fx.bot.log.filter((entry) => entry.event === 'TAKE_PROFIT_LIMIT_CANCELLED').length, 2);
});

test('close falls back to last in-window CLOB bids and never leaves a position pending', async () => {
  const fx = fixture();
  await openMarketPosition(fx, 'UP');
  const closeMs = (OPEN_TS + 300) * 1000;
  await fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED');

  const snapshot = fx.bot.snapshot();
  assert.equal(fx.w.closeResolution.source, 'LAST_WINDOW_QUOTE');
  assert.equal(fx.w.closeResolution.bids.UP, 0.40);
  assert.equal(fx.w.closeResolution.bids.DOWN, null);
  assert.equal(fx.w.closeResolution.winner, 'UP');
  assert.equal(fx.bot.trades.length, 1);
  assert.equal(fx.bot.trades[0].resolutionPricePerShare, 1);
  assert.equal(snapshot.pending.length, 0);
  assert.equal(snapshot.account.unresolvedPositions, 0);
  assert.notEqual(snapshot.account.equity, null);
});

test('close winner tie-break remains deterministic and only affects positions actually opened', async () => {
  const closeMs = (OPEN_TS + 300) * 1000;
  const fx = fixture();
  await openMarketPosition(fx, 'UP');
  await quote(fx, 'DOWN', 0.96, 0.99, closeMs - 2500);
  await quote(fx, 'UP', 0.95, 0.99, closeMs - 1500);
  await fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED');
  assert.equal(fx.w.closeResolution.winner, 'DOWN');
  assert.equal(fx.w.closeResolution.thresholdMatched, false);
  assert.equal(fx.bot.trades[0].resolutionOutcome, 'DOWN');

  const freshest = fixture();
  await openMarketPosition(freshest, 'UP');
  await quote(freshest, 'DOWN', 0.95, 0.99, closeMs - 2500);
  await quote(freshest, 'UP', 0.95, 0.99, closeMs - 1500);
  await freshest.bot._finishWindow(freshest.w, closeMs, 'WINDOW_EXPIRED');
  assert.equal(freshest.w.closeResolution.winner, 'UP');
  assert.equal(freshest.w.closeResolution.tieBreak, 'FRESHEST_QUOTE');

  const tie = fixture();
  await openMarketPosition(tie, 'UP');
  tie.w.finalThreeSecondQuoteBySide = {
    UP: { bid: 0.95, ts: closeMs - 1000 },
    DOWN: { bid: 0.95, ts: closeMs - 1000 },
  };
  await tie.bot._finishWindow(tie.w, closeMs, 'WINDOW_EXPIRED');
  assert.equal(tie.w.closeResolution.winner, 'UP');
  assert.equal(tie.w.closeResolution.tieBreak, 'DETERMINISTIC_UP_FALLBACK');
  assert.equal(tie.bot.pending.length, 0);
});

test('wins and losses update only that side; a same-side win resets its next size', () => {
  const { bot } = fixture();
  const position = (side, pnl) => ({
    slug: 'window', openTs: OPEN_TS, side, trancheId: 'SINGLE', cycle: 1,
    shares: 10, entryPrice: 0.45, entryNotional: 4.5, entryFee: 0,
    exitPrice: 0.99, exitProceeds: 9.9, netExitProceeds: 9.9,
    clobExitPrice: 0.99, clobExitProceeds: 9.9, clobExitShares: 10,
    fees: 0, realizedPnl: pnl, resolutionOutcome: null,
    resolutionPricePerShare: null, finalized: false,
  });
  bot._finalizeTrade(position('UP', -2), 'CLOB_CLOSE_PRICE');
  assert.equal(bot.snapshot().martingale.UP.nextShares, 18);
  assert.equal(bot.snapshot().martingale.DOWN.nextShares, 10);
  bot._finalizeTrade(position('DOWN', 1), 'TAKE_PROFIT');
  assert.equal(bot.snapshot().martingale.UP.nextShares, 18);
  assert.equal(bot.snapshot().martingale.DOWN.nextShares, 10);
  bot._finalizeTrade(position('UP', 1), 'TAKE_PROFIT');
  assert.equal(bot.snapshot().martingale.UP.nextShares, 10);
  assert.equal(bot.snapshot().martingale.DOWN.nextShares, 10);
});

test('shared cash caps both independent market buys without overdrawing the bankroll', async () => {
  const fx = fixture();
  fx.bot.cash = 4.50;
  await fireMarketOrders(fx, {
    UP: makeBook([[0.45, 10]], [[0.40, 20]]),
    DOWN: makeBook([[0.45, 10]], [[0.40, 20]]),
  });
  assert.ok(fx.bot.cash >= -1e-8);
  const up = fx.w.sides.UP.tranches[0];
  const down = fx.w.sides.DOWN.tranches[0];
  assert.equal(up.entryOrder.status, 'partial_fill_remainder_cancelled');
  approx(up.entryOrder.filledShares * 0.45 + up.entryOrder.fees, 4.50);
  assert.equal(down.entryOrder.status, 'no_fill');
  assert.equal(down.entryOrder.limitingFactor, 'shared_cash');
});

test('snapshot reports market entries, opening delay, taker fee rate and separate TP rebates', () => {
  const { bot } = fixture();
  const state = bot.snapshot();
  assert.equal(state.mode, 'DEMO');
  assert.equal(state.strategy.demoCapital, 1000);
  assert.equal(state.strategy.sharedCapital, true);
  assert.equal(state.strategy.entryReferencePrice, 0.45);
  assert.equal(state.strategy.entryPriceCap, null);
  assert.equal(state.strategy.entryDelayMs, 3000);
  assert.equal(state.strategy.takeProfitBid, 0.99);
  assert.equal(state.strategy.entryOrderType, 'MARKET');
  assert.equal(state.strategy.takeProfitOrderType, 'POST_ONLY');
  assert.equal(state.strategy.takerFeeRate, 0.07);
  assert.equal(state.strategy.takeProfitMakerFeesCharged, 0);
  assert.equal(state.strategy.rebateEstimateIsCash, false);
  assert.equal(state.strategy.takeProfitPaperOrderLatencyMs, 250);
  assert.equal(state.strategy.hardStopLossBid, null);
  assert.equal(state.strategy.martingaleMultiplier, 1.8);
  assert.equal(state.strategy.settlementMethod, 'CLOB_CLOSE_PRICE');
  assert.equal(state.strategy.settlementCloseSampleSeconds, 3);
  assert.equal(state.strategy.settlementWinnerThreshold, 0.98);
  assert.equal(state.strategy.settlementFallback, 'HIGHER_BID_THEN_FRESHEST_THEN_UP');
  assert.equal(state.cfg.entryReferencePrice, 0.45);
  assert.equal(state.cfg.entryDelayMs, 3000);
  assert.equal(state.cfg.entryPriceCap, null);
  assert.equal(state.cfg.takerFeeRate, 0.07);
  assert.equal(state.cfg.takeProfitMakerFeesCharged, 0);
  assert.equal(state.cfg.entryAsk, undefined);
  assert.equal(state.cfg.forcedExitBufferSeconds, undefined);
  assert.equal(state.stats.estimatedMakerRebate, 0);
});

test('Bot refuses a non-demo order adapter', () => {
  const bot = new Bot({ demoMode: false });
  bot.start();
  assert.equal(bot.executionHalt, true);
  assert.match(bot.error, /DemoTrader/);
  assert.equal(bot.snapshot().mode, 'DEMO');
});
