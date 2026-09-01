'use strict';
const { CheapHunterEngine } = require('./engine');

const WINDOW = 300;
const START = 300;
const FIRST_WINDOW = Math.floor(Date.now() / 1000 / WINDOW) * WINDOW;

let step = 0, mode = null, nowMs = 0;
const windowTokens = {};

function askOf(p) { return Math.round((p + 0.005) * 100) / 100; }

function upPrice() {
  const d = step;
  if (mode === 'all3') return 0.80;
  if (mode === 'c3-only') return d < 29 ? 0.50 : 0.80;
  if (mode === 'no-fire') return d < 29 ? 0.50 : 0.55;
  return d < 29 ? 0.50 : 0.80;
}
function dnPrice() {
  const d = step;
  if (mode === 'all3') return 0.15;
  if (mode === 'c3-only') return d < 29 ? 0.50 : 0.15;
  if (mode === 'no-fire') return d < 29 ? 0.50 : 0.45;
  return (d >= 25 && d < 29) ? 0.18 : (d < 25 ? 0.50 : 0.45);
}

function fakeFetch(url, options) {
  if (url.includes('gamma-api')) {
    const slug = url.match(/slug=(btc-updown-5m-\d+)/)?.[1] || 'test';
    const wStart = parseInt(slug.split('-').pop()) || 0;
    windowTokens[wStart] = { up: 'tok_up_' + wStart, dn: 'tok_dn_' + wStart };
    return Promise.resolve({ ok: true, json: () => Promise.resolve([{ conditionId: '0x' + wStart, question: 'BTC ' + wStart, outcomes: JSON.stringify(['Up', 'Down']), clobTokenIds: JSON.stringify([windowTokens[wStart].up, windowTokens[wStart].dn]), closed: false }]) });
  }
  const up = upPrice(), dn = dnPrice();
  const books = [];
  for (const wStart of Object.keys(windowTokens)) {
    books.push({ asset_id: windowTokens[wStart].up, asks: [{ price: askOf(up), size: 100 }], bids: [] });
    books.push({ asset_id: windowTokens[wStart].dn, asks: [{ price: askOf(dn), size: 100 }], bids: [] });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(books) });
}

async function runWindowPart(engine, wStart, m, durSeconds) {
  mode = m;
  step = 0;
  nowMs = wStart * 1000;
  Date.now = () => nowMs;
  await engine.discoverWindow(wStart);
  for (let s = 0; s < durSeconds + 2; s++) {
    await engine.pollClob();
    engine.evaluate();
    nowMs += 1000;
    step += 1;
  }
  return (engine.trades || []).filter(t => t.type === 'BUY');
}

const failures = [];
(async () => {
  // Test 1: no check fires (nothing cheap)
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: START, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = 0;
    const buys = await runWindowPart(engine, FIRST_WINDOW, 'no-fire', 35);
    console.log('\n--- NO CHEAP (no fire) ---');
    console.log('  buys:', buys.length, '| bank:', engine.bankroll.toFixed(2));
    if (buys.length !== 0) failures.push('NO-FIRE: expected 0 buys');
  }

  // Test 2: c3-only fires (DN <0.20 at 29s only)
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: START, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = 0;
    const buys = await runWindowPart(engine, FIRST_WINDOW + WINDOW, 'c3-only', 35);
    console.log('\n--- C3 ONLY ---');
    buys.forEach(b => console.log('   ', b.reason));
    console.log('  buys:', buys.length);
    if (buys.length !== 1) failures.push('C3: expected 1 buy, got ' + buys.length);
  }

  // Test 3: all 3 fire (DN cheap from start at 0.15)
  {
    const engine = new CheapHunterEngine({ fetchImpl: fakeFetch, bankroll: START, onTick: () => {}, onLog: () => {} });
    engine.entryWindow = 0;
    const buys = await runWindowPart(engine, FIRST_WINDOW + WINDOW * 2, 'all3', 35);
    console.log('\n--- ALL 3 FIRE ---');
    buys.forEach(b => console.log('   ', b.reason));
    console.log('  buys:', buys.length);
    if (buys.length !== 3) failures.push('ALL3: expected 3 buys, got ' + buys.length);
  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length === 0) console.log('All checks passed');
  else failures.forEach(f => console.log('  FAIL: ' + f));
  process.exit(failures.length > 0 ? 1 : 0);
})();
