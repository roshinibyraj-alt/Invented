'use strict';

/**
 * Full-window smoke test for the BTC 5m 0.60 martingale engine.
 * Real-sized 5m windows (300s, 60s wait) on a virtual clock.
 *
 * Window A (t0):     entry UP, 1 stop loss + 1 martingale re-entry, win
 * Window B (t0+300): no entry (side never reaches 0.60+)
 * Window C (t0+600): entry UP, 2 stop losses + 2 martingale re-entries, loss
 * Window D (t0+900): entry UP, no stop loss, win
 * Window E (t0+1200): entry UP, 1 stop loss + 1 martingale re-entry, loss
 */

const { createEngine } = require('./engine-factory');

const W5 = 300, WAIT5 = 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let virtualNow = 0, T0 = 0;

const SCHEDULE_5 = [
  { offset: 0,    entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [90], winner: 'up' },
  { offset: 300,  entry: null, highAfterMs: null, gapMs: 3000, stopLosses: [], winner: 'up' },
  { offset: 600,  entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [90, 160], winner: 'down' },
  { offset: 900,  entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [], winner: 'up' },
  { offset: 1200, entry: 'up', highAfterMs: 70, gapMs: 3000, stopLosses: [90], winner: 'down' },
];

function schedLookup(ts) {
  for (const s of SCHEDULE_5) if (s.offset !== undefined && ts === T0 + s.offset) return s;
  return { entry: null, highAfterMs: null, gapMs: 3000, stopLosses: [], winner: 'up' };
}

function askForSide(ts, offsetMs) {
  const s = schedLookup(ts);
  if (!s.entry || s.highAfterMs == null) return 0.50;
  const highAt = WAIT5 * 1000 + s.highAfterMs * 1000;
  if (offsetMs < highAt) return 0.55;
  if (offsetMs < highAt + (s.gapMs || 3000)) return 0.62;
  return 0.60;
}

function bidForSide(ts, offsetMs) {
  const s = schedLookup(ts);
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
    const limit = u.includes('limit=500') ? 500 : 5;
    const intervalSec = 5 * 60;
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
    const m = u.match(/slug=btc-updown-5m-(\d+)/);
    const ts = m ? Number(m[1]) : T0;
    return new Response(JSON.stringify([{ markets: [{ conditionId: `cond-5-${ts}`, outcomes: '["Up","Down"]', clobTokenIds: `["u5-${ts}","d5-${ts}"]` }] }]), { status: 200 });
  }
  if (u.includes('gamma-api.polymarket.com/markets')) {
    const m = u.match(/condition_ids=cond-5-(\d+)/);
    const ts = m ? Number(m[1]) : T0;
    const w = schedLookup(ts).winner;
    return new Response(JSON.stringify([{ conditionId: `cond-5-${ts}`, closed: true, outcomes: '["Up","Down"]', clobTokenIds: `["u5-${ts}","d5-${ts}"]`, outcomePrices: w === 'up' ? '[ "1.0", "0.0" ]' : '[ "0.0", "1.0" ]' }]), { status: 200 });
  }
  if (u.includes('clob.polymarket.com/price')) {
    const m = u.match(/token_id=(u|d)5-(\d+)/);
    const ts = m ? Number(m[2]) : T0;
    const side = m && m[1] === 'u' ? 'up' : 'down';
    const s = schedLookup(ts);
    const urlSide = u.includes('side=SELL') ? 'SELL' : 'BUY';
    let price = 0.5;
    if (virtualNow >= (ts + W5) * 1000) {
      price = s.winner === side ? 1.0 : 0.01;
    } else if (s.entry && side === s.entry) {
      const offset = virtualNow - ts * 1000;
      if (urlSide === 'BUY') price = askForSide(ts, offset);
      else price = bidForSide(ts, offset);
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
    waitSeconds5: WAIT5, windowSeconds5: W5,
    dryRun: true, tickMs: 1, priceRefreshMs: 1,
    nowFn: () => virtualNow, emit: (ev, s) => { states[ev] = s; }, slog: () => {},
  });
  await engine.start();
  await sleep(30);
  T0 = states['hedgeState:BTC-5m'].current.btc.windowTs;

  const endAt = (T0 + 5 * W5 + 30) * 1000;
  while (virtualNow < endAt) { virtualNow += 500; await sleep(1); }
  await sleep(50);

  const st5 = states['hedgeState:BTC-5m'];
  const byTs5 = new Map((st5.history || []).map(h => [h.windowTs, h]));
  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  const A = byTs5.get(T0);
  const B = byTs5.get(T0 + W5);
  const C = byTs5.get(T0 + 2 * W5);
  const D = byTs5.get(T0 + 3 * W5);
  const E = byTs5.get(T0 + 4 * W5);

  const fmt = h => h ? `${h.betPlaced ? h.entrySide.toUpperCase() : 'NONE'} ${h.legs.length}legs sl:${h.stopLossCount} ${h.win === true ? 'WIN' : h.win === false ? 'LOSS' : '?'} $${h.pnl?.toFixed(2)}` : 'MISSING';
  console.log(`A: ${fmt(A)}`);
  console.log(`B: ${fmt(B)}`);
  console.log(`C: ${fmt(C)}`);
  console.log(`D: ${fmt(D)}`);
  console.log(`E: ${fmt(E)}`);

  check('A: entry + martingale re-entry (2+ legs)', A && A.betPlaced && A.legs.length >= 2);
  check('A: 1 stop loss', A && A.stopLossCount >= 1);
  check('A: win', A && A.win === true);
  check('A: pnl = payout + sellProceeds - wager', A && Math.abs(A.pnl - (A.payout + A.sellProceeds - A.wager)) < 0.02);

  check('B: no bet placed', B && !B.betPlaced);

  check('C: 2+ stops', C && C.stopLossCount >= 2);
  check('C: loss', C && C.win === false);

  check('D: entry, no stop, win', D && D.betPlaced && D.stopLossCount === 0 && D.win === true);

  check('E: 1 stop', E && E.stopLossCount >= 1);
  check('E: loss', E && E.win === false);

  const scales = (st5.history || []).filter(h => h.legs.length >= 3)
    .every(h => h.legs[1].dollars > h.legs[0].dollars && h.legs[2].dollars > h.legs[1].dollars);
  check('martingale amounts scale (1.5x)', scales);

  const openCost5 = st5.current.btc ? st5.current.btc.totalCost : 0;
  check('5m bankroll consistent', Math.abs(st5.bankroll - (4000 + st5.realizedPnl - openCost5)) < 0.01);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ FULL-WINDOW SMOKE TEST PASSED' : '\n❌ FULL-WINDOW SMOKE TEST FAILED');
  process.exit(allOk ? 0 : 1);
})();
