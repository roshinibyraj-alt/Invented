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
  btcAsk = 0.40, ethAsk = 0.49, askSize = 1000,
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
  assert.equal(multi.snapshot().account.capital, 10000);
  assert.deepEqual(CrossPairBot.constants.PAIRS.map(pair => pair.label), [
    'BTC UP + ETH DOWN',
    'ETH UP + BTC DOWN',
  ]);
  assert.deepEqual(bot.snapshot().strategy.entries.tiers.map(tier =>
    [tier.combinedAskThreshold, tier.sharesPerLeg]), [
    [0.9, 200], [0.8, 300], [0.7, 300], [0.6, 300], [0.5, 300],
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

test('BTC UP + ETH DOWN buys 200 shares on both legs when combined asks are below $0.90', () => {
  const { bot } = fixture();
  assert.equal(enterBtcUpEthDown(bot), true);
  assert.equal(bot.positions.length, 2);
  const btc = bot.positions.find(position => position.asset === 'BTC');
  const eth = bot.positions.find(position => position.asset === 'ETH');
  assert.equal(btc.side, 'UP');
  assert.equal(eth.side, 'DOWN');
  assert.equal(btc.shares, 200);
  assert.equal(eth.shares, 200);
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
  setQuote(bot, 'BTC', 'UP', { ask: 0.40 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49 });
  setQuote(bot, 'ETH', 'UP', { ask: 0.39 });
  setQuote(bot, 'BTC', 'DOWN', { ask: 0.49 });
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

test('entry boundary is strict and an incomplete pair books no shares', () => {
  const boundary = fixture().bot;
  assert.equal(enterBtcUpEthDown(boundary, START + 1000, { btcAsk: 0.40, ethAsk: 0.50 }), false);
  assert.equal(boundary.positions.length, 0);

  const shallow = fixture().bot;
  assert.equal(enterBtcUpEthDown(shallow, START + 1000, {
    btcAsk: 0.40, ethAsk: 0.49, askSize: 199,
  }), false);
  assert.equal(shallow.positions.length, 0);
  assert.equal(shallow.orders.length, 0);
  assert.equal(pairState(shallow).tiers['base-090'].status, 'WAITING_FOR_FULL_FILL');
  assert.match(pairState(shallow).lastReason, /No shares were booked/);

  const qualifies = fixture().bot;
  assert.equal(enterBtcUpEthDown(qualifies, START + 1000, { btcAsk: 0.40, ethAsk: 0.499 }), true);
});

test('entry sweeps asks up to $0.99 and requires full size on both legs', () => {
  const { bot } = fixture();
  const now = START + 1000;
  setQuote(bot, 'BTC', 'UP', {
    ask: 0.40, askLevels: [{ price: 0.40, size: 100 }, { price: 0.99, size: 100 }], at: now,
  });
  setQuote(bot, 'ETH', 'DOWN', {
    ask: 0.49, askLevels: [{ price: 0.49, size: 200 }], at: now,
  });
  assert.equal(bot.processStrategyEntry(now), true);
  const btc = bot.positions.find(position => position.asset === 'BTC');
  assert.equal(btc.shares, 200);
  assert.equal(btc.avgEntry, 0.695);
  assert.equal(btc.maxEntryPrice, 0.99);
  assert.equal(bot.snapshot().strategy.entries.maxPricePerShare, 0.99);

  const blocked = fixture().bot;
  setQuote(blocked, 'BTC', 'UP', {
    ask: 0.40, askLevels: [{ price: 0.40, size: 100 }, { price: 0.991, size: 100 }], at: now,
  });
  setQuote(blocked, 'ETH', 'DOWN', {
    ask: 0.49, askLevels: [{ price: 0.49, size: 200 }], at: now,
  });
  assert.equal(blocked.processStrategyEntry(now), false);
  assert.equal(blocked.positions.length, 0);
  assert.match(pairState(blocked).lastReason, /100\/200/);
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
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49, askSize: 200 });
  assert.equal(bot.processStrategyEntry(START + 1000), false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders.length, 0);
  assert.equal(pairState(bot).tiers['base-090'].status, 'WAITING_FOR_FULL_FILL');
  setQuote(bot, 'BTC', 'UP', { ask: 0.40, askSize: 200, at: START + 2000 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49, askSize: 200, at: START + 2000 });
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
  setQuote(bot, 'BTC', 'UP', { ask: 0.20, askSize: 1400, at: now });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.20, askSize: 1400, at: now });
  assert.equal(bot.processStrategyEntry(now), true);
  const positions = bot.positions.filter(position => position.pairId === 'btc-up-eth-down');
  assert.equal(positions.length, 10);
  assert.deepEqual(Object.fromEntries(
    positions.filter(position => position.asset === 'BTC')
      .map(position => [position.entryTierId, position.shares]),
  ), {
    'base-090': 200,
    'add-080': 300,
    'add-070': 300,
    'add-060': 300,
    'add-050': 300,
  });
  assert.equal(bot.processStrategyEntry(now + 500), false);
  assert.equal(bot.positions.filter(position => position.pairId === 'btc-up-eth-down').length, 10);
  assert.equal(bot.orders.some(order => order.action === 'SELL'), false);
});

test('each rung consumes visible ask depth once across later ticks', () => {
  const { bot } = fixture();
  const first = START + 1000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.35, askSize: 500, at: first });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.40, askSize: 500, at: first });
  assert.equal(bot.processStrategyEntry(first), true);
  assert.deepEqual([...new Set(bot.positions.map(position => position.entryTierId))].sort(),
    ['add-080', 'base-090']);
  assert.equal(bot.positions.filter(position => position.asset === 'BTC')
    .reduce((sum, position) => sum + position.shares, 0), 500);

  const next = first + 500;
  setQuote(bot, 'BTC', 'UP', { ask: 0.30, askSize: 500, at: next });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.40, askSize: 500, at: next });
  assert.equal(bot.processStrategyEntry(next), false);
  assert.equal(pairState(bot).tiers['add-070'].status, 'WAITING_FOR_FULL_FILL');
  assert.equal(bot.positions.filter(position => position.asset === 'BTC')
    .reduce((sum, position) => sum + position.shares, 0), 500);

  const replenished = next + 500;
  setQuote(bot, 'BTC', 'UP', { ask: 0.30, askSize: 500, at: replenished });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.40, askSize: 800, at: replenished });
  assert.equal(bot.processStrategyEntry(replenished), true);
  assert.equal(pairState(bot).tiers['add-070'].status, 'FILLED');
  assert.equal(bot.positions.filter(position => position.asset === 'BTC')
    .reduce((sum, position) => sum + position.shares, 0), 800);
});

test('newly crossed lower tiers fire once even when the price skips over their thresholds', () => {
  const { bot } = fixture();
  const first = START + 1000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.35, askSize: 2000, at: first });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.40, askSize: 2000, at: first });
  assert.equal(bot.processStrategyEntry(first), true);
  assert.deepEqual(
    [...new Set(bot.positions.map(position => position.entryTierId))].sort(),
    ['add-080', 'base-090'],
  );

  const lower = first + 500;
  setQuote(bot, 'BTC', 'UP', { ask: 0.20, askSize: 2000, at: lower });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.25, askSize: 2000, at: lower });
  assert.equal(bot.processStrategyEntry(lower), true);
  assert.deepEqual(
    [...new Set(bot.positions.map(position => position.entryTierId))].sort(),
    ['add-050', 'add-060', 'add-070', 'add-080', 'base-090'],
  );
  assert.equal(bot.positions.filter(position => position.asset === 'BTC')
    .reduce((sum, position) => sum + position.shares, 0), 1400);
});

test('a qualified tier stays latched and retries until complete two-leg depth is available', () => {
  const { bot } = fixture();
  const first = START + 1000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.30, askSize: 500, at: first });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49, askSize: 200, at: first });
  assert.equal(bot.processStrategyEntry(first), true);
  assert.equal(pairState(bot).tiers['base-090'].status, 'FILLED');
  assert.equal(pairState(bot).tiers['add-080'].status, 'WAITING_FOR_FULL_FILL');
  assert.equal(bot.positions.length, 2);

  const later = first + 500;
  setQuote(bot, 'BTC', 'UP', { ask: 0.46, askSize: 300, at: later });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49, askSize: 500, at: later });
  assert.equal(bot.processStrategyEntry(later), true);
  const addOn = bot.positions.filter(position => position.entryTierId === 'add-080');
  assert.equal(addOn.length, 2);
  assert.ok(addOn.every(position => position.shares === 300));
  assert.equal(addOn.find(position => position.asset === 'BTC').avgEntry, 0.46);
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

test('entry tier constants retain the specified size and price ladder', async () => {
  const { bot } = fixture();
  assert.deepEqual(CrossPairBot.constants.ENTRY_TIERS.map(tier =>
    [tier.id, tier.combinedAskThreshold, tier.sharesPerLeg]), [
    ['base-090', 0.90, 200],
    ['add-080', 0.80, 300],
    ['add-070', 0.70, 300],
    ['add-060', 0.60, 300],
    ['add-050', 0.50, 300],
  ]);
  assert.equal(bot.snapshot().strategy.settlement.intraWindowSells, false);
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
  assert.equal(CrossPairBot.constants.SHARES_PER_LEG, 200);
  assert.equal(CrossPairBot.constants.ENTRY_ASK_SUM_MAX, 0.90);
  assert.equal('EXIT_BID_SUM_MIN' in CrossPairBot.constants, false);
  await assert.rejects(data.getAssetMarket('SOL', START, WINDOW), /Unsupported asset/);
});
