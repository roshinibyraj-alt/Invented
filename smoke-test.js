'use strict';

const { createEngine } = require('./engine-factory');

const W5 = 12, WAIT5 = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let virtualNow = Date.now(), T0 = 0;

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

// Track ALL known token IDs so we can always feed prices
const knownTokens = new Set();

function tokenPrices(tokenId) {
  const m = tokenId.match(/(u|d)5-(\d+)/);
  if (!m) return { bid: 0.50, ask: 0.50 };
  const ts = Number(m[2]), tokSide = m[1] === 'u' ? 'up' : 'down';
  const s = scriptFor(ts);
  let ask = 0.50, bid = 0.50;
  if (virtualNow >= (ts + W5) * 1000) {
    ask = bid = s.winner === tokSide ? 1.0 : 0.01;
  } else if (s.entry && tokSide === s.entry) {
    const offset = virtualNow - ts * 1000;
    const waitMs = WAIT5 * 1000;
    const highAt = waitMs + s.highAfterMs * 1000;
    if (offset < highAt) ask = 0.55;
    else if (offset < highAt + (s.gapMs || 3000)) ask = 0.62;
    else ask = 0.60;
    bid = 0.50;
    for (const sl of s.stopLosses) { if (offset >= waitMs + sl * 1000) bid = 0.40; }
  } else if (s.entry && tokSide !== s.entry) {
    ask = 0.40; bid = 0.35;
  }
  return { bid, ask };
}

function feedAllPrices(engine, states) {
  // Also scan state for any new token IDs
  const st = states['hedgeState:BTC-5m'];
  if (st) {
    const all = [st.current?.btc, ...(st.pending || [])].filter(Boolean);
    for (const t of all) {
      if (t.leg && t.leg.discovered) {
        if (t.leg.upTokenId) knownTokens.add(t.leg.upTokenId);
        if (t.leg.downTokenId) knownTokens.add(t.leg.downTokenId);
      }
    }
  }
  // Feed ALL known tokens
  for (const tok of knownTokens) {
    engine.updateLegPrice(tok, tokenPrices(tok));
  }
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
      const o = 60000 + (i % 9) * 10;
      rows.push([openTime, String(o), String(o + 25), String(o - 15), String(o + 10), '100', closeTime, '1', '1', '1', '1', '1']);
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
    const w = scriptFor(ts).winner;
    return new Response(JSON.stringify([{
      conditionId: `cond-5-${ts}`, closed: true,
      outcomes: '["Up","Down"]', clobTokenIds: `["u5-${ts}","d5-${ts}"]`,
      outcomePrices: w === 'up' ? '[ "1.0", "0.0" ]' : '[ "0.0", "1.0" ]',
    }]), { status: 200 });
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
    dryRun: true, tickMs: 1,
    nowFn: () => virtualNow, emit: (ev, s) => { states[ev] = s; }, slog: () => {},
  });
  await engine.start();
  await sleep(30);
  T0 = states['hedgeState:BTC-5m'].current.btc.windowTs;

  const endAt = (T0 + 8 * W5 + 30) * 1000;
  while (virtualNow < endAt) {
    virtualNow += 100;
    feedAllPrices(engine, states);
    await sleep(1);
  }
  feedAllPrices(engine, states);
  await sleep(200);
  feedAllPrices(engine, states);
  await sleep(100);

  const st5 = states['hedgeState:BTC-5m'];
  const round2 = n => Math.round(n * 100) / 100;
  const checks = [];
  const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

  const h5 = st5.history || [];
  console.log('Total windows decided:', st5.windowsDecided, 'History:', h5.length);
  for (const h of h5) {
    console.log('  ' + h.slug + ' bet=' + h.betPlaced + ' legs=' + h.legs.length + ' sl=' + h.stopLossCount + ' win=' + h.win + ' pnl=' + h.pnl);
  }

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
