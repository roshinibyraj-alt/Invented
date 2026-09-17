"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- one trade per window, direction decided by the color
of BTC's own second 1-minute spot candle (from Binance, via websocket):

  1. Minute 1 (0-60s of the window): no action -- just elapses while
     Binance's first 1-minute candle for this window forms.
  2. Minute 2 (60-120s of the window): once THIS candle closes (its
     Binance kline event arrives with x=true), compare its close to its
     open:
       - close > open (green) -> buy DOWN
       - close < open (red)   -> buy UP
       - close == open (flat) -> no trade this window
     Binance's spot price is used ONLY to decide the color -- it never
     prices or executes anything. The actual entry is a real TAKER buy
     against Polymarket's own order book (real depth-weighted fill,
     real fee), fired the instant the candle closes and its color is
     known.
  3. No stop-loss. Take profit is fixed at TP_PRICE (0.99) -- a real
     taker sell, priced by walking actual book depth, the moment the
     bid reaches it.
  4. No re-arming: one entry per window, maximum. If TP never hits, the
     position is force-closed at window end (taker, real depth-weighted
     price).

If Binance's data for the relevant candle hasn't arrived yet by the
120s mark (feed lag, reconnect, etc.), the engine keeps checking every
tick and fires the instant it becomes available -- it does not guess or
skip just because it's a little late, though obviously a decision can
no longer be acted on once the window itself has closed.
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / pricing ---------------------------------------
# CLOB only -- no Gamma price fallback anywhere in this app. Gamma is
# used purely for one-time window metadata (slug -> token ids) in
# polymarket_client.py; every live price/book read goes to CLOB.
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# ---- Candle-color engine ------------------------------------------------
BASE_SHARES = 500.0
SIGNAL_MINUTE_OFFSET = 60    # the decision candle is the one starting this many seconds after window open
SIGNAL_MINUTE_DURATION = 60  # ...and running for this long (i.e. covers window_open+60s to +120s)
TP_PRICE = 0.99

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "10000"))

# ---- Trading fees -----------------------------------------------------
# Every fill in this engine is a taker market order -- the entry, the
# TP exit, and any forced window-end close all pay the real fee, priced
# by walking real order-book depth. Verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
