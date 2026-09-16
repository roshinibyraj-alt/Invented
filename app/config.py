"""
Dual-strategy BTC 5-minute up/down paper bot.

Two strategies share one position slot per window:

Strategy A (dip-recovery):
  Dip below 0.30 → recover to 0.48 → limit buy 500sh @ 0.48

Strategy B (spike-reversal):
  Spike above 0.70 → return to 0.50 → limit buy 500sh @ 0.48

Both: TP at 0.99 (redeem $1.00/share, fee-free), no SL.
Alternation: A starts active. Win → swap for next window. Loss → same.

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

# ---- Shared strategy params --------------------------------------------
ENTRY_LIMIT = 0.48              # resting limit buy price (same for both strategies)
ENTRY_SHARES = 500              # flat share size per window
TP_PRICE = 0.99                 # take profit: mid >= this -> redeem at $1.00
WAIT_AFTER_OPEN_SECONDS = 5     # wait after window opens before monitoring
STARTING_CAPITAL = 4500.0

# ---- Strategy A: dip-recovery -------------------------------------------
DIP_THRESHOLD = 0.30            # flag whichever side first dips below this
ENTRY_RECOVERY = 0.48           # flagged side returning to this mid fires limit order

# ---- Strategy B: spike-reversal -----------------------------------------
SPIKE_THRESHOLD = 0.70          # flag whichever side first spikes above this
B_RECOVERY = 0.50               # flagged side returning to this mid fires limit order

# ---- Trading fees -----------------------------------------------------
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -------------------------------------------------------------
LOG_MAX_ENTRIES = 500
