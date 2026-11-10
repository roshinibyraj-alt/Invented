'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startServer = require('../server');

test('state endpoint returns the current strategy with no cache', async t => {
  const expected = { mode: 'DEMO ONLY', strategy: { id: 'btc-eth-next-candle-predictor' } };
  const server = startServer({ snapshot: () => expected }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state?ts=123`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('health endpoint reports the demo service without secrets', async t => {
  const server = startServer({ snapshot: () => ({ mode: 'DEMO ONLY', status: 'scanning', now: 123 }) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: 'DEMO', status: 'scanning', now: 123 });
});

test('dashboard explains separate candle signals and exact entry rules', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Invented · BTC &amp; ETH Signal Desk/);
  assert.match(html, /WickyWackyTrader Next Candle Predictor/);
  assert.match(html, /DIRECTIONAL SCORE/);
  assert.match(html, /not a probability/i);
  assert.match(html, /00:00–00:59/);
  assert.match(html, /below \$0\.40/);
  assert.match(html, /\$0\.60 or less/);
  assert.match(html, /full visible ask-depth/i);
  assert.match(html, /no in-window sells/i);
  assert.match(html, /five completed Binance 5-minute candles/);
  assert.match(html, /Latest relative volume/);
  assert.match(html, /Recent activity/);
  assert.match(html, /Paper equity/);
  assert.match(html, /Positions/);
  assert.match(html, /exact-market resolution/);
  assert.doesNotMatch(html, /cheapest leg/i);
  assert.doesNotMatch(html, /combined.ask rungs/i);
  assert.doesNotMatch(html, /buy 100 shares on both legs/i);
});

test('unknown dashboard paths still return 404', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/not-a-route`);
  assert.equal(response.status, 404);
});
