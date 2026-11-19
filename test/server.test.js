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

test('dashboard explains same-side entries, profit-only exits, TP/SL, and resolution rules', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.indexOf('Current Polymarket books') < html.indexOf('Paper equity'));
  assert.match(html, /Invented · BTC 5-minute/);
  assert.match(html, /Order-flow profit-exit bot/i);
  assert.match(html, /three one-second checks/i);
  assert.match(html, /last five seconds/i);
  assert.match(html, /100 shares per same-side signal/i);
  assert.match(html, /An UP signal buys UP; a DOWN signal buys DOWN/i);
  assert.match(html, /An opposite signal can only sell the current position/i);
  assert.match(html, /Opposite signal: profit exit only/i);
  assert.match(html, /state\.signal\?\.signalSide && state\.signal\?\.buySide/);
  assert.match(html, /resting buy/i);
  assert.match(html, /fresh midpoint drops at least \$0\.01 below it/i);
  assert.match(html, /modeled taker fee/i);
  assert.match(html, /OPPOSITE SIGNAL BLOCKED/);
  assert.match(html, /PAPER_MARKET_OPPOSITE_SIGNAL_EXIT/);
  assert.match(html, /Global equity curve/i);
  assert.match(html, /Completed-window win rate/i);
  assert.match(html, /estimated maker rebates/i);
  assert.match(html, /0\.99/);
  assert.match(html, /0\.01/);
  assert.match(html, /Waiting for official resolution/i);
  assert.match(html, /current-window UP and DOWN boxes/i);
  assert.match(html, /official resolution/i);
  assert.match(html, /PAPER ONLY/);
  assert.match(html, /Binance BTCUSDT aggregate-trade WebSocket/);
  assert.match(html, /Polymarket CLOB books and trades/);
  assert.match(html, /Recent orders/);
  assert.match(html, /Bot activity/);
  assert.doesNotMatch(html, /BTC &amp; ETH Signal Desk/);
  assert.match(html, /Opposite signal: profit exit only/i);
  assert.doesNotMatch(html, /two fresh Binance updates/i);
});

test('unknown dashboard paths still return 404', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/not-a-route`);
  assert.equal(response.status, 404);
});
