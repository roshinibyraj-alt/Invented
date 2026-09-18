"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- one resting limit buy per window. Direction is decided
by an online AI signal engine (app/ai_signal.py) predicting the next
window's outcome, then FADED (the bot trades the opposite side of that
prediction, always):

  1. The instant a new window opens, read the previous window's last
     1-minute Binance candle (already closed by definition) and use it
     -- along with RSI, momentum, volatility, and streak features
     computed off the same feed -- as input to the AI signal engine's
     prediction of P(next window resolves UP).
       - confident UP prediction -> real signal UP
       - confident DOWN prediction -> real signal DOWN
       - not confident, or the model hasn't trained on enough windows
         yet (cold start) -> no trade this window
  2. RSI(14) veto is checked against the REAL signal side (see below) --
     if it survives, the bot places its resting limit buy on the
     OPPOSITE side of the real signal, always (this is a fade/contrarian
     strategy, not momentum-following).
  3. This is a real MAKER limit order -- it fills at its own exact
     price (0.45), no slippage, no fee, the moment that side's ask
     drops to/through it. It is NOT a taker/market buy. LIMIT ONLY:
     if it never fills, it just sits resting until the window closes,
     then is cancelled with no penalty -- no market-order fallback.
  4. No stop-loss. Take profit is fixed at TP_PRICE (0.99) -- a real
     taker sell, priced by walking actual book depth, the moment the
     bid reaches it.
  5. Only one order, one trade max per window -- no re-arming. If the
     resting order fills but TP never hits, the position is
     force-closed at window end (taker, real depth-weighted price).
  6. Every window's true outcome (once known) is fed back into the AI
     signal engine as one online training step -- it keeps learning
     for as long as the bot runs, whether or not a trade was actually
     placed that window.

This completely replaces the previous "read minute 2 of THIS window"
strategy -- Binance is still signal-only (never prices or executes
anything), just feeding a model instead of being read directly now.
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

# ---- Previous-window-momentum engine (faded) ------------------------------
ORDER_SHARES = 200.0
ORDER_PRICE = 0.45           # fixed absolute limit price, whichever side is traded
SIGNAL_CANDLE_OFFSET = 240   # the decision candle is the previous window's [240s, 300s) minute
TP_PRICE = 0.99

# ---- RSI veto -----------------------------------------------------------
# Computed on the 1-minute BTC feed, as of the same signal candle used for
# color. Checked against the REAL signal side (before the fade flip) --
# it only blocks a trade when that real signal direction looks exhausted
# rather than fresh:
#   green -> real signal UP,   but RSI already overbought -> veto (no trade)
#   red   -> real signal DOWN, but RSI already oversold   -> veto (no trade)
# If there isn't enough closed-candle history yet (startup/reconnect), the
# veto is skipped and the trade proceeds on candle color alone.
RSI_PERIOD = 14
RSI_OVERBOUGHT = 70.0
RSI_OVERSOLD = 30.0

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- AI signal engine -----------------------------------------------------
# Replaces "candle color = real signal" with an online (self-training)
# logistic regression predicting P(next window resolves UP), fit
# incrementally after every window's true outcome becomes known -- no
# external API calls, no offline training step, no historical dataset
# needed. See app/ai_signal.py for the model itself and feature list.
AI_MIN_SAMPLES_TO_PREDICT = 30   # cold-start: skip trading until this many windows have been learned from
AI_LEARNING_RATE = 0.05
AI_L2_REG = 0.001
AI_CONFIDENCE_BAND = 0.06        # |P(up) - 0.5| must exceed this or the window is treated as "no signal"
AI_STREAK_LOOKBACK = 10          # max consecutive same-color candles counted for the streak feature

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
