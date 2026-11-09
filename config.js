'use strict';

module.exports = {
  DEMO_CAPITAL: 3000,
  WINDOW_MS_5M: 5 * 60 * 1000,
  ENTRY_SHARES: 100,
  CROSS_PAIR_ENTRY_TIERS: [
    { id: 'tier-080', label: 'At or below $0.80', combinedAskThreshold: 0.80, comparison: 'LTE', sharesPerLeg: 100 },
    { id: 'tier-070', label: 'At or below $0.70', combinedAskThreshold: 0.70, comparison: 'LTE', sharesPerLeg: 100 },
    { id: 'tier-060', label: 'At or below $0.60', combinedAskThreshold: 0.60, comparison: 'LTE', sharesPerLeg: 100 },
    { id: 'tier-050', label: 'At or below $0.50', combinedAskThreshold: 0.50, comparison: 'LTE', sharesPerLeg: 100 },
    { id: 'tier-040', label: 'At or below $0.40', combinedAskThreshold: 0.40, comparison: 'LTE', sharesPerLeg: 100 },
  ],
  CROSS_PAIR_MAX_ENTRY_PRICE: 0.99,
  CRYPTO_TAKER_FEE_RATE: 0.07,
  CRYPTO_MAKER_REBATE_RATE: 0.20,
  POLL_INTERVAL_MS: 500,
  MARKET_REFRESH_MS: 10000,
  RESOLUTION_POLL_MS: 5000,
};
