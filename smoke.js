'use strict';
const { CheapHunterEngine } = require('./engine');

const WINDOW = 300;
const FIRST_WINDOW = Math.floor(Date.now() / 1000 / WINDOW) * WINDOW;

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
  e.entryWindow = FIRST_WINDOW;
  return e;
}

const failures = [];

(async () => {
  // Test 1: RACE — ask dips to 0.30 then bounces back to 0.50.
  // Fill must be captured during the poll that sees 0.30.
  {
    // poll 0: 0.50 → evaluate places pending, poll 1: 0.30 → fills caught, poll 2: 0.50
    const script = [[0.50, 0.50], [0.30, 0.70], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'GREEN';
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob(); engine.evaluate();   // poll 0: place pending
    await engine.pollClob();                       // poll 1: dip to 0.30 → fills captured
    await engine.pollClob(); engine.evaluate();   // poll 2: back to 0.50
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- RACE: dip 0.30 → bounce 0.50 ---');
    filled.forEach(o => console.log('  ✅', o.outcome, 'limit', o.limitPrice, '@ fill', o.fillPrice));
    console.log('  filled:', filled.length, '| bank:', engine.bankroll.toFixed(2));
    if (filled.length !== 3) failures.push('RACE: expected 3 fills, got ' + filled.length);
    if (filled.some(o => o.fillPrice !== o.limitPrice)) failures.push('RACE: fill price mismatch');
  }

  // Test 2: FROZEN — ask always 0.50, no fills ever
  {
    const script = [[0.50, 0.50], [0.50, 0.50], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'GREEN';
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED').length;
    console.log('\n--- FROZEN: always 0.50 ---');
    console.log('  filled:', filled, '| bank:', engine.bankroll.toFixed(2));
    if (filled !== 0) failures.push('FROZEN: expected 0 fills');
    if (engine.bankroll !== 2000) failures.push('FROZEN: bankroll should be 2000');
  }

  // Test 3: NO SIGNAL → no orders
  {
    const engine = mkEngine([[0.50, 0.50]]);
    engine.candle.lastColor = null;
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob(); engine.evaluate();
    console.log('\n--- NO SIGNAL ---');
    console.log('  pending:', engine.pendingOrders.length);
    if (engine.pendingOrders.length !== 0) failures.push('NOSIGNAL: should not place orders');
  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length === 0) console.log('All checks passed');
  else failures.forEach(f => console.log('  FAIL: ' + f));
  process.exit(failures.length > 0 ? 1 : 0);
})();
