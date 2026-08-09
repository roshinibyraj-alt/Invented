'use strict';

/**
 * Deterministic smoke test — simulates the combined 15m/5m hedge engine
 * over several 15m windows in fast-forward (15m = 18s, 5m = 6s) with a
 * stubbed Polymarket API whose outcomes are scripted per window.
 *
 * Script for the run (5m bets SAME direction as the 15m bet):
 *   15m windows: T0 UP(wins) -> T0+18 UP(wins) -> T0+36 UP(loses) -> T0+54 DOWN(loses) -> T0+72 UP(wins)
 *   5m  windows (bets ONLY at 15m opens, NEVER skipped):
 *       T0    bet UP    -> winner UP    (WINS  -> rolls into 15m UP, which also wins)
 *       T0+18 bet UP    -> winner UP    (WINS  -> rolls into 15m UP, which also wins)
 *       T0+36 bet UP    -> winner DOWN  (LOSES -> no roll; no skip)
 *       T0+54 bet DOWN  -> winner UP    (LOSES -> no roll; no skip)
 *       T0+72 bet UP    -> winner UP    (WINS  -> rolls into 15m UP, which also wins)
 *
 * Verifies: 5m bets happen ONLY at 15m opens, are NEVER skipped, are the
 * SAME direction as the 15m bet, roll after a 5m win, 15m direction
 * follows the previous 15m outcome, and the shared bankroll accounting.
 *
 * Usage: node smoke-test.js   (takes ~2 minutes)
 */

const { createEngine } = require('./engine-factory');

const W15 = 18; // simulated 15m window (s)
const W5 = 6;   // simulated 5m window (s)
const realFetch = global.fetch;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Pick the boundary the engine will align to.
let T0 = Math.floor(Date.now() / 1000 / W15) * W15 + W15;
if (Math.floor(Date.now() / 1000) >= T0 - 3) T0 += W15;

const SCRIPT = {
  '15': new Map([[T0, 'up'], [T0 + W15, 'up'], [T0 + 2 * W15, 'down'], [T0 + 3 * W15, 'up'], [T0 + 4 * W15, 'up']]),
  '5': new Map([[T0, 'up'], [T0 + W15, 'up'], [T0 + 2 * W15, 'down'], [T0 + 3 * W15, 'up'], [T0 + 4 * W15, 'up']]),
};
function winnerFor(tf, ts) {
  const w = SCRIPT[tf] && SCRIPT[tf].get(ts);
  return w || 'up';
}

// Stub: Binance passes through; Polymarket endpoints are scripted.
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.binance.com')) return realFetch(url, opts);

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
    const w = winnerFor(tf, ts);
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
    const w = winnerFor(tf, ts);
    const closeAt = ts * 1000 + (tf === '5' ? W5 : W15) * 1000;
    let price = 0.5;
    if (Date.now() >= closeAt) {
      const isWinner = (m && m[1] === 'u') === (w === 'up');
      price = isWinner ? 1.0 : 0.01;
    }
    return new Response(JSON.stringify({ price: String(price) }), { status: 200 });
  }

  return new Response('{}', { status: 200 });
};

(async () => {
  const lines = [];
  const logs = [];
  const snap = { max15Shares: 0, m15Seq: [], m5Seq: [], last5wt: null, last15wt: null };
  const states = { m15: null, m5: null };

  // wait until ~2s before the boundary, then start the engine
  const waitMs = Math.max(0, (T0 - 2) * 1000 - Date.now());
  if (waitMs > 0) await sleep(waitMs);

  const engine = createEngine({
    startingCapital: 4000, baseBet15m: 150, baseBet5m: 50,
    windowSeconds15: W15, windowSeconds5: W5,
    dryRun: true,
    emit: (ev, s) => {
      states[ev === 'hedgeState:BTC-15m' ? 'm15' : 'm5'] = s;
      if (ev === 'hedgeState:BTC-15m') {
        const t = s.current.btc;
        if (t && t.betPlaced) snap.max15Shares = Math.max(snap.max15Shares, t.position.shares);
        if (t && t.windowTs !== snap.last15wt) { snap.last15wt = t.windowTs; snap.m15Seq.push({ wt: t.windowTs, dir: t.signalSide }); }
      } else {
        const t = s.current.btc;
        if (t && t.windowTs !== snap.last5wt) {
          snap.last5wt = t.windowTs;
          snap.m5Seq.push({ wt: t.windowTs, side: t.signalSide });
        }
      }
    },
    slog: (l) => { logs.push(l); lines.push(l); },
  });

  await engine.start();

  // run through T0 + 5 windows + settle margin
  const endAt = (T0 + 5 * W15 + 15) * 1000;
  while (Date.now() < endAt) await sleep(1000);

  const s15 = states.m15;
  const s5 = states.m5;
  const h15 = s15.history; // newest first
  const h5 = s5.history;
  const fmt = ts => new Date(ts * 1000).toISOString().slice(11, 19);

  console.log('== 15m windows seen (direction) ==');
  for (const x of snap.m15Seq) console.log(`  ${fmt(x.wt)} -> ${x.dir}`);
  console.log('== 5m windows seen (only at 15m opens) ==');
  for (const x of snap.m5Seq) console.log(`  ${fmt(x.wt)} -> ${x.side}`);
  console.log('== resolved 15m ==');
  for (const h of h15) console.log(`  ${fmt(h.windowTs)} dir ${h.direction} winner ${h.winner} win ${h.win} pnl $${h.pnl.toFixed(2)}`);
  console.log('== resolved 5m ==');
  for (const h of h5) console.log(`  ${fmt(h.windowTs)} side ${h.side || '—'} winner ${h.winner} skipped ${h.skipped} win ${h.win} pnl $${h.pnl.toFixed(2)}`);
  console.log(`bankroll $${s15.bankroll.toFixed(2)} | totalPnl $${s15.realizedPnlTotal.toFixed(2)} (15m $${s15.realizedPnl.toFixed(2)} + 5m $${s5.realizedPnl.toFixed(2)}) | max 15m shares ${snap.max15Shares.toFixed(1)}`);

  const m15wt = snap.m15Seq.map(x => x.wt);
  const m15dir = snap.m15Seq.map(x => x.dir);
  const m5wt = snap.m5Seq.map(x => x.wt);

  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  // 5m bets at EVERY 15m open (T0, T0+18, ...) — never at T0+6/T0+12/... and NEVER skipped
  check('5m windows occur at every 15m open (5 of 5)', m5wt.length >= 5 && m5wt.every(ts => ts % W15 === 0) && JSON.stringify(m5wt.slice(0, 5)) === JSON.stringify([T0, T0 + W15, T0 + 2 * W15, T0 + 3 * W15, T0 + 4 * W15]));
  check('no 5m window at intermediate boundaries', !m5wt.includes(T0 + W5) && !m5wt.includes(T0 + 2 * W5));
  check('no 5m window ever skipped', snap.m5Seq.every(x => x.side != null));
  // 15m direction follows previous outcome: up, up, up, down, up
  check('15m direction sequence', JSON.stringify(m15dir.slice(0, 5)) === JSON.stringify(['up', 'up', 'up', 'down', 'up']));
  // 5m side is the SAME as the 15m direction (momentum add-on)
  const sameSide = snap.m5Seq.slice(0, 5).every((x, i) => x.side === m15dir[i]);
  check('5m side same as 15m direction', sameSide);
  // roll: 15m position grew past the $150 base (300 shares @0.5)
  check('5m win rolled into 15m (shares > base)', snap.max15Shares >= 380);
  // resolutions
  const h15new = h15.slice().reverse();
  check('15m W1 won (up)', h15new[0] && h15new[0].direction === 'up' && h15new[0].win === true);
  check('15m W2 won (up)', h15new[1] && h15new[1].direction === 'up' && h15new[1].win === true);
  check('15m W3 lost (up vs down)', h15new[2] && h15new[2].direction === 'up' && h15new[2].win === false);
  check('15m W4 lost (down vs up)', h15new[3] && h15new[3].direction === 'down' && h15new[3].win === false);
  check('15m W5 won (up)', h15new[4] && h15new[4].direction === 'up' && h15new[4].win === true);
  const h5new = h5.slice().reverse();
  const byTs = new Map(h5new.map(h => [h.windowTs, h]));
  check('5m T0 won (up)', byTs.get(T0) && byTs.get(T0).win === true && byTs.get(T0).side === 'up' && byTs.get(T0).skipped === false);
  check('5m T0+18 won (up)', byTs.get(T0 + W15) && byTs.get(T0 + W15).win === true && byTs.get(T0 + W15).side === 'up' && byTs.get(T0 + W15).skipped === false);
  check('5m T0+36 lost, still bet', byTs.get(T0 + 2 * W15) && byTs.get(T0 + 2 * W15).win === false && byTs.get(T0 + 2 * W15).side === 'up' && byTs.get(T0 + 2 * W15).skipped === false);
  check('5m T0+54 lost, still bet', byTs.get(T0 + 3 * W15) && byTs.get(T0 + 3 * W15).win === false && byTs.get(T0 + 3 * W15).side === 'down' && byTs.get(T0 + 3 * W15).skipped === false);
  check('5m T0+72 won (up)', byTs.get(T0 + 4 * W15) && byTs.get(T0 + 4 * W15).win === true && byTs.get(T0 + 4 * W15).side === 'up' && byTs.get(T0 + 4 * W15).skipped === false);
  check('5m history has 5 bets, 0 skips', h5new.length >= 5 && h5new.slice(0, 5).every(h => !h.skipped));
  // shared bankroll: bankroll = start + realized - open position cost
  const openCost = s15.current.btc && s15.current.btc.position ? s15.current.btc.position.cost : 0;
  check('shared bankroll accounting consistent', Math.abs(s15.bankroll - (4000 + s15.realizedPnlTotal - openCost)) < 0.01);
  check('total P&L = 15m + 5m', Math.abs(s15.realizedPnlTotal - (s15.realizedPnl + s5.realizedPnl)) < 0.01);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ SMOKE TEST PASSED' : '\n❌ SMOKE TEST FAILED');
  process.exit(allOk ? 0 : 1);
})();
