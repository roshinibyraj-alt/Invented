'use strict';
const { CheapHunterEngine } = require('./engine');

const WINDOW = 300;
const FIRST = Math.floor(Date.now() / 1000 / WINDOW) * WINDOW;

function makeFetch(script) {
  const tokens = {};
  let n = 0;
  return function fakeFetch(url) {
    if (url.includes('gamma-api')) {
      const m = url.match(/slug=(btc-updown-5m-\d+)/);
      const s = m ? m[1] : 'test';
      const w = parseInt(s.split('-').pop()) || 0;
      if (!tokens[w]) tokens[w] = { up: 'up_' + w, dn: 'dn_' + w };
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{ conditionId: '0x' + w, question: 'BTC ' + w, outcomes: JSON.stringify(['Up', 'Down']), clobTokenIds: JSON.stringify([tokens[w].up, tokens[w].dn]), closed: false }]) });
    }
    const [u, d] = script[n++] || [0.50, 0.50];
    const books = [];
    for (const w of Object.keys(tokens)) {
      books.push({ asset_id: tokens[w].up, asks: [{ price: u, size: 500 }], bids: [{ price: Math.max(0.01, u - 0.01), size: 500 }] });
      books.push({ asset_id: tokens[w].dn, asks: [{ price: d, size: 500 }], bids: [{ price: Math.max(0.01, d - 0.01), size: 500 }] });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(books) });
  };
}

function mk(script, color) {
  const e = new CheapHunterEngine({ fetchImpl: makeFetch(script), bankroll: 2000, onTick: () => {}, onLog: () => {} });
  e._entryWindow = 0;
  e.candle.color = color;
  return e;
}

const fails = [];

(async () => {
  // 1) GREEN candle → BUY UP, dip to 0.30 → 3 fills (bid=0.29 ≤ 0.40/0.35/0.30)
  {
    const e = mk([[0.50, 0.50], [0.30, 0.70], [0.50, 0.50]], 'GREEN');
    await e._discover(FIRST); await e._discover(FIRST + WINDOW);
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    const f = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- GREEN → UP dip 0.30: fills', f.length, '---');
    f.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, 'fill', o.fillPrice));
    if (f.length !== 3) fails.push('GREEN-UP: expected 3, got ' + f.length);
  }

  // 2) RED candle → BUY DOWN, dip to 0.30 → 3 fills
  {
    const e = mk([[0.50, 0.50], [0.70, 0.30], [0.50, 0.50]], 'RED');
    await e._discover(FIRST); await e._discover(FIRST + WINDOW);
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    const f = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- RED → DOWN dip 0.30: fills', f.length, '---');
    f.forEach(o => console.log('  ✅', o.outcome, o.limitPrice, 'fill', o.fillPrice));
    if (f.length !== 3) fails.push('RED-DOWN: expected 3, got ' + f.length);
  }

  // 3) FROZEN — 0.50 both sides, no fills
  {
    const e = mk([[0.50, 0.50], [0.50, 0.50], [0.50, 0.50]], 'GREEN');
    await e._discover(FIRST); await e._discover(FIRST + WINDOW);
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    console.log('\n--- FROZEN 0.50: fills', e.pendingOrders.filter(o => o.status === 'FILLED').length, '---');
    if (e.pendingOrders.filter(o => o.status === 'FILLED').length !== 0) fails.push('FROZEN: should be 0 fills');
  }

  // 4) NO SIGNAL
  {
    const e = mk([[0.50, 0.50]], null);
    await e._discover(FIRST); await e._discover(FIRST + WINDOW);
    await e._pollClob(); e._evaluate();
    console.log('\n--- NO SIGNAL: pending', e.pendingOrders.length, '---');
    if (e.pendingOrders.length !== 0) fails.push('NO SIGNAL: should be 0 orders');
  }

  // 5) ALL 6 FILLS — deep dip to 0.10
  {
    const e = mk([[0.50, 0.50], [0.10, 0.90], [0.50, 0.50]], 'GREEN');
    await e._discover(FIRST); await e._discover(FIRST + WINDOW);
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    const f = e.pendingOrders.filter(o => o.status === 'FILLED');
    console.log('\n--- ALL 6 FILLS dip 0.10: fills', f.length, '---');
    f.forEach(o => console.log('  ✅', o.outcome, o.limitPrice));
    if (f.length !== 6) fails.push('ALL FILLS: expected 6, got ' + f.length);
  }

  // 6) PARTIAL — dip to 0.22 → 4 fills (bid=0.21 ≤ 0.40/0.35/0.30/0.25)
  {
    const e = mk([[0.50, 0.50], [0.22, 0.78], [0.50, 0.50]], 'GREEN');
    await e._discover(FIRST); await e._discover(FIRST + WINDOW);
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    await e._pollClob(); e._evaluate();
    const f = e.pendingOrders.filter(o => o.status === 'FILLED');
    const p = e.pendingOrders.filter(o => o.status === 'PENDING');
    console.log('\n--- PARTIAL dip 0.22: fills', f.length, 'pending', p.length, '---');
    if (f.length !== 4) fails.push('PARTIAL: expected 4 fills, got ' + f.length);
    if (p.length !== 2) fails.push('PARTIAL: expected 2 pending, got ' + p.length);
  }

  console.log('\n=== RESULT ===');
  if (!fails.length) console.log('All passed ✅');
  else fails.forEach(f => console.log('FAIL:', f));
  process.exit(fails.length ? 1 : 0);
})();
