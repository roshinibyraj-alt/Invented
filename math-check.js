'use strict';

/**
 * Math verification — proves the engine's P&L follows Polymarket's exact rules.
 *
 * Rule 1 (binary payout):  $X worth of shares at price p  =>  shares = X / p.
 *                          Every winning share pays exactly $1.00 at resolution.
 *                          => a $50 entry at 0.60 = 83.33 shares, win pays $83.33
 *                             (net profit +$33.33 before the taker fee).
 *
 * Rule 2 (close the loser at flip): the bot allows ONLY ONE $100 flip (2x the
 *                          $50 entry). It
 *                          BUYS the new side first, then ~2s later SELLS the
 *                          losing side it just left at the current bid
 *                          (recovering capital). Only the FINAL side is held.
 *                          PnL = final payout (final side shares x $1)
 *                                + sell proceeds - cost of every buy incl. fee.
 *
 * Fee rule (Polymarket docs, crypto category): fee = shares * 0.07 * p * (1-p).
 *
 * Usage: node math-check.js   (virtual clock, ~4 seconds)
 */

const { createEngine } = require('./engine-factory');

const W5 = 300;
const WAIT5 = 60;
const FLIP_HOLD_MS = 30000;
const FEE_THETA = 0.07;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;

let virtualNow = 0;
let T0 = 0;

// M1: lone UP entry, no flips, winner UP.
// M2: UP $50 entry + ONE $100 flip DOWN (3 touches scripted, only 1 allowed), winner DOWN.
function scheduleFor(ts) {
  if (ts === T0)         return { entry: 'up',   flips: [],                    winner: 'up' };
  return                  { entry: 'up',   flips: ['down', 'up', 'down'],      winner: 'down' };
}

function highSideAt(ts, now) {
  const s = scheduleFor(ts);
  const waitMs = (ts + WAIT5) * 1000;
  const closeMs = (ts + W5) * 1000;
  if (now < waitMs || now >= closeMs) return null;
  let high = s.entry;
  for (let i = 0; i < s.flips.length; i++) {
    const touchAt = waitMs + (i + 1) * FLIP_HOLD_MS;
    if (now >= touchAt && now < touchAt + FLIP_HOLD_MS) { high = s.flips[i]; break; }
  }
  if (s.flips.length && now >= waitMs + (s.flips.length + 1) * FLIP_HOLD_MS) {
    high = s.flips[s.flips.length - 1];
  }
  return high;
}

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.binance.com')) {
    const m = u.match(/interval=(\d+)m/);
    const intervalSec = (m ? Number(m[1]) : 5) * 60;
    const base = Math.floor(virtualNow / (intervalSec * 1000)) * (intervalSec * 1000);
    const rows = [];
    for (let i = 0; i < 5; i++) {
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
        const w = scheduleFor(ts).winner;
        price = side === w ? 1.0 : 0.01;
      } else {
        const high = highSideAt(ts, virtualNow);
        if (high) price = side === high ? 0.61 : 0.40;
      }
    } else if (virtualNow >= (ts + 180) * 1000 && virtualNow < (ts + 900) * 1000) {
      price = side === 'up' ? 0.61 : 0.40;
    }
    return new Response(JSON.stringify({ price: String(price) }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

// Polymarket docs fee: fee = shares * feeRate * p * (1-p), crypto feeRate = 0.07.
function expectedFee(shares, price) {
  return shares * FEE_THETA * price * (1 - price);
}
function expectedCost(dollars, price) {
  const shares = round2(dollars / price);
  const notional = round2(shares * price);
  return { shares, notional, fee: round2(expectedFee(shares, price)), cost: round2(notional + round2(expectedFee(shares, price))) };
}

(async () => {
  const states = {};
  virtualNow = Math.floor(Date.now() / (W5 * 1000)) * (W5 * 1000) + W5 * 1000;

  const engine = createEngine({
    startingCapital: 4000, entryDollars: 50, martingaleAmounts: [100],
    waitSeconds5: WAIT5, waitSeconds15: 180, windowSeconds15: 900, windowSeconds5: W5,
    triggerSlip: 0.02, dryRun: true, startAtBoundary: false, tickMs: 1,
    nowFn: () => virtualNow,
    emit: (ev, s) => { states[ev] = s; },
    slog: () => {},
  });

  await engine.start();
  await sleep(30);
  T0 = states['hedgeState:BTC-5m'].current.btc.windowTs;

  const endAt = (T0 + 2 * W5 + 30) * 1000;
  while (virtualNow < endAt) { virtualNow += 500; await sleep(1); }
  await sleep(50);

  const st5 = states['hedgeState:BTC-5m'];
  const byTs = new Map((st5.history || []).map(h => [h.windowTs, h]));
  const M1 = byTs.get(T0);
  const M2 = byTs.get(T0 + W5);
  const legLine = h => (h.legs || []).map(l => `${l.side.toUpperCase()} $${l.dollars} @${l.price.toFixed(2)} = ${l.shares.toFixed(2)}sh cost $${l.cost.toFixed(2)}`).join(' | ');

  console.log('\n== Polymarket math check ==');
  console.log(`Rule 1 — $50 worth at 0.60 = ${round2(50 / 0.6).toFixed(2)} shares; win pays ${(50 / 0.6).toFixed(2)} x $1 = $${(50 / 0.6).toFixed(2)} (profit $${round2(50 / 0.6 - 50).toFixed(2)} before fee).`);
  console.log(`         10 SHARES at 0.60 costs $6.00 and pays $10.00 (profit $4.00 before fee) — different sizing model.`);
  console.log(`Fee rule — crypto taker fee = shares x 0.07 x p x (1-p)  [docs.polymarket.com/trading/fees]`);
  console.log(`   $50 @0.60: fee = 83.33 x 0.07 x 0.6 x 0.4 = $${expectedFee(83.33, 0.6).toFixed(2)} (docs table: 100sh@60c = $60 value -> $1.68 fee)`);

  console.log('\n== M1: lone $50 UP entry, winner UP (no flips) ==');
  console.log('  legs:', legLine(M1));
  console.log(`  payout = ${M1.payout.toFixed(2)} (winning UP shares 81.97 x $1) | wager(cost) = ${M1.wager.toFixed(2)} | pnl = ${M1.pnl.toFixed(2)} | win=${M1.win}`);

  console.log('\n== M2: UP $50 entry + ONE $100 flip DOWN (3 touches, 1 allowed), winner DOWN ==');
  console.log('  legs:', legLine(M2));
  console.log('  sells:', (M2.sells || []).map(x => `${x.side.toUpperCase()} ${x.shares.toFixed(2)}sh @${x.price.toFixed(2)} = $${x.proceeds.toFixed(2)}`).join(' | '));
  console.log(`  payout = ${M2.payout.toFixed(2)} (FINAL held DOWN ${M2.payout.toFixed(2)}sh x $1) | wager = ${M2.wager.toFixed(2)} | recovered = ${(M2.sellProceeds || 0).toFixed(2)} | pnl = ${M2.pnl.toFixed(2)} | win=${M2.win}`);
  console.log(`  -> the flipped-away UP entry is sold at 0.40; only the FINAL DOWN $100 leg is held to resolution.`);

  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  // Rule 1: shares = dollars / price; winning share pays exactly $1
  const e1 = expectedCost(50, 0.61);
  check('M1: $50 @0.61 buys 81.97 shares', Math.abs(M1.legs[0].shares - e1.shares) < 0.01);
  check('M1: payout = winning shares x $1 (81.97)', Math.abs(M1.payout - e1.shares) < 0.01);
  check('M1: cost = notional + fee (50.00 + 1.37)', Math.abs(M1.wager - e1.cost) < 0.01 && Math.abs(e1.fee - 1.37) < 0.005);
  check('M1: pnl = payout - wager', Math.abs(M1.pnl - (M1.payout - M1.wager)) < 0.01);

  // Rule 2: the losing side is CLOSED at each flip — only the final side is
  // held; pnl = final payout + sell proceeds - total buy cost.
  check('M2: exactly ONE $100 flip placed despite 3 touches (max 1)', M2 && M2.legs.length === 2 && M2.legs[1].dollars === 100 && M2.reachedMaxMartingale === true);
  check('M2: exactly 1 losing-side sell (UP entry closed)', M2 && M2.sells.length === 1 && M2.sells[0].side === 'up');
  check('M2: sell closes the exact flipped-away quantity (81.97)', M2 && Math.abs(M2.sells[0].shares - 81.97) < 0.02);
  check('M2: payout = FINAL held side shares x $1 (163.93)', M2 && Math.abs(M2.payout - 163.93) < 0.02);
  check('M2: pnl accounts for ALL buy costs (~154.10)', M2 && Math.abs(M2.wager - 154.10) < 0.02);
  check('M2: pnl = payout + sellProceeds - wager (+41.24, flip recovers the entry)', M2 && Math.abs(M2.pnl - (M2.payout + M2.sellProceeds - M2.wager)) < 0.01 && M2.pnl > 41 && M2.pnl < 41.5);

  // What-if: winner UP -> the FINAL held side is DOWN, so UP pays nothing
  const upLosePnl = round2((M2.sellProceeds || 0) - M2.wager);
  console.log(`\n  (what-if: same window resolves UP -> final DOWN leg expires, payout $0 + recovered $${(M2.sellProceeds || 0).toFixed(2)} - cost $${M2.wager.toFixed(2)} = pnl $${upLosePnl.toFixed(2)})`);
  check('M2: what-if UP winner -> pnl -122.69 (final side lost, only sells recovered)', Math.abs(upLosePnl + 122.69) < 0.02);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ MATH CHECK PASSED — engine P&L matches Polymarket payout + fee rules' : '\n❌ MATH CHECK FAILED');
  process.exit(allOk ? 0 : 1);
})();
