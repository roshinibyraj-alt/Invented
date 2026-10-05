'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const Bot = require('../paired-limit-bot');
const { makeWindowState } = require('../paired-limit-bot');
const { currentWindowOpenTs, slugForTs } = require('../polymarket-market');

class FakeDemoTrader {
  constructor() {
    this.demoMode = true;
    this.calls = [];
    this.books = new Map();
    this.askDepth = new Map();
  }

  async getOrderBook(tokenId) {
    return this.books.get(tokenId) || { bids: [], asks: [] };
  }

  updateQuote(tokenId, quote) {
    const bid = Number(quote && quote.bid);
    const ask = Number(quote && quote.ask);
    this.books.set(tokenId, {
      bids: Number.isFinite(bid) && bid > 0 ? [{ price: bid, size: 1000 }] : [],
      asks: Number.isFinite(ask) && ask > 0
        ? [{ price: ask, size: this.askDepth.get(tokenId) || 1000 }] : [],
    });
  }

  async placeFakMarketOrder(tokenId, side, amount, options = {}) {
    this.calls.push({ method: 'placeFakMarketOrder', tokenId, side, amount, options });
    const book = await this.getOrderBook(tokenId);
    const levels = (String(side).toUpperCase() === 'BUY' ? book.asks : book.bids)
      .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => !Number.isFinite(Number(options.priceLimit))
        || level.price <= Number(options.priceLimit))
      .sort((a, b) => a.price - b.price);
    const priceLimit = Number(options.priceLimit);
    const hasPriceLimit = Number.isFinite(priceLimit) && priceLimit > 0;
    let remaining = hasPriceLimit ? Number(amount) / priceLimit : Number(amount) || 0;
    let shares = 0;
    let notional = 0;
    for (const level of levels) {
      const take = Math.min(level.size, hasPriceLimit ? remaining : remaining / level.price);
      shares += take;
      notional += take * level.price;
      remaining -= hasPriceLimit ? take : take * level.price;
      if (remaining <= 1e-9) break;
    }
    if (shares <= 0) {
      return { id: null, status: 'unmatched', isFilled: false, avgPrice: 0, raw: {} };
    }
    return {
      id: 'fake-' + this.calls.length, status: 'matched', isFilled: true,
      avgPrice: notional / shares,
      raw: { makingAmount: String(notional), takingAmount: String(shares) },
    };
  }

  async getBalance() { return null; }
}

function fixture({ trader = new FakeDemoTrader(), cash } = {}) {
  const bot = new Bot(trader);
  if (cash != null) bot.cash = cash;
  const openTs = currentWindowOpenTs();
  const slug = slugForTs(openTs);
  const w = makeWindowState(slug, openTs);
  w.window = {
    slug, openTs, closeTs: openTs + 300,
    tokenUp: 'up-token', tokenDown: 'down-token',
  };
  bot.w = w;
  bot.prices = { slug, ts: Date.now(), up: { bid: null, ask: null, mid: null }, down: { bid: null, ask: null, mid: null } };
  return { bot, trader, w };
}

async function quote(fx, side, bid, ask) {
  const tokenId = side === 'UP' ? fx.w.window.tokenUp : fx.w.window.tokenDown;
  await fx.bot._onQuote(fx.w.slug, tokenId, { bid, ask });
}

async function nextWindow(fx, index) {
  const openTs = fx.w.openTs + index * 300;
  const slug = slugForTs(openTs);
  const w = makeWindowState(slug, openTs);
  w.window = {
    slug, openTs, closeTs: openTs + 300,
    tokenUp: 'up-token-' + index, tokenDown: 'down-token-' + index,
  };
  fx.bot.w = w;
  fx.bot.prices = { slug, ts: Date.now(), up: { bid: null, ask: null, mid: null }, down: { bid: null, ask: null, mid: null } };
  fx.bot._quotesByToken = new Map();
  fx.w = w;
  return w;
}

async function enterPrimary(fx, side = 'UP') {
  const opposite = side === 'UP' ? 'DOWN' : 'UP';
  const callsBefore = fx.trader.calls.length;
  await quote(fx, opposite, 0.29, 0.30);
  await quote(fx, side, 0.68, 0.68);
  assert.equal(fx.trader.calls.length, callsBefore);
  await quote(fx, side, 0.68, cfg.ENTRY_TRIGGER_PRICE_USD);
  assert.equal(fx.trader.calls.length, callsBefore + 1);
  assert.ok(fx.w.primaryPosition);
  return fx.w.primaryPosition;
}

async function confirmClobOutcome(fx, winner) {
  if (winner === 'UP') {
    await quote(fx, 'UP', 0.99, 1.00);
    await quote(fx, 'DOWN', 0.01, 0.02);
  } else {
    await quote(fx, 'DOWN', 0.99, 1.00);
    await quote(fx, 'UP', 0.01, 0.02);
  }
}

test('configuration uses $100 base stake, 45% hedge, and $0.69/$0.70 triggers', () => {
  assert.equal(cfg.DEMO_CAPITAL, 10000);
  assert.equal(cfg.BASE_STAKE_USD, 100);
  assert.equal(cfg.HEDGE_STAKE_RATIO, 0.45);
  assert.equal(cfg.ENTRY_TRIGGER_PRICE_USD, 0.69);
  assert.equal(cfg.STOP_LOSS_HEDGE_TRIGGER_PRICE_USD, 0.70);
});

test('no order is placed until a side ask reaches $0.69, then buys a fixed $100 stake', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.67, 0.68);

  assert.equal(fx.trader.calls.length, 0);
  assert.equal(fx.bot.cash, 10000);

  await quote(fx, 'UP', 0.68, 0.69);

  assert.equal(fx.trader.calls.length, 1);
  assert.deepEqual(fx.trader.calls[0], {
    method: 'placeFakMarketOrder', tokenId: 'up-token', side: 'BUY',
    amount: 100, options: { priceLimit: 0.69 },
  });
  assert.equal(fx.w.primarySide, 'UP');
  assert.equal(fx.w.primaryPosition.role, 'PRIMARY');
  assert.equal(fx.w.primaryPosition.stakeUsd, 100);
  assert.ok(Math.abs(fx.w.primaryPosition.entryNotional - 100) < 1e-8);
  assert.ok(fx.bot.cash < 9900); // Stake plus estimated taker fee.
});

test('the first side to reach the trigger wins the primary entry', async () => {
  const fx = fixture();
  await quote(fx, 'DOWN', 0.68, 0.69);

  assert.equal(fx.w.primarySide, 'DOWN');
  assert.equal(fx.trader.calls.length, 1);
  assert.equal(fx.trader.calls[0].tokenId, 'down-token');
});

test('opposite-side buy fires only at the stop trigger and scales to 45% of primary stake', async () => {
  const fx = fixture();
  await enterPrimary(fx, 'UP');
  await quote(fx, 'DOWN', 0.69, 0.699);
  assert.equal(fx.trader.calls.length, 1);

  await quote(fx, 'DOWN', 0.70, 0.70);

  assert.equal(fx.trader.calls.length, 2);
  assert.equal(fx.trader.calls[1].tokenId, 'down-token');
  assert.equal(fx.trader.calls[1].amount, 45);
  assert.equal(fx.trader.calls[1].options.priceLimit, 0.70);
  assert.equal(fx.w.hedgePosition.role, 'STOP_LOSS_HEDGE');
  assert.equal(fx.w.hedgePosition.stakeUsd, 45);
  assert.equal(fx.bot.stats.stopLossHedges, 1);
});

test('CLOB outcome requires the winner and opposite side to confirm together', async () => {
  const fx = fixture();
  const primary = await enterPrimary(fx);

  await quote(fx, 'UP', 0.99, 1.00);
  await quote(fx, 'DOWN', 0.02, 0.03);
  assert.equal(primary.settled, false);
  assert.equal(fx.bot.currentStakeUsd, 100);
  assert.equal(fx.w.closed, false);

  await quote(fx, 'DOWN', 0.01, 0.02);
  assert.equal(primary.settled, true);
  assert.equal(fx.w.clobConfirmedOutcome, 'UP');
  assert.equal(fx.bot.outcomes.get(fx.w.openTs).source, 'clob_pair');
  assert.equal(fx.bot.currentStakeUsd, 100);
});

test('at close, the higher fresh CLOB midpoint provisionally advances the stake ladder', async () => {
  const fx = fixture();
  const primary = await enterPrimary(fx);
  await quote(fx, 'DOWN', 0.70, 0.70);
  const hedge = fx.w.hedgePosition;
  await quote(fx, 'UP', 0.56, 0.62);
  await quote(fx, 'DOWN', 0.68, 0.78);

  await fx.bot._closeWindow(fx.w);

  assert.equal(fx.w.closed, true);
  assert.equal(fx.w.clobCloseProvisionalOutcome, 'DOWN');
  assert.ok(Math.abs(fx.w.clobClosePrices.upMid - 0.59) < 1e-9);
  assert.ok(Math.abs(fx.w.clobClosePrices.downMid - 0.73) < 1e-9);
  assert.equal(fx.bot.outcomes.get(fx.w.openTs).source, 'clob_close_provisional');
  assert.equal(primary.settled, true);
  assert.equal(hedge.settled, true);
  assert.equal(fx.bot.currentStakeUsd, 200);
});

test('tied or missing close-time midpoints remain on the official-result fallback', async () => {
  const fx = fixture();
  const primary = await enterPrimary(fx);
  await quote(fx, 'UP', 0.49, 0.51);
  await quote(fx, 'DOWN', 0.49, 0.51);

  await fx.bot._closeWindow(fx.w);

  assert.equal(fx.w.closed, true);
  assert.equal(fx.w.clobCloseProvisionalOutcome, null);
  assert.equal(fx.bot.outcomes.has(fx.w.openTs), false);
  assert.equal(primary.settled, false);
  assert.equal(fx.bot.currentStakeUsd, 100);
});

test('stake progression is $100 → $200 → $400, then resets to $100 after a primary win', async () => {
  const fx = fixture();
  const expectedStakes = [100, 200, 400, 100];

  for (let index = 0; index < expectedStakes.length; index += 1) {
    if (index > 0) await nextWindow(fx, index);
    const primary = await enterPrimary(fx);
    const stake = expectedStakes[index];
    assert.equal(primary.stakeUsd, stake);

    await quote(fx, 'DOWN', 0.70, 0.70);
    assert.equal(fx.trader.calls.at(-1).amount, stake * 0.45);
    const hedge = fx.w.hedgePosition;

    if (index < 2) {
      await confirmClobOutcome(fx, 'DOWN');
      assert.equal(fx.bot.currentStakeUsd, expectedStakes[index + 1]);
      assert.equal(hedge.settled, true);
    } else if (index === 2) {
      await confirmClobOutcome(fx, 'UP');
      assert.equal(fx.bot.currentStakeUsd, 100);
      assert.equal(hedge.settled, true);
    }
  }

  assert.deepEqual(
    fx.trader.calls.filter((call) => call.method === 'placeFakMarketOrder').map((call) => call.amount),
    [100, 45, 200, 90, 400, 180, 100, 45],
  );
});

test('settling a hedge does not change the next primary stake', async () => {
  const fx = fixture();
  fx.bot.currentStakeUsd = 200;
  const primary = await enterPrimary(fx);
  await quote(fx, 'DOWN', 0.70, 0.70);
  const hedge = fx.w.hedgePosition;

  fx.bot._finalizePosition(hedge, 'WIN', 'TEST');
  assert.equal(fx.bot.currentStakeUsd, 200);
  await confirmClobOutcome(fx, 'DOWN');
  assert.equal(fx.bot.currentStakeUsd, 400);
  assert.equal(primary.settled, true);
});

test('next window waits for the previous primary result before choosing its stake', async () => {
  const fx = fixture();
  const previousPrimary = await enterPrimary(fx);
  const previousWindow = fx.w;
  await nextWindow(fx, 1);

  await quote(fx, 'UP', 0.68, 0.69);
  assert.equal(fx.trader.calls.length, 1);
  assert.equal(fx.w.status, 'awaiting_previous_primary_settlement');
  assert.equal(fx.w.primaryAttempted, false);

  fx.bot._confirmClobOutcome(previousWindow, 'DOWN');
  assert.equal(fx.bot.currentStakeUsd, 200);
  await quote(fx, 'UP', 0.68, 0.69);

  assert.equal(fx.trader.calls.length, 2);
  assert.equal(fx.trader.calls[1].amount, 200);
  assert.equal(fx.w.primaryPosition.stakeUsd, 200);
});

test('thin visible depth creates a partial fixed-dollar fill and tracks actual cost', async () => {
  const fx = fixture();
  fx.trader.askDepth.set('up-token', 10);
  await quote(fx, 'UP', 0.68, 0.69);

  assert.equal(fx.w.primaryPosition.shares, 10);
  assert.ok(Math.abs(fx.w.primaryPosition.entryNotional - 6.9) < 1e-8);
  assert.ok(fx.bot.cash > 9900);
});

test('insufficient demo cash prevents the entry order', async () => {
  const fx = fixture({ cash: 50 });
  await quote(fx, 'UP', 0.68, 0.69);

  assert.equal(fx.trader.calls.length, 0);
  assert.equal(fx.w.status, 'insufficient_cash');
  assert.equal(fx.bot.cash, 50);
});

test('official-result settlement remains available for primary and hedge positions', async () => {
  const fx = fixture();
  const primary = await enterPrimary(fx);
  await quote(fx, 'DOWN', 0.70, 0.70);
  const hedge = fx.w.hedgePosition;

  primary.closeTs = Math.floor(Date.now() / 1000) - 1;
  hedge.closeTs = primary.closeTs;
  fx.w.closed = true;
  fx.bot.outcomes.set(primary.openTs, { winner: 'UP', source: 'official' });
  await fx.bot._settleClosedPositions(Date.now());

  assert.equal(primary.settled, true);
  assert.equal(hedge.settled, true);
  assert.equal(fx.bot.trades.length, 2);
  assert.equal(fx.bot.currentStakeUsd, 100);
});

test('non-DemoTrader instances remain blocked and cannot submit orders', async () => {
  const trader = new FakeDemoTrader();
  trader.demoMode = false;
  const fx = fixture({ trader });
  assert.equal(fx.bot.executionHalt, true);
  fx.bot.start();
  await quote(fx, 'UP', 0.68, 0.69);

  assert.equal(fx.trader.calls.length, 0);
});

test('snapshot exposes trigger levels, current primary/hedge stakes, and demo capital', async () => {
  const fx = fixture();
  fx.bot.currentStakeUsd = 200;
  const snapshot = fx.bot.snapshot();

  assert.equal(snapshot.mode, 'DEMO');
  assert.equal(snapshot.account.capital, 10000);
  assert.equal(snapshot.strategy.baseStakeUsd, 100);
  assert.equal(snapshot.strategy.currentStakeUsd, 200);
  assert.equal(snapshot.strategy.currentHedgeStakeUsd, 90);
  assert.equal(snapshot.strategy.entryTriggerPrice, 0.69);
  assert.equal(snapshot.strategy.stopLossHedgeTriggerPrice, 0.70);
});
