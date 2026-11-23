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
        sequence: updatedAt,
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
  bot.evaluateCrossPairs(getNow());
  assert.equal(bot.positions.length, 6, 'each qualifying pair should enter independently');
  assert.deepEqual(bot.positions.map(position => position.shares), [100, 100, 100, 100, 100, 100]);
  assert.equal(bot.crossPairCycles.length, 3);
  assert.ok(bot.crossPairCycles.every(cycle => cycle.legPositionIds.length === 2));
  assert.equal(bot.snapshot().crossPairs.length, 4);
  assert.equal(bot.snapshot().strategy.id, CrossPairBot.STRATEGY.id);
  assert.equal(bot.snapshot().strategy.resolutionPollMs, 5000);
});

test('all pair sizes stay at 100 after wins or losses', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const btcUpEthDown = bot.crossPairCycles.find(cycle => cycle.pairId === 'btc-up-eth-down');
  assert.ok(btcUpEthDown);

  settlePair(bot, btcUpEthDown, 'DOWN', 'UP', getNow() + 1000);
  assert.equal(bot.crossPairSizing['btc-up-eth-down'].nextShares, 100);
  assert.equal(btcUpEthDown.sizingOutcome, 'BOTH_LEGS_LOST');
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

test('a $0.99 best bid does not close a leg before official resolution', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const position = bot.positions.find(item => item.id === cycle.legPositionIds[0]);
  const record = bot.records.get(`${position.asset}:5m`);
  const quote = record.quotes[position.side];
  quote.bestBid = 0.99;
  quote.updatedAt = getNow() + 100;

  bot.checkTakeProfits(record, position.side, quote, getNow() + 100);

  assert.equal(position.status, 'OPEN');
  assert.equal(position.exitPrice, null);
  assert.equal(position.exitPayout, null);
  assert.equal(position.realizedPnl, null);
  assert.equal(cycle.status, 'OPEN');
  assert.equal(bot.crossPairSizing[cycle.pairId].nextShares, 100);
});

test('an empty bid does not stop or close a position', () => {
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
    assert.equal(position.status, 'OPEN');
    assert.equal(position.exitPrice, null);
    assert.equal(position.exitPayout, null);
    assert.equal(position.realizedPnl, null);
  }

  assert.equal(cycle.status, 'OPEN');
  assert.equal(cycle.sizingOutcome, undefined);
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
  assert.equal(cycle.sizingOutcome, 'AT_LEAST_ONE_WIN');
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
