"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- one resting limit buy per window, direction decided by
the color of the PREVIOUS window's own last 1-minute Binance spot
candle (the 240-300s candle of the window that just closed):

  1. The instant a new window opens, read that candle (already closed
     by definition -- it ended exactly when this window began):
       - green (close > open) -> place a resting limit buy on UP,
         200 shares, @ 0.45
       - red   (close < open) -> place a resting limit buy on DOWN,
         200 shares, @ 0.45
       - flat  (close == open) -> no trade this window
     If Binance's data for that candle hasn't arrived yet right at the
     window boundary (feed lag), the engine keeps checking every tick
     and places the order the instant it becomes available.
  2. This is a real MAKER limit order -- it fills at its own exact
     price (0.45), no slippage, no fee, the moment that side's ask
     drops to/through it. It is NOT a taker/market buy.
  3. No stop-loss. Take profit is fixed at TP_PRICE (0.99) -- a real
     taker sell, priced by walking actual book depth, the moment the
     bid reaches it.
  4. Only one order, one trade max per window -- no re-arming. If the
     order never fills, it's cancelled at window end (no penalty, not
     a loss). If it fills but TP never hits, the position is
     force-closed at window end (taker, real depth-weighted price).

This completely replaces the previous "read minute 2 of THIS window"
strategy -- Binance is still signal-only (never prices or executes
anything), just reading a different candle now.
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

# ---- Previous-window-momentum engine -------------------------------------
ORDER_SHARES = 200.0
ORDER_PRICE = 0.45           # fixed absolute limit price, whichever side is signaled
SIGNAL_CANDLE_OFFSET = 240   # the decision candle is the previous window's [240s, 300s) minute
TP_PRICE = 0.99

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# The entry is a resting MAKER limit order -- it fills at its own exact
# price with no fee. Only the TP exit and any forced window-end close
# are TAKER market orders and pay the real fee, priced by walking real
# order-book depth. Verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
