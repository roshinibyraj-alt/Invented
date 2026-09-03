'use strict';
const { MomentumCatchEngine } = require('./engine');

const WINDOW = 300;
let fakeNow = Date.now();
Date.now = () => fakeNow;
function setNow(ms) { fakeNow = ms; }
const FIRST = Math.floor(fakeNow / 1000 / WINDOW) * WINDOW;

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
    const mid = script[pollN++] || [0.50, 0.50];
    const books = [];
    for (const w of Object.keys(tokenMap)) {
      books.push({ asset_id: tokenMap[w].up, asks: [{ price: mid[0] + 0.01, size: 1000 }], bids: [{ price: Math.max(0.01, mid[0] - 0.01), size: 1000 }] });
      books.push({ asset_id: tokenMap[w].dn, asks: [{ price: mid[1] + 0.01, size: 1000 }], bids: [{ price: Math.max(0.01, mid[1] - 0.01), size: 1000 }] });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(books) });
  };
}

async function setup(script, bankroll) {
  const e = new MomentumCatchEngine({ fetchImpl: makeFetch(script), bankroll: bankroll || 10000, onTick: () => {}, onLog: () => {} });
  e.entryWindow = 0;
  await e.discoverWindow(FIRST);
  await e.discoverWindow(FIRST + WINDOW);
  return e;
}

async function step(e, secs) {
  setNow(secs * 1000 + FIRST * 1000);
  await e.pollClob();
  e.evaluate();
}

const failures = [];
(async () => {
  // TEST 1: UP mid=0.70 → limit buy at 0.70
  {
    console.log('\n--- TEST 1: UP mid=0.70 → limit buy ---');
    const e = await setup([[0.50,0.50],[0.70,0.30],[0.70,0.30]]);
    await step(e, 46); await step(e, 47);
    if (e.positions.length !== 1) failures.push('TEST1: expected 1 entry');
    else if (e.positions[0].entryPrice !== 0.70) failures.push('TEST1: fill should be 0.70, got ' + e.positions[0].entryPrice);
    else console.log('  ✅ limit fill at 0.70');
  }

  // TEST 2: UP mid=0.69 triggers
  {
    console.log('\n--- TEST 2: UP mid=0.69 triggers ---');
    const e = await setup([[0.50,0.50],[0.69,0.31],[0.69,0.31]]);
    await step(e, 46); await step(e, 47);
    if (e.positions.length !== 1) failures.push('TEST2: 0.69 should trigger');
    else console.log('  ✅ 0.69 triggers');
  }

  // TEST 3: UP mid=0.68 no trigger
  {
    console.log('\n--- TEST 3: UP mid=0.68 no trigger ---');
    const e = await setup([[0.50,0.50],[0.68,0.32],[0.68,0.32]]);
    await step(e, 46); await step(e, 120);
    if (e.positions.length !== 0) failures.push('TEST3: 0.68 should not trigger');
    else console.log('  ✅ 0.68 no trigger');
  }

  // TEST 4: Win → $1/share, reset martingale
  {
    console.log('\n--- TEST 4: Resolution win ---');
    const e = await setup([[0.50,0.50],[0.70,0.30],[0.97,0.03]]);
    e._baseShares = 300;
    await step(e, 46); await step(e, 47); await step(e, 299);
    if (e.wins !== 1) failures.push('TEST4: expected win');
    else if (e._baseShares !== 100) failures.push('TEST4: base should reset to 100');
    else console.log('  ✅ win resets martingale to 100');
  }

  // TEST 5: Loss → 2.5x martingale
  {
    console.log('\n--- TEST 5: Resolution loss → 2.5x ---');
    const e = await setup([[0.50,0.50],[0.70,0.30],[0.55,0.45]]);
    await step(e, 46); await step(e, 47); await step(e, 299);
    if (e.losses !== 1) failures.push('TEST5: expected loss');
    else if (Math.abs(e._baseShares - 300) > 0.01) failures.push('TEST5: base should be 300');
    else console.log('  ✅ loss escalates to 300');
  }

  // TEST 6: Entry before 45s blocked
  {
    console.log('\n--- TEST 6: Entry before 45s blocked ---');
    const e = await setup([[0.70,0.30],[0.70,0.30]]);
    await step(e, 2); await step(e, 10);
    if (e._windowEntries !== 0) failures.push('TEST6: should block before 45s');
    else console.log('  ✅ blocked before wait');
  }

  // TEST 7: No SL — holds to resolution
  {
    console.log('\n--- TEST 7: No SL, holds to resolution ---');
    const e = await setup([[0.50,0.50],[0.70,0.30],[0.40,0.60],[0.55,0.45]]);
    await step(e, 46); await step(e, 47);
    await step(e, 80); await step(e, 120);
    await step(e, 299);
    if (e._windowActive !== null) failures.push('TEST7: should be resolved');
    else console.log('  ✅ held to resolution');
  }

  // TEST 8: Bankroll guard resets bloated base
  {
    console.log('\n--- TEST 8: Bankroll guard ---');
    const e = await setup([[0.50,0.50],[0.70,0.30]], 5000);
    e._baseShares = 9765;
    await step(e, 46);
    if (e._baseShares !== 100) failures.push('TEST8: should reset to 100');
    else console.log('  ✅ bankroll guard reset');
  }

  console.log('\n=== RESULT ===');
  if (!failures.length) console.log('All passed ✅');
  else failures.forEach(f => console.log('FAIL:', f));
  process.exit(failures.length ? 1 : 0);
})();
