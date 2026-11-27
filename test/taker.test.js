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
      writtenAt: now, pUp: .7, pDown: .3, model: 'LightGBMClassifier' };
    const bot = new Bot({ initialCapital: capital, now: () => now, marketData: {},
      freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: raw }) } });
    const record = bot.records.get('BTC:5m');
    record.marketStatus = 'OPEN';
    record.market = { id: 'market', slug: 'btc-test', start, end: start + 300000,
      tokens: { UP: 'up', DOWN: 'down' }, feeSchedule: { rate: .05 } };
    const book = (side = 'UP', levels = [{ price: .6, size: 1000 }]) => {
      record.quotes[side] = { updatedAt: now, tokenId: side.toLowerCase(), marketId: 'market',
        windowStart: record.market.start, bestAsk: levels[0]?.price ?? null,
        bestBid: .59, asks: levels };
    };
    book(); book('DOWN');
    return { bot, record, start, book, time: t => { now = t; }, now: () => now,
      score: (up, fields = {}) => { raw = { ...raw, pUp: up, pDown: 1 - up,
        candleCloseAt: now, writtenAt: now, ...fields }; },
      check: () => bot.processSide(record, 'UP', record.quotes.UP, 1),
      trades: () => bot.shadowEntries || bot.positions,
      orders: () => bot.snapshot().shadowTakerOrders || bot.orders,
      account: () => bot.snapshot().shadowAccount || bot.accountSnapshot(),
    };
  }

  test(label + ': immediately sweeps depth at weighted prices and charges actual taker fees', () => {
    const f = fixture(); f.book('UP', [{ price: .7, size: 70 }, { price: .6, size: 30 }]);
    f.check();
    const p = f.trades()[0], o = f.orders()[0];
    assert.equal(p.shares, 100); assert.ok(Math.abs(p.entryPrice - .67) < 1e-10);
    assert.ok(Math.abs(p.totalCost - 67) < 1e-10);
    assert.ok(Math.abs(p.fees - 1.095) < 1e-10);
    assert.ok(Math.abs(f.account().cash - 2931.905) < 1e-8);
    assert.equal(o.execution, 'TAKER'); assert.equal(o.remainingShares, 0);
    assert.equal(f.bot.snapshot().takerOrderSummary.reservedCash, 0);
    assert.equal(f.bot.snapshot().restingOrderSummary, undefined);
  });

  test(label + ': strict above 58%, unchanged delay and no old-window/stale/future score fallback', () => {
    const f = fixture(); f.time(f.start + 44999); f.score(.9); f.book(); f.check();
    assert.equal(f.trades().length, 0);
    f.time(f.start + 45000); f.score(.58); f.book(); f.check();
    assert.equal(f.trades().length, 0);
    f.score(.9, { windowStart: f.start - 300000 }); f.check();
    assert.equal(f.trades().length, 0);
    f.score(.9, { windowStart: f.start, candleCloseAt: f.now() - 70001 }); f.check();
    assert.equal(f.trades().length, 0);
    f.score(.9, { candleCloseAt: f.now() + 2000 }); f.check();
    assert.equal(f.trades().length, 0);
    f.score(.58001); f.check(); assert.equal(f.trades().length, 1);
  });

  test(label + ': partial fills cancel immediately, consume window, and never flip or use TP/SL', () => {
    const f = fixture(); f.book('UP', [{ price: .4, size: 40 }]); f.check();
    const o = f.orders()[0]; assert.equal(o.status, 'PARTIALLY_FILLED');
    assert.equal(o.filledShares, 40); assert.equal(o.cancelledShares, 60);
    f.book(); f.check(); f.score(.01); f.book('DOWN'); f.check();
    f.bot.checkTakeProfits(f.record, 'UP', { mid: 1, bestBid: 1 }, 2);
    f.bot.checkStopLosses(f.record, 'UP', { mid: 0, bestBid: 0 }, 2);
    assert.equal(f.trades().length, 1); assert.equal(f.trades()[0].shares, 40);
    assert.equal(f.trades()[0].status, 'OPEN');
  });

  test(label + ': empty/stale/wrong-token books and insufficient cash cannot create fake fills', () => {
    const f = fixture(); f.book('UP', []); f.check(); assert.equal(f.trades().length, 0);
    f.book(); f.record.quotes.UP.updatedAt -= 2001; f.check();
    assert.equal(f.trades().length, 0);
    f.book(); f.record.quotes.UP.tokenId = 'prior-window-token'; f.check();
    assert.equal(f.trades().length, 0);
    f.book(); f.record.quotes.UP.windowStart -= 300000; f.check();
    assert.equal(f.trades().length, 0);
    const poor = fixture(60); poor.check(); assert.equal(poor.trades().length, 0);
    f.book(); f.check(); assert.equal(f.trades().length, 1);
  });

  test(label + ': no entry-price cap; market fee overrides and fee-free flags are respected', () => {
    const f = fixture(); f.record.market.feeSchedule.rate = .01;
    f.book('UP', [{ price: .99, size: 100 }]); f.check();
    assert.equal(f.trades()[0].entryPrice, .99);
    assert.equal(f.trades()[0].fees, .0099);
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
      const expected = winner === 'UP' ? 38.8 : -61.2;
      assert.ok(Math.abs(f.trades()[0].realizedPnl - expected) < 1e-8);
      assert.ok(Math.abs(f.account().cash - (3000 + expected)) < 1e-8);
    }
  });

  test(label + ': restart preserves fills, fees, cash and the consumed window', () => {
    const f = fixture(); f.check(); const saved = JSON.parse(JSON.stringify(f.bot.exportLedger()));
    const r = fixture(); r.bot.restoreLedger(saved); r.check();
    assert.equal(r.trades().length, 1);
    assert.ok(Math.abs(r.account().cash - 2938.8) < 1e-8);
    assert.equal(r.orders()[0].execution, 'TAKER');
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

  test(label + ': live dashboard script renders taker entries, fees and no resting controls', async () => {
    const f = fixture(); f.check(); const state = f.bot.snapshot();
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
    assert.match(html, /Taker buy orders/);
    assert.doesNotMatch(html, /<h2>Resting buy orders|Maker fees are zero|ask minus \$0\.10/);
    const output = elements.get('auditTrail') || elements.get('restingOrders');
    assert.match(output.innerHTML, /100 \/ 100 filled/);
    assert.match(output.innerHTML, /fees \$1\.20/);
    assert.match(elements.get('modelDecision').textContent, /immediately buys 100/);
  });
}
