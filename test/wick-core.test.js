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
  assert.match(bot.snapshot().strategy.exit,/bid\/ask\/mid >= \$0\.99/);
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

test('terminal one-sided CLOB bid or ask can identify the binary winner',()=>{
  assert.equal(_test.clobQuoteWinner({bestAsk:.01},{bestBid:.99}),'DOWN');
  assert.equal(_test.clobQuoteWinner({bestBid:.99},{bestAsk:.01}),'UP');
  assert.equal(_test.clobQuoteWinner({bestBid:.61},{bestAsk:.59}),'UP');
  assert.equal(_test.clobQuoteWinner({bestAsk:.01},{}),'DOWN');
  assert.equal(_test.clobQuoteWinner({},{}),null);
});
test('three settled rung wins arm exactly one signalled-side window',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000}),source=900000;
  bot.positions=['move-25','move-50','move-75'].map(entryKey=>({windowStart:source,entryKey,status:'SETTLED_WIN'}));
  bot.updateOneWindowOverride(source+1000);
  assert.equal(bot.oneWindowOverrides.get(source+300000),source);
  assert.equal(bot.oneWindowOverrides.has(source+600000),false);
});
test('three settled rung losses arm one 500-share signal-side window',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000}),source=900000;
  bot.positions=['move-25','move-50','move-75'].map(entryKey=>({windowStart:source,entryKey,status:'SETTLED_LOSS'}));
  bot.updateOneWindowOverride(source+1000);
  assert.equal(bot.oneWindowOverrides.get(source+300000),source);
  assert.equal(bot.oneWindowOverrides.size,1);
});
test('fewer than three settled rung losses do not arm an override',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000}),source=900000;
  bot.positions=['move-25','move-50'].map(entryKey=>({windowStart:source,entryKey,status:'SETTLED_LOSS'}));
  bot.updateOneWindowOverride(source+1000);
  assert.equal(bot.oneWindowOverrides.size,0);
});
test('late-confirmed losses arm the next upcoming window, not a missed one',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000}),source=900000;
  bot.positions=['move-25','move-50','move-75'].map(entryKey=>({windowStart:source,entryKey,status:'SETTLED_LOSS'}));
  bot.updateOneWindowOverride(1500000);
  assert.equal(bot.oneWindowOverrides.get(1800000),source);
});
test('fewer than three wins do not arm a one-window override',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000}),source=900000;
  bot.positions=['move-25','move-50'].map(entryKey=>({windowStart:source,entryKey,status:'SETTLED_WIN'}));
  bot.updateOneWindowOverride(source+1000);assert.equal(bot.oneWindowOverrides.size,0);
});
test('late-confirmed wins arm the next upcoming window, not a missed one',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000}),source=900000;
  bot.positions=['move-25','move-50','move-75'].map(entryKey=>({windowStart:source,entryKey,status:'SETTLED_WIN'}));
  bot.updateOneWindowOverride(1500000);assert.equal(bot.oneWindowOverrides.get(1800000),source);
});
test('one-window entry buys 500 shares on the signalled side',()=>{
  assert.deepEqual(_test.signalSideEntry({side:'UP',key:'move-25',shares:100,windowEnd:123}),{
    side:'UP',key:'one-window-signal',shares:500,label:'One-window signalled side · 500 shares',windowEnd:123
  });
});
test('simultaneously crossed rung fills are held at least two seconds apart',async()=>{
  const Bot=require('../wick-bot'),md=require('../wick-market-data');const oldBook=md.getBook,oldNow=Date.now;
  md.getBook=async()=>({asks:[{price:.5,size:1000}]});let now=100000;Date.now=()=>now;
  try{const bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000}),start=now-1000;
    bot.market={id:'t',slug:'t',title:'t',tokens:{UP:'u',DOWN:'d'},raw:{feesEnabled:false}};bot.rungState[start]={triggered:{},filled:{},blocks:{}};
    const first={side:'UP',shares:100,key:'move-25',label:'25%',windowEnd:now+10000},second={side:'UP',shares:200,key:'move-50',label:'50%',windowEnd:now+10000};
    await bot.tryEnter(start,first,'move-25');now+=1000;await bot.tryEnter(start,second,'move-50');assert.equal(bot.positions.length,1);
    now+=1000;await bot.tryEnter(start,second,'move-50');assert.equal(bot.positions.length,2);assert.ok(bot.positions[0].openedAt-bot.positions[1].openedAt>=2000);
  }finally{md.getBook=oldBook;Date.now=oldNow}
});
test('TP trigger accepts any fresh own-side quote at 0.99',()=>{const n=10000;assert.equal(_test.takeProfitHit({bestBid:.99,updatedAt:n},n),true);assert.equal(_test.takeProfitHit({bestAsk:.99,updatedAt:n},n),true);assert.equal(_test.takeProfitHit({mid:.99,updatedAt:n},n),true);assert.equal(_test.takeProfitHit({bestAsk:.989,updatedAt:n},n),false);assert.equal(_test.takeProfitHit({bestAsk:.99,updatedAt:n-5001},n),false)});
test('missed TP waits for and uses official Gamma win result',async()=>{const Bot=require('../wick-bot'),md=require('../wick-market-data'),old=md.getMarket;let m={closed:false,outcomes:['Up','Down'],outcomePrices:['.5','.5']};md.getMarket=async()=>m;try{const b=new Bot({timeframe:'5m',windowMs:300000,capital:1000}),p={id:'w',marketId:'m',windowStart:Date.now()-300000,windowMs:300000,status:'OPEN',shares:100,totalCost:50,side:'UP'};b.cash=950;b.positions=[p];await b.trySettle(p);assert.equal(p.status,'PENDING_CLOB_RESULT');m={closed:true,outcomes:['Up','Down'],outcomePrices:['1','0']};await b.trySettle(p);assert.equal(p.status,'SETTLED_WIN');assert.equal(p.proceeds,100);assert.equal(b.cash,1050)}finally{md.getMarket=old}});
test('official fallback pays zero to the losing side',async()=>{const Bot=require('../wick-bot'),md=require('../wick-market-data'),old=md.getMarket;md.getMarket=async()=>({closed:true,outcomes:['Up','Down'],outcomePrices:['1','0']});try{const b=new Bot({timeframe:'5m',windowMs:300000,capital:1000}),p={id:'l',marketId:'m',windowStart:Date.now()-300000,windowMs:300000,status:'OPEN',shares:100,totalCost:50,side:'DOWN'};b.cash=950;await b.trySettle(p);assert.equal(p.status,'SETTLED_LOSS');assert.equal(p.proceeds,0);assert.equal(p.realizedPnl,-50);assert.equal(b.cash,950)}finally{md.getMarket=old}});
test('stale marks are excluded from floating P&L and equity',()=>{const Bot=require('../wick-bot'),b=new Bot({timeframe:'5m',windowMs:300000,capital:1000});b.cash=900;b.positions=[{status:'OPEN',side:'UP',shares:200,totalCost:100,markBid:.8,markUpdatedAt:Date.now()-20000}];const a=b.snapshot().account;assert.equal(a.unrealizedPnl,0);assert.equal(a.equity,900);assert.equal(a.unpricedOpenPositions,1)});
