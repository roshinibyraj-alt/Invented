'use strict';

/**
 * Full-window smoke test — proves the ENTIRE martingale ladder completes
 * inside ONE real-sized 5m window (300s, 60s wait) on the virtual clock.
 *
 * Window A (t0):     UP entry $10 -> DOWN $20 -> UP $40 -> DOWN $80, winner DOWN  (full ladder, win)
 * Window B (t0+300): UP $10 -> DOWN $20 -> UP $40 -> DOWN $80 with the 3rd band
 *                    touch only 10s before close -> still completes (edge timing)
 * Window D (t0+600): BOTH sides already at 0.60+ when the wait ends (UP 0.61,
 *                    DOWN 0.60, never leaving) -> entry fires, then the ENTIRE
 *                    ladder fires instantly (no come-back wait, no transition
 *                    guard) — proves "martingale fires instantly".
 * Window C (t0+900): UP $10 -> DOWN $20 -> UP $40, DOWN never reaches 0.60
 *                    -> 3rd martingale NOT placed (documents the "missed 3rd" case)
 *
 * Band touches are 30s holds at ask 0.61 (inside the 0.60-0.62 band);
 * non-touched sides sit at 0.40, everything is 0.50 during the wait.
 *
 * Usage: node smoke-full-window.js   (virtual clock, ~4 seconds)
 */

const { createEngine } = require('./engine-factory');

const W5 = 300;
const WAIT5 = 60;
const FLIP_HOLD_MS = 30000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let virtualNow = 0; // set to a clean 5m boundary before start
let T0 = 0;

function scheduleFor(ts) {
  if (ts === T0)            return { entry: 'up', flips: ['down', 'up', 'down'], winner: 'down' };              // A: full ladder
  if (ts === T0 + W5)       return { entry: 'up', flips: ['down', 'up', 'down'], winner: 'down', late3: true };  // B: 3rd touch at close
  if (ts === T0 + 2 * W5)   return { entry: 'up', flips: ['down', 'up', 'down'], winner: 'down', instant: true }; // D: both sides at 0.60+ all window
  return                     { entry: 'up', flips: ['down', 'up'],              winner: 'up' };                   // C: no 3rd touch
}

// Which side's ask is at 0.61 at virtual time `now` for 5m window `ts`?
function highSideAt(ts, now) {
  const s = scheduleFor(ts);
  const waitMs = (ts + WAIT5) * 1000;
  const closeMs = (ts + W5) * 1000;
  if (now < waitMs || now >= closeMs) return null; // waiting or resolved
  if (s.late3) {
    // B: entry at waitMs, flips at waitMs+30s / waitMs+60s, 3rd touch only 10s before close
    const touches = [
      { at: waitMs + 30000, side: s.flips[0], hold: 30000 },
      { at: waitMs + 60000, side: s.flips[1], hold: 30000 },
      { at: closeMs - 10000, side: s.flips[2], hold: 10000 },
    ];
    let high = s.entry;
    for (const { at, side, hold } of touches) {
      if (now >= at && now < at + hold) { high = side; break; }
    }
    return high;
  }
  let high = s.entry;
  for (let i = 0; i < s.flips.length; i++) {
    const touchAt = waitMs + (i + 1) * FLIP_HOLD_MS;
    if (now >= touchAt && now < touchAt + FLIP_HOLD_MS) { high = s.flips[i]; break; }
  }
  if (now >= waitMs + (s.flips.length + 1) * FLIP_HOLD_MS) {
    high = s.flips[s.flips.length - 1]; // hold the last touched side until close
  }
  return high;
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
      const ct = base - i * intervalSec * 1000;
      rows.push([ct - intervalSec * 1000, '60000', '60025', '59985', '60010', '100', ct, '1', '1', '1', '1', '1']);
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
    const w = tf === '5' ? scheduleFor(ts).winner : 'up';
    return new Response(JSON.stringify([{ conditionId: `cond-${tf}-${ts}`, closed: true, outcomes: '["Up","Down"]', clobTokenIds: `["u${tf}-${ts}","d${tf}-${ts}"]`, outcomePrices: w === 'up' ? '[ "1.0", "0.0" ]' : '[ "0.0", "1.0" ]' }]), { status: 200 });
  }
  if (u.includes('clob.polymarket.com/price')) {
    const m = u.match(/token_id=(u|d)(\d+)-(\d+)/);
    const tf = m ? (m[2] === '5' ? '5' : '15') : '15';
    const ts = m ? Number(m[3]) : T0;
    const side = m && m[1] === 'u' ? 'up' : 'down';
    let price = 0.5;
    if (tf === '5') {
      const closeMs = (ts + W5) * 1000;
      if (virtualNow >= closeMs) {
        // resolved: winner pays 1.00, loser dust — fast resolution must pick the scripted winner
        const w = scheduleFor(ts).winner;
        price = side === w ? 1.0 : 0.01;
      } else if (scheduleFor(ts).instant) {
        price = side === 'up' ? 0.61 : 0.60; // D: both sides already at 0.60+ when the wait ends
      } else {
        const high = highSideAt(ts, virtualNow);
        if (high) price = side === high ? 0.61 : 0.40;
      }
    } else if (virtualNow >= (ts + 180) * 1000 && virtualNow < (ts + 900) * 1000) {
      price = side === 'up' ? 0.61 : 0.40; // 15m benign: never flips, winner up
    }
    return new Response(JSON.stringify({ price: String(price) }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

(async () => {
  const states = {};
  const logs = [];

  // Start on a clean 5m boundary so the first window is a full 300s window.
  virtualNow = Math.floor(Date.now() / (W5 * 1000)) * (W5 * 1000) + W5 * 1000;

  const engine = createEngine({
    startingCapital: 4000,
    entryDollars: 10,
    martingaleAmounts: [20, 40, 80],
    waitSeconds5: WAIT5,
    waitSeconds15: 180,
    windowSeconds15: 900,
    windowSeconds5: W5,
    triggerSlip: 0.02,
    dryRun: true,
    startAtBoundary: false,
    tickMs: 1,
    nowFn: () => virtualNow,
    emit: (ev, s) => { states[ev] = s; },
    slog: (l) => { logs.push(l); },
  });

  await engine.start();
  await sleep(30); // let the first tick open the current window
  T0 = states['hedgeState:BTC-5m'].current.btc.windowTs;
  console.log(`5m start window: ${new Date(T0 * 1000).toISOString()}`);

  // Drive virtual time through 3 full windows + settle margin.
  const endAt = (T0 + 4 * W5 + 30) * 1000;
  while (virtualNow < endAt) {
    virtualNow += 500;
    await sleep(1);
  }
  await sleep(50);

  const st5 = states['hedgeState:BTC-5m'];
  const byTs = new Map((st5.history || []).map(h => [h.windowTs, h]));
  const fmt = ts => new Date(ts * 1000).toISOString().slice(11, 19);

  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  const A = byTs.get(T0);
  const B = byTs.get(T0 + W5);
  const D = byTs.get(T0 + 2 * W5);
  const C = byTs.get(T0 + 3 * W5);

  console.log('\n== window A (full ladder) ==');
  console.log('  legs:', (A.legs || []).map(l => `${l.side.toUpperCase()} $${l.dollars} @${l.price} t=${fmt(Math.floor(l.ts / 1000))}`).join(' | '), '| winner', A.winner, '| pnl', A.pnl);
  console.log('== window B (3rd touch 10s before close) ==');
  console.log('  legs:', (B.legs || []).map(l => `${l.side.toUpperCase()} $${l.dollars} @${l.price} t=${fmt(Math.floor(l.ts / 1000))}`).join(' | '), '| winner', B.winner, '| pnl', B.pnl);
  console.log('== window D (both sides at 0.60+ -> instant ladder) ==');
  console.log('  legs:', (D.legs || []).map(l => `${l.side.toUpperCase()} $${l.dollars} @${l.price} t=${fmt(Math.floor(l.ts / 1000))}`).join(' | '), '| winner', D.winner, '| pnl', D.pnl);
  console.log('== window C (no 3rd touch) ==');
  console.log('  legs:', (C.legs || []).map(l => `${l.side.toUpperCase()} $${l.dollars} @${l.price} t=${fmt(Math.floor(l.ts / 1000))}`).join(' | '), '| winner', C.winner, '| pnl', C.pnl);

  const waitEnd = (T0 + WAIT5) * 1000;

  // Window A: entry after wait, then $20/$40/$80 flips, all inside the window
  check('A: entry UP $10 after the 60s wait', A && A.entrySide === 'up' && A.legs[0].dollars === 10 && A.legs[0].ts >= waitEnd - 1000);
  check('A: martingale amounts 20/40/80 in order', A && A.legs.length === 4 && JSON.stringify(A.legs.slice(1).map(l => l.dollars)) === JSON.stringify([20, 40, 80]));
  check('A: sides alternate up/down/up/down', A && JSON.stringify(A.legs.map(l => l.side)) === JSON.stringify(['up', 'down', 'up', 'down']));
  check('A: reached 3rd martingale', A && A.reachedLevel3 === true);
  check('A: all 4 buys inside the 300s window', A && A.legs.every(l => l.ts < (T0 + W5) * 1000));
  check('A: every flip ~30s after the previous leg', A && A.legs.slice(1).every((l, i) => Math.abs((l.ts - A.legs[i].ts) - FLIP_HOLD_MS) < 5000));
  check('A: window resolves as a WIN (winner down)', A && A.win === true && A.winner === 'down');

  // Window B: 3rd touch at T+290 -> flip still lands before close
  const bClose = (T0 + 2 * W5) * 1000;
  check('B: full ladder placed too', B && B.legs.length === 4 && B.reachedLevel3 === true);
  check('B: 3rd flip lands within 10s of close', B && B.legs[3].ts > bClose - 12000 && B.legs[3].ts < bClose);

  // Window D: both sides at 0.60+ -> entry fires, then the ladder fires INSTANTLY
  // (no 30s holds, no come-back wait, no transition guard)
  const dEntryTs = D && D.legs[0].ts;
  check('D: entry UP $10 fires when the wait ends', D && D.entrySide === 'up' && D.legs[0].dollars === 10 && D.legs[0].ts >= (T0 + WAIT5) * 1000 - 1000);
  check('D: full ladder placed (4 legs, reached 3rd MG)', D && D.legs.length === 4 && D.reachedLevel3 === true);
  check('D: 1st flip fires within 5s of entry (instant, no come-back wait)', D && D.legs[1].ts - dEntryTs < 5000);
  check('D: entire ladder completes within 10s of entry', D && D.legs[3].ts - dEntryTs < 10000);
  check('D: resolved as a WIN (winner down)', D && D.win === true && D.winner === 'down');

  // Window C: opposite side never reaches 0.60 -> 3rd martingale NOT placed (by design)
  check('C: only 3 legs (entry + 2 flips)', C && C.legs.length === 3);
  check('C: 3rd martingale not reached', C && C.reachedLevel3 === false);
  check('C: resolved anyway (winner up)', C && C.win === true && C.winner === 'up');

  // Engine-level counters
  check('3rd-martingale counter >= 3 (A + B + D)', st5.windowsReached3rdMartingale >= 3);

  // Shared bankroll accounting (both open 5m and 15m trades still hold cost)
  const st15 = states['hedgeState:BTC-15m'];
  const openCost = (st5.current.btc ? st5.current.btc.totalCost : 0)
                 + (st15.current.btc ? st15.current.btc.totalCost : 0);
  check('bankroll consistent', Math.abs(st5.bankroll - (4000 + st5.realizedPnlTotal - openCost)) < 0.01);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ FULL-WINDOW SMOKE TEST PASSED' : '\n❌ FULL-WINDOW SMOKE TEST FAILED');
  process.exit(allOk ? 0 : 1);
})();
