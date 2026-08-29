'use strict';
const assert = require('node:assert/strict');
const { BotEngine } = require('../engine');

async function setup(candles) {
  const engine = new BotEngine({
    fetchImpl: async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith('/books') && options.method === 'POST') return { ok: true, json: async () => [] };
      if (u.includes('/markets')) {
        return { ok: true, json: async () => [{
          conditionId: '0xbtc', question: 'BTC test', closed: false,
          outcomes: '["Up","Down"]', clobTokenIds: '["up-id","down-id"]',
        }] };
      }
      if (u.includes('klines')) return { ok: true, json: async () => candles };
      if (u.includes('ticker/price')) return { ok: true, json: async () => ({ price: '60000' }) };
      throw new Error('unexpected url ' + u);
    },
  });
  engine.binanceCandles = candles;
  return engine;
}

(async () => {
  const logs = [];
  const engine = await setup([]);
  engine.onLog = line => logs.push(line);

  // ── Recovery ladder caps at 2x ────────────────────────────
  assert.equal(engine.nextShares(), 1000, 'base size is 1000 shares');
  assert.equal(engine.recoveryActive, false);

  engine._onRecoveryLoss(100);
  assert.equal(engine.recoveryActive, true, 'recovery should be active after loss');
  assert.equal(engine.recoveryDebt, 100);
  assert.equal(engine.recoveryMultiplier(), 2, 'first recovery level is 2x');
  assert.equal(engine.nextShares(), 2000, '2x recovery sizes at 2000 shares');

  engine._onRecoveryLoss(80);
  assert.equal(engine.recoveryDebt, 180);
  assert.equal(engine.recoveryMultiplier(), 2, 'ladder caps at 2x, never 3x/4x');
  assert.equal(engine.nextShares(), 2000, 'still 2000 shares at cap');

  engine._onRecoveryWin(180);
  assert.equal(engine.recoveryActive, false, 'debt cleared → recovery off');
  assert.equal(engine.recoveryDebt, 0);
  assert.equal(engine.nextShares(), 1000, 'back to base 1000 shares');

  // ── Resolution: last-2s CLOB, no fallback ─────────────────
  engine._onRecoveryLoss(50);
  assert.equal(engine.recoveryActive, true);

  const start = Math.floor((Date.now() - 600000) / 1000 / 300) * 300;
  const end = start + 300;
  await engine.discoverMarket('btc', start);
  engine.activeWindowStart = start;

  const upMarket = engine.markets.get(`btc-updown-5m-${start}`);
  upMarket.up.ask = 0.04; upMarket.up.bid = 0.03; upMarket.up.mid = 0.035;
  engine.executeBuy(upMarket, 'UP', 0.035, 2000, start, end);

  // Final 2s: UP touched 0.92 → UP wins
  upMarket.finalUpMax = 0.92;
  upMarket.finalDownMax = 0.08;
  engine.resolveByBinance();
  const resolved = engine.resolvedPositions.find(p => p.windowStart === start);
  assert.ok(resolved, 'position should have resolved');
  assert.equal(resolved.won, true, 'UP won: final UP price 0.92 >= 0.90');
  assert.equal(resolved.pnl, Math.round((2000 - resolved.cost - resolved.fee) * 100) / 100, 'winning UP position pays shares minus cost');
  assert.equal(engine.recoveryActive, false, 'this win clears the 50 debt');
  assert.equal(engine.nextShares(), 1000, 'resolved back to base 1000 shares');
  assert.equal(engine.positions.filter(p => p.windowStart === start && p.status === 'open').length, 0);

  // ── Key bug fix test: unchanged book within final 2s ───────
  // Simulate: price reached 0.91 on a book change (captured), then book
  // is unchanged on subsequent polls — finalDownMax must STILL be 0.91.
  const start2 = start - 300;
  await engine.discoverMarket('btc', start2);
  const downMarket = engine.markets.get(`btc-updown-5m-${start2}`);
  // Set DOWN mid to 0.91 — simulates a prior poll already set this.
  downMarket.down.bid = 0.90; downMarket.down.ask = 0.92; downMarket.down.mid = 0.91;
  downMarket.up.bid = 0.08; downMarket.up.ask = 0.10; downMarket.up.mid = 0.09;
  engine.executeBuy(downMarket, 'DOWN', 0.91, 1000, start2, start2 + 300);

  // Apply a book with the SAME prices (unchanged from previous poll).
  // Before the fix, this would early-return without capturing.
  // After the fix, capture MUST run even on unchanged books.
  const downToken = downMarket.down;
  engine.applyBook(downToken, [{ price: '0.90', size: '500' }], [{ price: '0.92', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.91, 'capture fires even on unchanged book within final 2s');
  assert.equal(downMarket.finalCaptureAt > 0, true, 'capture timestamp set');

  // Now call again with same book — still captures (not blocked by early return)
  engine.applyBook(downToken, [{ price: '0.90', size: '500' }], [{ price: '0.92', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.91, 'unchanged book still captured');

  // Simulate a price spike: mid jumps to 0.96
  engine.applyBook(downToken, [{ price: '0.95', size: '500' }], [{ price: '0.97', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.96, 'spike captured on new book change');

  downMarket.finalUpMax = 0.05;
  engine.resolveByBinance();
  const resolved2 = engine.resolvedPositions.find(p => p.windowStart === start2);
  assert.ok(resolved2, 'down position should resolve');
  assert.equal(resolved2.resolvedWinner, 'DOWN', 'DOWN won');
  assert.equal(resolved2.won, true);

  console.log('✅ Invented smoke: recovery + last-2s CLOB + unchanged-book capture fix OK');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
