'use strict';

const { createEngine } = require('./engine-factory');

const W5 = 300, WAIT5 = 2;
const STEP = 500; // advance 500ms per tick (fast-forward)
const sleep = ms => new Promise(r => setTimeout(r, ms));
let virtualNow = Date.now(), T0 = 0;

// stopLosses: seconds AFTER wait ends when price crashes.
// entryHoldMs: how long price stays above 0.60 for momentum confirmation.
const SCRIPTS_5 = [
  { entry: 'up', entryHoldMs: 4000, stopLosses: [], winner: 'up' },
  { entry: 'up', entryHoldMs: 4000, stopLosses: [10], winner: 'down' },
  { entry: null, entryHoldMs: 0, stopLosses: [], winner: 'up' },
  { entry: 'up', entryHoldMs: 4000, stopLosses: [10], winner: 'up' },
  { entry: 'up', entryHoldMs: 4000, stopLosses: [10, 30], winner: 'down' },
  { entry: 'up', entryHoldMs: 4000, stopLosses: [10], winner: 'down' },
  { entry: 'up', entryHoldMs: 4000, stopLosses: [], winner: 'up' },
  { entry: null, entryHoldMs: 0, stopLosses: [], winner: 'up' },
];

function scriptFor(ts) {
  const idx = Math.floor(ts / W5);
  return SCRIPTS_5[((idx % SCRIPTS_5.length) + SCRIPTS_5.length) % SCRIPTS_5.length];
}

function entrySideMid(ts, offsetMs) {
  const s = scriptFor(ts);
  if (!s || !s.entry || s.entryHoldMs == null) return 0.50;
  const waitMs = WAIT5 * 1000;
  if (offsetMs < waitMs) return 0.55;
  return 0.62;
}

function oppSideMid(ts, offsetMs) {
  const s = scriptFor(ts);
  if (!s || !s.entry) return 0.50;
  const waitMs = WAIT5 * 1000;
  if (offsetMs < waitMs) return 0.45;
  const sinceWait = offsetMs - waitMs;
  for (const sl of (s.stopLosses || [])) {
    if (sinceWait >= sl * 1000) return 0.62;
  }
  return 0.38;
}

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('gamma-api.polymarket.com/markets') && !u.includes('condition_ids')) {
    const m = u.match(/slug=btc-updown-5m-(\d+)/);
    const ts = m ? Number(m[1]) : 0;
    return new Response(JSON.stringify({
      conditionId: `cond-5-${ts}`, outcomes: '["Up","Down"]',
      clobTokenIds: `["u5-${ts}","d5-${ts}"]`,
    }), { status: 200 });
  }
  if (u.includes('gamma-api.polymarket.com/events')) {
    const m = u.match(/slug=btc-updown-5m-(\d+)/);
    const ts = m ? Number(m[1]) : T0;
    return new Response(JSON.stringify([{ markets: [{ conditionId: `cond-5-${ts}`, outcomes: '["Up","Down"]', clobTokenIds: `["u5-${ts}","d5-${ts}"]` }] }]), { status: 200 });
  }
  if (u.includes('gamma-api.polymarket.com/markets') && u.includes('condition_ids')) {
    const m = u.match(/condition_ids=cond-5-(\d+)/);
    const ts = m ? Number(m[1]) : T0;
    const w = scriptFor(ts).winner;
    return new Response(JSON.stringify([{
      conditionId: `cond-5-${ts}`, closed: true,
      outcomes: '["Up","Down"]', clobTokenIds: `["u5-${ts}","d5-${ts}"]`,
      outcomePrices: w === 'up' ? '[ "1.0", "0.0" ]' : '[ "0.0", "1.0" ]',
    }]), { status: 200 });
  }
  if (u.includes('clob.polymarket.com/midpoint')) {
    const m = u.match(/token_id=(u|d)5-(\d+)/);
    const ts = m ? Number(m[2]) : T0;
    const side = m && m[1] === 'u' ? 'up' : 'down';
    const s = scriptFor(ts);
    let mid = 0.50;
    if (virtualNow >= (ts + W5) * 1000) {
      mid = s.winner === side ? 1.0 : 0.01;
    } else if (s.entry) {
      const offset = virtualNow - ts * 1000;
      if (side === s.entry) {
        mid = entrySideMid(ts, offset);
        const waitMs = WAIT5 * 1000;
        const sinceWait = offset - waitMs;
        for (const sl of (s.stopLosses || [])) {
          const slMs = sl * 1000;
          if (sinceWait >= slMs && sinceWait < slMs + 500) mid = 0.40;
        }
      } else {
        mid = oppSideMid(ts, offset);
      }
    }
    return new Response(JSON.stringify({ mid: String(mid) }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

(async () => {
  const states = {};
  virtualNow = Math.floor(Date.now() / (W5 * 1000)) * (W5 * 1000) + W5 * 1000;
  const engine = createEngine({
    label: 'BTC-5m',
    startingCapital: 4000, entryPrice: 0.60, stopLossPrice: 0.49,
    entryDollars: 50, martingaleMultiplier: 1.5, maxMartingaleLevels: 3,
    waitSeconds5: WAIT5, windowSeconds5: W5,
    dryRun: true, tickMs: 1, priceRefreshMs: 1,
    nowFn: () => virtualNow, emit: (ev, s) => { states[ev] = s; }, slog: () => {},
  });
  await engine.start();
  await sleep(30);
  T0 = states['hedgeState:BTC-5m'].current.btc.windowTs;

  // Fast-forward: 8 windows + 30s buffer
  const endAt = (T0 + 8 * W5 + 30) * 1000;
  while (virtualNow < endAt) { virtualNow += STEP; await sleep(1); }
  await sleep(50);

  const st5 = states['hedgeState:BTC-5m'];
  const round2 = n => Math.round(n * 100) / 100;
  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  const h5 = st5.history || [];
  check('5m: has no-entry windows', h5.filter(h => !h.betPlaced).length >= 1);
  check('5m: has entry-win windows', h5.filter(h => h.betPlaced && h.win === true).length >= 1);
  check('5m: has stop-loss windows', h5.filter(h => h.betPlaced && h.stopLossCount >= 1).length >= 1);
  check('5m: has multi-stop windows', h5.filter(h => h.stopLossCount >= 2).length >= 1);
  const scalesCorrectly = h5.filter(h => h.legs.length >= 3).every(h => {
    for (let i = 1; i < h.legs.length; i++) { if (h.legs[i].dollars <= h.legs[i - 1].dollars) return false; }
    return true;
  });
  check('5m: martingale amounts scale (1.5x)', scalesCorrectly);
  check('stop-loss sells recover positive capital', h5.filter(h => h.sells && h.sells.length > 0).every(h => h.sells.every(x => x.proceeds > 0)));
  check('5m win rate consistent', st5.windowsDecided > 0 && st5.winRate === round2(st5.wins / st5.windowsDecided));
  check('5m windowsDecided = wins + losses', st5.windowsDecided === st5.wins + st5.losses);
  const openCost5 = (st5.current.btc ? st5.current.btc.totalCost : 0);
  check('5m bankroll consistent', Math.abs(st5.bankroll - (4000 + st5.realizedPnl - openCost5)) < 0.01);
  check('equity curve has points', st5.equityCurve.length >= 3);
  check('max drawdown >= 0', st5.maxDrawdown.pct >= 0);
  check('max drawdown <= 100%', st5.maxDrawdown.pct <= 1);
  const allEntriesBelowCap = h5.filter(h => h.betPlaced).every(h =>
    h.legs.every(l => l.price <= 0.651)
  );
  check('5m: all entry prices <= 0.65', allEntriesBelowCap);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ SMOKE TEST PASSED' : '\n❌ SMOKE TEST FAILED');
  process.exit(allOk ? 0 : 1);
})();
