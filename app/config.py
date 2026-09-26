"""Runtime configuration for the real single-candle contrarian bot."""
import os


TRADING_MODE = os.getenv("TRADING_MODE", "live").strip().lower()
if TRADING_MODE not in {"live", "paper"}:
    raise ValueError("TRADING_MODE must be 'live' or 'paper'")

# Live credentials are read only from the runtime environment. Never commit
# the private key or derived CLOB credentials to the repository.
POLYMARKET_PRIVATE_KEY = os.getenv("POLYMARKET_PRIVATE_KEY", "").strip()

GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = os.getenv("SLUG_PREFIX", "btc-updown-5m-")
WINDOW_SECONDS = 300
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

BINANCE_SYMBOL = os.getenv("BINANCE_SYMBOL", "BTCUSDT")
CANDLE_HISTORY_MAXLEN = 20

# The signal trades one side at the first available ask of each new window.
TAKE_PROFIT_PRICE = 0.99
PROFIT_TARGET_USD = 500.0
SLEEP_WINDOWS = 3

# Dollar ladder. Losses move one dollar up; wins move one dollar down.
BASE_TRADE_USD = 1.0
TRADE_STEP_USD = 1.0
MAX_TRADE_USD = 8.0

# Absolute token-price tolerance around the observed best quote. Orders are
# FOK limit orders, so they remain takers while refusing worse fills.
SLIPPAGE_CEILING = 0.30

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))
LOG_MAX_ENTRIES = 500
