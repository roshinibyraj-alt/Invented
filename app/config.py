"""
Candle-pattern BTC 5-minute up/down paper bot.

The 5-minute window is divided into 5 one-minute candles. Candle color
is determined by the real Binance BTCUSDT spot price (spot rising over
the minute = green candle, falling = red candle) -- NOT the CLOB
probability price, which drifts with time decay.

Two independent signals per window (up to 2 trades):

  Trade #1 (after candle 2): C1/C2 = red,green -> buy UP
                             C1/C2 = green,red -> buy DOWN
                             same color -> no first trade

  Trade #2 (after candle 3, existing setup): C3 must differ from C2.
    3rd green (2nd red) -> buy UP
    3rd red   (2nd green) -> buy DOWN
    same color on C2/C3 (GRR, RGG, RRR, GGG) -> no second trade

Trades: flat ENTRY_SHARES at the current ask (immediate taker), per
signal. No stop-loss. TP at 0.99 (redeem $1.00/share, fee-free);
otherwise settle by the inferred CLOB winner.

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

# ---- Binance spot feed (candle color only) -----------------------------
BINANCE_API_BASE = os.getenv("BINANCE_API_BASE", "https://api.binance.com")
BINANCE_WS_URL = os.getenv("BINANCE_WS_URL",
                           "wss://stream.binance.com:9443/ws/btcusdt@aggTrade")
BINANCE_SYMBOL = "BTCUSDT"

# ---- Candle-pattern strategy -------------------------------------------
CANDLE_SECONDS = 60                     # one-minute candles within the 5-min window
FIRST_SIGNAL_CANDLES = 2                # trade #1 uses the first 2 candles (RG->UP, GR->DOWN)
PATTERN_CANDLES = 3                     # trade #2 uses the first 3 candles (C3 must differ from C2)
ENTRY_SHARES = 500                      # flat share size per window
TP_PRICE = 0.99                         # take profit: mid >= this -> redeem at $1.00
STARTING_CAPITAL = 4500.0

# ---- Trading fees -----------------------------------------------------
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -------------------------------------------------------------
LOG_MAX_ENTRIES = 500
