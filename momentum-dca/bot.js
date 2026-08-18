'use strict';

const PolymarketTrader = require('../polymarket-trader');
const { createMomentumEngine } = require('./engine');

const CAPITAL        = Number(process.env.DCA_CAPITAL || 10000);
const PER_WINDOW     = Number(process.env.DCA_PER_WINDOW || 1200);
const FEE_THETA      = Number(process.env.FEE_THETA || 0.07);
const REBATE_PCT     = Number(process.env.REBATE_PCT || 0);

let engine = null;

async function init(emit, slogFn) {
  let trader = null;
  const pk = process.env.PRIVATE_KEY;
  if (pk) {
    try {
      trader = new PolymarketTrader(pk);
      await trader.authenticate();
      slogFn('🔑 Trader authenticated');
    } catch (e) {
      slogFn(`⚠️ Trader auth failed: ${e.message} — running demo mode`);
      trader = null;
    }
  } else {
    slogFn('⚠️ No PRIVATE_KEY — running demo mode');
  }

  engine = createMomentumEngine({
    label: 'MOMENTUM-DCA',
    startingCapital: CAPITAL,
    perWindowBudget: PER_WINDOW,
    feeTheta: FEE_THETA,
    rebatePct: REBATE_PCT,
  }, trader);

  engine._log((msg) => {
    const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
    slogFn(line);
  });
  engine._slog(slogFn);

  engine.start();
}

function buildState() { return engine ? engine.buildState() : {}; }

module.exports = { init, buildState };
