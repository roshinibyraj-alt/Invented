'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CrossTimeframeArbitrageBot = require('../cross-timeframe-arbitrage-bot');

const FIFTEEN_START = 1_800_000_000_000;
const FIVE_START = FIFTEEN_START + 10 * 60 * 1000;
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
      const size = defaultAsks[`${timeframe}.${side}.size`] ?? 20;
      bot.applyBookSnapshot(timeframe, side, {
        timestamp: nowRef.value,
        bids: [{ price: bid.toFixed(2), size: '30' }],
        asks: [{ price: ask.toFixed(2), size: String(size) }],
      }, nowRef.value);
    }
  }
  return { bot, nowRef, five, fifteen };
}

test('pairs only markets with the same actual end time', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const five = makeMarket('5m', FIVE_START, '5m');
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

test('equal strikes choose the first qualifying cross-market pair', () => {
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
  assert.deepEqual(opportunity.direction, { upMarket: '5m', downMarket: '15m' });
  assert.equal(opportunity.prices.sumPrice, 0.8);
});

test('pair threshold is strict and rejects a sum equal to $0.90', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    beat5m: { value: 62_000 },
    beat15m: { value: 62_500 },
    quotes: {
      '5m': { UP: { bestAsk: 0.45 }, DOWN: { bestAsk: 0.6 } },
      '15m': { UP: { bestAsk: 0.6 }, DOWN: { bestAsk: 0.45 } },
    },
  });
  assert.equal(opportunity.exists, false);
  assert.match(opportunity.reason, /below \$0\.90/);
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

test('paper execution fills both 10-share legs, models fees, and prevents duplicate pairs', async () => {
  const { bot } = makeBot({
    beats: { [FIVE_START]: 62_000, [FIFTEEN_START]: 62_500 },
  });
  const entered = await bot.processStrategyEntry();
  assert.equal(entered, true);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.orders.length, 2);
  assert.ok(bot.orders.every((order) => order.status === 'FILLED' && order.filledShares === 10));
  assert.ok(bot.orders.every((order) => order.fees > 0));
  assert.equal(bot.pairs[0].bestAskSum, 0.88);
  assert.equal(bot.pairs[0].totalCost > bot.pairs[0].grossCost, true);
  assert.equal(bot.pairs[0].minimumNetProfit > 0, true);
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.pairs.length, 1);
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
  assert.equal(snapshot.strategy.id, 'btc-synchronized-5m-15m-arbitrage-paper');
  assert.equal(snapshot.strategy.liveOrdersEnabled, false);
  assert.equal(snapshot.marketPair.synchronized, true);
  assert.equal(snapshot.marketPair.fiveMinute.timeframe, '5m');
  assert.equal(snapshot.marketPair.fifteenMinute.timeframe, '15m');
  assert.equal(snapshot.persistence.status, 'MEMORY ONLY');
  assert.equal(snapshot.opportunity.legs, undefined);
});
