"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- delayed cheap-side entry, continuous trailing stop
(tightens above a price threshold), single trade per window, TP
redemption:

  1. Entry: from window open, wait ENTRY_WAIT_SECONDS (10s). At that
     point, look at both sides' ask price once and buy whichever is
     cheaper ("the cheap side") -- but ONLY if that side's price is
     inside the entry zone [ENTRY_ZONE_LOW, ENTRY_ZONE_HIGH] (0.20-0.80).
     If it's outside the zone at the 10s mark, no trade is taken this
     window. This is a single check at t=10s, not a rearmed watch --
     the zone/cheap-side gating applies to this initial entry only.
  2. Trailing stop: continuous, not stepped, and inactive for the
     first TRAIL_START_DELAY_SECONDS (120s) after entry -- during that
     window only TP can close the position, the stop cannot fire (the
     high-water mark still tracks the whole time, so the stop starts
     from wherever price has gotten to once it activates, not from
     scratch). Once active, every tick that the position's mid has
     made a new high-water mark, the stop is recomputed as
     high_water_mark - trail_distance, rounded to the cent (0.01) tick
     size. The trail distance is TRAIL_DISTANCE (0.20) normally, but
     narrows to TRAIL_DISTANCE_TIGHT (0.10) once the high-water mark
     has gone above TRAIL_TIGHTEN_PRICE (0.85) -- tightening the stop
     as the position gets deep in the money. It only ever moves up
     (one-way ratchet) since it's driven off the monotonic high-water
     mark. Mid <= stop -> stop hit (once active).
  3. TP: TP_PRICE (0.99) hit -> REDEEMED, not sold -- credited at a
     flat $1.00/share, zero fee (CTF resolution redemption).
  4. No flips: a stop-hit closes the position and the window is done --
     at most one trade per window, no re-entry on the opposite side.
  5. Sizing: flat, no martingale of any kind. Every entry is exactly
     BASE_ORDER_SHARES. No cross-window sizing memory either; every
     window starts fresh.
  6. Window close: if a position is still open when the window closes,
     it's force-closed at whatever the market will pay (real taker
     sell).

At most one position open at a time, one trade per window, no order-book
ladder, no merge.
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

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "0.5"))

# ---- Delayed cheap-side entry / continuous trailing stop / flip engine ----
ENTRY_WAIT_SECONDS = 10.0         # wait this long after window open before checking entry
ENTRY_ZONE_LOW = 0.20             # entry zone floor -- initial entry only
ENTRY_ZONE_HIGH = 0.80            # entry zone ceiling -- initial entry only
TP_PRICE = 0.99                   # take-profit level -- hit = redeemed at $1.00, fee-free
TRAIL_DISTANCE = 0.20             # continuous trailing stop distance from high-water mark
TRAIL_DISTANCE_TIGHT = 0.10       # narrowed trail distance once high-water mark > TRAIL_TIGHTEN_PRICE
TRAIL_TIGHTEN_PRICE = 0.85        # high-water mark threshold above which the tighter trail applies
TRAIL_START_DELAY_SECONDS = 120.0 # trailing stop is inactive until this long after entry (TP still live)
PRICE_TICK = 0.01                 # rounding granularity for the stop price

BASE_ORDER_SHARES = 100.0         # flat size for every entry -- initial and every flip, no martingale

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
