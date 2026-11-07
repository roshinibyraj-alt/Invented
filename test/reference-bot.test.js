'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const config=require('../config');
const SignalLimitBot=require('../signal-limit-bot');
const MultiBot=require('../multi-bot');
const marketData=require('../wick-market-data');

const WINDOW=config.WINDOW_MS_5M;
const START=1_800_000_000_000;

function makeBot({currentPrice=101,previousClose=100}={}){
  const candleFeed={
    getMinuteCandles:()=>[
      {t:START-120000,o:99,h:101,l:98,c:previousClose},
      // This candle is not closed yet at T−3s, so it must not be used.
      {t:START-60000,o:previousClose,h:110,l:90,c:110},
    ],
    getLatestPrice:()=>({price:currentPrice,timestamp:START-3000}),
  };
  const bot=new SignalLimitBot({candleFeed});
  bot.log=()=>{};
  bot.market={
    id:'market-5m',slug:'btc-updown-5m-test',title:'BTC 5 minute test',
    start:START,end:START+WINDOW,tokens:{UP:'up-token',DOWN:'down-token'},
    feesEnabled:true,feeSchedule:{rate:0.07,exponent:1},
  };
  bot.openStrategyWindow(START,START-10000);
  return bot;
}

function quote(bot,side,at,{bid=0.30,ask=0.60,bidSize=1000,askSize=1000,askLevels}={}){
  bot.liveQuotes[side]={
    status:'LIVE',bestBid:bid,bidSize,bestAsk:ask,askSize,
    mid:(bid+ask)/2,askLevels:askLevels||[{price:ask,size:askSize}],
    updatedAt:at,stale:false,
  };
}

function latchSignal(bot,at=START-3000){
  bot.processStrategyEntry(at);
  return bot.entryTriggerSide;
}

function openEntry(bot,{side='UP',at=START,ask=0.60,askSize=1000,askLevels}={}){
  quote(bot,side,at,{ask,askSize,askLevels});
  bot.processStrategyEntry(at);
  return bot.orders.find(order=>order.kind==='ENTRY');
}

test('only one independent $10,000 BTC 5-minute paper account remains',()=>{
  const multi=new MultiBot();
  assert.deepEqual(Object.keys(multi.bots),['btc-5m-signal']);
  const state=multi.snapshot();
  assert.equal(state.account.capital,10000);
  assert.equal(state.strategies['btc-5m-signal'].account.capital,10000);
  assert.equal(state.strategies['trigger-5m'],undefined);
  assert.equal(state.strategies['prebuy-5m'],undefined);
  assert.deepEqual(state.strategy.timeframes,['5m']);
});

test('the previous completed 1-minute candle and final 57-second comparison choose UP or DOWN',()=>{
  const up=makeBot({currentPrice:101,previousClose:100});
  assert.equal(latchSignal(up),'UP');
  assert.equal(up.entryTriggerCandle.referenceClose,100);
  assert.equal(up.entryTriggerCandle.currentPrice,101);
  assert.equal(up.entryTriggerCandle.durationSeconds,57);

  const equal=makeBot({currentPrice:100,previousClose:100});
  assert.equal(latchSignal(equal),'DOWN');
});

test('scan the upcoming market during the final 10 seconds and signal at T−3s',()=>{
  const bot=makeBot();
  const currentStart=START-WINDOW;
  assert.equal(bot.getWindowStartToScan(START-10001,currentStart),currentStart);
  assert.equal(bot.getWindowStartToScan(START-10000,currentStart),START);
  assert.equal(config.SIGNAL_COMPARE_LEAD_MS,3000);
  assert.equal(config.SIGNAL_SCAN_LEAD_MS,10000);
});

test('no entry is placed before the window opens; one $0.45 limit is placed after open',()=>{
  const bot=makeBot();
  assert.equal(latchSignal(bot),'UP');
  bot.processStrategyEntry(START-1);
  assert.equal(bot.orders.length,0);
  const order=openEntry(bot,{side:'UP',ask:0.60});
  assert.ok(order);
  assert.equal(order.orderType,'LIMIT');
  assert.equal(order.limitPrice,0.45);
  assert.equal(order.requestedShares,500);
  assert.equal(order.side,'UP');
  assert.equal(order.status,'PENDING');
});

test('available ask liquidity fills at the better price and credits rebate without fees',()=>{
  const bot=makeBot();
  latchSignal(bot);
  const order=openEntry(bot,{
    side:'UP',ask:0.42,askSize:500,
    askLevels:[{price:0.42,size:500}],
  });
  assert.equal(order.status,'FILLED');
  assert.equal(order.filledShares,500);
  assert.equal(order.averagePrice,0.42);
  assert.equal(order.fillEvents[0].source,'IMMEDIATE_MARKETABLE_LIMIT');
  assert.equal(order.fillEvents[0].price,0.42);
  const position=bot.positions[0];
  assert.equal(position.avgEntry,0.42);
  assert.equal(position.totalCost,210);
  assert.equal(position.fees,0);
  assert.ok(position.estimatedMakerRebate>0);
  assert.ok(bot.cash>10000-210);
  const tp=bot.orders.find(item=>item.kind==='TAKE_PROFIT');
  assert.equal(tp.orderType,'LIMIT');
  assert.equal(tp.limitPrice,0.99);
  assert.equal(tp.shares,500);
  assert.equal(bot.orders.filter(item=>item.action==='SELL').length,1);
  assert.equal(bot.orders.some(item=>item.kind==='STOP_LOSS'),false);
  assert.equal(bot.snapshot().account.takerFees,0);
  assert.equal(bot.snapshot().strategy.exit.stopLoss,null);
});

test('a lower ask appearing after the order rests fills at the $0.45 limit',()=>{
  const bot=makeBot();
  latchSignal(bot);
  const order=openEntry(bot,{side:'UP',ask:0.60,askSize:1000});
  assert.equal(order.status,'PENDING');

  quote(bot,'UP',START+500,{ask:0.40,askSize:500});
  bot.processStrategyEntry(START+500);
  assert.equal(order.status,'FILLED');
  assert.equal(order.filledShares,500);
  assert.equal(order.averagePrice,0.45);
  assert.equal(order.fillEvents[0].source,'RESTING_LIMIT_MATCH');
  assert.equal(order.fillEvents[0].price,0.45);
  assert.equal(bot.positions[0].avgEntry,0.45);
});

test('unchanged visible ask depth is not counted repeatedly across polls',()=>{
  const bot=makeBot();
  latchSignal(bot);
  const order=openEntry(bot,{side:'UP',ask:0.60,askSize:1000});

  quote(bot,'UP',START+500,{ask:0.40,askSize:100});
  bot.processStrategyEntry(START+500);
  assert.equal(order.status,'PARTIALLY_FILLED');
  assert.equal(order.filledShares,100);
  assert.equal(order.averagePrice,0.45);

  quote(bot,'UP',START+1000,{ask:0.40,askSize:100});
  bot.processStrategyEntry(START+1000);
  assert.equal(order.status,'PARTIALLY_FILLED');
  assert.equal(order.filledShares,100);

  quote(bot,'UP',START+1500,{ask:0.40,askSize:140});
  bot.processStrategyEntry(START+1500);
  assert.equal(order.filledShares,140);
  assert.equal(order.remainingShares,360);
  assert.equal(order.averagePrice,0.45);
});

test('a $0.76 ask with 16 shares never fills the $0.45 limit',async()=>{
  const bot=makeBot();
  latchSignal(bot);
  const order=openEntry(bot,{side:'UP',ask:0.76,askSize:16});
  bot.processStrategyEntry(START+999);
  assert.equal(order.status,'PENDING');
  assert.equal(bot.positions.length,0);

  bot.processStrategyEntry(START+1000);
  assert.equal(order.status,'PENDING');
  assert.equal(order.filledShares,0);
  assert.equal(order.remainingShares,500);
  assert.equal(bot.positions.length,0);
  assert.equal(bot.cash,10000);
  await bot.closePreviousWindows(START+WINDOW,START+WINDOW);
  assert.equal(order.status,'CANCELLED_WINDOW_END');
  assert.equal(order.remainingShares,0);
});

test('partial eligible ask depth stays partial when later asks exceed the limit',()=>{
  const bot=makeBot();
  latchSignal(bot);
  const order=openEntry(bot,{
    side:'UP',ask:0.40,askSize:100,
    askLevels:[{price:0.40,size:100}],
  });
  assert.equal(order.status,'PARTIALLY_FILLED');
  assert.equal(order.filledShares,100);
  assert.equal(bot.positions[0].avgEntry,0.40);
  assert.equal(bot.orders.find(item=>item.kind==='TAKE_PROFIT').shares,100);

  quote(bot,'UP',START+1000,{ask:0.46,askSize:500});
  bot.processStrategyEntry(START+1000);
  assert.equal(order.status,'PARTIALLY_FILLED');
  assert.equal(order.filledShares,100);
  assert.equal(order.remainingShares,400);
  assert.equal(order.averagePrice,0.40);
  assert.equal(bot.positions.length,1);
  assert.equal(bot.positions[0].shares,100);
  assert.equal(bot.positions[0].totalCost,40);
  assert.equal(bot.orders.filter(item=>item.kind==='TAKE_PROFIT').length,1);
  assert.equal(bot.orders.find(item=>item.kind==='TAKE_PROFIT').shares,100);
});

test('$0.99 take profit pays $1 per share, has no stop loss, and rebates enter P&L',()=>{
  const bot=makeBot();
  latchSignal(bot);
  openEntry(bot,{side:'UP',ask:0.45});
  bot.processStrategyEntry(START+1000);
  const position=bot.positions[0];
  const tp=bot.orders.find(item=>item.kind==='TAKE_PROFIT');
  quote(bot,'UP',START+2000,{bid:0.99,ask:1});
  bot.processPendingTakeProfitOrders(START+2000);
  assert.equal(tp.status,'FILLED');
  assert.equal(position.status,'SETTLED_EXIT');
  assert.equal(position.payout,1);
  assert.equal(position.proceeds,500);
  assert.ok(position.estimatedMakerRebate>0);
  assert.equal(position.realizedPnl,500-position.totalCost+position.estimatedMakerRebate);
  assert.equal(bot.orders.some(item=>item.kind==='STOP_LOSS'),false);
});

test('open positions move to official resolution at window end if TP did not fill',async()=>{
  const bot=makeBot();
  latchSignal(bot);
  const order=openEntry(bot,{side:'UP',ask:0.45});
  assert.equal(order.status,'FILLED');
  const position=bot.positions[0];
  assert.equal(position.status,'OPEN');
  await bot.closePreviousWindows(START+WINDOW,START+WINDOW);
  assert.equal(position.status,'PENDING_RESOLUTION');
  assert.equal(position.markStatus,'PENDING_RESOLUTION');
  assert.equal(bot.orders.find(item=>item.kind==='TAKE_PROFIT').status,'EXPIRED_WINDOW_END');
});
