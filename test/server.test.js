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

test('dashboard shows the limit-ladder strategy and both highest-streak metrics',async(t)=>{
  const server=startServer({snapshot:()=>({})},0);
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html=await response.text();
  assert.equal(response.status,200);
  assert.match(html,/Highest consecutive strategy wins/);
  assert.match(html,/Highest consecutive strategy losses/);
  assert.match(html,/TP missed by window end/);
  assert.match(html,/LOSS · TP not hit by window end/);
  assert.doesNotMatch(html,/LOSS · TP missed by expiry/);
  assert.match(html,/180 seconds after placement/);
  assert.match(html,/maxConsecutiveWins/);
  assert.match(html,/maxConsecutiveLosses/);
  assert.match(html,/four independent resting limit buys/);
  assert.match(html,/\$0\.10 entry → \$0\.20 TP/);
  assert.match(html,/official Polymarket resolution/);
  assert.doesNotMatch(html,/market stop-loss/);
});
