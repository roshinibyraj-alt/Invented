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

async function drive(e, cycles) {
  for (let i = 0; i < cycles; i++) {
    await e.pollClob();
    e.evaluate();
  }
}

const failures = [];
(async () => {
  // TEST 1: Prev UP won → FADE DOWN ladder fills
  {
    console.log('\n--- TEST 1: Prev UP won → FADE DOWN ---');
    const e = await setup([[0.50,0.50],[0.70,0.30],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 4);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('  filled:', filled.length, 'side:', e._windowSide);
    filled.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, o.shares + 'sh @', o.fillPrice));
    // Prev winner = UP → fade DOWN. DOWN price dips to 0.30 → bid 0.29 → fills 0.49,0.45,0.40,0.35 (bid 0.29 <= 0.35), 0.30 not (0.29>0.30)
    if (filled.length !== 5) failures.push('TEST1: expected 5, got ' + filled.length);
  }

  // TEST 2: Prev DOWN won → FADE UP ladder fills
  {
    console.log('\n--- TEST 2: Prev DOWN won → FADE UP ---');
    const e = await setup([[0.70,0.30],[0.30,0.70],[0.50,0.50]], 0.01, 0.99);
    await drive(e, 4);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('  filled:', filled.length, 'side:', e._windowSide);
    filled.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, o.shares + 'sh @', o.fillPrice));
    if (filled.length !== 5) failures.push('TEST2: expected 5, got ' + filled.length);
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

  // TEST 4: All 8 rungs fill — fade side deep dips
  {
    console.log('\n--- TEST 4: All 8 rungs fill ---');
    const e = await setup([[0.50,0.50],[0.60,0.10],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 6);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('  filled:', filled.length, 'side:', e._windowSide, 'bank:', e.bankroll.toFixed(2));
    filled.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, o.shares + 'sh @', o.fillPrice));
    if (filled.length !== 8) failures.push('TEST4: expected 8, got ' + filled.length);
  }

  // TEST 5: Partial fill — fade side moderate dip
  {
    console.log('\n--- TEST 5: Partial fill ---');
    const e = await setup([[0.50,0.50],[0.60,0.32],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 6);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED');
    const pending = e.pendingOrders.filter(o => o.status === 'PENDING');
    console.log('  filled:', filled.length, 'pending:', pending.length, 'side:', e._windowSide);
    filled.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, o.shares + 'sh @', o.fillPrice));
    pending.forEach(o => console.log('  ⏳', o.outcome, o.limitPrice, o.shares + 'sh'));
    if (filled.length !== 4) failures.push('TEST5: expected 4 fills, got ' + filled.length);
    if (pending.length !== 4) failures.push('TEST5: expected 4 pending, got ' + pending.length);
  }

  // TEST 6: Frozen 0.50 → 0.49 rung fills
  {
    console.log('\n--- TEST 6: Frozen 0.50 ---');
    const e = await setup([[0.50,0.50],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 4);
    const filled = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('  filled:', filled.length);
    filled.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, o.shares + 'sh @', o.fillPrice));
    if (filled.length !== 1) failures.push('TEST6: expected 1, got ' + filled.length);
  }

  // TEST 7: Resolution UP wins (DOWN faded side loses)
  {
    console.log('\n--- TEST 7: Resolution UP wins → faded DOWN loses ---');
    const e = await setup([[0.50,0.50],[0.60,0.30],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 4);
    const market = e.markets.get(slugFor(FIRST));
    market.settled = true;
    market.finalUpMax = 0.98;
    market.finalDownMax = 0.30;
    e._resolveExpiredPositions(market, market.windowEnd + 1);
    const results = e.results.filter(r => r.slug === slugFor(FIRST));
    console.log('  results:', results.length, 'wins:', e.wins, 'losses:', e.losses);
    const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
    console.log('  window P&L:', totalPnl >= 0 ? '+' : '', totalPnl.toFixed(2));
    if (results.length === 0) failures.push('TEST7: expected results, got 0');
    if (e.losses !== results.length) failures.push('TEST7: expected all losses (faded DOWN lost)');
  }

  // TEST 8: Resolution DOWN wins → faded DOWN wins (profit)
  {
    console.log('\n--- TEST 8: Resolution DOWN wins → faded DOWN profits ---');
    const e = await setup([[0.50,0.50],[0.60,0.30],[0.50,0.50]], 0.99, 0.01);
    await drive(e, 4);
    const market = e.markets.get(slugFor(FIRST));
    market.settled = true;
    market.finalUpMax = 0.30;
    market.finalDownMax = 0.98;
    e._resolveExpiredPositions(market, market.windowEnd + 1);
    const results = e.results.filter(r => r.slug === slugFor(FIRST));
    const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
    console.log('  results:', results.length, 'wins:', e.wins, 'losses:', e.losses);
    console.log('  window P&L:', totalPnl >= 0 ? '+' : '', totalPnl.toFixed(2));
    if (results.length === 0) failures.push('TEST8: expected results, got 0');
    if (totalPnl <= 0) failures.push('TEST8: expected profit, got ' + totalPnl);
  }

  console.log('\n=== RESULT ===');
  if (!failures.length) console.log('All passed ✅');
  else failures.forEach(f => console.log('FAIL:', f));
  process.exit(failures.length ? 1 : 0);
})();
