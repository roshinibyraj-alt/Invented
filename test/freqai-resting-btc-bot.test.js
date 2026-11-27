'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Bot = require('../freqai-resting-btc-bot');
const { restoreOrResetLedger } = require('../index');

function fixture(capital = 3000) {
  const start = 1800000000000;
  let now = start + 60000;
  let raw = { windowStart: start, candleStart: start, candleCloseAt: now,
    writtenAt: now, pUp: 0.59, pDown: 0.41, model: 'LightGBMClassifier' };
  const bot = new Bot({ initialCapital: capital, marketData: {}, now: () => now,
    freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: raw }) } });
  const record = bot.records.get('BTC:5m');
  record.marketStatus = 'OPEN';
  record.market = { id: 'market', slug: 'btc-updown-test', start, end: start + 300000,
    tokens: { UP: 'up', DOWN: 'down' }, tickSize: 0.01 };
  function book(side, ask = 0.7, size = 1000) {
    record.quotes[side] = { bestAsk: ask, bestBid: ask == null ? null : ask - 0.01,
      asks: ask == null ? [] : [{ price: ask, size }], updatedAt: now,
      tokenId: record.market.tokens[side], marketId: 'market', windowStart: record.market.start };
  }
  book('UP'); book('DOWN');
  return { bot, record, start, now: () => now,
    time: t => { now = t; }, advance: ms => { now += ms; }, book,
    score: (up, down = 1 - up, fields = {}) => {
      raw = { ...raw, pUp: up, pDown: down, candleStart: now - 60000,
        candleCloseAt: now, writtenAt: now, ...fields };
    },
    check: () => bot.processSide(record),
  };
}
function placed(f) { f.check(); return f.bot.orders[0]; }
function fill(f, side = 'UP', size = 100) {
  f.advance(10); f.book(side, 0.59, size); f.check();
}

test('flat 100-share limit at ask minus 0.10; reserve rather than immediately spend cash', () => {
  const f = fixture(), o = placed(f);
  assert.equal(o.requestedShares, 100); assert.equal(o.limitPrice, 0.6);
  assert.equal(o.status, 'RESTING'); assert.equal(f.bot.positions.length, 0);
  assert.equal(f.bot.cash, 3000); assert.equal(f.bot.availableCash(), 2940);
  assert.equal(f.bot.snapshot().restingOrderSummary.reservedCash, 60);
});

test('minimum 45-second delay, strict >58% threshold, no 51% or fallback entries', () => {
  const f = fixture(); f.time(f.start + 44999); f.score(0.8); f.book('UP'); f.check();
  assert.equal(f.bot.orders.length, 0);
  f.time(f.start + 45000); f.score(0.58, 0.42); f.book('UP'); f.check();
  assert.equal(f.bot.orders.length, 0);
  f.score(0.51); f.check(); assert.equal(f.bot.orders.length, 0);
  f.score(0.58001); f.check(); assert.equal(f.bot.orders.length, 1);
});

test('preserve Invented model-window labels: previous-window boundary score is rejected', () => {
  const f = fixture(); f.time(f.start + 45000);
  f.score(0.9, 0.1, { windowStart: f.start - 300000 }); f.book('UP'); f.check();
  assert.equal(f.bot.orders.length, 0);
  f.time(f.start + 60001); f.score(0.59, 0.41, { windowStart: f.start }); f.book('UP'); f.check();
  assert.equal(f.bot.orders.length, 1);
});

test('same-side changes, neutral scores, and exactly-58% opposite scores keep price fixed', () => {
  const f = fixture(), o = placed(f);
  f.advance(10); f.score(0.9); f.book('UP', 0.9); f.check();
  f.advance(10); f.score(0.5); f.check();
  f.advance(10); f.score(0.42, 0.58); f.check();
  assert.equal(o.status, 'RESTING'); assert.equal(o.limitPrice, 0.6);
  assert.equal(f.bot.orders.length, 1);
});

test('opposite >58% cancels unfilled remainder and places new 100 shares at current ask minus 0.10', () => {
  const f = fixture(), o = placed(f);
  f.advance(10); f.score(0.41, 0.59); f.book('DOWN', 0.82); f.check();
  const replacement = f.bot.orders[0];
  assert.equal(o.status, 'CANCELLED_OPPOSITE_SIGNAL');
  assert.equal(o.cancelledShares, 100); assert.equal(o.reservedCash, 0);
  assert.equal(replacement.side, 'DOWN'); assert.equal(replacement.limitPrice, 0.72);
  assert.equal(replacement.remainingShares, 100);
  assert.equal(f.bot.availableCash(), 2928);
});

test('later strictly-through depth fills at maker limit with zero maker fees', () => {
  const f = fixture(), o = placed(f); fill(f);
  const p = f.bot.positions[0];
  assert.equal(o.status, 'FILLED'); assert.equal(p.shares, 100);
  assert.equal(p.totalCost, 60); assert.equal(p.entryPrice, 0.6);
  assert.equal(p.fees, 0); assert.equal(p.estimatedMakerRebate, 0);
  assert.equal(f.bot.cash, 2940);
  assert.equal(p.fills[0].liquidity, 'MAKER');
});

test('touch alone does not fill; unchanged depth is not reused across ticks or book updates', () => {
  const f = fixture(), o = placed(f);
  f.advance(10); f.book('UP', 0.6); f.check();
  assert.equal(f.bot.positions.length, 0);
  fill(f, 'UP', 40);
  f.check(); f.advance(10); f.book('UP', 0.59, 40); f.check();
  assert.equal(o.filledShares, 40); assert.equal(f.bot.cash, 2976);
  f.advance(10); f.book('UP', 0.59, 60); f.check();
  assert.equal(o.filledShares, 60);
  assert.equal(f.bot.positions.length, 1);
});

test('partially filled shares stay held after opposite replacement, which still requests 100', () => {
  const f = fixture(), first = placed(f); fill(f, 'UP', 40);
  f.advance(10); f.score(0.4); f.book('DOWN', 0.7); f.check();
  assert.equal(first.cancelledShares, 60); assert.equal(first.status, 'CANCELLED_OPPOSITE_SIGNAL');
  assert.equal(f.bot.positions[0].shares, 40); assert.equal(f.bot.positions[0].status, 'OPEN');
  assert.equal(f.bot.orders[0].requestedShares, 100);
  fill(f, 'DOWN');
  assert.equal(f.bot.positions.length, 2);
  assert.ok(f.bot.positions.every(p => p.status === 'OPEN'));
  assert.equal(f.bot.cash, 2916); assert.equal(f.bot.availableCash(), 2916);
});

test('full fill consumes window; opposite signals, old TP and old SL never sell it', () => {
  const f = fixture(); placed(f); fill(f);
  f.advance(10); f.score(0.01); f.book('DOWN', 0.8); f.check();
  f.bot.checkTakeProfits(f.record, 'UP', { mid: 1, bestBid: 1 }, f.now());
  f.bot.checkStopLosses(f.record, 'UP', { mid: 0, bestBid: 0 }, f.now());
  assert.equal(f.bot.orders.length, 1); assert.equal(f.bot.positions[0].status, 'OPEN');
  assert.equal(f.bot.positions[0].shares, 100);
});

test('stale books and different token or window identity cannot fill', () => {
  const f = fixture(); placed(f);
  f.advance(5000); f.record.quotes.UP.asks = [{ price: 0.59, size: 1000 }]; f.check();
  f.book('UP', 0.59); f.record.quotes.UP.tokenId = 'old-token'; f.check();
  assert.equal(f.bot.positions.length, 0);
});

test('resting orders can fill when the model becomes stale; stale predictions cannot replace them', () => {
  const f = fixture(), o = placed(f);
  f.time(f.start + 180000); f.book('UP', 0.59); f.check();
  assert.equal(o.status, 'FILLED');
});

test('expired orders release reserves before new-window activity; partial positions go to resolution', () => {
  const f = fixture(), o = placed(f); fill(f, 'UP', 40);
  f.time(f.start + 300000); f.bot.expireMarket(f.record, f.now());
  assert.equal(o.status, 'EXPIRED'); assert.equal(o.remainingShares, 0);
  assert.equal(f.bot.availableCash(), 2976);
  assert.equal(f.bot.positions[0].status, 'PENDING_RESOLUTION');
  assert.equal(f.bot.accountSnapshot().equity, null);
  f.bot.settleMarket('market', 'UP', f.now() + 1000);
  assert.equal(f.bot.cash, 3016); assert.equal(f.bot.accountSnapshot().realizedPnl, 16);
  f.bot.settleMarket('market', 'UP', f.now() + 2000);
  assert.equal(f.bot.cash, 3016);
  assert.equal(f.bot.snapshot().sizingByAsset.BTC.currentShares, 100);
});

test('a losing resolution loses cost only; following size is still 100', () => {
  const f = fixture(); placed(f); fill(f);
  f.time(f.start + 300000); f.bot.expireMarket(f.record, f.now());
  f.bot.settleMarket('market', 'DOWN', f.now());
  assert.equal(f.bot.cash, 2940); assert.equal(f.bot.accountSnapshot().realizedPnl, -60);
  assert.equal(f.bot.positions[0].status, 'RESOLVED_LOSS');
  assert.equal(f.bot.snapshot().sizingByAsset.BTC.currentShares, 100);
});

test('restart preserves partial inventory, cash, fixed limit and consumed ask depth', () => {
  const f = fixture(); placed(f); fill(f, 'UP', 40);
  const ledger = f.bot.exportLedger(), g = fixture();
  g.time(f.now() + 10); g.bot.restoreLedger(ledger); g.book('UP', 0.59, 40); g.check();
  assert.equal(g.bot.orders[0].filledShares, 40); assert.equal(g.bot.orders[0].remainingShares, 60);
  assert.equal(g.bot.orders[0].limitPrice, 0.6); assert.equal(g.bot.positions[0].shares, 40);
  assert.equal(g.bot.cash, 2976); assert.equal(g.bot.availableCash(), 2940);
});

test('restart after window end expires persisted limits and cannot fill from new window', () => {
  const f = fixture(); placed(f); const ledger = f.bot.exportLedger(), g = fixture();
  g.time(f.start + 301000); g.bot.restoreLedger(ledger);
  assert.equal(g.bot.orders[0].status, 'EXPIRED');
  g.record.market.start += 300000; g.record.market.end += 300000;
  g.book('UP', 0.59); g.check(); assert.equal(g.bot.positions.length, 0);
});

test('empty bids do not become fake zero marks or phantom drawdown', () => {
  const f = fixture(); placed(f); fill(f);
  f.advance(10); f.book('UP', null); f.bot.markPositions(f.now());
  const samples = f.bot.equityCurve.length; f.bot.updateAccountMetrics(f.now(), true);
  assert.equal(f.bot.positions[0].markBid, null);
  assert.equal(f.bot.accountSnapshot().equity, null);
  assert.equal(f.bot.equityCurve.length, samples);
});

test('invalid price offsets and insufficient paper cash do not place orders', () => {
  const f = fixture(); f.book('UP', 0.1); f.check(); assert.equal(f.bot.orders.length, 0);
  const g = fixture(50); g.check(); assert.equal(g.bot.orders.length, 0);
});

test('CLOB websocket message path uses the new maker engine, not recovery/taker methods', () => {
  const f = fixture(); f.bot.tokenRefs.set('up', { recordKey: 'BTC:5m', side: 'UP' });
  function send(ask) { f.bot.handleMarketMessage({ event_type: 'book', asset_id: 'up', timestamp: String(f.now()),
    bids: [{ price: String(ask - 0.01), size: '1000' }], asks: [{ price: String(ask), size: '1000' }] }); }
  send(0.7); assert.equal(f.bot.orders[0].status, 'RESTING');
  f.advance(10); send(0.59); assert.equal(f.bot.positions[0].shares, 100);
  assert.equal(f.bot.orders.length, 1); assert.equal(f.bot.orders[0].execution, 'MAKER_LIMIT');
});

test('strategy switch resets old history and capital once, then restores subsequent new records', async () => {
  const f = fixture(); let archived = 0, saved;
  f.bot.ledgerStore = { archive: async () => { archived++; }, save: async ledger => { saved = ledger; } };
  assert.equal(await restoreOrResetLedger(f.bot,
    { strategyId: 'btc-5m-freqai-recovery-flips-paper-v2' }, Bot.STRATEGY.id), 'reset');
  assert.equal(archived, 1); assert.equal(saved.snapshot.positions.length, 0);
  assert.equal(saved.snapshot.orders.length, 0); assert.equal(saved.snapshot.account.cash, 3000);
  const g = fixture();
  g.bot.ledgerStore = f.bot.ledgerStore;
  assert.equal(await restoreOrResetLedger(g.bot, saved, Bot.STRATEGY.id), 'restored');
  assert.equal(archived, 1);
});

test('malformed saved resting orders fail explicitly', () => {
  const f = fixture(); placed(f); const ledger = f.bot.exportLedger();
  ledger.snapshot.orders[0].requestedShares = 50;
  assert.throws(() => f.bot.restoreLedger(ledger), /Invalid saved resting order/);
});

test('HTTP dashboard state exposes resting limits and no recovery controls', async t => {
  const { once } = require('node:events');
  const startServer = require('../server');
  const f = fixture(); placed(f);
  const server = startServer(f.bot, 0);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/state');
  const state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.strategy.id, Bot.STRATEGY.id);
  assert.equal(state.sizingByAsset.BTC.minimumProbability, 0.58);
  assert.equal(state.sizingByAsset.BTC.currentShares, 100);
  assert.equal(state.orders[0].status, 'RESTING');
  assert.equal(state.account.availableCash, 2940);
  assert.equal(state.recovery, undefined);
  assert.equal(state.freqai.auditTrail, undefined);
  assert.equal(state.orders[0].depthBudget, undefined);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /Taker order history/);
  assert.match(html, /strictly above 70%/);
  assert.doesNotMatch(html, /<h2>Score &amp; flip audit/);
});
