'use strict';

// Strategy: trade the first qualifying pullback inside the prior BTC 5-minute candle's range.
module.exports = {
  DEMO_CAPITAL: 5000,
  BTC_SYMBOL: 'BTCUSDT',
  BTC_INTERVAL: '5m',
  BASE_SHARES: 500,
  ENTRY_DELAY_MS: 120000,
  MAX_ENTRY_ASK: 0.40,
  PRICE_CAP: 0.99,
  END_WATCH_MS: 3000,
  WIN_PRICE: 0.96,
  TAKER_FEE_RATE: 0.07,
};
