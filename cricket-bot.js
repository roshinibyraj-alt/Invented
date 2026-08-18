'use strict';

/**
 * Manager module — instantiates ONE 0.60-martingale engine for BTC 5m
 * Up/Down windows. Exposes the API that index.js (the dashboard) talks to.
 *
 * Strategy:
 *   - wait 1m after a 5m window opens
 *   - fire the $50 entry at any price >= 0.60 on the leading side
 *   - 1.5x martingale re-entry on next 0.60+ signal (max 3 levels)
 *   - stop loss at 0.49 (force sell)
 *   - side above 0.90 at window end is declared the winner
 */

const path = require('path');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const CAPITAL = Number(process.env.CAPITAL || process.env.STARTING_CAPITAL || 4000);
const CAPITAL_5 = process.env.CAPITAL_5 ? Number(process.env.CAPITAL_5) : undefined;
const ENTRY_PRICE = Number(process.env.ENTRY_PRICE || 0.60);
const STOP_LOSS_PRICE = Number(process.env.STOP_LOSS_PRICE || 0.49);
const ENTRY_DOLLARS = Number(process.env.ENTRY_DOLLARS || 50);
const MARTINGALE_MULTIPLIER = Number(process.env.MARTINGALE_MULTIPLIER || 1.5);
const MAX_MARTINGALE_LEVELS = Number(process.env.MAX_MARTINGALE_LEVELS || 1);
const WAIT_SECONDS_5 = Number(process.env.WAIT_SECONDS_5 || 30);
const FEE_THETA = Number(process.env.FEE_THETA || 0.07);
const REBATE_PCT = Number(process.env.REBATE_PCT || 0);

let trader = null;
let engine = null;

async function init(privateKey, emit, slogFn) {
  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  engine = createEngine({
    label: 'BTC-0.60-MART',
    startingCapital: CAPITAL,
    startingCapital5: CAPITAL_5,
    entryPrice: ENTRY_PRICE,
    stopLossPrice: STOP_LOSS_PRICE,
    entryDollars: ENTRY_DOLLARS,
    martingaleMultiplier: MARTINGALE_MULTIPLIER,
    maxMartingaleLevels: MAX_MARTINGALE_LEVELS,
    waitSeconds5: WAIT_SECONDS_5,
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
  return engine ? engine.buildState() : { m5: null };
}

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
