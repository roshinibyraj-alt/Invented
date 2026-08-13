'use strict';

/**
 * Math verification — proves the engine's P&L follows Polymarket's exact rules.
 *
 * Rule 1 (binary payout):  $X worth of shares at price p  =>  shares = X / p.
 *                          Every winning share pays exactly $1.00 at resolution.
 *                          => a $10 entry at 0.60 = 16.67 shares, win pays $16.67
 *                             (net profit +$6.67 before the taker fee).
 *
 * Rule 2 (ladder accumulation): when the bot flips up/down/up/down it holds BOTH
 *                          sides. On resolution ALL accumulated winning-side
 *                          shares pay $1 each; ALL other shares expire worthless.
 *                          PnL = (sum of winning-side shares) - (cost of every
 *                          leg incl. taker fee). This is what "martingale, not
 *                          only the final bet" means in accounting terms.
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
// M2: full ladder UP/DOWN/UP/DOWN, winner DOWN (the $20 + $80 down shares win).
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
    startingCapital: 4000, entryDollars: 10, martingaleAmounts: [20, 40, 80],
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
  console.log(`Rule 1 — $10 worth at 0.60 = ${round2(10 / 0.6).toFixed(2)} shares; win pays ${(10 / 0.6).toFixed(2)} x $1 = $${(10 / 0.6).toFixed(2)} (profit $${round2(10 / 0.6 - 10).toFixed(2)} before fee).`);
  console.log(`         10 SHARES at 0.60 costs $6.00 and pays $10.00 (profit $4.00 before fee) — different sizing model.`);
  console.log(`Fee rule — crypto taker fee = shares x 0.07 x p x (1-p)  [docs.polymarket.com/trading/fees]`);
  console.log(`   $10 @0.60: fee = 16.67 x 0.07 x 0.6 x 0.4 = $${expectedFee(16.67, 0.6).toFixed(2)} (docs table: 100sh@60c = $60 value -> $1.68 fee)`);

  console.log('\n== M1: lone $10 UP entry, winner UP (no flips) ==');
  console.log('  legs:', legLine(M1));
  console.log(`  payout = ${M1.payout.toFixed(2)} (winning UP shares 16.39 x $1) | wager(cost) = ${M1.wager.toFixed(2)} | pnl = ${M1.pnl.toFixed(2)} | win=${M1.win}`);

  console.log('\n== M2: full ladder UP/DOWN/UP/DOWN, winner DOWN ==');
  console.log('  legs:', legLine(M2));
  const upShares = M2.legs.filter(l => l.side === 'up').reduce((s, l) => s + l.shares, 0);
  const downShares = M2.legs.filter(l => l.side === 'down').reduce((s, l) => s + l.shares, 0);
  console.log(`  accumulated UP shares   = ${upShares.toFixed(2)}  (expire worthless when DOWN wins)`);
  console.log(`  accumulated DOWN shares = ${downShares.toFixed(2)}  (pay $1 each = $${downShares.toFixed(2)})`);
  console.log(`  payout = ${M2.payout.toFixed(2)} | wager(cost) = ${M2.wager.toFixed(2)} | pnl = ${M2.pnl.toFixed(2)} | win=${M2.win}`);
  console.log(`  -> the $80 final leg wins, but the window nets only +$${M2.pnl.toFixed(2)} because the $50 of UP shares expired worthless.`);

  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  // Rule 1: shares = dollars / price; winning share pays exactly $1
  const e1 = expectedCost(10, 0.61);
  check('M1: $10 @0.61 buys 16.39 shares', Math.abs(M1.legs[0].shares - e1.shares) < 0.01);
  check('M1: payout = winning shares x $1 (16.39)', Math.abs(M1.payout - e1.shares) < 0.01);
  check('M1: cost = notional + fee (10.00 + 0.27)', Math.abs(M1.wager - e1.cost) < 0.01 && Math.abs(e1.fee - 0.27) < 0.005);
  check('M1: pnl = payout - wager', Math.abs(M1.pnl - (M1.payout - M1.wager)) < 0.01);

  // Rule 2: ALL accumulated winning-side shares pay, not just the final bet
  check('M2: payout = BOTH down legs ($20+$80) shares x $1', Math.abs(M2.payout - downShares) < 0.01 && Math.abs(M2.payout - 163.94) < 0.02);
  check('M2: pnl accounts for ALL 4 legs cost (~154.09)', Math.abs(M2.wager - 154.09) < 0.02);
  check('M2: pnl = payout - wager (+9.85)', Math.abs(M2.pnl - (M2.payout - M2.wager)) < 0.01 && M2.pnl > 9.8 && M2.pnl < 9.9);

  // Cross-check: if the same ladder had resolved UP instead, the math says -72.13
  const upLosePayout = upShares;
  const upLosePnl = round2(upLosePayout - M2.wager);
  console.log(`\n  (what-if: same ladder resolves UP -> payout $${upLosePayout.toFixed(2)} - cost $${M2.wager.toFixed(2)} = pnl $${upLosePnl.toFixed(2)})`);
  check('M2: what-if UP winner -> pnl -72.13 (both up legs pay, both down legs expire)', Math.abs(upLosePnl + 72.13) < 0.02);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ MATH CHECK PASSED — engine P&L matches Polymarket payout + fee rules' : '\n❌ MATH CHECK FAILED');
  process.exit(allOk ? 0 : 1);
})();
