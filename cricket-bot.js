'use strict';

/**
 * Manager module — instantiates ONE shared 0.60-martingale engine that
 * trades both 5m and 15m Up/Down windows. Exposes the API that index.js
 * (the dashboard) talks to.
 *
 * Strategy (both timeframes, independent, SEPARATE demo capital):
 *   - wait 2m (5m) / 6m (15m) after a window opens
 *   - fire the $50 entry on the LEADING side at ANY price (no come-back wait)
 *   - ONE flip of $100 (2x the $50 entry) INSTANTLY when the opposite side hits 0.50
 *   - no flips after 280s (5m) / 870s (15m)
 *   - flip FIRST, then sell the losing side ~2s later at the current bid
 *   - side above 0.90 at window end is declared the winner
 */

const path = require('path');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const CAPITAL = Number(process.env.CAPITAL || process.env.STARTING_CAPITAL || 4000);
const CAPITAL_5 = process.env.CAPITAL_5 ? Number(process.env.CAPITAL_5) : undefined;
const CAPITAL_15 = process.env.CAPITAL_15 ? Number(process.env.CAPITAL_15) : undefined;
const FLIP_CUTOFF_SECONDS_5 = Number(process.env.FLIP_CUTOFF_SECONDS_5 || 280);
const FLIP_CUTOFF_SECONDS_15 = Number(process.env.FLIP_CUTOFF_SECONDS_15 || 870);
const ENTRY_DOLLARS = Number(process.env.ENTRY_DOLLARS || 50);
const MARTINGALE_AMOUNTS = (process.env.MARTINGALE_AMOUNTS || '100')
  .split(',').map(v => Number(String(v).trim())).filter(Number.isFinite);
const WAIT_SECONDS_5 = Number(process.env.WAIT_SECONDS_5 || 120);
const WAIT_SECONDS_15 = Number(process.env.WAIT_SECONDS_15 || 360);
const TRIGGER_SLIP = Number(process.env.TRIGGER_SLIP || 0.02);
const SELL_DELAY_MS = Number(process.env.SELL_DELAY_MS || 2000);
const START_AT_BOUNDARY = (process.env.START_AT_BOUNDARY || 'false').toLowerCase() === 'true';
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
    startingCapital15: CAPITAL_15,
    flipCutoffSeconds5: FLIP_CUTOFF_SECONDS_5,
    flipCutoffSeconds15: FLIP_CUTOFF_SECONDS_15,
    entryDollars: ENTRY_DOLLARS,
    martingaleAmounts: MARTINGALE_AMOUNTS.length ? MARTINGALE_AMOUNTS : [100],
    waitSeconds5: WAIT_SECONDS_5,
    waitSeconds15: WAIT_SECONDS_15,
    triggerSlip: TRIGGER_SLIP,
    sellDelayMs: SELL_DELAY_MS,
    startAtBoundary: START_AT_BOUNDARY,
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
