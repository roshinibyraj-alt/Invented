'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CrossPairBot = require('../cross-pair-bot');

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

test('strict ask-sum threshold is below $0.80 and both pairings are independent', () => {
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

  btcUp.bestAsk = 0.35;
  btcUp.asks = [{ price: 0.35, size: 2000 }];
  bot.evaluateCrossPairs(getNow());
  assert.equal(bot.positions.length, 4, 'both cross-pairs should enter independently when both qualify');
  assert.deepEqual(bot.positions.map(position => position.shares), [100, 100, 100, 100]);
  assert.equal(bot.crossPairCycles.length, 2);
  assert.ok(bot.crossPairCycles.every(cycle => cycle.legPositionIds.length === 2));
  assert.equal(bot.snapshot().strategy.id, CrossPairBot.STRATEGY.id);
});

test('both losing legs set only that pair to 1,000; at least one win leaves base size', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const btcUpEthDown = bot.crossPairCycles.find(cycle => cycle.pairId === 'btc-up-eth-down');
  const ethUpBtcDown = bot.crossPairCycles.find(cycle => cycle.pairId === 'eth-up-btc-down');
  assert.ok(btcUpEthDown);
  assert.ok(ethUpBtcDown);

  settlePair(bot, btcUpEthDown, 'DOWN', 'UP', getNow() + 1000);
  settlePair(bot, ethUpBtcDown, 'DOWN', 'UP', getNow() + 2000);

  assert.equal(bot.crossPairSizing['btc-up-eth-down'].nextShares, 1000);
  assert.equal(bot.crossPairSizing['eth-up-btc-down'].nextShares, 100);
  assert.equal(btcUpEthDown.sizingOutcome, 'BOTH_LEGS_LOST');
  assert.equal(ethUpBtcDown.sizingOutcome, 'AT_LEAST_ONE_WIN');
});

test('a resolved 1,000-share recovery attempt always returns its pair to 100 shares', () => {
  const { bot, setNow, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const firstCycle = bot.crossPairCycles.find(cycle => cycle.pairId === 'btc-up-eth-down');
  settlePair(bot, firstCycle, 'DOWN', 'UP', getNow() + 1000);
  assert.equal(bot.crossPairSizing['btc-up-eth-down'].nextShares, 1000);

  const nextStart = START + WINDOW_MS;
  const nextNow = nextStart + 1000;
  setNow(nextNow);
  setWindow(bot, nextStart, {
    btcUp: 0.30,
    btcDown: 0.40,
    ethUp: 0.35,
    ethDown: 0.35,
  }, nextNow);
  bot.evaluateCrossPairs(nextNow);

  const recovery = bot.crossPairCycles.find(cycle =>
    cycle.pairId === 'btc-up-eth-down' && cycle.windowStart === nextStart);
  assert.ok(recovery);
  assert.equal(recovery.sharesPerLeg, 1000);
  assert.equal(recovery.recoveryAttempt, true);
  settlePair(bot, recovery, 'UP', 'DOWN', nextNow + 1000);
  assert.equal(bot.crossPairSizing['btc-up-eth-down'].nextShares, 100);
  assert.equal(recovery.sizingOutcome, 'RECOVERY_ATTEMPT_RESET');
});

test('a pair waits for its unresolved previous cycle, without blocking the other pair', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  const cycle = bot.crossPairCycles.find(item => item.pairId === 'btc-up-eth-down');
  const otherCycle = bot.crossPairCycles.find(item => item.pairId === 'eth-up-btc-down');
  assert.ok(cycle);
  assert.ok(otherCycle);
  settlePair(bot, otherCycle, 'DOWN', 'UP', getNow() + 500);

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
  assert.equal(bot.pairWindowStates['btc-up-eth-down'].status, 'WAITING_FOR_RESOLUTION');
});

test('the new ledger stores pair sizing and restores open pair positions', () => {
  const { bot, getNow } = createBot();
  bot.evaluateCrossPairs(getNow());
  bot.crossPairSizing['btc-up-eth-down'].nextShares = 1000;
  const saved = bot.exportLedger();
  assert.equal(saved.strategyId, CrossPairBot.STRATEGY.id);

  const restored = new CrossPairBot({ now: getNow });
  restored.restoreLedger(saved);
  assert.equal(restored.crossPairSizing['btc-up-eth-down'].nextShares, 1000);
  assert.equal(restored.positions.length, 4);
  assert.equal(restored.crossPairCycles.length, 2);
  assert.equal(restored.snapshot().strategy.id, CrossPairBot.STRATEGY.id);
});
