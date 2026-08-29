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

function candle(openTime, open, close, high, low, volume) {
  return { openTime, open, high: high ?? Math.max(open, close), low: low ?? Math.min(open, close), close, volume: volume ?? 1000 };
}

(async () => {
  const logs = [];
  const engine = await setup([]);
  engine.onLog = line => logs.push(line);

  // ── Discovery ─────────────────────────────────────────────
  const cs = Math.floor(Date.now() / 1000 / 300) * 300;
  const market = await engine.discoverMarket('btc', cs);
  assert.ok(market, 'btc market should discover');
  assert.equal(engine.positions.length, 0);

  // ── Recovery ladder caps at 2x ────────────────────────────
  assert.equal(engine.nextShares(), 1000, 'base size is 1000 shares');
  assert.equal(engine.recoveryActive, false);

  // First loss → enter recovery at 2x
  engine._onRecoveryLoss(100);
  assert.equal(engine.recoveryActive, true, 'recovery should be active after loss');
  assert.equal(engine.recoveryDebt, 100);
  assert.equal(engine.recoveryMultiplier(), 2, 'first recovery level is 2x');
  assert.equal(engine.nextShares(), 2000, '2x recovery sizes at 2000 shares');

  // Additional loss while in recovery → stays capped at 2x (ladder is [2])
  engine._onRecoveryLoss(80);
  assert.equal(engine.recoveryDebt, 180);
  assert.equal(engine.recoveryMultiplier(), 2, 'ladder caps at 2x, never 3x/4x');
  assert.equal(engine.nextShares(), 2000, 'still 2000 shares at cap');

  // A win that clears the debt exits recovery
  engine._onRecoveryWin(180);
  assert.equal(engine.recoveryActive, false, 'debt cleared → recovery off');
  assert.equal(engine.recoveryDebt, 0);
  assert.equal(engine.nextShares(), 1000, 'back to base 1000 shares');

  // ── Resolution: last-2s CLOB-based, no fallback ────────────
  // Re-enter recovery with a small debt to test the winning resolution path.
  engine._onRecoveryLoss(50);
  assert.equal(engine.recoveryActive, true);

  const start = Math.floor((Date.now() - 600000) / 1000 / 300) * 300;
  const end = start + 300;
  await engine.discoverMarket('btc', start);
  engine.activeWindowStart = start;

  const upMarket = engine.markets.get(`btc-updown-5m-${start}`);
  // Build an open UP position bought this window.
  upMarket.up.ask = 0.04; upMarket.up.bid = 0.03; upMarket.up.mid = 0.035;
  engine.executeBuy(upMarket, 'UP', 0.035, 2000, start, end);

  // Final 2 seconds: UP touched 0.92 in the last 2s → UP must win (no Binance fallback).
  upMarket.finalUpMax = 0.92;
  upMarket.finalDownMax = 0.08;

  engine.resolveByBinance();
  const resolved = engine.resolvedPositions.find(p => p.windowStart === start);
  assert.ok(resolved, 'position should have resolved');
  assert.equal(resolved.won, true, 'UP won: final UP price 0.92 >= 0.90 in last 2s');
  assert.equal(resolved.resolvedWinner, 'UP');
  assert.equal(resolved.pnl, Math.round((2000 - resolved.cost - resolved.fee) * 100) / 100, 'winning UP position pays shares minus cost');
  assert.equal(engine.recoveryActive, false, 'this win clears the 50 debt all the way to base');
  assert.equal(engine.nextShares(), 1000, 'resolved back to base 1000 shares');
  assert.equal(engine.positions.filter(p => p.windowStart === start && p.status === 'open').length, 0, 'position removed from open list');

  // A DOWN position where DOWN touched 0.90+ in the last 2s must resolve as DOWN.
  const start2 = start - 300;
  await engine.discoverMarket('btc', start2);
  const downMarket = engine.markets.get(`btc-updown-5m-${start2}`);
  downMarket.down.ask = 0.96; downMarket.down.bid = 0.95; downMarket.down.mid = 0.955;
  engine.executeBuy(downMarket, 'DOWN', 0.955, 1000, start2, start2 + 300);
  downMarket.finalUpMax = 0.05;
  downMarket.finalDownMax = 0.95;
  engine.resolveByBinance();
  const resolvedDown = engine.resolvedPositions.find(p => p.windowStart === start2);
  assert.ok(resolvedDown, 'down position should have resolved');
  assert.equal(resolvedDown.resolvedWinner, 'DOWN', 'DOWN won: final DOWN price 0.95 >= 0.90');
  assert.equal(resolvedDown.won, true);

  console.log('✅ ConfidenceBot smoke: recovery cap 2x + last-2s CLOB resolution OK');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
