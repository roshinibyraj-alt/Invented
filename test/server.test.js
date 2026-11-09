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

test('dashboard shows same-direction leader-laggard tiers and resolution-only exits', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /BTC × ETH Same-Direction Price-Gap Bot/);
  assert.match(html, /BTC UP ↔ ETH UP · BTC DOWN ↔ ETH DOWN/);
  assert.match(html, /≥ \$0\.60 \/ &lt; \$0\.50; ≥ \$0\.70 \/ &lt; \$0\.60; ≥ \$0\.80 \/ &lt; \$0\.70; ≥ \$0\.90 \/ &lt; \$0\.80/);
  assert.match(html, /Buy 100 target shares per fire/);
  assert.match(html, /at or after 270 seconds/);
  assert.match(html, /No intra-window selling/);
  assert.doesNotMatch(html, /BTC UP \+ ETH DOWN/);
  assert.doesNotMatch(html, /ETH UP \+ BTC DOWN/);
  assert.match(html, /Current-window accumulated shares/);
  assert.match(html, /Accumulated shares awaiting resolution/);
  assert.match(html, /Floating P&amp;L/);
  assert.match(html, /Realized P&amp;L/);
  assert.match(html, /target asks and include modeled taker fees/);
  assert.match(html, /retry only while the signal remains valid/);
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
