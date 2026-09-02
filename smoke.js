'use strict';
const { CheapHunterEngine } = require('./engine');

const WINDOW = 300;
const FIRST = Math.floor(Date.now() / 1000 / WINDOW) * WINDOW;

function makeFetch(script) {
  const tokenMap = {};
  let pollN = 0;
  return function fakeFetch(url) {
    if (url.includes('gamma-api')) {
      const slug = url.match(/slug=(btc-updown-5m-\d+)/)?.[1] || 'test';
      const wStart = parseInt(slug.split('-').pop()) || 0;
      if (!tokenMap[wStart]) tokenMap[wStart] = { up: 'tok_up_' + wStart, dn: 'tok_dn_' + wStart };
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{ conditionId: '0x' + wStart, question: 'BTC ' + wStart, outcomes: JSON.stringify(['Up', 'Down']), clobTokenIds: JSON.stringify([tokenMap[wStart].up, tokenMap[wStart].dn]), closed: false }]) });
    }
    const [u, d] = script[pollN] || [0.50, 0.50];
    pollN += 1;
    const books = [];
    for (const wStart of Object.keys(tokenMap)) {
      books.push({ asset_id: tokenMap[wStart].up, asks: [{ price: u, size: 500 }], bids: [{ price: Math.max(0.01, u - 0.01), size: 500 }] });
      books.push({ asset_id: tokenMap[wStart].dn, asks: [{ price: d, size: 500 }], bids: [{ price: Math.max(0.01, d - 0.01), size: 500 }] });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(books) });
  };
}

function mkEngine(script) {
  const e = new CheapHunterEngine({ fetchImpl: makeFetch(script), bankroll: 2000, onTick: () => {}, onLog: () => {} });
  e.entryWindow = FIRST;
  return e;
}

const failures = [];

(async () => {
  // Test 1: GREEN candle → BUY UP. Up ask dips to 0.30 → 3 fills (bid=0.29 ≤ 0.40/0.35/0.30)
  {
    const script = [[0.50, 0.50], [0.30, 0.70], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'GREEN';
    await engine.discoverWindow(FIRST);
    await engine.discoverWindow(FIRST + WINDOW);
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- GREEN candle → BUY UP · dip 0.30 ---');
    filled.forEach(o => console.log('  ✅', o.outcome, 'limit', o.limitPrice, '@ fill', o.fillPrice));
    console.log('  filled:', filled.length, '| bank:', engine.bankroll.toFixed(2));
    if (filled.length !== 3) failures.push('GREEN-UP: expected 3 fills, got ' + filled.length);
    if (filled.some(o => o.fillPrice !== o.limitPrice)) failures.push('GREEN-UP: fill price mismatch');
  }

  // Test 2: RED candle → BUY DOWN. Down ask dips to 0.30 → 3 fills
  {
    const script = [[0.50, 0.50], [0.70, 0.30], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'RED';
    await engine.discoverWindow(FIRST);
    await engine.discoverWindow(FIRST + WINDOW);
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- RED candle → BUY DOWN · dip 0.30 ---');
    filled.forEach(o => console.log('  ✅', o.outcome, 'limit', o.limitPrice, '@ fill', o.fillPrice));
    console.log('  filled:', filled.length, '| bank:', engine.bankroll.toFixed(2));
    if (filled.length !== 3) failures.push('RED-DOWN: expected 3 fills, got ' + filled.length);
  }

  // Test 3: FROZEN — 0.50 both sides, no fills
  {
    const script = [[0.50, 0.50], [0.50, 0.50], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'GREEN';
    await engine.discoverWindow(FIRST);
    await engine.discoverWindow(FIRST + WINDOW);
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED').length;
    console.log('\n--- FROZEN 0.50: fills', filled, '---');
    if (filled !== 0) failures.push('FROZEN: expected 0 fills, got ' + filled);
  }

  // Test 4: NO SIGNAL
  {
    const engine = mkEngine([[0.50, 0.50]]);
    engine.candle.lastColor = null;
    await engine.discoverWindow(FIRST);
    await engine.discoverWindow(FIRST + WINDOW);
    await engine.pollClob(); engine.evaluate();
    console.log('\n--- NO SIGNAL: pending', engine.pendingOrders.length, '---');
    if (engine.pendingOrders.length !== 0) failures.push('NOSIGNAL: should not place orders');
  }

  // Test 5: ALL 6 FILLS — deep dip to 0.10
  {
    const script = [[0.50, 0.50], [0.10, 0.90], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'GREEN';
    await engine.discoverWindow(FIRST);
    await engine.discoverWindow(FIRST + WINDOW);
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- ALL 6 FILLS · dip 0.10 ---');
    filled.forEach(o => console.log('  ✅', o.outcome, 'limit', o.limitPrice));
    console.log('  filled:', filled.length, '| bank:', engine.bankroll.toFixed(2));
    if (filled.length !== 6) failures.push('ALLFILLS: expected 6 fills, got ' + filled.length);
  }

  // Test 6: PARTIAL — dip to 0.22 → 4 fills (bid=0.21 ≤ 0.40/0.35/0.30/0.25)
  {
    const script = [[0.50, 0.50], [0.22, 0.78], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'GREEN';
    await engine.discoverWindow(FIRST);
    await engine.discoverWindow(FIRST + WINDOW);
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED');
    const pending = engine.pendingOrders.filter(o => o.status === 'PENDING');
    console.log('\n--- PARTIAL · dip 0.22: fills', filled.length, '| pending', pending.length, '---');
    if (filled.length !== 4) failures.push('PARTIAL: expected 4 fills, got ' + filled.length);
    if (pending.length !== 2) failures.push('PARTIAL: expected 2 pending, got ' + pending.length);
  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length === 0) console.log('All passed ✅');
  else failures.forEach(f => console.log('FAIL: ' + f));
  process.exit(failures.length > 0 ? 1 : 0);
})();
