"""
Single-engine BTC 5-minute up/down paper bot.

Strategy: dip-recovery
  From window open watch both sides' mid prices. Whichever side first
  dips below 0.40 is flagged. When the flagged side recovers to 0.50,
  the bot buys shares sized CUMULATIVELY by how deep the dip went:
    below 0.40 -> 100 shares
    below 0.30 -> 100 + 200 = 300 shares
    below 0.20 -> 100 + 200 + 400 = 700 shares
    below 0.10 -> 100 + 200 + 400 + 800 = 1500 shares
  Taker fill at current ask. No stop loss. TP at 0.99 (redeem
  $1.00/share, fee-free). Max one trade per window.

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
DIP_THRESHOLD = 0.40            # price must be below this to count as "deep"
# no timer — watch which side dips below DIP_THRESHOLD
ENTRY_RECOVERY = 0.50           # flagged side must reach this mid to trigger entry
TP_PRICE = 0.99                 # take profit: mid >= this -> redeem at $1.00

# Tiered sizing (CUMULATIVE): each deeper tier adds its shares on top of
# the shallower ones.  E.g. dipped below 0.20 -> 100+200+400 = 700sh.
DIP_TIERS = [
    (0.40, 100),   # dipped below 0.40 -> +100 shares (total 100)
    (0.30, 200),   # dipped below 0.30 -> +200 shares (total 300)
    (0.20, 400),   # dipped below 0.20 -> +400 shares (total 700)
    (0.10, 800),   # dipped below 0.10 -> +800 shares (total 1500)
]
STARTING_CAPITAL = 4500.0

# ---- Trading fees -----------------------------------------------------
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -------------------------------------------------------------
LOG_MAX_ENTRIES = 500
