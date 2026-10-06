'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const Bot = require('../bot');
const { makeWindowState } = require('../bot');
const { slugForTs } = require('../polymarket-market');

const OPEN_TS = 1_800_000_000;

class FakeDemoTrader {
  constructor() {
    this.demoMode = true;
    this.calls = [];
    this.books = new Map();
  }

  async getOrderBook(tokenId) {
    return this.books.get(tokenId) || { bids: [], asks: [] };
  }

  updateQuote(tokenId, quote) {
    const bid = Number(quote && quote.bid);
    const ask = Number(quote && quote.ask);
    this.books.set(tokenId, {
      bids: Number.isFinite(bid) && bid > 0 ? [{ price: bid, size: 10000 }] : [],
      asks: Number.isFinite(ask) && ask > 0 ? [{ price: ask, size: 10000 }] : [],
    });
  }

  async placeFakMarketOrder(tokenId, side, amount, options = {}) {
    const buying = String(side).toUpperCase() === 'BUY';
    this.calls.push({ tokenId, side, amount, options: { ...options } });
    const limit = Number(options.priceLimit);
    const hasLimit = Number.isFinite(limit) && limit > 0;
    const book = await this.getOrderBook(tokenId);
    const levels = (buying ? book.asks : book.bids)
      .map((item) => ({ price: Number(item.price), size: Number(item.size) }))
      .filter((item) => Number.isFinite(item.price) && item.size > 0
        && (!hasLimit || (buying ? item.price <= limit : item.price >= limit)))
      .sort(buying ? (a, b) => a.price - b.price : (a, b) => b.price - a.price);
    let remaining = Number(amount);
    let shares = 0;
    let notional = 0;
    for (const level of levels) {
      if (buying) {
        const spend = Math.min(remaining, level.price * level.size);
        shares += spend / level.price;
        notional += spend;
        remaining -= spend;
      } else {
        const take = Math.min(remaining, level.size);
        shares += take;
        notional += take * level.price;
        remaining -= take;
      }
      if (remaining <= 1e-9) break;
    }
    const raw = buying
      ? { makingAmount: String(notional), takingAmount: String(shares) }
      : { makingAmount: String(shares), takingAmount: String(notional) };
    return {
      id: 'fake-' + this.calls.length,
      status: shares > 0 ? 'matched' : 'unmatched',
      isFilled: shares > 0,
      avgPrice: shares > 0 ? notional / shares : 0,
      raw,
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
  bot.w = w;
  bot.prices = {
    slug, ts: OPEN_TS * 1000,
    up: { bid: null, ask: null, mid: null },
    down: { bid: null, ask: null, mid: null },
  };
  return { bot, trader, w, now: OPEN_TS * 1000 + 30_000 };
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

test('strategy constants match the confirmed independent-side rules', () => {
  assert.equal(cfg.SIDE_BUDGET_USD, 500);
  assert.equal(cfg.TRANCHE_BUDGET_USD, 250);
  assert.equal(cfg.FIRST_ENTRY_ASK_USD, 0.50);
  assert.equal(cfg.SECOND_ENTRY_ASK_USD, 0.60);
  assert.equal(cfg.TAKE_PROFIT_OFFSET_USD, 0.20);
  assert.equal(cfg.REENTRY_PULLBACK_USD, 0.10);
  assert.equal(cfg.MAX_ENTRY_ASK_USD, 0.90);
  assert.equal(cfg.FORCED_EXIT_BUFFER_SECONDS, 2);
});

test('UP and DOWN each start with two separate $250 tranche budgets', () => {
  const { bot } = fixture();
  const snapshot = bot.snapshot();
  for (const side of ['UP', 'DOWN']) {
    const tranches = snapshot.window.sides[side].tranches;
    assert.equal(tranches.length, 2);
    assert.deepEqual(tranches.map((item) => item.availableUsd), [250, 250]);
  }
});

test('the $0.50 tranche enters independently and does not fire the $0.60 tranche', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.49, 0.50);

  assert.equal(fx.trader.calls.length, 1);
  assert.equal(fx.trader.calls[0].tokenId, 'up-token');
  assert.equal(fx.trader.calls[0].side, 'BUY');
  assert.equal(fx.trader.calls[0].amount, 250);
  assert.equal(fx.trader.calls[0].options.priceLimit, 0.90);
  assert.equal(fx.w.sides.UP.tranches[0].state, 'in_position');
  assert.equal(fx.w.sides.UP.tranches[1].state, 'waiting_entry');
  assert.equal(fx.w.sides.DOWN.tranches[0].state, 'waiting_entry');
});

test('a first observed ask at $0.60+ catches up both independent tranches', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.59, 0.60);

  assert.equal(fx.trader.calls.length, 2);
  assert.deepEqual(fx.trader.calls.map((call) => call.amount), [250, 250]);
  assert.ok(fx.w.sides.UP.tranches.every((tranche) => tranche.state === 'in_position'));
  assert.ok(fx.w.sides.DOWN.tranches.every((tranche) => tranche.state === 'waiting_entry'));
});

test('UP and DOWN can enter independently in the same window', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.49, 0.50);
  await quote(fx, 'DOWN', 0.60, 0.61);

  assert.deepEqual(fx.trader.calls.map((call) => call.tokenId), [
    'up-token', 'down-token', 'down-token',
  ]);
  assert.equal(fx.w.sides.UP.tranches[0].state, 'in_position');
  assert.equal(fx.w.sides.UP.tranches[1].state, 'waiting_entry');
  assert.ok(fx.w.sides.DOWN.tranches.every((tranche) => tranche.state === 'in_position'));
});

test('entry asks above $0.90 are skipped; a later eligible ask can still fire', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.90, 0.91);
  assert.equal(fx.trader.calls.length, 0);

  await quote(fx, 'UP', 0.89, 0.90);
  assert.equal(fx.trader.calls.length, 2);
  assert.ok(fx.w.sides.UP.tranches.every((tranche) => tranche.position.takeProfitPrice > 1));
  assert.ok(fx.w.sides.UP.tranches.every((tranche) => tranche.position.takeProfitReachable === false));

  await quote(fx, 'UP', 0.99, 1);
  assert.equal(fx.trader.calls.length, 2, 'an unreachable TP must not be treated as hit');
});

test('TP uses best bid, sells no lower than target, and recycles all net tranche proceeds', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.49, 0.50);
  const tranche = fx.w.sides.UP.tranches[0];
  fx.w.sides.UP.tranches[1].state = 'done_for_window';
  const position = tranche.position;
  approx(position.takeProfitPrice, 0.70);

  await quote(fx, 'UP', 0.69, 0.70);
  assert.equal(fx.trader.calls.length, 1, 'bid below TP must not sell');

  await quote(fx, 'UP', 0.70, 0.72);
  assert.equal(fx.trader.calls.length, 2);
  assert.equal(fx.trader.calls[1].side, 'SELL');
  assert.equal(fx.trader.calls[1].options.priceLimit, 0.70);
  assert.equal(tranche.state, 'waiting_reentry');
  assert.equal(tranche.position, null);
  approx(tranche.reentryPrice, 0.60);
  approx(tranche.availableUsd, 342.65, 1e-6);
  approx(fx.bot.trades[0].netExitProceeds, 342.65, 1e-6);

  await quote(fx, 'UP', 0.60, 0.61);
  assert.equal(fx.trader.calls.length, 2, 'ask above TP−$0.10 must not re-enter');
  await quote(fx, 'UP', 0.59, 0.60);
  assert.equal(fx.trader.calls.length, 3);
  assert.equal(fx.trader.calls[2].side, 'BUY');
  approx(fx.trader.calls[2].amount, 342.65, 1e-6);
  approx(tranche.position.entryPrice, 0.60);
  approx(tranche.position.takeProfitPrice, 0.80);
  assert.equal(tranche.cycle, 2);
});

test('forced exits begin exactly two seconds before expiry and stop re-entries', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.49, 0.50);
  fx.w.sides.UP.tranches[1].state = 'done_for_window';
  const closeMs = (OPEN_TS + 300) * 1000;
  const position = fx.w.sides.UP.tranches[0].position;

  await quote(fx, 'UP', 0.65, 0.66, closeMs - 2501);
  assert.equal(position.openShares > 0, true);
  assert.equal(fx.trader.calls.length, 1);

  await quote(fx, 'UP', 0.65, 0.66, closeMs - 2000);
  assert.equal(position.openShares, 0);
  assert.equal(fx.trader.calls.length, 2);
  assert.equal(fx.trader.calls[1].side, 'SELL');
  assert.equal(fx.trader.calls[1].options.priceLimit, 0);
  assert.equal(fx.w.sides.UP.tranches[0].state, 'done_for_window');
  assert.equal(fx.trader.calls.some((call) => call.side === 'BUY' && call.amount !== 250), false);
});

test('a quote after expiry cannot create a simulated late sale', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.49, 0.50);
  fx.w.sides.UP.tranches[1].state = 'done_for_window';
  const position = fx.w.sides.UP.tranches[0].position;
  const expiredAt = (OPEN_TS + 300) * 1000 + 1;

  await quote(fx, 'UP', 0.70, 0.71, expiredAt);
  await fx.bot._finishWindow(fx.w, expiredAt, 'WINDOW_EXPIRED');

  assert.equal(fx.trader.calls.length, 1, 'no SELL should be simulated after expiry');
  assert.ok(position.openShares > 0);
  assert.equal(position.status, 'unresolved_exit');
});

test('demo-only guard blocks non-demo order adapters', async () => {
  const trader = new FakeDemoTrader();
  trader.demoMode = false;
  const bot = new Bot(trader);
  const fx = fixture();
  bot.w = fx.w;
  bot.prices = fx.bot.prices;
  bot._marketFeedSlug = fx.w.slug;
  await quote({ ...fx, bot }, 'UP', 0.49, 0.50);

  assert.equal(bot.executionHalt, true);
  assert.equal(trader.calls.length, 0);
});

test('snapshot reports the demo-only mode and configured TP/cap rules', () => {
  const { bot } = fixture();
  const snapshot = bot.snapshot();
  assert.equal(snapshot.mode, 'DEMO');
  assert.equal(snapshot.strategy.sideBudgetUsd, 500);
  assert.equal(snapshot.strategy.trancheBudgetUsd, 250);
  assert.equal(snapshot.strategy.takeProfitOffset, 0.20);
  assert.equal(snapshot.strategy.maxEntryAsk, 0.90);
  assert.equal(snapshot.strategy.forcedExitBufferSeconds, 2);
  assert.equal(snapshot.executionHalt, false);
});
