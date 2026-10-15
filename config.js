'use strict';

module.exports = {
  DEMO_CAPITAL: 10000,
  ENTRY_RUNGS: [
    { movePct: 25, shares: 100 },
    { movePct: 50, shares: 200 },
    { movePct: 75, shares: 300 },
    { movePct: 90, shares: 400 },
  ],
  DEMO_CAPITAL_5M: 10000,
  MIN_ENTRY_ASK: 0.05,
  MAX_ENTRY_ASK: 0.60,
  WINDOW_MS: 5 * 60 * 1000,
  ENTRY_CUTOFF_MS: 150 * 1000,
  RUNG_DELAY_MS: 2000,
  POLL_INTERVAL_MS: 500,
  MARKET_REFRESH_MS: 10000,
  CANDLE_REFRESH_MS: 1000,
  FEE_RATE: 0.07,
};
