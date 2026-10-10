'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isCryptoMarket, matchBinaryMarkets, sweepAsks, findArbitrage } = require('../arb-core');

test('crypto markets are excluded by title or category', () => {
  assert.equal(isCryptoMarket({ title: 'Bitcoin above $100k?' }), true);
  assert.equal(isCryptoMarket({ title: 'Who wins the election?', category: 'Crypto' }), true);
  assert.equal(isCryptoMarket({ title: 'Will the bill pass?', category: 'Politics' }), false);
});

test('only exact-title binary outcome matches are paired', () => {
  const poly = [{ id: 'p1', question: 'Will Bill 123 pass?', outcomes: ['Yes','No'], clobTokenIds: ['py','pn'] },
    { id: 'p2', question: 'Bitcoin up this week?', outcomes: ['Yes','No'], clobTokenIds: ['cy','cn'] }];
  const predict = [{ id: 'd1', title: 'Will Bill 123 pass?', outcomes: ['Yes','No'] },
    { id: 'd2', title: 'Will Bill 123 pass by Friday?', outcomes: ['Yes','No'] },
    { id: 'd3', title: 'Bitcoin up this week?', outcomes: ['Yes','No'] }];
  const pairs = matchBinaryMarkets(poly, predict);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].predict.id, 'd1');
});

test('duplicate titles on either venue are skipped instead of ambiguously paired', () => {
  const p = { question:'Will the bill pass?', outcomes:['Yes','No'], clobTokenIds:['y','n'] };
  const d = { id:'d', title:'Will the bill pass?', outcomes:['Yes','No'] };
  assert.deepEqual(matchBinaryMarkets([p,p], [d]), []);
  assert.deepEqual(matchBinaryMarkets([p], [d,d]), []);
});

test('official settlement values are read only when a market is resolved', () => {
  const { payoutFor } = require('../arb-bot');
  const m = { closed:true, outcomes:['Yes','No'], outcomePrices:['1','0'] };
  assert.equal(payoutFor(m, 'Yes'), 1);
  assert.equal(payoutFor(m, 'No'), 0);
  assert.equal(payoutFor({ closed:false, outcomes:['Yes','No'], outcomePrices:['1','0'] }, 'Yes'), null);
});

test('book sweep requires full equal-share depth and includes fees in edge', () => {
  const fill = sweepAsks([[0.4, 250], [0.42, 250]], 500, (p, q) => p * q * 0.01);
  assert.equal(fill.filledShares, 500);
  assert.equal(fill.remainingShares, 0);
  assert.equal(fill.totalCost, 207.05);
});

test('arbitrage direction fires only at or above the 3-cent all-in gap', () => {
  const pair = { labels: ['yes','no'], poly: { outcomes: { yes:'py', no:'pn' } },
    predict: { outcomes: { yes:'dy', no:'dn' } } };
  const books = { poly: { py:[[0.40,500]], pn:[[0.95,500]] },
    predict: { dy:[[0.62,500]], dn:[[0.55,500]] } };
  const hits = findArbitrage(pair, books, { shares:500, minEdge:0.03 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direction, 'POLY yes + PREDICT no');
  assert.ok(hits[0].edgePerShare >= 0.03);
});

test('market with insufficient depth is not treated as a qualifying pair', () => {
  const pair = { labels: ['yes','no'], poly: { outcomes: { yes:'py', no:'pn' } },
    predict: { outcomes: { yes:'dy', no:'dn' } } };
  const books = { poly: { py:[[0.4,200]], pn:[] }, predict: { dy:[[0.4,500]], dn:[[0.5,500]] } };
  assert.deepEqual(findArbitrage(pair, books, { shares:500, minEdge:0.03 }), []);
});
