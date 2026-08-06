'use strict';

/**
 * Manager module — instantiates TWO independent signal-model engines
 * (5-minute and 15-minute BTC Up/Down), each with its own $2000 demo
 * bankroll, own candle feed, own learned model, own win rate. Exposes a
 * combined API that index.js (the dashboard) talks to.
 *
 * This file keeps the name `cricket-bot.js` only because index.js already
 * requires('./cricket-bot') — the actual logic lives in engine-factory.js
 * / candles.js / signal-model.js / patterns.js.
 */

const path = require('path');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const CAPITAL_5M = Number(process.env.CAPITAL_5M || process.env.STARTING_CAPITAL_5M || 2000);
const CAPITAL_15M = Number(process.env.CAPITAL_15M || process.env.STARTING_CAPITAL_15M || 2000);
const BASE_BET_5M = Number(process.env.BASE_BET_5M || 50);
const BASE_BET_15M = Number(process.env.BASE_BET_15M || 50);
const CONFIDENCE_5M = Number(process.env.CONFIDENCE_THRESHOLD_5M || process.env.CONFIDENCE_THRESHOLD || 0.55);
const CONFIDENCE_15M = Number(process.env.CONFIDENCE_THRESHOLD_15M || process.env.CONFIDENCE_THRESHOLD || 0.55);
const FORCED_OPPOSITE_WINDOWS = Number(process.env.FORCED_OPPOSITE_WINDOWS || 2);
const ENTRY_PRICE_THRESHOLD = Number(process.env.ENTRY_PRICE_THRESHOLD || 0.33);
// Entry wait is proportional to window length: 60s for 5m, 3x that (180s) for 15m.
const ENTRY_WAIT_SEC_5M = Number(process.env.ENTRY_WAIT_SEC_5M || process.env.ENTRY_WAIT_SEC || 60);
const ENTRY_WAIT_SEC_15M = Number(process.env.ENTRY_WAIT_SEC_15M || ENTRY_WAIT_SEC_5M * 3);
// Polymarket taker fee: fee = shares * theta * price * (1-price). Crypto category theta = 0.07.
const FEE_THETA = Number(process.env.FEE_THETA || 0.07);
// Taker rebate is a flat approximation - Polymarket's exact tiered schedule isn't public.
const REBATE_PCT = Number(process.env.REBATE_PCT || 0);

let trader = null;
let engines = null;

async function init(privateKey, emit, slogFn) {
  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  const m5 = createEngine({
    label: 'BTC-5m',
    windowSeconds: 300,
    slugPrefix: 'btc-updown-5m-',
    binanceInterval: '5m',
    modelStatePath: process.env.MODEL_STATE_PATH_5M || path.join(__dirname, 'model-state-5m.json'),
    statsStatePath: process.env.STATS_STATE_PATH_5M || path.join(__dirname, 'stats-state-5m.json'),
    startingCapital: CAPITAL_5M,
    baseBetDollars: BASE_BET_5M,
    confidenceThreshold: CONFIDENCE_5M,
    forcedOppositeWindows: FORCED_OPPOSITE_WINDOWS,
    entryPriceThreshold: ENTRY_PRICE_THRESHOLD,
    entryWaitSec: ENTRY_WAIT_SEC_5M,
    feeTheta: FEE_THETA,
    rebatePct: REBATE_PCT,
    trader,
    dryRun: DRY_RUN,
  });

  const m15 = createEngine({
    label: 'BTC-15m',
    windowSeconds: 900,
    slugPrefix: 'btc-updown-15m-',
    binanceInterval: '15m',
    modelStatePath: process.env.MODEL_STATE_PATH_15M || path.join(__dirname, 'model-state-15m.json'),
    statsStatePath: process.env.STATS_STATE_PATH_15M || path.join(__dirname, 'stats-state-15m.json'),
    startingCapital: CAPITAL_15M,
    baseBetDollars: BASE_BET_15M,
    confidenceThreshold: CONFIDENCE_15M,
    forcedOppositeWindows: FORCED_OPPOSITE_WINDOWS,
    entryPriceThreshold: ENTRY_PRICE_THRESHOLD,
    entryWaitSec: ENTRY_WAIT_SEC_15M,
    feeTheta: FEE_THETA,
    rebatePct: REBATE_PCT,
    trader,
    dryRun: DRY_RUN,
  });

  engines = { m5, m15 };

  slogFn('[hedgebot] 🪙 Running TWO independent signal-model engines: BTC 5-minute and BTC 15-minute Up/Down — separate candle history, separate learned model, separate bankroll, separate win rate for each.');

  await Promise.all([m5.start(emit, slogFn), m15.start(emit, slogFn)]);
}

function requireEngines() {
  if (!engines) throw new Error('Engines not initialized yet');
  return engines;
}

function pauseTrading(engineKey) {
  const { m5, m15 } = requireEngines();
  if (engineKey === 'm5') return m5.pauseTrading();
  if (engineKey === 'm15') return m15.pauseTrading();
  m5.pauseTrading(); m15.pauseTrading();
  return { ok: true };
}
function resumeTrading(engineKey) {
  const { m5, m15 } = requireEngines();
  if (engineKey === 'm5') return m5.resumeTrading();
  if (engineKey === 'm15') return m15.resumeTrading();
  m5.resumeTrading(); m15.resumeTrading();
  return { ok: true };
}
function setMode(live, engineKey) {
  const { m5, m15 } = requireEngines();
  if (engineKey === 'm5') return m5.setMode(live);
  if (engineKey === 'm15') return m15.setMode(live);
  m5.setMode(live); m15.setMode(live);
  return { ok: true, dryRun: !live };
}
function buildState() {
  const { m5, m15 } = requireEngines();
  return { m5: m5.buildState(), m15: m15.buildState() };
}

module.exports = {
  init,
  pauseTrading, resumeTrading,
  setMode,
  buildState, getStatus: buildState,
};
