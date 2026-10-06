'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchResolvedOutcomeBySlug, parseResolvedOutcome } = require('../polymarket-market');

test('Gamma final binary prices map to the correct UP and DOWN payouts', () => {
  const result = parseResolvedOutcome({
    closed: true,
    umaResolutionStatus: 'resolved',
    outcomes: '["Up","Down"]',
    outcomePrices: '["0","1"]',
  });

  assert.deepEqual(result, {
    resolved: true,
    winningSide: 'DOWN',
    payoutPerShare: { UP: 0, DOWN: 1 },
  });
});

test('open, proposed, or non-binary prices are not treated as final', () => {
  const base = {
    outcomes: ['Up', 'Down'],
    outcomePrices: ['0.995', '0.005'],
  };
  assert.equal(parseResolvedOutcome({
    ...base, closed: false, umaResolutionStatus: 'proposed',
  }).resolved, false);
  assert.equal(parseResolvedOutcome({
    ...base, closed: true, umaResolutionStatus: 'proposed',
  }).resolved, false);
  assert.equal(parseResolvedOutcome({
    ...base, closed: true, umaResolutionStatus: 'resolved',
  }).resolved, false);
});

test('Gamma slug lookup returns a resolved payout when the market is final', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    assert.match(String(url), /\/events\?slug=btc-updown-5m-12345$/);
    return {
      ok: true,
      json: async () => [{
        markets: [{
          closed: true,
          umaResolutionStatus: 'resolved',
          outcomes: ['Up', 'Down'],
          outcomePrices: ['1', '0'],
        }],
      }],
    };
  };

  assert.deepEqual(await fetchResolvedOutcomeBySlug('btc-updown-5m-12345'), {
    resolved: true,
    winningSide: 'UP',
    payoutPerShare: { UP: 1, DOWN: 0 },
  });
});
