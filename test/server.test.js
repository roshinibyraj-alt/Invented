'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const startServer = require('../server');

test('state endpoint accepts the dashboard cache-buster query string', async (t) => {
  const expected = { mode: 'DEMO', account: { capital: 1000 } };
  const server = startServer({ snapshot: () => expected }, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/state?ts=123');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('unknown dashboard paths still return 404', async (t) => {
  const server = startServer({ snapshot: () => ({}) }, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/not-a-route');
  assert.equal(response.status, 404);
});

test('health endpoint returns demo service status without exposing secrets', async (t) => {
  const server = startServer({ snapshot: () => ({ mode: 'DEMO ONLY', status: 'scanning', now: 123 }) }, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: 'DEMO', status: 'scanning', now: 123 });
});

test('real-balance proxy returns the upstream account summary',async(t)=>{
  const expected={status:'ready',collateral:125,positionValue:40,equity:165,positionCount:2};
  const server=startServer({snapshot:()=>({})},0,async()=>{
    return{ok:true,json:async()=>expected};
  });
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/real-balance`);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),expected);
});

test('dashboard shows both BTC windows, the scheduled strategy, and fee metrics',async(t)=>{
  const server=startServer({snapshot:()=>({})},0);
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html=await response.text();
  assert.equal(response.status,200);
  assert.match(html,/Highest consecutive strategy wins/);
  assert.match(html,/Highest consecutive strategy losses/);
  assert.match(html,/BTC 5m \/ 15m Scheduled Paper Bot/);
  assert.match(html,/\$10,000 total demo capital/);
  assert.match(html,/Taker fees paid/);
  assert.match(html,/minute 0 to 1/);
  assert.match(html,/minute 1 to 3/);
  assert.match(html,/1\.5× the prior interval size/);
  assert.match(html,/15-minute bot scales all times and intervals by 3/);
  assert.match(html,/resting \$0\.99 take-profit, counted as \$1 per share/);
  assert.match(html,/takerFees/);
  assert.match(html,/Accumulated \$\{side\}/);
  assert.match(html,/inventoryCard\('UP',inventory\.UP,'up'\)/);
  assert.match(html,/inventoryCard\('DOWN',inventory\.DOWN,'down'\)/);
  assert.match(html,/Cost basis incl\. fees/);
  assert.match(html,/MARKET BUY/);
  assert.match(html,/maxConsecutiveWins/);
  assert.match(html,/maxConsecutiveLosses/);
  assert.match(html,/official Polymarket resolution/);
  assert.doesNotMatch(html,/market stop-loss/);
  assert.doesNotMatch(html,/Limit Ladder/);
  assert.doesNotMatch(html,/Order activity/);
  assert.doesNotMatch(html,/Recent bot events/);
});
