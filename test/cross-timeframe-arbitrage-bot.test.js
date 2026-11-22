'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CrossTimeframeArbitrageBot = require('../cross-timeframe-arbitrage-bot');

const FIFTEEN_START = 1_800_000_000_000;
const FIVE_START = FIFTEEN_START;
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
      getBeatPriceAt(timestamp) {
        const value = beats[timestamp] || 62_000;
        return { value, source: 'BINANCE_WS_ESTIMATE', exact: false, sourceTimestamp: timestamp, offsetMs: 0 };
      },
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
  });
  const five = makeMarket('5m', FIVE_START, 'market-5m');
  const fifteen = makeMarket('15m', FIFTEEN_START, 'market-15m');
  bot.market = five;
  bot.pairMarkets = { '5m': five, '15m': fifteen };
  bot.orderWindowStart = FIVE_START;
  bot.pairKey = 'market-5m|market-15m';
  bot.websocket = {
    status: 'CONNECTED',
    connectedAt: nowRef.value,
    lastMessageAt: nowRef.value,
    reconnectCount: 0,
    error: null,
  };
  bot.rebuildTokenRefs();
  const defaultAsks = {
    '5m.UP': 0.27,
    '5m.DOWN': 0.35,
    '15m.UP': 0.35,
    '15m.DOWN': 0.27,
    ...asks,
  };
  for (const timeframe of ['5m', '15m']) {
    for (const side of ['UP', 'DOWN']) {
      const ask = defaultAsks[`${timeframe}.${side}`];
      const bid = Math.max(0.01, ask - 0.02);
      const size = defaultAsks[`${timeframe}.${side}.size`] ?? 1_000;
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

test('all three 5-minute slots map to their parent 15-minute window', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const fifteen = makeMarket('15m', FIFTEEN_START, '15m');
  assert.equal(_test.fiveMinuteSlotIndex(makeMarket('5m', FIFTEEN_START, 'first'), fifteen), 0);
  assert.equal(_test.fiveMinuteSlotIndex(makeMarket('5m', FIFTEEN_START + 5 * 60 * 1000, 'second'), fifteen), 1);
  assert.equal(_test.fiveMinuteSlotIndex(makeMarket('5m', FIFTEEN_START + 10 * 60 * 1000, 'third'), fifteen), 2);
  assert.equal(_test.fiveMinuteSlotIndex(makeMarket('5m', FIFTEEN_START + 15 * 60 * 1000, 'outside'), fifteen), null);
});

test('still recognizes exact shared end times for display only', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const five = makeMarket('5m', FIFTEEN_START + 10 * 60 * 1000, '5m');
  const fifteen = makeMarket('15m', FIFTEEN_START, '15m');
  assert.equal(_test.synchronizedMarkets(five, fifteen), true);
  fifteen.raw.endDate = new Date(END + 1_000).toISOString();
  assert.equal(_test.synchronizedMarkets(five, fifteen), false);
});

test('lowest eligible complementary ask pair selects sides without beat prices', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const five = makeMarket('5m', FIVE_START, '5m');
  const fifteen = makeMarket('15m', FIFTEEN_START, '15m');
  const quotes = {
    '5m': { UP: { bestAsk: 0.27 }, DOWN: { bestAsk: 0.35 } },
    '15m': { UP: { bestAsk: 0.35 }, DOWN: { bestAsk: 0.27 } },
  };
  const opportunity = _test.detectOpportunity({
    market5m: five,
    market15m: fifteen,
    quotes,
  });
  assert.equal(opportunity.exists, true);
  assert.equal(opportunity.case, 'A');
  assert.deepEqual(opportunity.direction, { upMarket: '5m', downMarket: '15m' });
  assert.equal(opportunity.prices.sumPrice, 0.54);
  assert.equal(opportunity.selectionMode, 'LOWEST_ASK_SUM');
});

test('lowest ask combination wins even if the old beat direction would disagree', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    quotes: {
      '5m': { UP: { bestAsk: 0.35 }, DOWN: { bestAsk: 0.24 } },
      '15m': { UP: { bestAsk: 0.25 }, DOWN: { bestAsk: 0.35 } },
    },
  });
  assert.equal(opportunity.case, 'B');
  assert.deepEqual(opportunity.direction, { upMarket: '15m', downMarket: '5m' });
  assert.equal(opportunity.prices.sumPrice, 0.49);
});

test('individual asks below $0.20 are excluded even when their sum is cheap', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    quotes: {
      '5m': { UP: { bestAsk: 0.15 }, DOWN: { bestAsk: 0.35 } },
      '15m': { DOWN: { bestAsk: 0.30 } },
    },
  });
  assert.equal(opportunity.exists, false);
  assert.match(opportunity.reason, /individual ask below the \$0\.20 minimum/);
});

test('an ask exactly at $0.20 is allowed when the combined sum is below $0.85', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    quotes: {
      '5m': { UP: { bestAsk: 0.20 }, DOWN: { bestAsk: 0.42 } },
      '15m': { UP: { bestAsk: 0.41 }, DOWN: { bestAsk: 0.30 } },
    },
  });
  assert.equal(opportunity.exists, true);
  assert.equal(opportunity.prices.sumPrice, 0.50);
});

test('missing asks on one pairing do not block the other eligible pairing', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    quotes: {
      '5m': { UP: { bestAsk: 0.28 }, DOWN: { bestAsk: 0.34 } },
      '15m': { DOWN: { bestAsk: 0.29 } },
    },
  });
  assert.equal(opportunity.exists, true);
  assert.equal(opportunity.case, 'A');
  assert.equal(Number(opportunity.prices.sumPrice.toFixed(2)), 0.57);
});

test('combined asks equal to $0.85 do not qualify', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    quotes: {
      '5m': { UP: { bestAsk: 0.42 }, DOWN: { bestAsk: 0.41 } },
      '15m': { UP: { bestAsk: 0.44 }, DOWN: { bestAsk: 0.43 } },
    },
  });
  assert.equal(opportunity.exists, false);
  assert.equal(opportunity.prices.sumPrice, 0.85);
  assert.equal(opportunity.waitingForAskSum, true);
});

test('ask-only entries do not depend on the Binance volatility feed', async () => {
  const { bot } = makeBot();
  bot.binanceFeed.status = 'DISCONNECTED';
  bot.binanceFeed.getVolatilityBand = () => ({
    ready: false,
    bandUsd: 2,
    rangeUsd: 0,
    sampleCount: 0,
    windowMs: 60_000,
    lastTickAgeMs: 10_000,
  });
  assert.equal(await bot.processStrategyEntry(), true);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.pairs.length, 1);
});

test('ask-only entries do not require Binance market-start beat snapshots', async () => {
  const { bot } = makeBot();
  bot.binanceFeed.getBeatPriceAt = () => null;
  assert.equal(await bot.processStrategyEntry(), true);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.pairs.length, 1);
});

test('does not use fresh cached CLOB books while its WebSocket is disconnected', async () => {
  const { bot, nowRef } = makeBot();
  bot.websocket.status = 'DISCONNECTED';
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.opportunity.status, 'WAITING_FOR_POLYMARKET_WS');
  assert.equal(bot.positions.length, 0);

  bot.websocket.status = 'CONNECTED';
  bot.websocket.lastMessageAt = nowRef.value;
  assert.equal(await bot.processStrategyEntry(), true);
  assert.equal(bot.pairs.length, 1);
});

test('a combined ask sum below $0.85 qualifies the single configured entry tier', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    quotes: {
      '5m': { UP: { bestAsk: 0.30 }, DOWN: { bestAsk: 0.60 } },
      '15m': { UP: { bestAsk: 0.60 }, DOWN: { bestAsk: 0.30 } },
    },
  });
  assert.equal(opportunity.exists, true);
  assert.equal(opportunity.prices.sumPrice, 0.6);
  assert.equal(opportunity.askSumUnderTarget, true);
  assert.deepEqual(opportunity.qualifyingThresholds, [0.85]);
  assert.equal(opportunity.waitingForAskSum, false);
});

test('a $0.59 ask sum qualifies the $0.85 entry tier', () => {
  const { _test } = CrossTimeframeArbitrageBot;
  const opportunity = _test.detectOpportunity({
    market5m: makeMarket('5m', FIVE_START, '5m'),
    market15m: makeMarket('15m', FIFTEEN_START, '15m'),
    quotes: {
      '5m': { UP: { bestAsk: 0.29 }, DOWN: { bestAsk: 0.60 } },
      '15m': { UP: { bestAsk: 0.60 }, DOWN: { bestAsk: 0.30 } },
    },
  });
  assert.equal(opportunity.exists, true);
  assert.equal(opportunity.prices.sumPrice, 0.59);
  assert.equal(opportunity.askSumUnderTarget, true);
  assert.equal(opportunity.waitingForAskSum, false);
  assert.deepEqual(opportunity.qualifyingThresholds, [0.85]);
});

test('the $0.85 ask-sum entry fires once per 5m market', async () => {
  const { bot, nowRef } = makeBot({
    asks: {
      '5m.UP': 0.51,
      '15m.DOWN': 0.36,
      '15m.UP': 0.46,
      '5m.DOWN': 0.45,
    },
  });
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.opportunity.status, 'WAITING_FOR_ASK_SUM');
  assert.equal(bot.positions.length, 0);
  const updatePairAsks = (upAsk, downAsk) => {
    nowRef.value += 1_000;
    bot.applyBookSnapshot('5m', 'UP', {
      timestamp: nowRef.value,
      bids: [{ price: Math.max(0.01, upAsk - 0.02).toFixed(2), size: '1000' }],
      asks: [{ price: upAsk.toFixed(2), size: '1000' }],
    }, nowRef.value);
    bot.applyBookSnapshot('15m', 'DOWN', {
      timestamp: nowRef.value,
      bids: [{ price: Math.max(0.01, downAsk - 0.02).toFixed(2), size: '1000' }],
      asks: [{ price: downAsk.toFixed(2), size: '1000' }],
    }, nowRef.value);
  };

  updatePairAsks(0.32, 0.32);
  assert.equal(await bot.processStrategyEntry(), true);
  assert.deepEqual(bot.pairs.map((pair) => pair.askSumTarget), [0.85]);
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.pairs.length, 1);

  updatePairAsks(0.33, 0.32);
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.pairs.length, 1);

  updatePairAsks(0.27, 0.28);
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.pairs.length, 1);
  assert.equal(bot.positions.length, 2);
});

test('skips a 5m slot if the combined asks never fall below $0.85', async () => {
  const { bot, nowRef, five } = makeBot({
    asks: {
      '5m.UP': 0.50,
      '15m.DOWN': 0.40,
      '15m.UP': 0.46,
      '5m.DOWN': 0.45,
    },
  });
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.opportunity.status, 'WAITING_FOR_ASK_SUM');
  nowRef.value = five.end;
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.opportunity.status, 'WINDOW_EXPIRED');
  assert.equal(bot.positions.length, 0);
});

test('a jump below $0.85 produces one pair for the active 5m slot', async () => {
  const { bot } = makeBot();
  assert.equal(await bot.processStrategyEntry(), true);
  assert.equal(bot.pairs.length, 1);
  assert.equal(bot.pairs[0].askSumTarget, 0.85);
  assert.equal(bot.pairs[0].sharesPerLeg, 300);
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.pairs.length, 1);
});

test('CLOB price changes update the matching timeframe book and quote', () => {
  const { bot, nowRef } = makeBot();
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: nowRef.value,
    price_changes: [
      { asset_id: 'market-5m-up', side: 'BUY', price: '0.46', size: '13' },
      { asset_id: 'market-5m-up', side: 'SELL', price: '0.27', size: '0' },
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

test('paper execution fills 300 shares on each leg below the $0.85 gate', async () => {
  const { bot } = makeBot();
  const entered = await bot.processStrategyEntry();
  assert.equal(entered, true);
  assert.equal(bot.positions.length, 2);
  assert.equal(bot.orders.length, 2);
  assert.equal(bot.pairs.length, 1);
  assert.ok(bot.orders.every((order) => order.status === 'FILLED' && order.filledShares === 300));
  assert.ok(bot.orders.every((order) => order.orderType === 'PAPER_MARKET_FOK' && order.priceCap === 0.99));
  assert.ok(bot.orders.every((order) => order.fees > 0));
  assert.ok(bot.pairs.every((pair) => pair.bestAskSum === 0.54));
  assert.equal(bot.pairs[0].totalCost > bot.pairs[0].grossCost, true);
  assert.equal(bot.pairs[0].askSumUnderTarget, true);
  assert.equal(await bot.processStrategyEntry(), false);
  assert.equal(bot.pairs.length, 1);
});

test('a best bid at $0.99 closes a leg at the modeled $1.00 payout', async () => {
  const { bot, nowRef } = makeBot({
    beats: { [FIVE_START]: 62_000, [FIFTEEN_START]: 62_500 },
  });
  await bot.processStrategyEntry();
  const position = bot.positions.find((item) => item.pairId === bot.pairs[0].id && item.timeframe === '5m');
  const cashBefore = bot.cash;
  nowRef.value += 1_000;
  bot.pairQuotes['5m'][position.side] = {
    ...bot.pairQuotes['5m'][position.side],
    bestBid: 0.99,
    updatedAt: nowRef.value,
  };

  bot.updatePositionMarks(nowRef.value, '5m', position.side);

  const closed = bot.positions.filter((item) => item.timeframe === '5m' && item.side === position.side);
  assert.equal(closed.length, 1);
  assert.ok(closed.every((item) => item.status === 'SETTLED_EXIT'));
  assert.ok(closed.every((item) => item.settlementBasis === 'TAKE_PROFIT_099'));
  assert.ok(closed.every((item) => item.exitBid === 0.99));
  assert.ok(closed.every((item) => item.exitPrice === 1));
  assert.ok(closed.every((item) => item.takeProfitProceeds === item.shares));
  assert.ok(closed.every((item) => item.realizedPnl > 0));
  assert.equal(bot.cash, cashBefore + closed.reduce((sum, item) => sum + item.shares, 0));
  assert.equal(bot.pairs.find((pair) => pair.id === position.pairId).status, 'PARTIALLY_SETTLED');
});

test('positions that miss take-profit wait for their own market resolution time', async () => {
  const { bot, five } = makeBot({
    beats: { [FIVE_START]: 62_000, [FIFTEEN_START]: 62_500 },
  });
  await bot.processStrategyEntry();
  const pair = bot.pairs[0];
  const fiveLeg = bot.positions.find((position) => position.pairId === pair.id && position.timeframe === '5m');
  const fifteenLeg = bot.positions.find((position) => position.pairId === pair.id && position.timeframe === '15m');

  await bot.closePreviousWindows(five.end, five.end);
  assert.equal(fiveLeg.status, 'PENDING_RESOLUTION');
  assert.equal(fifteenLeg.status, 'OPEN');

  await bot.closePreviousWindows(fifteenLeg.windowEnd, fifteenLeg.windowEnd);
  assert.equal(fifteenLeg.status, 'PENDING_RESOLUTION');
});

test('reselects sides on new entries without selling filled positions', async () => {
  const { bot, nowRef, fifteen } = makeBot();
  assert.equal(await bot.processStrategyEntry(), true);
  assert.equal(await bot.processStrategyEntry(), false);
  for (const [index, offset] of [5, 10].entries()) {
    const nextFiveStart = FIFTEEN_START + offset * 60 * 1000;
    const nextFive = makeMarket('5m', nextFiveStart, `market-5m-next-${index}`);
    nowRef.value = nextFiveStart + 1_000;
    bot.market = nextFive;
    bot.pairMarkets['5m'] = nextFive;
    bot.pairMarkets['15m'] = fifteen;
    bot.orderWindowStart = nextFiveStart;
    bot.pairKey = `${nextFive.id}|${fifteen.id}`;
    bot.websocket.lastMessageAt = nowRef.value;
    const asks = index === 0
      ? { '5m.UP': 0.32, '5m.DOWN': 0.25, '15m.UP': 0.30, '15m.DOWN': 0.32 }
      : { '5m.UP': 0.24, '5m.DOWN': 0.32, '15m.UP': 0.32, '15m.DOWN': 0.30 };
    for (const timeframe of ['5m', '15m']) {
      for (const side of ['UP', 'DOWN']) {
        const ask = asks[`${timeframe}.${side}`];
        bot.applyBookSnapshot(timeframe, side, {
          timestamp: nowRef.value,
          bids: [{ price: (ask - 0.02).toFixed(2), size: '1000' }],
          asks: [{ price: ask.toFixed(2), size: '1000' }],
        }, nowRef.value);
      }
    }
    assert.equal(await bot.processStrategyEntry(), true);
    assert.equal(bot.pairs[0].entryNumber, index + 2);
  }
  assert.equal(bot.pairs.length, 3);
  assert.deepEqual(bot.pairs.map((pair) => pair.case), ['A', 'B', 'A']);
  assert.ok(bot.orders.every((order) => order.id.endsWith('-buy')));
  assert.ok(bot.orders.every((order) => order.filledShares === 300));
  const fifteenPositions = bot.positions.filter((position) => position.timeframe === '15m');
  assert.equal(fifteenPositions.reduce((sum, position) => sum + position.shares, 0), 900);
  assert.equal(fifteenPositions.filter((position) => position.side === 'DOWN')
    .reduce((sum, position) => sum + position.shares, 0), 600);
  assert.equal(fifteenPositions.filter((position) => position.side === 'UP')
    .reduce((sum, position) => sum + position.shares, 0), 300);
  assert.ok(fifteenPositions.every((position) => position.windowStart === FIFTEEN_START));
  assert.deepEqual(bot.pairs.map((pair) => pair.entryNumber), [3, 2, 1]);
});

test('allows a pair whose modeled total cost exceeds a single winning leg payout', async () => {
  const { bot } = makeBot({
    asks: {
      '5m.UP': 0.29,
      '15m.DOWN': 0.29,
      '5m.UP.size': 1,
      '15m.DOWN.size': 1,
    },
  });
  bot.pairBooks['5m'].UP.asks = [{ price: 0.29, size: 1 }, { price: 0.99, size: 299 }];
  bot.pairBooks['15m'].DOWN.asks = [{ price: 0.29, size: 1 }, { price: 0.99, size: 299 }];
  assert.equal(await bot.processStrategyEntry(), true);
  assert.ok(bot.pairs[0].totalCost > 500);
  assert.equal(bot.pairs[0].sharesPerLeg, 300);
});

test('an incomplete book on either leg does not create an unmatched paper position', async () => {
  const { bot } = makeBot({
    asks: { '15m.DOWN.size': 4 },
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

test('snapshot exposes the rolling ask-only 300-share strategy', () => {
  const { bot } = makeBot();
  const snapshot = bot.snapshot();
  assert.equal(snapshot.mode, 'DEMO ONLY');
  assert.equal(snapshot.strategy.id, 'btc-every-5m-paired-5m-15m-paper');
  assert.equal(snapshot.strategy.liveOrdersEnabled, false);
  assert.equal(snapshot.strategy.sharesPerLeg, 300);
  assert.equal(snapshot.strategy.sharesPerFiveMinuteEntry, 300);
  assert.equal(snapshot.strategy.sharesAddedToFifteenMinuteMarketPerSlot, 300);
  assert.equal(snapshot.strategy.individualAskFloor, 0.2);
  assert.equal(snapshot.strategy.askSumTarget, 0.85);
  assert.deepEqual(snapshot.strategy.entryAskSumThresholds, [0.85]);
  assert.equal(snapshot.strategy.maxPairsPerFiveMinuteWindow, 1);
  assert.equal(snapshot.strategy.maxPairsPerFifteenMinuteWindow, 3);
  assert.equal(snapshot.strategy.firstFiveMinuteSlotOnly, false);
  assert.equal(snapshot.strategy.onePairPerFiveMinuteWindow, true);
  assert.equal(snapshot.strategy.onePairPerFirstFiveMinuteSlot, false);
  assert.equal(snapshot.strategy.onePairPerFiveMinuteSlot, true);
  assert.equal(snapshot.strategy.sideSelectionMode.includes('ignore Binance beat'), true);
  assert.equal(snapshot.strategy.sideSelectionMode.includes('never closes filled positions'), true);
  assert.equal(snapshot.strategy.synchronizedEndTimeRequired, false);
  assert.equal(snapshot.strategy.forceEntryAboveAskSumTarget, false);
  assert.equal(snapshot.marketPair.synchronized, false);
  assert.equal(snapshot.marketPair.eligible, true);
  assert.equal(snapshot.marketPair.fiveMinute.timeframe, '5m');
  assert.equal(snapshot.marketPair.fifteenMinute.timeframe, '15m');
  assert.equal(snapshot.persistence.status, 'MEMORY ONLY');
  assert.equal(snapshot.opportunity.legs, undefined);
});
