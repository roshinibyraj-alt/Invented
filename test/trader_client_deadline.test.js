'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Only the method's clock/metadata behavior is under test. Stub SDK imports
// so this regression runs without exchange packages or credentials locally.
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'viem/accounts') return { privateKeyToAccount: () => ({}) };
  if (request === 'viem') return { createWalletClient: () => ({}), http: () => ({}) };
  if (request === 'viem/chains') return { polygon: {} };
  if (request === '@polymarket/clob-client-v2') {
    return { ClobClient: class {}, AssetType: {}, Side: { BUY: 'BUY' }, OrderType: { FAK: 'FAK' } };
  }
  if (request === '@polymarket/builder-relayer-client') return { RelayClient: class {} };
  return load.call(this, request, parent, isMain);
};
let PolymarketTrader;
try {
  PolymarketTrader = require('../trader_client');
} finally {
  Module._load = load;
}

test('a buy is not submitted when metadata lookup finishes after the window closes', async () => {
  const trader = Object.create(PolymarketTrader.prototype);
  let resolveNegRisk;
  let signalNegRisk;
  const negRiskStarted = new Promise((resolve) => { signalNegRisk = resolve; });
  let posts = 0;
  trader.clob = {
    getTickSize: async () => '0.01',
    getNegRisk: () => {
      signalNegRisk();
      return new Promise((resolve) => { resolveNegRisk = resolve; });
    },
    createAndPostMarketOrder: async () => { posts += 1; },
  };
  const closeMs = Date.now() + 60_000;
  const buy = trader.buy('token', 0.49, 1, closeMs);
  await negRiskStarted;
  const actualNow = Date.now;
  try {
    Date.now = () => closeMs;
    resolveNegRisk(false);
    const result = await buy;
    assert.equal(result.status, 'WINDOW_CLOSED');
    assert.equal(result.filled, false);
    assert.equal(posts, 0);
  } finally {
    Date.now = actualNow;
  }
});