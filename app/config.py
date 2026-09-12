"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- ladder breakout with immediate TAKER entries:

  1. Cold start: do nothing for the first ARM_DELAY_SECONDS (60s) of each
     window -- no monitoring, no orders.
  2. Arm: after the cold start, watch both sides' mid-price every tick.
     Whichever side's mid-price first reaches LADDER_THRESHOLDS[0] (0.65)
     becomes the ARMED side for the rest of that window -- the other side
     is no longer watched (they're complementary, so once one is rallying
     the other's falling).
  3. Ladder: every time the armed side's mid-price climbs through the
     next threshold in LADDER_THRESHOLDS (0.65 / 0.75 / 0.85), fire an
     immediate TAKER buy -- no resting limit order, so the fill is
     guaranteed instead of waiting on a pullback that might never come.
     The price actually paid is the REAL best ask read from the book at
     the moment of firing (checked fresh, not assumed to equal the mid
     that triggered the threshold) -- that's the realistic fill price,
     and it's what gets recorded as the position's entry price.
  4. Per fill: every rung that fills becomes its own independent
     position of SHARES_PER_RUNG shares (doubling after every stop loss,
     see below) with its own stop loss (LADDER_SL_PRICE, 0.50) and take
     profit (LADDER_TP_PRICE, 0.99) -- both taker market orders, filled
     at the real current bid the instant it drops to/through SL or rises
     to/through TP. Up to 3 positions can be open at once in one window
     if all three rungs fill.
  5. Rearm: EVERY stop loss hit (not just the first) doubles the size
     used for every rung placed for the rest of the window, and resets
     the engine to watch both sides again from scratch. This compounds
     -- a second SL doubles again on top of the first. The SL and TP
     price levels never change with size; a doubled-up rung shares the
     exact same 0.50 SL / 0.99 TP as every other rung.
  6. Window close: force a taker close on any positions still open.

Sizing starts flat at SHARES_PER_RUNG and only changes via the SL-driven
doubling above -- never any other progression.
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

# ---- Ladder breakout engine --------------------------------------------
LADDER_ARM_DELAY_SECONDS = 60          # do nothing for the first minute of each window
LADDER_THRESHOLDS = [0.65, 0.75, 0.85]  # mid-price levels that arm / extend the ladder
LADDER_SL_PRICE = 0.50                  # shared stop loss for every filled rung
LADDER_TP_PRICE = 0.99                  # shared take profit for every filled rung
LADDER_SHARES_PER_RUNG = 100.0          # flat size, every rung, every window

# Demo capital: single source of truth for the paper balance -- debited
# on every buy fill, credited on every TP/SL/forced-close settlement.
# Halts permanently if it ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Every fill in this engine is a taker market order now -- rung entries,
# TP exits, SL exits, and forced window-end closes all pay the taker fee
# for real. There is no maker rebate anywhere anymore (it only applied
# to resting orders, and nothing rests). Verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
