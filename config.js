'use strict';

// All strategy constants live here. Real orders only when LIVE_TRADING=true (demo otherwise).
module.exports = {
  STREAK_LEN: 3,               // consecutive same-side window winners that trigger a bet
  BASE_SHARES: 100,            // base stake in shares
  MAX_LOSS_DOUBLINGS: 2,       // 100 -> 200 -> 400, a 3rd straight loss resets to base
  MAX_WIN_DOUBLINGS: 1,        // 100 -> 200, a 2nd straight win resets to base
  SHARED_LADDER: false,        // false = separate sizing ladder per side (UP / DOWN)

  // Who won a window: in the last END_WATCH_MS before it closes, a side priced above WIN_PRICE wins.
  // If neither side gets there, the bot falls back to Polymarket's official resolution.
  END_WATCH_MS: 3000,
  WIN_PRICE: 0.96,

  // Entry: no price filter. One order, ENTRY_DELAY_MS after the window opens, filled at any price.
  ENTRY_DELAY_MS: 3000,
  SIGNAL_DEADLINE_MS: 30000,   // if the signal isn't known within 30s of open, skip the window (no late entries)
  PRICE_CAP: 0.99,             // order limit = highest tick, so a fired order fills at any price

  TAKER_FEE_RATE: 0.07,        // fee = shares * rate * p * (1-p), used for P&L estimate only
};
