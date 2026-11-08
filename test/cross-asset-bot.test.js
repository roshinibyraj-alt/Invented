'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const CrossAssetBot = require('../cross-asset-bot');
const MultiBot = require('../multi-bot');

const WINDOW = config.WINDOW_MS_5M;
const START = 1_800_000_000_000;

function fixture() {
  const requestedMarkets = [];
  const data = {
    async getBtcMarket(start, windowMs) {
      requestedMarkets.push({ asset: 'BTC', start, windowMs });
      return {
        id: 'btc-market',
        asset: 'BTC',
        slug: `btc-updown-5m-${start / 1000}`,
        title: 'BTC Up or Down',
        start,
        end: start + windowMs,
        tokens: { UP: 'btc-up', DOWN: 'btc-down' },
      };
    },
    async getEthMarket(start, windowMs) {
      requestedMarkets.push({ asset: 'ETH', start, windowMs });
      return {
        id: 'eth-market',
        asset: 'ETH',
        slug: `eth-updown-5m-${start / 1000}`,
        title: 'ETH Up or Down',
        start,
        end: start + windowMs,
        tokens: { UP: 'eth-up', DOWN: 'eth-down' },
        feesEnabled: true,
        feeSchedule: { rate: 0.07, exponent: 1 },
      };
    },
    async getBook(tokenId) {
      return tokenId.startsWith('btc')
        ? { bids: [{ price: 0.8, size: 100 }], asks: [{ price: 0.81, size: 100 }] }
        : { bids: [{ price: 0.3, size: 100 }], asks: [{ price: 0.5, size: 100 }] };
    },
    async getMarket(id) {
      requestedMarkets.push({ resolutionId: id });
      return { id, closed: true, outcomes: ['Up', 'Down'], outcomePrices: ['1', '0'] };
    },
    resolvedWinner(market) {
      return market?.closed ? 'UP' : null;
    },
  };
  const bot = new CrossAssetBot({ marketData: data });
  bot.log = () => {};
  bot.market = {
    id: 'eth-market', asset: 'ETH', slug: 'eth-updown-5m-test',
    title: 'ETH Up or Down', start: START, end: START + WINDOW,
    tokens: { UP: 'eth-up', DOWN: 'eth-down' },
    feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 },
  };
  bot.btcMarket = {
    id: 'btc-market', asset: 'BTC', slug: 'btc-updown-5m-test',
    start: START, end: START + WINDOW, tokens: { UP: 'btc-up', DOWN: 'btc-down' },
  };
  bot.openStrategyWindow(START, START);
  return { bot, data, requestedMarkets };
}

function setQuote(bot, asset, side, {
  bid = 0.3, bidSize = 1000, ask = 0.5, askSize = 1000, at = START + 1000,
  bidLevels, askLevels,
} = {}) {
  const quotes = asset === 'BTC' ? bot.btcLiveQuotes : bot.liveQuotes;
  quotes[side] = {
    status: 'LIVE', bestBid: bid, bidSize, bestAsk: ask, askSize,
    mid: (bid + ask) / 2,
    bidLevels: bidLevels || [{ price: bid, size: bidSize }],
    askLevels: askLevels || [{ price: ask, size: askSize }],
    updatedAt: at, stale: false,
  };
}

function qualify(bot, side = 'UP', at = START + 1000, {
  btcAsk = 0.81, ethAsk = 0.5, ethAskSize = 1000, ethAskLevels,
} = {}) {
  setQuote(bot, 'BTC', side, { ask: btcAsk, at });
  setQuote(bot, 'ETH', side, { ask: ethAsk, askSize: ethAskSize, askLevels: ethAskLevels, at });
  return bot.processStrategyEntry(at);
}

test('only the cross-asset ETH strategy is active and both markets share the 5-minute start', async () => {
  const { bot, requestedMarkets } = fixture();
  const multi = new MultiBot();
  assert.deepEqual(Object.keys(multi.bots), ['eth-5m-btc-confirmed']);
  assert.equal(multi.snapshot().strategy.id, 'eth-5m-btc-confirmed');
  assert.equal(multi.snapshot().account.capital, 10000);
  assert.equal(bot.snapshot().strategy.entries.orderType, 'MARKET');
  assert.equal(bot.snapshot().strategy.exit.takeProfit.creditedPricePerShare, 1);
  assert.equal(bot.snapshot().strategy.timeframe, '5m');

  const loaded = new CrossAssetBot({ marketData: {
    ...require('../wick-market-data'),
    getBtcMarket: async (start, windowMs) => ({ asset: 'BTC', start, windowMs }),
    getEthMarket: async (start, windowMs) => ({ asset: 'ETH', start, windowMs }),
  } });
  loaded.market = await loaded.loadMarket(START, WINDOW);
  assert.equal(loaded.btcMarket.start, loaded.market.start);
  assert.deepEqual(requestedMarkets, []);
});

test('BTC UP confirms an ETH UP taker entry and BTC DOWN confirms ETH DOWN', () => {
  const up = fixture().bot;
  assert.equal(qualify(up, 'UP'), true);
  assert.equal(up.positions[0].side, 'UP');
  assert.equal(up.positions[0].asset, 'ETH');
  assert.equal(up.positions[0].signalSide, 'UP');

  const down = fixture().bot;
  assert.equal(qualify(down, 'DOWN'), true);
  assert.equal(down.positions[0].side, 'DOWN');
  assert.equal(down.positions[0].signalSide, 'DOWN');
});

test('BTC threshold is inclusive at $0.80, while ETH must be strictly below $0.60', () => {
  const atBtcBoundary = fixture().bot;
  assert.equal(qualify(atBtcBoundary, 'UP', START + 1000, { btcAsk: 0.8, ethAsk: 0.599 }), true);

  const belowBtcBoundary = fixture().bot;
  assert.equal(qualify(belowBtcBoundary, 'UP', START + 1000, { btcAsk: 0.799, ethAsk: 0.5 }), false);
  assert.equal(belowBtcBoundary.positions.length, 0);

  const atEthBoundary = fixture().bot;
  assert.equal(qualify(atEthBoundary, 'UP', START + 1000, { btcAsk: 0.9, ethAsk: 0.6 }), false);
  assert.equal(atEthBoundary.positions.length, 0);
});

test('entry is allowed through second 179 but blocked exactly at second 180', () => {
  const lastAllowed = fixture().bot;
  assert.equal(qualify(lastAllowed, 'UP', START + 179999), true);

  const cutoff = fixture().bot;
  setQuote(cutoff, 'BTC', 'UP', { ask: 0.9, at: START + 180000 });
  setQuote(cutoff, 'ETH', 'UP', { ask: 0.5, at: START + 180000 });
  assert.equal(cutoff.processStrategyEntry(START + 180000), false);
  assert.equal(cutoff.positions.length, 0);
  assert.equal(CrossAssetBot.constants.ENTRY_CUTOFF_MS, 180000);
});

test('taker market buy sweeps visible ETH asks, charges fees, and cancels unfilled remainder', () => {
  const { bot } = fixture();
  qualify(bot, 'UP', START + 1000, {
    ethAsk: 0.45,
    ethAskSize: 100,
    ethAskLevels: [{ price: 0.45, size: 40 }, { price: 0.5, size: 60 }],
  });
  const position = bot.positions[0];
  const order = bot.orders[0];
  assert.equal(order.orderType, 'MARKET');
  assert.equal(order.status, 'FILLED');
  assert.equal(order.filledShares, 100);
  assert.equal(position.shares, 100);
  assert.equal(position.totalCost, 48);
  assert.ok(position.fees > 0);
  assert.equal(position.avgEntry, 0.48);
  assert.equal(position.takeProfitOrder.limitPrice, 0.99);
  assert.equal(position.takeProfitOrder.creditedPrice, 1);

  const partial = fixture().bot;
  qualify(partial, 'UP', START + 1000, {
    ethAsk: 0.5, ethAskSize: 20, ethAskLevels: [{ price: 0.5, size: 20 }],
  });
  assert.equal(partial.positions[0].shares, 20);
  assert.equal(partial.orders[0].status, 'PARTIALLY_FILLED_REMAINDER_CANCELLED');
  assert.equal(partial.orders[0].cancelledRemainderShares, 80);
});

test('missing ask depth never creates an assumed fill', () => {
  const { bot } = fixture();
  setQuote(bot, 'BTC', 'UP', { ask: 0.9, at: START + 1000 });
  setQuote(bot, 'ETH', 'UP', { ask: 0.5, askSize: 0, askLevels: [], at: START + 1000 });
  assert.equal(bot.processStrategyEntry(START + 1000), true);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders[0].status, 'REJECTED_NO_VISIBLE_ASK_DEPTH');
  assert.equal(bot.cash, config.DEMO_CAPITAL);
});

test('TP requires newly visible bid depth at $0.99 and credits exactly $1 per sold share', () => {
  const bot = fixture().bot;
  qualify(bot, 'UP');
  const position = bot.positions[0];
  const cashAfterEntry = bot.cash;

  setQuote(bot, 'ETH', 'UP', {
    bid: 0.99, bidSize: 30, bidLevels: [{ price: 0.99, size: 30 }], at: START + 2000,
  });
  bot.processStrategyEntry(START + 2000);
  assert.equal(position.takeProfitShares, 30);
  assert.equal(position.takeProfitProceeds, 30);
  assert.equal(position.shares, 70);
  assert.equal(bot.cash, cashAfterEntry + 30);
  assert.equal(position.status, 'OPEN');

  bot.processStrategyEntry(START + 2500);
  assert.equal(position.takeProfitShares, 30, 'same depth must not be sold again');

  setQuote(bot, 'ETH', 'UP', {
    bid: 0.99, bidSize: 100, bidLevels: [{ price: 0.99, size: 100 }], at: START + 3000,
  });
  bot.processStrategyEntry(START + 3000);
  assert.equal(position.takeProfitShares, 100);
  assert.equal(position.shares, 0);
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.proceeds, 100);
  assert.equal(position.creditedExitPrice, 1);
  assert.equal(position.settlementBasis, 'PAPER_TAKE_PROFIT');
});

test('unexited ETH shares resolve only against their exact ETH market ID', async () => {
  const { bot, requestedMarkets } = fixture();
  qualify(bot, 'UP');
  const position = bot.positions[0];
  await bot.closePreviousWindows(START + WINDOW, START + WINDOW);
  assert.equal(position.status, 'PENDING_RESOLUTION');
  await bot.resolvePendingPositions(START + WINDOW + config.RESOLUTION_POLL_MS);
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.settlementBasis, 'POLYMARKET_RESOLUTION');
  assert.equal(position.resolutionWinner, 'UP');
  assert.equal(position.proceeds, position.shares * position.payout);
  assert.deepEqual(requestedMarkets, [{ resolutionId: 'eth-market' }]);
});

test('a partial take-profit is credited before the remaining ETH shares resolve', async () => {
  const { bot } = fixture();
  qualify(bot, 'UP');
  const position = bot.positions[0];
  const entryCashCost = position.initialTotalCost + position.initialFees;
  setQuote(bot, 'ETH', 'UP', {
    bid: 0.99, bidSize: 30, bidLevels: [{ price: 0.99, size: 30 }], at: START + 2000,
  });
  bot.processStrategyEntry(START + 2000);
  assert.equal(position.takeProfitShares, 30);
  assert.equal(position.shares, 70);

  await bot.closePreviousWindows(START + WINDOW, START + WINDOW);
  assert.equal(position.status, 'PENDING_RESOLUTION');
  assert.equal(position.takeProfitOrder.status, 'CANCELLED_WINDOW_END');
  await bot.resolvePendingPositions(START + WINDOW + config.RESOLUTION_POLL_MS);
  assert.equal(position.resolutionProceeds, 70);
  assert.equal(position.proceeds, 100);
  assert.equal(position.realizedPnl, 100 - entryCashCost);
  assert.equal(bot.cash, config.DEMO_CAPITAL - entryCashCost + 100);
});

test('ETH market mapping accepts both outcomes and rejects unsupported assets', async () => {
  const data = require('../wick-market-data');
  assert.equal(typeof data.getEthMarket, 'function');
  assert.equal(typeof data.getBtcMarket, 'function');
  assert.equal(CrossAssetBot.constants.ENTRY_CUTOFF_MS, 180000);
  assert.equal(CrossAssetBot.constants.BTC_SIGNAL_MIN, 0.8);
  assert.equal(CrossAssetBot.constants.ETH_ENTRY_MAX, 0.6);
  await assert.rejects(data.getAssetMarket('SOL', START, WINDOW), /Unsupported asset/);
});
