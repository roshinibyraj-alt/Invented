'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../public/pressure-dashboard.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];

function renderDashboard(state) {
  const elements = new Map();
  const makeElement = () => ({
    textContent: '',
    innerHTML: '',
    className: '',
    hidden: false,
    dataset: {},
    attributes: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
  });
  const context = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
    },
    fetch: async () => ({ ok: true, json: async () => state }),
    setInterval: () => 0,
    Date,
    Number,
    Math,
    String,
    Intl,
    Array,
    Object,
    JSON,
    Error,
  };
  vm.runInNewContext(script, context);
  return new Promise((resolve) => setImmediate(() => resolve(elements)));
}

test('mobile dashboard renders all eight markets, trading rules, and paper-only status', async () => {
  assert.ok(script, 'dashboard inline script is present');
  const markets = ['BTC', 'ETH', 'SOL', 'DOGE'].flatMap((asset) => ['5m', '15m'].map((timeframe) => ({
    asset,
    timeframe,
    title: `${asset} ${timeframe} Up or Down`,
    start: 1_800_000_000_000,
    end: 1_800_000_300_000,
    marketStatus: 'OPEN',
    sideStates: {
      UP: { mid: 0.5, bestBid: 0.49, bestAsk: 0.51, dipSeen: true, bounceSeen: true, orderStatus: 'RESTING', limitPrice: 0.48, requestedShares: 100, filledShares: 0 },
      DOWN: { mid: 0.3, bestBid: 0.29, bestAsk: 0.31, dipSeen: false, bounceSeen: false, orderStatus: 'WAITING_FOR_DIP', limitPrice: 0.48, requestedShares: 100, filledShares: 0 },
    },
  })));
  const elements = await renderDashboard({
    now: 1_800_000_001_000,
    mode: 'DEMO ONLY',
    status: 'RUNNING',
    statusReason: 'Monitoring CLOB updates',
    strategy: { name: 'Midpoint dip and bounce', version: 'dip-bounce-v1' },
    websocket: { status: 'CONNECTED', lastMessageAt: 1_800_000_001_000 },
    account: { initialCapital: 3000, cash: 2952, availableCash: 2952, equity: 2999, realizedPnl: 0, unrealizedPnl: -1, openPositions: 1, wins: 0, losses: 0, winRate: 0, maxDrawdown: 1, maxDrawdownPercent: 0.03, equityCurve: [] },
    markets,
    positions: [{ asset: 'BTC', timeframe: '5m', side: 'UP', status: 'OPEN', shares: 100, entryPrice: 0.48, totalCost: 48, markBid: 0.47, unrealizedPnl: -1, windowEnd: 1_800_000_300_000, marketTitle: 'Bitcoin Up or Down' }],
    orders: [{ time: 1_800_000_001_000, asset: 'BTC', timeframe: '5m', side: 'UP', action: 'BUY_LIMIT', status: 'FILLED', limitPrice: 0.48, requestedShares: 100, filledShares: 100, windowEnd: 1_800_000_300_000 }],
    events: [
      { time: 1_800_000_001_000, asset: 'BTC', timeframe: '5m', side: 'UP', message: 'Take-profit hit', outcome: 'good' },
      { time: 1_800_000_001_000, asset: 'ETH', timeframe: '15m', side: 'DOWN', message: 'Resolution loss', outcome: 'bad' },
    ],
  });

  assert.equal(elements.get('marketLiveCount').textContent, '8 / 8');
  assert.match(elements.get('marketGrid').innerHTML, /BTC/);
  assert.match(elements.get('marketGrid').innerHTML, /DOGE/);
  assert.match(elements.get('marketGrid').innerHTML, /WAITING_FOR_DIP/);
  assert.match(elements.get('positionList').innerHTML, /100/);
  assert.match(elements.get('orderList').innerHTML, /FILLED/);
  assert.match(elements.get('eventList').innerHTML, /Take-profit hit/);
  assert.match(elements.get('eventList').innerHTML, /#176e4c/);
  assert.match(elements.get('eventList').innerHTML, /#e66854/);
  assert.match(html, /Arm below \$0\.35/);
  assert.match(html, /midpoint at \$0\.50 or higher/);
  assert.match(html, /Sweep visible asks up to \$0\.99/);
  assert.match(html, /100-share taker buy/);
  assert.match(html, /No stop-loss/);
  assert.match(html, /official resolution/);
  assert.match(html, /SIMULATION ONLY/);
  assert.match(html, /@media \(max-width:420px\)/);
});

test('dashboard escapes market and event text before rendering it', async () => {
  const elements = await renderDashboard({
    status: 'RUNNING',
    now: Date.now(),
    account: {},
    markets: [{ asset: '<script>', timeframe: '5m', title: '<img src=x>', marketStatus: 'OPEN', sideStates: {} }],
    positions: [],
    orders: [],
    events: [{ time: Date.now(), message: '<script>alert(1)</script>', outcome: 'neutral' }],
    strategy: {},
    websocket: {},
  });
  assert.doesNotMatch(elements.get('marketGrid').innerHTML, /<script>|<img/);
  assert.doesNotMatch(elements.get('eventList').innerHTML, /<script>/);
  assert.match(elements.get('marketGrid').innerHTML, /&lt;SCRIPT&gt;/);
});
