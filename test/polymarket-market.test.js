'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTokenIds } = require('../polymarket-market');

test('market metadata maps UP and DOWN outcome labels to their own CLOB token IDs', () => {
  assert.deepEqual(extractTokenIds({
    outcomes: '["Down","Up"]',
    clobTokenIds: '["down-token","up-token"]',
  }), { tokenUp: 'up-token', tokenDown: 'down-token' });
});

test('market metadata can identify YES/NO token IDs when that is how outcomes are labeled', () => {
  assert.deepEqual(extractTokenIds({
    outcomes: ['No', 'Yes'],
    clobTokenIds: ['no-token', 'yes-token'],
  }), { tokenUp: 'yes-token', tokenDown: 'no-token' });
});
