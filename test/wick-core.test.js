'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {aggregate,rsi,hourSlot,detectWick}=require('../wick-core');
const { _test }=require('../wick-bot');

test('aggregates one-minute bars into quarter-hour and hourly slots',()=>{
  const bars=aggregate([{t:0,o:10,h:12,l:9,c:11,v:2},{t:60000,o:11,h:13,l:10,c:12,v:3}],900000);
  assert.deepEqual(bars[0],{t:0,o:10,h:13,l:9,c:12,v:5});
  assert.equal(hourSlot(45*60000),3);
});

test('RSI handles rising, falling, and flat series',()=>{
  assert.equal(rsi(Array.from({length:15},(_,i)=>i)),100);
  assert.equal(rsi(Array.from({length:15},(_,i)=>15-i)),0);
  assert.equal(rsi(Array(15).fill(10)),50);
});

test('wick detector maps a confirmed lower rejection to UP and permits a latched chase',()=>{
  const minute=[];let base=100;
  for(let i=0;i<36;i++){
    const open=base,close=i%2===0?101:100;
    const high=Math.max(open,close)+.2,low=Math.min(open,close)-.1;
    const t=i*900000;
    for(let j=0;j<15;j++)minute.push({t:t+j*60000,o:open,h:high,l:low,c:close,v:1});
    base=close;
  }
  const start=36*900000, previousClose=base;
  for(let j=0;j<15;j++){
    let o=100.5,c=100.6,h=101,l=100.05;
    if(j===0)c=100.4;
    if(j===14)c=100.9;
    minute.push({t:start+j*60000,o,h,l,c,v:1});
  }
  const result=detectWick({minuteCandles:minute,now:start+15*60000,windowStart:start});
  assert.equal(result.ready,true);
  assert.equal(result.previousClose,previousClose);
  assert.equal(result.signal?.side,'UP');
  assert.equal(result.signal?.kind,'lower');
  assert.equal(result.signal?.entryType,'CHASE');
});

test('paper entry requires full 300-share depth at or below the ask ceiling',()=>{
  assert.equal(_test.sweep([{price:.60,size:300}],300,.65).cost,180);
  assert.equal(_test.sweep([{price:.66,size:300}],300,.65),null);
  assert.equal(_test.sweep([{price:.60,size:299}],300,.65),null);
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
