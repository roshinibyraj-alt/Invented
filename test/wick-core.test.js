'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {aggregate,detectMoveLadder}=require('../wick-core');
const { _test }=require('../wick-bot');

test('aggregates one-minute bars into quarter-hour and hourly slots',()=>{
  const bars=aggregate([{t:0,o:10,h:12,l:9,c:11,v:2},{t:60000,o:11,h:13,l:10,c:12,v:3}],900000);
  assert.deepEqual(bars[0],{t:0,o:10,h:13,l:9,c:12,v:5});
});

function sampleWindow(previous,current,windowMs=900000){
  const minute=[];
  for(let j=0;j<windowMs/60000;j++)minute.push({t:j*60000,...previous,v:1});
  minute.push({t:windowMs,...current,v:1});
  return detectMoveLadder({minuteCandles:minute,windowStart:windowMs,windowMs,sharesByLevel:{25:200,50:100}});
}

test('red previous candle and 50% rise trigger 200- and 100-share DOWN rungs',()=>{
  const a=sampleWindow({o:100,h:110,l:90,c:95},{o:95,h:106,l:95,c:105});
  assert.equal(a.previousColor,'red');assert.equal(a.previousBody,5);
  assert.equal(a.side,'DOWN');assert.equal(a.observedMove,10);
  assert.deepEqual(a.rungs.map(r=>[r.levelPct,r.shares,r.crossed]),[[25,200,true],[50,100,true]]);
});

test('green previous candle and 25% fall triggers only the UP 25% rung',()=>{
  const a=sampleWindow({o:100,h:110,l:90,c:105},{o:105,h:105,l:103,c:103.5});
  assert.equal(a.previousColor,'green');assert.equal(a.side,'UP');
  assert.equal(a.previousBody,5);assert.equal(a.observedMove,1.5);
  assert.deepEqual(a.rungs.map(r=>r.crossed),[true,false]);
});

test('doji has no side and cannot trigger either rung',()=>{
  const a=sampleWindow({o:100,h:110,l:90,c:100},{o:100,h:111,l:100,c:111});
  assert.equal(a.side,null);assert.deepEqual(a.rungs.map(r=>r.crossed),[false,false]);
});

test('five-minute windows use previous open-close body and independent rung sizes',()=>{
  const a=sampleWindow({o:100,h:110,l:90,c:96},{o:96,h:98,l:96,c:98},300000);
  assert.equal(a.previousBody,4);
  assert.deepEqual(a.rungs.map(r=>[r.requiredMove,r.shares,r.crossed]),[[1,200,true],[2,100,true]]);
});

test('five- and fifteen-minute bot instances have fully separate cash and positions',()=>{
  const MultiBot=require('../multi-bot'),bots=new MultiBot();
  const five=bots.bots['5m'],fifteen=bots.bots['15m'];
  assert.notEqual(five,fifteen);assert.equal(five.cash,10000);assert.equal(fifteen.cash,10000);
  five.cash-=25;assert.equal(fifteen.cash,10000);
  assert.equal(bots.snapshot().account.capital,20000);
  assert.equal(bots.snapshot().timeframes['5m'].strategy.sharesByLevel[25],200);
});

function windowsLadder(past,current,windowMs=300000){
  const minute=[];
  for(let w=0;w<past.length;w++)for(let j=0;j<windowMs/60000;j++)
    minute.push({t:w*windowMs+j*60000,...past[w],v:1});
  minute.push({t:past.length*windowMs,...current,v:1});
  return detectMoveLadder({minuteCandles:minute,windowStart:past.length*windowMs,windowMs});
}

test('three same-colour completed candles pause the next window; opposite close releases the lock',()=>{
  const green={o:100,h:105,l:99,c:104},red={o:104,h:105,l:99,c:100};
  const paused=windowsLadder([green,green,green],{o:104,h:104,l:100,c:100});
  assert.equal(paused.streak.blocked,true);
  assert.equal(paused.rungs[0].wouldCross,true);assert.equal(paused.rungs[0].crossed,false);
  const released=windowsLadder([green,green,red],{o:100,h:102,l:100,c:102});
  assert.equal(released.streak.blocked,false);assert.equal(released.rungs[1].crossed,true);
});

test('first opposite-colour candle creates a one-window recovery signal and suppresses normal rungs',()=>{
  const green={o:100,h:105,l:99,c:104},red={o:104,h:105,l:99,c:100};
  const down=windowsLadder([green,green,green,red],{o:100,h:102,l:100,c:102});
  assert.equal(down.recovery.active,true);assert.equal(down.recovery.color,'red');
  assert.equal(down.recovery.side,'DOWN');assert.equal(down.entryMode,'RECOVERY_ONLY');
  assert.deepEqual(down.rungs.map(r=>[r.wouldCross,r.crossed]),[[true,false],[true,false]]);
  const redBars=[red,red,red],greenBar={o:100,h:105,l:99,c:104};
  const up=windowsLadder([...redBars,greenBar],{o:104,h:104,l:100,c:100});
  assert.equal(up.recovery.active,true);assert.equal(up.recovery.side,'UP');
});

test('recovery detection is one completed opposite candle, not a continuing opposite streak',()=>{
  const green={o:100,h:105,l:99,c:104},red={o:104,h:105,l:99,c:100};
  const secondRed=windowsLadder([green,green,red,red],{o:100,h:102,l:100,c:102});
  assert.equal(secondRed.recovery.active,false);assert.equal(secondRed.entryMode,'NORMAL');
});

test('recovery entry depth must be fully available strictly below $0.50',()=>{
  assert.ok(Math.abs(_test.sweep([{price:.499,size:300}],300,.499999,0).avg-.499)<1e-9);
  assert.equal(_test.sweep([{price:.50,size:300}],300,.499999,0),null);
  assert.equal(_test.sweep([{price:.40,size:299}],300,.499999,0),null);
});

test('realized and floating position P&L are computed separately from bid marks',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:1000});
  bot.cash=900;
  bot.positions=[{status:'OPEN',side:'UP',shares:200,totalCost:100,markBid:.45,
    markUpdatedAt:Date.now()},{status:'SETTLED_LOSS',realizedPnl:-5}];
  const a=bot.snapshot().account;
  assert.equal(a.realizedPnl,-5);assert.equal(a.unrealizedPnl,-10);
  assert.equal(a.equity,990);assert.equal(a.openPositions,1);
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
