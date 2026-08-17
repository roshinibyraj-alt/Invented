'use strict';

/**
 * Math verification for the BTC 5m 0.60 martingale engine.
 */

const { createEngine } = require('./engine-factory');

const W5 = 300, WAIT5 = 60, FEE_THETA = 0.07;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;
let virtualNow = 0, T0 = 0;

const SCRIPTS = [
  { entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [], winner: 'up' },
  { entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [90], winner: 'up' },
];

function schedFor(ts) { return SCRIPTS[Math.floor(ts / W5) % SCRIPTS.length]; }

function askForEntry(ts, offsetMs) {
  const s = schedFor(ts);
  if (!s.entry) return 0.50;
  const highAt = WAIT5 * 1000 + s.highAfterMs * 1000;
  if (offsetMs < highAt) return 0.55;
  if (offsetMs < highAt + (s.gapMs || 3000)) return 0.62;
  return 0.60;
}

function bidForEntry(ts, offsetMs) {
  const s = schedFor(ts);
  if (!s.entry) return 0.50;
  const waitMs = WAIT5 * 1000;
  for (const sl of s.stopLosses) {
    const slStart = waitMs + sl * 1000;
    if (offsetMs >= slStart && offsetMs < slStart + 500) return 0.40;
  }
  return 0.50;
}

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.binance.com')) {
    return new Response(JSON.stringify([[Date.now()-60000,'60000','60025','59985','60010','100',Date.now()-1000,'1','1','1','1','1']]), { status: 200 });
  }
  if (u.includes('gamma-api.polymarket.com/events')) {
    const m = u.match(/slug=btc-updown-5m-(\d+)/);
    const ts = m ? Number(m[1]) : 0;
    return new Response(JSON.stringify([{ markets: [{ conditionId: `cond-5-${ts}`, outcomes: '["Up","Down"]', clobTokenIds: `["u5-${ts}","d5-${ts}"]` }] }]), { status: 200 });
  }
  if (u.includes('gamma-api.polymarket.com/markets')) {
    const m = u.match(/condition_ids=cond-5-(\d+)/);
    const ts = m ? Number(m[1]) : 0;
    const w = schedFor(ts).winner;
    return new Response(JSON.stringify([{ conditionId: `cond-5-${ts}`, closed: true, outcomes: '["Up","Down"]', clobTokenIds: `["u5-${ts}","d5-${ts}"]`, outcomePrices: w === 'up' ? '[ "1.0", "0.0" ]' : '[ "0.0", "1.0" ]' }]), { status: 200 });
  }
  if (u.includes('clob.polymarket.com/price')) {
    const m = u.match(/token_id=(u|d)5-(\d+)/);
    const ts = m ? Number(m[2]) : 0;
    const side = m && m[1] === 'u' ? 'up' : 'down';
    const urlSide = u.includes('side=SELL') ? 'SELL' : 'BUY';
    const offset = virtualNow - ts * 1000;
    let price = 0.5;
    if (offset < 0 || ts === 0) {
      price = 0.5;
    } else if (offset >= W5 * 1000) {
      price = schedFor(ts).winner === side ? 1.0 : 0.01;
    } else if (schedFor(ts).entry && side === schedFor(ts).entry) {
      price = urlSide === 'BUY' ? askForEntry(ts, offset) : bidForEntry(ts, offset);
    } else if (schedFor(ts).entry && side !== schedFor(ts).entry) {
      price = urlSide === 'BUY' ? 0.40 : 0.35;
    }
    return new Response(JSON.stringify({ price: String(price) }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

function expectedFee(shares, price) { return shares * FEE_THETA * price * (1 - price); }
function expectedCost(dollars, price) {
  const shares = round2(dollars / price);
  const notional = round2(shares * price);
  return { shares, notional, fee: round2(expectedFee(shares, price)), cost: round2(notional + round2(expectedFee(shares, price))) };
}

(async () => {
  const states = {};
  virtualNow = Math.floor(Date.now() / (W5 * 1000)) * (W5 * 1000) + W5 * 1000;
  const engine = createEngine({
    startingCapital: 4000, entryPrice: 0.60, stopLossPrice: 0.49,
    entryDollars: 50, martingaleMultiplier: 1.5, maxMartingaleLevels: 3,
    waitSeconds5: WAIT5, windowSeconds5: W5,
    dryRun: true, tickMs: 1, priceRefreshMs: 1,
    nowFn: () => virtualNow, emit: (ev, s) => { states[ev] = s; }, slog: () => {},
  });
  await engine.start();
  await sleep(30);
  T0 = states['hedgeState:BTC-5m'].current.btc.windowTs;

  const endAt = (T0 + 4 * W5 + 60) * 1000;
  while (virtualNow < endAt) { virtualNow += 500; await sleep(1); }
  await sleep(200);

  const st5 = states['hedgeState:BTC-5m'];
  const M1 = (st5.history || []).find(h => h.betPlaced && h.stopLossCount === 0 && h.win === true);
  const M2 = (st5.history || []).find(h => h.betPlaced && h.stopLossCount >= 1 && h.win === true);

  const legLine = h => (h?.legs || []).map(l => `${l.side.toUpperCase()} $${l.dollars} @${l.price.toFixed(2)} = ${l.shares.toFixed(2)}sh cost $${l.cost.toFixed(2)}`).join(' | ');

  console.log('\n== Polymarket math check (0.60 pullback strategy) ==');
  console.log(`Rule 1 — $50 at 0.60 = ${round2(50/0.6).toFixed(2)} shares; win pays $${round2(50/0.6).toFixed(2)}`);
  console.log(`Fee rule — taker fee = shares × 0.07 × p × (1-p)`);

  console.log('\n== M1: lone $50 UP entry, no stop, winner UP ==');
  if (M1) {
    console.log('  legs:', legLine(M1));
    console.log(`  payout=${M1.payout.toFixed(2)} wager=${M1.wager.toFixed(2)} pnl=${M1.pnl.toFixed(2)} win=${M1.win}`);
  } else console.log('  (not found in history)');

  console.log('\n== M2: $50 entry + stop loss + $75 martingale, winner UP ==');
  if (M2) {
    console.log('  legs:', legLine(M2));
    console.log('  sells:', (M2.sells || []).map(x => `${x.side.toUpperCase()} ${x.shares.toFixed(2)}sh @${x.price.toFixed(2)} = $${x.proceeds.toFixed(2)}`).join(' | '));
    console.log(`  payout=${M2.payout.toFixed(2)} wager=${M2.wager.toFixed(2)} recovered=${(M2.sellProceeds||0).toFixed(2)} pnl=${M2.pnl.toFixed(2)} win=${M2.win}`);
  } else console.log('  (not found in history)');

  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  const e1 = expectedCost(50, 0.60);
  check('M1 found', !!M1);
  check('M1: shares from entry price', M1 && M1.legs[0].shares > 80 && M1.legs[0].shares < 84);
  check('M1: payout = shares x $1', M1 && Math.abs(M1.payout - M1.legs[0].shares) < 0.01);
  check('M1: cost = notional + fee', M1 && M1.wager > 50 && M1.wager < 55);
  check('M1: pnl = payout - wager', M1 && Math.abs(M1.pnl - (M1.payout - M1.wager)) < 0.01);
  check('M1: win', M1 && M1.win === true);

  check('M2 found', !!M2);
  check('M2: 2 legs (entry + 1 mart)', M2 && M2.legs.length === 2);
  check('M2: 1 stop loss', M2 && M2.sells.length === 1);
  check('M2: martingale = $75 (1.5x)', M2 && M2.legs[1].dollars === 75);
  check('M2: sold at stop loss price', M2 && Math.abs(M2.sells[0].price - 0.49) < 0.01);
  check('M2: pnl = payout + sellProceeds - wager', M2 && Math.abs(M2.pnl - (M2.payout + (M2.sellProceeds||0) - M2.wager)) < 0.5);
  check('M2: win', M2 && M2.win === true);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ MATH CHECK PASSED' : '\n❌ MATH CHECK FAILED');
  process.exit(allOk ? 0 : 1);
})();
