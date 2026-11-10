'use strict';

module.exports = {
  DEMO_CAPITAL: 3000,
  WINDOW_MS_5M: 5 * 60 * 1000,
  ENTRY_SHARES: 100,
  CROSS_PAIR_ENTRY_TIERS: [
    { id: '0.90', label: 'Combined asks < $0.90', threshold: 0.90, strict: true, sharesPerFire: 100 },
    { id: '0.80', label: 'Combined asks ≤ $0.80', threshold: 0.80, strict: false, sharesPerFire: 100 },
    { id: '0.70', label: 'Combined asks ≤ $0.70', threshold: 0.70, strict: false, sharesPerFire: 100 },
    { id: '0.60', label: 'Combined asks ≤ $0.60', threshold: 0.60, strict: false, sharesPerFire: 100 },
    { id: '0.50', label: 'Combined asks ≤ $0.50', threshold: 0.50, strict: false, sharesPerFire: 100 },
  ],
  CROSS_PAIR_MAX_ENTRY_PRICE: 0.99,
  CROSS_PAIR_SHARES_PER_LEG: 100,
  CRYPTO_TAKER_FEE_RATE: 0.07,
  CRYPTO_MAKER_REBATE_RATE: 0.20,
  POLL_INTERVAL_MS: 500,
  MARKET_REFRESH_MS: 10000,
  RESOLUTION_POLL_MS: 5000,
};
