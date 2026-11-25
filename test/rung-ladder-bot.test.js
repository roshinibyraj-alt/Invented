'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Bot = require('../rung-ladder-bot');
const START = 1_800_000_000_000;
function fixture(capital = 3000) {
  let now = START + 1000;
  const bot = new Bot({now: () => now, initialCapital: capital});
  const record = bot.records.get('BTC:5m');
  record.market = {id:'btc-one',start:START,end:START+300000,tokens:{UP:'up-one',DOWN:'down-one'}};
  record.marketStatus = 'OPEN';
  bot.ensureOrders(record);
  const tick = (bid, ask, size = 100, side = 'UP') => {
    now += 10;
    const book = {bids:bid == null ? []:[{price:bid,size}], asks:ask == null ? []:[{price:ask,size}]};
    record.books[side] = book;
    bot.applyBook(record,side,book,now);
  };
  return {bot,record,tick,setNow: t => {now=t;}};
}
test('each outcome gets three independent 100-share rung orders and reserves cash', () => {
  const {bot} = fixture();
  assert.equal(bot.orders.length,6);
  assert.equal(bot.cash,3000);
  assert.ok(Math.abs(bot.availableCash()-2790)<1e-8);
  assert.deepEqual(bot.snapshot().markets[0].ladders.UP.map(o=>o.limitPrice),[.4,.35,.3]);
});
test('depth is shared across rungs and unchanged snapshots cannot refill it', () => {
  const {bot,tick} = fixture();
  tick(.24,.25,120);
  assert.equal(bot.positions.reduce((s,p)=>s+p.originalShares,0),120);
  tick(.24,.25,120);
  assert.equal(bot.positions.reduce((s,p)=>s+p.originalShares,0),120);
  tick(.24,.25,150);
  assert.equal(bot.positions.reduce((s,p)=>s+p.originalShares,0),150);
  assert.ok(bot.orders.some(o=>o.status==='PARTIAL'));
});
test('no fills above a rung and each side is independent', () => {
  const {bot,tick} = fixture();
  tick(.44,.45);
  assert.equal(bot.positions.length,0);
  tick(.39,.4,30,'DOWN');
  assert.equal(bot.positions.length,1);
  assert.equal(bot.positions[0].side,'DOWN');
  assert.equal(bot.positions[0].entryPrice,.4);
  assert.equal(bot.positions[0].shares,30);
  assert.equal(bot.cash,2988);
});
test('partial TP sells use visible depth; own rung rearms only after fully sold', () => {
  const {bot,tick} = fixture();
  tick(.39,.4,100);
  const p = bot.positions[0];
  tick(.6,.61,30);
  assert.equal(p.shares,70);
  assert.ok(Math.abs(p.realizedPnl-6)<1e-8);
  assert.equal(bot.orders.filter(o=>o.limitPrice===.4 && o.side==='UP').length,1);
  tick(.6,.61,30);
  assert.equal(p.shares,70);
  tick(.6,.61,100);
  assert.equal(p.status,'TAKE_PROFIT');
  assert.ok(Math.abs(bot.cash-3020)<1e-8);
  assert.equal(bot.orders.find(o=>o.limitPrice===.4 && o.side==='UP').cycle,2);
  assert.equal(bot.positions.length,1,'new rung cannot buy on same TP event');
  tick(.39,.4,100);
  assert.equal(bot.positions.length,2);
  assert.equal(bot.positions[0].cycle,2);
});
test('partial entry remainder cancels when TP fills and cannot create an orphan buy', () => {
  const {bot,tick} = fixture();
  tick(.39,.4,20);
  tick(.6,.61,10);
  const old = bot.orders.find(o=>o.positionId===bot.positions[0].id);
  assert.equal(old.entryCancelled,true);
  assert.equal(old.reservedCash,0);
  tick(.39,.4,100);
  assert.equal(bot.positions[0].originalShares,20);
});
test('expiry cancels buys and resolves remaining shares without stop-loss', () => {
  const {bot,record,tick,setNow} = fixture();
  tick(.39,.4,100);
  tick(null,.01,100);
  assert.ok(bot.positions.every(p=>p.status==='OPEN'),'empty bid must not close any rung');
  const cost = bot.positions.reduce((s,p)=>s+p.totalCost,0);
  const quantity = bot.positions.reduce((s,p)=>s+p.shares,0);
  setNow(START+300000);
  bot.expireMarket(record,START+300000);
  assert.equal(bot.availableCash(),bot.cash);
  assert.ok(bot.positions.every(p=>p.status==='PENDING_RESOLUTION'));
  const before = bot.cash;
  bot.settleMarket('btc-one','UP',START+301000);
  assert.equal(bot.cash,before+quantity);
  assert.ok(Math.abs(bot.accountSnapshot().realizedPnl-(quantity-cost))<1e-8);
  const cash=bot.cash;
  bot.settleMarket('btc-one','UP',START+302000);
  assert.equal(bot.cash,cash,'no duplicate payout');
});
test('restoring preserves partial fills, liquidity consumed, reserves and rearm sequence', () => {
  const {bot,tick} = fixture();
  tick(.39,.4,20);
  const copy = new Bot({now:()=>START+2000});
  copy.restoreLedger(JSON.parse(JSON.stringify(bot.exportLedger())));
  assert.equal(copy.cash,bot.cash);
  assert.equal(copy.availableCash(),bot.availableCash());
  assert.equal(copy.positions[0].shares,20);
  const r=copy.records.get('BTC:5m');
  Object.assign(r,{market:{id:'btc-one',start:START,end:START+300000,tokens:{UP:'up-one',DOWN:'down-one'}},marketStatus:'OPEN'});
  r.books.UP={bids:[{price:.39,size:20}],asks:[{price:.4,size:20}]};
  copy.applyBook(r,'UP',r.books.UP,START+2000);
  assert.equal(copy.positions[0].shares,20);
});
test('insufficient funds never overspend or reserve imaginary cash', () => {
  const {bot,tick} = fixture(40);
  tick(.29,.3,1000);
  assert.ok(bot.cash>=-1e-8);
  assert.ok(bot.availableCash()>=0);
  assert.equal(bot.positions.reduce((s,p)=>s+p.totalCost,0),40);
});
