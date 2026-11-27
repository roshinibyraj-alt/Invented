'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Bot = require('../freqai-taker-btc-bot');
const { restoreOrResetLedger } = require('../index');
const { valuationSummary, settledBalanceHistory } = require('../paper-valuation');

const START = 1800000000000;
function fixture() {
  let now = START + 60000;
  const bot = new Bot({ initialCapital: 3000, marketData: {}, now: () => now,
    freqaiWorker: { snapshot: () => ({ status: 'READY' }) } });
  const record = bot.records.get('BTC:5m');
  record.marketStatus = 'OPEN';
  record.market = { id: 'market', slug: 'btc-test', start: START, end: START + 300000,
    tokens: { UP: 'up', DOWN: 'down' } };
  const common = { asset: 'BTC', timeframe: '5m', shares: 100, originalShares: 100,
    windowStart: START, windowEnd: START + 300000, marketId: 'market', side: 'UP',
    entryAt: START, requestedShares: 100, fees: 1, entryPrice: .5 };
  bot.positions = [
    { ...common, id: 'closed', status: 'RESOLVED_WIN', totalCost: 79, realizedPnl: 20,
      resolvedAt: START + 10000, markStatus: 'CLOSED', unrealizedPnl: null },
    { ...common, id: 'open', status: 'OPEN', totalCost: 50, realizedPnl: null,
      markStatus: 'LIVE', markBid: .6, markUpdatedAt: now, unrealizedPnl: 9 },
    { ...common, id: 'pending', status: 'PENDING_RESOLUTION', totalCost: 60,
      realizedPnl: null, markStatus: 'LAST_MARK_PENDING_RESOLUTION', markBid: .99,
      markUpdatedAt: START, unrealizedPnl: null },
  ];
  bot.cash = 2908;
  bot.equityCurve = [{ at: START, equity: 3000 }, { at: START + 15000, equity: 3010 }];
  return { bot, record, now: () => now, time: t => { now = t; } };
}

test('pending settlement keeps live equity unknown but exposes settled balance and priced-position P&L', () => {
  const f = fixture(), s = f.bot.snapshot(), a = s.account;
  assert.equal(a.equity, null);
  assert.equal(a.unrealizedPnl, null);
  assert.equal(a.settledBalance, 3020);
  assert.equal(a.cash, 2908);
  assert.equal(a.valuation.pricedPositions, 1);
  assert.equal(a.valuation.unpricedPositions, 1);
  assert.equal(a.valuation.pendingPositions, 1);
  assert.equal(a.valuation.knownMarkedValue, 60);
  assert.equal(a.valuation.knownUnrealizedPnl, 9);
  assert.equal(a.valuation.unpricedCostBasis, 61);
  assert.deepEqual(a.settledBalanceCurve, [
    { at: START, equity: 3000 }, { at: START + 10000, equity: 3020 },
    { at: f.now(), equity: 3020 },
  ]);
  assert.equal(a.settlementHistoryIncomplete, false);
});

test('unknown marks never release money or manufacture a zero-value equity sample', () => {
  const f = fixture(), before = structuredClone(f.bot.positions), curve = structuredClone(f.bot.equityCurve);
  f.bot.updateAccountMetrics(f.now(), true);
  assert.deepEqual(f.bot.equityCurve, curve);
  for (let i = 0; i < 3; i++) f.bot.snapshot();
  assert.equal(f.bot.cash, 2908);
  assert.deepEqual(f.bot.positions, before);
  f.time(f.now() + 15000);
  const a = f.bot.snapshot().account;
  assert.equal(a.settledBalanceCurve.at(-1).at, f.now());
  assert.equal(a.settledBalanceCurve.at(-1).equity, 3020);
  assert.equal(a.valuation.pricedPositions, 0);
  assert.equal(a.valuation.unpricedPositions, 2);
});

test('fresh zero bids remain valid marks; null, stale, future and closed-market marks are not live', () => {
  const base = { status: 'OPEN', markStatus: 'LIVE', shares: 100, totalCost: 50, fees: 1,
    markBid: 0, markUpdatedAt: START };
  assert.equal(valuationSummary([base], START, 2000).knownUnrealizedPnl, -51);
  for (const change of [{ markBid: null }, { markBid: NaN }, { markBid: 1.1 },
    { markUpdatedAt: START - 2001 }, { markUpdatedAt: START + 1 },
    { status: 'PENDING_RESOLUTION' }, { markStatus: 'STALE' }]) {
    assert.equal(valuationSummary([{ ...base, ...change }], START, 2000).unpricedPositions, 1);
  }
});

test('settled history uses full ledger, actual credit times and zero-P&L settlements', () => {
  const positions = Array.from({ length: 205 }, (_, i) => ({
    realizedPnl: i === 0 ? 0 : 1, resolvedAt: START + i * 1000,
  }));
  const h = settledBalanceHistory(positions.reverse(), 3000, 3204, START + 300000, START - 1000);
  assert.equal(h.incomplete, false);
  assert.equal(h.points.length, 207);
  assert.equal(h.points[1].at, START);
  assert.equal(h.points[1].equity, 3000);
  assert.equal(h.points.at(-1).equity, 3204);
});

test('same-time settlements combine and missing settlement timestamps do not invent a historical path', () => {
  const h = settledBalanceHistory([{ realizedPnl: 20, resolvedAt: START },
    { realizedPnl: -5, exitAt: START }], 3000, 3015, START + 60000, START - 1000);
  assert.equal(h.points.length, 3);
  assert.equal(h.points[1].equity, 3015);
  const unknown = settledBalanceHistory([{ realizedPnl: 20, resolvedAt: null }],
    3000, 3020, START, START - 1000);
  assert.equal(unknown.incomplete, true);
  assert.deepEqual(unknown.points, [{ at: START, equity: 3020 }]);
});

test('no trades and fully priced positions continue to show genuine live equity', () => {
  const f = fixture(); f.bot.positions = []; f.bot.cash = 3000;
  let a = f.bot.snapshot().account;
  assert.equal(a.equity, 3000);
  assert.equal(a.valuation.unpricedPositions, 0);
  assert.equal(a.settledBalanceCurve.at(-1).equity, 3000);
  const live = fixture(); live.bot.positions = live.bot.positions.filter(p => p.id !== 'pending');
  live.bot.cash += 61;
  a = live.bot.snapshot().account;
  assert.equal(a.equity, 3029);
  assert.equal(a.unrealizedPnl, 9);
  assert.equal(a.valuation.status, 'LIVE');
});

test('same strategy restores existing cash, fills, outcomes and old equity history without reset', async () => {
  const f = fixture();
  f.bot.positions = [];
  f.bot.cash = 3000;
  f.bot.freqaiWorker = { snapshot: () => ({ status: 'READY', lastPrediction: {
    windowStart: START, candleCloseAt: f.now(), writtenAt: f.now(), pUp: .7, pDown: .3,
  } }) };
  f.record.quotes.UP = { bestBid: .39, bestAsk: .4, asks: [{ price: .4, size: 100 }],
    updatedAt: f.now(), tokenId: 'up', marketId: 'market', windowStart: START };
  f.bot.processSide(f.record);
  assert.equal(f.bot.positions.length, 1);
  const ledger = f.bot.exportLedger(), restored = fixture().bot;
  restored.ledgerStore = { archive: async () => { throw Error('History must not reset'); } };
  assert.equal(await restoreOrResetLedger(restored, ledger, Bot.STRATEGY.id), 'restored');
  assert.equal(restored.cash, f.bot.cash);
  assert.deepEqual(restored.positions.map(p => p.fills), f.bot.positions.map(p => p.fills));
  assert.deepEqual(restored.equityCurve, f.bot.equityCurve);
  assert.equal(restored.snapshot().strategy.id, Bot.STRATEGY.id);
});

async function renderState(state) {
  const html = fs.readFileSync(path.join(__dirname, '../public/freqai-dashboard.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const nodes = new Map();
  vm.runInNewContext(script, {
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id,
      { textContent: '', innerHTML: '', className: '', style: {} }); return nodes.get(id); } },
    fetch: async () => ({ ok: true, json: async () => state }),
    setTimeout() {}, Date, Intl, console,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(nodes.get('status')?.textContent, 'OFFLINE');
  return nodes;
}

test('actual dashboard script shows settled balance, partial marked P&L and both chart series', async () => {
  const f = fixture(), nodes = await renderState(f.bot.snapshot());
  assert.equal(nodes.get('equity').textContent, '$3,020.00');
  assert.match(nodes.get('equityLabel').textContent, /Settled balance/);
  assert.equal(nodes.get('settledBalance').textContent, '$3,020.00');
  assert.match(nodes.get('totalPnl').textContent, /\+\$20.00 realized/);
  assert.match(nodes.get('openPnl').textContent, /\+\$9.00/);
  assert.match(nodes.get('openPnlLabel').textContent, /partial/);
  assert.match(nodes.get('equityStatus').textContent, /1 awaiting resolution/);
  assert.match(nodes.get('equityChartStatus').textContent, /last valid sample/);
  assert.match(nodes.get('equityChart').innerHTML, /class="chart-settled"/);
  assert.match(nodes.get('equityChart').innerHTML, /class="chart-line"/);
  assert.doesNotMatch(nodes.get('equityChart').innerHTML, /NaN|Infinity|undefined/);
});

test('stale open position displays awaiting valuation instead of a fake zero floating P&L', async () => {
  const f = fixture();
  f.bot.positions.find(p => p.id === 'open').unrealizedPnl = null;
  f.bot.positions.find(p => p.id === 'open').markStatus = 'STALE';
  const nodes = await renderState(f.bot.snapshot());
  assert.equal(nodes.get('openPnl').textContent, 'Awaiting valuation');
  assert.match(nodes.get('position').innerHTML, /waiting for a fresh bid/);
  assert.doesNotMatch(nodes.get('position').innerHTML, /\$0\.00<small>/);
});

test('live chart uses timestamps and leaves a genuine gap when marks were unavailable', async () => {
  const f = fixture(), state = f.bot.snapshot();
  state.account.equityCurve = [
    { at: START, equity: 3000 }, { at: START + 15000, equity: 3010 },
    { at: START + 120000, equity: 3020 },
  ];
  state.now = START + 180000;
  const nodes = await renderState(state);
  const d = nodes.get('equityChart').innerHTML.match(/class="chart-line" d="([^"]*)"/)[1];
  assert.equal((d.match(/M/g) || []).length, 2);
  assert.equal((d.match(/L/g) || []).length, 1);
  assert.match(nodes.get('equityChart').innerHTML, /H[\d.]+ V[\d.]+/);
});
