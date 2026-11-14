'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startServer = require('../server');

test('state endpoint returns the current strategy with no cache', async t => {
  const expected = { mode: 'DEMO ONLY', strategy: { id: 'btc-5m-clob-midpoint-maker' } };
  const server = startServer({ snapshot: () => expected }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state?ts=123`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('dashboard state route serves the same live strategy snapshot', async t => {
  const expected = { mode: 'DEMO ONLY', strategy: { id: 'btc-5m-clob-midpoint-maker' } };
  const server = startServer({ snapshot: () => expected }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/strategy/state`);
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

test('health endpoint reports strategy errors as unhealthy', async t => {
  const server = startServer({ snapshot: () => ({ status: 'ERROR', now: 123 }) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/healthz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, mode: 'DEMO', status: 'ERROR', now: 123 });
});

test('dashboard explains the CLOB midpoint maker rules', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /CLOB FLOW/);
  assert.match(html, /Every second/i);
  assert.match(html, /5-share passive buy limit/i);
  assert.match(html, /Cancel the unfilled remainder after five seconds/i);
  assert.match(html, /midpoint minus \$0\.05/i);
  assert.match(html, /best ask reaches or falls below/i);
  assert.match(html, /Accumulated UP shares/i);
  assert.match(html, /Accumulated DOWN shares/i);
  assert.match(html, /upInventoryShares/);
  assert.match(html, /downAverageEntry/);
  assert.match(html, /Previous window holdings/i);
  assert.match(html, /previousWindowInventory/);
  assert.match(html, /post or resize a maker sell for held shares at \$0\.99/i);
  assert.match(html, /Estimated rebates/i);
  assert.match(html, /a \$0\.99 sell fill credits \$0\.99 per share/i);
  assert.match(html, /Polymarket CLOB/);
  assert.match(html, /Recent orders/);
  assert.match(html, /Activity feed/);
  assert.doesNotMatch(html, /Binance model inputs/i);
  assert.doesNotMatch(html, /BTC &amp; ETH Signal Desk/);
  assert.doesNotMatch(html, /profitable flip/i);
  assert.doesNotMatch(html, /two fresh Binance updates/i);
});

test('unknown dashboard paths still return 404', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/not-a-route`);
  assert.equal(response.status, 404);
});
