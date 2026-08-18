'use strict';

const path = require('path');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');
const { PriceStream } = require('./ws-prices');

const DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const CAPITAL_5 = Number(process.env.CAPITAL_5 || process.env.CAPITAL || 4000);
const CAPITAL_15 = Number(process.env.CAPITAL_15 || 4000);
const ENTRY_PRICE = Number(process.env.ENTRY_PRICE || 0.60);
const STOP_LOSS_PRICE = Number(process.env.STOP_LOSS_PRICE || 0.49);
const ENTRY_DOLLARS = Number(process.env.ENTRY_DOLLARS || 50);
const MARTINGALE_MULTIPLIER = Number(process.env.MARTINGALE_MULTIPLIER || 1.5);
const MAX_MARTINGALE_LEVELS = Number(process.env.MAX_MARTINGALE_LEVELS || 1);
const WAIT_SECONDS_5 = Number(process.env.WAIT_SECONDS_5 || 0);
const WAIT_SECONDS_15 = Number(process.env.WAIT_SECONDS_15 || 0);
const FEE_THETA = Number(process.env.FEE_THETA || 0.07);
const REBATE_PCT = Number(process.env.REBATE_PCT || 0);

let trader = null;
let engine5 = null;
let engine15 = null;
let priceStream = null;

function makeSlog(slogFn, label) {
  return (line) => slogFn(line);
}

async function init(privateKey, emit, slogFn) {
  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  const slog5 = makeSlog(slogFn, '5m');
  const slog15 = makeSlog(slogFn, '15m');

  engine5 = createEngine({
    label: 'BTC-5m',
    windowType: '5m',
    startingCapital: CAPITAL_5,
    entryPrice: ENTRY_PRICE,
    stopLossPrice: STOP_LOSS_PRICE,
    entryDollars: ENTRY_DOLLARS,
    martingaleMultiplier: MARTINGALE_MULTIPLIER,
    maxMartingaleLevels: MAX_MARTINGALE_LEVELS,
    waitSeconds5: WAIT_SECONDS_5,
    windowSeconds5: 300,
    feeTheta: FEE_THETA,
    rebatePct: REBATE_PCT,
    statsStatePath: process.env.STATS_STATE_PATH || path.join(__dirname, 'stats-5m.json'),
    trader,
    dryRun: DRY_RUN,
    emit: (ev, data) => emit(ev, data),
    slog: slog5,
  });

  engine15 = createEngine({
    label: 'BTC-15m',
    windowType: '15m',
    startingCapital: CAPITAL_15,
    entryPrice: ENTRY_PRICE,
    stopLossPrice: STOP_LOSS_PRICE,
    entryDollars: ENTRY_DOLLARS,
    martingaleMultiplier: MARTINGALE_MULTIPLIER,
    maxMartingaleLevels: MAX_MARTINGALE_LEVELS,
    waitSeconds5: WAIT_SECONDS_15,
    windowSeconds5: 900,
    feeTheta: FEE_THETA,
    rebatePct: REBATE_PCT,
    statsStatePath: process.env.STATS_STATE_PATH_15 || path.join(__dirname, 'stats-15m.json'),
    trader,
    dryRun: DRY_RUN,
    emit: (ev, data) => emit(ev, data),
    slog: slog15,
  });

  // WebSocket price streaming
  priceStream = new PriceStream({
    log: slogFn,
    onBookUpdate: (tokenId, prices) => {
      if (engine5) engine5.updateLegPrice(tokenId, prices);
      if (engine15) engine15.updateLegPrice(tokenId, prices);
    },
    onConnect: () => {
      if (engine5) engine5.setWsConnected(true);
      if (engine15) engine15.setWsConnected(true);
    },
    onDisconnect: () => {
      if (engine5) engine5.setWsConnected(false);
      if (engine15) engine15.setWsConnected(false);
    },
  });
  priceStream.connect();

  // Auto-subscribe when legs are discovered
  setInterval(() => {
    if (!priceStream) return;
    const subscribeEngine = (eng) => {
      if (!eng) return;
      const state = eng.buildState();
      const trades = [state.current?.btc, ...(state.pending || [])].filter(Boolean);
      for (const t of trades) {
        if (t.discovered && t.conditionId && t.upTokenId && t.downTokenId) {
          priceStream.subscribe(t.conditionId, [t.upTokenId, t.downTokenId]);
        }
      }
    };
    subscribeEngine(engine5);
    subscribeEngine(engine15);
  }, 2000);

  await engine5.start();
  await engine15.start();
}

function buildState() {
  return {
    m5: engine5 ? engine5.buildState() : null,
    m15: engine15 ? engine15.buildState() : null,
  };
}

function pauseTrading() {
  if (engine5) engine5.pauseTrading();
  if (engine15) engine15.pauseTrading();
  return { ok: true };
}
function resumeTrading() {
  if (engine5) engine5.resumeTrading();
  if (engine15) engine15.resumeTrading();
  return { ok: true };
}
function setMode(live) {
  if (engine5) engine5.setMode(live);
  if (engine15) engine15.setMode(live);
  return { ok: true };
}

module.exports = { init, buildState, pauseTrading, resumeTrading, setMode };
