"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- breakout-entry, fixed TP/SL, anti-martingale sizing:

  1. Entry trigger: from the instant a window opens, watch both sides'
     mid price every tick. The moment EITHER side's mid reaches
     ENTRY_TRIGGER_PRICE (0.70), immediately attempt a buy on that side
     only -- whichever side triggers first takes the window's one and
     only trade slot; the other side is ignored for the rest of the
     window even if it later reaches 0.70 too.
  2. Fill / slippage: the entry is priced by walking real ask depth
     (see Engine._realistic_fill_price), but capped at
     ENTRY_TRIGGER_PRICE + ENTRY_SLIPPAGE (0.80) -- if the market has
     already moved past that cap by the time the trigger fires, the
     entry is skipped entirely (logged as MISSED_ENTRY, no position,
     no capital risked) rather than chasing an arbitrarily bad price.
  3. Exit: once filled, every tick checks that side's bid against a
     take-profit level and a trailing stop-loss:
       - TP_PRICE (0.99): treated as a certain win and REDEEMED, not
         sold -- credited at a flat $1.00/share with zero fee (a CTF
         resolution redemption, not an orderbook trade -- same
         no-fee logic as the merge mechanic), instead of taker-selling
         at ~0.99 and losing a sliver of edge to fee/slippage.
       - Stop-loss trails up in one-way steps off the position's
         high-water mark (the best bid seen since entry) and never
         moves back down, even if price pulls back below the level
         that raised it: SL_STEPS (see below) map "price has reached
         at least X" -> "SL is now Y". Below the first step it's just
         SL_BASE (0.40). An SL exit is a real taker sell, priced by
         walking real bid depth, since (unlike TP) it isn't a
         guaranteed-resolution redemption.
     If the window closes before either is reached, the position is
     force-closed at whatever the market will pay (also a real taker
     sell), and still counts as a win/loss for sizing purposes.
  4. Sizing -- anti-martingale: position size is
     BASE_ORDER_SHARES * ANTI_MARTINGALE_MULTIPLIER ** martingale_step.
     martingale_step persists across windows (not reset per window):
       - a WIN steps it up by one (capped at MAX_MARTINGALE_STEPS),
         except a win that was already AT the cap resets back to 0.
       - a LOSS resets it to 0 immediately.
       - a window with no trade taken (trigger never reached, or the
         entry was skipped for slippage) leaves it unchanged.
     With the defaults (2.1x, cap 2) the ladder is:
       step 0 = 1x -> step 1 = 2.1x -> step 2 = 4.41x -> (win) -> step 0

At most one trade per window, no order-book ladder, no merge -- a
position only ever exists on one side at a time, so the fee-free CTF
merge mechanic (holding both sides at once) doesn't apply here and was
removed along with the old dual-grid logic.
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

# ---- Breakout-entry / trailing-SL / TP-redemption engine -----------------
ENTRY_TRIGGER_PRICE = 0.70        # mid price that arms a buy on that side
ENTRY_SLIPPAGE = 0.10             # max price above trigger we'll chase (cap = 0.80)
TP_PRICE = 0.99                   # take-profit level -- hit = redeemed at $1.00, fee-free
SL_BASE = 0.40                    # stop-loss before any trailing step has triggered

# Trailing stop-loss: (price the position's high-water mark must reach,
# the SL it moves to once it does). Must stay sorted ascending by
# trigger -- Engine._effective_sl walks it in order and keeps the last
# (highest) one whose trigger the high-water mark has reached, so a
# later/lower entry here would never actually win out over an earlier
# higher one. One-way ratchet: once a step fires it never moves back
# down, even if price pulls back below that step's trigger afterward.
SL_TRAIL_STEPS = [
    (0.80, 0.50),
    (0.90, 0.60),
    (0.97, 0.70),
]

BASE_ORDER_SHARES = 100.0                 # step-0 (1x) position size
ANTI_MARTINGALE_MULTIPLIER = 2.1          # size multiplier applied per step, after a win
MAX_MARTINGALE_STEPS = 2                  # steps 0..2 -> multipliers 1x, 2.1x, 4.41x

# Demo capital: single source of truth for the paper balance -- debited
# on every buy fill, credited on every sell settlement. Halts
# permanently if it ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Entry, SL, and a forced window-end close are reactive/triggered fills
# (not resting orders placed ahead of time), so all three are modeled
# as TAKER fills and pay the fee for real, priced by walking real book
# depth. TP is the one exception: it's booked as a resolution
# redemption (see TP_PRICE above), not an orderbook trade, so it pays
# no fee at all. Verify the taker rate against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
