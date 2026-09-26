"""Candle demo configuration and separate live execution settings."""
import os


# The simulation always stays paper-only. This switch controls only the
# independent real-order mirror, which cannot feed results into the engine.
TRADING_MODE = os.getenv("TRADING_MODE", "live").strip().lower()
if TRADING_MODE not in {"live", "paper"}:
    raise ValueError("TRADING_MODE must be 'live' or 'paper'")
PRIVATE_KEY = os.getenv("PRIVATE_KEY")
SLIPPAGE_CEILING = min(0.30, max(0.0, float(os.getenv("SLIPPAGE_CEILING", "0.30"))))

GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

BINANCE_SYMBOL = os.getenv("BINANCE_SYMBOL", "BTCUSDT")
CANDLE_HISTORY_MAXLEN = 20

# Single-candle contrarian strategy and exits.
ENGINE_TP_PRICE = 0.99
ENGINE_TP_COUNTS_AS = 1.00
ENGINE_PROFIT_TARGET_USD = 500.0
ENGINE_SLEEP_WINDOWS = 3
ENGINE2_SHARES = 500.0
MAKER_REBATE_FRACTION = 0.20

# Simulated balance and trading-fee accounting.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1
LOG_MAX_ENTRIES = 500