"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- delayed cheap-side entry, continuous 0.20 trailing
stop, one flat-size flip, TP redemption:

  1. Entry: from window open, wait ENTRY_WAIT_SECONDS (10s). At that
     point, look at both sides' MID price ((bid+ask)/2) once and buy
     whichever is cheaper ("the cheap side") -- but ONLY if that side's
     mid is inside the entry zone [ENTRY_ZONE_LOW, ENTRY_ZONE_HIGH]
     (0.20-0.80). If it's outside the zone at the 10s mark, no trade is
     taken this window. This is a single check at t=10s, not a rearmed
     watch -- the zone/cheap-side gating applies to this initial entry
     only. The actual fill is a real taker buy priced off ask depth
     (see Engine._realistic_fill_price), which can differ from the mid
     that triggered it by the spread.
  2. Trailing stop: continuous, not stepped, and driven off MID price
     (not bid). Every tick, if the position's mid has made a new
     high-water mark, the stop is recomputed as
     high_water_mark - TRAIL_DISTANCE (0.20), rounded to the cent
     (0.01) tick size. It only ever moves up (one-way ratchet) since
     it's driven off the monotonic high-water mark. Mid <= stop -> stop
     hit -> real taker sell against bid depth.
  3. TP: mid reaching TP_PRICE (0.99) -> REDEEMED, not sold -- credited
     at a flat $1.00/share, zero fee (CTF resolution redemption).
     Terminal for the window: no further flips after a TP.
  4. Flip on stop hit: when the trailing stop is hit (whether the
     position is up or down overall), the bot immediately buys the
     OPPOSITE side, flat BASE_ORDER_SHARES, no entry-zone check, no
     price condition -- it fires regardless of price, as a real taker
     buy against ask depth. The flip position gets the exact same
     continuous 0.20 trailing-stop treatment. Capped at
     MAX_FLIPS_PER_WINDOW (1): once that one flip has been used, a
     further stop-out just ends the window flat -- no re-entry, no
     second flip.
  5. Sizing: flat, no martingale of any kind. Every entry -- initial or
     the one flip -- is exactly BASE_ORDER_SHARES. No cross-window
     sizing memory either; every window starts fresh.
  6. Fees: every fill is a real taker order and pays the taker fee,
     EXCEPT a TP hit, which is a fee-free CTF redemption.
  7. Window close: if a position is still open when the window closes,
     it's force-closed at whatever the market will pay (real taker
     sell).

At most one position open at a time (flip replaces, doesn't stack), no
order-book ladder, no merge.
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
PRICE_TICK = 0.01                 # rounding granularity for the stop price

BASE_ORDER_SHARES = 100.0         # flat size for every entry -- initial and every flip, no martingale
MAX_FLIPS_PER_WINDOW = 1           # cap on flips per window -- 1 = only one flip allowed intra-window

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
