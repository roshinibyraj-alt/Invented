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
  assert.equal(bot.snapshot().strategy.entries.sharesPerLeg, 200);
  assert.equal(bot.snapshot().strategy.exit.combinedBestBidMinimum, 1.1);

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
  assert.equal(pairState(bot).status, 'IN_POSITION');
});

test('the reverse pairing is independent and both pairs may enter in the same scan', () => {
  const { bot } = fixture();
  setQuote(bot, 'BTC', 'UP', { ask: 0.40 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49 });
  setQuote(bot, 'ETH', 'UP', { ask: 0.39 });
  setQuote(bot, 'BTC', 'DOWN', { ask: 0.49 });
  assert.equal(bot.processStrategyEntry(START + 1000), true);
  assert.equal(bot.positions.length, 4);
  assert.equal(pairState(bot, 'btc-up-eth-down').status, 'IN_POSITION');
  assert.equal(pairState(bot, 'eth-up-btc-down').status, 'IN_POSITION');
  assert.deepEqual(
    bot.positions.filter(position => position.pairId === 'eth-up-btc-down')
      .map(position => `${position.asset} ${position.side}`).sort(),
    ['BTC DOWN', 'ETH UP'],
  );
});

test('entry boundary is strict and paired taker entries only book visible ask depth', () => {
  const boundary = fixture().bot;
  assert.equal(enterBtcUpEthDown(boundary, START + 1000, { btcAsk: 0.40, ethAsk: 0.50 }), false);
  assert.equal(boundary.positions.length, 0);

  const shallow = fixture().bot;
  assert.equal(enterBtcUpEthDown(shallow, START + 1000, {
    btcAsk: 0.40, ethAsk: 0.49, askSize: 199,
  }), true);
  assert.equal(shallow.positions.length, 2);
  assert.ok(shallow.positions.every(position => position.shares === 199));
  assert.ok(shallow.orders.filter(order => order.action === 'BUY')
    .every(order => order.status === 'PARTIALLY_FILLED_REMAINDER_CANCELLED'));

  const qualifies = fixture().bot;
  assert.equal(enterBtcUpEthDown(qualifies, START + 1000, { btcAsk: 0.40, ethAsk: 0.499 }), true);
});

test('stale or missing quotes cannot trigger a pair entry', () => {
  const { bot } = fixture();
  const now = START + 5000;
  setQuote(bot, 'BTC', 'UP', { ask: 0.40, at: now - 2500 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49, at: now });
  assert.equal(bot.processStrategyEntry(now), false);
  assert.equal(bot.positions.length, 0);
});

test('one leg may partially fill, and only actually filled shares are exited', () => {
  const { bot } = fixture();
  setQuote(bot, 'BTC', 'UP', { ask: 0.40, askSize: 0 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.49, askSize: 200 });
  assert.equal(bot.processStrategyEntry(START + 1000), true);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].asset, 'ETH');
  assert.equal(bot.positions[0].shares, 200);
  assert.equal(bot.orders.find(order => order.asset === 'BTC' && order.action === 'BUY')
    .status, 'REJECTED_NO_VISIBLE_ASK_DEPTH');

  const now = START + 5000;
  setQuote(bot, 'BTC', 'UP', { bid: 0.56, ask: 0.60, at: now });
  setQuote(bot, 'ETH', 'DOWN', { bid: 0.54, ask: 0.60, bidSize: 200, at: now });
  assert.equal(bot.processStrategyEntry(now), true);
  assert.equal(bot.positions[0].status, 'SETTLED_EXIT');
  assert.equal(pairState(bot).activeCycle, null);
});

test('the exit uses combined best bids, not asks, and sells at visible bid depth', () => {
  const { bot } = fixture();
  enterBtcUpEthDown(bot);
  const entryCash = bot.cash;
  const now = START + 5000;
  setQuote(bot, 'BTC', 'UP', {
    bid: 0.56, ask: 0.60, bidSize: 200, at: now,
  });
  setQuote(bot, 'ETH', 'DOWN', {
    bid: 0.54, ask: 0.60, bidSize: 200, at: now,
  });
  assert.equal(bot.processStrategyEntry(now), true);
  const positions = bot.positions.filter(position => position.pairId === 'btc-up-eth-down');
  assert.ok(positions.every(position => position.status === 'SETTLED_EXIT'));
  assert.ok(positions.every(position => position.exitPrice > 0));
  assert.ok(positions.every(position => position.exitFees > 0));
  assert.equal(bot.orders.filter(order => order.kind === 'PAIR_EXIT').length, 2);
  assert.equal(pairState(bot).activeCycle, null);
  assert.equal(pairState(bot).status, 'ARMED');
  assert.ok(bot.cash > entryCash);
});

test('an ask sum of $1.10 does not exit unless combined bids reach $1.10', () => {
  const { bot } = fixture();
  enterBtcUpEthDown(bot);
  const now = START + 5000;
  setQuote(bot, 'BTC', 'UP', { bid: 0.55, ask: 0.60, at: now });
  setQuote(bot, 'ETH', 'DOWN', { bid: 0.54, ask: 0.60, at: now });
  assert.equal(bot.processStrategyEntry(now), false);
  assert.ok(bot.positions.every(position => position.status === 'OPEN'));
  assert.equal(pairState(bot).activeCycle.exitTriggeredAt, null);
});

test('partial pair exits never reuse unchanged bid depth and rearm after both legs sell', () => {
  const { bot } = fixture();
  enterBtcUpEthDown(bot);
  const triggerAt = START + 5000;
  setQuote(bot, 'BTC', 'UP', {
    bid: 0.56, ask: 0.60, bidSize: 100, at: triggerAt,
  });
  setQuote(bot, 'ETH', 'DOWN', {
    bid: 0.54, ask: 0.60, bidSize: 100, at: triggerAt,
  });
  assert.equal(bot.processStrategyEntry(triggerAt), true);
  let positions = bot.positions.filter(position => position.pairId === 'btc-up-eth-down');
  assert.deepEqual(positions.map(position => position.shares), [100, 100]);

  assert.equal(bot.processStrategyEntry(triggerAt + 500), false);
  assert.deepEqual(positions.map(position => position.shares), [100, 100]);

  setQuote(bot, 'BTC', 'UP', {
    bid: 0.56, ask: 0.60, bidSize: 200, at: triggerAt + 1000,
  });
  setQuote(bot, 'ETH', 'DOWN', {
    bid: 0.54, ask: 0.60, bidSize: 200, at: triggerAt + 1000,
  });
  assert.equal(bot.processStrategyEntry(triggerAt + 1000), true);
  assert.equal(pairState(bot).activeCycle, null);
  assert.equal(pairState(bot).status, 'ARMED');

  setQuote(bot, 'BTC', 'UP', { ask: 0.40, at: triggerAt + 1500 });
  setQuote(bot, 'ETH', 'DOWN', { ask: 0.45, at: triggerAt + 1500 });
  assert.equal(bot.processStrategyEntry(triggerAt + 1500), true);
  assert.equal(pairState(bot).cycleCount, 2);
  positions = bot.positions.filter(position => position.pairCycleNumber === 2);
  assert.equal(positions.length, 2);
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
});

test('a partial pair exit is included in final exact-market resolution accounting', async () => {
  const { bot } = fixture();
  enterBtcUpEthDown(bot);
  const btc = bot.positions.find(position => position.asset === 'BTC');
  const now = START + 5000;
  setQuote(bot, 'BTC', 'UP', { bid: 0.56, ask: 0.60, bidSize: 50, at: now });
  setQuote(bot, 'ETH', 'DOWN', { bid: 0.54, ask: 0.60, bidSize: 0, at: now });
  assert.equal(bot.processStrategyEntry(now), true);
  assert.equal(btc.shares, 150);
  assert.equal(btc.exitProceeds, 28);
  const priorExitFees = btc.exitFees;
  assert.ok(priorExitFees > 0);

  await bot.closePreviousWindows(START + WINDOW, START + WINDOW);
  await bot.resolvePendingPositions(START + WINDOW + config.RESOLUTION_POLL_MS);
  assert.equal(btc.status, 'SETTLED_EXIT');
  assert.equal(btc.exitFees, priorExitFees);
  assert.equal(btc.resolutionProceeds, 150);
  assert.equal(btc.proceeds, 178);
  assert.equal(btc.realizedPnl,
    btc.proceeds - btc.initialTotalCost - btc.initialFees - priorExitFees);
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
  assert.equal(CrossPairBot.constants.EXIT_BID_SUM_MIN, 1.10);
  await assert.rejects(data.getAssetMarket('SOL', START, WINDOW), /Unsupported asset/);
});
