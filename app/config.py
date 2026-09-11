"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- ladder breakout with pullback limit entries:

  1. Cold start: do nothing for the first ARM_DELAY_SECONDS (60s) of each
     window -- no monitoring, no orders.
  2. Arm: after the cold start, watch both sides' mid-price every tick.
     Whichever side's mid-price first reaches LADDER_THRESHOLDS[0] (0.75)
     becomes the ARMED side for the rest of that window -- the other side
     is no longer watched (they're complementary, so once one is rallying
     the other's falling).
  3. Ladder: every time the armed side's mid-price climbs through the
     next threshold in LADDER_THRESHOLDS (0.75 / 0.85 / 0.95), place one
     new resting limit BUY order (maker), priced LADDER_OFFSET (0.10)
     below that threshold:
       - crosses 0.75 -> resting buy @ 0.65
       - crosses 0.85 -> resting buy @ 0.75
       - crosses 0.95 -> resting buy @ 0.85
     Each rung is placed once and stays resting waiting for a pullback --
     it is NOT cancelled just because price keeps climbing past it.
  4. Per fill: every rung that fills becomes its own independent
     position of SHARES_PER_RUNG (100) shares with its own stop loss
     (LADDER_SL_PRICE, 0.50 -- taker market sell the instant the bid
     drops to/through it) and take profit (LADDER_TP_PRICE, 0.99 --
     resting maker sell). Up to 3 positions can be open at once in one
     window if all three rungs fill.
  5. Window close: cancel any rungs that never filled; force a taker
     close on any positions still open.

Sizing is flat -- SHARES_PER_RUNG every time, no martingale or
anti-martingale progression carried between windows or between rungs.
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
LADDER_THRESHOLDS = [0.75, 0.85, 0.95]  # mid-price levels that arm / extend the ladder
LADDER_OFFSET = 0.10                    # each rung's limit buy sits this far below its threshold
LADDER_SL_PRICE = 0.50                  # shared stop loss for every filled rung
LADDER_TP_PRICE = 0.99                  # shared take profit for every filled rung
LADDER_SHARES_PER_RUNG = 100.0          # flat size, every rung, every window

MAKER_REBATE_FRACTION = 0.20  # rebate earned on every resting-order fill (maker side)

# Demo capital: single source of truth for the paper balance -- debited
# on every buy fill, credited on every TP/SL/forced-close settlement.
# Halts permanently if it ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Ladder rung entries and TP exits are resting maker orders (no fee, earn
# the maker rebate above); the stop loss and any forced window-end close
# are taker market orders and pay the fee for real. Verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
