'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CrossPairBot = require('../cross-pair-bot');
const config = require('../config');

const WINDOW_MS = 5 * 60_000;
const START = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;

function createBot(now = START + 1000) {
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.35,
    btcDown: 0.40,
    ethUp: 0.38,
    ethDown: 0.44,
  }, now);
  return { bot, setNow(value) { now = value; }, getNow() { return now; } };
}

function setWindow(bot, start, asks, updatedAt = start + 1000) {
  for (const asset of ['BTC', 'ETH']) {
    const record = bot.records.get(`${asset}:5m`);
    record.market = {
      id: `${asset.toLowerCase()}-${start}`,
      slug: `${asset.toLowerCase()}-updown-5m-${start}`,
      title: `${asset} 5m test`,
      asset,
      start,
      end: start + WINDOW_MS,
      tokens: {
        UP: `${asset.toLowerCase()}-${start}-up`,
        DOWN: `${asset.toLowerCase()}-${start}-down`,
      },
      feesEnabled: true,
      feeSchedule: { rate: 0 },
    };
    record.marketStatus = 'OPEN';
    for (const side of ['UP', 'DOWN']) {
      const ask = asks[`${asset.toLowerCase()}${side === 'UP' ? 'Up' : 'Down'}`];
      record.quotes[side] = {
        status: 'LIVE',
        bestBid: Math.max(0.01, ask - 0.01),
        bestAsk: ask,
        mid: (Math.max(0.01, ask - 0.01) + ask) / 2,
        updatedAt,
        receivedAt: updatedAt,
        sequence: updatedAt,
        tokenId: record.market.tokens[side],
        marketId: record.market.id,
        marketSlug: record.market.slug,
        windowStart: start,
        windowEnd: start + WINDOW_MS,
        asks: [{ price: ask, size: 2000 }],
        bids: [{ price: Math.max(0.01, ask - 0.01), size: 2000 }],
      };
    }
  }
}

function settlePair(bot, cycle, btcWinner, ethWinner, now) {
  for (const positionId of cycle.legPositionIds) {
    const position = bot.positions.find(item => item.id === positionId);
    assert.ok(position);
    position.status = 'PENDING_RESOLUTION';
  }
  bot.settleMarket(`btc-${cycle.windowStart}`, btcWinner, now);
  bot.settleMarket(`eth-${cycle.windowStart}`, ethWinner, now + 1);
}

test('four pairs are independent and each requires a strict ask-sum below $0.80', () => {
  const { bot, getNow } = createBot();
  const btcUp = bot.records.get('BTC:5m').quotes.UP;
  const ethDown = bot.records.get('ETH:5m').quotes.DOWN;

  btcUp.bestAsk = 0.36;
  btcUp.asks = [{ price: 0.36, size: 2000 }];
  ethDown.bestAsk = 0.44;
  ethDown.asks = [{ price: 0.44, size: 2000 }];
  bot.evaluateCrossPairs(getNow());
  assert.equal(
    bot.positions.filter(position => position.pairId === 'btc-up-eth-down').length,
    0,
    'a sum exactly equal to $0.80 must not trigger the first pair',
  );
  assert.equal(bot.positions.filter(position => position.pairId === 'eth-up-btc-down').length, 2);
  assert.equal(bot.positions.filter(position => position.pairId === 'btc-up-eth-up').length, 2);
  assert.equal(bot.positions.filter(position => position.pairId === 'btc-down-eth-down').length, 0);

  btcUp.bestAsk = 0.35;
  btcUp.asks = [{ price: 0.35, size: 2000 }];
  btcUp.sequence += 1;
  bot.evaluateCrossPairs(getNow());
  assert.equal(bot.positions.length, 6, 'each qualifying pair should enter independently');
  assert.deepEqual(bot.positions.map(position => position.shares), [100, 100, 100, 100, 100, 100]);
  assert.equal(bot.crossPairCycles.length, 3);
  assert.ok(bot.crossPairCycles.every(cycle => cycle.legPositionIds.length === 2));
  assert.equal(bot.snapshot().crossPairs.length, 4);
  assert.equal(bot.snapshot().strategy.id, CrossPairBot.STRATEGY.id);
  assert.equal(bot.snapshot().strategy.resolutionPollMs, 5000);
});

test('entry rejects stale, wrong-market, mismatched-book, and widely skewed quotes', () => {
  const { bot, getNow } = createBot();
  const pair = CrossPairBot.PAIRS[0];
  const normal = bot.pairQuotes(pair, getNow());
  assert.equal(normal.asksFresh, true);

  const staleLeg = bot.records.get('BTC:5m').quotes.UP;
  staleLeg.updatedAt -= config.CROSS_PAIR_MAX_QUOTE_AGE_MS + 1;
  staleLeg.receivedAt -= config.CROSS_PAIR_MAX_QUOTE_AGE_MS + 1;
  assert.equal(bot.pairQuotes(pair, getNow()).asksFresh, false);

  setWindow(bot, START, {
    btcUp: 0.35, btcDown: 0.40, ethUp: 0.38, ethDown: 0.44,
  }, getNow());
  bot.records.get('BTC:5m').quotes.UP.tokenId = 'wrong-token';
  assert.equal(bot.pairQuotes(pair, getNow()).asksFresh, false);

  setWindow(bot, START, {
    btcUp: 0.35, btcDown: 0.40, ethUp: 0.38, ethDown: 0.44,
  }, getNow());
  bot.records.get('ETH:5m').quotes.DOWN.updatedAt -= config.CROSS_PAIR_MAX_QUOTE_SKEW_MS + 1;
  assert.equal(bot.pairQuotes(pair, getNow()).asksFresh, false);

  setWindow(bot, START, {
    btcUp: 0.35, btcDown: 0.40, ethUp: 0.38, ethDown: 0.44,
  }, getNow());
  bot.records.get('BTC:5m').quotes.UP.asks[0].price = 0.20;
  assert.equal(bot.pairQuotes(pair, getNow()).asksFresh, true, 'ask-depth arrays do not gate a valid best ask');
});

test('audit records a valid one-cent source ask and its exact simulated fill', () => {
  const { bot, getNow } = createBot();
  setWindow(bot, START, {
    btcUp: 0.01,
    btcDown: 0.40,
    ethUp: 0.38,
    ethDown: 0.44,
  }, getNow());
  const btcUp = bot.records.get('BTC:5m').quotes.UP;
  btcUp.bestBid = null;
  btcUp.bidSize = 0;
  btcUp.asks = [{ price: 0.01, size: 100 }];
  btcUp.askSize = 100;
  btcUp.mid = null;

  bot.evaluateCrossPairs(getNow());
  const order = bot.orders.find(item =>
    item.pairId === 'btc-up-eth-down' && item.asset === 'BTC' && item.side === 'UP');
  assert.ok(order);
  assert.equal(order.averagePrice, 0.01);
  assert.equal(order.executionAudit.bestAsk, 0.01);
  assert.deepEqual(order.executionAudit.asks, [{ price: 0.01, size: 100 }]);
  assert.deepEqual(order.executionAudit.simulatedFills, [
    { shares: 100, price: 0.01, value: 1, fee: 0 },
  ]);
});

test('all qualifying pairs assume full best-ask fills even with missing or shallow ask depth', () => {
  const { bot, getNow } = createBot();
  for (const record of bot.records.values()) {
    for (const side of ['UP', 'DOWN']) {
      record.quotes[side].asks = side === 'UP' ? [] : [{ price: record.quotes[side].bestAsk, size: 1 }];
      record.quotes[side].askSize = side === 'UP' ? 0 : 1;
    }
  }
  bot.evaluateCrossPairs(getNow());

  const consumedByToken = new Map();
  for (const position of bot.positions) {
    const key = `${position.marketId}:${position.side}`;
    consumedByToken.set(key, (consumedByToken.get(key) || 0) + position.initialShares);
  }
  assert.ok([...consumedByToken.values()].some(shares => shares === 200));
  assert.equal(bot.positions.length, 6);
  assert.ok(bot.positions.every(position => position.initialShares === 100));
  assert.equal(bot.snapshot().strategy.askDepthRequired, false);
  assert.equal(bot.snapshot().strategy.executionModel, 'BEST_ASK_FULL_SIZE_PAPER_NO_DEPTH_V1');
});

test('all pair sizes stay at 100 after wins or losses', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const btcUpEthDown = bot.crossPairCycles.find(cycle => cycle.pairId === 'btc-up-eth-down');
  assert.ok(btcUpEthDown);

  settlePair(bot, btcUpEthDown, 'DOWN', 'UP', getNow() + 1000);
  assert.equal(bot.crossPairSizing['btc-up-eth-down'].nextShares, 100);
  assert.equal(btcUpEthDown.sizingOutcome, 'PAIR_LOSS');
  assert.ok(Object.values(bot.crossPairSizing).every(item => item.nextShares === 100));

  const nextStart = START + WINDOW_MS;
  const nextNow = nextStart + 1000;
  setWindow(bot, nextStart, {
    btcUp: 0.30,
    btcDown: 0.40,
    ethUp: 0.35,
    ethDown: 0.35,
  }, nextNow);
  bot.evaluateCrossPairs(nextNow);
  const nextCycle = bot.crossPairCycles.find(cycle =>
    cycle.pairId === 'btc-up-eth-down' && cycle.windowStart === nextStart);
  assert.ok(nextCycle);
  assert.equal(nextCycle.sharesPerLeg, 100);
});

test('a $0.99 best bid closes at the modeled $1-per-share payout', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const position = bot.positions.find(item => item.id === cycle.legPositionIds[0]);
  const record = bot.records.get(`${position.asset}:5m`);
  const quote = record.quotes[position.side];
  quote.bestBid = 0.99;
  quote.updatedAt = getNow() + 100;

  bot.checkTakeProfits(record, position.side, quote, getNow() + 100);

  assert.equal(position.status, 'TAKE_PROFIT');
  assert.equal(position.exitPrice, 0.99);
  assert.equal(position.exitPayout, 1);
  assert.ok(position.realizedPnl > 0);
  assert.equal(cycle.status, 'OPEN');
  assert.equal(bot.crossPairSizing[cycle.pairId].nextShares, 100);
});

test('a fresh empty bid book triggers the $0 stop-loss', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');

  for (const positionId of cycle.legPositionIds) {
    const position = bot.positions.find(item => item.id === positionId);
    const record = bot.records.get(`${position.asset}:5m`);
    const quote = record.quotes[position.side];
    quote.bestBid = null;
    quote.updatedAt = getNow() + 100;
    bot.checkStopLosses(record, position.side, quote, getNow() + 100);
    assert.equal(position.status, 'STOP_LOSS');
    assert.equal(position.exitPrice, 0);
    assert.equal(position.exitPayout, 0);
    assert.ok(position.realizedPnl < 0);
  }

  assert.equal(cycle.status, 'CLOSED');
  assert.equal(cycle.sizingOutcome, 'PAIR_LOSS');
  assert.equal(bot.crossPairSizing[cycle.pairId].nextShares, 100);
  assert.ok(Object.values(bot.crossPairSizing).every(item => item.nextShares === 100));
});

test('positions keep their final live mark while awaiting resolution', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const position = bot.positions.find(item => item.id === cycle.legPositionIds[0]);
  const record = bot.records.get(`${position.asset}:5m`);
  const quote = record.quotes[position.side];
  quote.bestBid = 0.31;
  quote.updatedAt = getNow() + 20;
  bot.markPositions(getNow() + 20, record.key, position.side);
  const lastMarkPnl = position.unrealizedPnl;

  bot.expireMarket(record, START + WINDOW_MS);
  assert.equal(position.status, 'PENDING_RESOLUTION');
  assert.equal(position.markBid, 0.31);
  assert.equal(position.unrealizedPnl, lastMarkPnl);
  assert.equal(position.markStatus, 'LAST_MARK_PENDING_RESOLUTION');

  const restored = new CrossPairBot({ now: getNow });
  restored.restoreLedger(bot.exportLedger());
  const restoredPosition = restored.positions.find(item => item.id === position.id);
  assert.equal(restoredPosition.status, 'PENDING_RESOLUTION');
  assert.equal(restoredPosition.markBid, 0.31);
  assert.equal(restoredPosition.unrealizedPnl, lastMarkPnl);
});

test('open positions wait for official resolution at window end', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const end = START + WINDOW_MS;
  bot.expireMarket(bot.records.get('BTC:5m'), end);
  bot.expireMarket(bot.records.get('ETH:5m'), end);

  assert.equal(cycle.status, 'PENDING_RESOLUTION');
  assert.ok(cycle.legPositionIds.every(id =>
    bot.positions.find(position => position.id === id)?.status === 'PENDING_RESOLUTION'));
  assert.equal(cycle.sizingApplied, false);

  settlePair(bot, cycle, 'UP', 'DOWN', end + 1);
  assert.equal(cycle.status, 'CLOSED');
  assert.equal(cycle.sizingOutcome, 'PAIR_PROFIT');
});

test('a pair exits only at its own $1.22 ask sum, then its inverse enters only below $0.80', () => {
  let now = START + 1000;
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.30,
    btcDown: 0.60,
    ethUp: 0.55,
    ethDown: 0.40,
  }, now);
  bot.evaluateCrossPairs(now);
  const firstPair = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  assert.ok(firstPair);
  assert.equal(bot.crossPairCycles.length, 1, 'only the intended first pair should qualify');

  const setQuote = (asset, side, ask, bid, tick) => {
    const quote = bot.records.get(`${asset}:5m`).quotes[side];
    quote.bestAsk = ask;
    quote.bestBid = bid;
    quote.updatedAt = tick;
    quote.sequence = tick;
    quote.asks = [{ price: ask, size: 2000 }];
    quote.bids = [{ price: bid, size: 2000 }];
  };
  now += 500;
  setQuote('BTC', 'UP', 0.62, 0.61, now);
  setQuote('ETH', 'DOWN', 0.60, 0.59, now);
  setQuote('ETH', 'UP', 0.39, 0.38, now);
  setQuote('BTC', 'DOWN', 0.38, 0.37, now);
  bot.evaluateCrossPairs(now);

  assert.equal(firstPair.reverseExitTriggeredAt, null, 'exactly $1.22 must not sell');
  now += 100;
  setQuote('BTC', 'UP', 0.63, 0.61, now);
  bot.evaluateCrossPairs(now);
  assert.equal(firstPair.reverseExitAskSum, 1.23);
  assert.equal(firstPair.reverseExitStatus, 'SOLD');
  assert.equal(firstPair.legPositionIds.every(id =>
    bot.positions.find(position => position.id === id)?.status === 'PAIR_REVERSE_EXIT'), true);
  assert.equal(bot.orders.filter(order =>
    order.pairCycleId === firstPair.id && order.action === 'SELL_TAKER').length, 2);

  const inverseCycle = bot.crossPairCycles.find(item =>
    item.pairId === 'eth-up-btc-down' && item.windowStart === START);
  assert.ok(inverseCycle, 'the inverse should enter after its own asks fall below $0.80');
  assert.equal(inverseCycle.entryAskSum, 0.77);
  assert.ok(inverseCycle.legPositionIds.every(id =>
    bot.positions.find(position => position.id === id)?.status === 'OPEN'));
  assert.equal(bot.snapshot().strategy.inverseExitAskSumAbove, 1.22);
});

test('the inverse pair does not enter when its own combined asks are not below $0.80', () => {
  let now = START + 1000;
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.30,
    btcDown: 0.60,
    ethUp: 0.55,
    ethDown: 0.40,
  }, now);
  bot.evaluateCrossPairs(now);
  const firstPair = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  assert.ok(firstPair);

  const setQuote = (asset, side, ask, bid, tick) => {
    const quote = bot.records.get(`${asset}:5m`).quotes[side];
    quote.bestAsk = ask;
    quote.bestBid = bid;
    quote.updatedAt = tick;
    quote.sequence = tick;
    quote.asks = [{ price: ask, size: 2000 }];
    quote.bids = [{ price: bid, size: 2000 }];
  };
  now += 500;
  setQuote('BTC', 'UP', 0.63, 0.61, now);
  setQuote('ETH', 'DOWN', 0.60, 0.59, now);
  setQuote('ETH', 'UP', 0.45, 0.44, now);
  setQuote('BTC', 'DOWN', 0.40, 0.39, now);
  bot.evaluateCrossPairs(now);

  assert.equal(firstPair.reverseExitStatus, 'SOLD');
  assert.equal(bot.crossPairCycles.some(item => item.pairId === 'eth-up-btc-down'), false);
});

test('inverse exits sell visible bid depth and account for a later partial-fill retry', () => {
  let now = START + 1000;
  const bot = new CrossPairBot({ now: () => now });
  setWindow(bot, START, {
    btcUp: 0.30,
    btcDown: 0.60,
    ethUp: 0.55,
    ethDown: 0.40,
  }, now);
  bot.evaluateCrossPairs(now);
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const btcPosition = bot.positions.find(item =>
    item.pairCycleId === cycle.id && item.asset === 'BTC');
  assert.ok(cycle);
  assert.ok(btcPosition);

  const setQuote = (asset, side, ask, bid, size, tick) => {
    const quote = bot.records.get(`${asset}:5m`).quotes[side];
    quote.bestAsk = ask;
    quote.bestBid = bid;
    quote.updatedAt = tick;
    quote.sequence = tick;
    quote.asks = [{ price: ask, size: 2000 }];
    quote.bids = [{ price: bid, size }];
  };
  now += 500;
  setQuote('BTC', 'UP', 0.63, 0.61, 50, now);
  setQuote('ETH', 'DOWN', 0.60, 0.59, 2000, now);
  setQuote('ETH', 'UP', 0.39, 0.38, 2000, now);
  setQuote('BTC', 'DOWN', 0.38, 0.37, 2000, now);
  bot.evaluateCrossPairs(now);

  assert.equal(btcPosition.status, 'OPEN');
  assert.equal(btcPosition.shares, 50);
  assert.equal(btcPosition.soldShares, 50);
  assert.equal(btcPosition.totalCost, 15);
  assert.equal(btcPosition.partialRealizedPnl, 15.5);
  assert.equal(cycle.reverseExitStatus, 'SELLING_REMAINDER');
  assert.equal(bot.accountSnapshot().realizedPnl, 34.5);

  now += 200;
  setQuote('BTC', 'UP', 0.62, 0.60, 50, now);
  bot.evaluateCrossPairs(now);
  assert.equal(btcPosition.status, 'PAIR_REVERSE_EXIT');
  assert.equal(btcPosition.shares, 0);
  assert.equal(btcPosition.soldShares, 100);
  assert.equal(btcPosition.realizedPnl, 30.5);
  assert.equal(cycle.reverseExitStatus, 'SOLD');
  assert.equal(cycle.realizedPnl, 49.5);
});

test('official outcomes are checked every five seconds and settle only when published', async () => {
  assert.equal(config.DIP_BOUNCE_RESOLUTION_POLL_MS, 5000);
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const end = START + WINDOW_MS;
  bot.expireMarket(bot.records.get('BTC:5m'), end);
  bot.expireMarket(bot.records.get('ETH:5m'), end);

  let shouldResolve = false;
  let checks = 0;
  bot.marketData.getMarket = async id => {
    checks += 1;
    return {
      id,
      closed: shouldResolve,
      outcomes: ['Up', 'Down'],
      outcomePrices: shouldResolve ? ['1', '0'] : ['0.5', '0.5'],
    };
  };
  bot.marketData.resolvedWinner = market => market.closed ? 'UP' : null;

  await bot.checkResolutions(end);
  assert.equal(checks, 2, 'check once for each BTC and ETH market');
  assert.ok(bot.positions.every(position => position.status === 'PENDING_RESOLUTION'));

  await bot.checkResolutions(end + 4999);
  assert.equal(checks, 2, 'do not poll faster than the configured interval');

  shouldResolve = true;
  await bot.checkResolutions(end + 5000);
  assert.equal(checks, 4);
  assert.ok(bot.positions.every(position => position.status === 'RESOLVED_WIN' || position.status === 'RESOLVED_LOSS'));
});

test('a pair waits for its unresolved previous cycle, without blocking the other pair', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const otherCycle = bot.crossPairCycles.find(item => item.pairId === 'eth-up-btc-down');
  assert.ok(cycle);
  assert.ok(otherCycle);
  settlePair(bot, otherCycle, 'DOWN', 'UP', getNow() + 500);
  bot.expireMarket(bot.records.get('BTC:5m'), START + WINDOW_MS);
  bot.expireMarket(bot.records.get('ETH:5m'), START + WINDOW_MS);

  const nextStart = START + WINDOW_MS;
  const nextNow = nextStart + 1000;
  setWindow(bot, nextStart, {
    btcUp: 0.30,
    btcDown: 0.40,
    ethUp: 0.35,
    ethDown: 0.35,
  }, nextNow);
  bot.evaluateCrossPairs(nextNow);

  assert.equal(bot.crossPairCycles.filter(item => item.pairId === 'btc-up-eth-down').length, 1);
  assert.equal(bot.crossPairCycles.filter(item => item.pairId === 'eth-up-btc-down').length, 2);
  assert.equal(bot.crossPairCycles.filter(item => item.pairId === 'btc-up-eth-up').length, 1);
  assert.equal(bot.crossPairCycles.filter(item => item.pairId === 'btc-down-eth-down').length, 1);
  assert.equal(bot.pairWindowStates['btc-up-eth-down'].status, 'WAITING_FOR_RESOLUTION');
  const pairCard = bot.snapshot(nextNow).crossPairs.find(item => item.id === 'btc-up-eth-down');
  assert.equal(pairCard.currentCycle.status, 'PENDING_RESOLUTION');
  assert.ok(pairCard.currentCycle.legs.some(leg => leg.position?.status === 'PENDING_RESOLUTION'));
});

test('the new ledger stores pair sizing and restores open pair positions', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  bot.crossPairSizing['btc-up-eth-down'].nextShares = 1000;
  const saved = bot.exportLedger();
  assert.equal(saved.strategyId, CrossPairBot.STRATEGY.id);

  const restored = new CrossPairBot({ now: getNow });
  restored.restoreLedger(saved);
  assert.equal(restored.crossPairSizing['btc-up-eth-down'].nextShares, 100);
  assert.equal(restored.positions.length, 6);
  assert.equal(restored.crossPairCycles.length, 3);
  assert.equal(restored.snapshot().strategy.id, CrossPairBot.STRATEGY.id);
  const pair = restored.snapshot().crossPairs.find(item => item.id === 'btc-up-eth-down');
  assert.equal(pair.trades[0].legs[0].position.shares, 100);
  assert.equal(pair.trades.length, 1);
  assert.equal(restored.snapshot().crossPairs.length, 4);
});
