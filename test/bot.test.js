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

function fixture(botOptions = {}) {
  const trader = new FakeDemoTrader();
  const bot = new Bot(trader, botOptions);
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
  return { bot, trader, w, now: OPEN_TS * 1000 + 120_000 };
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
  assert.equal(cfg.TRANCHE_BUDGET_USD, 100);
  assert.equal(cfg.ENTRY_ASK_USD, 0.90);
  assert.equal(cfg.ENTRY_DELAY_SECONDS, 90);
  assert.equal(cfg.TAKE_PROFIT_BID_USD, 0.99);
  assert.equal(cfg.TAKE_PROFIT_CREDIT_PRICE_USD, 1.00);
  assert.equal(cfg.HARD_STOP_LOSS_BID_USD, 0.70);
  assert.equal(cfg.MAX_ENTRY_ASK_USD, 0.90);
  assert.equal(cfg.MAX_MARTINGALE_STEPS, 2);
  assert.equal(cfg.FORCED_EXIT_BUFFER_SECONDS, 10);
});

test('UP and DOWN each start with one $100 tranche', () => {
  const { bot } = fixture();
  const snapshot = bot.snapshot();
  for (const side of ['UP', 'DOWN']) {
    const tranches = snapshot.window.sides[side].tranches;
    assert.equal(tranches.length, 1);
    assert.equal(tranches[0].availableUsd, 100);
  }
});

test('all entries are blocked before 90 seconds and allowed at the exact delay boundary', async () => {
  const fx = fixture();
  const beforeBoundary = (OPEN_TS + cfg.ENTRY_DELAY_SECONDS) * 1000 - 1;
  await quote(fx, 'UP', 0.89, 0.90, beforeBoundary);
  await quote(fx, 'DOWN', 0.89, 0.90, beforeBoundary);
  assert.equal(fx.trader.calls.length, 0);
  assert.ok(['UP', 'DOWN'].every((side) => fx.w.sides[side].tranches
    .every((tranche) => tranche.state === 'waiting_entry')));

  const boundary = (OPEN_TS + cfg.ENTRY_DELAY_SECONDS) * 1000;
  await quote(fx, 'UP', 0.89, 0.90, boundary);
  await quote(fx, 'DOWN', 0.89, 0.90, boundary);
  assert.equal(fx.trader.calls.length, 2);
  assert.ok(fx.trader.calls.every((call) => call.side === 'BUY'));
  assert.ok(['UP', 'DOWN'].every((side) => fx.w.sides[side].tranches
    .every((tranche) => tranche.state === 'in_position' && tranche.position.entryBudgetUsd === 100)));
  assert.equal(fx.bot.snapshot().cfg.entryDelaySeconds, 90);
});

test('an ask above the $0.90 entry cap is skipped', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.90, 0.91);
  assert.equal(fx.trader.calls.length, 0);
  assert.equal(fx.w.sides.UP.tranches[0].state, 'waiting_entry');
});

test('UP and DOWN make independent $100 entries', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.89, 0.90);
  await quote(fx, 'DOWN', 0.89, 0.90);
  assert.equal(fx.trader.calls.length, 2);
  assert.ok(fx.w.sides.UP.tranches[0].position);
  assert.ok(fx.w.sides.DOWN.tranches[0].position);
  assert.deepEqual(fx.trader.calls.map((call) => call.amount), [100, 100]);
  assert.deepEqual(fx.trader.calls.map((call) => call.tokenId), ['up-token', 'down-token']);
  assert.ok(fx.trader.calls.every((call) => call.options.priceLimit === 0.90));
});

for (const sideName of ['UP', 'DOWN']) {
  test(`${sideName} hard stop triggers at $0.70, advances both sides, and does not rearm`, async () => {
    const fx = fixture();
    await quote(fx, sideName, 0.89, 0.90);
    const tranches = fx.w.sides[sideName].tranches;
    const positions = tranches.map((tranche) => tranche.position);
    assert.ok(positions.every(Boolean));

    await quote(fx, sideName, 0.71, 0.72);
    assert.ok(positions.every((position) => position.status === 'open'));
    await quote(fx, sideName, 0.70, 0.71);

    assert.ok(positions.every((position) => position.status === 'closed'));
    assert.ok(positions.every((position) => position.stopLossTriggered));
    assert.ok(tranches.every((tranche) => tranche.state === 'done_for_window'));
    const stopSells = fx.trader.calls.filter((call) => call.side === 'SELL');
    assert.equal(stopSells.length, 1);
    assert.ok(stopSells.every((call) => call.options.priceLimit === 0));
    const stopEvents = fx.bot.log.filter((entry) => entry.event === 'STOP_LOSS_TRIGGERED');
    assert.equal(stopEvents.length, 1);
    assert.equal(stopEvents[0].side, sideName);
    assert.equal(positions[0].lastExitPrice, 0.70);
    assert.equal(fx.bot.martingaleStep, 1);
    assert.equal(fx.bot.snapshot().martingale.nextWindowStakeUsd, 200);

    const callsAfterStops = fx.trader.calls.length;
    await quote(fx, sideName, 0.89, 0.90);
    assert.equal(fx.trader.calls.length, callsAfterStops, 'a closed tranche cannot re-enter this window');
  });
}

test('hard stop stays latched and retries if no bid fills at the trigger', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.89, 0.90);
  const [firstTranche] = fx.w.sides.UP.tranches;
  const firstPosition = firstTranche.position;
  const originalSell = fx.trader.placeFakMarketOrder.bind(fx.trader);
  let rejectFirstStop = true;
  fx.trader.placeFakMarketOrder = async (tokenId, side, amount, options = {}) => {
    if (String(side).toUpperCase() === 'SELL' && tokenId === 'up-token' && rejectFirstStop) {
      rejectFirstStop = false;
      fx.trader.calls.push({ tokenId, side, amount, options: { ...options } });
      return {
        id: 'fake-unmatched-stop', status: 'unmatched', isFilled: false, avgPrice: 0,
        raw: { makingAmount: '0', takingAmount: '0' },
      };
    }
    return originalSell(tokenId, side, amount, options);
  };

  await quote(fx, 'UP', 0.70, 0.71);
  assert.equal(firstPosition.status, 'stop_loss_triggered');
  assert.equal(firstPosition.openShares > 0, true);
  assert.equal(firstPosition.stopLossTriggered, true);

  await quote(fx, 'UP', 0.65, 0.66);
  assert.equal(firstPosition.status, 'closed');
  assert.equal(firstTranche.state, 'done_for_window');
  approx(firstPosition.lastExitPrice, 0.65);
  assert.equal(fx.bot.log.filter((entry) => entry.event === 'STOP_LOSS_TRIGGERED').length, 1);
  assert.equal(fx.bot.martingaleStep, 1);
});

test('the shared martingale doubles both side stakes twice, then resets at the cap', () => {
  const { bot } = fixture();
  const position = { slug: 'test-window', side: 'UP', trancheId: 'SINGLE' };
  let window = makeWindowState('test-window-1', OPEN_TS);
  bot._recordMartingaleStop(window, position);
  bot._recordMartingaleStop(window, { ...position, side: 'DOWN' });
  assert.equal(bot.martingaleStep, 1, 'both stops in one window advance only one step');

  let stake = bot._stakeForMartingaleStep();
  window = makeWindowState('test-window-2', OPEN_TS + 300, stake, bot.martingaleStep);
  assert.equal(window.sides.UP.tranches[0].initialBudgetUsd, 200);
  assert.equal(window.sides.DOWN.tranches[0].initialBudgetUsd, 200);
  bot._recordMartingaleStop(window, position);
  assert.equal(bot.martingaleStep, 2);

  stake = bot._stakeForMartingaleStep();
  window = makeWindowState('test-window-3', OPEN_TS + 600, stake, bot.martingaleStep);
  assert.equal(window.sides.UP.tranches[0].initialBudgetUsd, 400);
  assert.equal(window.sides.DOWN.tranches[0].initialBudgetUsd, 400);
  bot._recordMartingaleStop(window, position);
  assert.equal(bot.martingaleStep, 0, 'a stop after the capped $400 attempt resets to base');
  assert.equal(bot._stakeForMartingaleStep(), 100);
});

test('a winning position resets the shared martingale to base stakes', () => {
  const { bot } = fixture();
  bot.martingaleStep = 2;
  bot._recordMartingaleWin(null, { slug: 'test-window', side: 'DOWN', trancheId: 'SINGLE' }, 'TAKE_PROFIT');
  assert.equal(bot.martingaleStep, 0);
  assert.equal(bot._stakeForMartingaleStep(), 100);
});

test('entry asks above $0.90 are skipped; fixed $0.99 TP credits $1 per share', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.90, 0.91);
  assert.equal(fx.trader.calls.length, 0);

  await quote(fx, 'UP', 0.89, 0.90);
  assert.equal(fx.trader.calls.length, 1);
  assert.equal(fx.w.sides.UP.tranches[0].position.takeProfitPrice, 0.99);
  assert.equal(fx.w.sides.UP.tranches[0].position.takeProfitReachable, true);

  await quote(fx, 'UP', 0.98, 0.99);
  assert.equal(fx.trader.calls.length, 1, 'a bid below $0.99 must not hit TP');
  await quote(fx, 'UP', 0.99, 0.99);
  assert.equal(fx.trader.calls.length, 2, 'a bid at $0.99 hits TP');
  assert.equal(fx.bot.trades[0].exitPrice, 1);
  assert.equal(fx.bot.trades[0].clobExitPrice, 0.99);
  assert.equal(fx.w.sides.UP.tranches[0].state, 'done_for_window');
  await quote(fx, 'UP', 0.89, 0.90);
  assert.equal(fx.trader.calls.length, 2, 'a TP cannot re-enter during the window');
});

test('fixed TP credits $1 per share and leaves the tranche done for the window', async () => {
  const fx = fixture();
  fx.bot.martingaleStep = 1;
  await quote(fx, 'UP', 0.89, 0.90);
  const tranche = fx.w.sides.UP.tranches[0];
  const position = tranche.position;
  approx(position.takeProfitPrice, 0.99);

  await quote(fx, 'UP', 0.98, 0.99);
  assert.equal(fx.trader.calls.length, 1, 'bid below TP must not sell');

  await quote(fx, 'UP', 0.99, 0.99);
  assert.equal(fx.trader.calls.length, 2);
  assert.equal(fx.trader.calls[1].side, 'SELL');
  assert.equal(fx.trader.calls[1].options.priceLimit, 0.99);
  assert.equal(tranche.state, 'done_for_window');
  assert.equal(tranche.position, null);
  assert.equal(fx.bot.martingaleStep, 0, 'a TP resets both sides to the base martingale stake');
  const expectedNetProceeds = position.shares * 1 - estimateTakerFee(position.shares, 0.99);
  approx(tranche.availableUsd, expectedNetProceeds, 1e-6);
  approx(fx.bot.trades[0].netExitProceeds, expectedNetProceeds, 1e-3);
  approx(fx.bot.trades[0].exitPrice, 1);
  approx(fx.bot.trades[0].clobExitPrice, 0.99);
  approx(fx.bot.stats.realizedPnl, fx.bot.trades[0].pnl, 0.01);

  await quote(fx, 'UP', 0.89, 0.90);
  assert.equal(fx.trader.calls.length, 2, 'a completed TP does not rearm');
});

test('partial TP fills credit $1 per share while marking remaining shares at the CLOB bid', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.89, 0.90);
  const tranche = fx.w.sides.UP.tranches[0];
  const position = tranche.position;
  const originalOrder = fx.trader.placeFakMarketOrder.bind(fx.trader);
  let partial = true;
  fx.trader.placeFakMarketOrder = async (tokenId, side, amount, options = {}) => {
    if (String(side).toUpperCase() === 'SELL' && partial) {
      partial = false;
      fx.trader.calls.push({ tokenId, side, amount, options: { ...options } });
      const shares = Number(amount) / 2;
      return {
        id: 'fake-partial-tp', status: 'matched', isFilled: true, avgPrice: 0.99,
        raw: { makingAmount: String(shares), takingAmount: String(shares * 0.99) },
      };
    }
    return originalOrder(tokenId, side, amount, options);
  };

  await quote(fx, 'UP', 0.99, 0.99);
  approx(position.openShares, position.shares / 2);
  approx(position.exitProceeds, position.shares / 2);
  approx(position.lastMark, 0.99);

  await quote(fx, 'UP', 0.99, 0.99);
  assert.equal(position.openShares, 0);
  approx(fx.bot.trades[0].exitPrice, 1);
  approx(fx.bot.trades[0].clobExitPrice, 0.99);
  approx(fx.bot.trades[0].exitProceeds, position.shares, 1e-3);
});

test('forced exits start at T−10 seconds and close the position', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.89, 0.90);
  const closeMs = (OPEN_TS + 300) * 1000;
  const position = fx.w.sides.UP.tranches[0].position;

  await quote(fx, 'UP', 0.75, 0.76, closeMs - 10001);
  assert.equal(position.openShares > 0, true);
  assert.equal(fx.trader.calls.length, 1);

  await quote(fx, 'UP', 0.75, 0.76, closeMs - 10000);
  assert.equal(position.openShares, 0);
  assert.equal(fx.trader.calls.length, 2);
  assert.equal(fx.trader.calls[1].side, 'SELL');
  assert.equal(fx.trader.calls[1].options.priceLimit, 0);
  assert.equal(fx.w.sides.UP.tranches[0].state, 'done_for_window');
  assert.equal(fx.trader.calls.some((call) => call.side === 'BUY' && call.amount !== 100), false);
});

test('forced exit sells the side’s single open tranche', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.89, 0.90);
  const before = fx.trader.calls.length;

  const exits = fx.bot._forceExitSide(fx.w, 'UP', fx.now);
  const sells = fx.trader.calls.slice(before).filter((call) => call.side === 'SELL');
  assert.equal(sells.length, 1);
  await exits;
  assert.ok(fx.w.sides.UP.tranches.every((tranche) => tranche.state === 'done_for_window'));
});

test('partial exits immediately update realized P&L and it reconciles with total P&L', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.89, 0.90);
  const tranche = fx.w.sides.UP.tranches[0];
  const position = tranche.position;
  fx.trader.books.set('up-token', {
    bids: [{ price: 0.80, size: 100 }],
    asks: [],
  });

  await fx.bot._sellPosition(fx.w, tranche, position, 'TAKE_PROFIT', 0.80, fx.now + 1000);

  assert.equal(position.status, 'tp_partial');
  assert.ok(position.openShares > 0);
  assert.ok(position.realizedPnl > 0);
  approx(fx.bot.stats.realizedPnl, position.realizedPnl, 1e-6);
  const account = fx.bot.snapshot().account;
  approx(account.totalPnl, fx.bot.stats.realizedPnl + account.unrealizedPnl, 0.02);
});

test('a quote after expiry cannot create a simulated late sale', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.89, 0.90);
  const position = fx.w.sides.UP.tranches[0].position;
  const expiredAt = (OPEN_TS + 300) * 1000 + 1;

  await quote(fx, 'UP', 0.70, 0.71, expiredAt);
  approx(position.lastMark, 0.89);
  const realNow = Date.now;
  let expiredSnapshot;
  try {
    Date.now = () => expiredAt;
    expiredSnapshot = fx.bot.snapshot();
  } finally {
    Date.now = realNow;
  }
  assert.equal(expiredSnapshot.pending[0].status, 'pending_resolution');
  assert.equal(expiredSnapshot.pending[0].mark, null);
  assert.equal(expiredSnapshot.account.totalPnl, null);
  await fx.bot._finishWindow(fx.w, expiredAt, 'WINDOW_EXPIRED');

  assert.equal(fx.trader.calls.length, 1, 'no SELL should be simulated after expiry');
  assert.ok(position.openShares > 0);
  assert.equal(position.status, 'pending_resolution');
});

test('expired positions awaiting resolution keep a stale reference mark but are excluded from valuation', async () => {
  const fx = fixture();
  await quote(fx, 'UP', 0.89, 0.90);
  const position = fx.w.sides.UP.tranches[0].position;
  const expiredAt = (OPEN_TS + 300) * 1000 + 1;
  await fx.bot._finishWindow(fx.w, expiredAt, 'WINDOW_EXPIRED');

  const snapshot = fx.bot.snapshot();
  const awaitingResolution = snapshot.pending[0];
  assert.equal(awaitingResolution.status, 'pending_resolution');
  assert.equal(awaitingResolution.mark, null);
  assert.equal(awaitingResolution.unrealized, null);
  approx(awaitingResolution.lastKnownMark, 0.89);
  assert.equal(snapshot.account.unresolvedPositions, 1);
  approx(snapshot.account.unresolvedEntryCost, position.remainingEntryCost, 0.01);
  assert.equal(snapshot.account.equity, null);
  assert.equal(snapshot.account.totalPnl, null);
  assert.equal(snapshot.account.maxDrawdown, null);
});

for (const scenario of [
  { name: 'winning', winner: 'UP', payoutPerShare: { UP: 1, DOWN: 0 } },
  { name: 'losing', winner: 'DOWN', payoutPerShare: { UP: 0, DOWN: 1 } },
]) {
  test(`official ${scenario.name} outcome settles only remaining shares and realizes P&L`, async () => {
    const fx = fixture({
      resolveMarketOutcome: async () => ({
        resolved: true, winningSide: scenario.winner, payoutPerShare: scenario.payoutPerShare,
      }),
    });
    await quote(fx, 'UP', 0.89, 0.90);
    const position = fx.w.sides.UP.tranches[0].position;
    const entryCost = position.remainingEntryCost;
    const shares = position.openShares;
    const cashBeforeSettlement = fx.bot.cash;
    const expiredAt = (OPEN_TS + 300) * 1000 + 1;
    await fx.bot._finishWindow(fx.w, expiredAt, 'WINDOW_EXPIRED');

    assert.equal(position.status, 'pending_resolution');
    assert.equal(fx.bot.trades.length, 0);
    await fx.bot._pollExpiredResolutions(expiredAt);

    const payoutPerShare = scenario.payoutPerShare.UP;
    const payout = shares * payoutPerShare;
    assert.equal(position.status, 'settled');
    assert.equal(position.openShares, 0);
    assert.equal(position.resolutionOutcome, scenario.winner);
    assert.equal(position.resolutionPricePerShare, payoutPerShare);
    approx(fx.bot.cash, cashBeforeSettlement + payout, 1e-6);
    approx(fx.bot.stats.realizedPnl, payout - entryCost, 1e-6);
    assert.equal(fx.bot.stats.settlements, 1);
    assert.equal(fx.bot.pending.length, 0);
    assert.equal(fx.bot.trades[0].reason, 'MARKET_RESOLUTION');
    assert.equal(fx.bot.trades[0].resolutionOutcome, scenario.winner);
    assert.equal(fx.bot.trades[0].resolutionPricePerShare, payoutPerShare);
    approx(fx.bot.trades[0].pnl, Math.round((payout - entryCost) * 100) / 100, 1e-6);
    assert.equal(fx.bot.snapshot().account.unresolvedPositions, 0);
  });
}

test('pending Gamma resolution is not guessed and is retried after the poll interval', async () => {
  let calls = 0;
  const fx = fixture({
    resolveMarketOutcome: async () => {
      calls += 1;
      return calls === 1
        ? { resolved: false, reason: 'UMA resolution is still pending.' }
        : { resolved: true, winningSide: 'UP', payoutPerShare: { UP: 1, DOWN: 0 } };
    },
  });
  await quote(fx, 'UP', 0.89, 0.90);
  const position = fx.w.sides.UP.tranches[0].position;
  const expiredAt = (OPEN_TS + 300) * 1000 + 1;
  await fx.bot._finishWindow(fx.w, expiredAt, 'WINDOW_EXPIRED');

  await fx.bot._pollExpiredResolutions(expiredAt);
  assert.equal(calls, 1);
  assert.equal(position.status, 'pending_resolution');
  assert.equal(fx.bot.trades.length, 0);
  assert.equal(fx.bot.cash < fx.bot.capital, true);

  await fx.bot._pollExpiredResolutions(expiredAt + cfg.RESOLUTION_POLL_MS - 1);
  assert.equal(calls, 1, 'do not query Gamma more often than the configured poll interval');
  await fx.bot._pollExpiredResolutions(expiredAt + cfg.RESOLUTION_POLL_MS);

  assert.equal(calls, 2);
  assert.equal(position.status, 'settled');
  assert.equal(fx.bot.pending.length, 0);
  assert.equal(fx.bot.stats.settlements, 1);
});

test('demo-only guard blocks non-demo order adapters', async () => {
  const trader = new FakeDemoTrader();
  trader.demoMode = false;
  const bot = new Bot(trader);
  const fx = fixture();
  bot.w = fx.w;
  bot.prices = fx.bot.prices;
  bot._marketFeedSlug = fx.w.slug;
  await quote({ ...fx, bot }, 'UP', 0.89, 0.90);

  assert.equal(bot.executionHalt, true);
  assert.equal(trader.calls.length, 0);
});

test('snapshot reports the demo-only mode and configured TP/cap rules', () => {
  const { bot } = fixture();
  const snapshot = bot.snapshot();
  assert.equal(snapshot.mode, 'DEMO');
  assert.equal(snapshot.strategy.trancheBudgetUsd, 100);
  assert.equal(snapshot.strategy.entryAsk, 0.90);
  assert.equal(snapshot.strategy.takeProfitBid, 0.99);
  assert.equal(snapshot.strategy.takeProfitCreditPrice, 1.00);
  assert.equal(snapshot.strategy.maxEntryAsk, 0.90);
  assert.equal(snapshot.strategy.forcedExitBufferSeconds, 10);
  assert.equal(snapshot.strategy.hardStopLossBid, 0.70);
  assert.equal(snapshot.strategy.maxMartingaleSteps, 2);
  assert.equal(snapshot.martingale.nextWindowStakeUsd, 100);
  assert.equal(snapshot.executionHalt, false);
});
