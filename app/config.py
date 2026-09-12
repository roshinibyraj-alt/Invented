"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- buy both sides immediately, trail a stop once a side
moves in its favor:

  1. Window open: the instant a window is live, fire an immediate TAKER
     buy of SHARES_PER_SIDE on BOTH the UP token and the DOWN token, no
     delay and no waiting for any price level. Each side becomes its own
     independent position from here on -- what happens to one has zero
     effect on the other.
  2. No stop loss at all to start. Each side sits completely unprotected
     until its own price first reaches TRAIL_ARM_PRICE (0.60).
  3. Trailing stop: once a side's price reaches 0.60, its stop loss is
     set at 0.60 - TRAIL_STEP (0.50). From there the stop trails the
     price up in TRAIL_STEP (0.10) increments, and ONLY ratchets up,
     never down:
       - price reaches 0.60 -> stop loss 0.50
       - price reaches 0.70 -> stop loss 0.60
       - price reaches 0.80 -> stop loss 0.70
       - ...and so on
     If a side never reaches 0.60 in a window, it just never gets a stop
     loss -- it rides uncovered until TP or the forced window-end close.
  4. Take profit is fixed at TP_PRICE (0.99) for both sides from the
     moment they're bought, independent of whether trailing has armed.
  5. All fills are TAKER orders (entries, stop loss, take profit, forced
     close), and every exit is priced off the REAL current bid/ask read
     at the moment it fires -- never assumed.
  6. Window close: force a taker close on any side(s) still open.

Sizing is flat -- SHARES_PER_SIDE, every window, both sides. No
progression, doubling, or rearm logic of any kind.
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

# ---- Dual-entry trailing-stop engine ------------------------------------
SHARES_PER_SIDE = 300.0     # flat size, bought on BOTH sides at window open
TRAIL_ARM_PRICE = 0.60      # price level that first arms the trailing stop
TRAIL_STEP = 0.10           # both the trailing increment and the initial SL offset below TRAIL_ARM_PRICE
TP_PRICE = 0.99             # shared take profit for both sides, from the start

# Demo capital: single source of truth for the paper balance -- debited
# on every buy fill, credited on every TP/SL/forced-close settlement.
# Halts permanently if it ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Every fill in this engine is a taker market order -- both entries, both
# kinds of exit (trailing SL / TP), and any forced window-end close all
# pay the taker fee for real. There is no maker rebate anywhere in this
# engine. Verify against GET https://clob.polymarket.com/fee-rate?token_id=...
# before trading real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
