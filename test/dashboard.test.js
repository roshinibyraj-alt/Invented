'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('dashboard groups same-market positions and labels pending P&L clearly', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/pressure-dashboard.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
  assert.ok(script, 'dashboard inline script is present');
  const elements = new Map();
  const context = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, { textContent: '', innerHTML: '', className: '' });
        }
        return elements.get(id);
      },
    },
    fetch: async () => { throw new Error('test keeps refresh offline'); },
    setInterval: () => 0,
    Date,
    Number,
    Math,
    String,
    Intl,
    Array,
  };
  vm.runInNewContext(script, context);

  const now = Date.now();
  const openEntry = (id, unrealizedPnl, markUpdatedAt) => ({
    id,
    marketId: 'market-5m',
    status: 'OPEN',
    timeframe: '5m',
    side: 'UP',
    marketTitle: 'BTC 5-minute window',
    shares: 100,
    entryPrice: 0.30,
    totalCost: 30,
    fees: 0.20,
    markBid: 0.40,
    markUpdatedAt,
    markStatus: 'LIVE',
    unrealizedPnl,
    windowEnd: now + 60_000,
  });
  context.renderPositions([
    openEntry('open-1', 5, now),
    openEntry('open-2', 6, now + 1),
    openEntry('open-3', 7, now + 2),
    {
      status: 'PENDING_RESOLUTION',
      timeframe: '15m',
      side: 'DOWN',
      marketId: 'market-15m',
      marketTitle: 'BTC 15-minute window',
      shares: 10,
      entryPrice: 0.40,
      totalCost: 4,
      fees: 0.10,
      markBid: 0.50,
      markUpdatedAt: now - 60_000,
      markStatus: 'PENDING_RESOLUTION',
      unrealizedPnl: null,
      windowEnd: now + 60_000,
    },
    {
      status: 'PENDING_RESOLUTION',
      timeframe: '5m',
      side: 'DOWN',
      marketId: 'old-market',
      shares: 10,
      entryPrice: 0.40,
      totalCost: 4,
      fees: 0.10,
      markBid: null,
      markUpdatedAt: null,
      markStatus: 'PENDING_RESOLUTION',
      unrealizedPnl: null,
      windowEnd: now + 60_000,
    },
  ], {}, now);

  const rows = elements.get('positionRows').innerHTML;
  assert.equal(elements.get('floatPnl').textContent, '$18.00');
  assert.equal(elements.get('floatPnlDetail').textContent, '3 / 3 open positions have fresh bids');
  assert.equal(elements.get('positionCount').textContent, '3 market groups · 5 entries');
  assert.equal((rows.match(/class="position-row/g) || []).length, 3);
  assert.match(rows, /300 · 3/);
  assert.match(rows, /Average entry \/ best bid/);
  assert.match(rows, /last marks · pending/);
  assert.match(rows, /Awaiting resolution/);
  assert.match(rows, /\$0\.90/);
  assert.doesNotMatch(rows, /-\$4\.10/);
  assert.doesNotMatch(rows, /position-card/);
});

test('paired history renders compact rows instead of a wide table', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/pressure-dashboard.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
  const elements = new Map();
  const context = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', className: '' });
        return elements.get(id);
      },
    },
    fetch: async () => { throw new Error('test keeps refresh offline'); },
    setInterval: () => 0,
    Date,
    Number,
    Math,
    String,
    Intl,
    Array,
  };
  vm.runInNewContext(script, context);
  context.renderPairs([{
    windowEnd: Date.now(),
    entryNumber: 2,
    case: 'A',
    direction: { upMarket: '5m', downMarket: '15m' },
    upPrice: 0.31,
    downPrice: 0.29,
    sharesPerLeg: 100,
    bestAskSum: 0.60,
    fees: 1.23,
    status: 'OPEN',
    realizedPnl: null,
    askSumTarget: 0.7,
  }]);

  const rows = elements.get('pairRows').innerHTML;
  assert.match(rows, /Entry 2/);
  assert.match(rows, /5m UP \+ 15m DOWN/);
  assert.match(rows, /100 shares\/leg/);
  assert.match(rows, /tier \$0\.70/);
  assert.doesNotMatch(rows, /<table/);
  assert.ok(html.indexOf('Paired trade history') < html.indexOf('Current positions'));
  assert.ok(html.indexOf('Current positions') < html.indexOf('Strategy and feed details'));
});
