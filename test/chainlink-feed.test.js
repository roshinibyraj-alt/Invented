'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {ChainlinkFeed,MAX_AGE_MS}=require('../chainlink-feed');

class FakeWebSocket{
  addEventListener(){}
  send(){}
  close(){}
}

test('Chainlink RTDS updates are aggregated into minute OHLC bars',()=>{
  let now=1800000000000;
  const feed=new ChainlinkFeed({WebSocketImpl:FakeWebSocket,now:()=>now});
  feed.start();
  feed.onMessage(JSON.stringify({payload:{symbol:'btc/usd',data:[
    {timestamp:now,value:100},
    {timestamp:now+1000,value:104},
    {timestamp:now+2000,value:97},
    {timestamp:now+3000,value:102},
  ]}}));
  assert.deepEqual(feed.getMinuteCandles(),[
    {t:now,o:100,h:104,l:97,c:102,v:0},
  ]);
  assert.equal(feed.snapshot().status,'live');
});

test('Chainlink RTDS ignores other symbols and rejects stale data',()=>{
  let now=1800000000000;
  const feed=new ChainlinkFeed({WebSocketImpl:FakeWebSocket,now:()=>now});
  feed.start();
  feed.onMessage(JSON.stringify({payload:{symbol:'eth/usd',timestamp:now,value:2000}}));
  assert.throws(()=>feed.getMinuteCandles(),/waiting for a fresh price update/);
  feed.onMessage(JSON.stringify({payload:{symbol:'btc/usd',timestamp:now,value:100}}));
  now+=MAX_AGE_MS+1;
  assert.throws(()=>feed.getMinuteCandles(),/feed stale/);
});

test('Chainlink RTDS accepts replay arrays and second-based timestamps',()=>{
  const now=1800000000000;
  const feed=new ChainlinkFeed({WebSocketImpl:FakeWebSocket,now:()=>now});
  feed.start();
  feed.onMessage(JSON.stringify({payload:{symbol:'btc/usd',data:[
    {timestamp:now/1000,value:50100},
    {timestamp:now/1000+1,value:50102},
  ]}}));
  const candles=feed.getMinuteCandles();
  assert.equal(candles.length,1);
  assert.equal(candles[0].o,50100);
  assert.equal(candles[0].c,50102);
});
