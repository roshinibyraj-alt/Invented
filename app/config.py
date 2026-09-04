"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Everything that tunes strategy behavior lives here so Engine A / Engine B
logic files stay readable.
"""
import os

# ---- Mode -------------------------------------------------------------
# "paper" = simulate fills against live Polymarket prices, no real orders.
# "live"  = NOT IMPLEMENTED YET. Placeholder for when real order routing
#           via py-clob-client is wired in.
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Capital ------------------------------------------------------------
STARTING_BALANCE_USDC = float(os.getenv("STARTING_BALANCE_USDC", "5000"))

# ---- Market discovery ---------------------------------------------------
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

# How often the price-polling loop ticks. Polymarket CLOB has no public
# free websocket for anonymous market-data reads in every deployment, so
# we poll. 1s is a reasonable balance of freshness vs. rate limits; drop
# to 0.5s if your host allows it and you see PMF need for tighter timing.
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# How many seconds before window close counts as the "resolution window"
# for the logging-only 0.90+ signal.
RESOLUTION_WINDOW_SECONDS = 2.0

# ---- Engine A -------------------------------------------------------------
ENGINE_A_BASE_SHARES = 100
ENGINE_A_LIMIT_PRICE = 0.30
ENGINE_A_ARM_PRICE = 0.60      # price that must be touched to arm the guard
ENGINE_A_GUARD_EXIT_PRICE = 0.50  # if price falls back to this after arming, sell
ENGINE_A_RESOLUTION_PRICE = 0.90

# ---- Engine B -------------------------------------------------------------
ENGINE_B_BASE_SHARES = 200
ENGINE_B_TRIGGER_PRICE = 0.70
ENGINE_B_STOP_LOSS_PRICE = 0.50
ENGINE_B_RESOLUTION_PRICE = 0.90
ENGINE_B_MARTINGALE_MULTIPLIER = 2

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500  # trade/event log kept in memory for the dashboard
