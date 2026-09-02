'use strict';
const { CheapHunterEngine } = require('./engine');
const assert = require('node:assert/strict');

const WINDOW = 300;
const FIRST_WINDOW = Math.floor(Date.now() / 1000 / WINDOW) * WINDOW;

const tokenMap = {};
let askUp = 0.50, askDn = 0.50;

function fakeFetch(url, options) {
  if (url.includes('gamma-api')) {
    const slug = url.match(/slug=(btc-updown-5m-\d+)/)?.[1] || 'test';
    const wStart = parseInt(slug.split('-').pop()) || 0;
    if (!tokenMap[wStart]) tokenMap[wStart] = { up: 'tok_up_' + wStart, dn: 'tok_dn_' + wStart };
    return Promise.resolve({ ok: true, json: () => Promise.resolve([{ conditionId: '0x' + wStart, question: 'BTC ' + wStart, outcomes: JSON.stringify(['Up', 'Down']), clobTokenIds: JSON.stringify([tokenMap[wStart].up, tokenMap[wStart].dn]), closed: false }]) });
  }
  const books = [];
  for (const wStart of Object.keys(tokenMap)) {
    books.push({ asset_id: tokenMap[wStart].up, asks: [{ price: askUp, size: 500 }], bids: [{ price: Math.max(0.01, askUp - 0.01), size: 500 }] });
    books.push({ asset_id: tokenMap[wStart].dn, asks: [{ price: askDn, size: 500 }], bids: [{ price: Math.max(0.01, askDn - 0.01), size: 500 }] });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(books) });
}

function mkEngine() {
  const e = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: 500, onTick: () => {}, onLog: () => {} });
  e.entryWindow = FIRST_WINDOW;
  return e;
}

async function sync(engine, market) {
  await engine.pollClob();
  engine.evaluate();
}

const failures = [];

(async () => {
  // Test 1: GREEN signal, market frozen at 0.50/0.50 → NO fills (realistic)
  {
    const engine = mkEngine();
    engine.candle.lastColor = 'GREEN';
    askUp = 0.50; askDn = 0.50;
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob();
    engine.evaluate();  // places pending orders
    const pending = engine.pendingOrders;
    console.log('\n--- FROZEN MARKET (0.50/0.50) GREEN signal ---');
    console.log('  pending orders:', pending.length);
    console.log('  orders statuses:', pending.map(o => o.status).join(','));
    // No ask ≤ 0.40, so nothing should fill
    if (pending.some(o => o.status === 'FILLED')) failures.push('FROZEN: order filled when ask=0.50 (should not)');
    if (engine.positions.length !== 0) failures.push('FROZEN: expected 0 filled positions');
    if (engine.bankroll !== 500) failures.push('FROZEN: bankroll should stay 500, got ' + engine.bankroll);
    console.log('  bankroll:', engine.bankroll.toFixed(2), '(unchanged, realistic)');
  }

  // Test 2: Ask drops to 0.30 → only orders with limit ≥ 0.30 fill
  {
    const engine = mkEngine();
    engine.candle.lastColor = 'GREEN';
    askUp = 0.28; askDn = 0.72;
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob();
    engine.evaluate();  // place pending
    // Ask UP = 0.28 → funds 0.40,0.35,0.30 fill; 0.25,0.20,0.15 do NOT (ask above)
    await engine.pollClob();
    engine.evaluate();
    const buys = engine.trades.filter(t => t.type === 'BUY');
    console.log('\n--- ASK UP=0.28 ---');
    buys.forEach(b => console.log('   ', b.reason));
    console.log('  fills:', buys.length);
    // Correct: limit 0.40, 0.35, 0.30 fill (ask 0.28 ≤ each)
    if (buys.length !== 3) failures.push('ASK0.28: expected 3 fills (0.40, 0.35, 0.30), got ' + buys.length);
    if (buys.some(b => Math.abs(b.price - 0.28) > 0.001)) failures.push('ASK0.28: fill price should equal ask 0.28, got ' + buys.map(b => b.price).join(','));
    console.log('  fill prices:', buys.map(b => b.price).join(', '), '(all at ask 0.28)');
  }

  // Test 3: No candle signal → skip entire window, no orders
  {
    const engine = mkEngine();
    engine.candle.lastColor = null;
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob();
    engine.evaluate();
    console.log('\n--- NO SIGNAL ---');
    console.log('  pending orders:', engine.pendingOrders.length);
    if (engine.pendingOrders.length !== 0) failures.push('NOSIGNAL: should not place orders without signal');
    console.log('  bankroll:', engine.bankroll.toFixed(2));
  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length === 0) console.log('All checks passed');
  else failures.forEach(f => console.log('  FAIL: ' + f));
  process.exit(failures.length > 0 ? 1 : 0);
})();
