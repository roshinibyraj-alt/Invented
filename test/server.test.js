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

test('dashboard explains reversed entries, no early sells, and resolution-only exits', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.indexOf('Current Polymarket books') < html.indexOf('Paper equity'));
  assert.match(html, /Invented · BTC 5-minute/);
  assert.match(html, /Independent-side pressure bot/i);
  assert.match(html, /three one-second checks/i);
  assert.match(html, /last five seconds/i);
  assert.match(html, /100 shares per signal/i);
  assert.match(html, /An UP signal sweeps visible DOWN asks for 100 shares/i);
  assert.match(html, /No early sells/i);
  assert.match(html, /There are no opposite-signal sells, take-profit orders, or stop-loss exits/i);
  assert.match(html, /official resolution/i);
  assert.match(html, /state\.signal\?\.signalSide && state\.signal\?\.buySide/);
  assert.match(html, /Every newly confirmed UP signal market-buys DOWN/i);
  assert.match(html, /partial fills are allowed/i);
  assert.match(html, /There is no entry-price floor or ceiling/i);
  assert.match(html, /Only market-entry taker fees are modeled/i);
  assert.match(html, /PAPER_MARKET_BUY/);
  assert.match(html, /Completed-window win rate/i);
  assert.doesNotMatch(html, /PAPER_MARKET_OPPOSITE_SIGNAL_EXIT/);
  assert.doesNotMatch(html, /PAPER_LIMIT_TAKE_PROFIT|PAPER_STOP_LOSS/);
  assert.doesNotMatch(html, /0\.99|0\.01/);
  assert.match(html, /Waiting for official resolution/i);
  assert.match(html, /current-window UP and DOWN boxes/i);
  assert.match(html, /official resolution/i);
  assert.match(html, /PAPER ONLY/);
  assert.match(html, /Binance BTCUSDT aggregate-trade WebSocket/);
  assert.match(html, /Polymarket CLOB books and trades/);
  assert.match(html, /Recent orders/);
  assert.doesNotMatch(html, /Global equity curve/i);
  assert.doesNotMatch(html, /Position history/i);
  assert.doesNotMatch(html, /Bot activity/i);
  assert.doesNotMatch(html, /BTC &amp; ETH Signal Desk/);
  assert.doesNotMatch(html, /two fresh Binance updates/i);
});

test('unknown dashboard paths still return 404', async t => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/not-a-route`);
  assert.equal(response.status, 404);
});
