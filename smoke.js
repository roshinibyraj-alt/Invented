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
  // Test 1: RACE — candle GREEN → BUY DOWN. Down ask dips to 0.30 then bounces.
  // Fill captured during poll that sees DOWN bid ≤ limit (bid = ask - 0.01 = 0.29).
  // 3 fills: limit 0.40, 0.35, 0.30 (0.29 ≤ limit).
  {
    const script = [[0.50, 0.50], [0.70, 0.30], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'GREEN';
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob(); engine.evaluate();   // poll 0: place pending (GREEN → DOWN)
    await engine.pollClob(); engine.evaluate();   // poll 1: DOWN ask 0.30 → bid 0.29 → fills
    await engine.pollClob(); engine.evaluate();   // poll 2: back to 0.50
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- RACE: GREEN candle → DOWN dip to 0.30 → bounce ---');
    filled.forEach(o => console.log('  ✅', o.outcome, 'limit', o.limitPrice, '@ fill', o.fillPrice));
    console.log('  filled:', filled.length, '| bank:', engine.bankroll.toFixed(2));
    if (filled.length !== 3) failures.push('RACE: expected 3 fills, got ' + filled.length);
    if (filled.some(o => o.fillPrice !== o.limitPrice)) failures.push('RACE: fill price mismatch');
  }

  // Test 2: RACE RED — candle RED → BUY UP. Up ask dips to 0.30.
  {
    const script = [[0.50, 0.50], [0.30, 0.70], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'RED';
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();   // UP ask 0.30 → bid 0.29 → fills
    await engine.pollClob(); engine.evaluate();
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- RACE RED: candle RED → UP dip to 0.30 → bounce ---');
    filled.forEach(o => console.log('  ✅', o.outcome, 'limit', o.limitPrice, '@ fill', o.fillPrice));
    console.log('  filled:', filled.length, '| bank:', engine.bankroll.toFixed(2));
    if (filled.length !== 3) failures.push('RACE RED: expected 3 fills, got ' + filled.length);
  }

  // Test 3: FROZEN — price always 0.50, no fills
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

  // Test 4: NO SIGNAL
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

  // Test 5: ALL 6 FILLS — deep dip to 0.10
  {
    const script = [[0.50, 0.50], [0.90, 0.10], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'GREEN'; // → BUY DOWN
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();   // DOWN ask 0.10 → bid 0.09 → all 6 limits fill
    await engine.pollClob(); engine.evaluate();
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- ALL FILLS: GREEN → DOWN deep dip to 0.10 ---');
    filled.forEach(o => console.log('  ✅', o.outcome, 'limit', o.limitPrice, '@ fill', o.fillPrice));
    console.log('  filled:', filled.length, '| bank:', engine.bankroll.toFixed(2));
    if (filled.length !== 6) failures.push('ALL FILLS: expected 6 fills, got ' + filled.length);
  }

  // Test 6: PARTIAL FILL — dip to 0.22, only top 4 limits fill
  {
    const script = [[0.50, 0.50], [0.78, 0.22], [0.50, 0.50]];
    const engine = mkEngine(script);
    engine.candle.lastColor = 'GREEN'; // → BUY DOWN
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    await engine.pollClob(); engine.evaluate();
    await engine.pollClob(); engine.evaluate();   // DOWN ask 0.22 → bid 0.21 → limits ≤ 0.21 fill
    await engine.pollClob(); engine.evaluate();
    const filled = engine.pendingOrders.filter(o => o.status === 'FILLED');
    const pending = engine.pendingOrders.filter(o => o.status === 'PENDING');
    console.log('\n--- PARTIAL: GREEN → DOWN dip to 0.22 ---');
    filled.forEach(o => console.log('  ✅', o.outcome, 'limit', o.limitPrice, '@ fill', o.fillPrice));
    console.log('  filled:', filled.length, '| pending:', pending.length, '| bank:', engine.bankroll.toFixed(2));
    if (filled.length !== 4) failures.push('PARTIAL: expected 4 fills, got ' + filled.length);
    if (pending.length !== 2) failures.push('PARTIAL: expected 2 pending, got ' + pending.length);
  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length === 0) console.log('All checks passed ✅');
  else failures.forEach(f => console.log('  FAIL: ' + f));
  process.exit(failures.length > 0 ? 1 : 0);
})();
