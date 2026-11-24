'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreOrResetLedger } = require('../index');
const CrossPairBot = require('../cross-pair-bot');

function makeStubBot() {
  const calls = { restored: 0, flushed: 0, logs: [] };
  return {
    calls,
    restoreLedger() {
      calls.restored += 1;
    },
    async flushLedger() {
      calls.flushed += 1;
    },
    log(message, details) {
      calls.logs.push({ message, details });
    },
  };
}

test('startup restores history only for the current strategy id', async () => {
  const bot = makeStubBot();
  const status = await restoreOrResetLedger(
    bot,
    { snapshot: { strategy: { id: 'current-strategy' } } },
    'current-strategy',
  );
  assert.equal(status, 'restored');
  assert.equal(bot.calls.restored, 1);
  assert.equal(bot.calls.flushed, 1);
  assert.equal(bot.calls.logs.length, 0);
});

test('startup clears old strategy history and flushes a fresh ledger', async () => {
  const bot = makeStubBot();
  const status = await restoreOrResetLedger(
    bot,
    { snapshot: { strategy: { id: 'previous-strategy' }, positions: [{ id: 'old-position' }] } },
    'current-strategy',
  );
  assert.equal(status, 'reset');
  assert.equal(bot.calls.restored, 0);
  assert.equal(bot.calls.flushed, 1);
  assert.equal(bot.calls.logs[0].details.type, 'LEDGER_RESET');
});

test('the simplified execution model resets the previous four-pair paper ledger', async () => {
  const bot = new CrossPairBot();
  const status = await restoreOrResetLedger(bot, {
    snapshot: {
      strategy: { id: 'btc-eth-four-pair-inverse-exit-tpsl-paper' },
      positions: [{ id: 'old-position' }],
      account: { cash: 5298 },
    },
  }, CrossPairBot.STRATEGY.id);
  assert.equal(status, 'reset');
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.orders.length, 0);
  assert.equal(bot.crossPairCycles.length, 0);
  assert.equal(bot.cash, require('../config').DEMO_CAPITAL);
  const saved = bot.exportLedger();
  const nextBot = new CrossPairBot();
  assert.equal(await restoreOrResetLedger(nextBot, saved, CrossPairBot.STRATEGY.id), 'restored');
});
