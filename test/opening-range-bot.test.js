'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const cfg=require('../config');
const OpeningRangeBot=require('../opening-range-bot');
const MultiBot=require('../multi-bot');

const START=1_800_000_000_000;
const WINDOW=cfg.WINDOW_MS_5M;

function candle(openTime,open,high,low,close){
  return {openTime,closeTime:openTime+59999,open,high,low,close,volume:100};
}

function rangeData(side='UP',weak=false){
  const previous=Array.from({length:20},(_,index)=>
    candle(START-(20-index)*60000,100,100.2,99.9,100.1));
  const first=side==='DOWN'
    ?candle(START,100,100.1,99.8,99.9)
    :candle(START,100,100.2,99.9,100.1);
  const second=side==='DOWN'
    ?candle(START+60000,99.9,100,weak?99.95:99.4,weak?99.79:99.5)
    :candle(START+60000,100.1,weak?100.22:100.6,100.05,weak?100.21:100.5);
  return {previous,opening:[first,second]};
}

function makeMarket(asset){
  return {
    id:`${asset.toLowerCase()}-market`,
    asset,
    slug:`${asset.toLowerCase()}-updown-5m-test`,
    title:`${asset} Up or Down`,
    start:START,
    end:START+WINDOW,
    tokens:{UP:`${asset}-UP`,DOWN:`${asset}-DOWN`},
    feesEnabled:true,
    feeSchedule:{rate:0.07,exponent:1},
  };
}

function quote(ask=0.5,bid=0.49,size=1000,updatedAt=START+cfg.SIGNAL_READY_AFTER_MS){
  return {
    status:'LIVE',
    bestBid:bid,
    bidSize:size,
    bestAsk:ask,
    askSize:size,
    askLevels:ask==null?[]:[{price:ask,size}],
    bidLevels:bid==null?[]:[{price:bid,size}],
    updatedAt,
    stale:false,
  };
}

async function fixture({btc='UP',eth='UP',ask=0.5,bid=0.49,size=1000,weak=false}={}){
  const data={
    async getBtcMarket(){return makeMarket('BTC')},
    async getEthMarket(){return makeMarket('ETH')},
    async getOpeningRangeCandles(asset){return rangeData(asset==='BTC'?btc:eth,weak)},
    async getBook(){return {bids:[],asks:[]}},
    async getMarket(){return {closed:true,outcomes:['Up','Down'],outcomePrices:['1','0']}},
    resolvedWinner(){return 'UP'},
  };
  const bot=new OpeningRangeBot({marketData:data});
  bot.log=()=>{};
  bot.btcMarket=makeMarket('BTC');
  bot.market=makeMarket('ETH');
  bot.orderWindowStart=START;
  bot.openStrategyWindow(START,START);
  for(const side of ['UP','DOWN']){
    bot.btcLiveQuotes[side]=quote(ask,bid,size);
    bot.liveQuotes[side]=quote(ask,bid,size);
  }
  return {bot,data};
}

test('confirms a breakout only when the second candle breaks the first range with enough body strength',()=>{
  const {analyzeOpeningRange}=OpeningRangeBot._test;
  const up=analyzeOpeningRange(rangeData('UP'),START);
  const down=analyzeOpeningRange(rangeData('DOWN'),START);
  const weak=analyzeOpeningRange(rangeData('UP',true),START);
  assert.equal(up.side,'UP');
  assert.equal(down.side,'DOWN');
  assert.ok(up.bodyMultiple>=cfg.BREAKOUT_BODY_MULTIPLE);
  assert.equal(weak.side,null);
  assert.equal(weak.setupStatus,'WEAK_BREAKOUT');
});

test('waits for two completed candles before evaluating any setup',async()=>{
  const {bot}=await fixture();
  const changed=await bot.processStrategyEntry(START+cfg.SIGNAL_READY_AFTER_MS-1);
  assert.equal(changed,false);
  assert.equal(bot.positions.length,0);
});

test('does not buy if signal loading finishes after the entry cutoff',async()=>{
  const {bot}=await fixture();
  const now=START+cfg.ENTRY_CUTOFF_MS-1;
  const originalNow=Date.now;
  Date.now=()=>START+cfg.ENTRY_CUTOFF_MS+1;
  try{
    await bot.processStrategyEntry(now);
  }finally{
    Date.now=originalNow;
  }
  assert.equal(bot.positions.length,0);
  assert.equal(bot.assetSignals.BTC.entryStatus,'NO_TRADE_CUTOFF');
  assert.equal(bot.assetSignals.ETH.entryStatus,'NO_TRADE_CUTOFF');
});

test('opens independent BTC and ETH positions within the fee-inclusive risk cap',async()=>{
  const {bot}=await fixture();
  const now=START+cfg.SIGNAL_READY_AFTER_MS+100;
  bot.btcLiveQuotes.UP=quote(0.5,0.49,1000,now);
  bot.liveQuotes.UP=quote(0.5,0.49,1000,now);
  const changed=await bot.processStrategyEntry(now);
  assert.equal(changed,true);
  assert.deepEqual(bot.positions.map(position=>position.asset).sort(),['BTC','ETH']);
  for(const position of bot.positions){
    assert.equal(position.side,'UP');
    assert.ok(position.shares>=cfg.MIN_ENTRY_SHARES);
    assert.ok(position.totalCost+position.fees<=cfg.ENTRY_BUDGET_PER_ASSET+1e-6);
  }
  assert.ok(bot.cash>=cfg.DEMO_CAPITAL-2*cfg.ENTRY_BUDGET_PER_ASSET-1e-6);
  assert.equal(bot.positions[0].entryMode,'OPENING_RANGE_BREAKOUT');
});

test('price and spread filters do not trigger a fill',async()=>{
  const highAsk=await fixture({ask:0.7,bid:0.69});
  const highAskNow=START+cfg.SIGNAL_READY_AFTER_MS+100;
  highAsk.bot.btcLiveQuotes.UP=quote(0.7,0.69,1000,highAskNow);
  highAsk.bot.liveQuotes.UP=quote(0.7,0.69,1000,highAskNow);
  await highAsk.bot.processStrategyEntry(highAskNow);
  assert.equal(highAsk.bot.positions.length,0);
  assert.equal(highAsk.bot.assetSignals.BTC.entryStatus,'WAITING_FOR_PRICE_BAND');

  const wideSpread=await fixture();
  wideSpread.bot.btcLiveQuotes.UP=quote(0.5,0.4,1000,highAskNow);
  wideSpread.bot.liveQuotes.UP=quote(0.5,0.4,1000,highAskNow);
  await wideSpread.bot.processStrategyEntry(highAskNow);
  assert.equal(wideSpread.bot.positions.length,0);
  assert.equal(wideSpread.bot.assetSignals.BTC.entryStatus,'WAITING_FOR_TIGHT_SPREAD');

  const crossedBook=await fixture();
  crossedBook.bot.btcLiveQuotes.UP=quote(0.5,0.55,1000,highAskNow);
  crossedBook.bot.liveQuotes.UP=quote(0.5,0.55,1000,highAskNow);
  await crossedBook.bot.processStrategyEntry(highAskNow);
  assert.equal(crossedBook.bot.positions.length,0);
  assert.equal(crossedBook.bot.assetSignals.BTC.entryStatus,'WAITING_FOR_TIGHT_SPREAD');
});

test('does not book partial fills when visible depth is below the risk-sized order',async()=>{
  const {bot}=await fixture({size:5});
  const now=START+cfg.SIGNAL_READY_AFTER_MS+100;
  bot.btcLiveQuotes.UP=quote(0.5,0.49,5,now);
  bot.liveQuotes.UP=quote(0.5,0.49,5,now);
  await bot.processStrategyEntry(now);
  assert.equal(bot.positions.length,0);
  assert.equal(bot.cash,cfg.DEMO_CAPITAL);
  assert.equal(bot.assetSignals.BTC.entryStatus,'WAITING_FOR_FULL_DEPTH');
});

test('rejects quotes older than two seconds or timestamped in the future',async()=>{
  const {bot}=await fixture();
  const now=START+cfg.SIGNAL_READY_AFTER_MS+100;
  bot.btcLiveQuotes.UP=quote(0.5,0.49,1000,now-cfg.MAX_QUOTE_AGE_MS-1);
  bot.liveQuotes.UP=quote(0.5,0.49,1000,now+1);
  await bot.processStrategyEntry(now);
  assert.equal(bot.positions.length,0);
  assert.equal(bot.assetSignals.BTC.entryStatus,'WAITING_FOR_FRESH_BOOK');
  assert.equal(bot.assetSignals.ETH.entryStatus,'WAITING_FOR_FRESH_BOOK');
});

test('only trades the breakout side and settles from the exact market result',async()=>{
  const {bot}=await fixture({btc:'DOWN',eth:'UP'});
  const now=START+cfg.SIGNAL_READY_AFTER_MS+100;
  bot.btcLiveQuotes.DOWN=quote(0.5,0.49,1000,now);
  bot.liveQuotes.UP=quote(0.5,0.49,1000,now);
  await bot.processStrategyEntry(now);
  assert.deepEqual(bot.positions.map(position=>[position.asset,position.side]).sort(),
    [['BTC','DOWN'],['ETH','UP']]);
  const position=bot.positions.find(item=>item.asset==='BTC');
  position.status='PENDING_RESOLUTION';
  assert.equal(bot.finalizeResolution(position,'DOWN',START+WINDOW),true);
  assert.equal(position.marketId,'btc-market');
  assert.equal(position.settlementBasis,'POLYMARKET_RESOLUTION');
});

test('publishes the replacement strategy as the only 5-minute paper bot',()=>{
  const multi=new MultiBot();
  const snapshot=multi.snapshot();
  assert.deepEqual(Object.keys(multi.bots),['opening-range-breakout']);
  assert.equal(snapshot.strategy.id,'opening-range-breakout');
  assert.equal(snapshot.strategy.signal.openingCandles,2);
  assert.equal(snapshot.strategy.entries.maxRiskPerPosition,15);
  assert.equal(snapshot.strategy.execution,'PAPER ONLY');
});
