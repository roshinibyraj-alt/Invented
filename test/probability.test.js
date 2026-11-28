'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { probabilityModel } = require('../probability-model');
const Feed = require('../probability-feed');
const { ProbabilityBot, entryPlan, quote } = require('../probability-bot');
const { restoreOrResetLedger } = require('../index');
const Store = require('../paper-ledger-store');
const START = 1800000000000;
const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function movement(overrides = {}) {
  const now = START + 100000;
  const price = i => 60000 + 6 * Math.sin(i * .13) + 3 * Math.cos(i * .43);
  const binance = Array.from({ length: 600 }, (_, i) => ({ at: now - (599 - i) * 1000, price: price(i) }));
  const chainlink = binance.slice(-120).map(p => ({ ...p, price: p.price + 10 }));
  return { now, end: START + 300000, beatPrice: 60010, binance, chainlink, ...overrides };
}
function fixture() {
  let now = START + 10000;
  let model = { status: 'READY', up: .7, down: .3, lowerUp: .63, lowerDown: .23, uncertaintyMargin: .07 };
  const feed = { start() {}, stop() {}, async refreshHistory() {}, async refreshReference() {},
    evaluate: () => ({ ...model, at: now }), snapshot: () => ({}) };
  const data = { getMarket: async id => ({ id }), resolvedWinner: () => 'UP' };
  const bot = new ProbabilityBot({ now: () => now, feed, marketData: data }), r = bot.records['5m'], a = bot.accounts['5m'];
  r.market = { id: 'm', slug: 'btc-updown-5m-test', title: 'BTC', start: START, end: START + 300000,
    tokens: { UP: 'u', DOWN: 'd' }, feesEnabled: true, feeSchedule: { rate: .05, exponent: 1 } };
  function book(side = 'UP', ask = .4, bid = .39, size = 500, overrides = {}) {
    r.quotes[side] = quote({ asset_id: r.market.tokens[side], timestamp: now,
      asks: [{ price: ask, size }], bids: [{ price: bid, size }], ...overrides }, r.market, side, now);
  }
  const consider = () => bot.consider('5m', now);
  function enter(side = 'UP') { book(side); consider(); now += 1000; book(side); consider(); return a.positions[0]; }
  return { bot, r, a, book, consider, enter, feed, data, get now() { return now; },
    advance(ms = 1000) { now += ms; }, setModel(x) { model = { ...model, ...x }; } };
}
test('time-aware model returns complementary, bounded probabilities using 10 minutes of changes', () => {
  const s = probabilityModel(movement());
  assert.equal(s.status, 'READY'); near(s.up + s.down, 1);
  assert.ok(s.up >= .02 && s.up <= .98); assert.ok(s.lowerUp < s.up);
  assert.ok(s.samples >= 520); assert.equal(s.scenarios.length, 3);
  assert.match(s.settlementBasis, /proxy/); assert.equal(s.observedTwapSeconds, 0);
});
test('distance to beat and seconds remaining affect probability rather than just recent direction', () => {
  const x = movement(), spot = x.chainlink.at(-1).price;
  const below = probabilityModel({ ...x, beatPrice: spot - 10 });
  const above = probabilityModel({ ...x, beatPrice: spot + 10 });
  assert.ok(below.up > above.up);
  const early = probabilityModel({ ...x, beatPrice: spot - 3 });
  const late = probabilityModel({ ...x, end: x.now + 60000, beatPrice: spot - 3 });
  assert.notEqual(early.up.toFixed(3), late.up.toFixed(3));
});
test('model never uses future observations and refuses stale or missing aligned data', () => {
  const x = movement(), original = probabilityModel(x);
  const future = probabilityModel({ ...x, binance: [...x.binance, { at: x.now + 1000, price: 1000000 }],
    chainlink: [...x.chainlink, { at: x.now + 1000, price: 1 }] });
  near(future.up, original.up);
  for (const input of [{ beatPrice: null }, { chainlink: [] },
    { binance: x.binance.slice(-60) }, { now: x.now + 15000 }])
    assert.equal(probabilityModel({ ...x, ...input }).status, 'WAITING');
});
test('final-minute probability includes already-observed TWAP samples, not just the final spot', () => {
  const x = movement({ end: START + 130000 });
  const s = probabilityModel(x);
  assert.equal(s.status, 'READY'); assert.ok(s.observedTwapSeconds >= 29);
  const noHistory = probabilityModel({ ...x, chainlink: x.chainlink.slice(-20) });
  assert.equal(noHistory.status, 'WAITING');
});
test('large cross-feed dislocation increases uncertainty rather than creating a confident bargain', () => {
  const x = movement(), baseline = probabilityModel(x);
  x.chainlink[x.chainlink.length - 1].price += 200;
  const shocked = probabilityModel(x);
  assert.ok(shocked.basisUncertaintyUsd > baseline.basisUncertaintyUsd);
});
test('mean-reversion is an evidence-weighted scenario, not a guaranteed rebound', () => {
  const s = probabilityModel(movement());
  const reversion = s.scenarios.find(x => x.name === 'Mean reversion');
  assert.ok(reversion.weight >= .1 && reversion.weight <= .25);
  assert.ok(reversion.weight < .5); assert.ok(s.uncertaintyMargin >= .06);
});
test('entry plans include per-level fees and reject prices without conservative edge', () => {
  const f = { rate: .05, exponent: 1 };
  const p = entryPlan({ asks: [{ price: .4, size: 10 }, { price: .41, size: 100 }] }, 30, .63, f);
  near(p.shares, 50); assert.ok(p.fees > 0); assert.ok(p.conservativeEdge > .03);
  assert.equal(entryPlan({ asks: [{ price: .6, size: 100 }] }, 30, .63, f), null);
  assert.equal(entryPlan({ asks: [{ price: .4, size: 4 }] }, 30, .63, f), null);
  assert.equal(entryPlan({ asks: [{ price: .4, size: 100 }] }, 30, .63, { rate: NaN, exponent: 1 }), null);
  const consumed = entryPlan({ asks: [{ price: .4, size: 0 }, { price: .41, size: 100 }] }, 30, .63, f);
  near(consumed.shares, 50); near(consumed.entryPrice, .41);
});
test('paper sizing is up to 50 shares, at most 2% settled capital, with no recovery sizing', () => {
  const f = fixture(), p = f.enter();
  near(p.shares, 50); assert.ok(p.cost + p.entryFees <= 30);
  assert.equal(f.bot.snapshot().strategy.id, 'invented-btc5m-time-aware-twap-value-v1');
  assert.equal(f.bot.snapshot().strategy.targetShares, 50);
});
test('entry waits for later exchange book and uses actual new asks, not signal price', () => {
  const f = fixture(); f.book(); f.consider(); f.advance(); f.consider();
  assert.equal(f.a.positions.length, 0);
  f.book('UP', .45, .44); f.consider();
  near(f.a.positions[0].entryPrice, .45);
});
test('entry cancels if the edge vanishes during latency or inputs become unavailable', () => {
  const f = fixture(); f.book(); f.consider(); f.advance(); f.book('UP', .68, .67); f.consider();
  assert.equal(f.a.positions.length, 0); assert.equal(f.r.pending, null);
  f.book(); f.consider(); f.advance(); f.setModel({ status: 'WAITING', reason: 'stale' }); f.book(); f.consider();
  assert.equal(f.a.positions.length, 0); assert.equal(f.r.pending, null);
});
test('DOWN enters independently when it offers the better probability-price gap', () => {
  const f = fixture(); f.setModel({ up: .3, down: .7, lowerUp: .23, lowerDown: .63 });
  const p = f.enter('DOWN'); assert.equal(p.side, 'DOWN'); near(p.shares, 50);
});
test('there is no forced trade, 94-cent trigger, fixed 90-cent stop or recovery buy', () => {
  const f = fixture(); f.book('UP', .94, .93); f.consider(); assert.equal(f.a.positions.length, 0);
  assert.match(f.r.status, /No executable/);
  assert.throws(() => f.bot.stopPosition(), /not part/);
});
test('unknown fee data, duplicate levels, future, stale and wrong token books cannot enter', () => {
  for (const invalid of [
    q => { q.exchangeAt -= 4000; }, q => { q.exchangeAt += 1; }, q => { q.tokenId = 'wrong'; },
    q => { q.asks.push({ ...q.asks[0] }); },
  ]) {
    const f = fixture(); f.book(); invalid(f.r.quotes.UP); f.consider(); assert.equal(f.r.pending, null);
  }
  const f = fixture(); f.book(); delete f.r.market.feeSchedule; f.consider(); assert.equal(f.r.pending, null);
});
test('no entry in last 20 seconds, including pending requests crossing the cutoff', () => {
  const f = fixture(); f.advance(269500); f.book(); f.consider();
  assert.ok(f.r.pending); f.advance(500); f.book(); f.consider();
  assert.equal(f.a.positions.length, 0); assert.equal(f.r.pending, null);
});
test('held position does not buy more or automatically flip when opposite side looks attractive', () => {
  const f = fixture(), p = f.enter(); f.advance(); f.book(); f.book('DOWN', .1, .09); f.consider();
  assert.equal(f.a.positions.length, 1); assert.equal(f.a.positions[0], p); assert.equal(f.r.pending, null);
});
test('model overpricing exit uses later actual bids, fees and permits a realized loss', () => {
  const f = fixture(), p = f.enter();
  f.setModel({ up: .2, down: .8, lowerUp: .13, lowerDown: .73 });
  f.advance(); f.book('UP', .35, .34); f.consider(); assert.ok(p.exitIntent);
  assert.equal(f.a.history.length, 0);
  f.advance(); f.book('UP', .31, .30); f.consider();
  assert.equal(p.status, 'MODEL_EXIT'); near(p.exitPrice, .30); assert.ok(p.pnl < 0);
  near(f.a.cash, 1500 + p.pnl); near(p.pnl, p.proceeds - p.cost - p.entryFees);
});
test('a profitable bid above fair value exits instead of requiring a fixed TP', () => {
  const f = fixture(), p = f.enter(); f.setModel({ up: .6, lowerUp: .53 });
  f.advance(); f.book('UP', .82, .81); f.consider();
  f.advance(); f.book('UP', .80, .79); f.consider();
  assert.equal(p.status, 'MODEL_EXIT'); assert.ok(p.pnl > 0); near(p.exitPrice, .79);
});
test('missing model does not invent a stop or zero valuation', () => {
  const f = fixture(); f.enter(); f.advance(); f.setModel({ status: 'WAITING', reason: 'feed stale' });
  f.book('UP', .2, .19); f.consider();
  assert.equal(f.a.positions.length, 1); assert.match(f.r.status, /Model inputs unavailable/);
  f.advance(6000); assert.equal(f.bot.snapshot().accounts['5m'].equity, null);
});
test('partial market exits cannot reuse unchanged visible liquidity and reconcile correctly', () => {
  const f = fixture(), p = f.enter(); f.setModel({ up: .2, lowerUp: .13 });
  f.advance(); f.book('UP', .4, .39, 10); f.consider();
  f.advance(); f.book('UP', .4, .39, 10); f.consider(); near(p.shares, 40);
  f.advance(); f.book('UP', .4, .39, 10); f.consider(); near(p.shares, 40);
  f.advance(); f.book('UP', .4, .39, 50); f.consider();
  assert.equal(p.status, 'MODEL_EXIT'); near(p.sales.reduce((s, x) => s + x.shares, 0), 50);
  near(f.a.cash, 1500 + p.pnl);
});
test('cooldown prevents immediate reverse entries; later opposite purchases require their own edge', () => {
  const f = fixture(); f.enter(); f.setModel({ up: .2, down: .8, lowerUp: .13, lowerDown: .73 });
  f.advance(); f.book('UP', .4, .39); f.consider(); f.advance(); f.book('UP', .4, .39); f.consider();
  f.book('DOWN'); f.consider(); assert.equal(f.r.pending, null);
  f.advance(15000); f.book('DOWN'); f.consider(); assert.equal(f.r.pending.side, 'DOWN');
});
test('global open-cost budget counts unresolved positions and never borrows cash', () => {
  const f = fixture(); const p = f.enter();
  f.a.positions.push({ ...p, id: 'old', windowStart: START - 300000, cost: 50, entryFees: 0 });
  const budget = f.bot.riskBudget(f.a); assert.ok(budget < 6);
  f.a.cash = 0; assert.equal(f.bot.riskBudget(f.a), 0);
});
test('window entry limit blocks a fourth purchase without forcing a fallback', () => {
  const f = fixture(); f.book();
  f.a.history = Array.from({ length: 3 }, (_, i) => ({ id: String(i), windowStart: START, pnl: 1 }));
  f.consider(); assert.equal(f.r.pending, null); assert.match(f.r.status, /Three-entry/);
});
test('unchanged consumed ask size cannot be reused on another purchase', () => {
  const f = fixture(); f.enter();
  const depth = f.r.entryDepths.UP.levels['0.4']; near(depth.available, 450);
  // Simulate no new liquidity at that price; a new timestamp alone is not replenishment.
  depth.available = 0; f.a.positions = []; f.advance(16000); f.book(); f.consider();
  assert.equal(f.r.pending, null); near(f.r.entryDepths.UP.levels['0.4'].available, 0);
  f.advance(); f.book('UP', .4, .39, 550); f.consider();
  assert.equal(f.r.pending.side, 'UP');
});
test('official settlement pays only remaining shares once and includes prior sale fees', async () => {
  const f = fixture(), p = f.enter(); f.setModel({ up: .2, lowerUp: .13 });
  f.advance(); f.book('UP', .4, .39, 10); f.consider();
  f.advance(); f.book('UP', .4, .39, 10); f.consider(); near(p.shares, 40);
  const netSold = p.proceeds;
  f.advance(300000); await f.bot.settle(f.now);
  assert.equal(p.status, 'RESOLVED'); near(p.payout, 40 + netSold); near(f.a.cash, 1500 + p.pnl);
  const cash = f.a.cash; f.advance(11000); await f.bot.settle(f.now); near(f.a.cash, cash);
});
test('official losing settlement is zero, never a modeled $1 credit at a 99-cent mark', async () => {
  const f = fixture(), p = f.enter(); f.data.resolvedWinner = () => 'DOWN';
  f.advance(300000); await f.bot.settle(f.now);
  near(p.payout, 0); near(p.pnl, -p.cost - p.entryFees);
});
test('restart restores open positions/cash and partial sales without duplicate fills', () => {
  const f = fixture(), p = f.enter(); f.setModel({ up: .2, lowerUp: .13 });
  f.advance(); f.book('UP', .4, .39, 10); f.consider();
  f.advance(); f.book('UP', .4, .39, 10); f.consider();
  const saved = structuredClone({ strategyId: ProbabilityBot.STRATEGY.id, accounts: f.bot.accounts, events: [], tradeSequence: 1 });
  const g = fixture(); g.advance(f.now - g.now); g.bot.restoreLedger(saved);
  g.setModel({ up: .2, lowerUp: .13 }); g.advance(); g.book('UP', .4, .39, 10); g.consider();
  near(g.a.cash, 1500); // fixture reference is replaced on restore; restored account checked below.
  near(g.bot.accounts['5m'].positions[0].shares, 40);
  near(g.bot.accounts['5m'].cash, f.a.cash);
  const bad = structuredClone(saved); bad.accounts['5m'].cash += 1;
  assert.throws(() => g.bot.restoreLedger(bad), /reconciliation/);
  assert.ok(p.shares < 50);
});
test('strategy replacement archives old ledger and resets once; restart preserves new history', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probability-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'ledger.json')), f = fixture(); f.bot.ledgerStore = store;
  const old = { strategyId: 'invented-btc5m-ask94-flat300-stop90-v1', accounts: {} };
  await store.save(old);
  assert.equal(await restoreOrResetLedger(f.bot, old, ProbabilityBot.STRATEGY.id), 'reset');
  near(store.load().accounts['5m'].cash, 1500); assert.ok(fs.readdirSync(dir).length >= 2);
  f.enter(); await f.bot.flushLedger();
  const g = fixture(); g.bot.ledgerStore = store;
  assert.equal(await restoreOrResetLedger(g.bot, store.load(), ProbabilityBot.STRATEGY.id), 'restored');
  near(g.bot.accounts['5m'].cash, f.a.cash); assert.equal(g.bot.accounts['5m'].positions.length, 1);
});
test('feed accepts only matching BTC Chainlink frames, filters future points and stops cleanly', () => {
  const feed = new Feed({ now: () => START });
  feed.ingest({ topic: 'crypto_prices_chainlink', payload: { symbol: 'eth/usd', timestamp: START, value: 100 } });
  feed.ingest({ topic: 'crypto_prices_chainlink', payload: { symbol: 'btc/usd', timestamp: START + 1, value: 100 } });
  assert.equal(feed.chainlink.length, 0);
  feed.ingest({ topic: 'crypto_prices', type: 'subscribe', payload: { symbol: 'btc/usd',
    data: [{ timestamp: START - 1000, value: 60000 }, { timestamp: START, value: 60001 }] } });
  assert.equal(feed.chainlink.length, 2); feed.stop();
});
test('feed validates official TWAP rules, reference identity and history freshness', async () => {
  const requests = [];
  const feed = new Feed({ now: () => START + 10000, fetchImpl: async url => {
    requests.push(String(url)); return { ok: true, json: async () => ({ openPrice: 60000, timestamp: START + 5000 }) };
  } });
  const m = { start: START, end: START + 300000, raw: { description: 'Chainlink time-weighted average TWAP',
    resolutionSource: 'https://data.chain.link/streams/btc-usd-twap-60s-streams' } };
  await feed.refreshReference(m);
  near(feed.reference.price, 60000); assert.match(requests[0], /eventStartTime=/);
  feed.reference = null; feed.nextReference = 0;
  await feed.refreshReference({ ...m, raw: { description: 'Last Binance spot price' } });
  assert.equal(feed.reference, null); assert.match(feed.referenceError, /Unsupported settlement/);
});
test('history refresh merges small incremental requests without losing its ten-minute context', async () => {
  let now = START, limit;
  const feed = new Feed({ now: () => now, fetchImpl: async url => {
    limit = new URL(url).searchParams.get('limit');
    const count = Number(limit);
    return { ok: true, json: async () => Array.from({ length: count }, (_, i) =>
      [0, 0, 0, 0, '60000', 0, now - (count - i) * 1000]) };
  } });
  await feed.refreshHistory(); assert.equal(limit, '650'); assert.equal(feed.binance.length, 650);
  now += 5000; await feed.refreshHistory();
  assert.equal(limit, '15'); assert.ok(feed.binance.length >= 645);
});
test('production refresh runs the model path, not the removed 94-cent logic', async () => {
  const f = fixture();
  const market = f.r.market;
  f.data.getBtcMarket = async () => market;
  f.data.getBook = async token => ({ asset_id: token, timestamp: f.now,
    bids: [{ price: '.39', size: '500' }], asks: [{ price: '.40', size: '500' }] });
  await f.bot.refresh('5m', f.now); assert.equal(f.r.pending.side, 'UP');
  f.advance(); await f.bot.refresh('5m', f.now);
  assert.equal(f.a.positions.length, 1); near(f.a.positions[0].shares, 50);
});
