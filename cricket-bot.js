'use strict';

/**
 * Manager module — instantiates TWO independent fixed-rule signal engines
 * (5-minute and 15-minute BTC Up/Down), each with its own $2000 demo
 * bankroll, own candle feed, own win rate. NO learning/training — both
 * engines use the same fixed point-scoring rules every time (see
 * signal-model.js). Exposes a combined API that index.js (the dashboard)
 * talks to.
 *
 * This file keeps the name `cricket-bot.js` only because index.js already
 * requires('./cricket-bot') — the actual logic now lives in
 * engine-factory.js / candles.js / signal-model.js / patterns.js.
 */

const path = require('path');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const CAPITAL_5M = Number(process.env.CAPITAL_5M || process.env.STARTING_CAPITAL_5M || 2000);
const CAPITAL_15M = Number(process.env.CAPITAL_15M || process.env.STARTING_CAPITAL_15M || 2000);
const BASE_BET_5M = Number(process.env.BASE_BET_5M || 100);
const BASE_BET_15M = Number(process.env.BASE_BET_15M || 100);
const CONFIDENCE_5M = Number(process.env.CONFIDENCE_THRESHOLD_5M || process.env.CONFIDENCE_THRESHOLD || 0.55);
const CONFIDENCE_15M = Number(process.env.CONFIDENCE_THRESHOLD_15M || process.env.CONFIDENCE_THRESHOLD || 0.55);

let trader = null;
let engines = null; // { m5, m15 }

async function init(privateKey, emit, slogFn) {
  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  const m5 = createEngine({
    label: 'BTC-5m',
    windowSeconds: 300,
    slugPrefix: 'btc-updown-5m-',
    binanceInterval: '5m',
    statsStatePath: process.env.STATS_STATE_PATH_5M || path.join(__dirname, 'stats-state-5m.json'),
    startingCapital: CAPITAL_5M,
    baseBetDollars: BASE_BET_5M,
    confidenceThreshold: CONFIDENCE_5M,
    trader,
    dryRun: DRY_RUN,
  });

  const m15 = createEngine({
    label: 'BTC-15m',
    windowSeconds: 900,
    slugPrefix: 'btc-updown-15m-',
    binanceInterval: '15m',
    statsStatePath: process.env.STATS_STATE_PATH_15M || path.join(__dirname, 'stats-state-15m.json'),
    startingCapital: CAPITAL_15M,
    baseBetDollars: BASE_BET_15M,
    confidenceThreshold: CONFIDENCE_15M,
    trader,
    dryRun: DRY_RUN,
  });

  engines = { m5, m15 };

  slogFn('[hedgebot] 🪙 Running TWO independent FIXED RULE engines (no learning): BTC 5-minute and BTC 15-minute Up/Down — separate candle history, separate bankroll, separate win rate for each, but identical fixed scoring rules.');

  await Promise.all([m5.start(emit, slogFn), m15.start(emit, slogFn)]);
}

function requireEngines() {
  if (!engines) throw new Error('Engines not initialized yet');
  return engines;
}

/** engineKey: 'm5' | 'm15' | undefined (undefined = apply to both) */
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
