'use strict';
// Internal smoke test — drives the flip bot through simulated windows.
// Strategy verification (v6):
//  1. Wait WAIT_SECONDS (45s) after window start — no fire before that.
//  2. First entry: fire when ANY side.s ask ticks down to AT/BELOW 0.70 (old
//     analyzed profitable logs — may buy the cheap/losing side too). Start size = base =
//     10% of capital in shares (1000 * 0.10 / 0.70 = 142.85 -> 143).
//  3. Stop loss: held side mid <= SL_PRICE (0.50) -> sell immediately at 0.50.
//  4. Re-entry after SL: wait for ANY side's ask >= REENTRY_PRICE (0.65), fire
//     with DOUBLE shares; ceiling 0.99 is slippage-only there. Capped at
//     MAX_MARTINGALE (2) steps per window (up to 3 entries: S -> 2S -> 4S).
//     After the 3rd SL the window stops.
//  5. NO CARRY: every window starts fresh at base regardless of prior losses.

const { FlipBotEngine } = require('./engine');

const WINDOW = 300;
const WAIT = 45;
const ENTRY = 0.70;
const SL = 0.50;
const REENTRY = 0.65;
const BASE_PCT = 0.10;
const TOKEN_UP = 'token-up';
const TOKEN_DOWN = 'token-down';

let t = 1600000000000;
let step = 0;
let mode = null;
const failures = [];
function round2(v) { return Math.round(v * 100) / 100; }

function upPrice() {
  const d = step;
  if (mode === 'win') {
    if (d < 46) return 0.50;
    if (d < 250) return 0.695;                 // ENTRY @ ask 0.700 (start base)
    return 0.90;                               // hold, UP wins
  }
  if (mode === 'any-down') {
    if (d < 46) return 0.50;
    if (d < 250) return 0.35;                  // UP ask 0.355 cheap; DOWN ask 0.655 <=0.70 -> ENTRY DOWN
    return 0.26;                               // DOWN holds, DOWN wins
  }
  if (mode === 'cheap-buy') {
    if (d < 46) return 0.50;
    if (d < 250) return 0.125;                 // UP ask 0.13 cheap side -> ENTRY UP (old behavior, buys cheap leg)
    return 0.90;                               // UP wins at resolution
  }

  if (mode === 'wait-gate') {
    if (d < 46) return 0.50;
    if (d < 250) return 0.695;                 // ask 0.700 at/below after wait
    return 0.82;                               // UP wins
  }
  if (mode === 'win-at-3') {
    if (d < 46) return 0.50;
    if (d < 96) return 0.695;             // ENTRY#1 (base) @ ask 0.700
    if (d < 146) return 0.45;             // SL#1
    if (d < 196) return 0.66;             // ENTRY#2 (2x) @ 0.665
    if (d < 246) return 0.45;             // SL#2
    if (d < 296) return 0.67;             // ENTRY#3 (4x) @ 0.675
    return 0.90;                          // UP wins at resolution -> deepest before win = M2
  }
  // mode === 'all-sl': base @0.70 -> SL -> 2*base @0.65 -> SL -> 4*base @0.65 -> SL
  // (cap reached, window stops). Distinct re-entry levels avoid lastFireTick guard.
  if (d < 46) return 0.50;
  if (d < 96) return 0.695;             // ENTRY#1 (base) @ ask 0.700
  if (d < 146) return 0.45;             // SL#1 @ 0.50
  if (d < 196) return 0.66;             // ENTRY#2 (2x) @ 0.665
  if (d < 246) return 0.45;             // SL#2
  if (d < 296) return 0.67;             // ENTRY#3 (4x) @ 0.675
  return 0.45;                          // SL#3 -> cap, stop
}

function askOf(price) { return round2(price + 0.005); }

const fakeFetch = async (url) => {
  const u = String(url);
  if (u.includes('gamma-api') && u.includes('/markets?slug=')) {
    const slug = decodeURIComponent(u.split('slug=')[1]).split('&')[0];
    return { ok: true, json: async () => [{ conditionId: 'c-' + slug, question: 'BTC test', outcomes: JSON.stringify(['Up', 'Down']), clobTokenIds: JSON.stringify([TOKEN_UP, TOKEN_DOWN]), closed: false }] };
  }
  if (u.includes('/books')) {
    const up = upPrice();
    const down = round2(1 - up);
    return { ok: true, json: async () => ([
      { asset_id: TOKEN_UP, bids: [{ price: round2(up - 0.005), size: 5000 }], asks: [{ price: askOf(up), size: 5000 }] },
      { asset_id: TOKEN_DOWN, bids: [{ price: round2(down - 0.005), size: 5000 }], asks: [{ price: askOf(down), size: 5000 }] },
    ]) };
  }
  throw new Error('unexpected url ' + u);
};

function advance(sec) { for (let i = 0; i < sec; i++) { t += 1000; step += 1; } }

async function runWindow(engine, startMs, m) {
  mode = m;
  t = startMs * 1000;
  const w0 = startMs;
  step = 0;
  engine.windowStartFor = null;
  await engine.discoverWindow(w0);
  await engine.discoverWindow(w0 + WINDOW);
  let elapsedPreWait = 0;
  let startShares = null;
  for (let s = 0; s < 300; s += 2) {
    advance(2);
    await engine.pollClob();
    engine.evaluate();
    const elapsed = Math.floor(t / 1000 - w0);
    if (startShares === null) startShares = engine.baseShares;
    if (elapsed === 6) elapsedPreWait = engine.trades.filter(x => x.type === 'BUY').length;
  }
  await engine.pollClob();
  engine.evaluate();
  return { w0, elapsedPreWait, startShares };
}

async function resolve(engine, openEnd) {
  await engine.pollClob();
  t = (openEnd + 1) * 1000;
  await engine.pollClob();
  engine.evaluate();
}

async function fullScenario(name, windows) {
  const engine = new FlipBotEngine({ fetchImpl: fakeFetch, bankroll: 1000, onTick: () => {}, onLog: () => {} });
  const origNow = Date.now;
  t = 1600000000000;
  mode = null;
  Date.now = () => t;
  try {
    engine.entryWindow = 0;
    const firstW = Math.floor(t / 1000 / WINDOW) * WINDOW;
    await engine.discoverWindow(firstW);
    await engine.discoverWindow(firstW + WINDOW);
    let wStart = firstW + WINDOW;
    const starts = [];
    for (const w of windows) {
      const rw = await runWindow(engine, wStart, w.mode);
      await engine.discoverWindow(wStart);
      await resolve(engine, wStart + WINDOW);
      starts.push(rw.startShares);
      if (w.expectStart != null && rw.startShares !== w.expectStart) failures.push(`${name} W${w.i}: base ${rw.startShares} != expected ${w.expectStart}`);
      if (w.preWait != null && rw.elapsedPreWait !== w.preWait) failures.push(`${name} W${w.i}: pre-wait buys ${rw.elapsedPreWait} != expected ${w.preWait}`);
      wStart += WINDOW;
    }
    console.log(`\n── ${name} ──`);
    starts.forEach((s, i) => console.log(`  W${i + 1}: base ${s}sh`));
    console.log('  bank:', engine.bankroll.toFixed(2), '| wins:', engine.wins, '| losses:', engine.losses);
    return engine;
  } finally {
    Date.now = origNow;
  }
}

(async () => {
  const base10 = Math.max(1, Math.round(1000 * BASE_PCT / ENTRY)); // 143

  // SCENARIO 1: all SL in one window -> cap reached, no carry. Next window still base.
  {
    const e = await fullScenario('NO-CARRY (all SL, cap reached)', [
      { i: 1, mode: 'all-sl', expectStart: base10 },
      { i: 2, mode: 'all-sl', expectStart: null }, // fresh base from reduced bankroll, asserted below
    ]);
    const buys = e.trades.filter(x => x.type === 'BUY');
    // W1: base -> 2x -> 4x (from initial bankroll 1000 -> base 143)
    const w1 = buys.slice(0, 3).map(b => b.shares);
    const exp1 = [base10, base10 * 2, base10 * 4];
    if (JSON.stringify(w1) !== JSON.stringify(exp1)) failures.push(`NO-CARRY: W1 shares ${w1} != ${exp1}`);
    // W2: NO carry — starts FRESH at base recomputed from the (reduced) bankroll,
    // NOT escalated to 143->286->572. So W2 = [w2base, 2x, 4x] where w2base < base10.
    const w2 = buys.slice(3, 6).map(b => b.shares);
    const w2base = w2[0];
    if (w2base >= base10) failures.push(`NO-CARRY: W2 base ${w2base} >= W1 base ${base10} — carry/escalation must NOT happen`);
    if (JSON.stringify(w2) !== JSON.stringify([w2base, w2base * 2, w2base * 4])) failures.push(`NO-CARRY: W2 shares ${w2} not 2x-martingale from fresh base`);
    if (e.trades.filter(x => x.type === 'SELL' && x.reason === 'STOP_LOSS').length !== 6) failures.push(`NO-CARRY: expected 6 SLs, got ${e.trades.filter(x => x.type === 'SELL' && x.reason === 'STOP_LOSS').length}`);
    if (buys.length !== 6) failures.push(`NO-CARRY: expected exactly 6 buys (3 per window), got ${buys.length}`);
  }

  // SCENARIO 2: after a winning window, next window still starts fresh at base
  // (no carry, no escalation). Base recomputes from the updated bankroll.
  {
    const e = await fullScenario('NO-CARRY WIN, fresh base next', [
      { i: 1, mode: 'win', expectStart: base10 },
      { i: 2, mode: 'win', expectStart: null }, // recomputed; assert it's ~10% of new bankroll below
    ]);
    const w2Base = e.baseShares;
    const expW2 = Math.max(1, Math.round(e.bankroll * BASE_PCT / ENTRY));
    if (w2Base !== expW2) failures.push(`NO-CARRY WIN: W2 base ${w2Base} != expected ${expW2} (fresh, ~10% of bankroll)`);
  }

  // SCENARIO 3: win at the deepest martingale (entry #3) -> record M2 / 2 loses before win
  {
    const e = await fullScenario('WIN-AT-3 (deepest martingale before win)', [
      { i: 1, mode: 'win-at-3', expectStart: base10 },
    ]);
    if (e.maxDeepestBeforeWin !== 2) failures.push(`WIN-AT-3: maxDeepestBeforeWin ${e.maxDeepestBeforeWin} != 2`);
    if (e.maxConsecLosesBeforeWin !== 2) failures.push(`WIN-AT-3: maxConsecLosesBeforeWin ${e.maxConsecLosesBeforeWin} != 2`);
  }

  // SCENARIO 4: wait gate + side-agnostic
  {
    const e = await fullScenario('WAIT-GATE', [
      { i: 1, mode: 'wait-gate', expectStart: base10, preWait: 0 },
    ]);
    const buys = e.trades.filter(x => x.type === 'BUY');
    if (buys.length < 1 || buys[0].outcome !== 'UP') failures.push('WAIT-GATE: expected UP first entry');
  }
  {
    const e = await fullScenario('ANY-SIDE DOWN', [
      { i: 1, mode: 'any-down', expectStart: base10 },
    ]);
    const buys = e.trades.filter(x => x.type === 'BUY');
    if (buys.length < 1 || buys[0].outcome !== 'DOWN') failures.push('ANY-SIDE: expected DOWN first entry');
  }
  {
    const e = await fullScenario('CHEAP-BUY (old cheap-leg entry)', [
      { i: 1, mode: 'cheap-buy', expectStart: base10 },
    ]);
    const buys = e.trades.filter(x => x.type === 'BUY');
    if (buys.length < 1 || buys[0].outcome !== 'UP' || buys[0].entryPrice > 0.15) failures.push('CHEAP-BUY: expected UP cheap entry ~0.13, got ' + (buys[0] && buys[0].outcome));

  }

  console.log('\n=== SMOKE RESULT ===');
  if (failures.length) {
    failures.forEach(f => console.log('  ✗', f));
    process.exit(1);
  }
  console.log('✔ All checks passed');
})().catch(e => { console.error(e); process.exit(1); });

