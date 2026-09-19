"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- one entry attempt EVERY window (no-skip mode).
Direction is decided by an AI signal engine (app/ai_signal.py)
predicting the next window's outcome -- pretrained on historical
Binance data at startup (app/backtest.py) so it isn't starting cold --
and the bot trades WITH that signal (no fade):

  1. The instant a new window opens, compute AI features off the
     Binance feed and get a prediction -- the model always returns UP
     or DOWN (no "not confident enough" skip), so the signal is
     decided every window that has candle history.
  2. RSI(14) is computed and logged against the signal side for
     visibility, but does NOT block the trade.
  3. The bot places a resting MAKER limit buy on the SIGNALLED side
     @ ORDER_PRICE (0.45). It fills at its own exact price, no
     slippage, no fee, the moment that side's ask drops to/through it.
  4. If the resting order hasn't filled ORDER_TIMEOUT_SECONDS (30s)
     after being placed, it is cancelled and the bot switches to
     TAKER fallback: from then until the window closes, the moment the
     signalled side's best ask is BELOW TAKER_FALLBACK_MAX_PRICE
     (0.60), the bot buys at market (taker) -- priced by walking real
     ask depth, paying the taker fee. If the ask never gets below
     0.60 before the window closes, no trade that window.
  5. No stop-loss. Take profit is fixed at TP_PRICE (0.99) -- a real
     taker sell, priced by walking actual book depth, the moment the
     bid reaches it.
  6. Only one entry, one trade max per window -- no re-arming. If the
     position is open but TP never hits, it is force-closed at window
     end (taker, real depth-weighted price).
  7. Every window's true outcome (once known) is fed back into the AI
     signal engine as one online training step -- it keeps learning
     for as long as the bot runs, whether or not a trade was actually
     placed that window.

The only thing that can skip a window for data reasons is missing
candle history from the live Binance feed (disconnected, or too early
after process startup for the RSI/momentum lookback to be full).
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

# ---- Order sizing / pricing (AI signal engine, traded WITH the signal) ------
ORDER_SHARES = 200.0
ORDER_PRICE = 0.45           # fixed absolute resting-limit price on the signalled side
ORDER_TIMEOUT_SECONDS = 30.0        # cancel the resting order if unfilled this long after placement
TAKER_FALLBACK_MAX_PRICE = 0.60     # after the cancel, taker-buy only while signalled side's best ask is strictly BELOW this
SIGNAL_CANDLE_OFFSET = 240   # the decision candle is the previous window's [240s, 300s) minute
TP_PRICE = 0.99

# ---- RSI flag (informational, no-skip mode) --------------------------------
# Computed on the 1-minute BTC feed, as of the same signal candle used for
# the AI's features. Checked against the signal side and logged for
# visibility -- it does NOT block the trade:
#   AI signal UP,   RSI already overbought -> flagged, trade still placed
#   AI signal DOWN, RSI already oversold   -> flagged, trade still placed
# If there isn't enough closed-candle history yet (startup/reconnect), the
# flag is just skipped (nothing to compute it from).
RSI_PERIOD = 14
RSI_OVERBOUGHT = 70.0
RSI_OVERSOLD = 30.0

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- AI signal engine -----------------------------------------------------
# Replaces "candle color = real signal" with an online (self-training)
# logistic regression predicting P(next window resolves UP), fit
# incrementally after every window's true outcome becomes known -- no
# external API calls, no historical dataset REQUIRED to run, but see
# AI_BACKTEST_DAYS below for pretraining. See app/ai_signal.py for the
# model itself and feature list.
#
# NO-SKIP MODE: the model always returns a side (never "not confident
# enough" or "not trained enough") and RSI is logged but no longer
# blocks a trade -- every window that has candle history places a
# resting limit order. The only thing that can still skip a window is
# missing live feed data (Binance disconnected / not enough candle
# history yet at process startup), which is a data-availability issue,
# not a strategy choice, and can't be worked around without inventing
# prices.
AI_LEARNING_RATE = 0.05
AI_L2_REG = 0.001
AI_STREAK_LOOKBACK = 10          # max consecutive same-color candles counted for the streak feature

# ---- AI historical pretraining ---------------------------------------------
# At startup, fetch this many days of 1-minute BTC/USDT candles from
# Binance's public REST klines endpoint (no API key needed) and replay
# them through the exact same feature computation and 5-minute window
# grid the live bot uses, training the model on all of it before the
# first live tick -- so it isn't starting from all-zero weights. See
# app/backtest.py. Label used: whether BTC's own spot price finished
# each historical window higher than it opened (Polymarket's own
# historical order book isn't available, but these are BTC up/down
# markets, so BTC's own move is the real determinant behind them).
AI_BACKTEST_DAYS = float(os.getenv("AI_BACKTEST_DAYS", "3"))
AI_BACKTEST_BASE_URL = "https://api.binance.com/api/v3/klines"

# ---- Trading fees -----------------------------------------------------
# The resting entry is a MAKER limit order -- it fills at its own exact
# price with no fee. The taker-fallback entry (after the 30s timeout),
# the TP exit and any forced window-end close are TAKER market orders
# and pay the real fee, priced by walking real order-book depth. Verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
