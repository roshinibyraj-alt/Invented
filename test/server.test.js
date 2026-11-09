'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startServer = require('../server');

test('state endpoint returns the current strategy with no cache', async t => {
  const expected = { mode: 'DEMO ONLY', strategy: { id: 'btc-eth-cross-pair-arbitrage' } };
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

test('dashboard shows all cross-pair entry tiers and resolution-only exits', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /BTC × ETH Cross-Pair Arbitrage/);
  assert.match(html, /combined asks &lt; \$0\.90/);
  assert.match(html, /combined asks ≤ \$0\.80, \$0\.70, \$0\.60, and \$0\.50/);
  assert.match(html, /No intra-window selling/);
  assert.match(html, /BTC UP \+ ETH DOWN/);
  assert.match(html, /ETH UP \+ BTC DOWN/);
  assert.match(html, /300 per leg at combined asks/);
  assert.match(html, /fully fill at or below \$0\.99 per share/);
  assert.match(html, /that tier books no shares and retries/);
  assert.match(html, /Recent activity/);
  assert.match(html, /Entry tier/);
  assert.match(html, /No raw event payloads/);
  assert.match(html, /exact original BTC or ETH market/);
  assert.doesNotMatch(html, /BTC Strategy Lab/);
  assert.doesNotMatch(html, /combined bids.*sell/i);
  assert.doesNotMatch(html, /exit on bids/i);
  assert.doesNotMatch(html, /Against signal/);
  assert.doesNotMatch(html, /57-second/);
  assert.doesNotMatch(html, /Chainlink/);
});

test('unknown dashboard paths still return 404', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/not-a-route`);
  assert.equal(response.status, 404);
});
