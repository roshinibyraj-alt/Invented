'use strict';

const { createEngine } = require('./engine-factory');

const W5 = 12, WAIT5 = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let virtualNow = Date.now(), T0 = 0;

// Scripts define: which side enters, when stop losses hit, who wins.
// stopLosses are seconds AFTER the wait period ends.
const SCRIPTS_5 = [
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [3.5, 5.5, 7], winner: 'down' },
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [], winner: 'up' },
  { entry: null, highAfterMs: null, gapMs: 1500, stopLosses: [], winner: 'up' },
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [3.5], winner: 'up' },
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [3.5, 5.5], winner: 'down' },
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [3.5], winner: 'down' },
  { entry: 'up', highAfterMs: 1, gapMs: 1500, stopLosses: [], winner: 'up' },
  { entry: null, highAfterMs: null, gapMs: 1500, stopLosses: [], winner: 'up' },
];

function scriptFor(ts) {
  const idx = Math.floor(ts / W5);
  return SCRIPTS_5[((idx % SCRIPTS_5.length) + SCRIPTS_5.length) % SCRIPTS_5.length];
}

// Midpoint for the entry side based on time into the window
function entrySideMid(ts, offsetMs) {
  const s = scriptFor(ts);
  if (!s || !s.entry || s.highAfterMs == null) return 0.50;
  const waitMs = WAIT5 * 1000;
  const highAt = waitMs + s.highAfterMs * 1000;
  if (offsetMs < highAt) return 0.55;
  if (offsetMs < highAt + (s.gapMs || 3000)) return 0.62;
  // After gap: price recovers to 0.62 (above entry threshold) for martingale re-entries
  return 0.62;
}

global.fetch = async (url) => {
  const u = String(url);

  // Gamma markets lookup (used by discoverLeg)
  if (u.includes('gamma-api.polymarket.com/markets') && !u.includes('condition_ids')) {
    const m = u.match(/slug=btc-updown-5m-(\d+)/);
    const ts = m ? Number(m[1]) : 0;
    return new Response(JSON.stringify({
      conditionId: `cond-5-${ts}`,
      outcomes: '["Up","Down"]',
      clobTokenIds: `["u5-${ts}","d5-${ts}"]`,
    }), { status: 200 });
  }
  // Gamma events fallback
  if (u.includes('gamma-api.polymarket.com/events')) {
    const m = u.match(/slug=btc-updown-5m-(\d+)/);
    const ts = m ? Number(m[1]) : T0;
    return new Response(JSON.stringify([{ markets: [{ conditionId: `cond-5-${ts}`, outcomes: '["Up","Down"]', clobTokenIds: `["u5-${ts}","d5-${ts}"]` }] }]), { status: 200 });
  }
  // Gamma markets by condition_id (resolution check)
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
  // CLOB midpoint (primary price source)
  if (u.includes('clob.polymarket.com/midpoint')) {
    const m = u.match(/token_id=(u|d)5-(\d+)/);
    const ts = m ? Number(m[2]) : T0;
    const side = m && m[1] === 'u' ? 'up' : 'down';
    const s = scriptFor(ts);
    let mid = 0.50;
    if (virtualNow >= (ts + W5) * 1000) {
      // Window closed — resolve
      mid = s.winner === side ? 1.0 : 0.01;
    } else if (s.entry && side === s.entry) {
      const offset = virtualNow - ts * 1000;
      mid = entrySideMid(ts, offset);
      // Stop loss: price crashes below 0.49 for 0.5s, then recovers
      const waitMs = WAIT5 * 1000;
      for (const sl of (s.stopLosses || [])) {
        const slOffsetMs = waitMs + sl * 1000;
        if (offset >= slOffsetMs && offset < slOffsetMs + 500) {
          mid = 0.40; // price crashes — stop loss fires
        }
        // After 500ms of crash, price recovers to 0.62 for martingale re-entry
      }
    } else if (s.entry && side !== s.entry) {
      mid = 0.40; // opposite side always low
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

  const endAt = (T0 + 8 * W5 + 30) * 1000;
  while (virtualNow < endAt) { virtualNow += 100; await sleep(1); }
  await sleep(50);

  const st5 = states['hedgeState:BTC-5m'];
  const round2 = n => Math.round(n * 100) / 100;
  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  const h5 = st5.history || [];
  check('5m: has no-entry windows', h5.filter(h => !h.betPlaced).length >= 1);
  check('5m: has entry-no-stop-win windows', h5.filter(h => h.betPlaced && h.stopLossCount === 0 && h.win === true).length >= 1);
  check('5m: has stop-loss windows', h5.filter(h => h.betPlaced && h.stopLossCount >= 1).length >= 1);
  check('5m: has multi-stop windows', h5.filter(h => h.stopLossCount >= 2).length >= 1);
  const scalesCorrectly = h5.filter(h => h.legs.length >= 3).every(h => {
    for (let i = 1; i < h.legs.length; i++) { if (h.legs[i].dollars <= h.legs[i - 1].dollars) return false; }
    return true;
  });
  check('5m: martingale amounts scale (1.5x)', scalesCorrectly);
  check('stop-loss sells recover positive capital', h5.filter(h => h.sells && h.sells.length > 0).every(h => h.sells.every(x => x.proceeds > 0)));
  check('5m max-martingale counter >= 1', st5.windowsReachedMaxMartingale >= 1);
  check('5m win rate consistent', st5.windowsDecided > 0 && st5.winRate === round2(st5.wins / st5.windowsDecided));
  check('5m windowsDecided = wins + losses', st5.windowsDecided === st5.wins + st5.losses);
  const openCost5 = (st5.current.btc ? st5.current.btc.totalCost : 0);
  check('5m bankroll consistent', Math.abs(st5.bankroll - (4000 + st5.realizedPnl - openCost5)) < 0.01);
  check('equity curve has points', st5.equityCurve.length >= 3);
  check('max drawdown >= 0', st5.maxDrawdown.pct >= 0);
  check('max drawdown <= 100%', st5.maxDrawdown.pct <= 1);

  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? '\n✅ SMOKE TEST PASSED' : '\n❌ SMOKE TEST FAILED');
  process.exit(allOk ? 0 : 1);
})();
