'use strict';

module.exports = {
  DEMO_CAPITAL: 3000,
  WINDOW_MS_5M: 5 * 60 * 1000,
  ENTRY_SHARES: 100,
  CROSS_PAIR_MIN_ENTRY_PRICE: 0.20,
  CROSS_PAIR_ENTRY_CUTOFF_MS: 270 * 1000,
  CROSS_PAIR_ENTRY_TIERS: [
    { id: 'tier-060-050', label: 'Leader ≥ $0.60 · target < $0.50', leaderMinPrice: 0.60, targetMaxPriceExclusive: 0.50, sharesPerFire: 100 },
    { id: 'tier-070-060', label: 'Leader ≥ $0.70 · target < $0.60', leaderMinPrice: 0.70, targetMaxPriceExclusive: 0.60, sharesPerFire: 100 },
    { id: 'tier-080-070', label: 'Leader ≥ $0.80 · target < $0.70', leaderMinPrice: 0.80, targetMaxPriceExclusive: 0.70, sharesPerFire: 100 },
    { id: 'tier-090-080', label: 'Leader ≥ $0.90 · target < $0.80', leaderMinPrice: 0.90, targetMaxPriceExclusive: 0.80, sharesPerFire: 100 },
  ],
  CROSS_PAIR_MAX_ENTRY_PRICE: 0.99,
  CRYPTO_TAKER_FEE_RATE: 0.07,
  CRYPTO_MAKER_REBATE_RATE: 0.20,
  POLL_INTERVAL_MS: 500,
  MARKET_REFRESH_MS: 10000,
  RESOLUTION_POLL_MS: 5000,
};
