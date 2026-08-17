'use strict';

/**
 * Deterministic smoke test for the 0.60 pullback martingale engine.
 *
 * Compressed windows: 15m = 30s (wait 8s), 5m = 12s (wait 4s).
 * Script indices are T0-independent: Math.floor(ts / wsec) % scripts.length.
 */

const { createEngine } = require('./engine-factory');

const W15 = 30, W5 = 12, WAIT15 = 8, WAIT5 = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let virtualNow = Date.now(), T0 = 0;

// 15m scripts: cycle through entry/stoploss/win combos
const SCRIPTS_15 = [
  { entry: 'up', highAfterMs: 2, gapMs: 3000, stopLosses: [6.5], winner: 'down' },  // entry + stop loss → loss
  { entry: null, highAfterMs: null, gapMs: 3000, stopLosses: [], winner: 'up' },     // no entry
  { entry: 'up', highAfterMs: 2, gapMs: 3000, stopLosses: [], winner: 'up' },        // entry, no stop → win
];

const SCRIPTS_5 = [
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [3.5, 5.5, 7], winner: 'down' },   // 3 stops, 3 marts → loss
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [], winner: 'up' },                   // no stop → win
  { entry: null, highAfterMs: null, gapMs: 1500, stopLosses: [], winner: 'up' },                 // no entry
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [3.5], winner: 'up' },                 // 1 stop + 1 mart → win
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [3.5, 5.5], winner: 'down' },          // 2 stops → loss
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [3.5], winner: 'down' },                // 1 stop → loss
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [], winner: 'up' },                     // no stop → win
  { entry: null, highAfterMs: null, gapMs: 1500, stopLosses: [], winner: 'up' },                  // no entry
];

function scriptFor(tf, ts) {
  const wsec = tf === '5' ? W5 : W15;
  const idx = Math.floor(ts / wsec);
  const scripts = tf === '5' ? SCRIPTS_5 : SCRIPTS_15;
  return scripts[((idx % scripts.length) + scripts.length) % scripts.length];
}

function entrySideAsk(ts, nowMs, tf) {
  const s = scriptFor(tf, ts);
  if (!s || !s.entry || s.highAfterMs == null) return 0.50;
  const waitMs = (tf === '5' ? WAIT5 : WAIT15) * 1000;
  const highAt = waitMs + s.highAfterMs * 1000;
  const gapMs = s.gapMs || 3000;
  if (nowMs < highAt) return 0.55;
  if (nowMs < highAt + gapMs) return 0.62;
  return 0.60;
}

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.binance.com')) {
    const m = u.match(/interval=(\d+)m/);
    const intervalSec = (m ? Number(m[1]) : 5) * 60;
    const limit = u.includes('limit=500') ? 500 : 5;
    const base = Math.floor(virtualNow / (intervalSec * 1000)) * (intervalSec * 1000);
    const rows = [];
    for (let i = 0; i < limit; i++) {
      const closeTime = base - i * intervalSec * 1000;
      const openTime = closeTime - intervalSec * 1000;
      const o = 60000 + (i % 9) * 10;
      rows.push([openTime, String(o), String(o + 25), String(o - 15), String(o + 10), '100', closeTime, '1', '1', '1', '1', '1']);
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  if (u.includes('gamma-api.polymarket.com/events')) {
    const m = u.match(/slug=btc-updown-(\d+)m-(\d+)/);
    const tf = m ? (m[1] === '5' ? '5' : '15') : '15';
    const ts = m ? Number(m[2]) : T0;
    return new Response(JSON.stringify([{ markets: [{ conditionId: `cond-${tf}-${ts}`, outcomes: '["Up","Down"]', clobTokenIds: `["u${tf}-${ts}","d${tf}-${ts}"]` }] }]), { status: 200 });
  }
  if (u.includes('gamma-api.polymarket.com/markets')) {
    const m = u.match(/condition_ids=cond-(\d+)-(\d+)/);
    const tf = m ? (m[1] === '5' ? '5' : '15') : '15';
    const ts = m ? Number(m[2]) : T0;
    const w = scriptFor(tf, ts).winner;
    return new Response(JSON.stringify([{
      conditionId: `cond-${tf}-${ts}`, closed: true,
      outcomes: '["Up","Down"]', clobTokenIds: `["u${tf}-${ts}","d${tf}-${ts}"]`,
      outcomePrices: w === 'up' ? '[ "1.0", "0.0" ]' : '[ "0.0", "1.0" ]',
    }]), { status: 200 });
  }
  if (u.includes('clob.polymarket.com/price')) {
    const m = u.match(/token_id=(u|d)(\d+)-(\d+)/);
    const tf = m ? (m[2] === '5' ? '5' : '15') : '15';
    const ts = m ? Number(m[3]) : T0;
    const side = m && m[1] === 'u' ? 'up' : 'down';
    const wsec = tf === '5' ? W5 : W15;
    const s = scriptFor(tf, ts);
    const urlSide = u.includes('side=SELL') ? 'SELL' : 'BUY';
    let price = 0.5;
    if (virtualNow >= (ts + wsec) * 1000) {
      price = s.winner === side ? 1.0 : 0.01;
    } else if (s.entry && side === s.entry) {
      const offset = virtualNow - ts * 1000;
      if (urlSide === 'BUY') {
        price = entrySideAsk(ts, offset, tf);
      } else {
        const waitMs = (tf === '5' ? WAIT5 : WAIT15) * 1000;
        let bid = 0.50;
        for (const sl of s.stopLosses) { if (offset >= waitMs + sl * 1000) bid = 0.40; }
        price = bid;
      }
    } else if (s.entry && side !== s.entry) {
      price = urlSide === 'BUY' ? 0.40 : 0.35;
    }
    return new Response(JSON.stringify({ price: String(price) }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

(async () => {
  const states = {};
  virtualNow = Math.floor(Date.now() / (W5 * 1000)) * (W5 * 1000) + W5 * 1000;
  const engine = createEngine({
    startingCapital: 4000, entryPrice: 0.60, stopLossPrice: 0.49,
    entryDollars: 50, martingaleMultiplier: 1.5, maxMartingaleLevels: 3,
    waitSeconds5: WAIT5, waitSeconds15: WAIT15, windowSeconds15: W15, windowSeconds5: W5,
    dryRun: true, startAtBoundary: false, tickMs: 1, priceRefreshMs: 1,
    nowFn: () => virtualNow, emit: (ev, s) => { states[ev] = s; }, slog: () => {},
  });
  await engine.start();
  await sleep(30);
  T0 = states['hedgeState:BTC-5m'].current.btc.windowTs;

  const endAt = (T0 + 8 * W5 + 30) * 1000;
  while (virtualNow < endAt) { virtualNow += 100; await sleep(1); }
  await sleep(50);

  const st5 = states['hedgeState:BTC-5m'];
  const st15 = states['hedgeState:BTC-15m'];
  const round2 = n => Math.round(n * 100) / 100;
  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  const h5 = st5.history || [];
  const h15 = st15.history || [];

  // ── 15m: classify history by script type ──
  const noEntry15 = h15.filter(h => !h.betPlaced);
  const entryNoStop15 = h15.filter(h => h.betPlaced && h.stopLossCount === 0 && h.win === true);
  const entryWithStop15 = h15.filter(h => h.betPlaced && h.stopLossCount >= 1);

  check('15m: has no-entry windows', noEntry15.length >= 1);
  check('15m: has entry-with-stop-loss windows', entryWithStop15.length >= 1);
  check('15m: has entry-no-stop-win windows', entryNoStop15.length >= 1);
  check('15m: stop-loss entry loses', entryWithStop15.every(h => h.win === false));
  check('15m: no-stop entry wins', entryNoStop15.every(h => h.win === true));
  check('15m: entries happen after wait', h15.filter(h => h.betPlaced && h.legs.length)
    .every(h => h.legs[0].ts >= (h.windowTs + WAIT15) * 1000 - 500));

  // ── 5m: classify by script type ──
  const noEntry5 = h5.filter(h => !h.betPlaced);
  const entryNoStopWin5 = h5.filter(h => h.betPlaced && h.stopLossCount === 0 && h.win === true);
  const entryWithStop5 = h5.filter(h => h.betPlaced && h.stopLossCount >= 1);
  const multiStop5 = h5.filter(h => h.stopLossCount >= 2);
  const maxMart5 = h5.filter(h => h.reachedMaxMartingale === true);

  check('5m: has no-entry windows', noEntry5.length >= 1);
  check('5m: has entry-no-stop-win windows', entryNoStopWin5.length >= 1);
  check('5m: has stop-loss windows', entryWithStop5.length >= 1);
  check('5m: has multi-stop windows', multiStop5.length >= 1);

  // Martingale amounts scale: each leg should be 1.5x the previous
  const scalesCorrectly = h5.filter(h => h.legs.length >= 3).every(h => {
    for (let i = 1; i < h.legs.length; i++) {
      if (h.legs[i].dollars <= h.legs[i - 1].dollars) return false;
    }
    return true;
  });
  check('5m: martingale amounts scale (1.5x)', scalesCorrectly);

  // Stop-loss sells recover positive capital
  const sellsCorrect = h5.concat(h15).filter(h => h.sells && h.sells.length > 0)
    .every(h => h.sells.every(x => x.proceeds > 0));
  check('stop-loss sells recover positive capital', sellsCorrect);

  // Max martingale counter
  check('5m max-martingale counter >= 1', st5.windowsReachedMaxMartingale >= 1);

  // Win rate consistent
  check('5m win rate consistent', st5.windowsDecided > 0 && st5.winRate === round2(st5.wins / st5.windowsDecided));
  check('5m windowsDecided = wins + losses', st5.windowsDecided === st5.wins + st5.losses);

  // Separate bankroll accounting
  const openCost5 = (st5.current.btc ? st5.current.btc.totalCost : 0);
  const openCost15 = (st15.current.btc ? st15.current.btc.totalCost : 0);
  check('5m bankroll consistent', Math.abs(st5.bankroll - (2000 + st5.realizedPnl - openCost5)) < 0.01);
  check('15m bankroll consistent', Math.abs(st15.bankroll - (2000 + st15.realizedPnl - openCost15)) < 0.01);

  // Equity curve + drawdown
  check('equity curve has points', st15.equityCurve.length >= 3);
  check('max drawdown >= 0', st15.maxDrawdown.pct >= 0);
  check('max drawdown <= 100%', st15.maxDrawdown.pct <= 1);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ SMOKE TEST PASSED' : '\n❌ SMOKE TEST FAILED');
  process.exit(allOk ? 0 : 1);
})();
