"""
Candle-pattern BTC 5-minute up/down paper bot.

The 5-minute window is divided into 5 one-minute candles (the UP-side
CLOB mid price is the candle basis: mid rising over the minute = green,
falling = red). After the first 3 candles close:

  buy DOWN on: GRR, GGR, RGR  (3rd candle red)
  buy UP on:    RRG, RGG, GRG  (exact opposites)
  RRR and GGG -> no trade

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

# Signal patterns (first 3 one-minute candles).
# "R" = red candle (UP mid fell), "G" = green candle (UP mid rose).
BUY_DOWN_PATTERNS = [("green", "green", "red"), ("green", "red", "red"), ("red", "green", "red")]
BUY_UP_PATTERNS   = [("red", "red", "green"),   ("red", "green", "green"), ("green", "red", "green")]

# ---- Trading fees -----------------------------------------------------
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -------------------------------------------------------------
LOG_MAX_ENTRIES = 500
