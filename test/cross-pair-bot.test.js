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
    resolvedWinner(market) { return market?.closed ? market.winner : null; },
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

function setRoute(bot, {
  leaderAsset = 'BTC',
  leaderSide = 'UP',
  leaderAsk = 0.60,
  targetAsset = 'ETH',
  targetSide = 'UP',
  targetAsk = 0.49,
  at = START + 1000,
  targetAskLevels,
} = {}) {
  setQuote(bot, leaderAsset, leaderSide, { ask: leaderAsk, at });
  setQuote(bot, targetAsset, targetSide, {
    ask: targetAsk,
    askLevels: targetAskLevels,
    at,
  });
  return bot.processStrategyEntry(at);
}

function routeState(bot, id = 'btc-up-leads-eth-up') {
  return bot.pairStates[id];
}

test('strategy snapshot exposes the four same-side tiers and 270-second cutoff', () => {
  const { bot } = fixture();
  const multi = new MultiBot();
  const snapshot = bot.snapshot();
  assert.deepEqual(Object.keys(multi.bots), ['btc-eth-cross-pair-arbitrage']);
  assert.equal(multi.snapshot().account.capital, 3000);
  assert.equal(CrossPairBot.constants.ENTRY_CUTOFF_MS, 270_000);
  assert.equal(snapshot.strategy.entries.entryCutoffMs, 270_000);
  assert.equal(snapshot.strategy.entries.minTargetPrice, 0.20);
  assert.deepEqual(snapshot.strategy.entries.tiers.map(tier => [
    tier.leaderMinPrice, tier.targetMaxPriceExclusive, tier.sharesPerFire,
  ]), [
    [0.60, 0.50, 100],
    [0.70, 0.60, 100],
    [0.80, 0.70, 100],
    [0.90, 0.80, 100],
  ]);
  assert.deepEqual(CrossPairBot.constants.PAIRS.map(route =>
    [route.leaderAsset, route.leaderSide, route.targetAsset, route.targetSide]), [
    ['BTC', 'UP', 'ETH', 'UP'],
    ['ETH', 'UP', 'BTC', 'UP'],
    ['BTC', 'DOWN', 'ETH', 'DOWN'],
    ['ETH', 'DOWN', 'BTC', 'DOWN'],
  ]);
  assert.equal(snapshot.strategy.settlement.intraWindowSells, false);
  assert.equal(snapshot.strategy.settlement.resolutionPollIntervalMs, 5000);
});

test('each route buys 100 target shares in the same direction, never both legs', () => {
  const cases = [
    {
      routeId: 'btc-up-leads-eth-up',
      leaderAsset: 'BTC', leaderSide: 'UP', leaderAsk: 0.60,
      targetAsset: 'ETH', targetSide: 'UP', targetAsk: 0.49,
      tierId: 'tier-060-050',
    },
    {
      routeId: 'eth-up-leads-btc-up',
      leaderAsset: 'ETH', leaderSide: 'UP', leaderAsk: 0.70,
      targetAsset: 'BTC', targetSide: 'UP', targetAsk: 0.59,
      tierId: 'tier-070-060',
    },
    {
      routeId: 'btc-down-leads-eth-down',
      leaderAsset: 'BTC', leaderSide: 'DOWN', leaderAsk: 0.80,
      targetAsset: 'ETH', targetSide: 'DOWN', targetAsk: 0.69,
      tierId: 'tier-080-070',
    },
    {
      routeId: 'eth-down-leads-btc-down',
      leaderAsset: 'ETH', leaderSide: 'DOWN', leaderAsk: 0.90,
      targetAsset: 'BTC', targetSide: 'DOWN', targetAsk: 0.79,
      tierId: 'tier-090-080',
    },
  ];

  for (const scenario of cases) {
    const { bot } = fixture();
    assert.equal(setRoute(bot, scenario), true, scenario.routeId);
    assert.equal(bot.positions.length, 1, scenario.routeId);
    const [position] = bot.positions;
    assert.equal(position.asset, scenario.targetAsset);
    assert.equal(position.side, scenario.targetSide);
    assert.equal(position.shares, 100);
    assert.equal(position.entryTierId, scenario.tierId);
    assert.equal(position.leaderAsset, scenario.leaderAsset);
    assert.equal(position.leaderSide, scenario.leaderSide);
    assert.equal(position.leaderPriceAtEntry, scenario.leaderAsk);
    assert.equal(position.targetPriceAtEntry, scenario.targetAsk);
    assert.equal(bot.orders.filter(order => order.action === 'BUY').length, 1);
    assert.ok(position.fees > 0);
  }
});

test('leader threshold is inclusive, target ceiling is exclusive, and $0.20 floor is inclusive', () => {
  const { bot } = fixture();
  assert.equal(setRoute(bot, { leaderAsk: 0.599, targetAsk: 0.20 }), false);
  assert.equal(setRoute(bot, { leaderAsk: 0.60, targetAsk: 0.50 }), false);
  assert.equal(setRoute(bot, { leaderAsk: 0.60, targetAsk: 0.199 }), false);
  assert.equal(setRoute(bot, { leaderAsk: 0.60, targetAsk: 0.20 }), true);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].avgEntry, 0.20);
});

test('separate tiers can fire in one route, but a filled tier cannot fire twice in a window', () => {
  const { bot } = fixture();
  assert.equal(setRoute(bot, { leaderAsk: 0.60, targetAsk: 0.49 }), true);
  assert.equal(setRoute(bot, {
    leaderAsk: 0.70, targetAsk: 0.59, at: START + 2000,
  }), true);
  assert.equal(setRoute(bot, {
    leaderAsk: 0.70, targetAsk: 0.59, at: START + 2500,
  }), false);
  assert.equal(bot.positions.length, 2);
  assert.deepEqual(bot.positions.map(position => position.entryTierId), [
    'tier-070-060', 'tier-060-050',
  ]);
  assert.ok(bot.positions.every(position => position.shares === 100));
});

test('a tier requires full visible target depth strictly below its ceiling and retries safely', () => {
  const { bot } = fixture();
  assert.equal(setRoute(bot, {
    leaderAsk: 0.60,
    targetAsk: 0.49,
    targetAskLevels: [
      { price: 0.49, size: 40 },
      { price: 0.50, size: 100 },
    ],
  }), false);
  assert.equal(bot.positions.length, 0);
  assert.equal(routeState(bot).tiers['tier-060-050'].status, 'WAITING_FOR_FULL_FILL');

  assert.equal(setRoute(bot, {
    leaderAsk: 0.60,
    targetAsk: 0.49,
    at: START + 2000,
    targetAskLevels: [{ price: 0.49, size: 100 }],
  }), true);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].avgEntry, 0.49);
  assert.ok(bot.positions[0].maxEntryPrice < 0.50);
});

test('no new orders are opened at or after the 270-second cutoff', () => {
  const { bot } = fixture();
  const cutoff = START + 270_000;
  assert.equal(setRoute(bot, {
    leaderAsk: 0.60,
    targetAsk: 0.49,
    at: cutoff,
  }), false);
  assert.equal(bot.positions.length, 0);
  assert.equal(routeState(bot).tiers['tier-060-050'].status, 'CUTOFF_REACHED');
  assert.equal(bot.snapshot().strategy.entries.entryCutoffMs, 270_000);
});

test('a filled position has no intra-window exit and resolves against its exact market', async () => {
  const { bot, resolutionChecks } = fixture();
  assert.equal(setRoute(bot, {
    leaderAsset: 'BTC',
    leaderSide: 'UP',
    leaderAsk: 0.60,
    targetAsset: 'ETH',
    targetSide: 'UP',
    targetAsk: 0.49,
  }), true);
  const [position] = bot.positions;
  assert.equal(position.status, 'OPEN');
  assert.equal(position.exitOrder, undefined);
  await bot.closePreviousWindows(START + WINDOW, START + WINDOW);
  assert.equal(position.status, 'PENDING_RESOLUTION');
  await bot.resolvePendingPositions(START + WINDOW + config.RESOLUTION_POLL_MS);
  assert.deepEqual(resolutionChecks, ['eth-market']);
  assert.equal(position.resolutionWinner, 'DOWN');
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(bot.pairCycles[0].status, 'RESOLVED');
});

test('misaligned BTC and ETH markets are rejected', async () => {
  const bot = new CrossPairBot({ marketData: {
    getBtcMarket: async start => ({ start }),
    getEthMarket: async start => ({ start: start + WINDOW }),
  } });
  await assert.rejects(bot.loadMarket(START, WINDOW), /same 5-minute window start/);
});

test('a triggered rung pauses the opposite direction on that rung only', () => {
  const { bot } = fixture();
  assert.equal(setRoute(bot, { leaderAsk: 0.60, targetAsk: 0.49 }), true);
  assert.equal(setRoute(bot, {
    leaderSide: 'DOWN', targetSide: 'DOWN', leaderAsk: 0.60, targetAsk: 0.49, at: START + 2000,
  }), false);
  assert.equal(bot.positions.length, 1);
  const down = bot.pairStates['btc-down-leads-eth-down'].tiers['tier-060-050'];
  assert.equal(down.status, 'PAUSED_BY_OPPOSITE');
  // A different rung is still independent.
  assert.equal(setRoute(bot, {
    leaderSide: 'DOWN', targetSide: 'DOWN', leaderAsk: 0.70, targetAsk: 0.59, at: START + 3000,
  }), true);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.positions[0].entryTierId, 'tier-070-060');
});
