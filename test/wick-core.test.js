'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {aggregate,detectMoveLadder}=require('../wick-core');
const { _test }=require('../wick-bot');

test('aggregates one-minute bars into quarter-hour and hourly slots',()=>{
  const bars=aggregate([{t:0,o:10,h:12,l:9,c:11,v:2},{t:60000,o:11,h:13,l:10,c:12,v:3}],900000);
  assert.deepEqual(bars[0],{t:0,o:10,h:13,l:9,c:12,v:5});
});

function sampleWindow(previous,current){
  const minute=[];
  for(let j=0;j<15;j++)minute.push({t:j*60000,...previous,v:1});
  minute.push({t:900000,...current,v:1});
  return detectMoveLadder({minuteCandles:minute,windowStart:900000});
}

test('red previous candle and 50% rise trigger both 100-share DOWN rungs',()=>{
  const a=sampleWindow({o:100,h:110,l:90,c:95},{o:95,h:106,l:95,c:105});
  assert.equal(a.previousColor,'red');assert.equal(a.previousRange,20);
  assert.equal(a.side,'DOWN');assert.equal(a.observedMove,10);
  assert.deepEqual(a.rungs.map(r=>[r.levelPct,r.shares,r.crossed]),[[25,100,true],[50,100,true]]);
});

test('green previous candle and 25% fall triggers only the UP 25% rung',()=>{
  const a=sampleWindow({o:100,h:110,l:90,c:105},{o:105,h:105,l:99,c:99});
  assert.equal(a.previousColor,'green');assert.equal(a.side,'UP');
  assert.equal(a.observedMove,6);
  assert.deepEqual(a.rungs.map(r=>r.crossed),[true,false]);
});

test('doji has no side and cannot trigger either rung',()=>{
  const a=sampleWindow({o:100,h:110,l:90,c:100},{o:100,h:111,l:100,c:111});
  assert.equal(a.side,null);assert.deepEqual(a.rungs.map(r=>r.crossed),[false,false]);
});

test('paper entry requires full depth within the $0.05-$0.60 ask band',()=>{
  assert.equal(_test.sweep([{price:.60,size:100}],100,.60,.05).cost,60);
  assert.equal(_test.sweep([{price:.05,size:100}],100,.60,.05).cost,5);
  assert.equal(_test.sweep([{price:.049,size:100}],100,.60,.05),null);
  assert.equal(_test.sweep([{price:.61,size:100}],100,.60,.05),null);
  assert.equal(_test.sweep([{price:.60,size:99}],100,.60,.05),null);
});

test('paper BTC taker fee and official outcome settlement are applied',()=>{
  assert.ok(Math.abs(_test.feeFor({feesEnabled:true,feeSchedule:{rate:.07,exponent:1}},.5,300)-5.25)<1e-9);
  const settled={closed:true,outcomes:['Up','Down'],outcomePrices:['1','0']};
  assert.equal(_test.payout(settled,'UP'),1);
  assert.equal(_test.payout(settled,'DOWN'),0);
  assert.equal(_test.payout({closed:true,outcomes:['Up','Down'],outcomePrices:['.5','.5']},'UP'),null);
});

test('live CLOB quote selects highest bid and lowest ask with visible sizes',()=>{
  const q=_test.quoteFromBook({bids:[{price:'0.42',size:'8'},{price:'0.46',size:'3'}],
    asks:[{price:'0.55',size:'4'},{price:'0.51',size:'7'}]},1234);
  assert.equal(q.bestBid,.46);assert.equal(q.bidSize,3);
  assert.equal(q.bestAsk,.51);assert.equal(q.askSize,7);
  assert.equal(q.updatedAt,1234);assert.equal(q.status,'LIVE');
});
