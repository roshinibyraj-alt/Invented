"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- one position at a time, re-armed after every stop out:

  1. Window open: watch both sides' mid-price every tick. No cold start.
  2. Entry: the instant EITHER side's mid-price first reaches
     TRAIL_ARM_PRICE (0.60), buy that side -- SHARES_PER_SIDE shares,
     taker, priced against real book depth. The other side is not
     bought. (Tie-break if both cross in the same tick: UP checked
     first, same convention as the old ladder engine.)
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
  7. Window close: force a taker close on any position still open.

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

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
