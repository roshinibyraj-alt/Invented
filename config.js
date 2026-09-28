'use strict';

// All strategy constants live here (the only Railway env var is PRIVATE_KEY).
module.exports = {
  STREAK_LEN: 3,               // consecutive same-color closed 5m candles that trigger a bet
  DEMO_STARTING_CAPITAL: 5000, // starting simulated balance in DEMO mode
  BASE_SHARES: 100,            // base stake in shares
  MAX_LOSS_DOUBLINGS: 2,       // 100 -> 200 -> 400, a 3rd straight loss resets to base
  MAX_WIN_DOUBLINGS: 1,        // 100 -> 200, a 2nd straight win resets to base
  SHARED_LADDER: false,        // false = separate sizing ladder per side (UP / DOWN)

  ENTRY_DELAY_MS: 3000,        // first check 3s after the window opens
  ENTRY_DEADLINE_MS: 270000,   // no entry after 270s -> window is void
  SETTLEMENT_CHECK_AFTER_MS: 297000, // start outcome checks 3s before window close
  SETTLEMENT_PRICE_THRESHOLD: 0.95,  // winning side must have a higher CLOB midpoint
  PRICE_TRIGGER: 0.50,         // fire when best ask is strictly below this
  PRICE_CAP: 0.99,             // order limit = highest tick, so a fired order fills at any price (no slippage kill)

  TAKER_FEE_RATE: 0.07,        // fee = shares * rate * p * (1-p), used for P&L estimate only
};
