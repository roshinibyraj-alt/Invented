'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('dashboard shows fresh floating P&L and labels pending marks as estimates', () => {
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

  context.renderPositions([
    {
      status: 'OPEN',
      timeframe: '5m',
      side: 'UP',
      shares: 10,
      entryPrice: 0.40,
      totalCost: 4,
      fees: 0.10,
      markBid: 0.70,
      markUpdatedAt: Date.now(),
      markStatus: 'LIVE',
      unrealizedPnl: 2.90,
      windowEnd: Date.now() + 60_000,
    },
    {
      status: 'PENDING_RESOLUTION',
      timeframe: '15m',
      side: 'DOWN',
      shares: 10,
      entryPrice: 0.40,
      totalCost: 4,
      fees: 0.10,
      markBid: 0.50,
      markUpdatedAt: Date.now() - 60_000,
      markStatus: 'PENDING_RESOLUTION',
      unrealizedPnl: null,
      windowEnd: Date.now() + 60_000,
    },
    {
      status: 'PENDING_RESOLUTION',
      timeframe: '5m',
      side: 'UP',
      shares: 10,
      entryPrice: 0.40,
      totalCost: 4,
      fees: 0.10,
      markBid: null,
      markUpdatedAt: null,
      markStatus: 'PENDING_RESOLUTION',
      unrealizedPnl: null,
      windowEnd: Date.now() + 60_000,
    },
  ], {}, Date.now());

  assert.equal(elements.get('floatPnl').textContent, '$2.90');
  assert.equal(elements.get('positionCount').textContent, '3 active · 1 live marks');
  assert.match(elements.get('positionCards').innerHTML, /Floating P&amp;L · fresh bid/);
  assert.match(elements.get('positionCards').innerHTML, /Last-mark P&amp;L · not live/);
  assert.match(elements.get('positionCards').innerHTML, /Awaiting official resolution/);
  assert.match(elements.get('positionCards').innerHTML, /\$0\.900/);
  assert.match(elements.get('positionCards').innerHTML, /PENDING RESOLUTION/);
  assert.doesNotMatch(elements.get('positionCards').innerHTML, /-\$4\.10/);
});
