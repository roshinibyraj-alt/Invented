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

# ---- Engine B (v5 -- momentum-confirmed signal strategy) ---------------
# Replaces the old fixed-schedule "buy on a clock" approach entirely.
# A blind buy on every tick has no edge in an efficient market beyond
# whatever the fee/spread costs; this version only trades when a side
# shows real momentum AND sits in a sane confirmation price band, sizes
# by how strong that momentum is, and caps total exposure per window.
#
# Regular scan: every MOM_CHECK_INTERVAL_SECONDS from MOM_ENTRY_START to
# MOM_ENTRY_END, compare each side's current price to its price
# MOM_LOOKBACK_SECONDS ago. A side qualifies if it has risen by at least
# MOM_MIN_DELTA over that lookback AND its current price sits inside
# [MOM_CONFIRM_MIN_PRICE, MOM_CONFIRM_MAX_PRICE]. If both sides qualify,
# take the one with the stronger momentum. If neither qualifies, skip
# the tick -- no forced trade.
MOM_LOOKBACK_SECONDS = 20
MOM_MIN_DELTA = 0.03
MOM_NORMALIZE_DELTA = 0.12   # delta at/above which size scaling maxes out

MOM_CONFIRM_MIN_PRICE = 0.45
MOM_CONFIRM_MAX_PRICE = 0.80

MOM_CHECK_INTERVAL_SECONDS = 10
MOM_ENTRY_START = 20         # needs a full lookback of history first
MOM_ENTRY_END = 260

# Confidence-scaled sizing: BASE at the minimum qualifying momentum,
# scaling up to MAX as momentum strength approaches MOM_NORMALIZE_DELTA.
MOM_BASE_SHARES = 20
MOM_MAX_SHARES = 60

# Hard cap on total shares bought (either side combined) per window --
# a wrong read can't compound past this regardless of how many ticks
# keep signaling.
MOM_MAX_TOTAL_SHARES_PER_WINDOW = 260

# Late-window confirmation add: a single shot near the close. By then
# the fee curve is cheaper near the extremes and the "which side is
# winning" signal is at its most reliable -- but only if that side
# hasn't already gone parabolic (diminishing reward for the risk).
MOM_LATE_SNIPE_AT = 280
MOM_LATE_SNIPE_MIN_PRICE = 0.55
MOM_LATE_SNIPE_MAX_PRICE = 0.95
MOM_LATE_SNIPE_SHARES = 20

# Every fill (regular scan or late snipe) is held and settled at window
# close against the real outcome -- no stop loss / take profit / exit.

# ---- Trading fees ---------------------------------------------------------
# Polymarket taker fee (per docs.polymarket.com/trading/fees, Crypto
# category). Charged only on entry (buys); redemption/resolution is
# fee-free, and there is no maker fee since every fill here is a taker
# market order. Formula: fee = shares * price * FEE_RATE * (price * (1 - price)) ** FEE_EXPONENT
# NOTE: Polymarket has revised this fee schedule multiple times in 2026
# and third-party sources disagree on the exact current rate for the
# 5-min/15-min crypto sub-category specifically -- verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money. APPLY_TAKER_FEES can be set False to model a fee-free run.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
