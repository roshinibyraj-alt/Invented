'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DipBounceBot = require('../dip-bounce-bot');

function fakeMarket(asset, timeframe, start) {
  const windowMs = timeframe === '5m' ? 300_000 : 900_000;
  return {
    id: `${asset}-${timeframe}-${start}`,
    slug: `${asset.toLowerCase()}-updown-${timeframe}-${Math.floor(start / 1000)}`,
    title: `${asset} ${timeframe} market`,
    asset,
    timeframe,
    start,
    end: start + windowMs,
    tokens: { UP: `${asset}-${timeframe}-up`, DOWN: `${asset}-${timeframe}-down` },
  };
}

function makeBot({ now = 1_800_000_000_100, marketData = {} } = {}) {
  let clock = now;
  const data = {
    getAssetMarket: async (asset, start, windowMs) => ({
      ...fakeMarket(asset.toUpperCase(), windowMs === 300_000 ? '5m' : '15m', start),
      end: start + windowMs,
    }),
    connectMarketStream: (tokenIds, options) => ({
      tokenIds,
      options,
      close() {},
    }),
    getMarket: async () => null,
    resolvedWinner: () => null,
    ...marketData,
  };
  const bot = new DipBounceBot({ marketData: data, now: () => clock, initialCapital: 3000 });
  bot.running = true;
  return {
    bot,
    data,
    setNow(value) { clock = value; },
  };
}

function setMarket(bot, asset = 'BTC', timeframe = '5m', start = 1_800_000_000_000) {
  const record = bot.records.get(`${asset}:${timeframe}`);
  record.targetStart = start;
  record.market = fakeMarket(asset, timeframe, start);
  record.marketStatus = 'OPEN';
  return record;
}

function book(bid, ask) {
  return {
    bids: bid == null ? [] : [{ price: String(bid), size: '500' }],
    asks: ask == null ? [] : [{ price: String(ask), size: '500' }],
  };
}

test('scans only BTC and ETH 5-minute markets and subscribes to their CLOB tokens', async () => {
  const start = 1_800_000_000_000;
  const { bot } = makeBot({ now: start + 1000 });
  await bot.tick(start + 1000);

  const state = bot.snapshot();
  assert.equal(state.markets.length, 2);
  assert.deepEqual(state.scanner.assets, ['BTC', 'ETH']);
  assert.deepEqual(state.scanner.timeframes, ['5m']);
  assert.ok(state.markets.every((market) => market.marketStatus === 'OPEN'));
  assert.equal(bot.tokenRefs.size, 4);
  assert.deepEqual(Object.keys(state.sizingByAsset), ['BTC', 'ETH']);
  bot.stop();
});

test('only a midpoint strictly below $0.35 arms a side', () => {
  const { bot, setNow } = makeBot();
  const start = 1_800_000_000_000;
  const record = setMarket(bot, 'ETH', '5m', start);

  for (const [offset, bid, ask] of [[1000, 0.38, 0.40], [2000, 0.34, 0.36], [3000, 0.49, 0.51]]) {
    setNow(start + offset);
    bot.applyBook(record, 'UP', book(bid, ask), start + offset);
    assert.equal(record.sideStates.UP.dipSeen, false);
    assert.equal(bot.orders.length, 0);
  }
  setNow(start + 4000);
  bot.applyBook(record, 'UP', book(0.33, 0.35), start + 4000);
  assert.equal(record.sideStates.UP.dipSeen, true);
  assert.equal(bot.snapshot().strategy.dipBelow, 0.35);
});

test('a dip then rebound immediately buys 100 shares at asks with taker fees', () => {
  const { bot, setNow } = makeBot();
  const start = 1_800_000_000_000;
  const record = setMarket(bot, 'BTC', '5m', start);

  setNow(start + 1000);
  bot.applyBook(record, 'UP', book(0.33, 0.35), start + 1000);
  assert.equal(record.sideStates.UP.dipSeen, true);
  assert.equal(record.sideStates.UP.orderStatus, 'WAITING_FOR_BOUNCE');

  setNow(start + 2000);
  bot.applyBook(record, 'UP', book(0.49, 0.51), start + 2000);
  assert.equal(bot.orders[0].status, 'FILLED');
  assert.equal(bot.orders[0].action, 'BUY_TAKER');
  assert.equal(bot.orders[0].limitPrice, 0.99);
  assert.equal(bot.orders[0].requestedShares, 100);
  assert.equal(bot.positions.length, 1, 'taker entry fills on the trigger tick');

  setNow(start + 3000);
  bot.applyBook(record, 'UP', book(0.47, 0.49), start + 3000);
  assert.equal(bot.orders[0].status, 'FILLED');
  assert.equal(bot.orders[0].fillPrice, 0.51);
  assert.equal(bot.orders[0].filledShares, 100);
  assert.equal(bot.positions[0].shares, 100);
  assert.equal(bot.positions[0].totalCost, 51);
  assert.ok(Math.abs(bot.positions[0].fees - 1.2495) < 1e-8);
  assert.ok(Math.abs(bot.cash - 2947.7505) < 1e-8);
  assert.equal(bot.orders.length, 1, 'later ticks do not buy again');
  assert.equal(bot.accountSnapshot().settledPositions, 0);
  assert.equal(bot.accountSnapshot().wins, 0);
  assert.equal(bot.accountSnapshot().losses, 0);
});

test('the first side to trigger blocks the opposite side for the whole market window', () => {
  const { bot, setNow } = makeBot();
  const start = 1_800_000_000_000;
  const record = setMarket(bot, 'ETH', '5m', start);

  setNow(start + 1000);
  bot.applyBook(record, 'UP', book(0.33, 0.35), start + 1000);
  bot.applyBook(record, 'DOWN', book(0.32, 0.34), start + 1001);
  setNow(start + 2000);
  bot.applyBook(record, 'UP', book(0.49, 0.51), start + 2000);
  bot.applyBook(record, 'DOWN', book(0.50, 0.52), start + 2001);

  assert.equal(bot.orders.length, 1);
  assert.equal(bot.orders[0].side, 'UP');
  assert.equal(record.triggeredSide, 'UP');
  assert.equal(record.sideStates.DOWN.orderStatus, 'BLOCKED_FIRST_TRIGGER');
  assert.equal(bot.positions.length, 1);
});

test('an empty bid book triggers the $0.00 stop-loss without waiting for resolution', () => {
  const { bot, setNow } = makeBot();
  const start = 1_800_000_000_000;
  const record = setMarket(bot, 'ETH', '5m', start);

  setNow(start + 1000);
  bot.applyBook(record, 'DOWN', book(0.33, 0.35), start + 1000);
  setNow(start + 2000);
  bot.applyBook(record, 'DOWN', book(0.49, 0.51), start + 2000);
  setNow(start + 3000);
  bot.applyBook(record, 'DOWN', book(0.47, 0.49), start + 3000);
  const position = bot.positions[0];

  setNow(start + 4000);
  bot.applyBook(record, 'DOWN', book(0.01, 0.03), start + 4000);
  assert.equal(position.status, 'OPEN', 'a positive bid does not trigger the zero stop');

  setNow(start + 5000);
  bot.applyBook(record, 'DOWN', book(null, 0.01), start + 5000);
  assert.equal(position.status, 'STOP_LOSS');
  assert.equal(position.exitPrice, 0);
  assert.equal(position.exitPayout, 0);
  assert.equal(position.exitReason, 'STOP_LOSS_000');
  assert.ok(Math.abs(position.realizedPnl + 51.2499) < 1e-8);
  assert.ok(Math.abs(bot.cash - 2948.7501) < 1e-8);
  assert.equal(bot.snapshot().strategy.stopLoss, '$0.00 best bid; an empty bid book is a zero-payout loss, not a sell order.');
  assert.equal(bot.sizingByAsset.ETH.nextShares, 200);
  assert.equal(bot.sizingByAsset.BTC.nextShares, 100, 'ETH sizing changes do not affect BTC');
  assert.equal(position.fees, 0.2499, 'only the entry fee is charged; zero-stop adds no sell fee');
});

test('$0.99 take-profit still credits $1 per share', () => {
  const { bot, setNow } = makeBot();
  const start = 1_800_000_000_000;
  const record = setMarket(bot, 'ETH', '5m', start);

  setNow(start + 1000);
  bot.applyBook(record, 'UP', book(0.33, 0.35), start + 1000);
  setNow(start + 2000);
  bot.applyBook(record, 'UP', book(0.49, 0.51), start + 2000);
  const position = bot.positions[0];
  setNow(start + 3000);
  bot.applyBook(record, 'UP', book(0.99, 1.00), start + 3000);
  assert.equal(position.status, 'TAKE_PROFIT');
  assert.equal(position.exitPrice, 0.99);
  assert.equal(position.exitPayout, 1);
  assert.ok(Math.abs(position.realizedPnl - 48.7501) < 1e-8);
  assert.ok(Math.abs(bot.cash - 3048.7501) < 1e-8);
  assert.equal(bot.sizingByAsset.ETH.nextShares, 100, 'a win at the floor keeps the next size at 100');
});

test('window end sends the first triggered position to official resolution', async () => {
  const start = 1_800_000_000_000;
  let resolution = null;
  const { bot, setNow } = makeBot({
    now: start + 1000,
    marketData: {
      getMarket: async () => ({ closed: true, outcomes: ['Up', 'Down'], outcomePrices: [1, 0] }),
      resolvedWinner: (market) => market?.closed ? 'UP' : null,
    },
  });
  const record = setMarket(bot, 'ETH', '5m', start);

  setNow(start + 1000);
  bot.applyBook(record, 'UP', book(0.33, 0.35), start + 1000);
  setNow(start + 2000);
  bot.applyBook(record, 'UP', book(0.49, 0.51), start + 2000);
  setNow(start + 3000);
  bot.applyBook(record, 'DOWN', book(0.33, 0.35), start + 3000);
  setNow(start + 4000);
  bot.applyBook(record, 'DOWN', book(0.49, 0.51), start + 4000);
  const position = bot.positions[0];
  assert.equal(bot.positions.length, 1);
  assert.equal(record.sideStates.DOWN.orderStatus, 'BLOCKED_FIRST_TRIGGER');

  setNow(record.market.end);
  bot.expireMarket(record, record.market.end);
  assert.equal(position.status, 'PENDING_RESOLUTION');
  assert.ok(Math.abs(bot.cash - 2948.7501) < 1e-8);
  assert.equal(bot.snapshot().strategy.stopLoss, '$0.00 best bid; an empty bid book is a zero-payout loss, not a sell order.');

  setNow(record.market.end + 10_001);
  await bot.checkResolutions(record.market.end + 10_001);
  resolution = position.status;
  assert.equal(resolution, 'RESOLVED_WIN');
  assert.ok(Math.abs(position.realizedPnl - 48.7501) < 1e-8);
  assert.ok(Math.abs(bot.cash - 3048.7501) < 1e-8);
  assert.equal(bot.sizingByAsset.ETH.nextShares, 100);
});

test('taker sweep uses multiple ask levels and cancels shallow-book remainder', () => {
  const { bot, setNow } = makeBot();
  const start = 1_800_000_000_000;
  const record = setMarket(bot);
  setNow(start + 1000);
  bot.applyBook(record, 'UP', book(0.33, 0.35), start + 1000);
  setNow(start + 2000);
  bot.applyBook(record, 'UP', {
    bids: [{ price: '0.49', size: '500' }],
    asks: [{ price: '0.51', size: '20' }, { price: '0.52', size: '30' }],
  }, start + 2000);
  assert.equal(bot.orders[0].status, 'PARTIALLY_FILLED');
  assert.equal(bot.positions[0].shares, 50);
  assert.ok(Math.abs(bot.positions[0].entryPrice - 0.516) < 1e-8);
  assert.equal(bot.orders[0].unfilledShares, 50);
  assert.equal(bot.orders[0].reservedCash, 0);
  setNow(start + 3000);
  bot.applyBook(record, 'UP', book(0.49, 0.51), start + 3000);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].shares, 50);
});

test('missing books do not arm a dip or create invented taker fills', () => {
  const { bot, setNow } = makeBot();
  const start = 1_800_000_000_000;
  const record = setMarket(bot);
  setNow(start + 1000);
  bot.applyBook(record, 'UP', book(null, null), start + 1000);
  assert.equal(record.sideStates.UP.dipSeen, false);
  setNow(start + 2000);
  bot.applyBook(record, 'UP', book(0.49, 0.51), start + 2000);
  assert.equal(bot.orders.length, 0);
});

test('a later win resets an asset to base once the recovery round exceeds $40 net', async () => {
  const start = 1_800_000_000_000;
  const { bot, setNow } = makeBot({ now: start + 1000 });
  const record = setMarket(bot, 'BTC', '5m', start);

  setNow(start + 1000);
  bot.applyBook(record, 'UP', book(0.33, 0.35), start + 1000);
  setNow(start + 2000);
  bot.applyBook(record, 'UP', book(0.49, 0.51), start + 2000);
  setNow(start + 3000);
  bot.applyBook(record, 'UP', book(null, 0.01), start + 3000);
  assert.equal(bot.sizingByAsset.BTC.nextShares, 200);
  assert.equal(bot.sizingByAsset.ETH.nextShares, 100);
  assert.equal(bot.sizingByAsset.BTC.recoveryActive, true);
  assert.ok(bot.sizingByAsset.BTC.recoveryNetPnl < 0);

  const nextStart = start + 300_000;
  setNow(nextStart + 1000);
  await bot.refreshMarket(record, nextStart + 1000);
  assert.equal(record.market.start, nextStart);
  assert.equal(record.sideStates.UP.requestedShares, 200);
  bot.applyBook(record, 'UP', book(0.33, 0.35), nextStart + 1000);
  setNow(nextStart + 2000);
  bot.applyBook(record, 'UP', book(0.49, 0.51), nextStart + 2000);
  assert.equal(bot.orders[0].requestedShares, 200);
  assert.equal(bot.positions[0].shares, 200);

  setNow(nextStart + 3000);
  bot.applyBook(record, 'UP', book(0.99, 1.00), nextStart + 3000);
  assert.equal(bot.positions[0].status, 'TAKE_PROFIT');
  assert.equal(bot.sizingByAsset.BTC.nextShares, 100);
  assert.equal(bot.positions[0].nextEntryShares, 100);
  assert.equal(bot.sizingByAsset.BTC.recoveryActive, false);
  assert.equal(bot.sizingByAsset.BTC.recoveryNetPnl, 0);
  assert.equal(bot.sizingByAsset.BTC.recoveryResetCount, 1);
  assert.equal(bot.positions[0].sizingOutcome, 'WIN', '$0.99 take-profit stays classified as a win');
});

test('recovery can span multiple wins until cumulative net P&L reaches $40', () => {
  const { bot } = makeBot();
  const sizing = bot.sizingByAsset.BTC;
  sizing.nextShares = 300;
  sizing.recoveryActive = true;
  sizing.recoveryNetPnl = -100;

  bot.updateSizingAfterClose({
    asset: 'BTC', timeframe: '5m', side: 'UP',
    realizedPnl: 55, sizingApplied: false,
  }, true, 1_800_000_001_000);
  assert.equal(sizing.nextShares, 200);
  assert.equal(sizing.recoveryNetPnl, -45);
  assert.equal(sizing.recoveryActive, true);

  bot.updateSizingAfterClose({
    asset: 'BTC', timeframe: '5m', side: 'DOWN',
    realizedPnl: 90, sizingApplied: false,
  }, true, 1_800_000_002_000);
  assert.equal(sizing.nextShares, 100);
  assert.equal(sizing.recoveryNetPnl, 0);
  assert.equal(sizing.recoveryActive, false);
  assert.equal(sizing.recoveryResetCount, 1);
});

test('restoring a ledger preserves balance, sizing round and one-entry-per-window state', async () => {
  const start = 1_800_000_000_000;
  let saved;
  const ledgerStore = { async save(value) { saved = value; } };
  const { bot, setNow } = makeBot({ now: start + 1000 });
  bot.ledgerStore = ledgerStore;
  bot.ledgerPersistenceState.enabled = true;
  const market = fakeMarket('BTC', '5m', start);
  const snapshot = {
    mode: 'DEMO ONLY',
    strategy: { id: 'btc-eth-5m-dip-bounce-paper' },
    account: {
      initialCapital: 3000,
      cash: 2900,
      peakEquity: 3100,
      maxDrawdown: 200,
      equityCurve: [{ at: start, equity: 3000 }, { at: start + 500, equity: 2900 }],
    },
    sizingByAsset: {
      BTC: { nextShares: 200, recoveryNetPnl: -60, recoveryActive: true, wins: 2, losses: 1 },
      ETH: { nextShares: 100, recoveryNetPnl: 0, recoveryActive: false, wins: 1, losses: 0 },
    },
    positions: [{
      id: 'existing-position',
      marketId: market.id,
      marketTitle: market.title,
      asset: 'BTC',
      timeframe: '5m',
      side: 'UP',
      status: 'OPEN',
      shares: 100,
      requestedShares: 200,
      totalCost: 50,
      fees: 0.5,
      estimatedMakerRebate: 0,
      windowStart: start,
      windowEnd: start + 300_000,
      markBid: 0.5,
      unrealizedPnl: 0,
    }],
    orders: [{ id: 'existing-order', asset: 'BTC', timeframe: '5m', requestedShares: 200 }],
    events: [{ time: start, type: 'BUY_FILLED', message: 'Saved event' }],
  };

  bot.restoreLedger(snapshot);
  await bot.flushLedger();
  assert.equal(bot.cash, 2900);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.orders.length, 1);
  assert.equal(bot.sizingByAsset.BTC.nextShares, 200);
  assert.equal(bot.sizingByAsset.BTC.recoveryNetPnl, -60);
  assert.equal(bot.sizingByAsset.BTC.recoveryActive, true);
  assert.equal(bot.accountSnapshot().maxDrawdown, 200);
  assert.equal(saved.snapshot.account.cash, 2900);

  const record = bot.records.get('BTC:5m');
  setNow(start + 1000);
  await bot.refreshMarket(record, start + 1000);
  assert.equal(record.triggeredSide, 'UP');
  bot.applyBook(record, 'DOWN', book(0.33, 0.35), start + 1000);
  bot.applyBook(record, 'DOWN', book(0.49, 0.51), start + 2000);
  assert.equal(bot.positions.length, 1, 'a restart must not permit a second entry in the same market');
});

