'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {aggregate,detectTimedStrategy}=require('../wick-core');
const { _test }=require('../wick-bot');

test('aggregates one-minute bars into quarter-hour and hourly slots',()=>{
  const bars=aggregate([{t:0,o:10,h:12,l:9,c:11,v:2},{t:60000,o:11,h:13,l:10,c:12,v:3}],900000);
  assert.deepEqual(bars[0],{t:0,o:10,h:13,l:9,c:12,v:5});
});

function timedWindow(previous,rows,{windowMs=900000,elapsedMs=30000}={}){
  const minute=[];
  for(let j=0;j<windowMs/60000;j++)minute.push({t:j*60000,...previous,v:1});
  for(const row of rows)minute.push({t:windowMs+row.minute*60000,o:row.o,h:row.h,l:row.l,c:row.c,v:1});
  return detectTimedStrategy({minuteCandles:minute,windowStart:windowMs,windowMs,now:windowMs+elapsedMs});
}

test('green previous candle buys 100 UP on 25% drop during minute one and 200 on return to close in minute two',()=>{
  const previous={o:100,h:106,l:99,c:105};
  const first=timedWindow(previous,[{minute:0,o:105,h:106,l:103.7,c:104}],{elapsedMs:30000});
  assert.equal(first.previousBody,5);assert.equal(first.entries[0].side,'UP');
  assert.equal(first.entries[0].shares,100);assert.equal(first.entries[0].crossed,true);
  const second=timedWindow(previous,[{minute:0,o:105,h:106,l:103,c:104},{minute:1,o:104,h:105,l:103.8,c:104.5}],{elapsedMs:90000});
  assert.equal(second.entries[1].side,'UP');assert.equal(second.entries[1].shares,200);
  assert.equal(second.entries[1].crossed,true);
});

test('red previous candle mirrors timed entries on DOWN',()=>{
  const previous={o:105,h:106,l:99,c:100};
  const first=timedWindow(previous,[{minute:0,o:100,h:101.3,l:99,c:101}],{elapsedMs:30000});
  assert.equal(first.entries[0].side,'DOWN');assert.equal(first.entries[0].crossed,true);
  assert.equal(first.entries[0].shares,100);
  const second=timedWindow(previous,[{minute:0,o:100,h:102,l:99,c:101},{minute:1,o:101,h:101.2,l:100,c:100.5}],{elapsedMs:90000});
  assert.equal(second.entries[1].side,'DOWN');assert.equal(second.entries[1].crossed,true);
  assert.equal(second.entries[1].shares,200);
});

test('doji prior candle cannot signal entries or exits',()=>{
  const a=timedWindow({o:100,h:110,l:90,c:100},[{minute:0,o:100,h:120,l:80,c:110}],{elapsedMs:240000});
  assert.equal(a.side,null);assert.deepEqual(a.entries.map(e=>e.crossed),[false,false]);
  assert.equal(a.exit.triggered,false);
});

test('adverse 25% exit is inactive before 3 minutes and triggers after 3 minutes',()=>{
  const previous={o:100,h:110,l:99,c:105};
  const row={minute:3,o:104,h:104,l:103.7,c:103.75};
  assert.equal(timedWindow(previous,[row],{elapsedMs:179000}).exit.triggered,false);
  const after=timedWindow(previous,[row],{elapsedMs:180000});
  assert.equal(after.exit.triggered,true);assert.equal(after.exit.thresholdPrice,103.75);
});

test('same minute schedule scales unchanged to five-minute windows',()=>{
  const a=timedWindow({o:100,h:106,l:99,c:105},
    [{minute:0,o:105,h:105,l:103.5,c:104}],{windowMs:300000,elapsedMs:20000});
  assert.equal(a.entries[0].crossed,true);assert.equal(a.entries[0].shares,100);
  assert.equal(a.exit.triggered,false);
});

test('five- and fifteen-minute bot instances have fully separate cash and positions',()=>{
  const MultiBot=require('../multi-bot'),bots=new MultiBot();
  const five=bots.bots['5m'],fifteen=bots.bots['15m'];
  assert.notEqual(five,fifteen);assert.equal(five.cash,10000);assert.equal(fifteen.cash,10000);
  five.cash-=25;assert.equal(fifteen.cash,10000);
  assert.equal(bots.snapshot().account.capital,20000);
  assert.equal(bots.snapshot().timeframes['5m'].strategy.entries[0].shares,100);
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

test('forced exits sweep bids best-first and retry leftover shares',async()=>{
  const Bot=require('../wick-bot'),md=require('../wick-market-data');
  const original=md.getBook;let call=0;
  md.getBook=async()=>++call===1
    ?{bids:[{price:.5,size:30},{price:.6,size:40}],asks:[]}
    :{bids:[{price:.4,size:30}],asks:[]};
  try{
    const bot=new Bot({timeframe:'5m',windowMs:300000,capital:1000});
    bot.market={raw:{feesEnabled:false}};
    bot.cash=900;
    const p={id:'test',status:'OPEN',side:'UP',tokenId:'tok',shares:100,initialShares:100,totalCost:50};
    bot.positions=[p];
    await bot.tryExit(p,'test');
    assert.equal(p.status,'OPEN');assert.equal(p.shares,30);assert.equal(p.realizedPnl,4);
    assert.equal(bot.cash,939);
    await bot.tryExit(p,'test');
    assert.equal(p.status,'EXITED_STOP');assert.equal(p.shares,0);
    assert.equal(p.realizedPnl,1);assert.equal(p.avgExitPrice,.51);
    assert.equal(bot.cash,951);assert.equal(bot.snapshot().account.unrealizedPnl,0);
  }finally{md.getBook=original}
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
