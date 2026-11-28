'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const startServer = require('../server');
const { ProbabilityBot } = require('../probability-bot');
function snapshot() {
  const feed = { snapshot: () => ({ chainlink: { status: 'CONNECTED', latest: { price: 60000, at: Date.now() } } }) };
  const b = new ProbabilityBot({ feed }), s = b.snapshot(), now = s.now;
  s.status = 'RUNNING';
  s.model = { status: 'READY', reason: 'BTC movement estimate', up: .65, down: .35,
    beatPrice: 60010, spot: 60000, uncertaintyMargin: .07, expectedRemainingMoveUsd: 40, at: now,
    scenarios: [{ name: 'Diffusion', weight: .5, expectedTwap: 60000, sd: 30, up: .65 }] };
  s.markets['5m'] = { market: { id: 'm', title: 'BTC test', start: now - 100000, end: now + 200000, tokens: {} },
    quotes: { UP: { bestAsk: .4, bestBid: .39, updatedAt: now }, DOWN: { bestAsk: .61, bestBid: .60, updatedAt: now } },
    edges: { UP: { probability: .65, lowerProbability: .58, bid: .39, ask: .4, conservativeEdge: .168, feePerShare: .012, fresh: true },
      DOWN: { probability: .35, lowerProbability: .28, bid: .60, ask: .61, conservativeEdge: -.342, feePerShare: .012, fresh: true } },
    decision: { action: 'BUY_PENDING', reason: 'UP offers positive conservative edge', side: 'UP', at: now } };
  s.accounts['5m'].equityCurve = [{ at: now - 15000, equity: 1500, settledBalance: 1500 }, { at: now, equity: 1500, settledBalance: 1500 }];
  return s;
}
async function render(html, getState) {
  const nodes = new Map(), handlers = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', className: '', style: {},
      firstChild: { textContent: '' }, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, callback) { handlers.set(id + ':' + type, callback); } });
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { baseURI: 'http://localhost/', getElementById: element, querySelectorAll: () => [] },
    fetch: async () => ({ ok: true, json: async () => getState() }), setInterval() {},
    URL, AbortSignal, Date, console,
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, context, handlers };
}
test('production HTTP exposes the new paper strategy, scores and mobile dashboard', async t => {
  let s = snapshot();
  const server = startServer({ snapshot: () => s }, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const health = await fetch(url + '/api/healthz'); assert.equal(health.status, 200);
  const state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.strategy.id, ProbabilityBot.STRATEGY.id); assert.equal(state.model.up, .65);
  const html = await (await fetch(url)).text();
  assert.match(html, /viewport/); assert.doesNotMatch(html, /94.cent entry|90.cent stop|94¢ Entry/);
  const ui = await render(html, () => s);
  assert.match(ui.nodes.get('sides').innerHTML, /40\.0/);
  assert.match(ui.nodes.get('sides').innerHTML, /65\.0%/);
  assert.match(ui.nodes.get('decision').innerHTML, /positive conservative edge/);
  assert.match(ui.nodes.get('value').innerHTML, /CHEAP/);
  assert.match(ui.nodes.get('explain').innerHTML, /not a trained or calibrated classifier/);
  assert.match(ui.nodes.get('feed').innerHTML, /not the official TWAP stream/);
  assert.match(ui.nodes.get('account').innerHTML, /1,500\.00/);
  assert.match(ui.nodes.get('chart').innerHTML, /<svg/);
  s = { ...s, status: 'ERROR', lastError: 'example data failure' };
  assert.equal((await fetch(url + '/api/healthz')).status, 503);
});
test('dashboard handles warmup, stale books, unknown equity and feed errors without inventing zeros', async () => {
  const s = snapshot(), html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/freqai-dashboard.html'), 'utf8');
  s.model = { status: 'WAITING', reason: 'Waiting for aligned data' }; s.accounts['5m'].equity = null;
  s.markets['5m'].edges.UP.fresh = false; s.feed.referenceError = 'Official reference unavailable';
  const ui = await render(html, () => s);
  assert.match(ui.nodes.get('account').innerHTML, /unknown/);
  assert.match(ui.nodes.get('sides').innerHTML, /STALE/);
  assert.match(ui.nodes.get('feedBanner').textContent, /Official reference unavailable/);
  assert.match(ui.nodes.get('model').innerHTML, /Waiting for aligned data/);
});
test('closed history shows net P&L, entry/exit, fees and more results without a page reload', async () => {
  const s = snapshot(), html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/freqai-dashboard.html'), 'utf8');
  s.accounts['5m'].history = Array.from({ length: 15 }, (_, i) => ({ id: String(i), side: 'UP', status: 'MODEL_EXIT',
    initialShares: 50, entryPrice: .4, exitPrice: .55, pnl: 6.25, cost: 20, fees: 1.25, entryFees: .6,
    exitFees: .65, payout: 26.85, openedAt: s.now - 10000, closedAt: s.now, exitReason: 'BID_ABOVE_FAIR_VALUE' }));
  const ui = await render(html, () => s);
  assert.equal((ui.nodes.get('history').innerHTML.match(/class="trade /g) || []).length, 10);
  assert.match(ui.nodes.get('history').innerHTML, /0\.5500/);
  assert.match(ui.nodes.get('history').innerHTML, /\+\$6\.25/);
  assert.match(ui.nodes.get('history').innerHTML, /1\.2500/);
  ui.handlers.get('moreBtn:click')();
  assert.equal((ui.nodes.get('history').innerHTML.match(/class="trade /g) || []).length, 15);
});
test('chart retains real time spacing and gaps for unknown equity', async () => {
  const s = snapshot(), html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/freqai-dashboard.html'), 'utf8');
  s.accounts['5m'].equityCurve = [{ at: s.now - 30000, equity: 1500, settledBalance: 1500 },
    { at: s.now - 15000, equity: null, settledBalance: 1500 }, { at: s.now, equity: 1490, settledBalance: 1500 }];
  const ui = await render(html, () => s);
  assert.match(ui.nodes.get('chart').innerHTML, /unvalued \(gaps\)/);
  assert.match(ui.nodes.get('chart').innerHTML, /unknown marks are gaps/);
});
test('unknown taker fees do not silently become a fee-free opportunity', async () => {
  const s = snapshot(), html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/freqai-dashboard.html'), 'utf8');
  s.markets['5m'].edges.UP.feePerShare = null; s.markets['5m'].edges.UP.conservativeEdge = null;
  const ui = await render(html, () => s);
  assert.match(ui.nodes.get('value').innerHTML, /Taker fee is unknown/);
});
test('actual process archives an old strategy ledger, binds HTTP and exposes the reset account', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const net = require('node:net'), { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probability-startup-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const store = new (require('../paper-ledger-store'))(ledgerPath);
  await store.save({ strategyId: 'invented-btc5m-ask94-flat300-stop90-v1', accounts: {} });
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  let output = '';
  const child = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, LIVE_TRADING: 'false', PAPER_LEDGER_PATH: ledgerPath, PAPER_LEDGER_BOOTSTRAP: '', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exit; clearTimeout(timer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let state;
  for (let i = 0; i < 30; i++) {
    try { state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json(); break; }
    catch (_) { if (child.exitCode !== null) throw new Error(output); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(state, output);
  assert.equal(state.strategy.id, ProbabilityBot.STRATEGY.id);
  assert.equal(state.accounts['5m'].initialCapital, 1500);
  assert.equal(state.accounts['5m'].history.length, 0);
  assert.equal(state.persistence.enabled, true);
  assert.equal(store.load().strategyId, ProbabilityBot.STRATEGY.id);
});
