'use strict';
const { CheapHunterEngine } = require('./engine');

const WINDOW = 300;
const FIRST_WINDOW = Math.floor(Date.now() / 1000 / WINDOW) * WINDOW;

const windowTokens = {};
function fakeFetch(url, options) {
  if (url.includes('gamma-api')) {
    const slug = url.match(/slug=(btc-updown-5m-\d+)/)?.[1] || 'test';
    const wStart = parseInt(slug.split('-').pop()) || 0;
    windowTokens[wStart] = { up: 'tok_up_' + wStart, dn: 'tok_dn_' + wStart };
    return Promise.resolve({ ok: true, json: () => Promise.resolve([{ conditionId: '0x' + wStart, question: 'BTC ' + wStart, outcomes: JSON.stringify(['Up', 'Down']), clobTokenIds: JSON.stringify([windowTokens[wStart].up, windowTokens[wStart].dn]), closed: false }]) });
  }
  const books = [];
  for (const wStart of Object.keys(windowTokens)) {
    books.push({ asset_id: windowTokens[wStart].up, asks: [{ price: 0.50, size: 100 }], bids: [{ price: 0.49, size: 100 }] });
    books.push({ asset_id: windowTokens[wStart].dn, asks: [{ price: 0.50, size: 100 }], bids: [{ price: 0.49, size: 100 }] });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(books) });
}

const failures = [];
(async () => {
  // Test 1: GREEN signal → BUY UP × 6
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: 500, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = FIRST_WINDOW;   // allow trading NOW
    engine.candle.lastColor = 'GREEN';
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    engine.evaluate();
    const buys = (engine.trades || []).filter(t => t.type === 'BUY');
    console.log('\n--- GREEN → BUY UP × 6 ---');
    buys.forEach(b => console.log('   ', b.reason));
    console.log('  buys:', buys.length);
    if (buys.length !== 6) failures.push('GREEN: expected 6 buys, got ' + buys.length);
    if (buys.some(b => b.outcome !== 'UP')) failures.push('GREEN: all buys should be UP');
    const costTotal = buys.reduce((s, b) => s + b.cost, 0);
    console.log('  capital after:', engine.bankroll.toFixed(2), '| cost:', costTotal.toFixed(2));
  }

  // Test 2: RED signal → BUY DOWN × 6
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: 500, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = FIRST_WINDOW;
    engine.candle.lastColor = 'RED';
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    engine.evaluate();
    const buys = (engine.trades || []).filter(t => t.type === 'BUY');
    console.log('\n--- RED → BUY DOWN × 6 ---');
    buys.forEach(b => console.log('   ', b.reason));
    console.log('  buys:', buys.length);
    if (buys.length !== 6) failures.push('RED: expected 6 buys, got ' + buys.length);
    if (buys.some(b => b.outcome !== 'DOWN')) failures.push('RED: all buys should be DOWN');
  }

  // Test 3: NO SIGNAL → skip
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: 500, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = FIRST_WINDOW;
    engine.candle.lastColor = null;
    await engine.discoverWindow(FIRST_WINDOW);
    await engine.discoverWindow(FIRST_WINDOW + WINDOW);
    engine.evaluate();
    const buys = (engine.trades || []).filter(t => t.type === 'BUY');
    console.log('\n--- NO SIGNAL → skip ---');
    console.log('  buys:', buys.length);
    if (buys.length !== 0) failures.push('NOSIGNAL: expected 0 buys, got ' + buys.length);
  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length === 0) console.log('All checks passed');
  else failures.forEach(f => console.log('  FAIL: ' + f));
  process.exit(failures.length > 0 ? 1 : 0);
})();
