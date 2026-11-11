'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startServer = require('../server');

test('state endpoint returns the current strategy with no cache', async t => {
  const expected = { mode: 'DEMO ONLY', strategy: { id: 'opening-range-breakout' } };
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

test('dashboard explains the opening-range breakout and paper risk rules', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Invented · BTC &amp; ETH Signal Desk/);
  assert.match(html, /Opening-range/);
  assert.match(html, /two completed Binance 1-minute candles/i);
  assert.match(html, /1\.25×/);
  assert.match(html, /\$15 including fees per asset/i);
  assert.match(html, /full visible ask depth/i);
  assert.match(html, /in-window sells/i);
  assert.match(html, /Ask band \$0\.35–\$0\.65/);
  assert.match(html, /not a probability/i);
  assert.match(html, /Recent activity/);
  assert.match(html, /Paper equity/);
  assert.match(html, /Positions/);
  assert.match(html, /exact-market resolution/);
  assert.doesNotMatch(html, /Next Candle Predictor/i);
  assert.doesNotMatch(html, /WickyWackyTrader/i);
  assert.doesNotMatch(html, /combined.ask rungs/i);
  assert.match(html, /No martingale/i);
});

test('unknown dashboard paths still return 404', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/not-a-route`);
  assert.equal(response.status, 404);
});
