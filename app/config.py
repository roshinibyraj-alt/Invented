"""
Central configuration for the BTC 5-min breakout-limit-buy bot.

Strategy (see app/engine.py for full write-up):
  1. Wait 60 seconds after window opens. No action before that.
  2. After 60s, monitor both sides. The first side to tick above 0.75
     becomes the "tracked side" for this window.
  3. Place a resting BUY limit order at (current_price − 0.10).
     As price ticks higher, the limit order price updates dynamically:
       - price hits 0.75 → limit buy at 0.65
       - price hits 0.85 → limit buy at 0.75
       - price hits 0.95 → limit buy at 0.85
       - etc.
  4. 100 shares per fill.
  5. Stop loss at 0.50 applies immediately on fill.
  6. Take profit at 0.99 (resting limit sell).
  7. If neither TP nor SL hits by window close, position settles at
     Polymarket's real binary resolution ($1/share win, $0/share loss).
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / pricing ---------------------------------------
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# ---- Strategy ----------------------------------------------------------
WAIT_SECONDS = 60           # wait this long after window opens
BREAKOUT_THRESHOLD = 0.75   # side must tick above this to start laddering
LIMIT_OFFSET = 0.10         # limit buy = current_price − this
SHARES_PER_FILL = 100       # flat 100 shares per fill
SL_PRICE = 0.50             # stop loss (market sell) — applies immediately on fill
TP_PRICE = 0.99             # take profit (resting limit sell)

# ---- Fees --------------------------------------------------------------
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Capital -----------------------------------------------------------
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Misc ---------------------------------------------------------------
LOG_MAX_ENTRIES = 500
