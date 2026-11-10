'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const CrossPairBot = require('../cross-pair-bot');
const MultiBot = require('../multi-bot');

const WINDOW = config.WINDOW_MS_5M;
const START = 1_800_000_000_000;
const PAIRS = {
  'btc-up-eth-down': [{ asset: 'BTC', side: 'UP' }, { asset: 'ETH', side: 'DOWN' }],
  'eth-up-btc-down': [{ asset: 'ETH', side: 'UP' }, { asset: 'BTC', side: 'DOWN' }],
};

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
    resolvedWinner(market) { return market?.closed ? market.winner : null; },
  };
  const bot = new CrossPairBot({ marketData: data });
  bot.log = () => {};
  bot.market = {
    id: 'eth-market', asset: 'ETH', slug: 'eth-updown-5m-test',
    title: 'ETH Up or Down', start: START, end: START + WINDOW,
    tokens: { UP: 'eth-up', DOWN: 'eth-down' },
  };
  bot.btcMarket = {
    id: 'btc-market', asset: 'BTC', slug: 'btc-updown-5m-test',
    title: 'BTC Up or Down', start: START, end: START + WINDOW,
    tokens: { UP: 'btc-up', DOWN: 'btc-down' },
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
  quotes[side] = {
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
}

function setPair(bot, {
  pairId = 'btc-up-eth-down',
  btcAsk = 0.44,
  ethAsk = 0.44,
  at = START + 1000,
  btcAskLevels,
  ethAskLevels,
} = {}) {
  const legs = PAIRS[pairId];
  const asks = { BTC: btcAsk, ETH: ethAsk };
  const levels = { BTC: btcAskLevels, ETH: ethAskLevels };
  for (const leg of legs) {
    setQuote(bot, leg.asset, leg.side, {
      ask: asks[leg.asset],
      askLevels: levels[leg.asset],
      at,
    });
  }
  return bot.processStrategyEntry(at);
}

test('snapshot matches Pumpfun entry tiers and 5-minute aligned markets', () => {
  const { bot } = fixture();
  const snapshot = bot.snapshot();
  const multi = new MultiBot();
  assert.deepEqual(Object.keys(multi.bots), ['btc-eth-cross-pair-arbitrage']);
  assert.equal(snapshot.strategy.timeframe, '5m');
  assert.equal(snapshot.strategy.capital, 3000);
  assert.equal(snapshot.strategy.entries.maxPricePerShare, 0.99);
  assert.deepEqual(snapshot.strategy.entries.tiers.map(tier => tier.id),
    ['0.90', '0.80', '0.70', '0.60', '0.50']);
  assert.deepEqual(CrossPairBot.constants.PAIRS.map(pair => pair.id),
    ['btc-up-eth-down', 'eth-up-btc-down']);
  assert.equal(snapshot.strategy.settlement.intraWindowSells, false);
  assert.match(snapshot.strategy.entries.oppositePairRule, /other rungs remain independent/);
});

test('qualifying a pair/rung buys both 100-share legs as one paired fill', () => {
  const { bot } = fixture();
  assert.equal(setPair(bot), true);
  assert.equal(bot.positions.length, 2);
  assert.deepEqual(bot.positions.map(position => [position.asset, position.side, position.shares])
    .sort(), [['BTC', 'UP', 100], ['ETH', 'DOWN', 100]]);
  assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 2);
  assert.ok(bot.positions.every(position => position.pairCycleId === bot.positions[0].pairCycleId));
  assert.ok(bot.positions.every(position => position.fees > 0));
  assert.equal(bot.pairStates['btc-up-eth-down'].tiers['0.90'].status, 'FILLED');
  assert.equal(bot.pairStates['eth-up-btc-down'].tiers['0.90'].status, 'PAUSED_BY_OPPOSITE');
});

test('combined asks use strict 0.90 and inclusive lower thresholds', () => {
  const { bot } = fixture();
  assert.equal(setPair(bot, { btcAsk: 0.50, ethAsk: 0.40 }), false);
  assert.equal(bot.positions.length, 0);
  assert.equal(setPair(bot, { btcAsk: 0.50, ethAsk: 0.30, at: START + 2000 }), true);
  assert.equal(bot.positions.length, 4);
  assert.deepEqual([...new Set(bot.positions.map(position => position.entryTierId))].sort(),
    ['0.80', '0.90']);
});

test('each pair can fill multiple independent rungs but not repeat a filled rung', () => {
  const { bot } = fixture();
  assert.equal(setPair(bot, { btcAsk: 0.44, ethAsk: 0.44 }), true);
  assert.equal(setPair(bot, { btcAsk: 0.40, ethAsk: 0.40, at: START + 2000 }), true);
  assert.equal(setPair(bot, { btcAsk: 0.40, ethAsk: 0.40, at: START + 3000 }), false);
  assert.equal(setPair(bot, { btcAsk: 0.35, ethAsk: 0.35, at: START + 4000 }), true);
  assert.equal(bot.positions.length, 6);
  assert.deepEqual([...new Set(bot.positions.map(p => p.entryTierId))].sort(),
    ['0.70', '0.80', '0.90']);
});

test('the first pair pauses only its opposite pair on the triggered rung', () => {
  const { bot } = fixture();
  assert.equal(setPair(bot), true);
  assert.equal(setPair(bot, { pairId: 'eth-up-btc-down', at: START + 2000 }), false);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.pairStates['eth-up-btc-down'].tiers['0.90'].status, 'PAUSED_BY_OPPOSITE');
  assert.equal(setPair(bot, {
    pairId: 'eth-up-btc-down', btcAsk: 0.40, ethAsk: 0.40, at: START + 3000,
  }), true);
  assert.equal(bot.positions.length, 4);
  assert.equal(bot.positions[0].entryTierId, '0.80');
  assert.equal(bot.positions[0].pairId, 'eth-up-btc-down');
});

test('both legs need full visible depth; incomplete paired fills book neither leg', () => {
  const { bot } = fixture();
  assert.equal(setPair(bot, {
    btcAskLevels: [{ price: 0.44, size: 50 }],
    ethAskLevels: [{ price: 0.44, size: 100 }],
  }), false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.cash, 3000);
  assert.equal(bot.pairStates['btc-up-eth-down'].tiers['0.90'].status, 'WAITING_FOR_FULL_FILL');
  assert.equal(setPair(bot, {
    at: START + 2000,
    btcAskLevels: [{ price: 0.44, size: 100 }],
    ethAskLevels: [{ price: 0.44, size: 100 }],
  }), true);
  assert.equal(bot.positions.length, 2);
});

test('entries remain allowed through the 5-minute window and stop at its end', () => {
  const { bot } = fixture();
  assert.equal(setPair(bot, { at: START + 4 * 60 * 1000 }), true);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.processStrategyEntry(START + WINDOW), false);
});

test('both legs resolve only against their exact original markets', async () => {
  const { bot, resolutionChecks } = fixture();
  assert.equal(setPair(bot), true);
  const positions = bot.positions.slice();
  await bot.closePreviousWindows(START + WINDOW, START + WINDOW);
  assert.ok(positions.every(position => position.status === 'PENDING_RESOLUTION'));
  await bot.resolvePendingPositions(START + WINDOW + config.RESOLUTION_POLL_MS);
  assert.deepEqual([...resolutionChecks].sort(), ['btc-market', 'eth-market']);
  assert.ok(positions.every(position => position.status === 'SETTLED_EXIT'));
  assert.equal(bot.pairCycles[0].status, 'RESOLVED');
});

test('BTC and ETH market windows must be aligned', async () => {
  const bot = new CrossPairBot({ marketData: {
    getBtcMarket: async start => ({ start }),
    getEthMarket: async start => ({ start: start + WINDOW }),
  } });
  await assert.rejects(bot.loadMarket(START, WINDOW), /same 5-minute window start/);
});
