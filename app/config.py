"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- one position at a time, re-armed after every stop out:

  1. Window open: watch both sides' mid-price every tick. No cold start,
     except the first ENTRY_LOCKOUT_SECONDS (15s) of the window, where
     no entries are taken at all -- the market is often thin/choppy
     right at window open.
  2. Entry: the instant EITHER side's mid-price first reaches
     TRAIL_ARM_PRICE (0.60) -- and at least ENTRY_LOCKOUT_SECONDS has
     elapsed since window open -- buy that side -- SHARES_PER_SIDE
     shares, taker, priced against real book depth. The other side is
     not bought. (Tie-break if both cross in the same tick: UP checked
     first, same convention as the old ladder engine.)
     Entries do NOT chase: if a side's mid has already jumped past
     TRAIL_ARM_PRICE + ENTRY_MAX_CHASE (e.g. a gap between polls skips
     straight from 0.55 to 0.84), that tick is skipped entirely -- no
     buy. The engine keeps watching and will only enter once that
     side's price comes back down into the [0.60, 0.62] band, i.e. a
     real pullback to ~0.60, not a chase of wherever price ran to.
  3. Trailing stop: since entry only ever happens right as price
     crosses 0.60, the stop loss is armed immediately on entry at 0.50
     (0.60 - TRAIL_STEP). From there it trails the price up in
     TRAIL_STEP (0.10) increments, only ever ratcheting up:
       - price reaches 0.60 (entry) -> stop loss 0.50
       - price reaches 0.70 -> stop loss 0.60
       - price reaches 0.80 -> stop loss 0.70
       - ...and so on
  4. Take profit is fixed at TP_PRICE (0.99).
  5. One-way re-arm cycle: if the trailing stop hits, the position
     closes and the engine goes right back to step 2 -- watching BOTH
     sides again from scratch for whichever one next reaches 0.60
     (could be the same side recovering, or the other side). This can
     repeat any number of times within a single window. If TP hits
     instead, the engine does NOT re-arm -- no more entries for the
     rest of that window.
     A trailing stop can itself fire right at 0.60 (e.g. price ran to
     0.70+, trail_sl ratcheted to 0.60, then pulled back). Watching
     for entries again the instant that fill lands would immediately
     re-trigger the same 0.60 cross that just stopped it out. To avoid
     that contradiction, re-arming is delayed REARM_COOLDOWN_SECONDS
     (10s) after every trailing-stop exit before the engine resumes
     watching for the next entry.
  6. All fills (entry, trailing SL, TP, forced close) are TAKER orders,
     priced by walking the real order book depth needed to cover the
     full size, not just the single best bid/ask -- see
     Engine._realistic_fill_price. A thin/illiquid book pulls the
     average fill price accordingly instead of assuming unlimited
     depth at the top quote.
  7. Time-based force sell: if TP still hasn't hit by
     FORCE_SELL_AFTER_SECONDS (270s) into the window, any open position
     is force-closed immediately (taker, real fill) instead of waiting
     on the trailing stop. Same as a TP hit, this also ends the window
     for re-entry purposes -- no more entries for the rest of that
     window once a time-based force sell has fired.
  8. Window close: force a taker close on any position still open.

Sizing is flat -- SHARES_PER_SIDE every entry, no progression, doubling,
or rearm-driven size change of any kind. "Rearm" here only means
re-watching for the next 0.60 cross, not a bigger size.
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

# ---- One-way re-arming trailing-stop engine ------------------------------
SHARES_PER_SIDE = 300.0     # flat size, every entry
TRAIL_ARM_PRICE = 0.60      # price level that triggers entry AND arms the trailing stop
TRAIL_STEP = 0.10           # both the trailing increment and the initial SL offset below TRAIL_ARM_PRICE
TP_PRICE = 0.99             # take profit, active from the moment of entry
REARM_COOLDOWN_SECONDS = 10.0  # after a trailing-stop exit, wait this long before watching for the next 0.60 cross again

# ENTRY_MAX_CHASE: entries only fire when mid-price is between
# TRAIL_ARM_PRICE and TRAIL_ARM_PRICE + ENTRY_MAX_CHASE. Without this
# cap, a fast move or a gap between polls (POLL_INTERVAL_SECONDS) can
# jump straight from well below 0.60 to something like 0.84 -- the raw
# `mid >= TRAIL_ARM_PRICE` check has no upper bound, so it would chase
# and buy right at 0.84 instead of the intended "buy right as price
# touches 0.60". With this cap, an overshoot past the band is skipped
# entirely (no buy) and the engine keeps watching -- it will only enter
# once that side's price comes back down into the band, i.e. a real
# pullback to ~0.60, not a chase of wherever price already ran to.
ENTRY_MAX_CHASE = 0.02

# ---- Time-based window filters -----------------------------------------
# ENTRY_LOCKOUT_SECONDS: no entries in the first N seconds of a window --
# the market is often thin/choppy right at window open, so wait it out
# before watching for the 0.60 cross.
ENTRY_LOCKOUT_SECONDS = 15.0
# FORCE_SELL_AFTER_SECONDS: if TP still hasn't hit by N seconds into the
# window, force-close any open position immediately (taker, real fill --
# same pricing path as the trailing stop / window-close forced close).
# This is deliberately separate from and earlier than the window-close
# forced close in finalize_window(), which only fires if a position is
# *still* open at the literal end of the window (e.g. one that opened
# after this cutoff). A time-based force sell also ends the window for
# re-entry purposes -- same as a TP hit, no more entries after it fires.
FORCE_SELL_AFTER_SECONDS = 270.0

# Demo capital: single source of truth for the paper balance -- debited
# on every buy fill, credited on every TP/SL/forced-close settlement.
# Halts permanently if it ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Every fill in this engine is a taker market order -- entries, both
# kinds of exit (trailing SL / TP), and any forced window-end close all
# pay the taker fee for real. There is no maker rebate anywhere in this
# engine. Verify against GET https://clob.polymarket.com/fee-rate?token_id=...
# before trading real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---------------------------------------------------------------------------
# Chop engine -- a second, independent strategy (see chop_engine.py). Runs
# alongside the trailing-stop engine above, sharing the same PaperBroker
# (so both engines' events interleave in one log) but with its own capital
# pool so its P&L is directly comparable, not mixed in with TRAIL's.
#
# Thesis: round levels like 0.60 tend to act as resistance/chop rather than
# a clean breakout point (that's why TRAIL gets stopped out there so often).
# This engine trades that range directly: buy near the middle (0.40) on a
# pullback, take profit at the range top (0.60), cut losses if the range
# floor breaks (0.20). UP and DOWN are tracked completely independently --
# either or both can be holding a position at the same time -- and either
# exit (SL or TP) re-arms that side to watch for the next return to 0.40,
# unlike TRAIL where a TP ends the window.
# ---------------------------------------------------------------------------
CHOP_SHARES_PER_ENTRY = 300.0
CHOP_BUY_PRICE = 0.40
CHOP_SL_PRICE = 0.20
CHOP_TP_PRICE = 0.60

# Entries only fire when mid is within CHOP_BUY_PRICE +/- CHOP_ENTRY_MAX_CHASE
# (symmetric, unlike TRAIL's one-sided band, since 0.40 can be approached
# from above -- falling toward it -- or from below -- rising toward it).
# A gap past the band in either direction is skipped, not chased; the side
# keeps watching for an actual pullback into the band.
CHOP_ENTRY_MAX_CHASE = 0.02

# Same window-open lockout and pre-close force-sell safety as TRAIL, applied
# independently per side.
CHOP_ENTRY_LOCKOUT_SECONDS = 15.0
CHOP_FORCE_SELL_AFTER_SECONDS = 270.0

CHOP_STARTING_CAPITAL = float(os.getenv("CHOP_STARTING_CAPITAL", "2000"))

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
