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

test('dashboard uses the Pumpfun-style layout and explains cheaper-leg entries', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /BTC <span>×<\/span> ETH Cheapest-Leg Bot/);
  assert.match(html, /5-minute paper strategy · combined-ask triggers · buy only the cheaper leg/);
  assert.match(html, /Trigger on the combined asks; buy only the cheaper leg at trigger/);
  assert.match(html, /Equal asks select the first-listed leg/);
  assert.match(html, /opposite route pauses on this rung/);
  assert.match(html, /Combined ask/);
  assert.match(html, /no in-window exits/);
  assert.match(html, /Current 5-minute window/);
  assert.match(html, /Awaiting Polymarket resolution/);
  assert.match(html, /Floating P&amp;L uses fresh best bids/);
  assert.match(html, /Realized P&amp;L/);
  assert.match(html, /Position records/);
  assert.match(html, /Activity/);
  assert.match(html, /cheaper leg at trigger/);
  assert.match(html, /exact-market resolution/);
  assert.match(html, /fresh best bids/);
  assert.doesNotMatch(html, /buy 100 shares on both legs/i);
  assert.doesNotMatch(html, /both 100-share fills/i);
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
