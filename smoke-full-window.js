'use strict';

/**
 * Full-window smoke test for the 0.60 pullback martingale engine.
 * Real-sized 5m windows (300s, 60s wait) on a virtual clock.
 *
 * Window A (t0):     pullback entry UP, 1 stop loss + 1 martingale re-entry, win
 * Window B (t0+300): no entry (side never reaches 0.60+)
 * Window C (t0+600): pullback entry UP, 2 stop losses + 2 martingale re-entries, loss
 * Window D (t0+900): pullback entry UP, no stop loss, win
 * Window E (t0+1200): pullback entry UP, 1 stop loss + 1 martingale re-entry, loss
 *
 * 15m window: pullback entry UP, 1 stop loss, no re-entry (reached max), loss
 *
 * Stop loss bid pattern: bid drops to 0.40 at stop time, recovers to 0.50 after 5s
 * so the next martingale entry can fire. After max martingale is reached, bid stays low.
 */

const { createEngine } = require('./engine-factory');

const W5 = 300, WAIT5 = 60;
const W15 = 900, WAIT15 = 180;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let virtualNow = 0, T0 = 0;

// Stop loss times are in seconds AFTER the wait ends.
// Each stop loss lasts 5s (bid=0.40), then recovers (bid=0.50).
const SCHEDULE_5 = [
  { offset: 0,    entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [90], winner: 'up' },         // A: 1 stop, win
  { offset: 300,  entry: null, highAfterMs: null, gapMs: 3000, stopLosses: [], winner: 'up' },           // B: no entry
  { offset: 600,  entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [90, 160], winner: 'down' },   // C: 2 stops, loss
  { offset: 900,  entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [], winner: 'up' },            // D: no stop, win
  { offset: 1200, entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [90], winner: 'down' },        // E: 1 stop, loss
];
const SCHEDULE_15 = [
  { entry: 'up', highAfterMs: 200, gapMs: 3000, stopLosses: [300], winner: 'down' },
];

const STOP_RECOVERY_S = 5; // bid recovers 5s after stop loss

function schedLookup(list, ts) {
  for (const s of list) if (s.offset !== undefined && ts === T0 + s.offset) return s;
  // For lists without offsets (like 15m), return first entry for any ts
  if (list.length === 1 && list[0].offset === undefined) return list[0];
  return { entry: null, highAfterMs: null, gapMs: 3000, stopLosses: [], winner: 'up' };
}

function askForSide5(ts, offsetMs) {
  const s = schedLookup(SCHEDULE_5, ts);
  if (!s.entry || s.highAfterMs == null) return 0.50;
  const highAt = WAIT5 * 1000 + s.highAfterMs * 1000;
  if (offsetMs < highAt) return 0.55;
  if (offsetMs < highAt + (s.gapMs || 3000)) return 0.62;
  return 0.60;
}

function bidForSide5(ts, offsetMs) {
  const s = schedLookup(SCHEDULE_5, ts);
  if (!s.entry) return 0.50;
  const waitMs = WAIT5 * 1000;
  for (const sl of s.stopLosses) {
    const slStart = waitMs + sl * 1000;
    // Bid is 0.40 only at the exact stop loss moment (1 tick), then recovers.
    // This models: position is sold at 0.40, then bid recovers for next entry.
    if (offsetMs >= slStart && offsetMs < slStart + 500) return 0.40;
  }
  return 0.50;
}

function askForSide15(ts, offsetMs) {
  const s = schedLookup(SCHEDULE_15, ts);
  if (!s.entry || s.highAfterMs == null) return 0.50;
  const highAt = WAIT15 * 1000 + s.highAfterMs * 1000;
  if (offsetMs < highAt) return 0.55;
  if (offsetMs < highAt + (s.gapMs || 3000)) return 0.62;
  return 0.60;
}

function bidForSide15(ts, offsetMs) {
  const s = schedLookup(SCHEDULE_15, ts);
  if (!s.entry) return 0.50;
  const waitMs = WAIT15 * 1000;
  for (const sl of s.stopLosses) {
    const slStart = waitMs + sl * 1000;
    if (offsetMs >= slStart && offsetMs < slStart + 500) return 0.40;
  }
  return 0.50;
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
      rows.push([openTime, '60000', '60025', '59985', '60010', '100', closeTime, '1', '1', '1', '1', '1']);
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
    const w = tf === '5' ? schedLookup(SCHEDULE_5, ts).winner : schedLookup(SCHEDULE_15, ts).winner;
    return new Response(JSON.stringify([{ conditionId: `cond-${tf}-${ts}`, closed: true, outcomes: '["Up","Down"]', clobTokenIds: `["u${tf}-${ts}","d${tf}-${ts}"]`, outcomePrices: w === 'up' ? '[ "1.0", "0.0" ]' : '[ "0.0", "1.0" ]' }]), { status: 200 });
  }
  if (u.includes('clob.polymarket.com/price')) {
    const m = u.match(/token_id=(u|d)(\d+)-(\d+)/);
    const tf = m ? (m[2] === '5' ? '5' : '15') : '15';
    const ts = m ? Number(m[3]) : T0;
    const side = m && m[1] === 'u' ? 'up' : 'down';
    const wsec = tf === '5' ? W5 : W15;
    const s = tf === '5' ? schedLookup(SCHEDULE_5, ts) : schedLookup(SCHEDULE_15, ts);
    const urlSide = u.includes('side=SELL') ? 'SELL' : 'BUY';
    let price = 0.5;
    if (virtualNow >= (ts + wsec) * 1000) {
      price = s.winner === side ? 1.0 : 0.01;
    } else if (s.entry && side === s.entry) {
      const offset = virtualNow - ts * 1000;
      if (urlSide === 'BUY') {
        price = tf === '5' ? askForSide5(ts, offset) : askForSide15(ts, offset);
      } else {
        price = tf === '5' ? bidForSide5(ts, offset) : bidForSide15(ts, offset);
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

  const endAt = (T0 + 5 * W5 + 30) * 1000;
  while (virtualNow < endAt) { virtualNow += 500; await sleep(1); }
  await sleep(50);

  const st5 = states['hedgeState:BTC-5m'];
  const st15 = states['hedgeState:BTC-15m'];
  const byTs5 = new Map((st5.history || []).map(h => [h.windowTs, h]));
  const byTs15 = new Map((st15.history || []).map(h => [h.windowTs, h]));
  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  const A = byTs5.get(T0);
  const B = byTs5.get(T0 + W5);
  const C = byTs5.get(T0 + 2 * W5);
  const D = byTs5.get(T0 + 3 * W5);
  const E = byTs5.get(T0 + 4 * W5);
  const h15 = st15.history[0];

  const fmt = h => h ? `${h.betPlaced ? h.entrySide.toUpperCase() : 'NONE'} ${h.legs.length}legs sl:${h.stopLossCount} ${h.win === true ? 'WIN' : h.win === false ? 'LOSS' : '?'} $${h.pnl?.toFixed(2)}` : 'MISSING';
  console.log(`A: ${fmt(A)}`);
  console.log(`B: ${fmt(B)}`);
  console.log(`C: ${fmt(C)}`);
  console.log(`D: ${fmt(D)}`);
  console.log(`E: ${fmt(E)}`);
  console.log(`15m: ${fmt(h15)}`);

  // A: entry + 1 stop loss + 1 martingale re-entry, win
  check('A: entry + martingale re-entry (2+ legs)', A && A.betPlaced && A.legs.length >= 2);
  check('A: 1 stop loss', A && A.stopLossCount >= 1);
  check('A: win', A && A.win === true);
  check('A: pnl = payout + sellProceeds - wager', A && Math.abs(A.pnl - (A.payout + A.sellProceeds - A.wager)) < 0.02);

  // B: no entry
  check('B: no bet placed', B && !B.betPlaced);

  // C: 2 stops + 2 martingale, loss
  check('C: 2+ stops', C && C.stopLossCount >= 2);
  check('C: loss', C && C.win === false);

  // D: entry, no stop, win
  check('D: entry, no stop, win', D && D.betPlaced && D.stopLossCount === 0 && D.win === true);

  // E: 1 stop, loss
  check('E: 1 stop', E && E.stopLossCount >= 1);
  check('E: loss', E && E.win === false);

  // 15m: entry + stop, loss
  check('15m: entry + stop', h15 && h15.betPlaced && h15.stopLossCount >= 1);
  check('15m: loss', h15 && h15.win === false);

  // Martingale scaling
  const scales = (st5.history || []).filter(h => h.legs.length >= 3)
    .every(h => h.legs[1].dollars > h.legs[0].dollars && h.legs[2].dollars > h.legs[1].dollars);
  check('martingale amounts scale (1.5x)', scales);

  // Bankroll accounting
  const openCost5 = st5.current.btc ? st5.current.btc.totalCost : 0;
  const openCost15 = st15.current.btc ? st15.current.btc.totalCost : 0;
  check('5m bankroll consistent', Math.abs(st5.bankroll - (2000 + st5.realizedPnl - openCost5)) < 0.01);
  check('15m bankroll consistent', Math.abs(st15.bankroll - (2000 + st15.realizedPnl - openCost15)) < 0.01);
  check('bankrolls are separate', Math.abs(st5.bankroll - st15.bankroll) > 0.5);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ FULL-WINDOW SMOKE TEST PASSED' : '\n❌ FULL-WINDOW SMOKE TEST FAILED');
  process.exit(allOk ? 0 : 1);
})();
