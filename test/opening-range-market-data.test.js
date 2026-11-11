'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {getOpeningRangeCandles}=require('../wick-market-data');

const START=1_800_000_000_000;

function row(openTime,index){
  const open=100+index/100;
  return [openTime,String(open),String(open+0.2),String(open-0.1),
    String(open+0.1),String(20+index),openTime+59999,'0','0','0','0','0'];
}

test('fetches 20 completed baseline candles and the first two aligned window candles',async t=>{
  const originalFetch=global.fetch;
  const rows=Array.from({length:22},(_,index)=>row(START-20*60000+index*60000,index));
  let requestedUrl=null;
  global.fetch=async url=>{
    requestedUrl=new URL(url);
    return {ok:true,json:async()=>rows};
  };
  t.after(()=>{global.fetch=originalFetch});

  const candles=await getOpeningRangeCandles('BTC',START,START+122000);
  assert.equal(candles.previous.length,20);
  assert.equal(candles.opening.length,2);
  assert.equal(candles.opening[0].openTime,START);
  assert.equal(candles.opening[1].openTime,START+60000);
  assert.equal(requestedUrl.searchParams.get('interval'),'1m');
  assert.equal(requestedUrl.searchParams.get('symbol'),'BTCUSDT');
});

test('does not request opening-range data before two candles can close',async()=>{
  await assert.rejects(
    getOpeningRangeCandles('ETH',START,START+61000),
    /not available yet/,
  );
});

test('rejects a response with missing prior or opening candles',async t=>{
  const originalFetch=global.fetch;
  global.fetch=async()=>({ok:true,json:async()=>[row(START,0)]});
  t.after(()=>{global.fetch=originalFetch});
  await assert.rejects(
    getOpeningRangeCandles('ETH',START,START+122000),
    /20 and 2 are required/,
  );
});
