'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {aggregate,detectTimedStrategy}=require('../wick-core');
const { _test }=require('../wick-bot');

test('aggregates one-minute bars into quarter-hour and hourly slots',()=>{
  const bars=aggregate([{t:0,o:10,h:12,l:9,c:11,v:2},{t:60000,o:11,h:13,l:10,c:12,v:3}],900000);
  assert.deepEqual(bars[0],{t:0,o:10,h:13,l:9,c:12,v:5});
});

function timedWindow(previous,rows,{windowMs=300000,elapsedMs=30000}={}){
  const minute=[];
  for(let j=0;j<windowMs/60000;j++)minute.push({t:j*60000,...previous,v:1});
  for(const row of rows)minute.push({t:windowMs+row.minute*60000,o:row.o,h:row.h,l:row.l,c:row.c,v:1});
  return detectTimedStrategy({minuteCandles:minute,windowStart:windowMs,windowMs,now:windowMs+elapsedMs});
}

test('green previous candle triggers the four UP buy rungs on adverse drops throughout the window',()=>{
  const previous={o:100,h:106,l:99,c:105};
  const all=timedWindow(previous,[{minute:3,o:104,h:105,l:100.4,c:101}],{elapsedMs:230000});
  assert.equal(all.previousBody,5);assert.equal(all.side,'UP');
  assert.deepEqual(all.entries.map(e=>e.movePct),[25,50,75,90]);
  assert.deepEqual(all.entries.map(e=>e.shares),[100,200,300,400]);
  assert.deepEqual(all.entries.map(e=>e.crossed),[true,true,true,true]);
  assert.deepEqual(all.entries.map(e=>e.key),['move-25','move-50','move-75','move-90']);
  assert.ok(all.entries.every(e=>e.windowEnd===all.windowStart+300000));
  const partial=timedWindow(previous,[{minute:3,o:104,h:105,l:102.4,c:103}],{elapsedMs:230000});
  assert.deepEqual(partial.entries.map(e=>e.crossed),[true,true,false,false]);
});

test('red previous candle mirrors the four buy rungs on DOWN throughout the window',()=>{
  const previous={o:105,h:106,l:99,c:100};
  const all=timedWindow(previous,[{minute:3,o:104,h:104.6,l:99,c:104}],{elapsedMs:230000});
  assert.equal(all.side,'DOWN');assert.deepEqual(all.entries.map(e=>e.crossed),[true,true,true,true]);
  assert.deepEqual(all.entries.map(e=>e.shares),[100,200,300,400]);
});

test('doji prior candle cannot signal entries or exits',()=>{
  const a=timedWindow({o:100,h:110,l:90,c:100},[{minute:0,o:100,h:120,l:80,c:110}],{elapsedMs:240000});
  assert.equal(a.side,null);assert.deepEqual(a.entries.map(e=>e.crossed),[false,false,false,false]);
  assert.equal('exit' in a,false);
});

test('rung ladder has no sell/exit trigger at any point in a window',()=>{
  const a=timedWindow({o:100,h:110,l:99,c:105},
    [{minute:0,o:105,h:105,l:103,c:103},{minute:1,o:103,h:104,l:102,c:102},{minute:4,o:102,h:102,l:90,c:91}],
    {elapsedMs:240000});
  assert.equal('exit' in a,false);
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:1000});
  assert.equal(typeof bot.tryExit,'undefined');
  assert.match(bot.snapshot().strategy.exit,/higher midpoint wins/);
});

test('the 25% rung also works in a five-minute window',()=>{
  const a=timedWindow({o:100,h:106,l:99,c:105},
    [{minute:0,o:105,h:105,l:103.5,c:104}],{windowMs:300000,elapsedMs:20000});
  assert.equal(a.entries[0].crossed,true);assert.equal(a.entries[0].shares,100);
  assert.equal('exit' in a,false);
});

test('only one 5-minute bot and one $10,000 demo bankroll are active',()=>{
  const MultiBot=require('../multi-bot'),bots=new MultiBot();
  assert.deepEqual(Object.keys(bots.bots),['5m']);
  assert.equal(bots.bots['5m'].cash,10000);
  assert.equal(bots.snapshot().account.capital,10000);
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

test('paper entry requires full depth within the $0.05-$0.60 ask band',()=>{
  assert.equal(_test.sweep([{price:.60,size:100}],100,.60,.05).cost,60);
  assert.equal(_test.sweep([{price:.05,size:100}],100,.60,.05).cost,5);
  assert.equal(_test.sweep([{price:.049,size:100}],100,.60,.05),null);
  assert.equal(_test.sweep([{price:.61,size:100}],100,.60,.05),null);
  assert.equal(_test.sweep([{price:.60,size:99}],100,.60,.05),null);
});

test('paper fill records the crossed rung percentage and share size',async()=>{
  const Bot=require('../wick-bot'),md=require('../wick-market-data');
  const oldGetBook=md.getBook;
  md.getBook=async()=>({asks:[{price:.5,size:400}]});
  try{
    const bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000});
    const start=Date.now()-1000;
    bot.market={id:'test-market',slug:'test',title:'Test',tokens:{UP:'up-token',DOWN:'down-token'},raw:{feesEnabled:false}};
    bot.rungState[start]={triggered:{},filled:{},blocks:{}};
    await bot.tryEnter(start,{movePct:50,side:'UP',shares:200,key:'move-50',
      label:'50% adverse move',windowEnd:Date.now()+10000,thresholdPrice:99,observedPrice:98},'move-50');
    assert.equal(bot.positions[0].triggerPct,50);
    assert.equal(bot.positions[0].shares,200);
    assert.equal(bot.positions[0].entryType,'CANDLE_MOVE_RUNG');
  }finally{md.getBook=oldGetBook}
});

test('paper BTC taker fee and official outcome settlement are applied',()=>{
  assert.ok(Math.abs(_test.feeFor({feesEnabled:true,feeSchedule:{rate:.07,exponent:1}},.5,300)-5.25)<1e-9);
  assert.ok(Math.abs(_test.feeFor({feesEnabled:false},.5,300)-5.25)<1e-9);
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
  assert.equal(q.mid,.485);
});

test('CLOB final settlement prioritizes the 0.98 threshold then the higher midpoint',()=>{
  assert.equal(_test.clobWinner(.98,.02),'UP');
  assert.equal(_test.clobWinner(.45,.55),'DOWN');
  assert.equal(_test.clobWinner(.5,.5),'UP');
});

test('five-minute entries are blocked at 240 seconds',()=>{
  const a=timedWindow({o:100,h:106,l:99,c:105},
    [{minute:4,o:105,h:105,l:100,c:101}],{elapsedMs:240000});
  assert.ok(a.entries.every(e=>!e.crossed));
});
