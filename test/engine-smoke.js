const assert = require('node:assert/strict');
const { MomentumLagEngine } = require('../engine');

function windowStartFor(timeMs) { return Math.floor(timeMs / 1000 / 300) * 300; }
class FakeWebSocket { constructor() { this.readyState = 1; this.sent = []; } send(data) { this.sent.push(JSON.parse(data)); } close() { this.readyState = 3; } }
async function fakeFetch(url) {
  const match = String(url).match(/slug=([a-z]+)-updown-5m-(\d+)/);
  assert.ok(match, 'unexpected discovery URL: ' + url);
  const [asset, start] = [match[1], match[2]];
  return { ok: true, json: async () => [{
    conditionId: '0x' + asset, question: asset.toUpperCase() + ' test', closed: false,
    outcomes: '["Up","Down"]', clobTokenIds: `["${asset}-${start}-up","${asset}-${start}-down"]`,
  }] };
}

(async () => {
  const logs = [];
  const engine = new MomentumLagEngine({ WebSocketImpl: FakeWebSocket, fetchImpl: fakeFetch, onLog: line => logs.push(line), onTick: () => {} });
  const start = windowStartFor(Date.now());
  for (const asset of ['btc', 'eth', 'sol', 'xrp']) await engine.discoverMarket(asset, start);
  await engine.discoverMarket('btc', start + 300);
  assert.equal(engine.publicMarkets().length, 4, 'dashboard exposes only current-window books');
  engine.activeWindowStart = start;
  const market = slug => engine.markets.get(`${slug}-updown-5m-${start}`);

  engine.applyTop(market('btc').up, 0.29, 0.31);
  engine.applyTop(market('btc').down, 0.69, 0.71);
  engine.applyTop(market('eth').down, 0.39, 0.41);
  engine.applyTop(market('sol').down, 0.19, 0.21);
  engine.evaluateSignals();

  assert.equal(engine.combos.length, 2, 'ETH and SOL opposite-side combos both fire');
  assert.equal(engine.positions.length, 4, 'each combo has BTC and alt legs');
  assert.equal(engine.bankroll, 20000 - 72 - 52, 'bankroll drops by executable combo cost');
  const ethCombo = engine.combos.find(combo => combo.name === 'ETH_DOWN');
  assert.equal(ethCombo.cost, 72);
  assert.equal(ethCombo.legs[0].outcome, 'UP');
  assert.equal(ethCombo.legs[1].outcome, 'DOWN');
  assert.equal(ethCombo.combinedEntryMid, 0.7);

  market('btc').finalUpMax = 0.93; market('btc').finalDownMax = 0.07;
  market('eth').finalDownMax = 0.93; market('eth').finalUpMax = 0.05;
  market('btc').resolved = false; market('eth').resolved = false;
  engine.resolveFromFinalPrices(market('btc'));
  engine.resolveFromFinalPrices(market('eth'));
  engine.settleResolvedCombos();
  assert.equal(market('btc').winner, 'UP');
  assert.equal(market('eth').winner, 'DOWN');
  assert.equal(ethCombo.status, 'settled');
  assert.equal(ethCombo.payout, 200);
  assert.equal(ethCombo.pnl, 128);
  assert.equal(engine.realizedPnl, 128);

  console.log(JSON.stringify({
    openCombos: engine.combos.filter(c => c.status === 'open').length,
    filledLegs: engine.trades.length,
    realizedPnl: engine.realizedPnl,
    bankroll: engine.bankroll,
  }, null, 2));
  console.log('CORRELATION-COMBO CLOB SMOKE PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
