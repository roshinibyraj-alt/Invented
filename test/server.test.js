'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startServer = require('../server');

test('state endpoint returns the current strategy with no cache', async t => {
  const expected = { mode: 'DEMO ONLY', strategy: { id: 'btc-5m-combined-orderflow-accumulation' } };
  const server = startServer({ snapshot: () => expected }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state?ts=123`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('dashboard state route serves the same live strategy snapshot', async t => {
  const expected = { mode: 'DEMO ONLY', strategy: { id: 'btc-5m-combined-orderflow-accumulation' } };
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

test('dashboard serves the BTC/ETH 5-minute cross-pair strategy', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Invented/);
  assert.match(html, /Four cross-pairs/);
  assert.match(html, /Entry proof/);
  assert.match(html, /Performance, market detail, fill checks, and history/);
  assert.match(html, /BTC UP \+ ETH DOWN, ETH UP \+ BTC DOWN, BTC UP \+ ETH UP, and BTC DOWN \+ ETH DOWN/);
  assert.match(html, /Inverse-pair exits \+ ask-sum entries/);
  assert.match(html, /below \$0\.80/);
  assert.match(html, /Always buy 100 shares on each leg/);
  assert.match(html, /regardless of previous wins or losses/);
  assert.match(html, /History is saved in persistent Railway storage/);
  assert.match(html, /Paper taker sweeps are capped at \$0\.99/);
  assert.match(html, /Exit one pair without forcing its inverse to sell/);
  assert.match(html, /\$1 per remaining share/);
  assert.match(html, /empty fresh bid book counts as a \$0 stop/i);
  assert.match(html, /inverse enters only when its own fresh asks are below \$0\.80/i);
  assert.match(html, /Official result checked every/);
  assert.match(html, /Last pre-resolution mark/);
  assert.match(html, /pair-grid/);
  assert.match(html, /Recent trades/);
  assert.match(html, /official resolution/);
  assert.match(html, /SIMULATION ONLY/);
  assert.match(html, /positionList/);
  assert.match(html, /orderList/);
  assert.match(html, /eventList/);
  assert.ok(html.indexOf('aria-label="Paper account summary"') < html.indexOf('id="positionsHeading"'));
  assert.ok(html.indexOf('id="positionsHeading"') < html.indexOf('aria-label="Performance"'));
  assert.match(html, /id="feedStatus"/);
  assert.ok(html.indexOf('aria-label="Market activity"') > html.indexOf('aria-labelledby="strategyHeading"'));
  assert.ok(html.indexOf('aria-label="Market activity"') < html.indexOf('<footer>'));
});

test('unknown dashboard paths still return 404', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/not-a-route`);
  assert.equal(response.status, 404);
});
