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

test('dashboard shows two independent strategy portfolios with separate equity curves',async(t)=>{
  const server=startServer({snapshot:()=>({})},0);
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html=await response.text();
  assert.equal(response.status,200);
  assert.match(html,/Highest consecutive strategy wins/);
  assert.match(html,/Highest consecutive strategy losses/);
  assert.match(html,/BTC Strategy Lab/);
  assert.match(html,/separate \$10,000 demo accounts/);
  assert.match(html,/Independent strategy portfolios/);
  assert.match(html,/strategy-panels/);
  assert.match(html,/Equity curve/);
  assert.match(html,/id==='prebuy-5m'/);
  assert.match(html,/s\.strategies/);
  assert.match(html,/equitySvg\(a\.equityCurve\)/);
  assert.match(html,/strategyId/);
  assert.match(html,/Taker fees paid/);
  assert.match(html,/Profitable exits/);
  assert.match(html,/Losing exits/);
  assert.match(html,/Break-even exits/);
  assert.match(html,/From 4:00 to window end/);
  assert.match(html,/300-share UP and DOWN limit buys at \$0\.20 and \$0\.10/);
  assert.match(html,/matching \$0\.80 and \$0\.90 take-profit sells/);
  assert.match(html,/either side's fresh best ask is strictly above \$0\.32 and below \$0\.70/);
  assert.match(html,/final 57 seconds/);
  assert.match(html,/market-buys 500 shares on that side two seconds before open/);
  assert.match(html,/places a \$0\.99 limit sell at window open \(counted as \$1 per share\)/);
  assert.match(html,/Strategy two has no stop loss/);
  assert.match(html,/limit sell at window open; counts as \$1\/share; no stop loss/);
  assert.match(html,/equal or lower means red\/DOWN/);
  assert.match(html,/move to \$0\.99, counted as \$1 per share/);
  assert.match(html,/takerFees/);
  assert.match(html,/Accumulated \$\{side\}/);
  assert.match(html,/inventoryCard\('UP',inventory\.UP,'up'\)/);
  assert.match(html,/inventoryCard\('DOWN',inventory\.DOWN,'down'\)/);
  assert.match(html,/Cost basis incl\. fees/);
  assert.match(html,/500 shares on the candle-signaled side/);
  assert.match(html,/maxConsecutiveWins/);
  assert.match(html,/maxConsecutiveLosses/);
  assert.match(html,/official Polymarket resolution/);
  assert.doesNotMatch(html,/strictly above \$0\.42 and below \$0\.59/);
  assert.doesNotMatch(html,/market stop-loss/);
  assert.doesNotMatch(html,/15m/);
  assert.doesNotMatch(html,/1\.5×/);
  assert.doesNotMatch(html,/Order activity/);
  assert.doesNotMatch(html,/Recent bot events/);
});
