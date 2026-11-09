'use strict';

module.exports = {
  DEMO_CAPITAL: 10000,
  WINDOW_MS_5M: 5 * 60 * 1000,
  ENTRY_SHARES: 200,
  CROSS_PAIR_ENTRY_TIERS: [
    { id: 'base-090', label: 'Base below $0.90', combinedAskThreshold: 0.90, comparison: 'LT', sharesPerLeg: 200 },
    { id: 'add-080', label: 'Add at $0.80', combinedAskThreshold: 0.80, comparison: 'LTE', sharesPerLeg: 300 },
    { id: 'add-070', label: 'Add at $0.70', combinedAskThreshold: 0.70, comparison: 'LTE', sharesPerLeg: 300 },
    { id: 'add-060', label: 'Add at $0.60', combinedAskThreshold: 0.60, comparison: 'LTE', sharesPerLeg: 300 },
    { id: 'add-050', label: 'Add at $0.50', combinedAskThreshold: 0.50, comparison: 'LTE', sharesPerLeg: 300 },
  ],
  CROSS_PAIR_MAX_ENTRY_PRICE: 0.99,
  CRYPTO_TAKER_FEE_RATE: 0.07,
  CRYPTO_MAKER_REBATE_RATE: 0.20,
  POLL_INTERVAL_MS: 500,
  MARKET_REFRESH_MS: 10000,
  RESOLUTION_POLL_MS: 5000,
};
