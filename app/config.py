"""
Single-engine BTC 5-minute up/down paper bot.

Strategy: dip-recovery
  From window open watch both sides' mid prices. Whichever side first
  dips below 0.30 is flagged. When the flagged side returns to 0.48,
  the bot places a resting LIMIT buy order at 0.48 (so it never fills
  worse than 0.48) for a flat 500 shares. Fill is confirmed by price
  walk-through: once the ask trades at/below 0.48, the order is booked
  filled at 0.48. No stop loss. TP at 0.99 (redeem $1.00/share,
  fee-free). Max one trade per window.

Demo capital: $4,500. CLOB-only pricing, no fallback.
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / pricing ---------------------------------------
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "0.5"))

# ---- Strategy ---------------------------------------------------------
DIP_THRESHOLD = 0.30            # single dip level — flag whichever side first dips below this
ENTRY_RECOVERY = 0.48           # flagged side returning to this mid fires the limit order
ENTRY_LIMIT = 0.48              # resting limit buy price — never fills worse than 0.48
ENTRY_SHARES = 500              # flat share size per window
TP_PRICE = 0.99                 # take profit: mid >= this -> redeem at $1.00
WAIT_AFTER_OPEN_SECONDS = 5     # don't start monitoring dip until 5s after window opens
STARTING_CAPITAL = 4500.0

# ---- Trading fees -----------------------------------------------------
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -------------------------------------------------------------
LOG_MAX_ENTRIES = 500
