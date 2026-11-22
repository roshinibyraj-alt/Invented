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

test('dashboard puts paired history first and explains fixed-side entries', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Invented · BTC 5m \+ 15m/);
  assert.match(html, /Fixed-side window paper bot/i);
  assert.match(html, /First slot immediate · later slots price-triggered/i);
  assert.match(html, /Current positions/i);
  assert.match(html, /Floating P&amp;L/i);
  assert.match(html, /Buy DOWN in the new 5m market and UP in the active 15m market/i);
  assert.match(html, /slots two and three, wait for the 5m DOWN best ask to reach \$0\.40 or lower/i);
  assert.match(html, /first fresh 5m DOWN best ask at or below \$0\.40 arms the paired entry/i);
  assert.match(html, /Combined asks are not checked/i);
  assert.match(html, /Combined asks.*Not used as a filter/i);
  assert.match(html, /300 shares per leg/i);
  assert.match(html, /the two markets can resolve differently/i);
  assert.match(html, /Direction is fixed by timeframe/i);
  assert.match(html, /best bid of \$0\.99/i);
  assert.match(html, /modeled payout \$1\.00\/share/i);
  assert.match(html, /Fresh Polymarket CLOB WebSocket asks and enough visible depth up to \$0\.99 are still required/i);
  assert.doesNotMatch(html, /Chainlink Data Streams and timestamped CoinGecko history are fallback/i);
  assert.match(html, /Paired trade history/i);
  assert.match(html, /Strategy and feed details/i);
  assert.ok(html.indexOf('Paired trade history') < html.indexOf('Current positions'));
  assert.ok(html.indexOf('Current positions') < html.indexOf('Strategy and feed details'));
  assert.match(html, /PAPER ONLY/);
  assert.doesNotMatch(html, /100-share buys at \$0\.30|midpoint reaches \$0\.20|200 shares on the opposite side/);
});

test('unknown dashboard paths still return 404', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/not-a-route`);
  assert.equal(response.status, 404);
});
