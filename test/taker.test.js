'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// Optional second directory exercises both deployed adapters with identical cases.
for (const dir of JSON.parse(process.env.TAKER_BOT_DIRS || '[".."]')) {
  const root = path.resolve(__dirname, dir);
  const Bot = require(path.join(root, 'freqai-taker-btc-bot'));
  const { restoreOrResetLedger } = require(path.join(root, 'index'));
  const label = Bot.STRATEGY.id;
  function fixture(capital = 3000) {
    const start = 1800000000000; let now = start + 60000;
    let raw = { windowStart: start, candleStart: start, candleCloseAt: now,
      writtenAt: now, pUp: .75, pDown: .25, model: 'LightGBMClassifier' };
    const bot = new Bot({ initialCapital: capital, now: () => now, marketData: {},
      freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: raw }) } });
    const record = bot.records.get('BTC:5m');
    record.marketStatus = 'OPEN';
    record.market = { id: 'market', slug: 'btc-test', start, end: start + 300000,
      tokens: { UP: 'up', DOWN: 'down' }, feeSchedule: { rate: .05 } };
    const book = (side = 'UP', levels = [{ price: .4, size: 1000 }],
      bids = [{ price: .3, size: 1000 }]) => {
      record.quotes[side] = { updatedAt: now, tokenId: side.toLowerCase(), marketId: 'market',
        windowStart: record.market.start, bestAsk: levels[0]?.price ?? null,
        bestBid: bids[0]?.price ?? null, asks: levels, bids };
    };
    book(); book('DOWN');
    return { bot, record, start, book, time: t => { now = t; }, now: () => now,
      score: (up, fields = {}) => { raw = { ...raw, pUp: up, pDown: 1 - up,
        windowStart: start, candleStart: start, candleCloseAt: now, writtenAt: now, ...fields }; },
      check: () => bot.processSide(record, 'UP', record.quotes.UP, 1),
      trades: () => bot.shadowEntries || bot.positions,
      orders: () => bot.snapshot().shadowTakerOrders || bot.orders,
      account: () => bot.snapshot().shadowAccount || bot.accountSnapshot(),
    };
  }

  test(label + ': buys 100 shares with a best ask below 0.50 and charges taker fees', () => {
    const f = fixture(); f.book('UP', [{ price: .45, size: 70 }, { price: .4, size: 30 }]);
    f.check();
    const p = f.trades()[0], o = f.orders()[0];
    assert.equal(p.shares, 100); assert.ok(Math.abs(p.entryPrice - .435) < 1e-10);
    assert.ok(Math.abs(p.totalCost - 43.5) < 1e-10);
    assert.ok(Math.abs(p.fees - 1.22625) < 1e-10);
    assert.ok(Math.abs(f.account().cash - 2955.27375) < 1e-8);
    assert.equal(o.execution, 'TAKER'); assert.equal(o.remainingShares, 0);
    assert.equal(f.bot.snapshot().takerOrderSummary.reservedCash, 0);
    assert.equal(f.bot.snapshot().restingOrderSummary, undefined);
  });

  test(label + ': strict above 65%, 45-second delay, and no old-window or stale score fallback', () => {
    const f = fixture(); f.time(f.start + 44999); f.score(.9); f.book(); f.check();
    assert.equal(f.trades().length, 0);
    f.time(f.start + 45000); f.score(.35); f.book(); f.book('DOWN'); f.check();
    assert.equal(f.trades().length, 0);
    f.score(.9, { windowStart: f.start - 300000 }); f.check();
    assert.equal(f.trades().length, 0);
    f.score(.9, { windowStart: f.start, candleCloseAt: f.now() - 70001 }); f.check();
    assert.equal(f.trades().length, 0);
    f.score(.9, { candleCloseAt: f.now() + 2000 }); f.check();
    assert.equal(f.trades().length, 0);
    f.score(.34999); f.check(); assert.equal(f.trades().length, 1);
  });

  test(label + ': accepts fresh five-second provisional scores only for the live one-minute candle', () => {
    const f = fixture();
    f.time(f.start + 45000);
    f.score(.71, { provisional: true, adjustmentReady: true, observedAt: f.now(), writtenAt: f.now(),
      candleStart: f.start, candleCloseAt: f.start + 60000, windowStart: f.start });
    f.book();
    f.check();
    assert.equal(f.trades().length, 1);
    assert.equal(f.trades()[0].selectedProbability, .71);

    const stale = fixture();
    stale.time(stale.start + 45000);
    stale.score(.9, { provisional: true, adjustmentReady: true, observedAt: stale.now() - 13000,
      writtenAt: stale.now() - 13000, candleStart: stale.start,
      candleCloseAt: stale.start + 60000, windowStart: stale.start });
    stale.book();
    stale.check();
    assert.equal(stale.trades().length, 0);

    const oldMinute = fixture();
    oldMinute.time(oldMinute.start + 75000);
    oldMinute.score(.9, { provisional: true, adjustmentReady: true, observedAt: oldMinute.now(),
      candleStart: oldMinute.start, candleCloseAt: oldMinute.start + 60000,
      windowStart: oldMinute.start });
    oldMinute.book();
    oldMinute.check();
    assert.equal(oldMinute.trades().length, 0);
  });

  test(label + ': partial buy can flip after the old position is sold', () => {
    const f = fixture(); f.book('UP', [{ price: .4, size: 40 }]); f.check();
    const o = f.orders()[0]; assert.equal(o.status, 'PARTIALLY_FILLED');
    assert.equal(o.filledShares, 40); assert.equal(o.cancelledShares, 60);
    f.score(.1);
    f.book('UP', [{ price: .4, size: 1000 }], [{ price: .3, size: 1000 }]);
    f.book('DOWN', [{ price: .4, size: 1000 }]);
    f.check();
    f.bot.checkTakeProfits(f.record, 'UP', { mid: 1, bestBid: 1 }, 2);
    f.bot.checkStopLosses(f.record, 'UP', { mid: 0, bestBid: 0 }, 2);
    assert.equal(f.trades().filter(p => p.status === 'OPEN').length, 1);
    assert.equal(f.trades().find(p => p.status === 'OPEN').side, 'DOWN');
    assert.equal(f.trades().find(p => p.status === 'CLOSED_FLIP').shares, 40);
    assert.equal(f.orders().filter(order => order.action === 'SELL_TAKER').length, 1);
  });

  test(label + ': empty/stale/wrong-token books and insufficient cash cannot create fake fills', () => {
    const f = fixture(); f.book('UP', []); f.check(); assert.equal(f.trades().length, 0);
    f.book(); f.record.quotes.UP.updatedAt -= 2001; f.check();
    assert.equal(f.trades().length, 0);
    f.book(); f.record.quotes.UP.tokenId = 'prior-window-token'; f.check();
    assert.equal(f.trades().length, 0);
    f.book(); f.record.quotes.UP.windowStart -= 300000; f.check();
    assert.equal(f.trades().length, 0);
    const poor = fixture(30); poor.check(); assert.equal(poor.trades().length, 0);
    f.book(); f.check(); assert.equal(f.trades().length, 1);
  });

  test(label + ': strict best-ask cap and market fee overrides are respected', () => {
    const f = fixture(); f.record.market.feeSchedule.rate = .01;
    f.book('UP', [{ price: .49, size: 100 }]); f.check();
    assert.equal(f.trades()[0].entryPrice, .49);
    assert.equal(f.trades()[0].fees, .2499);
    const blocked = fixture(); blocked.book('UP', [{ price: .5, size: 100 }]); blocked.check();
    assert.equal(blocked.trades().length, 0);
    const free = fixture(); free.record.market.feesEnabled = false; free.check();
    assert.equal(free.trades()[0].fees, 0);
  });

  test(label + ': expiry becomes pending and official settlement pays once including fees', () => {
    for (const winner of ['UP', 'DOWN']) {
      const f = fixture(); f.check(); f.time(f.start + 300000);
      f.check(); assert.equal(f.trades().length, 1);
      f.bot.expireMarket(f.record, f.now());
      assert.equal(f.trades()[0].status, 'PENDING_RESOLUTION');
      f.bot.settleMarket('market', winner, f.now());
      f.bot.settleMarket('market', winner, f.now() + 10);
      const expected = winner === 'UP' ? 58.8 : -41.2;
      assert.ok(Math.abs(f.trades()[0].realizedPnl - expected) < 1e-8);
      assert.ok(Math.abs(f.account().cash - (3000 + expected)) < 1e-8);
    }
  });

  test(label + ': restart preserves fills and prevents duplicate same-side buys', () => {
    const f = fixture(); f.check(); const saved = JSON.parse(JSON.stringify(f.bot.exportLedger()));
    const r = fixture(); r.bot.restoreLedger(saved); r.check();
    assert.equal(r.trades().length, 1);
    assert.ok(Math.abs(r.account().cash - 2958.8) < 1e-8);
    assert.equal(r.orders()[0].execution, 'TAKER');
  });

  test(label + ': restart preserves a closed flip, its sell fee, and the open reversed leg', () => {
    const f = fixture();
    f.check();
    f.score(.29);
    f.book('UP', [{ price: .4, size: 1000 }], [{ price: .3, size: 1000 }]);
    f.book('DOWN', [{ price: .45, size: 1000 }]);
    f.check();
    const saved = JSON.parse(JSON.stringify(f.bot.exportLedger()));
    const r = fixture();
    r.bot.restoreLedger(saved);
    r.check();
    assert.equal(r.trades().filter(p => p.status === 'OPEN').length, 1);
    assert.equal(r.trades().find(p => p.status === 'OPEN').side, 'DOWN');
    assert.equal(r.trades().filter(p => p.status === 'CLOSED_FLIP').length, 1);
    assert.equal(r.orders().filter(o => o.action === 'SELL_TAKER').length, 1);
    assert.equal(r.bot.snapshot().flipPolicy.flipsUsed, 1);
  });

  test(label + ': old resting ledger resets once and new taker ledger restores subsequently', async () => {
    const f = fixture(); let archived = 0;
    f.bot.ledgerStore = { archive: async () => { archived++; } };
    f.bot.flushLedger = async () => {};
    assert.equal(await restoreOrResetLedger(f.bot, { strategyId: 'prior-resting-id' }, Bot.STRATEGY.id), 'reset');
    assert.equal(archived, 1); assert.equal(f.account().cash, 3000);
    assert.equal(await restoreOrResetLedger(f.bot, f.bot.exportLedger(), Bot.STRATEGY.id), 'restored');
    assert.equal(archived, 1);
  });

  test(label + ': only the first qualified reversal sells and buys; a second is blocked', () => {
    const f = fixture();
    f.check();
    f.score(.29); // DOWN 71%
    f.book('UP', [{ price: .4, size: 1000 }], [{ price: .3, size: 1000 }]);
    f.book('DOWN', [{ price: .45, size: 1000 }]);
    f.check();
    assert.equal(f.trades().filter(p => p.status === 'OPEN')[0].side, 'DOWN');
    f.score(.71); // UP 71%
    f.book('UP', [{ price: .49, size: 1000 }], [{ price: .3, size: 1000 }]);
    f.book('DOWN', [{ price: .4, size: 1000 }], [{ price: .35, size: 1000 }]);
    f.check();
    assert.equal(f.trades().filter(p => p.status === 'OPEN')[0].side, 'DOWN');
    assert.equal(f.trades().filter(p => p.status === 'CLOSED_FLIP').length, 1);
    assert.equal(f.orders().filter(order => order.action === 'SELL_TAKER').length, 1);
    assert.equal(f.orders().filter(order => order.action === 'BUY_TAKER').length, 2);
    assert.ok(f.trades().filter(p => p.status === 'CLOSED_FLIP').every(p => p.exitReason === 'OPPOSITE_SIGNAL'));
  });

  test(label + ': reversal waits for a strict qualifying ask and fully sold prior position', () => {
    const f = fixture();
    f.check();
    f.score(.29);
    f.book('UP', [{ price: .4, size: 1000 }], [{ price: .3, size: 40 }]);
    f.book('DOWN', [{ price: .5, size: 1000 }]);
    f.check();
    assert.equal(f.orders().length, 1);
    assert.equal(f.trades().filter(p => p.status === 'OPEN')[0].side, 'UP');

    f.book('DOWN', [{ price: .4, size: 1000 }]);
    f.check();
    assert.equal(f.orders()[0].action, 'SELL_TAKER');
    assert.equal(f.orders()[0].status, 'PARTIALLY_FILLED');
    assert.equal(f.trades().filter(p => p.status === 'OPEN')[0].side, 'UP');

    f.time(f.now() + 1000); f.score(.29);
    f.book('UP', [{ price: .4, size: 1000 }], [{ price: .3, size: 1000 }]);
    f.book('DOWN', [{ price: .4, size: 1000 }]);
    f.check();
    assert.equal(f.trades().filter(p => p.status === 'OPEN')[0].side, 'DOWN');
    assert.equal(f.orders().filter(order => order.action === 'SELL_TAKER').length, 2);
    assert.equal(f.bot.snapshot().flipPolicy.flipsUsed, 1);
    assert.equal(f.bot.snapshot().flipPolicy.completed, true);
  });

  test(label + ': flip allowed at 3:59.999 but blocked at exactly 4:00 and later', () => {
    for (const elapsed of [239999, 240000, 240001, 299999]) {
      const f = fixture(); f.check(); f.time(f.start + elapsed); f.score(.29);
      f.book('UP'); f.book('DOWN'); f.check();
      assert.equal(f.orders().filter(o => o.action === 'SELL_TAKER').length,
        elapsed < 240000 ? 1 : 0, String(elapsed));
      assert.equal(f.trades().find(p => p.status === 'OPEN').side, elapsed < 240000 ? 'DOWN' : 'UP');
    }
  });

  test(label + ': initial entry is still allowed after 4:00; cutoff only blocks flips', () => {
    const f = fixture(); f.time(f.start + 250000); f.score(.75); f.book(); f.check();
    assert.equal(f.orders().length, 1); assert.equal(f.orders()[0].action, 'BUY_TAKER');
    assert.equal(f.bot.snapshot().flipPolicy.flipsUsed, 0);
  });

  test(label + ': no liquidity does not consume the flip allowance', () => {
    const f = fixture(); f.check(); f.score(.29);
    f.book('UP', [{ price: .4, size: 1000 }], []); f.book('DOWN'); f.check();
    assert.equal(f.orders().length, 1); assert.equal(f.bot.snapshot().flipPolicy.flipsUsed, 0);
    f.book(); f.check(); assert.equal(f.bot.snapshot().flipPolicy.flipsUsed, 1);
  });

  test(label + ': partial-sale continuation stops at cutoff and survives restart', () => {
    const f = fixture(); f.check(); f.time(f.start + 239000); f.score(.29);
    f.book('UP', [{ price: .4, size: 1000 }], [{ price: .3, size: 40 }]); f.book('DOWN'); f.check();
    assert.equal(f.bot.snapshot().flipPolicy.flipsUsed, 1);
    const saved = JSON.parse(JSON.stringify(f.bot.exportLedger())), r = fixture();
    r.bot.restoreLedger(saved); r.time(r.start + 240000); r.score(.29); r.book(); r.book('DOWN'); r.check();
    assert.equal(r.orders().filter(o => o.action === 'SELL_TAKER').length, 1);
    assert.equal(r.orders().filter(o => o.action === 'BUY_TAKER').length, 1);
    assert.equal(r.trades().find(p => p.status === 'OPEN').shares, 60);
    assert.equal(r.bot.snapshot().flipPolicy.flipsUsed, 1);
  });

  test(label + ': pending rebuy cannot change sides or execute past cutoff', () => {
    const f = fixture(42); f.check(); f.score(.29);
    f.book('UP', [{ price: .4, size: 1000 }], [{ price: .01, size: 1000 }]);
    f.book('DOWN'); f.check();
    assert.equal(f.trades().filter(p => p.status === 'OPEN').length, 0);
    assert.equal(f.bot.snapshot().flipPolicy.flipsUsed, 1);
    f.score(.75); f.book('UP', [{ price: .01, size: 1000 }]); f.check();
    assert.equal(f.orders().filter(o => o.action === 'BUY_TAKER').length, 1);
    f.time(f.start + 240000); f.score(.29); f.book('DOWN', [{ price: .01, size: 1000 }]); f.check();
    assert.equal(f.orders().filter(o => o.action === 'BUY_TAKER').length, 1);
  });

  test(label + ': new window resets the allowance without discarding earlier history', () => {
    const f = fixture(); f.check(); f.score(.29); f.check();
    assert.equal(f.bot.snapshot().flipPolicy.flipsUsed, 1);
    f.time(f.start + 300000); f.bot.expireMarket(f.record, f.now());
    const next = f.start + 300000;
    f.record.market = { ...f.record.market, id: 'market-next', start: next, end: next + 300000 };
    f.record.marketStatus = 'OPEN'; f.time(next + 60000);
    f.score(.75, { windowStart: next, candleStart: next });
    f.book(); f.book('DOWN');
    for (const q of Object.values(f.record.quotes)) q.marketId = 'market-next';
    f.check(); assert.equal(f.bot.snapshot().flipPolicy.flipsUsed, 0);
    f.score(.29, { windowStart: next, candleStart: next }); f.check();
    assert.equal(f.bot.snapshot().flipPolicy.flipsUsed, 1);
    assert.equal(f.orders().filter(o => o.action === 'SELL_TAKER').length, 2);
  });

  test(label + ': stale opposite asks cannot trigger a sale before a new buy', () => {
    const f = fixture();
    f.check();
    f.score(.29);
    f.book('UP', [{ price: .4, size: 1000 }], [{ price: .3, size: 1000 }]);
    f.book('DOWN', [{ price: .4, size: 1000 }]);
    f.record.quotes.DOWN.updatedAt -= 2501;
    f.check();
    assert.equal(f.orders().length, 1);
    assert.equal(f.trades().filter(p => p.status === 'OPEN')[0].side, 'UP');
  });

  test(label + ': live dashboard script renders taker entries, fees and no resting controls', async () => {
    const f = fixture(); f.check();
    f.bot.freqaiWorker.snapshot = () => ({
      status: 'READY',
      lastPrediction: { source: 'FREQAI', pUp: .7, pDown: .3, side: 'UP',
        probability: .7, candleStart: f.start, candleCloseAt: f.now(),
        windowStart: f.start, writtenAt: f.now(), observedAt: f.now(), provisional: false },
      rawPrediction: { pUp: .7, pDown: .3, provisional: false },
      lastClosedPrediction: { pUp: .66, pDown: .34 },
      scoreAdjustment: { ready: true, mode: 'CLOSED_BASELINE_PLUS_INTRAMINUTE_DELTA',
        baselinePUp: .66, baselinePDown: .34, rawPUp: .70, rawPDown: .30,
        deltaPUp: .04, adjustedPUp: .70, adjustedPDown: .30 },
    });
    const state = f.bot.snapshot();
    const html = fs.readFileSync(path.join(root, 'public/freqai-dashboard.html'), 'utf8');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
    const elements = new Map();
    const element = () => ({ textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
      addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} },
      querySelectorAll() { return []; }, querySelector() { return {}; } });
    vm.runInNewContext(script, {
      document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        addEventListener() {}, visibilityState: 'visible' },
      fetch: async () => ({ ok: true, json: async () => state }),
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      AbortController, Date, Intl, console, navigator: { onLine: true }, window: { addEventListener() {} },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(elements.get('status')?.textContent, 'OFFLINE');
    assert.match(html, /Taker order history/);
    assert.doesNotMatch(html, /<h2>Resting buy orders|Maker fees are zero|ask minus \$0\.10/);
    const output = elements.get('auditTrail') || elements.get('restingOrders');
    assert.match(output.innerHTML, /100 \/ 100 filled/);
    assert.match(output.innerHTML, /fees \$1\.20/);
    assert.match(elements.get('modelDecision').textContent, /one flip is allowed, strictly before 4:00/);
    assert.match(elements.get('recovery').textContent, /flips used 0\/1/);
    assert.match(elements.get('scoreAdjustment').textContent, /Closed 1m baseline UP 66\.0%/);
    assert.match(elements.get('scoreAdjustment').textContent, /adjusted UP 70\.0%/);
    assert.match(html, /strictly above 65%/);
  });
}
