const assert = require('node:assert/strict');
const { MomentumLagEngine } = require('../engine');

function windowStartFor(timeMs) { return Math.floor(timeMs / 1000 / 300) * 300; }
async function fakeFetch(url, options = {}) {
  const urlText = String(url);
  if (urlText.endsWith('/books') && options.method === 'POST') return { ok: true, json: async () => [] };
  const match = urlText.match(/slug=([a-z]+)-updown-5m-(\d+)/);
  assert.ok(match, 'unexpected discovery URL: ' + urlText);
  const [asset, start] = [match[1], match[2]];
  return { ok: true, json: async () => [{
    conditionId: '0x' + asset + start, question: asset.toUpperCase() + ' test', closed: false,
    outcomes: '["Up","Down"]', clobTokenIds: `["${asset}-${start}-up","${asset}-${start}-down"]`,
  }] };
}

(async () => {
  const logs = [];
  const engine = new MomentumLagEngine({ fetchImpl: fakeFetch, onLog: line => logs.push(line) });
  const start = windowStartFor(Date.now());
  for (const asset of ['btc', 'eth', 'sol', 'xrp']) await engine.discoverMarket(asset, start);
  engine.activeWindowStart = start;
  const market = slug => engine.markets.get(`${slug}-updown-5m-${start}`);

  engine.applyTop(market('btc').up, 0.29, 0.31);
  engine.applyTop(market('btc').down, 0.69, 0.71);
  engine.applyTop(market('eth').up, 0.59, 0.61);
  engine.applyTop(market('eth').down, 0.39, 0.41);
  engine.applyTop(market('sol').down, 0.19, 0.21);
  engine.evaluateSignals();

  assert.equal(engine.combos.length, 2, 'ETH and SOL opposite-side combos both fire');
  assert.equal(engine.positions.length, 4, 'each combo has BTC and alt legs');
  assert.equal(engine.currentTradeShares(), 5, 'normal windows use the five-share base');
  assert.equal(engine.combos.find(combo => combo.name === 'ETH_DOWN').cost, 3.6);
  assert.equal(engine.combos.find(combo => combo.name === 'SOL_DOWN').cost, 2.6);
  assert.equal(engine.bankroll, 19993.8);
  assert.equal(engine.ethBoostPending, true, 'ETH decorrelation arms the next three windows');

  market('btc').finalUpMax = 0.93; market('btc').finalDownMax = 0.07;
  market('eth').finalDownMax = 0.93; market('eth').finalUpMax = 0.05;
  market('btc').resolved = false; market('eth').resolved = false;
  engine.resolveFromFinalPrices(market('btc'));
  engine.resolveFromFinalPrices(market('eth'));
  engine.settleResolvedCombos();
  const ethCombo = engine.combos.find(combo => combo.name === 'ETH_DOWN');
  assert.equal(ethCombo.payout, 10);
  assert.equal(ethCombo.pnl, 6.4);

  const originalNow = Date.now;
  try {
    Date.now = () => (start + 301) * 1000;
    await engine.rotateAndSweep();
    assert.equal(engine.boostWindowsRemaining, 3);
    assert.equal(engine.currentTradeShares(), 100);

    engine.boostWindowsRemaining = 1;
    assert.equal(engine.currentTradeShares(), 100);
    Date.now = () => (start + 601) * 1000;
    await engine.rotateAndSweep();
    assert.equal(engine.boostWindowsRemaining, 0);
    assert.equal(engine.currentTradeShares(), 5);
  } finally {
    Date.now = originalNow;
  }

  console.log(JSON.stringify({
    baseShares: 5, boostedShares: 100,
    baseCombos: 2, realizedPnl: engine.realizedPnl,
    bankroll: engine.bankroll, boostStateLogs: logs.filter(line => line.includes('Boost') || line.includes('decorrelation')),
  }, null, 2));
  console.log('CORRELATION-COMBO CLOB POLLING SMOKE PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
