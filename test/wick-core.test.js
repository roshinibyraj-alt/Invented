'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {aggregate,detectCandlePatternSignal,applyPatternAccuracy,detectTimedStrategy}=require('../wick-core');
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

const bullishHistory=[
  {t:0,o:110,h:111,l:99,c:100},
  {t:300000,o:99,h:112,l:98,c:111},
];
const bearishHistory=[
  {t:0,o:100,h:111,l:99,c:110},
  {t:300000,o:111,h:112,l:98,c:99},
];
function timedPattern(history,elapsedMs=30000,entryShares=500,options={}){
  const windowMs=options.windowMs??300000,entryDelayMs=options.entryDelayMs??3000,entryCutoffMs=options.entryCutoffMs??270000;
  const normalized=history.map((c,i)=>({...c,t:i*windowMs})),windowStart=normalized.length*windowMs;
  const candles=[...normalized,{t:windowStart,o:history.at(-1).c,h:history.at(-1).c+1,
    l:history.at(-1).c-1,c:history.at(-1).c+.5}];
  return detectTimedStrategy({minuteCandles:candles,windowStart,windowMs,now:windowStart+elapsedMs,entryShares,entryDelayMs,entryCutoffMs});
}

test('pattern signals always follow the detected side and keep the three-second gate',()=>{
  const before=timedPattern(bullishHistory,2999),up=timedPattern(bullishHistory,3000,700),down=timedPattern(bearishHistory,3000,600);
  assert.equal(up.patternSide,'UP');assert.equal(up.side,'UP');assert.equal(up.patternAction,'FOLLOW');assert.equal(up.patternHistoricalWinRate,49.84);
  assert.equal(up.entries[0].side,'UP');assert.equal(up.entries[0].shares,700);assert.equal(up.entries[0].crossed,true);assert.equal(before.entries[0].crossed,false);
  assert.equal(down.patternSide,'DOWN');assert.equal(down.side,'DOWN');assert.equal(down.patternAction,'FOLLOW');assert.equal(down.entries[0].shares,600);
});

test('neutral candle patterns produce no directional entry',()=>{
  const result=timedPattern([{t:0,o:100,h:101,l:99,c:100},{t:300000,o:100,h:101,l:99,c:100}],30000);
  assert.equal(result.side,null);assert.deepEqual(result.entries,[]);
});

test('single-entry strategy leaves position exits to the existing CLOB rules',()=>{
  const Bot=require('../wick-bot'),bot=new Bot({timeframe:'5m',windowMs:300000,capital:1000});
  assert.equal(typeof bot.tryExit,'undefined');
  assert.match(bot.snapshot().strategy.exit,/bid\/ask\/mid >= \$0\.99/);
});

test('timed strategy buys 100 shares of the cheaper side at 10-80s, pauses 90-140s, then buys the expensive side at 150-240s',()=>{
 const Bot=require('../wick-bot'),bot=new Bot(),start=1_000_000;bot.market={id:'m',slug:'m',title:'m',start,tokens:{UP:'u',DOWN:'d'}};bot.openStrategyWindow(start,start);for(let s=10;s<=240;s+=10){const now=start+s*1000;bot.liveQuotes=s<90?{UP:{status:'LIVE',bestAsk:.4,askSize:1000,updatedAt:now},DOWN:{status:'LIVE',bestAsk:.6,askSize:1000,updatedAt:now}}:{UP:{status:'LIVE',bestAsk:.7,askSize:1000,updatedAt:now},DOWN:{status:'LIVE',bestAsk:.3,askSize:1000,updatedAt:now}};bot.processTimedEntries(start,now)}assert.equal(bot.positions.length,18);assert.ok(bot.positions.every(p=>p.shares===100&&p.side==='UP'));assert.equal(bot.snapshot().strategy.entries.maxEntrySeconds,240)});
test('entry schedule skips stale quotes and the 90-150 second pause',()=>{const Bot=require('../wick-bot'),bot=new Bot(),start=1_000_000;bot.market={id:'m',slug:'m',title:'m',start,tokens:{UP:'u',DOWN:'d'}};bot.openStrategyWindow(start,start);let now=start+10_000;bot.liveQuotes={UP:{status:'LIVE',bestAsk:.4,askSize:100,updatedAt:now},DOWN:{status:'STALE',bestAsk:.2,askSize:100,updatedAt:now}};bot.processTimedEntries(start,now);assert.equal(bot.positions.length,1);assert.equal(bot.positions[0].side,'UP');for(const s of [90,100,110,120,130,140]){now=start+s*1000;bot.liveQuotes={UP:{status:'LIVE',bestAsk:.9,askSize:100,updatedAt:now},DOWN:{status:'LIVE',bestAsk:.1,askSize:100,updatedAt:now}};bot.processTimedEntries(start,now)}assert.equal(bot.positions.length,1);now=start+150_000;bot.liveQuotes={UP:{status:'LIVE',bestAsk:.7,askSize:100,updatedAt:now},DOWN:{status:'LIVE',bestAsk:.3,askSize:100,updatedAt:now}};bot.processTimedEntries(start,now);assert.equal(bot.positions.length,2);assert.equal(bot.positions[0].side,'UP')});
test('a best bid below $0.30 does not trigger a forced sale or lock entries',async()=>{
  const Bot=require('../wick-bot'),md=require('../wick-market-data'),oldGetBook=md.getBook,oldNow=Date.now;
  let now=2_000_000;Date.now=()=>now;
  md.getBook=async token=>token==='up'
    ?{bids:[{price:.40,size:100}],asks:[{price:.41,size:100}]}
    :{bids:[{price:.29,size:100}],asks:[{price:.30,size:100}]};
  try{
    const bot=new Bot({timeframe:'5m',windowMs:300000,capital:1000});
    const start=1_800_000;bot.market={id:'m',slug:'m',title:'m',start,tokens:{UP:'up',DOWN:'down'}};
    bot.orderWindowStart=start;bot.windowFiredEntries=6;bot.cash=870;
    bot.positions=[
      {id:'up',side:'UP',status:'OPEN',windowStart:start,shares:100,totalCost:60},
      {id:'down',side:'DOWN',status:'OPEN',windowStart:start,shares:100,totalCost:70},
    ];
    await bot.refreshLiveQuotes(now);
    assert.deepEqual(bot.positions.map(p=>p.status),['OPEN','OPEN']);
    assert.equal(bot.snapshot().strategy.martingaleExit,undefined);
    assert.equal(bot.events.some(e=>e.event.includes('MARTINGALE_EXIT')),false);
  }finally{md.getBook=oldGetBook;Date.now=oldNow}
});
test('240-second cutoff blocks entries after the last scheduled time',()=>{const Bot=require('../wick-bot'),bot=new Bot(),start=1_000_000,now=start+240001;bot.market={id:'m',slug:'m',title:'m',start,tokens:{UP:'u',DOWN:'d'}};bot.openStrategyWindow(start,start);bot.liveQuotes={UP:{status:'LIVE',bestAsk:.8,askSize:1000,updatedAt:now},DOWN:{status:'LIVE',bestAsk:.7,askSize:1000,updatedAt:now}};bot.processTimedEntries(start,now);assert.equal(bot.positions.length,0);assert.equal(bot.snapshot().strategy.entries.maxEntrySeconds,240)});
test('only the 5m strategy is running',()=>{
  const MultiBot=require('../multi-bot'),bots=new MultiBot();
  bots.bots['5m'].positions.push({status:'SETTLED_WIN',settledAt:Date.now(),realizedPnl:0,fees:0,
    estimatedMakerRebate:1.23,shares:100});
  const snapshot=bots.snapshot();
  assert.deepEqual(Object.keys(bots.bots),['5m']);
  assert.equal(bots.bots['5m'].windowMs,300000);
  assert.equal(snapshot.account.capital,10000);assert.deepEqual(snapshot.strategy.timeframes,['5m']);
  assert.equal(snapshot.timeframes['5m'].strategy.entries.initialEntryDelaySeconds,30);
  assert.equal(snapshot.timeframes['5m'].strategy.entries.initialEntryMaxAsk,.75);
  assert.equal(snapshot.timeframes['5m'].strategy.entries.baseShares,500);
  assert.equal(snapshot.timeframes['5m'].strategy.entries.sizeMultiplier,2);
  assert.equal(snapshot.timeframes['5m'].strategy.entries.maxSuccessfulEntries,2);
  assert.equal(snapshot.timeframes['5m'].strategy.entries.maxEntrySeconds,270);
  assert.equal(snapshot.account.estimatedMakerRebate,1.23);
  assert.equal(snapshot.account.takerFees,0);
});
test('15m strategy uses an independent 15-minute window and 9/810-second gates',()=>{
  const before=timedPattern(bullishHistory,8999,500,{windowMs:900000,entryDelayMs:9000,entryCutoffMs:810000});
  const triggered=timedPattern(bullishHistory,9000,500,{windowMs:900000,entryDelayMs:9000,entryCutoffMs:810000});
  const cutoff=timedPattern(bullishHistory,810000,500,{windowMs:900000,entryDelayMs:9000,entryCutoffMs:810000});
  assert.equal(triggered.side,'UP');assert.equal(triggered.entries[0].crossed,true);
  assert.equal(before.entries[0].crossed,false);assert.equal(cutoff.entries[0].expired,true);
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

test('the cutoff blocks all timed entries at 270 seconds',()=>{
  const Bot=require('../wick-bot'),bot=new Bot(),start=1_000_000,now=start+270000;
  bot.market={id:'m',slug:'m',title:'m',start,tokens:{UP:'u',DOWN:'d'}};
  bot.openStrategyWindow(start,start);
  bot.liveQuotes={UP:{status:'LIVE',bestAsk:.8,askSize:1000,updatedAt:now},
    DOWN:{status:'LIVE',bestAsk:.8,askSize:1000,updatedAt:now}};
  bot.processTimedEntries(start,now);
  assert.equal(bot.windowOrders.length,0);
  assert.equal(bot.positions.length,0);
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
  assert.equal(_test.simulateAtBestAsk([{price:.61,size:100}],100,1+1e-9,0).avg,.61);
});

test('a timed entry requires a fresh live CLOB ask',()=>{
  const Bot=require('../wick-bot'),bot=new Bot(),start=1_000_000,now=start+30000;
  bot.market={id:'m',slug:'m',title:'m',start,tokens:{UP:'u',DOWN:'d'}};
  bot.openStrategyWindow(start,start);
  bot.liveQuotes={UP:{status:'STALE',bestAsk:.80,askSize:1000,updatedAt:now},
    DOWN:{status:'LIVE',bestAsk:.80,askSize:1000,updatedAt:now-6000}};
  bot.processTimedEntries(start,now);
  assert.equal(bot.positions.length,0);
  assert.equal(bot.windowOrders.length,0);
});

test('paper market orders pay the configured crypto taker fee and official outcome settlement is applied',()=>{
  assert.ok(Math.abs(_test.feeFor({feesEnabled:true},.45,300)-.07*.45*.55*300)<1e-12);
  assert.equal(_test.feeFor({feesEnabled:false},.45,300),0);
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

test('historical accuracy is informational; every directional pattern is followed',()=>{
 const followHigh=applyPatternAccuracy({side:'UP',pattern:'Morning Star'}),followLow=applyPatternAccuracy({side:'UP',pattern:'Bullish Engulfing'}),followDown=applyPatternAccuracy({side:'DOWN',pattern:'Gravestone Doji'});
 assert.deepEqual({side:followHigh.side,action:followHigh.action,winRate:followHigh.winRate},{side:'UP',action:'FOLLOW',winRate:51.30});
 assert.deepEqual({side:followLow.side,action:followLow.action,winRate:followLow.winRate},{side:'UP',action:'FOLLOW',winRate:49.84});
 assert.deepEqual({side:followDown.side,action:followDown.action,winRate:followDown.winRate},{side:'DOWN',action:'FOLLOW',winRate:43.66});
 assert.equal(applyPatternAccuracy({side:null,pattern:'Standard Doji'}).side,null);
 const unknown=applyPatternAccuracy({side:'UP',pattern:'Unknown Pattern'});assert.equal(unknown.side,'UP');assert.equal(unknown.action,'FOLLOW');assert.equal(unknown.winRate,null);
});
