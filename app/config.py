"""
Central configuration for ALPHASTRIKE -- BTC 5-min up/down bot.

Strategy: "the current window decides the next window".

  SIGNAL (from the window that just closed, using its five 1-minute
  BTC closes c1..c5):
    UP   : minute 2 closed BELOW minute 1  (early dip)
           AND avg(c3, c4, c5) > avg(c1, c2)  (then recovered)
    DOWN : exactly the opposite -- minute 2 closed ABOVE minute 1
           AND avg(c3, c4, c5) < avg(c1, c2)
    else : no pattern -> no trade in the next window.

  TRADE (in the NEXT window, on the signalled side):
    1. The moment the window opens, place a resting MAKER limit buy for
       LIMIT_SHARES (200) @ LIMIT_PRICE (0.40). It fills at its own exact
       price, no fee, if that side's ask drops to/through it.
    2. If it hasn't filled LIMIT_TIMEOUT_SECONDS (120s = 2 min) after being
       placed, cancel it and switch to TAKER fallback: from then until the
       window closes, the first tick that side's best ask is BELOW
       TAKER_MAX_PRICE (0.60), buy TAKER_SHARES (300) at market -- priced by
       walking real ask depth, taker fee paid. If the ask never gets below
       0.60, no trade that window.
    3. No stop-loss. Take profit at TP_PRICE (0.99) -- a real taker sell,
       depth-walked. If TP never hits, force-closed at window end.
    4. One entry per window (either the 200sh limit fill OR the 300sh taker
       buy, never both).

Minute prices come from Binance BTCUSDT 1-minute candles (public REST);
every order is priced/filled against Polymarket's own CLOB book.
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
WINDOW_SECONDS = 300             # 5-minute windows: five 1-minute candles per window

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# ---- Entry: resting limit first, taker fallback -------------------------
LIMIT_PRICE = float(os.getenv("LIMIT_PRICE", "0.40"))
LIMIT_SHARES = float(os.getenv("LIMIT_SHARES", "200"))
LIMIT_TIMEOUT_SECONDS = float(os.getenv("LIMIT_TIMEOUT_SECONDS", "120"))
TAKER_SHARES = float(os.getenv("TAKER_SHARES", "300"))
TAKER_MAX_PRICE = float(os.getenv("TAKER_MAX_PRICE", "0.60"))   # taker-buy only while best ask is strictly BELOW this
TP_PRICE = 0.99

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Signal data (Binance public REST, no API key) ------------------------
# Used ONLY to read the previous window's 1-minute closes. If your host is
# geo-blocked from api.binance.com, point this at a mirror (e.g.
# https://api.binance.us/api/v3/klines) -- same response format.
BINANCE_KLINES_URL = os.getenv("BINANCE_KLINES_URL", "https://api.binance.com/api/v3/klines")
BINANCE_SYMBOL = os.getenv("BINANCE_SYMBOL", "BTCUSDT")
SIGNAL_MAX_WAIT_SECONDS = 60.0     # give up on a window's signal if the candles haven't arrived this long after open
LATE_JOIN_GRACE_SECONDS = 10.0     # a window first seen more than this many seconds after its open is not traded

# ---- Trading fees -----------------------------------------------------
# The taker fallback entry, the TP exit and any forced window-end close are
# TAKER market orders and pay the real fee, priced by walking real
# order-book depth. The resting-limit entry is a maker fill: no fee.
# Verify against GET https://clob.polymarket.com/fee-rate?token_id=...
# before trading real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
