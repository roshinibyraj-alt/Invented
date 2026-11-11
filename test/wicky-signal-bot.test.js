'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../config');
const WickySignalBot = require('../wicky-signal-bot');
const MultiBot = require('../multi-bot');

const WINDOW = cfg.WINDOW_MS_5M;
const START = 1_800_000_000_000;

function candleSet(direction) {
  return Array.from({ length: 5 }, (_, index) => {
    const openTime = START - (5 - index) * WINDOW;
    return {
      openTime,
      closeTime: openTime + WINDOW - 1,
      open: direction === 'DOWN' ? 101 : 100,
      high: 102,
      low: 99,
      close: direction === 'DOWN' ? 100 : direction === 'NEUTRAL' ? 100 : 101,
      volume: 100,
    };
  });
}

function fixture({ btc = 'UP', eth = 'DOWN' } = {}) {
  const data = {
    async getBtcMarket(start, windowMs) {
      return {
        id: 'btc-market',
        asset: 'BTC',
        slug: `btc-updown-5m-${start / 1000}`,
        title: 'BTC Up or Down',
        start,
        end: start + windowMs,
        tokens: { UP: 'btc-up', DOWN: 'btc-down' },
        feesEnabled: true,
        feeSchedule: { rate: 0.07, exponent: 1 },
      };
    },
    async getEthMarket(start, windowMs) {
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
    async getBinanceCandles(asset) {
      return candleSet(asset === 'BTC' ? btc : eth);
    },
    async getBook() { return { bids: [], asks: [] }; },
    async getMarket(id) {
      return { id, closed: true, outcomes: ['Up', 'Down'], outcomePrices: ['1', '0'] };
    },
    resolvedWinner(market) {
      if (!market?.closed) return null;
      return market.outcomePrices[0] === '1' ? 'UP' : 'DOWN';
    },
  };
  const bot = new WickySignalBot({ marketData: data });
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
    for (const side of ['UP', 'DOWN']) setQuote(bot, asset, side, 0.75, 1000, START);
  }
  return { bot, data };
}

function setQuote(bot, asset, side, ask, size = 1000, at = START + 1000) {
  const quotes = asset === 'BTC' ? bot.btcLiveQuotes : bot.liveQuotes;
  const bid = ask == null ? null : Math.max(0.01, ask - 0.01);
  quotes[side] = {
    status: 'LIVE',
    bestBid: bid,
    bidSize: size,
    bestAsk: ask,
    askSize: size,
    mid: bid == null || ask == null ? null : (bid + ask) / 2,
    bidLevels: bid == null ? [] : [{ price: bid, size }],
    askLevels: ask == null ? [] : [{ price: ask, size }],
    updatedAt: at,
    stale: false,
  };
}

function setSignalQuote(bot, asset, ask, at, size = 1000, levels = null) {
  const side = asset === 'BTC' ? 'UP' : 'DOWN';
  setQuote(bot, asset, side, ask, size, at);
  if (levels) {
    const quotes = asset === 'BTC' ? bot.btcLiveQuotes : bot.liveQuotes;
    quotes[side].askLevels = levels;
  }
}

test('snapshot exposes independent 5-minute BTC and ETH signals without price filters', async () => {
  const { bot } = fixture();
  await bot.processStrategyEntry(START + 1000);
  const snapshot = bot.snapshot();
  assert.equal(snapshot.strategy.id, 'btc-eth-next-candle-predictor');
  assert.equal(snapshot.strategy.timeframe, '5m');
  assert.equal(snapshot.strategy.capital, 3000);
  assert.equal(snapshot.strategy.entries.sharesPerAsset, 100);
  assert.equal(snapshot.strategy.entries.priceFilter, null);
  assert.match(snapshot.strategy.entries.fillPolicy, /no price filter/i);
  assert.equal(snapshot.signals.BTC.side, 'UP');
  assert.equal(snapshot.signals.ETH.side, 'DOWN');
  assert.equal(snapshot.signals.BTC.lookback, 5);
  assert.equal(snapshot.signals.BTC.bars.length, 5);
  assert.equal(snapshot.pairStates, undefined);
});

test('service wrapper publishes the new strategy as its only 5-minute bot', () => {
  const multi = new MultiBot();
  const snapshot = multi.snapshot();
  assert.deepEqual(Object.keys(multi.bots), ['btc-eth-next-candle-predictor']);
  assert.equal(snapshot.strategy.id, 'btc-eth-next-candle-predictor');
  assert.equal(snapshot.timeframes['5m'].strategy.id, 'btc-eth-next-candle-predictor');
});

test('signal buys immediately at a high ask during the first minute', async () => {
  const { bot } = fixture();
  const early = START + 30_000;
  setSignalQuote(bot, 'BTC', 0.85, early);
  await bot.processStrategyEntry(early);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].asset, 'BTC');
  assert.equal(bot.positions[0].side, 'UP');
  assert.equal(bot.positions[0].avgEntry, 0.85);
  assert.equal(bot.positions[0].maxEntryPrice, null);
  assert.equal(bot.assetSignals.BTC.triggerPhase, 'IMMEDIATE_SIGNAL');
});

test('signal buys immediately above the old $0.60 cap after one minute', async () => {
  const { bot } = fixture();
  const afterGate = START + 90_000;
  setSignalQuote(bot, 'BTC', 0.92, afterGate);
  await bot.processStrategyEntry(afterGate);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].avgEntry, 0.92);
  assert.equal(bot.assetSignals.BTC.triggerPhase, 'IMMEDIATE_SIGNAL');
});

test('BTC and ETH use independent signals and may each enter once', async () => {
  const { bot } = fixture();
  const atGate = START + 70_000;
  setSignalQuote(bot, 'BTC', 0.58, atGate);
  setSignalQuote(bot, 'ETH', 0.59, atGate);
  await bot.processStrategyEntry(atGate);
  assert.deepEqual(
    bot.positions.map(position => [position.asset, position.side]).sort(),
    [['BTC', 'UP'], ['ETH', 'DOWN']],
  );
  assert.ok(bot.positions.every(position => position.shares === 100));
});

test('neutral signal does not enter even when the ask is cheap', async () => {
  const { bot } = fixture({ btc: 'NEUTRAL', eth: 'NEUTRAL' });
  const early = START + 20_000;
  setQuote(bot, 'BTC', 'UP', 0.2, 1000, early);
  setQuote(bot, 'ETH', 'DOWN', 0.2, 1000, early);
  await bot.processStrategyEntry(early);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.assetSignals.BTC.entryStatus, 'NO_TRADE_NEUTRAL');
  assert.equal(bot.assetSignals.ETH.entryStatus, 'NO_TRADE_NEUTRAL');
});

test('no partial position is recorded when full visible ask depth is missing at any price', async () => {
  const { bot } = fixture();
  const early = START + 20_000;
  setSignalQuote(bot, 'BTC', 0.94, early, 40, [{ price: 0.94, size: 40 }]);
  await bot.processStrategyEntry(early);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.cash, 3000);
  assert.equal(bot.assetSignals.BTC.entryStatus, 'WAITING_FOR_FULL_FILL');

  setSignalQuote(bot, 'BTC', 0.94, early + 500, 100, [{ price: 0.94, size: 100 }]);
  await bot.processStrategyEntry(early + 500);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].shares, 100);
});

test('each asset can fill only once per window and fees are recorded', async () => {
  const { bot } = fixture();
  const early = START + 20_000;
  setSignalQuote(bot, 'BTC', 0.85, early);
  await bot.processStrategyEntry(early);
  const cashAfterFill = bot.cash;
  setSignalQuote(bot, 'BTC', 0.3, early + 1000);
  await bot.processStrategyEntry(early + 1000);
  assert.equal(bot.positions.length, 1);
  assert.ok(bot.positions[0].fees > 0);
  assert.ok(cashAfterFill < 3000);
  assert.equal(bot.cash, cashAfterFill);
});

test('held positions settle only through the base exact-market resolution flow', async () => {
  const { bot } = fixture();
  const early = START + 20_000;
  setSignalQuote(bot, 'BTC', 0.85, early);
  await bot.processStrategyEntry(early);
  const position = bot.positions[0];
  position.status = 'PENDING_RESOLUTION';
  assert.equal(bot.finalizeResolution(position, 'UP', START + WINDOW), true);
  assert.equal(position.status, 'SETTLED_EXIT');
  assert.equal(position.marketId, 'btc-market');
  assert.equal(position.settlementBasis, 'POLYMARKET_RESOLUTION');
});
