'use strict';
const { CheapHunterEngine } = require('./engine');

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
  const e = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: 2000, onTick: () => {}, onLog: () => {} });
  e.entryWindow = FIRST_WINDOW;
  return e;
}

const failures = [];

(async () => {
  // Test 1: Frozen market (ask=0.50) → no fills, bankroll unchanged
  {
    const engine = mkEngine();
    engine.candle.lastColor = 'GREEN';
    askUp = 0.50; askDn = 0.50;
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob();
    engine.evaluate();
    console.log('\n--- FROZEN MARKET (0.50) ---');
    console.log('  pending:', engine.pendingOrders.filter(o => o.status === 'PENDING').length);
    console.log('  filled:', engine.pendingOrders.filter(o => o.status === 'FILLED').length);
    console.log('  capital:', engine.bankroll.toFixed(2));
    if (engine.bankroll !== 2000) failures.push('FROZEN: bankroll should be 2000');
    if (engine.pendingOrders.filter(o => o.status === 'FILLED').length !== 0) failures.push('FROZEN: should not fill');
  }

  // Test 2: Ask drops to 0.28 → fills at ask, no fees, capital = 2000 - total cost
  {
    const engine = mkEngine();
    engine.candle.lastColor = 'GREEN';
    askUp = 0.28; askDn = 0.72;
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob();
    engine.evaluate(); // place pending
    await engine.pollClob();
    engine.evaluate(); // check fills
    const buys = engine.trades.filter(t => t.type === 'BUY');
    console.log('\n--- ASK UP=0.28 (no fees) ---');
    buys.forEach(b => console.log('   ', b.reason, 'price:', b.price));
    // 3 fills at 0.28 each = 84.00 cost, no fees
    const totalCost = buys.reduce((s, b) => s + b.cost, 0);
    console.log('  total cost:', totalCost.toFixed(2), '(no fee)');
    console.log('  capital:', engine.bankroll.toFixed(2));
    if (Math.abs(engine.bankroll - (2000 - totalCost)) > 0.01) failures.push('NOCAP: bankroll ' + engine.bankroll + ' != 2000 - ' + totalCost);
    console.log('  check: 2000 -', totalCost.toFixed(2), '=', (2000 - totalCost).toFixed(2), '✓');
  }

  // Test 3: No signal → no orders placed
  {
    const engine = mkEngine();
    engine.candle.lastColor = null;
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob();
    engine.evaluate();
    console.log('\n--- NO SIGNAL ---');
    console.log('  pending:', engine.pendingOrders.length);
    if (engine.pendingOrders.length !== 0) failures.push('NOSIGNAL: should not place orders');
  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length === 0) console.log('All checks passed');
  else failures.forEach(f => console.log('  FAIL: ' + f));
  process.exit(failures.length > 0 ? 1 : 0);
})();
