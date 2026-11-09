'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const CrossPairBot = require('../cross-pair-bot');
const MultiBot = require('../multi-bot');

const WINDOW = config.WINDOW_MS_5M;
const START = 1_800_000_000_000;

function fixture() {
  const resolutionChecks = [];
  const winners = { 'btc-market': 'UP', 'eth-market': 'DOWN' };
  const data = {
    async getBtcMarket(start, windowMs) {
      return {
        id: 'btc-market', asset: 'BTC', slug: `btc-updown-5m-${start / 1000}`,
        title: 'BTC Up or Down', start, end: start + windowMs,
        tokens: { UP: 'btc-up', DOWN: 'btc-down' },
        feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 },
      };
    },
    async getEthMarket(start, windowMs) {
      return {
        id: 'eth-market', asset: 'ETH', slug: `eth-updown-5m-${start / 1000}`,
        title: 'ETH Up or Down', start, end: start + windowMs,
        tokens: { UP: 'eth-up', DOWN: 'eth-down' },
        feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 },
      };
    },
    async getBook() { return { bids: [], asks: [] }; },
    async getMarket(id) {
      resolutionChecks.push(id);
      return { id, closed: true, winner: winners[id] };
    },
    resolvedWinner(market) {
      return market?.closed ? market.winner : null;
    },
  };
  const bot = new CrossPairBot({ marketData: data });
  bot.log = () => {};
  bot.market = {
    id: 'eth-market', asset: 'ETH', slug: 'eth-updown-5m-test',
    title: 'ETH Up or Down', start: START, end: START + WINDOW,
    tokens: { UP: 'eth-up', DOWN: 'eth-down' },
    feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 },
  };
  bot.btcMarket = {
    id: 'btc-market', asset: 'BTC', slug: 'btc-updown-5m-test',
    title: 'BTC Up or Down', start: START, end: START + WINDOW,
    tokens: { UP: 'btc-up', DOWN: 'btc-down' },
    feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 },
  };
  bot.openStrategyWindow(START, START);
  for (const asset of ['BTC', 'ETH']) {
    for (const side of ['UP', 'DOWN']) setQuote(bot, asset, side);
  }
  return { bot, data, resolutionChecks, winners };
}

function setQuote(bot, asset, side, {
  bid = 0.40, bidSize = 1000, ask = 0.50, askSize = 1000,
  at = START + 1000, bidLevels, askLevels,
} = {}) {
  const quotes = asset === 'BTC' ? bot.btcLiveQuotes : bot.liveQuotes;
  const quote = {
    status: 'LIVE',
    bestBid: bid,
    bidSize,
    bestAsk: ask,
    askSize,
    mid: bid == null || ask == null ? null : (bid + ask) / 2,
    bidLevels: bidLevels || (bid == null ? [] : [{ price: bid, size: bidSize }]),
    askLevels: askLevels || (ask == null ? [] : [{ price: ask, size: askSize }]),
    updatedAt: at,
    stale: false,
  };
  quotes[side] = quote;
  return quote;
}

function enterBtcUpEthDown(bot, now = START + 1000, {
  btcAsk = 0.30, ethAsk = 0.49, askSize = 1000,
} = {}) {
  setQuote(bot, 'BTC', 'UP', { ask: btcAsk, askSize, at: now });
  setQuote(bot, 'ETH', 'DOWN', { ask: ethAsk, askSize, at: now });
  return bot.processStrategyEntry(now);
}

function pairState(bot, id = 'btc-up-eth-down') {
  return bot.pairStates[id];
}

test('only the two independent BTC/ETH 5-minute pairings are configured', async () => {
  const { bot } = fixture();
  const multi = new MultiBot();
  assert.deepEqual(Object.keys(multi.bots), ['btc-eth-cross-pair-arbitrage']);
  assert.equal(multi.snapshot().strategy.id, 'btc-eth-cross-pair-arbitrage');
  assert.equal(multi.snapshot().account.capital, 1000);
  assert.deepEqual(CrossPairBot.constants.PAIRS.map(pair => pair.label), [
    'BTC UP + ETH DOWN',
    'ETH UP + BTC DOWN',
  ]);
  assert.deepEqual(bot.snapshot().strategy.entries.tiers.map(tier =>
    [tier.combinedAskThreshold, tier.sharesPerLeg]), [
    [0.8, 100], [0.7, 100], [0.6, 100], [0.5, 100], [0.4, 100],
  ]);
  assert.equal(bot.snapshot().strategy.settlement.intraWindowSells, false);
  assert.equal(bot.snapshot().strategy.exit, undefined);

  const loaded = new CrossPairBot({ marketData: {
    ...require('../wick-market-data'),
    getBtcMarket: async (start, windowMs) => ({ asset: 'BTC', start, windowMs }),
    getEthMarket: async (start, windowMs) => ({ asset: 'ETH', start, windowMs }),
  } });
  loaded.market = await loaded.loadMarket(START, WINDOW);
  assert.equal(loaded.btcMarket.start, loaded.market.start);
});

test('BTC UP + ETH DOWN buys 100 shares on both legs at the $0.80 tier', () => {
  const { bot } = fixture();
  assert.equal(enterBtcUpEthDown(bot), true);
  assert.equal(bot.positions.length, 2);
  const btc = bot.positions.find(position => position.asset === 'BTC');
  const eth = bot.positions.find(position => position.asset === 'ETH');
  assert.equal(btc.side, 'UP');
  assert.equal(eth.side, 'DOWN');
  assert.equal(btc.shares, 100);
  assert.equal(eth.shares, 100);
  assert.equal(btc.pairCycleId, eth.pairCycleId);
  assert.equal(btc.marketId, 'btc-market');
  assert.equal(eth.marketId, 'eth-market');
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 2);
  assert.equal(bot.cash < config.DEMO_CAPITAL, true);
  assert.ok(bot.positions.every(position => position.fees > 0));
  assert.equal(pairState(bot).status, 'HOLDING TO RESOLUTION');
});

test('the reverse pairing is independent and both pairs may enter in the same scan', () => {
  const { bot } = fixture();
  setQuote(bot, 'BTC', 'UP', { ask: 0.30 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49 });
  setQuote(bot, 'ETH', 'UP', { ask: 0.39 });
  setQuote(bot, 'BTC', 'DOWN', { ask: 0.40 });
  assert.equal(bot.processStrategyEntry(START + 1000), true);
  assert.equal(bot.positions.length, 4);
  assert.equal(pairState(bot, 'btc-up-eth-down').status, 'HOLDING TO RESOLUTION');
  assert.equal(pairState(bot, 'eth-up-btc-down').status, 'HOLDING TO RESOLUTION');
  assert.deepEqual(
    bot.positions.filter(position => position.pairId === 'eth-up-btc-down')
      .map(position => `${position.asset} ${position.side}`).sort(),
    ['BTC DOWN', 'ETH UP'],
  );
});

test('the $0.80 boundary is inclusive and an incomplete pair books no shares', () => {
  const boundary = fixture().bot;
  assert.equal(enterBtcUpEthDown(boundary, START + 1000, { btcAsk: 0.40, ethAsk: 0.40 }), true);
  assert.equal(boundary.positions.length, 2);
  assert.equal(pairState(boundary).tiers['tier-080'].status, 'FILLED');

  const shallow = fixture().bot;
  assert.equal(enterBtcUpEthDown(shallow, START + 1000, {
    btcAsk: 0.40, ethAsk: 0.39, askSize: 99,
  }), false);
  assert.equal(shallow.positions.length, 0);
  assert.equal(shallow.orders.length, 0);
  assert.equal(pairState(shallow).tiers['tier-080'].status, 'WAITING_FOR_FULL_FILL');
  assert.match(pairState(shallow).lastReason, /No shares were booked/);

  const qualifies = fixture().bot;
  assert.equal(enterBtcUpEthDown(qualifies, START + 1000, { btcAsk: 0.40, ethAsk: 0.399 }), true);
});

test('entry sweeps asks up to $0.99 and requires full size on both legs', () => {
  const { bot } = fixture();
  const now = START + 1000;
  setQuote(bot, 'BTC', 'UP', {
    ask: 0.40, askLevels: [{ price: 0.40, size: 50 }, { price: 0.99, size: 50 }], at: now,
  });
  setQuote(bot, 'ETH', 'DOWN', {
    ask: 0.39, askLevels: [{ price: 0.39, size: 100 }], at: now,
  });
  assert.equal(bot.processStrategyEntry(now), true);
  const btc = bot.positions.find(position => position.asset === 'BTC');
  assert.equal(btc.shares, 100);
  assert.equal(btc.avgEntry, 0.695);
  assert.equal(btc.maxEntryPrice, 0.99);
  assert.equal(bot.snapshot().strategy.entries.maxPricePerShare, 0.99);

  const blocked = fixture().bot;
  setQuote(blocked, 'BTC', 'UP', {
    ask: 0.40, askLevels: [{ price: 0.40, size: 50 }, { price: 0.991, size: 50 }], at: now,
  });
  setQuote(blocked, 'ETH', 'DOWN', {
    ask: 0.39, askLevels: [{ price: 0.39, size: 100 }], at: now,
  });
  assert.equal(blocked.processStrategyEntry(now), false);
  assert.equal(blocked.positions.length, 0);
  assert.match(pairState(blocked).lastReason, /50\/100/);
});

test('stale or missing quotes cannot trigger a pair entry', () => {
  const { bot } = fixture();
  const now = START + 5000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.40, at: now - 2500 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49, at: now });
  assert.equal(bot.processStrategyEntry(now), false);
  assert.equal(bot.positions.length, 0);
});

test('if either leg lacks full depth, neither leg is booked; bot retries the tier', () => {
  const { bot } = fixture();
  setQuote(bot, 'BTC', 'UP', { ask: 0.40, askSize: 0 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.39, askSize: 100 });
  assert.equal(bot.processStrategyEntry(START + 1000), false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders.length, 0);
  assert.equal(pairState(bot).tiers['tier-080'].status, 'WAITING_FOR_FULL_FILL');
  setQuote(bot, 'BTC', 'UP', { ask: 0.40, askSize: 100, at: START + 2000 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.39, askSize: 100, at: START + 2000 });
  assert.equal(bot.processStrategyEntry(START + 2000), true);
  assert.equal(bot.positions.length, 2);

  const now = START + 5000;
  setQuote(bot, 'BTC', 'UP', { bid: 0.99, ask: 0.99, at: now });
  setQuote(bot, 'ETH', 'DOWN', { bid: 0.99, ask: 0.99, at: now });
  assert.equal(bot.processStrategyEntry(now), false);
  assert.ok(bot.positions.every(position => position.status === 'OPEN'));
  assert.equal(bot.orders.some(order => order.action === 'SELL'), false);
});

test('all qualifying tiers fire once when one tick crosses multiple thresholds without reusing depth', () => {
  const { bot } = fixture();
  const now = START + 1000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.20, askSize: 500, at: now });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.20, askSize: 500, at: now });
  assert.equal(bot.processStrategyEntry(now), true);
  const positions = bot.positions.filter(position => position.pairId === 'btc-up-eth-down');
  assert.equal(positions.length, 10);
  assert.deepEqual(Object.fromEntries(
    positions.filter(position => position.asset === 'BTC')
      .map(position => [position.entryTierId, position.shares]),
  ), {
    'tier-080': 100,
    'tier-070': 100,
    'tier-060': 100,
    'tier-050': 100,
    'tier-040': 100,
  });
  assert.equal(bot.processStrategyEntry(now + 500), false);
  assert.equal(bot.positions.filter(position => position.pairId === 'btc-up-eth-down').length, 10);
  assert.equal(bot.orders.some(order => order.action === 'SELL'), false);
});

test('each rung consumes visible ask depth once across later ticks', () => {
  const { bot } = fixture();
  const first = START + 1000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.35, askSize: 100, at: first });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.45, askSize: 100, at: first });
  assert.equal(bot.processStrategyEntry(first), true);
  assert.deepEqual([...new Set(bot.positions.map(position => position.entryTierId))].sort(),
    ['tier-080']);
  assert.equal(bot.positions.filter(position => position.asset === 'BTC')
    .reduce((sum, position) => sum + position.shares, 0), 100);

  const next = first + 500;
  setQuote(bot, 'BTC', 'UP', { ask: 0.25, askSize: 100, at: next });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.45, askSize: 100, at: next });
  assert.equal(bot.processStrategyEntry(next), false);
  assert.equal(pairState(bot).tiers['tier-070'].status, 'WAITING_FOR_FULL_FILL');
  assert.equal(bot.positions.filter(position => position.asset === 'BTC')
    .reduce((sum, position) => sum + position.shares, 0), 100);

  const replenished = next + 500;
  setQuote(bot, 'BTC', 'UP', { ask: 0.25, askSize: 100, at: replenished });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.45, askSize: 200, at: replenished });
  assert.equal(bot.processStrategyEntry(replenished), true);
  assert.equal(pairState(bot).tiers['tier-070'].status, 'FILLED');
  assert.equal(bot.positions.filter(position => position.asset === 'BTC')
    .reduce((sum, position) => sum + position.shares, 0), 200);
});

test('newly crossed lower tiers fire once even when the price skips over their thresholds', () => {
  const { bot } = fixture();
  const first = START + 1000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.35, askSize: 2000, at: first });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.45, askSize: 2000, at: first });
  assert.equal(bot.processStrategyEntry(first), true);
  assert.deepEqual(
    [...new Set(bot.positions.map(position => position.entryTierId))].sort(),
    ['tier-080'],
  );

  const lower = first + 500;
  setQuote(bot, 'BTC', 'UP', { ask: 0.20, askSize: 2000, at: lower });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.20, askSize: 2000, at: lower });
  assert.equal(bot.processStrategyEntry(lower), true);
  assert.deepEqual(
    [...new Set(bot.positions.map(position => position.entryTierId))].sort(),
    ['tier-040', 'tier-050', 'tier-060', 'tier-070', 'tier-080'],
  );
  assert.equal(bot.positions.filter(position => position.asset === 'BTC')
    .reduce((sum, position) => sum + position.shares, 0), 500);
});

test('a qualified tier stays latched and retries until complete two-leg depth is available', () => {
  const { bot } = fixture();
  const first = START + 1000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.30, askSize: 100, at: first });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49, askSize: 99, at: first });
  assert.equal(bot.processStrategyEntry(first), false);
  assert.equal(pairState(bot).tiers['tier-080'].status, 'WAITING_FOR_FULL_FILL');
  assert.equal(bot.positions.length, 0);

  const later = first + 500;
  setQuote(bot, 'BTC', 'UP', { ask: 0.46, askSize: 100, at: later });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49, askSize: 100, at: later });
  assert.equal(bot.processStrategyEntry(later), true);
  const tierFill = bot.positions.filter(position => position.entryTierId === 'tier-080');
  assert.equal(tierFill.length, 2);
  assert.ok(tierFill.every(position => position.shares === 100));
  assert.equal(tierFill.find(position => position.asset === 'BTC').avgEntry, 0.46);
});

test('unsold BTC and ETH legs resolve against their own exact original markets', async () => {
  const { bot, resolutionChecks } = fixture();
  enterBtcUpEthDown(bot);
  const originalPositions = bot.positions.slice();
  await bot.closePreviousWindows(START + WINDOW, START + WINDOW);
  assert.ok(originalPositions.every(position => position.status === 'PENDING_RESOLUTION'));
  await bot.resolvePendingPositions(START + WINDOW + config.RESOLUTION_POLL_MS);
  assert.deepEqual(resolutionChecks.sort(), ['btc-market', 'eth-market']);
  const btc = originalPositions.find(position => position.asset === 'BTC');
  const eth = originalPositions.find(position => position.asset === 'ETH');
  assert.equal(btc.resolutionWinner, 'UP');
  assert.equal(eth.resolutionWinner, 'DOWN');
  assert.ok(originalPositions.every(position => position.status === 'SETTLED_EXIT'));
  assert.equal(bot.pairCycles[0].status, 'RESOLVED');
});

test('current-window inventory moves into four resolution boxes at window end', async () => {
  const { bot } = fixture();
  const now = START + 1000;
  setQuote(bot, 'BTC', 'UP', { bid: 0.35, ask: 0.40, at: now });
  setQuote(bot, 'ETH', 'DOWN', { bid: 0.35, ask: 0.40, at: now });
  setQuote(bot, 'ETH', 'UP', { bid: 0.35, ask: 0.40, at: now });
  setQuote(bot, 'BTC', 'DOWN', { bid: 0.35, ask: 0.40, at: now });
  assert.equal(bot.processStrategyEntry(now), true);
  assert.equal(bot.positions.length, 4);
  for (const position of bot.positions) {
    position.markBid = 0.50;
    position.markUpdatedAt = Date.now();
  }

  const open = bot.snapshot().positionBuckets.currentWindow;
  for (const [asset, side] of [['BTC', 'UP'], ['BTC', 'DOWN'], ['ETH', 'UP'], ['ETH', 'DOWN']]) {
    assert.equal(open[asset][side].shares, 100);
    assert.equal(open[asset][side].averageEntry, 0.4);
    assert.equal(typeof open[asset][side].unrealizedPnl, 'number');
  }

  await bot.closePreviousWindows(START + WINDOW, START + WINDOW);
  const snapshot = bot.snapshot();
  for (const [asset, side] of [['BTC', 'UP'], ['BTC', 'DOWN'], ['ETH', 'UP'], ['ETH', 'DOWN']]) {
    assert.equal(snapshot.positionBuckets.currentWindow[asset][side].shares, 0);
    assert.equal(snapshot.positionBuckets.awaitingResolution[asset][side].shares, 100);
    assert.equal(snapshot.positionBuckets.awaitingResolution[asset][side].averageEntry, 0.4);
    assert.equal(snapshot.positionBuckets.awaitingResolution[asset][side].unrealizedPnl, null);
  }
});

test('resolution checks are concurrent and retry no sooner than five seconds', async () => {
  const { bot, data, winners } = fixture();
  const entryAt = START + 1000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.40, at: entryAt });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.40, at: entryAt });
  setQuote(bot, 'ETH', 'UP', { ask: 0.40, at: entryAt });
  setQuote(bot, 'BTC', 'DOWN', { ask: 0.40, at: entryAt });
  bot.processStrategyEntry(entryAt);
  await bot.closePreviousWindows(START + WINDOW, START + WINDOW);

  const checks = [];
  const firstResponses = [];
  let active = 0;
  let maxActive = 0;
  data.getMarket = id => {
    checks.push(id);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise(resolve => firstResponses.push(() => {
      active -= 1;
      resolve({ id, closed: false });
    }));
  };

  const firstPollAt = START + WINDOW;
  const firstPoll = bot.resolvePendingPositions(firstPollAt);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(checks.sort(), ['btc-market', 'eth-market']);
  assert.equal(maxActive, 2);
  for (const respond of firstResponses) respond();
  await firstPoll;

  await bot.resolvePendingPositions(firstPollAt + config.RESOLUTION_POLL_MS - 1);
  assert.equal(checks.length, 2);
  data.getMarket = async id => {
    checks.push(id);
    return { id, closed: true, winner: winners[id] };
  };
  await bot.resolvePendingPositions(firstPollAt + config.RESOLUTION_POLL_MS);
  assert.equal(checks.length, 4);
  assert.ok(bot.positions.every(position => position.status === 'SETTLED_EXIT'));
});

test('entry tier constants retain the specified size and price ladder', async () => {
  const { bot } = fixture();
  assert.deepEqual(CrossPairBot.constants.ENTRY_TIERS.map(tier =>
    [tier.id, tier.combinedAskThreshold, tier.sharesPerLeg]), [
    ['tier-080', 0.80, 100],
    ['tier-070', 0.70, 100],
    ['tier-060', 0.60, 100],
    ['tier-050', 0.50, 100],
    ['tier-040', 0.40, 100],
  ]);
  assert.equal(bot.snapshot().strategy.settlement.intraWindowSells, false);
  assert.equal(bot.snapshot().strategy.settlement.resolutionPollIntervalMs, 5000);
});

test('misaligned BTC and ETH markets are rejected rather than paired', async () => {
  const mismatched = new CrossPairBot({ marketData: {
    getBtcMarket: async start => ({ start }),
    getEthMarket: async start => ({ start: start + WINDOW }),
  } });
  await assert.rejects(mismatched.loadMarket(START, WINDOW), /same 5-minute window start/);
});

test('Polymarket market mapping supports aligned BTC and ETH markets', async () => {
  const data = require('../wick-market-data');
  assert.equal(typeof data.getEthMarket, 'function');
  assert.equal(typeof data.getBtcMarket, 'function');
  assert.equal(CrossPairBot.constants.SHARES_PER_LEG, 100);
  assert.equal('EXIT_BID_SUM_MIN' in CrossPairBot.constants, false);
  await assert.rejects(data.getAssetMarket('SOL', START, WINDOW), /Unsupported asset/);
});
