'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {aggregate,detectCandlePatternSignal,detectMomentumSignal,detectTimedStrategy}=require('../wick-core');
const { _test }=require('../wick-bot');

test('aggregates one-minute bars into quarter-hour and hourly slots',()=>{
  const bars=aggregate([{t:0,o:10,h:12,l:9,c:11,v:2},{t:60000,o:11,h:13,l:10,c:12,v:3}],900000);
  assert.deepEqual(bars[0],{t:0,o:10,h:13,l:9,c:12,v:5});
});

test('single-candle patterns select directional sides while neutral doji patterns do not',()=>{
  assert.equal(detectCandlePatternSignal([{t:0,o:100,h:100.5,l:90,c:100.5}]).side,'UP');
  assert.equal(detectCandlePatternSignal([{t:0,o:100.5,h:110,l:100.5,c:100}]).side,'DOWN');
  assert.equal(detectCandlePatternSignal([{t:0,o:100,h:101,l:99,c:100}]).pattern,'Standard Doji');
  assert.equal(detectCandlePatternSignal([{t:0,o:100,h:101,l:99,c:100}]).side,null);
  assert.equal(detectCandlePatternSignal([
    {t:0,o:100,h:101,l:99,c:100},{t:300000,o:100,h:101,l:99,c:100},
    {t:600000,o:100,h:105,l:95,c:100},
  ]).pattern,'Long-Legged Doji');
  const hammer=detectCandlePatternSignal([
    {t:0,o:115,h:116,l:109,c:110},{t:300000,o:110,h:111,l:104,c:105},
    {t:600000,o:105,h:106,l:99,c:100},{t:900000,o:100,h:102.1,l:90,c:102},
  ]);
  const inverted=detectCandlePatternSignal([
    {t:0,o:115,h:116,l:109,c:110},{t:300000,o:110,h:111,l:104,c:105},
    {t:600000,o:105,h:106,l:99,c:100},{t:900000,o:102,h:112,l:99.9,c:100},
  ]);
  assert.equal(hammer.pattern,'Hammer');assert.equal(hammer.side,'UP');
  assert.equal(inverted.pattern,'Inverted Hammer');assert.equal(inverted.side,'UP');
  const shooting=detectCandlePatternSignal([
    {t:0,o:100,h:106,l:99,c:105},{t:300000,o:105,h:111,l:104,c:110},
    {t:600000,o:110,h:116,l:109,c:115},{t:900000,o:102,h:112,l:99.9,c:100},
  ]);
  const hanging=detectCandlePatternSignal([
    {t:0,o:100,h:106,l:99,c:105},{t:300000,o:105,h:111,l:104,c:110},
    {t:600000,o:110,h:116,l:109,c:115},{t:900000,o:100,c:102,h:102.1,l:90},
  ]);
  assert.equal(shooting.pattern,'Shooting Star');assert.equal(shooting.side,'DOWN');
  assert.equal(hanging.pattern,'Hanging Man');assert.equal(hanging.side,'DOWN');
});

test('bullish and bearish engulfing patterns override the prior candle color',()=>{
  const bullish=detectCandlePatternSignal([
    {t:0,o:110,h:111,l:99,c:100},{t:300000,o:99,h:112,l:98,c:111},
  ]);
  const bearish=detectCandlePatternSignal([
    {t:0,o:100,h:111,l:99,c:110},{t:300000,o:111,h:112,l:98,c:99},
  ]);
  assert.equal(bullish.pattern,'Bullish Engulfing');assert.equal(bullish.side,'UP');
  assert.equal(bearish.pattern,'Bearish Engulfing');assert.equal(bearish.side,'DOWN');
});

test('tweezer and harami formations are exposed as pattern candidates',()=>{
  const tweezer=detectCandlePatternSignal([
    {t:0,o:105,h:110,l:99,c:100},{t:300000,o:100,h:106,l:99,c:105},
  ]);
  const harami=detectCandlePatternSignal([
    {t:0,o:110,h:111,l:99,c:100},{t:300000,o:102,h:105,l:101,c:103},
  ]);
  assert.ok(tweezer.patterns.some(x=>x.name==='Tweezer Bottom'&&x.side==='UP'));
  assert.ok(harami.patterns.some(x=>x.name==='Bullish Harami'&&x.side==='UP'));
});

test('momentum and EMA slopes select UP and DOWN',()=>{
  assert.equal(detectMomentumSignal(momentumCandles(1),1800000).side,'UP');
  assert.equal(detectMomentumSignal(momentumCandles(-1),1800000).side,'DOWN');
});

test('momentum analysis starts with the five bars retained immediately after restart',()=>{
  const signal=detectMomentumSignal(momentumCandles(1,5),5*60000);
  assert.equal(signal.ready,true);assert.equal(signal.side,'UP');
  assert.equal(signal.returns.fiveMinute,0);
});

test('three-candle stars and soldier/crow formations produce directional signals',()=>{
  const morning=detectCandlePatternSignal([
    {t:0,o:110,h:111,l:99,c:100},
    {t:300000,o:100,h:101,l:98,c:99.5},
    {t:600000,o:99.5,h:112,l:99,c:111},
  ]);
  const evening=detectCandlePatternSignal([
    {t:0,o:100,h:111,l:99,c:110},
    {t:300000,o:110,h:112,l:109,c:110.5},
    {t:600000,o:110.5,h:111,l:98,c:99},
  ]);
  const soldiers=detectCandlePatternSignal([
    {t:0,o:100,h:106,l:99,c:105},
    {t:300000,o:105,h:111,l:104,c:110},
    {t:600000,o:110,h:116,l:109,c:115},
  ]);
  const crows=detectCandlePatternSignal([
    {t:0,o:115,h:116,l:109,c:110},
    {t:300000,o:110,h:111,l:104,c:105},
    {t:600000,o:105,h:106,l:99,c:100},
  ]);
  assert.equal(morning.pattern,'Morning Star');assert.equal(morning.side,'UP');
  assert.equal(evening.pattern,'Evening Star');assert.equal(evening.side,'DOWN');
  assert.equal(soldiers.pattern,'Three White Soldiers');assert.equal(soldiers.side,'UP');
  assert.equal(crows.pattern,'Three Black Crows');assert.equal(crows.side,'DOWN');
});

function momentumCandles(direction=1,count=24){
  let prior=100;
  return Array.from({length:count},(_,i)=>{
    const close=100+i*direction*.1,bar={t:i*60000,o:prior,c:close,h:Math.max(prior,close)+.02,l:Math.min(prior,close)-.02,v:1};
    prior=close;return bar;
  });
}
function timedMomentum(direction,elapsedMs=30000,entryShares=500){
  const windowStart=24*60000;
  return detectTimedStrategy({minuteCandles:momentumCandles(direction),windowStart,now:windowStart+elapsedMs,entryShares});
}

test('momentum signal uses dynamic size and waits for the three-second gate',()=>{
  const before=timedMomentum(1,2999),due=timedMomentum(1,3000,700);
  assert.equal(due.side,'UP');assert.equal(due.entries.length,1);
  assert.equal(due.entries[0].key,'momentum-entry');assert.equal(due.entries[0].shares,700);
  assert.equal(due.entries[0].crossed,true);assert.equal(before.entries[0].crossed,false);
});

test('flat momentum and EMA slopes produce no direction',()=>{
  const flat=timedMomentum(0);assert.equal(flat.side,null);assert.deepEqual(flat.entries,[]);
});

test('single-entry strategy leaves position exits to the existing CLOB rules',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:1000});
  assert.equal(typeof bot.tryExit,'undefined');
  assert.match(bot.snapshot().strategy.exit,/bid\/ask\/mid >= \$0\.99/);
});

test('the 150-second cutoff still blocks the single entry',()=>{
  const before=timedMomentum(1,149999);
  const cutoff=timedMomentum(1,150000);
  assert.equal(before.entries[0].crossed,true);
  assert.equal(cutoff.entries[0].crossed,false);assert.equal(cutoff.entries[0].expired,true);
});

test('only one 5-minute bot and one $10,000 demo bankroll are active',()=>{
  const MultiBot=require('../multi-bot'),bots=new MultiBot();
  assert.deepEqual(Object.keys(bots.bots),['5m']);
  assert.equal(bots.bots['5m'].cash,10000);
  assert.equal(bots.snapshot().account.capital,10000);
  assert.equal(bots.snapshot().timeframes['5m'].strategy.entries[0].shares,500);
  assert.equal(bots.snapshot().timeframes['5m'].strategy.entryDelaySeconds,3);
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

test('share size rises after losses, falls after wins, and stays within 500–1,000',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({capital:1000});
  assert.equal(bot.nextEntryShares(),500);
  bot.positions=Array.from({length:7},(_,i)=>({status:'SETTLED_LOSS',settledAt:i+1}));
  assert.equal(bot.nextEntryShares(),1000);
  bot.positions.push({status:'SETTLED_WIN',settledAt:8});
  assert.equal(bot.nextEntryShares(),900);
  bot.positions.push(...Array.from({length:10},(_,i)=>({status:'SETTLED_WIN',settledAt:i+9})));
  assert.equal(bot.nextEntryShares(),500);
});

test('equity history calculates wins, maximum loss streak, and peak drawdown',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({capital:1000});
  bot.positions=[
    {status:'SETTLED_LOSS',settledAt:1,realizedPnl:-100},
    {status:'SETTLED_LOSS',settledAt:2,realizedPnl:-50},
    {status:'SETTLED_WIN',settledAt:3,realizedPnl:80},
  ];
  const a=bot.snapshot().account;
  assert.equal(a.wins,1);assert.equal(a.maxConsecutiveLosses,2);
  assert.equal(a.maxDrawdown,150);assert.equal(a.maxDrawdownPercent,15);
  assert.deepEqual(a.equityCurve.map(x=>x.equity),[1000,900,850,930]);
});

test('demo fills the requested shares at best ask despite short visible depth',()=>{
  const fill=_test.simulateAtBestAsk([{price:.45,size:50},{price:.46,size:500}],200,.60,.05);
  assert.deepEqual(fill,{shares:200,cost:90,avg:.45,visibleDepth:50,simulatedShares:150});
  assert.equal(_test.simulateAtBestAsk([{price:.049,size:100}],100,.60,.05),null);
  assert.equal(_test.simulateAtBestAsk([{price:.61,size:100}],100,.60,.05),null);
  assert.equal(_test.simulateAtBestAsk([],100,.60,.05),null);
});

test('paper momentum entry records its method and dynamic share size',async()=>{
  const Bot=require('../wick-bot'),md=require('../wick-market-data');
  const oldGetBook=md.getBook;
  md.getBook=async()=>({asks:[{price:.5,size:400}]});
  try{
    const bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000});
    const start=Date.now()-5000;
    bot.market={id:'test-market',slug:'test',title:'Test',tokens:{UP:'up-token',DOWN:'down-token'},raw:{feesEnabled:false}};
    bot.entryState[start]={triggered:{},filled:{},blocks:{}};
    const trigger={side:'UP',shares:700,key:'momentum-entry',signalMethod:'BTC Momentum/Trend',
      signalStrength:4,label:'UP momentum/trend · 700 shares',windowEnd:start+300000};
    await bot.tryEnter(start,trigger,'momentum-entry');
    assert.equal(bot.positions[0].signalMethod,'BTC Momentum/Trend');
    assert.equal(bot.positions[0].shares,700);
    assert.equal(bot.positions[0].entryType,'MOMENTUM_TREND_SINGLE_ENTRY');
    await bot.tryEnter(start,trigger,'momentum-entry');
    assert.equal(bot.positions.length,1);
  }finally{md.getBook=oldGetBook}
});
test('paper entry records simulated shares beyond the visible best-ask size',async()=>{
  const Bot=require('../wick-bot'),md=require('../wick-market-data');
  const oldGetBook=md.getBook;
  md.getBook=async()=>({asks:[{price:.45,size:50}]});
  try{
    const bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000});
    const start=Date.now()-5000;
    bot.market={id:'test-market',slug:'test',title:'Test',tokens:{UP:'up-token',DOWN:'down-token'},raw:{feesEnabled:false}};
    bot.entryState[start]={triggered:{},filled:{},blocks:{}};
    await bot.tryEnter(start,{side:'UP',shares:500,key:'momentum-entry',
      label:'Momentum signal',windowEnd:start+300000,signalMethod:'BTC Momentum/Trend'},'momentum-entry');
    assert.equal(bot.positions[0].shares,500);
    assert.equal(bot.positions[0].avgEntry,.45);
    assert.equal(bot.positions[0].visibleAskSize,50);
    assert.equal(bot.positions[0].simulatedShares,450);
    assert.equal(bot.positions[0].fillModel,'FULL_SIZE_AT_BEST_ASK');
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

test('the single momentum entry remains gated by the three-second delay',async()=>{
  const Bot=require('../wick-bot'),md=require('../wick-market-data'),oldBook=md.getBook,oldNow=Date.now;
  md.getBook=async()=>({asks:[{price:.5,size:1000}]});
  let now=100000;Date.now=()=>now;
  try{
    const bot=new Bot({timeframe:'5m',windowMs:300000,capital:10000}),start=now-1000;
    bot.market={id:'t',slug:'t',title:'t',tokens:{UP:'u',DOWN:'d'},raw:{feesEnabled:false}};
    bot.entryState[start]={triggered:{},filled:{},blocks:{}};
    const trigger={side:'UP',shares:500,key:'momentum-entry',label:'Momentum signal',
      windowEnd:start+300000,signalMethod:'BTC Momentum/Trend'};
    await bot.tryEnter(start,trigger,'momentum-entry');
    assert.equal(bot.positions.length,0);
    now=start+3000;
    await bot.tryEnter(start,trigger,'momentum-entry');
    assert.equal(bot.positions.length,1);
    assert.equal(bot.positions[0].openedAt,now);
  }finally{md.getBook=oldBook;Date.now=oldNow}
});

test('terminal one-sided CLOB bid or ask can identify the binary winner',()=>{
  assert.equal(_test.clobQuoteWinner({bestAsk:.01},{bestBid:.99}),'DOWN');
  assert.equal(_test.clobQuoteWinner({bestBid:.99},{bestAsk:.01}),'UP');
  assert.equal(_test.clobQuoteWinner({bestBid:.61},{bestAsk:.59}),'UP');
  assert.equal(_test.clobQuoteWinner({bestAsk:.01},{}),'DOWN');
  assert.equal(_test.clobQuoteWinner({},{}),null);
});
test('TP trigger accepts any fresh own-side quote at 0.99',()=>{const n=10000;assert.equal(_test.takeProfitHit({bestBid:.99,updatedAt:n},n),true);assert.equal(_test.takeProfitHit({bestAsk:.99,updatedAt:n},n),true);assert.equal(_test.takeProfitHit({mid:.99,updatedAt:n},n),true);assert.equal(_test.takeProfitHit({bestAsk:.989,updatedAt:n},n),false);assert.equal(_test.takeProfitHit({bestAsk:.99,updatedAt:n-5001},n),false)});
test('stop-loss trigger remains at $0.01',()=>{const n=10000;assert.equal(_test.stopLossHit({bestBid:.01,updatedAt:n},n),true);assert.equal(_test.stopLossHit({bestAsk:.01,updatedAt:n},n),true);assert.equal(_test.stopLossHit({mid:.01,updatedAt:n},n),true);assert.equal(_test.stopLossHit({bestBid:.35,updatedAt:n},n),false);assert.equal(_test.stopLossHit({bestBid:.0101,updatedAt:n},n),false);assert.equal(_test.stopLossHit({bestBid:.01,updatedAt:n-5001},n),false)});
test('fresh 0.01 CLOB quote immediately settles the position as a zero-payout loss',async()=>{
  const Bot=require('../wick-bot'),md=require('../wick-market-data'),oldGetBook=md.getBook,oldNow=Date.now;
  let now=100000;Date.now=()=>now;
  md.getBook=async token=>token==='up'
    ?{bids:[{price:.01,size:50}],asks:[{price:.02,size:10}]}
    :{bids:[{price:.90,size:10}],asks:[{price:.91,size:10}]};
  try{
    const bot=new Bot({timeframe:'5m',windowMs:300000,capital:1000});
    bot.cash=955;bot.market={start:90000,tokens:{UP:'up',DOWN:'down'}};
    const p={id:'stop-loss',side:'UP',status:'OPEN',windowStart:90000,totalCost:45,shares:100};
    bot.positions=[p];
    await bot.refreshLiveQuotes(now);
    assert.equal(p.status,'SETTLED_LOSS');
    assert.equal(p.proceeds,0);
    assert.equal(p.realizedPnl,-45);
    assert.equal(bot.cash,955);
    assert.equal(bot.events[0].event,'PAPER_STOP_LOSS');
    assert.equal(p.stopTriggerQuote,.01);
  }finally{md.getBook=oldGetBook;Date.now=oldNow}
});
test('fresh 0.99 CLOB quote immediately settles the position as a one-dollar win',async()=>{
  const Bot=require('../wick-bot'),md=require('../wick-market-data'),oldGetBook=md.getBook,oldNow=Date.now;
  let now=100000;Date.now=()=>now;
  md.getBook=async token=>token==='up'
    ?{bids:[{price:.99,size:50}],asks:[{price:.995,size:10}]}
    :{bids:[{price:.01,size:10}],asks:[{price:.02,size:10}]};
  try{
    const bot=new Bot({timeframe:'5m',windowMs:300000,capital:1000});
    bot.cash=955;bot.market={start:90000,tokens:{UP:'up',DOWN:'down'}};
    const p={id:'take-profit',side:'UP',status:'OPEN',windowStart:90000,totalCost:45,shares:100};
    bot.positions=[p];
    await bot.refreshLiveQuotes(now);
    assert.equal(p.status,'SETTLED_WIN');
    assert.equal(p.proceeds,100);
    assert.equal(p.realizedPnl,55);
    assert.equal(bot.cash,1055);
    assert.equal(bot.events[0].event,'PAPER_TP_HIT');
    assert.ok(p.tpTriggerQuote>=.99);
  }finally{md.getBook=oldGetBook;Date.now=oldNow}
});
test('missed TP waits for and uses official Gamma win result',async()=>{const Bot=require('../wick-bot'),md=require('../wick-market-data'),old=md.getMarket;let m={closed:false,outcomes:['Up','Down'],outcomePrices:['.5','.5']};md.getMarket=async()=>m;try{const b=new Bot({timeframe:'5m',windowMs:300000,capital:1000}),p={id:'w',marketId:'m',windowStart:Date.now()-300000,windowMs:300000,status:'OPEN',shares:100,totalCost:50,side:'UP'};b.cash=950;b.positions=[p];await b.trySettle(p);assert.equal(p.status,'PENDING_CLOB_RESULT');m={closed:true,outcomes:['Up','Down'],outcomePrices:['1','0']};await b.trySettle(p);assert.equal(p.status,'SETTLED_WIN');assert.equal(p.proceeds,100);assert.equal(b.cash,1050)}finally{md.getMarket=old}});
test('official fallback pays zero to the losing side',async()=>{const Bot=require('../wick-bot'),md=require('../wick-market-data'),old=md.getMarket;md.getMarket=async()=>({closed:true,outcomes:['Up','Down'],outcomePrices:['1','0']});try{const b=new Bot({timeframe:'5m',windowMs:300000,capital:1000}),p={id:'l',marketId:'m',windowStart:Date.now()-300000,windowMs:300000,status:'OPEN',shares:100,totalCost:50,side:'DOWN'};b.cash=950;await b.trySettle(p);assert.equal(p.status,'SETTLED_LOSS');assert.equal(p.proceeds,0);assert.equal(p.realizedPnl,-50);assert.equal(b.cash,950)}finally{md.getMarket=old}});
test('stale marks are excluded from floating P&L and equity',()=>{const Bot=require('../wick-bot'),b=new Bot({timeframe:'5m',windowMs:300000,capital:1000});b.cash=900;b.positions=[{status:'OPEN',side:'UP',shares:200,totalCost:100,markBid:.8,markUpdatedAt:Date.now()-20000}];const a=b.snapshot().account;assert.equal(a.unrealizedPnl,0);assert.equal(a.equity,900);assert.equal(a.unpricedOpenPositions,1)});
