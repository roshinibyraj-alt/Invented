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

test('dashboard shows only the BTC signal-limit paper strategy and removes the retired strategy',async(t)=>{
  const server=startServer({snapshot:()=>({})},0);
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html=await response.text();
  assert.equal(response.status,200);
  assert.match(html,/Highest consecutive strategy wins/);
  assert.match(html,/Highest consecutive strategy losses/);
  assert.match(html,/BTC Strategy Lab/);
  assert.match(html,/One BTC 5-minute paper strategy · \$10,000 demo account/);
  assert.match(html,/Demo account overview/);
  assert.match(html,/strategy-panels/);
  assert.match(html,/Equity curve/);
  assert.match(html,/id==='btc-5m-signal'/);
  assert.match(html,/s\.strategies/);
  assert.match(html,/equitySvg\(a\.equityCurve\)/);
  assert.match(html,/strategyId/);
  assert.match(html,/Taker fees paid/);
  assert.match(html,/Profitable exits/);
  assert.match(html,/Losing exits/);
  assert.match(html,/Break-even exits/);
  assert.match(html,/final 57 seconds/);
  assert.match(html,/At window open, place one \$0\.45 limit buy for 500 shares/);
  assert.match(html,/asks below \$0\.45 are already present when submitted/);
  assert.match(html,/later fills are recorded at \$0\.45/);
  assert.match(html,/no timeout or assumed fill/);
  assert.match(html,/Entry fills may receive an estimated maker rebate/);
  assert.match(html,/no take-profit or stop-loss exit/);
  assert.match(html,/original market’s official Polymarket resolution/);
  assert.doesNotMatch(html,/TP limit/);
  assert.doesNotMatch(html,/TAKE_PROFIT/);
  assert.match(html,/lower price only at submission/);
  assert.doesNotMatch(html,/fallback after 1s/);
  assert.doesNotMatch(html,/paper-fill the remainder/);
  assert.match(html,/equal or lower signals DOWN/);
  assert.match(html,/on the opposite side of the signal/);
  assert.match(html,/takerFees/);
  assert.match(html,/maxConsecutiveWins/);
  assert.match(html,/maxConsecutiveLosses/);
  assert.match(html,/official Polymarket resolution/);
  assert.doesNotMatch(html,/prebuy-5m/);
  assert.doesNotMatch(html,/trigger-5m/);
  assert.doesNotMatch(html,/two independent strategies/);
  assert.doesNotMatch(html,/300-share UP and DOWN limit buys/);
  assert.doesNotMatch(html,/market-buys 500 shares/);
  assert.doesNotMatch(html,/15m/);
  assert.doesNotMatch(html,/1\.5×/);
  assert.doesNotMatch(html,/Order activity/);
  assert.doesNotMatch(html,/Recent bot events/);
});
