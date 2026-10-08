'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const Bot = require('../bot');
const { makeWindowState, estimateTakerFee } = require('../bot');
const { slugForTs } = require('../polymarket-market');

const OPEN_TS = 1_800_000_000;

class FakeDemoTrader {
  constructor() {
    this.demoMode = true;
    this.books = new Map();
    this.calls = [];
  }

  setBook(tokenId, bids = [], asks = []) {
    this.books.set(tokenId, { bids, asks });
  }

  async getOrderBook(tokenId) {
    return this.books.get(tokenId) || { bids: [], asks: [] };
  }

  updateQuote() {}

  async simulateLimitBuy(tokenId, requested, limit, orderState) {
    this.calls.push({ kind: 'limit-buy-fill-check', tokenId, requested, limit });
    const book = await this.getOrderBook(tokenId);
    const levels = book.asks
      .map(({ price, size }) => ({ price: Number(price), size: Number(size) }))
      .filter((level) => level.price <= limit && level.size > 0)
      .sort((a, b) => a.price - b.price);
    const signature = levels.map((level) => `${level.price}:${level.size}`).join('|');
    if (signature === orderState.lastBookSignature) {
      return { shares: 0, notional: 0, avgPrice: 0, fills: [], unchangedBook: true };
    }
    orderState.lastBookSignature = signature;
    orderState.consumedByPrice ||= {};
    let remaining = requested;
    let shares = 0;
    let notional = 0;
    for (const level of levels) {
      const key = level.price.toFixed(4);
      const consumed = orderState.consumedByPrice[key] || 0;
      const take = Math.min(remaining, Math.max(0, level.size - consumed));
      if (take <= 0) continue;
      orderState.consumedByPrice[key] = consumed + take;
      shares += take;
      notional += take * level.price;
      remaining -= take;
      if (remaining <= 1e-9) break;
    }
    return { shares, notional, avgPrice: shares ? notional / shares : 0, fills: [] };
  }

  async placeFakMarketOrder(tokenId, side, amount, options = {}) {
    const selling = String(side).toUpperCase() === 'SELL';
    const book = await this.getOrderBook(tokenId);
    const limit = Number(options.priceLimit) || 0;
    const levels = (selling ? book.bids : book.asks)
      .map(({ price, size }) => ({ price: Number(price), size: Number(size) }))
      .filter((level) => level.size > 0
        && (!limit || (selling ? level.price >= limit : level.price <= limit)))
      .sort(selling ? (a, b) => b.price - a.price : (a, b) => a.price - b.price);
    let remaining = Number(amount);
    let shares = 0;
    let notional = 0;
    for (const level of levels) {
      const quantity = Math.min(remaining, level.size);
      shares += quantity;
      notional += quantity * level.price;
      remaining -= quantity;
      if (remaining <= 1e-9) break;
    }
    this.calls.push({ kind: selling ? 'sell' : 'market-buy', tokenId, amount, options });
    return {
      raw: selling
        ? { makingAmount: String(shares), takingAmount: String(notional) }
        : { makingAmount: String(notional), takingAmount: String(shares) },
    };
  }
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

function approx(actual, expected, epsilon = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be near ${expected}`);
}

test('confirmed strategy constants are demo-only, shared cash, independent 1.8x sizing', () => {
  assert.equal(cfg.DEMO_CAPITAL, 1000);
  assert.equal(cfg.BASE_SHARES, 10);
  assert.equal(cfg.MARTINGALE_MULTIPLIER, 1.8);
  assert.equal(cfg.ENTRY_LIMIT_PRICE_USD, 0.40);
  assert.equal(cfg.TAKE_PROFIT_BID_USD, 0.99);
  assert.equal(cfg.HARD_STOP_LOSS_BID_USD, undefined);
  assert.equal(cfg.FORCED_EXIT_BUFFER_SECONDS, undefined);
  assert.equal(estimateTakerFee(10, 0.40), 0.168);
});

test('places one independent resting $0.40, 10-share limit order per side from shared $1,000', () => {
  const { bot, w } = fixture();
  const snapshot = bot.snapshot();
  assert.equal(w.sides.UP.tranches[0].entryOrder.status, 'resting');
  assert.equal(w.sides.DOWN.tranches[0].entryOrder.status, 'resting');
  assert.equal(w.sides.UP.tranches[0].entryOrder.targetShares, 10);
  assert.equal(w.sides.DOWN.tranches[0].entryOrder.targetShares, 10);
  assert.equal(snapshot.account.capital, 1000);
  approx(snapshot.account.reservedCash, 8.34, 0.005);
  approx(snapshot.account.availableCash, 991.66, 0.005);
  assert.equal(snapshot.martingale.UP.nextShares, 10);
  assert.equal(snapshot.martingale.DOWN.nextShares, 10);
});

test('limit order does not fill above $0.40 and fills only from displayed asks at or below limit', async () => {
  const fx = fixture();
  fx.trader.setBook('up-token', [], [{ price: 0.41, size: 50 }]);
  await quote(fx, 'UP', 0.39, 0.41);
  assert.equal(fx.w.sides.UP.tranches[0].position, null);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'resting');

  fx.trader.setBook('up-token', [], [{ price: 0.39, size: 10 }]);
  await quote(fx, 'UP', 0.38, 0.39);
  const position = fx.w.sides.UP.tranches[0].position;
  assert.equal(position.shares, 10);
  approx(position.entryPrice, 0.39);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'filled');
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'resting');
});

test('partial visible depth does not duplicate fills from an unchanged book', async () => {
  const fx = fixture();
  fx.trader.setBook('up-token', [], [{ price: 0.39, size: 4 }]);
  await quote(fx, 'UP', 0.38, 0.39);
  assert.equal(fx.w.sides.UP.tranches[0].position.shares, 4);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.remainingShares, 6);

  await quote(fx, 'UP', 0.38, 0.39, fx.now + 100);
  assert.equal(fx.w.sides.UP.tranches[0].position.shares, 4);

  fx.trader.setBook('up-token', [], [{ price: 0.39, size: 4 }, { price: 0.40, size: 6 }]);
  await quote(fx, 'UP', 0.38, 0.39, fx.now + 600);
  assert.equal(fx.w.sides.UP.tranches[0].position.shares, 10);
});

test('a low bid causes no stop sale; $0.99 TP sells at actual CLOB proceeds, not $1/share', async () => {
  const fx = fixture();
  fx.trader.setBook('up-token', [{ price: 0.39, size: 10 }], [{ price: 0.40, size: 10 }]);
  await quote(fx, 'UP', 0.39, 0.40);
  const position = fx.w.sides.UP.tranches[0].position;
  assert.equal(position.shares, 10);

  fx.trader.setBook('up-token', [{ price: 0.20, size: 10 }], []);
  await quote(fx, 'UP', 0.20, 0.21, fx.now + 100);
  assert.equal(fx.trader.calls.filter((call) => call.kind === 'sell').length, 0);
  assert.equal(position.openShares, 10);

  fx.trader.setBook('up-token', [{ price: 0.99, size: 10 }], []);
  await quote(fx, 'UP', 0.99, 1.00, fx.now + 200);
  assert.equal(fx.trader.calls.filter((call) => call.kind === 'sell').length, 1);
  assert.equal(fx.bot.trades.length, 1);
  approx(fx.bot.trades[0].exitPrice, 0.99);
  assert.ok(fx.bot.trades[0].exitProceeds < 10);
  assert.ok(fx.bot.trades[0].pnl > 0);
  assert.equal(fx.bot.lossStreak.UP, 0);
  assert.equal(fx.bot.lossStreak.DOWN, 0);
});

test('window close cancels resting orders and immediately books both sides from final-three-second CLOB bids', async () => {
  const fx = fixture();
  for (const side of ['UP', 'DOWN']) {
    const token = side === 'UP' ? 'up-token' : 'down-token';
    fx.trader.setBook(token, [], [{ price: 0.40, size: 10 }]);
    await quote(fx, side, 0.39, 0.40);
    assert.equal(fx.w.sides[side].tranches[0].position.openShares, 10);
  }

  const closeMs = (OPEN_TS + 300) * 1000;
  await quote(fx, 'UP', 0.985, 0.99, closeMs - 2500);
  await quote(fx, 'DOWN', 0.015, 0.99, closeMs - 1500);
  await fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED');
  assert.equal(fx.trader.calls.filter((call) => call.kind === 'sell').length, 0);
  assert.equal(fx.w.sides.UP.tranches[0].entryOrder.status, 'filled');
  assert.equal(fx.w.sides.DOWN.tranches[0].entryOrder.status, 'filled');
  assert.equal(fx.w.closed, true);
  assert.equal(fx.w.closeResolution.method, 'CLOB_CLOSE_PRICE');
  assert.equal(fx.w.closeResolution.winner, 'UP');
  assert.equal(fx.w.closeResolution.thresholdMatched, true);
  assert.equal(fx.w.closeResolution.source, 'FINAL_3_SECONDS');
  assert.equal(fx.bot.snapshot().account.reservedCash, 0);
  assert.notEqual(fx.bot.snapshot().account.equity, null);
  assert.equal(fx.bot.pending.length, 0);
  assert.equal(fx.bot.trades.length, 2);
  const upTrade = fx.bot.trades.find((trade) => trade.side === 'UP');
  const downTrade = fx.bot.trades.find((trade) => trade.side === 'DOWN');
  assert.equal(upTrade.reason, 'CLOB_CLOSE_PRICE');
  assert.equal(upTrade.resolutionOutcome, 'UP');
  assert.equal(upTrade.resolutionPricePerShare, 1);
  assert.equal(upTrade.settlementMethod, 'CLOB_CLOSE_PRICE');
  assert.ok(upTrade.pnl > 0);
  assert.equal(downTrade.resolutionOutcome, 'UP');
  assert.equal(downTrade.resolutionPricePerShare, 0);
  assert.ok(downTrade.pnl < 0);
  assert.equal(fx.bot.lossStreak.UP, 0);
  assert.equal(fx.bot.lossStreak.DOWN, 1);
  assert.equal(fx.bot.snapshot().martingale.UP.nextShares, 10);
  assert.equal(fx.bot.snapshot().martingale.DOWN.nextShares, 18);
  assert.equal(fx.bot.log.filter((entry) => entry.event === 'WINDOW_CLOB_CLOSE_CLASSIFIED').length, 1);
});

test('close falls back to last in-window CLOB bids and never leaves a position pending', async () => {
  const fx = fixture();
  fx.trader.setBook('up-token', [], [{ price: 0.40, size: 10 }]);
  await quote(fx, 'UP', 0.39, 0.40);
  const closeMs = (OPEN_TS + 300) * 1000;
  await fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED');

  const snapshot = fx.bot.snapshot();
  assert.equal(fx.w.closeResolution.source, 'LAST_WINDOW_QUOTE');
  assert.equal(fx.w.closeResolution.bids.UP, 0.39);
  assert.equal(fx.w.closeResolution.bids.DOWN, null);
  assert.equal(fx.w.closeResolution.winner, 'UP');
  assert.equal(fx.bot.trades.length, 1);
  assert.equal(fx.bot.trades[0].resolutionPricePerShare, 1);
  assert.equal(snapshot.pending.length, 0);
  assert.equal(snapshot.account.unresolvedPositions, 0);
  assert.notEqual(snapshot.account.equity, null);
});

test('when neither final bid exceeds $0.98, higher bid wins; equal bids use freshest quote', async () => {
  const fx = fixture();
  fx.trader.setBook('up-token', [], [{ price: 0.40, size: 10 }]);
  await quote(fx, 'UP', 0.39, 0.40);
  const closeMs = (OPEN_TS + 300) * 1000;
  await quote(fx, 'DOWN', 0.96, 0.99, closeMs - 2500);
  await quote(fx, 'UP', 0.95, 0.99, closeMs - 1500);
  await fx.bot._finishWindow(fx.w, closeMs, 'WINDOW_EXPIRED');
  assert.equal(fx.w.closeResolution.winner, 'DOWN');
  assert.equal(fx.w.closeResolution.thresholdMatched, false);
  assert.equal(fx.bot.trades[0].resolutionOutcome, 'DOWN');

  const freshest = fixture();
  freshest.trader.setBook('up-token', [], [{ price: 0.40, size: 10 }]);
  await quote(freshest, 'UP', 0.39, 0.40);
  await quote(freshest, 'DOWN', 0.95, 0.99, closeMs - 2500);
  await quote(freshest, 'UP', 0.95, 0.99, closeMs - 1500);
  await freshest.bot._finishWindow(freshest.w, closeMs, 'WINDOW_EXPIRED');
  assert.equal(freshest.w.closeResolution.winner, 'UP');
  assert.equal(freshest.w.closeResolution.tieBreak, 'FRESHEST_QUOTE');

  const tie = fixture();
  tie.trader.setBook('up-token', [], [{ price: 0.40, size: 10 }]);
  await quote(tie, 'UP', 0.39, 0.40);
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
    shares: 10, entryPrice: 0.40, entryNotional: 4, entryFee: 0.168,
    exitPrice: 0.20, exitProceeds: 2, netExitProceeds: 2,
    clobExitPrice: 0.20, clobExitProceeds: 2, clobExitShares: 10,
    fees: 0.2, realizedPnl: pnl, resolutionOutcome: null,
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

test('snapshot exposes new strategy settings and no old stop/forced-exit config', () => {
  const { bot } = fixture();
  const state = bot.snapshot();
  assert.equal(state.mode, 'DEMO');
  assert.equal(state.strategy.demoCapital, 1000);
  assert.equal(state.strategy.sharedCapital, true);
  assert.equal(state.strategy.entryLimitPrice, 0.40);
  assert.equal(state.strategy.takeProfitBid, 0.99);
  assert.equal(state.strategy.hardStopLossBid, null);
  assert.equal(state.strategy.martingaleMultiplier, 1.8);
  assert.equal(state.strategy.settlementMethod, 'CLOB_CLOSE_PRICE');
  assert.equal(state.strategy.settlementCloseSampleSeconds, 3);
  assert.equal(state.strategy.settlementWinnerThreshold, 0.98);
  assert.equal(state.strategy.settlementFallback, 'HIGHER_BID_THEN_FRESHEST_THEN_UP');
  assert.equal(state.cfg.entryLimitPrice, 0.40);
  assert.equal(state.cfg.entryAsk, undefined);
  assert.equal(state.cfg.forcedExitBufferSeconds, undefined);
});

test('Bot refuses a non-demo order adapter', () => {
  const bot = new Bot({ demoMode: false });
  bot.start();
  assert.equal(bot.executionHalt, true);
  assert.match(bot.error, /DemoTrader/);
  assert.equal(bot.snapshot().mode, 'DEMO');
});
