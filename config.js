'use strict';

// All strategy constants live here (the only Railway env var is PRIVATE_KEY).
module.exports = {
  STREAK_LEN: 3,               // consecutive close-to-close BTC 5m price moves that trigger a contrarian bet
  DEMO_STARTING_CAPITAL: 5000, // starting simulated balance in DEMO mode
  BASE_SHARES: 100,            // base stake in shares
  MAX_LOSS_DOUBLINGS: 2,       // 100 -> 200 -> 400, a 3rd straight loss resets to base
  MAX_WIN_DOUBLINGS: 1,        // 100 -> 200, a 2nd straight win resets to base
  SHARED_LADDER: false,        // false = separate sizing ladder per side (UP / DOWN)

  ENTRY_DELAY_MS: 3000,        // first check 3s after the window opens
  ENTRY_DEADLINE_MS: 270000,   // no entry after 270s -> window is void
  SETTLEMENT_PRICE_THRESHOLD: 0.99,  // latch a winner when either CLOB midpoint reaches this price
  PRICE_CAP: 0.99,             // maximum buy limit; FOK does not fill above this price

  TAKER_FEE_RATE: 0.07,        // fee = shares * rate * p * (1-p), used for P&L estimate only
};
