'use strict';

/**
 * Manager module — instantiates TWO independent SIMPLE price-band engines
 * (5-minute and 15-minute BTC Up/Down). No indicators, no patterns, no
 * candles, no learning — pure mechanical rule (see engine-factory.js).
 *
 * This file keeps the name `cricket-bot.js` only because index.js already
 * requires('./cricket-bot') — the actual logic lives in engine-factory.js.
 */

const path = require('path');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const CAPITAL_5M = Number(process.env.CAPITAL_5M || process.env.STARTING_CAPITAL_5M || 2000);
const CAPITAL_15M = Number(process.env.CAPITAL_15M || process.env.STARTING_CAPITAL_15M || 2000);
const BET_DOLLARS = Number(process.env.BET_DOLLARS || 50);
const PRICE_LOW = Number(process.env.PRICE_LOW || 0.10);
const PRICE_HIGH = Number(process.env.PRICE_HIGH || 0.20);
// Reference rule is defined for the 5-minute window: check between 240s-290s
// of the 300s window. The 15-minute window scales this proportionally
// (240/300=0.8 -> 720s, 290/300=0.9667 -> 870s) unless overridden.
const CHECK_START_5M = Number(process.env.CHECK_START_SEC_5M || 240);
const CHECK_END_5M = Number(process.env.CHECK_END_SEC_5M || 290);
const CHECK_START_15M = Number(process.env.CHECK_START_SEC_15M || Math.round(240 * (900 / 300)));
const CHECK_END_15M = Number(process.env.CHECK_END_SEC_15M || Math.round(290 * (900 / 300)));

let trader = null;
let engines = null; // { m5, m15 }

async function init(privateKey, emit, slogFn) {
  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  const m5 = createEngine({
    label: 'BTC-5m',
    windowSeconds: 300,
    slugPrefix: 'btc-updown-5m-',
    statsStatePath: process.env.STATS_STATE_PATH_5M || path.join(__dirname, 'stats-state-5m.json'),
    startingCapital: CAPITAL_5M,
    betDollars: BET_DOLLARS,
    priceLow: PRICE_LOW,
    priceHigh: PRICE_HIGH,
    checkStartSec: CHECK_START_5M,
    checkEndSec: CHECK_END_5M,
    trader,
    dryRun: DRY_RUN,
  });

  const m15 = createEngine({
    label: 'BTC-15m',
    windowSeconds: 900,
    slugPrefix: 'btc-updown-15m-',
    statsStatePath: process.env.STATS_STATE_PATH_15M || path.join(__dirname, 'stats-state-15m.json'),
    startingCapital: CAPITAL_15M,
    betDollars: BET_DOLLARS,
    priceLow: PRICE_LOW,
    priceHigh: PRICE_HIGH,
    checkStartSec: CHECK_START_15M,
    checkEndSec: CHECK_END_15M,
    trader,
    dryRun: DRY_RUN,
  });

  engines = { m5, m15 };

  slogFn(`[hedgebot] 🪙 Running TWO independent SIMPLE price-band engines: BTC 5-minute (check ${CHECK_START_5M}s-${CHECK_END_5M}s) and BTC 15-minute (check ${CHECK_START_15M}s-${CHECK_END_15M}s) Up/Down — separate bankroll, separate win rate. No indicators, no patterns, no learning — same mechanical rule every window.`);

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
