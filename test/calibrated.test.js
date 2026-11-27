'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CalibratedBot, buyPlan, quote } = require('../calibrated-bot');
const Worker = require('../calibrated-worker');
const { restoreOrResetLedger } = require('../index');
const START = 1800000000000;
function setup() {
  let now = START + 61000;
  const p = { pUp: .8, pDown: .2, windowStart: START, observedAt: START+60000,
    validUntil: START+120000, writtenAt: START+61000, rawUp: .85, accepted: true };
  const worker = { prediction: (tf,start) => start === p.windowStart && now<p.validUntil ? p : null,
    snapshot: () => ({ status: 'RUNNING' }) };
  const bot = new CalibratedBot({ worker, now: () => now });
  const market = { id:'m5', start:START, end:START+300000, slug:'s', tokens:{UP:'u',DOWN:'d'},
    feesEnabled:true, feeSchedule:{rate:.05,exponent:1} };
  const r = bot.records['5m']; r.market=market; r.targetStart=START;
  function book(side='UP', price=.4, size=200) {
    r.quotes[side] = quote({asset_id:market.tokens[side],timestamp:String(now),
      asks:[{price,size}],bids:[{price:price-.01,size}]},market,side,now);
  }
  return {bot,r,p,market,book,setNow(n){now=n;},get now(){return now;}};
}
test('full-size depth sweep accounts for fees and weighted entry', () => {
  const q={bestAsk:.4,asks:[{price:.4,size:20},{price:.42,size:50}]};
  const fill=buyPlan(q,.8,3000,.05,1);
  assert.equal(fill.shares,50); assert.equal(fill.cost,20*.4+30*.42);
  assert.equal(fill.fees,Number((20*.05*.4*.6).toFixed(5))+Number((30*.05*.42*.58).toFixed(5)));
  assert.ok(fill.netEdge>=.04);
});
test('target size is reduced to the two-percent cash budget', () => {
  const fill=buyPlan({bestAsk:.7,asks:[{price:.7,size:100}]},.8,1500,.05);
  assert.ok(fill.shares<50); assert.ok(fill.cost+fill.fees<=30);
});
test('bad edge, confidence, fees and zero cash never force entries', () => {
  const q={bestAsk:.7,asks:[{price:.7,size:100}]};
  for(const args of [[.72,1500,.05],[.57,1500,.05],[.9,0,.05],[.9,1500,NaN]]) {
    assert.equal(buyPlan(q,...args),null);
  }
});
test('depth sweep excludes levels that remove the net edge', () => {
  const fill=buyPlan({bestAsk:.4,asks:[{price:.4,size:10},{price:.79,size:100}]},.8,1500,.05);
  assert.equal(fill.shares,10); assert.equal(fill.fills.length,1);
});
test('book rejects wrong token, stale timestamp, and missing timestamp', () => {
  const f=setup();
  for(const book of [{asset_id:'wrong',timestamp:f.now},{asset_id:'u',timestamp:f.now-11000},{asset_id:'u'}]) {
    assert.throws(()=>quote(book,f.market,'UP',f.now));
  }
});
test('requires a subsequent fresh book after simulated latency before entry', () => {
  const f=setup(); f.book(); f.bot.consider('5m',f.now);
  assert.equal(f.bot.accounts['5m'].positions.length,0);
  f.setNow(f.now+2000); f.bot.consider('5m',f.now);
  assert.equal(f.bot.accounts['5m'].positions.length,0);
  f.book(); f.bot.consider('5m',f.now);
  assert.equal(f.bot.accounts['5m'].positions.length,1);
});
test('pending entry cancels when executable price loses its edge', () => {
  const f=setup(); f.book(); f.bot.consider('5m',f.now);
  f.setNow(f.now+2000); f.book('UP',.8); f.bot.consider('5m',f.now);
  assert.equal(f.r.pending,null); assert.equal(f.bot.accounts['5m'].positions.length,0);
});
function enter(f) {
  f.book(); f.bot.consider('5m',f.now);
  f.setNow(f.now+2000); f.book(); f.bot.consider('5m',f.now);
}
test('only one entry per window, with no flips on opposite probability', () => {
  const f=setup(); enter(f);
  const cash=f.bot.accounts['5m'].cash;
  f.p.pUp=.1; f.p.pDown=.9; f.book('DOWN'); f.bot.consider('5m',f.now);
  assert.equal(f.bot.accounts['5m'].positions.length,1);
  assert.equal(f.bot.accounts['5m'].cash,cash);
  assert.equal(f.bot.accounts['5m'].positions[0].side,'UP');
});
test('separate 15m account is untouched by 5m activity', () => {
  const f=setup();enter(f);
  assert.equal(f.bot.accounts['15m'].cash,1500);
  assert.equal(f.bot.accounts['15m'].positions.length,0);
});
test('no entries or rollover fills in last thirty seconds', () => {
  const f=setup();f.book();f.bot.consider('5m',f.now);
  f.setNow(START+270000);f.book();f.bot.consider('5m',f.now);
  assert.equal(f.r.pending,null);assert.equal(f.bot.accounts['5m'].positions.length,0);
});
test('unknown or insufficient bid marks produce null equity, not zero value', () => {
  const f=setup();enter(f);
  const p=f.bot.accounts['5m'].positions[0];
  p.mark=null;
  assert.equal(f.bot.account('5m',f.now).equity,null);
  f.book('UP',.5,1);p.mark=f.bot.mark(p,f.r.quotes.UP,f.now);
  assert.equal(f.bot.account('5m',f.now).equity,null);
  assert.ok(p.mark.unpricedShares>0);
});
test('floating profit includes entry fee and modeled liquidation fee', () => {
  const f=setup();enter(f);const p=f.bot.accounts['5m'].positions[0];
  const state=f.bot.account('5m',f.now);
  assert.equal(state.equity,state.cash+p.mark.value);
  assert.equal(state.unrealizedPnl,p.mark.value-p.cost-p.fees);
});
test('official resolution pays winning shares and keeps closed trade details', async () => {
  const f=setup();enter(f);const a=f.bot.accounts['5m'],p=a.positions[0];
  f.bot.data={getMarket:async()=>({id:'m5'}),resolvedWinner:()=> 'UP'};
  f.setNow(START+301000);await f.bot.settle(f.now);
  assert.equal(a.positions.length,0);assert.equal(a.history[0].exitPrice,1);
  assert.equal(a.cash,1500-p.cost-p.fees+p.shares);
  assert.equal(a.history[0].pnl,p.shares-p.cost-p.fees);
});
test('unresolved or mismatching official market never invents a win', async () => {
  const f=setup();enter(f);f.setNow(START+301000);
  f.bot.data={getMarket:async()=>({id:'other'}),resolvedWinner:()=> 'UP'};
  await f.bot.settle(f.now);
  assert.equal(f.bot.accounts['5m'].history.length,0);
  assert.equal(f.bot.accounts['5m'].positions[0].status,'AWAITING_RESOLUTION');
});
test('losing resolution records zero payout and exact cost plus fees loss', async () => {
  const f=setup();enter(f);const a=f.bot.accounts['5m'],p=a.positions[0];
  f.bot.data={getMarket:async()=>({id:'m5'}),resolvedWinner:()=> 'DOWN'};
  f.setNow(START+301000);await f.bot.settle(f.now);
  assert.equal(a.history[0].pnl,-p.cost-p.fees);assert.equal(a.history[0].exitPrice,0);
});
test('worker rejects cross-window, expired, failed validation and stale model predictions', () => {
  const f=setup();const w=new Worker({now:()=>f.now});
  w.status='RUNNING';w.models['5m']={status:'READY',metrics:{trainedAt:f.now},prediction:{...f.p}};
  assert.ok(w.prediction('5m',START));
  assert.equal(w.prediction('5m',START+300000),null);
  w.models['5m'].status='VALIDATION_REJECTED';assert.equal(w.prediction('5m',START),null);
  w.models['5m'].status='READY';f.setNow(START+120000);assert.equal(w.prediction('5m',START),null);
});
test('worker errors invalidate all previously issued predictions', () => {
  const w=new Worker();w.models['5m'].prediction={pUp:.9};
  w.consume({type:'status',status:'ERROR',message:'Stale data'});
  assert.equal(w.models['5m'].prediction,null);
});
test('history reset archives only old strategy and restart restores new history', async () => {
  const f=setup();let archived=false,saved;
  f.bot.ledgerStore={archive:async()=>{archived=true;},save:async x=>{saved=x;}};
  assert.equal(await restoreOrResetLedger(f.bot,{strategyId:'old'},CalibratedBot.STRATEGY.id),'reset');
  assert.ok(archived);assert.equal(saved.accounts['5m'].cash,1500);
  enter(f);await f.bot.flushLedger();
  const next=setup();next.bot.ledgerStore={save:async()=>{}};
  assert.equal(await restoreOrResetLedger(next.bot,saved,CalibratedBot.STRATEGY.id),'restored');
  assert.equal(next.bot.accounts['5m'].positions.length,1);
  next.book();next.bot.consider('5m',next.now);
  assert.equal(next.bot.accounts['5m'].positions.length,1);
});
