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
  bot._placeEntryOrders(w);
  return { bot, trader, w, now: (OPEN_TS + 120) * 1000 };
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

async function openMakerPosition(fx, side = 'UP', size = 10) {
  await quote(fx, side, 0.40, 0.46);
  trade(fx, side, 'SELL', 0.45, size, fx.now + 300, `entry-${side}-${size}`);
  await quote(fx, side, 0.40, 0.46, fx.now + 600);
  return fx.w.sides[side].tranches[0].position;
}

function approx(actual, expected, epsilon = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be near ${expected}`);
}

test('strategy constants use a shared $1,000 demo bankroll, $0.45 entry, $0.99 TP and no charged fees', () => {
  assert.equal(cfg.DEMO_CAPITAL, 1000);
  assert.equal(cfg.BASE_SHARES, 10);
  assert.equal(cfg.MARTINGALE_MULTIPLIER, 1.8);
  assert.equal(cfg.ENTRY_LIMIT_PRICE_USD, 0.45);
  assert.equal(cfg.TAKE_PROFIT_BID_USD, 0.99);
  assert.equal(cfg.TAKER_FEE_RATE, 0);
  assert.equal(cfg.REBATE_FEE_EQUIVALENT_RATE, 0.07);
  assert.equal(cfg.MAKER_REBATE_RATE, 0.20);
  assert.equal(cfg.PAPER_ORDER_LATENCY_MS, 250);
  approx(estimateMakerRebate(10, 0.45), 0.03465);
});

test('reserves two independent post-only 10-share bids at $0.45 from shared demo cash', () => {
  const { bot, w } = fixture();
  const snapshot = bot.snapshot();
  assert.equal(w.sides.UP.tranches[0].entryOrder.status, 'waiting_to_post');
  assert.equal(w.sides.DOWN.tranches[0].entryOrder.status, 'waiting_to_post');
  assert.equal(w.sides.UP.tranches[0].entryOrder.targetShares, 10);
  assert.equal(w.sides.DOWN.tranches[0].entryOrder.targetShares, 10);
  assert.equal(snapshot.account.capital, 1000);
  approx(snapshot.account.reservedCash, 9);
  approx(snapshot.account.availableCash, 991);
  assert.equal(snapshot.martingale.UP.nextShares, 10);
  assert.equal(snapshot.martingale.DOWN.nextShares, 10);
});

test('quotes alone never fill; a non-crossing order fills at exactly $0.45 on a later SELL print', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.40, 0.45);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'waiting_to_post');
  trade(fx, 'UP', 'SELL', 0.45, 10, fx.now + 50, 'before-post');
  assert.equal(fx.w.sides.UP.tranches[0].position, null);

  await quote(fx, 'UP', 0.40, 0.46, fx.now + 100);
  const order = fx.w.sides.UP.tranches[0].entryOrder;
  assert.equal(order.status, 'posting');
  assert.equal(order.restingAt, fx.now + 350);
  trade(fx, 'UP', 'SELL', 0.45, 10, fx.now + 200, 'before-arrival');
  assert.equal(fx.w.sides.UP.tranches[0].position, null);
  await quote(fx, 'UP', 0.44, 0.45, fx.now + 250);
  assert.equal(order.status, 'waiting_to_post');
  await quote(fx, 'UP', 0.40, 0.46, fx.now + 300);
  assert.equal(order.status, 'posting');
  trade(fx, 'UP', 'SELL', 0.45, 10, fx.now + 500, 'before-second-arrival');
  assert.equal(fx.w.sides.UP.tranches[0].position, null);
  trade(fx, 'UP', 'BUY', 0.45, 10, fx.now + 600, 'wrong-side');
  assert.equal(fx.w.sides.UP.tranches[0].position, null);
  trade(fx, 'UP', 'SELL', 0.45, 10, fx.now + 650, 'entry-fill');
  const position = fx.w.sides.UP.tranches[0].position;
  assert.equal(position.shares, 10);
  assert.equal(position.entryPrice, 0.45);
  assert.equal(position.entryNotional, 4.5);
  assert.equal(position.entryFee, 0);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'filled');
  assert.equal(position.takeProfitOrder.status, 'posting');
  approx(fx.bot.cash, 995.5);
  approx(fx.bot.stats.estimatedFees, 0);
  approx(fx.bot.stats.makerFeeEquivalent, 0.17325);
  approx(fx.bot.stats.estimatedMakerRebate, 0.03465);
});

test('partial maker prints fill only their trade size and duplicate prints do not double count', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.40, 0.46);
  trade(fx, 'UP', 'SELL', 0.45, 4, fx.now + 300, 'partial-1');
  const tranche = fx.w.sides.UP.tranches[0];
  assert.equal(tranche.position.shares, 4);
  assert.equal(tranche.entryOrder.remainingShares, 6);
  assert.equal(tranche.entryOrder.status, 'resting');
  trade(fx, 'UP', 'SELL', 0.45, 4, fx.now + 300, 'partial-1');
  assert.equal(tranche.position.shares, 4);
  trade(fx, 'UP', 'SELL', 0.45, 6, fx.now + 400, 'partial-2');
  assert.equal(tranche.position.shares, 10);
  assert.equal(tranche.position.openShares, 10);
  assert.equal(tranche.entryOrder.remainingShares, 0);
  assert.equal(tranche.entryOrder.status, 'filled');
  approx(tranche.position.entryPrice, 0.45);
  approx(fx.bot.stats.estimatedMakerRebate, 0.03465);
});

test('TP is a post-only $0.99 sell, quote changes do not fill it, and rebate stays outside cash/P&L', async () => {
  const fx = fixture();
  const position = await openMakerPosition(fx);
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
  assert.equal(closed.fees, 0);
  approx(closed.pnl, 5.4);
  approx(closed.makerFeeEquivalent, 0.18018);
  approx(closed.estimatedMakerRebate, 0.036036);
  approx(fx.bot.cash, 1005.4);
  approx(fx.bot.stats.estimatedFees, 0);
  approx(fx.bot.stats.realizedPnl, 5.4);
  approx(fx.bot.snapshot().account.equity, 1005.4);
  assert.equal(fx.bot.lossStreak.UP, 0);
});

test('window close cancels both maker orders and settles remaining shares from final-three-second CLOB bids', async () => {
  const fx = fixture();
  for (const side of ['UP', 'DOWN']) await openMakerPosition(fx, side);
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
  await openMakerPosition(fx, 'UP');
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
  await openMakerPosition(fx, 'UP');
  await quote(fx, 'DOWN', 0.96, 0.99, closeMs - 2500);
  await quote(fx, 'UP', 0.95, 0.99, closeMs - 1500);
  await fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED');
  assert.equal(fx.w.closeResolution.winner, 'DOWN');
  assert.equal(fx.w.closeResolution.thresholdMatched, false);
  assert.equal(fx.bot.trades[0].resolutionOutcome, 'DOWN');

  const freshest = fixture();
  await openMakerPosition(freshest, 'UP');
  await quote(freshest, 'DOWN', 0.95, 0.99, closeMs - 2500);
  await quote(freshest, 'UP', 0.95, 0.99, closeMs - 1500);
  await freshest.bot._finishWindow(freshest.w, closeMs, 'WINDOW_EXPIRED');
  assert.equal(freshest.w.closeResolution.winner, 'UP');
  assert.equal(freshest.w.closeResolution.tieBreak, 'FRESHEST_QUOTE');

  const tie = fixture();
  await openMakerPosition(tie, 'UP');
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

test('shared cash prevents overcommitment rather than silently resizing an order', () => {
  const { bot, w } = fixture();
  bot.cash = 4.50;
  bot._cancelEntryOrder(w, 'DOWN', w.sides.DOWN.tranches[0], 'test setup');
  w.sides.DOWN.tranches[0].entryOrder = null;
  w.sides.DOWN.tranches[0].state = 'waiting_for_market';
  bot._placeEntryOrders(w);
  assert.equal(w.sides.DOWN.tranches[0].entryOrder, null);
  assert.equal(w.sides.DOWN.tranches[0].state, 'capital_blocked');
  assert.equal(w.sides.UP.tranches[0].entryOrder.targetShares, 10);
});

test('snapshot identifies post-only orders and reports rebates separately from equity', () => {
  const { bot } = fixture();
  const state = bot.snapshot();
  assert.equal(state.mode, 'DEMO');
  assert.equal(state.strategy.demoCapital, 1000);
  assert.equal(state.strategy.sharedCapital, true);
  assert.equal(state.strategy.entryLimitPrice, 0.45);
  assert.equal(state.strategy.takeProfitBid, 0.99);
  assert.equal(state.strategy.entryOrderType, 'POST_ONLY');
  assert.equal(state.strategy.takeProfitOrderType, 'POST_ONLY');
  assert.equal(state.strategy.makerFeesCharged, 0);
  assert.equal(state.strategy.rebateEstimateIsCash, false);
  assert.equal(state.strategy.paperOrderLatencyMs, 250);
  assert.equal(state.strategy.hardStopLossBid, null);
  assert.equal(state.strategy.martingaleMultiplier, 1.8);
  assert.equal(state.strategy.settlementMethod, 'CLOB_CLOSE_PRICE');
  assert.equal(state.strategy.settlementCloseSampleSeconds, 3);
  assert.equal(state.strategy.settlementWinnerThreshold, 0.98);
  assert.equal(state.strategy.settlementFallback, 'HIGHER_BID_THEN_FRESHEST_THEN_UP');
  assert.equal(state.cfg.entryLimitPrice, 0.45);
  assert.equal(state.cfg.makerFeesCharged, 0);
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
