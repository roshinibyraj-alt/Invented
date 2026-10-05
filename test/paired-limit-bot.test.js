'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const Bot = require('../paired-limit-bot');
const DemoTrader = require('../demo-trader');
const { makeWindowState } = require('../paired-limit-bot');
const { currentWindowOpenTs, slugForTs } = require('../polymarket-market');

class FakeDemoTrader {
  constructor() {
    this.demoMode = true;
    this.calls = [];
    this.books = new Map();
    this.askDepth = new Map();
    this.executionBooks = new Map();
  }

  async getOrderBook(tokenId) {
    return this.executionBooks.get(tokenId) || this.books.get(tokenId) || { bids: [], asks: [] };
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
    let remaining = Number(amount) || 0;
    let shares = 0;
    let notional = 0;
    for (const level of levels) {
      const take = Math.min(level.size, remaining / level.price);
      shares += take;
      notional += take * level.price;
      remaining -= take * level.price;
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

function fixture({ trader = new FakeDemoTrader(), cash, logger } = {}) {
  const bot = new Bot(trader, { logger });
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
  const realNow = Date.now;
  try {
    Date.now = () => fx.w.openTs * 1000 + 120000;
    await quote(fx, winner, 0.96, 0.97);
  } finally { Date.now = realNow; }
}

test('configuration uses $100 base stake, 45% hedge, and $0.69/$0.70 triggers', () => {
  assert.equal(cfg.DEMO_CAPITAL, 10000);
  assert.equal(cfg.BASE_STAKE_USD, 100);
  assert.equal(cfg.HEDGE_STAKE_RATIO, 0.45);
  assert.equal(cfg.ENTRY_TRIGGER_PRICE_USD, 0.69);
  assert.equal(cfg.STOP_LOSS_HEDGE_TRIGGER_PRICE_USD, 0.70);
  assert.equal(cfg.CLOB_PRICE_SETTLEMENT_THRESHOLD_USD, 0.97);
  assert.equal(cfg.BOT_LOG_HEARTBEAT_MS, 30000);
  assert.equal(cfg.MAX_BUY_SLIPPAGE_PERCENT, 100000);
  assert.equal(cfg.MAX_BINARY_PRICE_USD, 1);
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
    amount: 100, options: { priceLimit: 1 },
  });
  assert.equal(fx.w.primarySide, 'UP');
  assert.equal(fx.w.primaryPosition.role, 'PRIMARY');
  assert.equal(fx.w.primaryPosition.stakeUsd, 100);
  assert.ok(Math.abs(fx.w.primaryPosition.entryNotional - 100) < 1e-8);
  assert.ok(Math.abs(fx.w.primaryPosition.shares - (100 / 0.69)) < 1e-8);
  assert.ok(fx.bot.cash < 9900); // Stake plus estimated taker fee.
});

test('one-tick jump from $0.65 to $0.75 still fires a $100 primary buy', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.64, 0.65);
  assert.equal(fx.trader.calls.length, 0);

  await quote(fx, 'UP', 0.74, 0.75);

  assert.equal(fx.trader.calls.length, 1);
  assert.equal(fx.trader.calls[0].amount, 100);
  assert.equal(fx.trader.calls[0].options.priceLimit, 1);
  assert.equal(fx.w.primaryPosition.stakeUsd, 100);
  assert.ok(Math.abs(fx.w.primaryPosition.entryNotional - 100) < 1e-8);
  assert.ok(Math.abs(fx.w.primaryPosition.shares - (100 / 0.75)) < 1e-8);
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
  assert.equal(fx.trader.calls[1].options.priceLimit, 1);
  assert.equal(fx.w.hedgePosition.role, 'STOP_LOSS_HEDGE');
  assert.equal(fx.w.hedgePosition.stakeUsd, 45);
  assert.equal(fx.bot.stats.stopLossHedges, 1);
});

test('opposite-side trigger is latched while primary order is pending, even if ask retreats', async () => {
  const fx = fixture();
  await quote(fx, 'DOWN', 0.29, 0.30);

  let primaryStarted;
  const primaryStartedPromise = new Promise((resolve) => { primaryStarted = resolve; });
  let resolvePrimaryOrder;
  const primaryOrder = new Promise((resolve) => { resolvePrimaryOrder = resolve; });
  const placeImmediately = fx.trader.placeFakMarketOrder.bind(fx.trader);
  fx.trader.placeFakMarketOrder = async (tokenId, side, amount, options = {}) => {
    if (tokenId === 'up-token') {
      fx.trader.calls.push({ method: 'placeFakMarketOrder', tokenId, side, amount, options });
      primaryStarted();
      return primaryOrder;
    }
    return placeImmediately(tokenId, side, amount, options);
  };

  const primaryTask = quote(fx, 'UP', 0.68, 0.69);
  await primaryStartedPromise;
  assert.equal(fx.trader.calls.length, 1);

  await quote(fx, 'DOWN', 0.69, 0.70);
  assert.equal(fx.w.hedgeTriggerPending, true);
  assert.equal(fx.w.hedgeTriggerPendingPrice, 0.70);
  assert.equal(fx.trader.calls.length, 1);

  await quote(fx, 'DOWN', 0.64, 0.65);
  assert.equal(fx.trader.calls.length, 1);

  resolvePrimaryOrder({
    id: 'fake-primary', status: 'matched', isFilled: true, avgPrice: 0.69,
    raw: { makingAmount: '100', takingAmount: String(100 / 0.69) },
  });
  await primaryTask;

  assert.equal(fx.trader.calls.length, 2);
  assert.equal(fx.trader.calls[1].tokenId, 'down-token');
  assert.equal(fx.trader.calls[1].amount, 45);
  assert.equal(fx.w.hedgePosition.entryPrice, 0.65);
  assert.equal(fx.w.hedgeTriggerPending, false);
  const trigger = fx.bot.log.find((entry) => entry.event === 'STOP_LOSS_HEDGE_TRIGGERED');
  assert.equal(trigger.price, 0.70);
});

test('primary entry can fill above or below its $0.69 trigger at the execution ask', async () => {
  for (const executionAsk of [0.65, 0.80]) {
    const fx = fixture();
    fx.trader.executionBooks.set('up-token', {
      bids: [],
      asks: [{ price: String(executionAsk), size: '1000' }],
    });

    await quote(fx, 'UP', 0.68, 0.69);

    assert.equal(fx.trader.calls.length, 1);
    assert.equal(fx.trader.calls[0].options.priceLimit, 1);
    assert.equal(fx.w.primaryPosition.entryPrice, executionAsk);
    assert.ok(Math.abs(fx.w.primaryPosition.shares - 100 / executionAsk) < 1e-8);
    assert.ok(Math.abs(fx.w.primaryPosition.entryNotional - 100) < 1e-8);
  }
});

test('triggered demo entry fills from the fresh cached ask when REST book is unavailable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('book unavailable'); };
  try {
    const fx = fixture({ trader: new DemoTrader() });
    await quote(fx, 'UP', 0.68, 0.69);

    assert.ok(fx.w.primaryPosition);
    assert.equal(fx.w.primaryPosition.entryPrice, 0.69);
    assert.ok(Math.abs(fx.w.primaryPosition.entryNotional - 100) < 1e-8);
    assert.ok(Math.abs(fx.w.primaryPosition.shares - 100 / 0.69) < 1e-8);
  } finally { global.fetch = originalFetch; }
});

test('a fresh best-ask tick at $0.97 settles winner and loser at any time in the window', async () => {
  for (const winner of ['UP', 'DOWN']) {
    const fx = fixture();
    const primary = await enterPrimary(fx, 'UP');
    const openMs = fx.w.openTs * 1000;
    const realNow = Date.now;

    try {
      Date.now = () => openMs + 120000;
      await quote(fx, winner, 0.96, 0.97);

      const outcome = fx.bot.outcomes.get(fx.w.openTs);
      assert.equal(outcome.winner, winner);
      assert.equal(outcome.loser, winner === 'UP' ? 'DOWN' : 'UP');
      assert.equal(outcome.source, 'clob_price_threshold');
      assert.equal(primary.settled, true);
      assert.equal(fx.w.clobConfirmedOutcome, winner);
      assert.equal(fx.bot.currentStakeUsd, winner === 'UP' ? 100 : 200);
      assert.ok(fx.bot.log.some((entry) => entry.event === 'CLOB_PRICE_THRESHOLD_CONFIRMED'));
    } finally { Date.now = realNow; }
  }
});

test('a bid update cannot refresh a stale best ask above threshold', async () => {
  const fx = fixture();
  const primary = await enterPrimary(fx);
  const openMs = fx.w.openTs * 1000;
  const realNow = Date.now;

  try {
    Date.now = () => openMs + 120000;
    const staleQuote = {
      bid: 0.96, ask: 0.97, mid: 0.965,
      ts: openMs + 110000, bidTs: openMs + 110000, askTs: openMs + 100000,
    };
    fx.bot._quotesByToken.set('up-token', staleQuote);
    await fx.bot._onQuote(fx.w.slug, 'up-token', { bid: 0.96 });

    assert.equal(primary.settled, false);
    assert.equal(fx.bot.outcomes.has(fx.w.openTs), false);
  } finally { Date.now = realNow; }
});

test('closed position remains unsettled when no side reaches $0.97; no fallback is used', async () => {
  const fx = fixture();
  const primary = await enterPrimary(fx);
  await quote(fx, 'UP', 0.49, 0.51);
  await quote(fx, 'DOWN', 0.49, 0.51);

  await fx.bot._closeWindow(fx.w);
  await fx.bot._settleClosedPositions(Date.now() + 300000);

  assert.equal(fx.w.closed, true);
  assert.equal(fx.w.status, 'awaiting_price_threshold');
  assert.equal(fx.bot.outcomes.has(fx.w.openTs), false);
  assert.equal(primary.settled, false);
  assert.ok(fx.bot.pending.includes(primary));
  assert.equal(fx.bot.currentStakeUsd, 100);
  assert.ok(fx.bot.log.some((entry) => entry.event === 'WINDOW_HOLD_NO_PRICE_THRESHOLD'));
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
  assert.ok(fx.bot.log.some((entry) => entry.event === 'ENTRY_HELD_PREVIOUS_PRIMARY'
    && entry.previousSlug === previousWindow.slug));

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
  assert.equal(fx.w.primaryPosition.stakeUsd, 100);
  assert.ok(fx.bot.cash > 9900);
});

test('one filled share pays $1 on a win and $0 on a loss', async () => {
  for (const winner of ['UP', 'DOWN']) {
    const fx = fixture();
    fx.trader.askDepth.set('up-token', 1);
    const primary = await enterPrimary(fx);
    fx.w.hedgeAttempted = true;

    assert.equal(primary.shares, 1);
    assert.ok(Math.abs(primary.entryNotional - 0.69) < 1e-8);
    await confirmClobOutcome(fx, winner);

    const trade = fx.bot.trades.find((item) => item.role === 'PRIMARY');
    const payout = winner === 'UP' ? 1 : 0;
    assert.equal(primary.exitProceeds, payout);
    assert.equal(trade.exitProceeds, payout);
    assert.equal(trade.exitPrice, payout);
    assert.equal(trade.outcome, winner === 'UP' ? 'WIN' : 'LOSS');
    assert.ok(Math.abs(trade.pnl - (payout - primary.entryNotional - primary.entryFee)) < 0.01);
    assert.equal(fx.bot.currentStakeUsd, winner === 'UP' ? 100 : 200);
  }
});

test('insufficient demo cash prevents the entry order', async () => {
  const fx = fixture({ cash: 50 });
  await quote(fx, 'UP', 0.68, 0.69);

  assert.equal(fx.trader.calls.length, 0);
  assert.equal(fx.w.status, 'insufficient_cash');
  assert.equal(fx.bot.cash, 50);
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
  assert.equal(snapshot.strategy.priceThresholdUsd, 0.97);
});

test('bot emits structured events and a throttled heartbeat through its logger', () => {
  const records = [];
  const fx = fixture({
    logger: { log: (line) => records.push(JSON.parse(line.replace(/^\[bot\] /, ''))) },
  });
  const now = Date.now();
  fx.bot._lastMarketEventAt = now - 1200;
  fx.bot._lastWebSocketQuoteAt = now - 4500;

  fx.bot._push({ event: 'TEST_EVENT', slug: fx.w.slug, note: 'test event' });
  fx.bot._maybeLogHeartbeat(fx.w, now);
  fx.bot._maybeLogHeartbeat(fx.w, now + 1000);

  assert.equal(records.filter((record) => record.event === 'TEST_EVENT').length, 1);
  const heartbeats = records.filter((record) => record.event === 'BOT_HEARTBEAT');
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].slug, fx.w.slug);
  assert.equal(heartbeats[0].marketReady, true);
  assert.equal(heartbeats[0].feedSubscriptionStarted, false);
  assert.equal(heartbeats[0].lastQuoteAgeMs, 1200);
  assert.equal(heartbeats[0].lastWebSocketQuoteAgeMs, 4500);
});
