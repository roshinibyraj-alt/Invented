'use strict';

module.exports = {
  DEMO_CAPITAL: 10000,
  ENTRY_RUNGS: [
    { movePct: 25, shares: 100 },
    { movePct: 50, shares: 200 },
    { movePct: 75, shares: 300 },
    { movePct: 90, shares: 400 },
  ],
  DEMO_CAPITAL_15M: 10000,
  DEMO_CAPITAL_5M: 10000,
  MIN_ENTRY_ASK: 0.05,
  MAX_ENTRY_ASK: 0.60,
  WINDOW_MS: 15 * 60 * 1000,
  POLL_INTERVAL_MS: 3000,
  MARKET_REFRESH_MS: 15000,
  CANDLE_REFRESH_MS: 3000,
  FEE_RATE: 0.07,
};
