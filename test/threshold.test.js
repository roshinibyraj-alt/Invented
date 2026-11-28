'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {CalibratedBot: Bot, buyPlan, quote} = require('../calibrated-bot');
const {restoreOrResetLedger} = require('../index');
const START = 1800000000000;
function fixture() {
  let now=START+1000;
  const bot=new Bot({now:()=>now, marketData:{
    getMarket:async()=>({id:'m'}), resolvedWinner:()=> 'UP',
  }});
  const r=bot.records['5m'], a=bot.accounts['5m'];
  r.market={id:'m',start:START,end:START+300000,tokens:{UP:'u',DOWN:'d'},
    feesEnabled:true,feeSchedule:{rate:.07,exponent:1}};
  r.targetStart=START;
  function book(side='UP',ask=.94,bid=.93,size=1000) {
    r.quotes[side]=quote({asset_id:r.market.tokens[side],timestamp:now,
      asks:[{price:ask,size}],bids:[{price:bid,size}]},r.market,side,now);
  }
  function advance(ms=2000) {now+=ms;}
  function enter(side='UP') {
    book(side); bot.consider('5m',now); advance();book(side);bot.consider('5m',now);
    assert.equal(a.positions.length,1);
  }
  return {bot,r,a,book,advance,enter,get now(){return now;}};
}
test('only five-minute paper trading, fixed 300 without model',()=>{
  const f=fixture(),s=f.bot.snapshot();
  assert.deepEqual(Object.keys(s.accounts),['5m']);
  assert.deepEqual(s.strategy.timeframes,['5m']);
  assert.equal(s.strategy.targetShares,300); assert.equal(s.model,undefined);
});
test('entry is full 300 shares including multi-level depth and rounded fees',()=>{
  const q={bestAsk:.94,asks:[{price:.94,size:100},{price:.95,size:250}]};
  const p=buyPlan(q,1500,.07,1);
  assert.equal(p.shares,300);assert.equal(p.cost,284);
  assert.equal(p.fees,Number((100*.07*.94*.06).toFixed(5))+Number((200*.07*.95*.05).toFixed(5)));
});
test('does not enter below trigger, without cash/depth, or invalid fee data',()=>{
  for(const [q,cash,fee] of [
    [{bestAsk:.93,asks:[{price:.93,size:1000}]},1500,.07],
    [{bestAsk:.94,asks:[{price:.94,size:299}]},1500,.07],
    [{bestAsk:.94,asks:[{price:.94,size:1000}]},200,.07],
    [{bestAsk:.94,asks:[{price:.94,size:1000}]},1500,NaN],
  ])assert.equal(buyPlan(q,cash,fee),null);
});
test('trigger waits for later fresh book, cancels if price falls, and accepts either side',()=>{
  const f=fixture();f.book();f.bot.consider('5m',f.now);assert.equal(f.a.positions.length,0);
  f.advance();f.bot.consider('5m',f.now);assert.equal(f.a.positions.length,0);
  f.book('UP',.93,.92);f.bot.consider('5m',f.now);assert.equal(f.r.pending,null);
  f.enter('DOWN');assert.equal(f.a.positions[0].side,'DOWN');assert.equal(f.a.positions[0].shares,300);
});
test('ambiguous books do not arbitrarily choose a side',()=>{
  const f=fixture();f.book();f.book('DOWN');f.bot.consider('5m',f.now);
  assert.match(f.r.status,/Ambiguous/);assert.equal(f.r.pending,null);
});
test('entry fill uses new ask, not trigger price; no final 30-second restriction',()=>{
  const f=fixture();f.advance(280000);f.book();f.bot.consider('5m',f.now);
  f.advance();f.book('UP',.96,.95);f.bot.consider('5m',f.now);
  assert.equal(f.a.positions[0].entryPrice,.96);
});
test('stop is inclusive at 90-cent bid and executes after delay at actual worse bids',()=>{
  const f=fixture();f.enter();const p=f.a.positions[0];
  f.advance();f.book('UP',.94,.91);f.bot.consider('5m',f.now);assert.equal(p.stopTriggeredAt,undefined);
  f.advance();f.book('UP',.91,.90);f.bot.consider('5m',f.now);
  assert.equal(p.status,'STOP_PENDING');assert.equal(f.a.history.length,0);
  f.advance();f.book('UP',.89,.88);f.bot.consider('5m',f.now);
  assert.equal(f.a.positions.length,0);assert.equal(f.a.history[0].status,'STOPPED');
  assert.ok(Math.abs(p.exitPrice-.88)<1e-9);
  assert.ok(Math.abs(p.pnl-(300*.88-p.exitFees-p.cost-p.entryFees))<1e-9);
  assert.ok(Math.abs(f.a.cash-(1500+p.pnl))<1e-9);
  f.book('DOWN');f.bot.consider('5m',f.now);assert.equal(f.r.pending,null);
});
test('stop stays triggered on rebound; partial depth cannot be reused unchanged',()=>{
  const f=fixture();f.enter();const p=f.a.positions[0];
  f.advance();f.book('UP',.91,.90,100);f.bot.consider('5m',f.now);
  f.advance();f.book('UP',.91,.89,100);f.bot.consider('5m',f.now);
  assert.equal(p.shares,200);
  f.advance();f.book('UP',.91,.89,100);f.bot.consider('5m',f.now);
  assert.equal(p.shares,200);
  f.advance();f.book('UP',.95,.94,500);f.bot.consider('5m',f.now);
  assert.equal(f.a.positions.length,0);assert.equal(p.sales.length,2);
});
test('partial-stop remainder settles once and includes sales, entry and exit fees',async()=>{
  const f=fixture();f.enter();const p=f.a.positions[0];
  f.advance();f.book('UP',.91,.90,100);f.bot.consider('5m',f.now);
  f.advance();f.book('UP',.90,.89,100);f.bot.consider('5m',f.now);
  assert.equal(p.shares,200);const soldNet=p.proceeds;
  f.advance(300000);await f.bot.settle(f.now);
  assert.equal(p.status,'RESOLVED');assert.equal(p.payout,200+soldNet);
  assert.ok(Math.abs(f.a.cash-(1500+p.pnl))<1e-9);
  const cash=f.a.cash;f.advance(11000);await f.bot.settle(f.now);assert.equal(f.a.cash,cash);
});
test('99-cent mark does not invent a $1 sale; waits for official winning resolution',async()=>{
  const f=fixture();f.enter();const p=f.a.positions[0];
  f.advance();f.book('UP',.999,.99);f.bot.consider('5m',f.now);
  assert.equal(f.a.positions.length,1);
  f.advance(300000);f.bot.data.resolvedWinner=()=>null;await f.bot.settle(f.now);
  assert.equal(p.status,'AWAITING_RESOLUTION');assert.equal(f.bot.snapshot().accounts['5m'].equity,null);
  f.advance(11000);f.bot.data.resolvedWinner=()=> 'UP';await f.bot.settle(f.now);
  assert.equal(p.exitPrice,1);assert.equal(p.pnl,300-p.cost-p.fees);
});
test('official loss pays zero; pending entries expire without rollover',async()=>{
  const f=fixture();f.enter('DOWN');f.advance(300000);await f.bot.settle(f.now);
  assert.equal(f.a.history[0].payout,0);assert.equal(f.a.history[0].pnl,-f.a.history[0].cost-f.a.history[0].fees);
  const g=fixture();g.book();g.bot.consider('5m',g.now);g.advance(300000);
  g.bot.consider('5m',g.now);assert.equal(g.r.pending,null);assert.equal(g.a.positions.length,0);
});
test('stale, wrong-token and crossed books reject',()=>{
  const f=fixture();
  for(const b of [
    {asset_id:'d',timestamp:f.now},
    {asset_id:'u',timestamp:f.now-11000},
    {asset_id:'u',timestamp:f.now,asks:[{price:.9,size:10}],bids:[{price:.95,size:10}]}
  ])assert.throws(()=>quote(b,f.r.market,'UP',f.now));
});
test('history reset archives old version once and restores new version on restart',async()=>{
  const f=fixture();let archived=0,saved;
  f.bot.ledgerStore={archive:async()=>archived++,save:async p=>{saved=p;}};
  assert.equal(await restoreOrResetLedger(f.bot,{strategyId:'old',accounts:{}},Bot.STRATEGY.id),'reset');
  assert.equal(archived,1);assert.equal(saved.accounts['5m'].cash,1500);
  f.enter();await f.bot.flushLedger();
  const g=fixture();g.bot.ledgerStore=f.bot.ledgerStore;
  assert.equal(await restoreOrResetLedger(g.bot,saved,Bot.STRATEGY.id),'restored');
  assert.equal(archived,1);assert.equal(g.a.cash,1500); // fixture's old reference is not restored state
  assert.equal(g.bot.accounts['5m'].positions.length,1);
  assert.equal(g.bot.accounts['5m'].cash,f.a.cash);
});
test('full refresh/tick path discovers only current 5m book and records errors explicitly',async()=>{
  const f=fixture();const starts=[];
  f.r.market=null;f.r.targetStart=undefined;
  f.bot.data.getBtcMarket=async(s,d)=>{starts.push([s,d]);return {id:'m',start:s,end:s+d,tokens:{UP:'u',DOWN:'d'},feesEnabled:false};};
  f.bot.data.getBook=async token=>({asset_id:token,timestamp:f.now,
    asks:[{price:token==='u'?.94:.07,size:1000}],bids:[{price:token==='u'?.93:.06,size:1000}]});
  f.bot.running=true;await f.bot.tick();f.advance();await f.bot.tick();
  assert.deepEqual(starts,[[START,300000]]);assert.equal(f.a.positions[0].shares,300);
  assert.equal(f.bot.status,'RUNNING');assert.equal(f.bot.lastError,null);
});
test('restored partial stop retains consumed depth and completes only with new liquidity',async()=>{
  const f=fixture();f.enter();f.advance();f.book('UP',.91,.90,100);f.bot.consider('5m',f.now);
  f.advance();f.book('UP',.90,.89,100);f.bot.consider('5m',f.now);
  let saved;f.bot.ledgerStore={save:async p=>{saved=p;}};await f.bot.flushLedger();
  const g=fixture();g.advance(f.now-g.now+2000);g.bot.restoreLedger(saved);
  g.book('UP',.90,.89,100);g.bot.consider('5m',g.now);
  assert.equal(g.bot.accounts['5m'].positions[0].shares,200);
  g.advance();g.book('UP',.90,.89,300);g.bot.consider('5m',g.now);
  assert.equal(g.bot.accounts['5m'].positions.length,0);
  assert.equal(g.bot.accounts['5m'].history[0].shares,300);
});
