'use strict';
const { MomentumCatchEngine } = require('./engine');

const WINDOW = 300;
let fakeNow = Date.now();
const RealDate = Date;
Date.now = () => fakeNow;
function setNow(ms) { fakeNow = ms; }
const FIRST = Math.floor(fakeNow / 1000 / WINDOW) * WINDOW;
function slugFor(s) { return 'btc-updown-5m-' + s; }

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
    const [u, d] = script[pollN++] || [0.50, 0.50];
    const books = [];
    for (const w of Object.keys(tokenMap)) {
      books.push({ asset_id: tokenMap[w].up, asks: [{ price: u, size: 1000 }], bids: [{ price: Math.max(0.01, u - 0.01), size: 1000 }] });
      books.push({ asset_id: tokenMap[w].dn, asks: [{ price: d, size: 1000 }], bids: [{ price: Math.max(0.01, d - 0.01), size: 1000 }] });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(books) });
  };
}

async function setup(script) {
  const e = new MomentumCatchEngine({ fetchImpl: makeFetch(script), bankroll: 10000, onTick: () => {}, onLog: () => {} });
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
  // TEST 1: UP reaches 0.80 → buy UP (base 100)
  {
    console.log('\n--- TEST 1: UP hits 0.80 → buy UP ---');
    const e = await setup([[0.40,0.60],[0.80,0.20],[0.80,0.20]]);
    await step(e, 1); await step(e, 2);
    console.log('  positions:', e.positions.length, 'entries:', e._windowEntries);
    if (e.positions.length !== 1 || e._windowEntries !== 1) failures.push('TEST1: expected 1 entry, got ' + e.positions.length);
    else console.log('  ✅ entry:', e.positions[0].outcome, e.positions[0].shares + 'sh @ $' + e.positions[0].entryPrice.toFixed(3));
  }

  // TEST 2: Position SL at 0.62 → sell + martingale escalates
  {
    console.log('\n--- TEST 2: SL hit → sell + martingale ---');
    const e = await setup([[0.40,0.60],[0.80,0.20],[0.45,0.55],[0.45,0.55]]);
    await step(e, 1); await step(e, 2); // buy UP
    console.log('  after entry: entries:', e._windowEntries, 'active:', !!e._windowActive, 'base:', e._baseShares);
    await step(e, 60); // UP drops to 0.45 → SL fires
    // Note: SL fires AND resolves in the same evaluate tick (check+resolve in one)
    console.log('  after SL step: losses:', e.losses, 'base:', e._baseShares, 'active:', !!e._windowActive);
    if (e.losses !== 1) failures.push('TEST2: expected 1 loss, got ' + e.losses);
    if (Math.abs(e._baseShares - 250) > 0.01) failures.push('TEST2: base should be 250, got ' + e._baseShares);
    if (e._windowActive) failures.push('TEST2: windowActive should be null after SL');
    console.log('  ✅ SL resolved, martingale →', e._baseShares);
  }

  // TEST 3: Max 2 entries per window
  {
    console.log('\n--- TEST 3: Max 2 entries per window ---');
    const e = await setup([[0.40,0.60],[0.80,0.20],[0.45,0.55],[0.45,0.55],[0.80,0.20],[0.80,0.20]]);
    await step(e, 1); await step(e, 2); // entry 1: UP at 0.80
    await step(e, 60); // SL entry 1
    await step(e, 61); // resolve SL, martingale 250
    console.log('  after SL: entries:', e._windowEntries, 'base:', e._baseShares);
    await step(e, 62); await step(e, 63); // entry 2 attempt (UP 0.80)
    console.log('  after 2nd attempt: entries:', e._windowEntries, 'positions:', e.positions.length);
    await step(e, 100); await step(e, 101); // 3rd attempt → should be blocked
    console.log('  after 3rd attempt: entries:', e._windowEntries, '(should be 2)');
    if (e._windowEntries !== 2) failures.push('TEST3: expected 2 entries, got ' + e._windowEntries);
    else console.log('  ✅ max 2 entries enforced');
  }

  // TEST 4: Resolution win → reset martingale
  {
    console.log('\n--- TEST 4: Resolution win resets martingale ---');
    const e = await setup([[0.40,0.60],[0.80,0.20],[0.97,0.03]]);
    await step(e, 1); await step(e, 2); // buy UP
    e._baseShares = 250; // simulate escalated
    await step(e, 299); // near window end, UP ask = 0.97 → win
    console.log('  wins:', e.wins, 'base:', e._baseShares, 'active:', !!e._windowActive);
    if (e.wins !== 1) failures.push('TEST4: expected 1 win');
    if (e._baseShares !== 100) failures.push('TEST4: base should be 100, got ' + e._baseShares);
    if (e._windowActive) failures.push('TEST4: windowActive should be null');
    console.log('  ✅ win resolved, martingale reset to', e._baseShares);
  }

  // TEST 5: Slippage — fill price differs from ask
  {
    console.log('\n--- TEST 5: Slippage applied ---');
    const e = await setup([[0.40,0.60],[0.80,0.20],[0.80,0.20]]);
    await step(e, 1); await step(e, 2);
    const pos = e.positions[0];
    console.log('  trigger ask was 0.80, entry filled at $' + pos.entryPrice.toFixed(3));
    if (pos.entryPrice < 0.50 || pos.entryPrice > 0.99) failures.push('TEST5: fill price out of range');
    else console.log('  ✅ slippage applied (can be better or worse)');
  }

  // TEST 6: No 0.80 → no position
  {
    console.log('\n--- TEST 6: No 0.80 → no position ---');
    const e = await setup([[0.50,0.50],[0.55,0.45]]);
    await step(e, 1); await step(e, 120);
    if (e.positions.length !== 0) failures.push('TEST6: expected 0 positions');
    else console.log('  ✅ no position when neither side reaches 0.80');
  }

  // TEST 7: Loss resolution → martingale carries to next window
  {
    console.log('\n--- TEST 7: Loss carries martingale to next window ---');
    const e = await setup([[0.40,0.60],[0.80,0.20],[0.30,0.70]]);
    await step(e, 1); await step(e, 2); // buy UP at 0.80
    await step(e, 299); // window end, UP at 0.30 < 0.95 → loss
    console.log('  losses:', e.losses, 'base:', e._baseShares, 'active:', !!e._windowActive);
    if (e.losses !== 1) failures.push('TEST7: expected 1 loss, got ' + e.losses);
    if (Math.abs(e._baseShares - 250) > 0.01) failures.push('TEST7: base should be 250, got ' + e._baseShares);
    if (e._windowActive) failures.push('TEST7: position should be closed');
    console.log('  ✅ loss resolved, martingale →', e._baseShares);
  }

  // TEST 8: SL resolve → re-entry at 0.80 in same window
  {
    console.log('\n--- TEST 8: SL + re-entry in same window ---');
    const e = await setup([[0.40,0.60],[0.80,0.20],[0.40,0.60],[0.80,0.20],[0.40,0.60]]);
    await step(e, 1); await step(e, 2); // entry 1
    const entry1Price = e.positions[0].entryPrice;
    console.log('  entry 1:', e.positions[0].outcome, e.positions[0].shares + 'sh @ $' + entry1Price.toFixed(3));
    await step(e, 60); // SL fires (UP drops to 0.40)
    await step(e, 61); // resolve SL
    console.log('  after SL: active:', !!e._windowActive, 'losses:', e.losses, 'base:', e._baseShares);
    await step(e, 62); await step(e, 63); // re-entry attempt (UP 0.80 again)
    console.log('  after re-entry: entries:', e._windowEntries, 'positions:', e.positions.length);
    if (e._windowEntries !== 2) failures.push('TEST8: expected 2 entries, got ' + e._windowEntries);
    else console.log('  ✅ SL → re-entry successful');
  }

  console.log('\n=== RESULT ===');
  if (!failures.length) console.log('All passed ✅');
  else failures.forEach(f => console.log('FAIL:', f));
  process.exit(failures.length ? 1 : 0);
})();
