"""
Single-engine BTC 5-minute up/down paper bot.

Strategy: dip-recovery
  After the window opens, track how long each side stays consecutively
  below 0.40. If the timer resets (price bounces back above 0.40) it
  starts over. Once either side has been below 0.40 for more than 10
  seconds straight, that side is flagged as "dipped". The bot then
  waits for the flagged side's mid to recover to 0.50 and buys 500
  shares as a taker at the current ask (no limit waiting -- immediate
  fill). SL at 0.10 (taker sell). TP at 0.99 (redeem $1.00/share,
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
DIP_THRESHOLD = 0.45            # price must be below this to count as "deep"
# no consecutive timer — just watch which side dips below DIP_THRESHOLD
ENTRY_RECOVERY = 0.50           # flagged side must reach this mid to trigger entry
SL_PRICE = 0.10                 # stop loss: mid <= this -> taker sell
TP_PRICE = 0.99                 # take profit: mid >= this -> redeem at $1.00

ORDER_SHARES = 500.0            # flat share count per entry
STARTING_CAPITAL = 4500.0

# ---- Trading fees -----------------------------------------------------
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -------------------------------------------------------------
LOG_MAX_ENTRIES = 500
