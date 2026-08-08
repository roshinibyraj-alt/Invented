'use strict';

/**
 * Manager module — instantiates ONE combined 15m/5m hedge engine
 * (single shared bankroll, coupled strategy). Exposes the API that
 * index.js (the dashboard) talks to.
 *
 * This file keeps the name `cricket-bot.js` only because index.js already
 * requires('./cricket-bot') — the actual logic lives in engine-factory.js
 * / candles.js / three-candle-model.js.
 */

const path = require('path');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const CAPITAL = Number(process.env.CAPITAL || process.env.STARTING_CAPITAL || 4000);
const BASE_BET_15M = Number(process.env.BASE_BET_15M || 150);
const BASE_BET_5M = Number(process.env.BASE_BET_5M || 50);
const FEE_THETA = Number(process.env.FEE_THETA || 0.07);
const REBATE_PCT = Number(process.env.REBATE_PCT || 0);

let trader = null;
let engine = null;

async function init(privateKey, emit, slogFn) {
  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  engine = createEngine({
    label: 'BTC-HEDGE',
    startingCapital: CAPITAL,
    baseBet15m: BASE_BET_15M,
    baseBet5m: BASE_BET_5M,
    feeTheta: FEE_THETA,
    rebatePct: REBATE_PCT,
    statsStatePath: process.env.STATS_STATE_PATH || path.join(__dirname, 'stats-state-hedge.json'),
    trader,
    dryRun: DRY_RUN,
    emit,
    slog: slogFn,
  });

  await engine.start();
}

function buildState() {
  return engine ? engine.buildState() : { m5: null, m15: null };
}

// Both panels map to the single combined engine.
function pauseTrading() {
  return engine ? engine.pauseTrading() : { ok: false, error: 'not initialized' };
}
function resumeTrading() {
  return engine ? engine.resumeTrading() : { ok: false, error: 'not initialized' };
}
function setMode(live) {
  return engine ? engine.setMode(live) : { ok: false, error: 'not initialized' };
}

module.exports = { init, buildState, pauseTrading, resumeTrading, setMode };
