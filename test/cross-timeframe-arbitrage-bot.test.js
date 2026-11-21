'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CrossTimeframeArbitrageBot = require('../cross-timeframe-arbitrage-bot');

const FIFTEEN_START = 1_800_000_000_000;
const FIVE_START = FIFTEEN_START + 5 * 60 * 1000;
const END = FIFTEEN_START + 15 * 60 * 1000;

function makeMarket(timeframe, start, id) {
  const duration = timeframe === '5m' ? 300_000 : 900_000;
  return {
    id,
    conditionId: `${id}-condition`,
    slug: `btc-updown-${timeframe}-${start / 1000}`,
    title: `BTC ${timeframe} Up or Down`,
    start,
    end: start + duration,
    feesEnabled: true,
    feeSchedule: { rate: 0.07, exponent: 1 },
    tokens: { UP: `${id}-up`, DOWN: `${id}-down` },
    raw: {
      eventStartTime: new Date(start).toISOString(),
      endDate: new Date(start + duration).toISOString(),
    },
  };
}

function makeBot({ asks = {}, beats = {} } = {}) {
  const nowRef = { value: FIVE_START + 1_000 };
  const bot = new CrossTimeframeArbitrageBot({
    now: () => nowRef.value,
    marketData: {},
    binanceFeed: {
      status: 'CONNECTED',
      start() {},
      stop() {},
      getBeatPriceAt() { return null; },
      getVolatilityBand() {
        return {
          ready: true,
          bandUsd: 2,
          rangeUsd: 1,
          sampleCount: 20,
          windowMs: 60_000,
          lastTickAt: nowRef.value,
          lastTickAgeMs: 0,
          minBandUsd: 2,
          maxBandUsd: 100,
        };
      },
    },
    beatPriceProvider: {
      async getAtTimestamp(timestamp) {
        const value = beats[timestamp] || 62_000;
        return { value, source: 'CHAINLINK_DATA_STREAMS', exact: true, sourceTimestamp: timestamp };
      },
    },
  });
  const five = makeMarket('5m', FIVE_START, 'market-5m');
  const fifteen = makeMarket('15m', FIFTEEN_START, 'market-15m');
  bot.market = five;
  bot.pairMarkets = { '5m': five, '15m': fifteen };
  bot.orderWindowStart = FIVE_START;
  bot.pairKey = 'market-5m|market-15m';
  bot.rebuildTokenRefs();
  const defaultAsks = {
    '5m.UP': 0.44,
    '5m.DOWN': 0.58,
    '15m.UP': 0.58,
    '15m.DOWN': 0.44,
    ...asks,
  };
  for (const timeframe of ['5m', '15m']) {
    for (const side of ['UP', 'DOWN']) {
      const ask = defaultAsks[`${timeframe}.${side}`];
      const bid = Math.max(0.01, ask - 0.02);
      const size = defaultAsks[`${timeframe}.${side}.size`] ?? 200;
      bot.applyBookSnapshot(timeframe, side, {
        timestamp: nowRef.value,
        bids: [{ price: bid.toFixed(2), size: '30' }],
        asks: [{ price: ask.toFixed(2), size: String(size) }],
      }, nowRef.value);
    }
  }
  return { bot, nowRef, five, fifteen };
}

test('accepts each 5m market contained by its active 15m market', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const five = makeMarket('5m', FIVE_START, '5m');
  const fifteen = makeMarket('15m', FIFTEEN_START, '15m');
  assert.equal(_test.validPairMarkets(five, fifteen), true);
  assert.equal(_test.synchronizedMarkets(five, fifteen), false);
  const nextFive = makeMarket('5m', FIFTEEN_START + 10 * 60 * 1000, '5m-next');
  assert.equal(_test.validPairMarkets(nextFive, fifteen), true);
  const outsideFifteen = makeMarket('5m', FIFTEEN_START + 15 * 60 * 1000, '5m-outside');
  assert.equal(_test.validPairMarkets(outsideFifteen, fifteen), false);
});

test('still recognizes exact shared end times for display only', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const five = makeMarket('5m', FIFTEEN_START + 10 * 60 * 1000, '5m');
  const fifteen = makeMarket('15m', FIFTEEN_START, '15m');
  assert.equal(_test.synchronizedMarkets(five, fifteen), true);
  fifteen.raw.endDate = new Date(END + 1_000).toISOString();
  assert.equal(_test.synchronizedMarkets(five, fifteen), false);
});

test('beat comparison chooses UP in 5m and DOWN in 15m when the 15m strike is higher', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const five = makeMarket('5m', FIVE_START, '5m');
  const fifteen = makeMarket('15m', FIFTEEN_START, '15m');
  const quotes = {
    '5m': { UP: { bestAsk: 0.44 }, DOWN: { bestAsk: 0.58 } },
    '15m': { UP: { bestAsk: 0.58 }, DOWN: { bestAsk: 0.44 } },
  };
  const opportunity = _test.detectOpportunity({
    market5m: five,
    market15m: fifteen,
    beat5m: { value: 62_000 },
    beat15m: { value: 62_500 },
    quotes,
  });
  assert.equal(opportunity.exists, true);
  assert.equal(opportunity.case, 'A');
  assert.deepEqual(opportunity.direction, { upMarket: '5m', downMarket: '15m' });
  assert.equal(opportunity.prices.sumPrice, 0.88);
});

test('beat comparison reverses the legs when the 5m strike is higher', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    beat5m: { value: 63_000 },
    beat15m: { value: 62_000 },
    quotes: {
      '5m': { UP: { bestAsk: 0.58 }, DOWN: { bestAsk: 0.44 } },
      '15m': { UP: { bestAsk: 0.44 }, DOWN: { bestAsk: 0.58 } },
    },
  });
  assert.equal(opportunity.case, 'B');
  assert.deepEqual(opportunity.direction, { upMarket: '15m', downMarket: '5m' });
});

test('any strict beat-price difference selects its corresponding pairing', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    beat5m: { value: 62_000 },
    beat15m: { value: 62_001 },
    quotes: {
      '5m': { UP: { bestAsk: 0.41 }, DOWN: { bestAsk: 0.59 } },
      '15m': { UP: { bestAsk: 0.59 }, DOWN: { bestAsk: 0.41 } },
    },
  });
  assert.equal(opportunity.case, 'A');
});

test('missing asks on unused outcomes do not block the selected paired asks', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    beat5m: { value: 62_000 },
    beat15m: { value: 62_500 },
    quotes: {
      '5m': { UP: { bestAsk: 0.44 } },
      '15m': { DOWN: { bestAsk: 0.44 } },
    },
  });
  assert.equal(opportunity.exists, true);
  assert.equal(opportunity.case, 'A');
});

test('equal strikes choose the lower-ask cross-market pair', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    beat5m: { value: 62_000 },
    beat15m: { value: 62_000 },
    quotes: {
      '5m': { UP: { bestAsk: 0.30 }, DOWN: { bestAsk: 0.40 } },
      '15m': { UP: { bestAsk: 0.30 }, DOWN: { bestAsk: 0.50 } },
    },
  });
  assert.equal(opportunity.exists, true);
  assert.equal(opportunity.case, 'C');
  assert.deepEqual(opportunity.direction, { upMarket: '15m', downMarket: '5m' });
  assert.equal(opportunity.prices.sumPrice, 0.7);
});

test('beat gaps within the volatility band evaluate both pair directions', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    beat5m: { value: 62_000 },
    beat15m: { value: 62_001.5 },
    beatToleranceUsd: 2,
    quotes: {
      '5m': { UP: { bestAsk: 0.30 }, DOWN: { bestAsk: 0.60 } },
      '15m': { UP: { bestAsk: 0.60 }, DOWN: { bestAsk: 0.30 } },
    },
  });
  assert.equal(opportunity.case, 'C');
  assert.equal(opportunity.beatGapUsd, 1.5);
  assert.equal(opportunity.beatToleranceUsd, 2);
  assert.deepEqual(opportunity.direction, { upMarket: '5m', downMarket: '15m' });
});

test('beat gaps beyond the volatility band select the higher-beat direction', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    beat5m: { value: 62_000 },
    beat15m: { value: 62_003 },
    beatToleranceUsd: 2,
    quotes: {
      '5m': { UP: { bestAsk: 0.30 }, DOWN: { bestAsk: 0.60 } },
      '15m': { UP: { bestAsk: 0.60 }, DOWN: { bestAsk: 0.30 } },
    },
  });
  assert.equal(opportunity.case, 'A');
  assert.equal(opportunity.beatGapUsd, 3);
});

test('waits for fresh Binance ticks instead of evaluating with a stale volatility band', async () => {
  const { bot } = makeBot();
  bot.binanceFeed.getVolatilityBand = () => ({
    ready: false,
    bandUsd: 2,
    rangeUsd: 0,
    sampleCount: 0,
    windowMs: 60_000,
    lastTickAgeMs: 10_000,
  });
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.opportunity.status, 'WAITING_FOR_BINANCE_DATA');
  assert.equal(bot.positions.length, 0);
});

test('combined ask target is not a hard gate, including at exactly $0.50', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    beat5m: { value: 62_000 },
    beat15m: { value: 62_500 },
    quotes: {
      '5m': { UP: { bestAsk: 0.25 }, DOWN: { bestAsk: 0.6 } },
      '15m': { UP: { bestAsk: 0.6 }, DOWN: { bestAsk: 0.25 } },
    },
  });
  assert.equal(opportunity.exists, true);
  assert.equal(opportunity.prices.sumPrice, 0.5);
  assert.equal(opportunity.askSumUnderTarget, false);
  assert.equal(opportunity.forcedEntry, true);
  assert.match(opportunity.reason, /entering anyway/);
});

test('CLOB price changes update the matching timeframe book and quote', () => {
  const { bot, nowRef } = makeBot();
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: nowRef.value,
    price_changes: [
      { asset_id: 'market-5m-up', side: 'BUY', price: '0.46', size: '13' },
      { asset_id: 'market-5m-up', side: 'SELL', price: '0.44', size: '0' },
      { asset_id: 'market-5m-up', side: 'SELL', price: '0.48', size: '9' },
    ],
  });
  const quote = bot.pairQuotes['5m'].UP;
  assert.equal(quote.bestBid, 0.46);
  assert.equal(quote.bestAsk, 0.48);
  assert.equal(quote.bidSize, 13);
  assert.equal(quote.askSize, 9);
  assert.equal(quote.updatedAt, nowRef.value);
});

test('paper execution fills both 100-share legs above target and prevents duplicate pairs', async () => {
  const { bot } = makeBot({
    beats: { [FIVE_START]: 62_000, [FIFTEEN_START]: 62_500 },
  });
  const entered = await bot.processStrategyEntry();
  assert.equal(entered, true);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.orders.length, 2);
  assert.ok(bot.orders.every((order) => order.status === 'FILLED' && order.filledShares === 100));
  assert.ok(bot.orders.every((order) => order.orderType === 'PAPER_MARKET_FOK' && order.priceCap === 0.99));
  assert.ok(bot.orders.every((order) => order.fees > 0));
  assert.equal(bot.pairs[0].bestAskSum, 0.88);
  assert.equal(bot.pairs[0].totalCost > bot.pairs[0].grossCost, true);
  assert.equal(bot.pairs[0].askSumUnderTarget, false);
  assert.equal(bot.pairs[0].forcedEntry, true);
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.pairs.length, 1);
});

test('enters each of three 5m markets while reusing their containing 15m market', async () => {
  const { bot, nowRef, fifteen } = makeBot({
    beats: { [FIVE_START]: 62_000, [FIFTEEN_START]: 62_500 },
  });
  assert.equal(await bot.processStrategyEntry(), true);
  const nextFiveStart = FIFTEEN_START + 10 * 60 * 1000;
  const nextFive = makeMarket('5m', nextFiveStart, 'market-5m-next');
  nowRef.value = nextFiveStart + 1_000;
  bot.market = nextFive;
  bot.pairMarkets['5m'] = nextFive;
  bot.pairMarkets['15m'] = fifteen;
  bot.orderWindowStart = nextFiveStart;
  bot.pairKey = `${nextFive.id}|${fifteen.id}`;
  bot.rebuildTokenRefs();
  for (const timeframe of ['5m', '15m']) {
    for (const side of ['UP', 'DOWN']) {
      const ask = timeframe === '5m' ? (side === 'UP' ? 0.44 : 0.58) : (side === 'UP' ? 0.58 : 0.44);
      bot.applyBookSnapshot(timeframe, side, {
        timestamp: nowRef.value,
        bids: [{ price: (ask - 0.02).toFixed(2), size: '200' }],
        asks: [{ price: ask.toFixed(2), size: '200' }],
      }, nowRef.value);
    }
  }
  assert.equal(await bot.processStrategyEntry(), true);
  assert.equal(bot.pairs.length, 2);
  assert.equal(bot.pairs[0].market15mId, bot.pairs[1].market15mId);
  assert.notEqual(bot.pairs[0].market5mId, bot.pairs[1].market5mId);
});

test('allows a pair whose modeled total cost exceeds a single winning leg payout', async () => {
  const { bot } = makeBot({
    asks: {
      '5m.UP': 0.60,
      '15m.DOWN': 0.60,
      '5m.UP.size': 200,
      '15m.DOWN.size': 200,
    },
    beats: { [FIVE_START]: 62_000, [FIFTEEN_START]: 62_500 },
  });
  assert.equal(await bot.processStrategyEntry(), true);
  assert.ok(bot.pairs[0].totalCost > 100);
  assert.equal(bot.pairs[0].sharesPerLeg, 100);
});

test('an incomplete book on either leg does not create an unmatched paper position', async () => {
  const { bot } = makeBot({
    asks: { '15m.DOWN.size': 4 },
    beats: { [FIVE_START]: 62_000, [FIFTEEN_START]: 62_500 },
  });
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.cash, 3_000);
  assert.equal(bot.opportunity.status, 'WAITING_FOR_FULL_DEPTH');
});

test('both settled winning legs are combined into one paired-window result', async () => {
  const { bot, nowRef } = makeBot({
    beats: { [FIVE_START]: 62_000, [FIFTEEN_START]: 62_500 },
  });
  await bot.processStrategyEntry();
  const pair = bot.pairs[0];
  const legs = bot.positions.filter((position) => position.pairId === pair.id);
  nowRef.value = END + 5_000;
  for (const position of legs) {
    position.status = 'PENDING_RESOLUTION';
    bot.finalizeResolution(position, position.side, nowRef.value);
  }
  assert.equal(pair.status, 'SETTLED');
  assert.equal(pair.outcome, 'WIN');
  assert.ok(pair.realizedPnl > 0);
  assert.equal(bot.completedPairStats().completed, 1);
  assert.equal(bot.completedPairStats().winRate, 100);
});

test('snapshot exposes only the new paper strategy and paired-market state', () => {
  const { bot } = makeBot();
  const snapshot = bot.snapshot();
  assert.equal(snapshot.mode, 'DEMO ONLY');
  assert.equal(snapshot.strategy.id, 'btc-every-5m-paired-5m-15m-paper');
  assert.equal(snapshot.strategy.liveOrdersEnabled, false);
  assert.equal(snapshot.strategy.sharesPerLeg, 100);
  assert.equal(snapshot.strategy.askSumTarget, 0.5);
  assert.equal(snapshot.strategy.synchronizedEndTimeRequired, false);
  assert.equal(snapshot.marketPair.synchronized, false);
  assert.equal(snapshot.marketPair.eligible, true);
  assert.equal(snapshot.marketPair.fiveMinute.timeframe, '5m');
  assert.equal(snapshot.marketPair.fifteenMinute.timeframe, '15m');
  assert.equal(snapshot.persistence.status, 'MEMORY ONLY');
  assert.equal(snapshot.opportunity.legs, undefined);
});
