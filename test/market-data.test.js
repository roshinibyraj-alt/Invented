'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPolymarketMarkets } = require('../arb-market-data');

test('Polymarket discovery uses Gamma keyset cursor instead of oversized offsets', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async url => {
    urls.push(String(url));
    if (urls.length === 1) return {
      ok: true,
      json: async () => ({ markets: [{ id: 'first' }], next_cursor: 'cursor-1' }),
    };
    return { ok: true, json: async () => ({ markets: [{ id: 'second' }], next_cursor: '' }) };
  };
  try {
    const rows = await getPolymarketMarkets();
    assert.deepEqual(rows.map(x => x.id), ['first', 'second']);
    assert.match(urls[0], /\/markets\/keyset\?/);
    assert.match(urls[1], /after_cursor=cursor-1/);
    assert.doesNotMatch(urls.join('&'), /offset=/);
  } finally {
    global.fetch = originalFetch;
  }
});

