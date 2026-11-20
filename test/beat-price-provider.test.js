'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BeatPriceProvider = require('../beat-price-provider');

const target = Math.floor(Date.now() / 60_000) * 60_000;

test('uses a timestamped Chainlink report close to market start', async () => {
  const provider = new BeatPriceProvider({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        reports: [{ timestamp: new Date(target).toISOString(), price: 62_500.25 }],
      }),
    }),
  });
  const beat = await provider.getAtTimestamp(target);
  assert.equal(beat.value, 62_500.25);
  assert.equal(beat.source, 'CHAINLINK_DATA_STREAMS');
  assert.equal(beat.exact, true);
});

test('labels CoinGecko fallback as an approximate proxy after Chainlink is challenged', async () => {
  const calls = [];
  const provider = new BeatPriceProvider({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return { ok: false, status: 429 };
      return {
        ok: true,
        json: async () => ({ prices: [[target, 62_499.75]] }),
      };
    },
  });
  const beat = await provider.getAtTimestamp(target);
  assert.equal(calls.length, 2);
  assert.equal(beat.value, 62_499.75);
  assert.equal(beat.source, 'COINGECKO_PROXY');
  assert.equal(beat.exact, false);
  assert.match(beat.note, /not the Chainlink resolution feed/i);
  assert.equal(beat.chainlinkError, 'Chainlink HTTP 429');
});

test('does not substitute a current spot quote when recent market-start history is missing', async () => {
  const calls = [];
  const provider = new BeatPriceProvider({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return { ok: false, status: 429 };
      return { ok: true, json: async () => ({ prices: [] }) };
    },
  });
  const beat = await provider.getAtTimestamp(target);
  assert.equal(calls.length, 2);
  assert.equal(beat.value, null);
  assert.equal(beat.source, null);
});

test('does not request a spot quote for a market start after historical data is unavailable', async () => {
  const calls = [];
  const provider = new BeatPriceProvider({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return { ok: false, status: 429 };
      return { ok: true, json: async () => ({ prices: [] }) };
    },
  });
  const beat = await provider.getAtTimestamp(target);
  assert.equal(calls.length, 2);
  assert.equal(beat.value, null);
  assert.equal(beat.source, null);
});

test('rejects historical prices that are too far from the requested market start', async () => {
  const provider = new BeatPriceProvider({
    fetchImpl: async (url) => {
      if (String(url).includes('data.chain.link')) {
        return { ok: false, status: 429 };
      }
      if (String(url).includes('coingecko')) {
        return { ok: true, json: async () => ({ prices: [[target + 120_000, 62_000]] }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const beat = await provider.getAtTimestamp(target);
  assert.equal(beat.value, null);
  assert.equal(beat.source, null);
  assert.match(beat.error, /No historical BTC price/);
});
