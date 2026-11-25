'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {feeEquivalent, summarizeMakerRebates} = require('../maker-rebates');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
test('crypto fee equivalent changes with price and market category', () => {
  near(feeEquivalent('BTC', 100, .4), 1.2);
  near(feeEquivalent('BTC', 100, .3), 1.05);
  near(feeEquivalent('BTC', 100, .35), 1.1375);
  near(feeEquivalent('BTC', 100, .5), 1.25);
  near(feeEquivalent('BTC', 100, .6), 1.2);
  near(feeEquivalent('ETH', 100, .4), .24);
});
test('only actual filled quantities count, including partial TP sells', () => {
  const orders = [
    {asset:'BTC',filledShares:20,soldShares:10,limitPrice:.4,tpPrice:.6},
    {asset:'ETH',filledShares:100,soldShares:0,limitPrice:.35,tpPrice:.65},
    {asset:'BTC',filledShares:0,soldShares:0,limitPrice:.3,tpPrice:.7},
  ];
  const result = summarizeMakerRebates(orders);
  near(result.byAsset.BTC.buy, .24);
  near(result.byAsset.BTC.sell, .12);
  near(result.feeEquivalent, .5875);
  near(result.scenarios.find(s=>s.rate===.03).amount, .017625);
  assert.equal(result.actualReceived, 0);
  assert.equal(result.includedInEquity, false);
  assert.deepEqual(result, summarizeMakerRebates(JSON.parse(JSON.stringify(orders))));
});
test('invalid fill prices cannot produce invented rebates', () => {
  assert.throws(()=>feeEquivalent('BTC',100,1));
  assert.throws(()=>feeEquivalent('BTC',-1,.4));
  assert.throws(()=>feeEquivalent('SOL',100,.4));
});
