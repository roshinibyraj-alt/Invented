'use strict';

module.exports = {
  DEMO_CAPITAL: 300,
  DEMO_CAPITAL_5M: 300,
  WINDOW_MS_5M: 5 * 60 * 1000,
  ENTRY_ORDER_TTL_MS: 180 * 1000,
  ENTRY_RUNGS: [
    { price: 0.10, shares: 100, takeProfitPrice: 0.20 },
    { price: 0.05, shares: 100, takeProfitPrice: 0.10 },
  ],
  CRYPTO_TAKER_FEE_RATE: 0.07,
  CRYPTO_MAKER_REBATE_RATE: 0.20,
  POLL_INTERVAL_MS: 500,
  MARKET_REFRESH_MS: 10000,
  RESOLUTION_POLL_MS: 5000,
};
