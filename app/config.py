"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Strategy: instant limit-order ladder on Engine B. No stop loss; every
fill takes profit at 0.99 if reached, otherwise holds to expiry and
settles against the real market outcome.
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

# ---- Engine B: limit-order ladder strategy -------------------------------
#
# At window open, place resting limit buy orders on BOTH sides, at
# every 0.01 increment from LADDER_HIGH down to LADDER_LOW inclusive,
# LADDER_SHARES each. As a side's price falls through a rung, that rung
# fills. No stop loss. Any side whose price reaches LADDER_TP_PRICE
# gets everything currently held on that side sold immediately (can
# fire more than once per window). Anything still held at window close
# settles against the real market outcome.
LADDER_HIGH = 0.49
LADDER_LOW = 0.02
LADDER_STEP = 0.01
LADDER_SHARES = 10
LADDER_TP_PRICE = 0.99

# ---- Fees ---------------------------------------------------------------
# Polymarket taker fee: fee = shares * FEE_RATE * price * (1 - price).
# Applied to every buy/sell in this bot (all fills treated as taker).
# Redemption at expiry is not a matched trade and is not fee'd.
TAKER_FEE_RATE = 0.07

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
