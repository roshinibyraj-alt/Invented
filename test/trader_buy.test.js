'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { placeBuy } = require('../trader_buy');

test('worker buy path sends a $16 stake and retains the window deadline', async () => {
  const calls = [];
  const trader = {
    book: async () => ({ bestAsk: 0.47 }),
    clob: { getTickSize: async () => '0.01' },
    buy: async (...args) => {
      calls.push(args);
      return { filled: true, status: 'matched' };
    },
  };
  const closeTs = Date.now() / 1000 + 300;
  const args = {
    tokenId: 'up-token', referenceAsk: 0.47,
    budgetUsd: 16, closeTs, slippage: 0.30,
  };
  const result = await placeBuy(trader, args);
  assert.equal(result.budgetUsd, 16);
  assert.deepEqual(calls, [['up-token', 0.99, 16, closeTs * 1000]]);
  assert.equal((await placeBuy(trader, { ...args, budgetUsd: 0 })).status, 'BUDGET_OUT_OF_RANGE');
  assert.equal(calls.length, 1);
});