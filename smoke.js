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
    const [u, d] = script[pollN++] || [0.50, 0.50];
    const books = [];
    for (const w of Object.keys(tokenMap)) {
      books.push({ asset_id: tokenMap[w].up, asks: [{ price: u, size: 500 }], bids: [{ price: Math.max(0.01, u - 0.01), size: 500 }] });
      books.push({ asset_id: tokenMap[w].dn, asks: [{ price: d, size: 500 }], bids: [{ price: Math.max(0.01, d - 0.01), size: 500 }] });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(books) });
  };
}

function slugFor(s) { return 'btc-updown-5m-' + s; }

const PREV = FIRST - WINDOW;

async function setup(script, upMax, downMax) {
  const e = new CheapHunterEngine({ fetchImpl: makeFetch(script), bankroll: 2000, onTick: () => {}, onLog: () => {} });
  e.entryWindow = 0;
  await e.discoverWindow(PREV);
  await e.discoverWindow(FIRST);
  await e.discoverWindow(FIRST + WINDOW);
  const mPrev = e.markets.get(slugFor(PREV));
  mPrev.settled = true;
  mPrev.finalUpMax = upMax;
  mPrev.finalDownMax = downMax;
  return e;
}

// Run poll+evaluate cycles. Since tests run within a 5-min window,
// elapsed is always > 2, so the ladder is placed on the first evaluate.
async function drive(e, cycles) {
  for (let i = 0; i < cycles; i++) {
    await e.pollClob();
    e.evaluate();
  }
}

const failures = [];
(async () => {
  // TEST 1: Prev UP won → UP ladder fills on dip (0.30)
  {
    console.log('\n--- TEST 1: Prev UP won → UP ladder fills ---');
    const e = await setup([[0.50,0.50],[0.30,0.70],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 4);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('  filled:', filled.length, 'side:', e._windowSide, 'pending:', e.pendingOrders.filter(o=>o.status==='PENDING').length);
    filled.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, '@', o.fillPrice));
    if (filled.length !== 3) failures.push('TEST1: expected 3, got ' + filled.length);
  }

  // TEST 2: Prev DOWN won → DOWN ladder fills
  {
    console.log('\n--- TEST 2: Prev DOWN won → DOWN ladder fills ---');
    const e = await setup([[0.70,0.30],[0.50,0.50]], 0.01, 0.99);
    await drive(e, 4);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('  filled:', filled.length, 'side:', e._windowSide);
    filled.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, '@', o.fillPrice));
    if (filled.length !== 3) failures.push('TEST2: expected 3, got ' + filled.length);
  }

  // TEST 3: No prev winner → skip
  {
    console.log('\n--- TEST 3: No prev winner → skip ---');
    const e = await setup([[0.50,0.50]], 0.60, 0.60);
    await drive(e, 2);
    console.log('  pending:', e.pendingOrders.length, 'windowSide:', e._windowSide);
    if (e.pendingOrders.length !== 0) failures.push('TEST3: should have 0 pending');
    if (e._windowSide !== null) failures.push('TEST3: windowSide should be null');
  }

  // TEST 4: All 6 rungs fill — warm-up avoids token swap, then deep dip
  {
    console.log('\n--- TEST 4: All 6 rungs fill ---');
    const e = await setup([[0.60,0.40],[0.10,0.90],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 6);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('  filled:', filled.length, 'bank:', e.bankroll.toFixed(2));
    filled.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, '@', o.fillPrice));
    if (filled.length !== 6) failures.push('TEST4: expected 6, got ' + filled.length);
  }

  // TEST 5: Partial fill (4 of 6)
  {
    console.log('\n--- TEST 5: Partial fill ---');
    const e = await setup([[0.60,0.40],[0.22,0.78],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 6);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED');
    const pending = e.pendingOrders.filter(o => o.status === 'PENDING');
    console.log('  filled:', filled.length, 'pending:', pending.length);
    filled.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, '@', o.fillPrice));
    pending.forEach(o => console.log('  ⏳', o.outcome, o.limitPrice));
    if (filled.length !== 4) failures.push('TEST5: expected 4 fills, got ' + filled.length);
    if (pending.length !== 2) failures.push('TEST5: expected 2 pending, got ' + pending.length);
  }

  // TEST 6: Frozen 0.50 → no fills
  {
    console.log('\n--- TEST 6: Frozen 0.50 ---');
    const e = await setup([[0.50,0.50],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 4);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED').length;
    console.log('  filled:', filled);
    if (filled !== 0) failures.push('TEST6: expected 0, got ' + filled);
  }

  // TEST 7: Resolution — UP wins, positions pay out
  {
    console.log('\n--- TEST 7: Resolution UP wins ---');
    const e = await setup([[0.60,0.40],[0.30,0.70],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 4);
    const openBefore = e.positions.filter(p => p.exitReason == null && p.slug === slugFor(FIRST));
    console.log('  open positions:', openBefore.length);
    openBefore.forEach(p => console.log('    ', p.outcome, p.shares + 'sh @', p.entryPrice, 'cost:', p.cost.toFixed(2)));
    // Force resolution
    const market = e.markets.get(slugFor(FIRST));
    market.settled = true;
    market.finalUpMax = 0.98;
    market.finalDownMax = 0.30;
    e._resolveExpiredPositions(market, market.windowEnd + 1);
    const results = e.results.filter(r => r.slug === slugFor(FIRST));
    console.log('  results:', results.length, 'wins:', e.wins, 'losses:', e.losses);
    results.forEach(r => console.log('  ', r.won ? '🏆' : '❌', r.outcome, r.shares + 'sh', 'pnl:' + (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)));
    const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
    console.log('  window P&L:', totalPnl >= 0 ? '+' : '', totalPnl.toFixed(2));
    if (results.length === 0) failures.push('TEST7: expected results, got 0');
  }

  // TEST 8: Resolution — neither reaches 0.95 → refund
  {
    console.log('\n--- TEST 8: Resolution no winner → refund ---');
    const e = await setup([[0.60,0.40],[0.30,0.70],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 4);
    const openBefore = e.positions.filter(p => p.exitReason == null && p.slug === slugFor(FIRST));
    console.log('  open positions:', openBefore.length);
    const market = e.markets.get(slugFor(FIRST));
    market.settled = true;
    market.finalUpMax = 0.60;
    market.finalDownMax = 0.70;
    const bankBefore = e.bankroll;
    e._resolveExpiredPositions(market, market.windowEnd + 1);
    const bankAfter = e.bankroll;
    console.log('  bank before:', bankBefore.toFixed(2), 'after:', bankAfter.toFixed(2));
    console.log('  refund?', bankAfter >= bankBefore ? 'YES' : 'NO');
    if (bankAfter < bankBefore) failures.push('TEST8: bank should not decrease on refund');
  }

  console.log('\n=== RESULT ===');
  if (!failures.length) console.log('All passed ✅');
  else failures.forEach(f => console.log('FAIL:', f));
  process.exit(failures.length ? 1 : 0);
})();
