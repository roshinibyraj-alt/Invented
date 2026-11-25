'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Bot = require('../freqai-btc-bot');
const { windowNet, recoveryShares } = require('../freqai-recovery');

function fixture() {
  const start = 1_800_000_000_000;
  let now = start + 85_000;
  let prediction = {
    windowStart: start, candleStart: start + 60_000,
    pUp: 0.7, pDown: 0.3,
  };
  const bot = new Bot({
    now: () => now, marketData: {}, initialCapital: 3000,
    freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: prediction }) },
  });
  const record = bot.records.get('BTC:5m');
  record.marketStatus = 'OPEN';
  record.market = {
    id: 'first', start, end: start + 300_000,
    tokens: { UP: 'up-first', DOWN: 'down-first' }, feeSchedule: { rate: 0.05 },
  };
  let sequence = 0;
  function book(side, ask, bid, size = 5000) {
    const quote = {
      bestBid: bid, bestAsk: ask, mid: (ask + bid) / 2,
      bids: bid ? [{ price: bid, size }] : [],
      asks: ask ? [{ price: ask, size }] : [],
      updatedAt: now, sequence: ++sequence,
    };
    record.quotes[side] = quote;
    return quote;
  }
  function check(side) {
    bot.processSide(record, side, record.quotes[side], ++sequence);
  }
  book('UP', 0.7, 0.69);
  book('DOWN', 0.31, 0.3);
  check('UP');
  return {
    bot, record, start, book, check,
    signal(up, down) { prediction = { windowStart: record.market.start, candleStart: now - 20_000, pUp: up, pDown: down }; },
    advance(ms) { now += ms; },
  };
}

test('only an opposite probability strictly above 60% flips, with no same-side adds', () => {
  const f = fixture();
  f.check('UP');
  for (const down of [0.51, 0.59, 0.6]) {
    f.signal(1 - down, down);
    f.check('DOWN');
  }
  assert.equal(f.bot.orders.length, 1);
  f.signal(0.39, 0.61);
  f.book('UP', 0.21, 0.2);
  f.book('DOWN', 0.81, 0.8);
  f.check('DOWN');
  assert.equal(f.bot.orders.length, 3);
  assert.equal(f.bot.positions.filter(p => p.status === 'OPEN').length, 1);
  const p = f.bot.positions.find(p => p.status === 'OPEN');
  assert.equal(p.side, 'DOWN');
  assert.ok(p.shares > 50);
  assert.ok(windowNet(f.bot, f.record) + p.shares - p.totalCost - p.fees >= -1e-8);
  const cash = f.bot.cash;
  f.check('DOWN');
  assert.equal(f.bot.cash, cash);
});

test('recovery uses full depth costs, rounds up and includes buy and sell fees', () => {
  const f = fixture();
  f.signal(0.2, 0.8);
  f.book('UP', 0.11, 0.1);
  const q = f.book('DOWN', 0.8, 0.79);
  q.asks = [{ price: 0.8, size: 30 }, { price: 0.9, size: 5000 }];
  f.check('DOWN');
  const p = f.bot.positions.find(p => p.status === 'OPEN');
  const closed = f.bot.positions.find(p => p.status === 'CLOSED_FLIP');
  assert.equal(p.shares, Math.ceil(p.shares));
  assert.ok(closed.sellFees > 0);
  assert.ok(closed.realizedPnl < -30);
  const net = windowNet(f.bot, f.record);
  assert.ok(net + p.shares - p.totalCost - p.fees >= -1e-8);
  const expectedCash = 3000 + net - p.totalCost - p.fees;
  assert.ok(Math.abs(f.bot.cash - expectedCash) < 1e-8);
  assert.equal(f.bot.accountSnapshot().settledPositions, 1);
});

test('partial sells do not invent liquidity or buy before all held shares sell', () => {
  const f = fixture();
  f.signal(0.2, 0.8);
  f.book('UP', 0.31, 0.3, 20);
  f.check('DOWN');
  assert.equal(f.bot.positions.find(p => p.status === 'OPEN').shares, 30);
  assert.equal(f.bot.orders.filter(o => o.action === 'BUY_TAKER').length, 1);
  f.check('DOWN');
  assert.equal(f.bot.positions.find(p => p.status === 'OPEN').shares, 30);
  f.book('UP', 0.31, 0.3, 30);
  f.check('DOWN');
  assert.equal(f.bot.positions.find(p => p.status === 'OPEN').side, 'DOWN');
  assert.equal(f.bot.positions.filter(p => p.status === 'CLOSED_FLIP').length, 2);
});

test('empty or stale sell books cannot produce fake sells', () => {
  const f = fixture();
  f.signal(0.2, 0.8);
  f.book('UP', 0.31, null);
  f.check('DOWN');
  assert.equal(f.bot.orders.length, 1);
  f.book('UP', 0.31, 0.3);
  f.record.quotes.UP.updatedAt -= 3000;
  f.check('DOWN');
  assert.equal(f.bot.orders.length, 1);
});

test('replacement waits for sufficient depth and cash instead of a fake recovery fill', () => {
  const f = fixture();
  f.signal(0.2, 0.8);
  f.book('UP', 0.11, 0.1);
  f.book('DOWN', 0.9, 0.89, 5);
  f.check('DOWN');
  assert.equal(f.record.sideStates.DOWN.orderStatus, 'WAITING_FOR_RECOVERY_DEPTH');
  assert.equal(f.bot.positions.filter(p => p.status === 'OPEN').length, 0);
  f.bot.cash = 1;
  f.book('DOWN', 0.9, 0.89);
  f.check('DOWN');
  assert.equal(f.record.sideStates.DOWN.orderStatus, 'WAITING_FOR_PAPER_CASH');
  assert.equal(f.bot.orders.filter(o => o.action === 'BUY_TAKER').length, 1);
});

test('repeated flips recalculate cumulative losses, then next window starts at 50', () => {
  const f = fixture();
  f.signal(0.2, 0.8);
  f.book('UP', 0.21, 0.2);
  f.book('DOWN', 0.81, 0.8);
  f.check('DOWN');
  const firstDeficit = f.bot.snapshot().recovery.deficit;
  f.signal(0.8, 0.2);
  f.book('DOWN', 0.11, 0.1);
  f.book('UP', 0.81, 0.8);
  f.check('UP');
  assert.ok(f.bot.snapshot().recovery.deficit > firstDeficit);
  const p = f.bot.positions.find(p => p.status === 'OPEN');
  assert.ok(windowNet(f.bot, f.record) + p.shares - p.totalCost - p.fees >= -1e-8);

  p.status = 'PENDING_RESOLUTION';
  f.advance(300_000);
  f.record.market = {
    ...f.record.market, id: 'second', start: f.start + 300_000,
    end: f.start + 600_000, tokens: { UP: 'up-second', DOWN: 'down-second' },
  };
  f.signal(0.8, 0.2);
  f.book('UP', 0.4, 0.39);
  f.check('UP');
  assert.equal(f.bot.positions.find(x => x.status === 'OPEN').shares, 50);
  assert.equal(f.bot.snapshot().recovery.deficit, 0);
});

test('profitable sale keeps the replacement at the 50-share floor', () => {
  const f = fixture();
  f.signal(0.2, 0.8);
  f.book('UP', 0.91, 0.9);
  f.check('DOWN');
  assert.ok(windowNet(f.bot, f.record) > 0);
  assert.equal(f.bot.positions.find(p => p.status === 'OPEN').shares, 50);
});

test('restart keeps held position and current-window recovery without duplicate entry', () => {
  const f = fixture();
  f.signal(0.2, 0.8);
  f.book('UP', 0.21, 0.2);
  f.book('DOWN', 0.81, 0.8);
  f.check('DOWN');
  const saved = f.bot.exportLedger();
  const restored = new Bot({ now: f.bot.now, marketData: {}, initialCapital: 3000 });
  restored.restoreLedger(saved);
  assert.equal(restored.positions.filter(p => p.status === 'OPEN').length, 1);
  assert.equal(restored.positions.find(p => p.status === 'OPEN').side, 'DOWN');
  assert.equal(restored.accountSnapshot().settledPositions, 1);
  assert.equal(restored.positions.find(p => p.status === 'OPEN').shares,
    f.bot.positions.find(p => p.status === 'OPEN').shares);
});

test('recovery planner rejects unavailable depth instead of extrapolating fills', () => {
  assert.equal(recoveryShares({ asks: [{ price: 0.9, size: 50 }] }, 100, 0.05), null);
  assert.equal(recoveryShares({ asks: [{ price: 0.5, size: 5000 }] }, 0, 0.05), 50);
});
