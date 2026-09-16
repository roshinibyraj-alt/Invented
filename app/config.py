"""
Candle-pattern BTC 5-minute up/down paper bot.

The 5-minute window is divided into 5 one-minute candles (the UP-side
CLOB mid price is the candle basis: mid rising over the minute = green,
falling = red). After the first 3 candles close:

  Signal: trade only when 3rd candle differs from 2nd candle.
    3rd green (2nd red) -> buy UP
    3rd red   (2nd green) -> buy DOWN
  Same color on C2/C3 (GRR, RGG, RRR, GGG) -> no trade

Trade: flat ENTRY_SHARES at the current ask (immediate taker), one
trade max per window. No stop-loss. TP at 0.99 (redeem $1.00/share,
fee-free); otherwise settle by the inferred CLOB winner.

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

# ---- Candle-pattern strategy -------------------------------------------
CANDLE_SECONDS = 60                     # one-minute candles within the 5-min window
PATTERN_CANDLES = 3                     # use the first 3 candles for the pattern
ENTRY_SHARES = 500                      # flat share size per window
TP_PRICE = 0.99                         # take profit: mid >= this -> redeem at $1.00
STARTING_CAPITAL = 4500.0

# ---- Trading fees -----------------------------------------------------
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -------------------------------------------------------------
LOG_MAX_ENTRIES = 500
