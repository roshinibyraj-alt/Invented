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

# ---- Engine B (interval accumulation strategy) -------------------------
# Phase 1: cheap-side scalping.
#   Every ENGINE_B_INTERVAL_SECONDS from ENGINE_B_PHASE1_START to
#   ENGINE_B_PHASE1_END (inclusive), look at both sides and buy the
#   CHEAPER one with ENGINE_B_PHASE1_SHARES shares, but only if that
#   cheaper price is below ENGINE_B_PHASE1_MAX_PRICE. Otherwise skip
#   that tick. The side bought can differ from check to check.
ENGINE_B_INTERVAL_SECONDS = 15
ENGINE_B_PHASE1_START = 15
ENGINE_B_PHASE1_END = 120
ENGINE_B_PHASE1_SHARES = 20
ENGINE_B_PHASE1_MAX_PRICE = 0.40

# Phase 2: expensive-side momentum buying.
#   Every ENGINE_B_INTERVAL_SECONDS from ENGINE_B_PHASE2_START to
#   ENGINE_B_PHASE2_END (inclusive), look at both sides and buy the
#   MORE EXPENSIVE one with ENGINE_B_PHASE2_SHARES shares, but only if
#   that price is above ENGINE_B_PHASE2_MIN_PRICE. Otherwise skip that
#   tick.
ENGINE_B_PHASE2_START = 135
ENGINE_B_PHASE2_END = 255
ENGINE_B_PHASE2_SHARES = 40
ENGINE_B_PHASE2_MIN_PRICE = 0.60

# No stop loss / take profit / doubling -- every fill from both phases
# is held and settled at window close against the real outcome.

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
