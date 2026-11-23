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

test('closed-pair log endpoint returns paginated history without caching', async t => {
  let requestedPage = null;
  const expected = { records: [{ id: 'pair-cycle-1', realizedPnl: 12.5 }], total: 21, offset: 20, hasMore: false };
  const server = startServer({
    snapshot: () => ({}),
    closedPairLogPage: (limit, offset) => {
      requestedPage = { limit, offset };
      return expected;
    },
  }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/closed-pair-logs?limit=5&offset=20`);
  assert.equal(response.status, 200);
  assert.deepEqual(requestedPage, { limit: 5, offset: 20 });
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('closed-pair log endpoint rejects invalid pagination', async t => {
  const server = startServer({ snapshot: () => ({}), closedPairLogPage: () => ({ records: [] }) }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/closed-pair-logs?limit=1000&offset=-1`);
  assert.equal(response.status, 400);
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
  assert.match(html, /Mixed-direction pairs/);
  assert.match(html, /Entry proof/);
  assert.match(html, /Closed pair log/);
  assert.match(html, /closed-pair-logs/);
  assert.match(html, /Last 5 windows · P&amp;L/);
  assert.match(html, /windowPnlHistory/);
  assert.match(html, /Closed windows show realized net/);
  assert.match(html, /Performance, market detail, fill checks, and history/);
  assert.match(html, /BTC UP \+ ETH DOWN and ETH UP \+ BTC DOWN remain enabled/);
  assert.match(html, /Two mixed pairs \+ ask-sum entries/);
  assert.match(html, /below \$0\.80/);
  assert.match(html, /Always buy 100 shares on each leg/);
  assert.match(html, /regardless of previous wins or losses/);
  assert.match(html, /History is saved in persistent Railway storage/);
  assert.match(html, /Paper taker sweeps are capped at \$0\.99/);
  assert.match(html, /Exit one pair without forcing its inverse to sell/);
  assert.match(html, /\$1 per remaining share/);
  assert.match(html, /empty fresh bid book counts as a \$0 stop/i);
  assert.match(html, /other enabled mixed pair remains independent/i);
  assert.match(html, /Official result checked every/);
  assert.match(html, /Last pre-resolution mark/);
  assert.match(html, /pair-grid/);
  assert.match(html, /Recent trades/);
  assert.match(html, /official resolution/);
  assert.match(html, /SIMULATION ONLY/);
  assert.match(html, /positionList/);
  assert.match(html, /orderList/);
  assert.match(html, /closedTradeList/);
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
