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
  for (const side of ['UP','DOWN']) {
    assert.deepEqual(bot.snapshot().markets[0].ladders[side].map(o=>o.tpPrice),[.9,.8,.7]);
  }
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
test('partial TP sells use visible depth; completed rung never rearms', () => {
  const {bot,tick} = fixture();
  tick(.39,.4,100);
  const p = bot.positions[0];
  tick(.9,.91,30);
  assert.equal(p.shares,70);
  assert.ok(Math.abs(p.realizedPnl-15)<1e-8);
  assert.equal(bot.orders.filter(o=>o.limitPrice===.4 && o.side==='UP').length,1);
  tick(.9,.91,30);
  assert.equal(p.shares,70);
  tick(.9,.91,100);
  assert.equal(p.status,'TAKE_PROFIT');
  assert.ok(Math.abs(bot.cash-3050)<1e-8);
  assert.equal(bot.orders.find(o=>o.limitPrice===.4 && o.side==='UP').status,'COMPLETED');
  assert.equal(bot.orders.find(o=>o.limitPrice===.4 && o.side==='UP').tpPrice,.9);
  assert.equal(bot.positions.length,1);
  tick(.39,.4,100);
  bot.ensureOrders(bot.records.get('BTC:5m'));
  assert.equal(bot.positions.length,1);
  assert.equal(bot.orders.length,6);
  assert.equal(bot.events.filter(e=>e.type==='REARM').length,0);
});
test('partial entry remainder cancels when TP fills and cannot create an orphan buy', () => {
  const {bot,tick} = fixture();
  tick(.39,.4,20);
  tick(.9,.91,10);
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
test('restoring preserves partial fills, liquidity consumed and reserves', () => {
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
test('rebate scenarios survive restore and exclude resolution payouts and equity', () => {
  const {bot,record,tick,setNow} = fixture();
  tick(.39,.4,100);
  tick(.9,.91,30);
  const a = bot.accountSnapshot();
  assert.ok(Math.abs(a.makerRebates.feeEquivalent-1.335)<1e-8);
  assert.equal(a.totalFees,0);
  assert.equal(a.totalRebates,0);
  const copy = new Bot({now:()=>START+2000});
  copy.restoreLedger(JSON.parse(JSON.stringify(bot.exportLedger())));
  assert.deepEqual(copy.accountSnapshot().makerRebates,a.makerRebates);
  setNow(START+300000);
  bot.expireMarket(record,START+300000);
  bot.settleMarket('btc-one','UP',START+301000);
  assert.deepEqual(bot.accountSnapshot().makerRebates,a.makerRebates);
});
test('each rung waits for its TP and stays completed for the rest of the window', () => {
  const {bot,tick} = fixture();
  tick(.28,.29,300);
  const positions = [...bot.positions];
  for (const [bid, expectedClosed] of [[.6,0],[.65,0],[.69,0],[.7,1],[.79,1],[.8,2],[.89,2],[.9,3]]) {
    tick(bid,bid+.01,300);
    assert.equal(positions.filter(p=>p.status==='TAKE_PROFIT').length,expectedClosed,`bid ${bid}`);
  }
  for (const p of positions) {
    const current = bot.orders.find(o=>o.side==='UP' && o.limitPrice===p.entryPrice);
    assert.equal(current.status,'COMPLETED');
    assert.equal(current.tpPrice,p.tpPrice);
    assert.equal(p.exitPrice,p.tpPrice);
  }
  assert.ok(Math.abs(bot.cash-3135)<1e-8);
  tick(.28,.29,1000);
  assert.equal(bot.positions.length,3);
  assert.equal(bot.orders.length,6);
});
test('completed rungs remain disabled after restore; new windows get fresh orders', () => {
  const {bot,tick} = fixture();
  tick(.39,.4,100);
  tick(.9,.91,100);
  const copy = new Bot({now:()=>START+2000});
  copy.restoreLedger(JSON.parse(JSON.stringify(bot.exportLedger())));
  const record=copy.records.get('BTC:5m');
  Object.assign(record,{market:{id:'btc-one',start:START,end:START+300000,tokens:{UP:'up-one',DOWN:'down-one'}},marketStatus:'OPEN'});
  copy.ensureOrders(record);
  record.books.UP={bids:[{price:.39,size:100}],asks:[{price:.4,size:100}]};
  copy.applyBook(record,'UP',record.books.UP,START+2000);
  assert.equal(copy.positions.length,1);
  assert.equal(copy.orders.length,6);
  record.market={id:'btc-two',start:START+300000,end:START+600000,tokens:{UP:'up-two',DOWN:'down-two'}};
  copy.ensureOrders(record);
  assert.equal(copy.orders.filter(o=>o.marketId==='btc-two').length,6);
});
