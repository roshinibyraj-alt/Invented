"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Engine A has been removed. Engine B is the only strategy running.
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Capital ------------------------------------------------------------
STARTING_BALANCE_USDC = float(os.getenv("STARTING_BALANCE_USDC", "5000"))

# ---- Market discovery ---------------------------------------------------
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# How many seconds before window close counts as the "resolution window"
# for the logging-only 0.90+ signal.
RESOLUTION_WINDOW_SECONDS = 2.0

# How many seconds to retry Polymarket's real settlement outcome before
# falling back to a last-observed-price approximation.
RESOLUTION_RETRY_SECONDS = 6

# ---- Engine B ---------------------------------------------------------------
ENGINE_B_BASE_SHARES = 200

# Entry: wait this long after window open before taking any position.
ENGINE_B_ENTRY_WAIT_SECONDS = 45

# Entry must be below this price (buy the cheaper of the two sides).
ENGINE_B_ENTRY_MAX_PRICE = 0.70

# Exit tiers, keyed off the entry price:
#   entry <  ENGINE_B_LOW_TIER_MAX               -> TP at ENGINE_B_LOW_TIER_TP
#   entry >= ENGINE_B_HIGH_TIER_MIN               -> hold to resolution
#   entry in between (no rule given)              -> defaults to hold to
#                                                     resolution (a 0.50 TP
#                                                     would be a guaranteed
#                                                     loss above entry 0.50,
#                                                     so it can't extend
#                                                     into this band)
ENGINE_B_LOW_TIER_MAX = 0.30
ENGINE_B_LOW_TIER_TP = 0.50
ENGINE_B_HIGH_TIER_MIN = 0.60

# Stop loss: fixed offset below entry price (entry - offset).
ENGINE_B_STOP_LOSS_OFFSET = 0.15

# After entering, wait this long before arming the doubling watch.
ENGINE_B_POST_ENTRY_WAIT_SECONDS = 45

# Doubling trigger: fires once per window, the first time the *other*
# side (not the one held) prints inside this band.
ENGINE_B_DOUBLE_BAND_LOW = 0.70
ENGINE_B_DOUBLE_BAND_HIGH = 0.72

# Logging-only resolution signal (kept from the original design): a side
# printing >= this in the last RESOLUTION_WINDOW_SECONDS is logged as the
# likely winner. No action is taken on it -- positions are held to expiry
# or exited via TP/SL as normal.
ENGINE_B_RESOLUTION_PRICE = 0.90

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
