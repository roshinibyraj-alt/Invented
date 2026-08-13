'use strict';

/**
 * Deterministic smoke test — drives the 0.60 martingale engine on a VIRTUAL
 * clock (no wall-clock flakiness), with stubbed Binance (synthetic candles)
 * and scripted Polymarket prices.
 *
 * Simulated windows: 15m = 30s, 5m = 12s, waits 8s/4s.
 *
 * Scripted window (index -> [entry, flips, winner]):
 *   idx0: up  -> [down, up, down] -> winner up     (reaches 3rd martingale)
 *   idx1: down -> [up]            -> winner up     (1 flip)
 *   idx2: up  -> []               -> winner up     (no flip, entry wins)
 *   idx3: down -> [up, down]      -> winner down   (2 flips)
 *   idx4: up  -> []               -> winner down   (entry loses)
 *
 * Prices: 0.50 during the wait, the entry side at 0.62 after the wait,
 * each flip side at 0.62 in 2s holds (other side 0.38), winner 1.0 /
 * loser 0.01 after close.
 *
 * Verifies: no bet before the wait ends, $10 entry, martingale amounts
 * $20/$40/$80 in order, flips alternate sides, 3rd-martingale counting,
 * win/loss accounting, win rate, max drawdown, equity curve, and the
 * shared bankroll math.
 *
 * Usage: node smoke-test.js   (takes ~15 seconds)
 */

const { createEngine } = require('./engine-factory');

const W15 = 30;
const W5 = 12;
const WAIT15 = 8;
const WAIT5 = 4;
const FLIP_GAP_MS = 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let virtualNow = Date.now(); // virtual clock, advanced by the test
let T0 = 0;

const SCRIPTS = [
  { entry: 'up',   flips: ['down', 'up', 'down'], winner: 'up' },
  { entry: 'down', flips: ['up'],                 winner: 'up' },
  { entry: 'up',   flips: [],                     winner: 'up' },
  { entry: 'down', flips: ['up', 'down'],         winner: 'down' },
  { entry: 'up',   flips: [],                     winner: 'down' },
];
function scriptFor(tf, ts) {
  const wsec = tf === '5' ? W5 : W15;
  const idx = Math.round((ts - T0) / wsec);
  const i = ((idx % SCRIPTS.length) + SCRIPTS.length) % SCRIPTS.length;
  return SCRIPTS[i];
}
function highSideAt(tf, ts, now) {
  const s = scriptFor(tf, ts);
  const wsec = tf === '5' ? W5 : W15;
  const waitMs = (ts + (tf === '5' ? WAIT5 : WAIT15)) * 1000;
  const closeMs = (ts + wsec) * 1000;
  if (now >= closeMs || now < waitMs) return null; // resolved or still waiting
  let high = s.entry;
  for (let i = 0; i < s.flips.length; i++) {
    if (now >= waitMs + (i + 1) * FLIP_GAP_MS) high = s.flips[i];
    else break;
  }
  return high;
}

// Stub: Binance klines are synthetic (no network), Polymarket is scripted.
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
    const cond = `cond-${tf}-${ts}`;
    return new Response(JSON.stringify([{ markets: [{ conditionId: cond, outcomes: '["Up","Down"]', clobTokenIds: `["u${tf}-${ts}","d${tf}-${ts}"]` }] }]), { status: 200 });
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
    let price = 0.5;
    if (virtualNow >= (ts + wsec) * 1000) {
      price = scriptFor(tf, ts).winner === side ? 1.0 : 0.01;
    } else {
      const high = highSideAt(tf, ts, virtualNow);
      if (high) price = side === high ? 0.62 : 0.38;
    }
    return new Response(JSON.stringify({ price: String(price) }), { status: 200 });
  }

  return new Response('{}', { status: 200 });
};

(async () => {
  const logs = [];
  const states = { m5: null, m15: null };

  const engine = createEngine({
    startingCapital: 4000,
    entryDollars: 10,
    martingaleAmounts: [20, 40, 80],
    waitSeconds5: WAIT5,
    waitSeconds15: WAIT15,
    windowSeconds15: W15,
    windowSeconds5: W5,
    dryRun: true,
    nowFn: () => virtualNow,
    tickMs: 1,
    emit: (ev, s) => {
      states[ev === 'hedgeState:BTC-15m' ? 'm15' : 'm5'] = s;
    },
    slog: (l) => { logs.push(l); },
  });

  await engine.start();

  // Learn the engine's aligned start boundary from its own state.
  const deadline = Date.now() + 5000;
  while ((!states.m5 || !states.m5.boundaryWindowTs) && Date.now() < deadline) {
    await sleep(5);
  }
  if (!states.m5 || !states.m5.boundaryWindowTs) {
    console.log('❌ engine never aligned to a boundary');
    process.exit(1);
  }
  T0 = states.m5.boundaryWindowTs;
  virtualNow = T0 * 1000;
  console.log(`T0 (aligned boundary) = ${new Date(T0 * 1000).toISOString()}`);

  // Drive the virtual clock forward in 500ms steps until 3x 15m windows settle.
  const endAt = (T0 + 3 * W15 + 30) * 1000;
  while (virtualNow < endAt) {
    virtualNow += 500;
    await sleep(1);
  }
  await sleep(50); // let the engine flush its last virtual steps

  const s15 = states.m15;
  const s5 = states.m5;
  const fmt = ts => new Date(ts * 1000).toISOString().slice(11, 19);

  const sorted = list => (list || []).slice().sort((a, b) => a.windowTs - b.windowTs);
  const h15 = sorted(s15.history);
  const h5 = sorted(s5.history);

  console.log('== resolved 15m ==');
  for (const h of h15) console.log(`  ${fmt(h.windowTs)} entry ${h.entrySide || '—'} legs [${(h.legs || []).map(l => '$' + l.dollars + l.side[0].toUpperCase()).join(' ')}] 3MG:${h.reachedLevel3 ? 'yes' : 'no'} winner ${h.winner} win ${h.win} pnl $${h.pnl.toFixed(2)}`);
  console.log('== resolved 5m ==');
  for (const h of h5) console.log(`  ${fmt(h.windowTs)} entry ${h.entrySide || '—'} legs [${(h.legs || []).map(l => '$' + l.dollars + l.side[0].toUpperCase()).join(' ')}] 3MG:${h.reachedLevel3 ? 'yes' : 'no'} winner ${h.winner} win ${h.win} pnl $${h.pnl.toFixed(2)}`);
  console.log(`bankroll $${s15.bankroll.toFixed(2)} | totalPnl $${s15.realizedPnlTotal.toFixed(2)} | equityCurve ${s15.equityCurve.length} pts | maxDD ${(s15.maxDrawdown.pct * 100).toFixed(2)}% ($${s15.maxDrawdown.dollars.toFixed(2)})`);
  console.log(`15m: ${s15.wins}W/${s15.losses}L (${s15.windowsDecided} decided, ${s15.windowsReached3rdMartingale} reached 3rd MG) | 5m: ${s5.wins}W/${s5.losses}L (${s5.windowsDecided} decided, ${s5.windowsReached3rdMartingale} reached 3rd MG)`);

  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  const h15new = h15.slice(0, 3); // first three 15m windows resolve during the run
  const first = h15new[0];
  const second = h15new[1];
  const third = h15new[2];

  // 1) entry never happens before the wait ends
  const waitFor = h => (h.windowTs + (h.tf === '5' ? WAIT5 : WAIT15)) * 1000;
  const entryOnlyAfterWait = h15new.concat(h5).filter(h => h.legs && h.legs.length)
    .every(h => h.legs[0].ts >= waitFor(h) - 500);
  check('entries only happen after the wait window', entryOnlyAfterWait);

  // 2) first 15m window: entry up $10, then $20/$40/$80 flips, reaches 3rd martingale
  check('idx0 entry is UP $10', first && first.entrySide === 'up' && first.legs[0].dollars === 10);
  check('idx0 martingale amounts 20/40/80', first && first.legs.length === 4 && JSON.stringify(first.legs.slice(1).map(l => l.dollars)) === JSON.stringify([20, 40, 80]));
  check('idx0 legs alternate sides', first && first.legs.every((l, i) => i === 0 || l.side !== first.legs[i - 1].side));
  check('idx0 reached 3rd martingale', first && first.reachedLevel3 === true);

  // 3) flips happen on the side opposite the previous buy
  const oppFlip = h15new.concat(h5).filter(h => h.legs && h.legs.length > 1)
    .every(h => h.legs.slice(1).every((l, i) => l.side !== h.legs[i].side));
  check('every flip is on the opposite side', oppFlip);

  // 4) scripted outcomes: idx0 LOSS despite full ladder, idx1 WIN, idx2 WIN
  check('idx0 full-ladder window is a net LOSS', first && first.win === false && first.pnl < 0);
  check('idx1 window WIN (1 flip, down->up)', second && second.win === true && second.entrySide === 'down' && second.martingaleLevels === 2);
  check('idx2 window WIN (no flip)', third && third.win === true && third.martingaleLevels === 1);

  // 5) 3rd-martingale counters
  check('15m 3rd-martingale counter >= 1', s15.windowsReached3rdMartingale >= 1);
  check('5m 3rd-martingale counter >= 1', s5.windowsReached3rdMartingale >= 1);

  // 6) win rate math
  const expectRate15 = s15.windowsDecided > 0 ? round2(s15.wins / s15.windowsDecided) : null;
  check('15m winRate consistent with wins/decided', s15.winRate === expectRate15 && s15.windowsDecided === s15.wins + s15.losses);

  // 7) shared bankroll accounting: bankroll = start + realizedPnl - open cost
  const openCost = (s15.current.btc ? s15.current.btc.totalCost : 0) + (s5.current.btc ? s5.current.btc.totalCost : 0);
  check('shared bankroll accounting consistent', Math.abs(s15.bankroll - (4000 + s15.realizedPnlTotal - openCost)) < 0.01);

  // 8) equity curve + max drawdown present
  check('equity curve has multiple points', s15.equityCurve.length >= 3);
  check('max drawdown >= 0', s15.maxDrawdown.pct >= 0 && s15.maxDrawdown.dollars >= 0);
  check('max drawdown <= 100%', s15.maxDrawdown.pct <= 1);

  // 9) no double bets per leg level, no skipped windows in this script
  const noDup = h15new.concat(h5).filter(h => h.legs && h.legs.length)
    .every(h => h.legs.every((l, i) => l.level === i));
  check('leg levels are sequential (no double buys)', noDup);
  check('no skipped windows in this script', h15new.concat(h5).every(h => h.skipped === false));

  // 10) 5m results sanity: multiple settled windows, wins and losses both present
  check('5m settled at least 6 windows', h5.length >= 6);
  check('5m has both wins and losses', h5.some(h => h.win === true) && h5.some(h => h.win === false));
  check('5m has a 3rd-martingale window', h5.some(h => h.reachedLevel3 === true));

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ SMOKE TEST PASSED' : '\n❌ SMOKE TEST FAILED');
  process.exit(allOk ? 0 : 1);
})();

function round2(n) { return Math.round(n * 100) / 100; }
