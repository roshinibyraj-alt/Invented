"""
Central configuration for the BTC 5-min up/down "confused market" bot.

Strategy (see app/engine.py for the full write-up):
  1. At the very first tick of each 5-min window, immediately place a
     3-level resting BUY ladder on BOTH sides at once: LADDER_LEVELS.
     No wait, no price-band filter -- the ladder fires unconditionally,
     once, the instant a window opens. Every order is a maker limit
     buy; none are ever proactively cancelled -- they simply stop
     resting when the window closes.
  2. Whichever side's ladder gets a fill FIRST (any single tranche, on
     either UP or DOWN) becomes the "first side" for the rest of the
     window. Its fills take profit at the tiered targets in
     LADDER_LEVELS (per-price TP). Fills on the other side (the side
     that fills after) always take profit at OPPOSITE_TP, regardless of
     which price tranche they filled at.
  3. TP orders are resting maker sell limits too. No stop loss --
     anything still open when the window closes rides to resolution:
     $1/share if that side won, $0 if it lost. No re-arming after a
     window resolves; each window gets at most one ladder.
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

# ---- Ladder -------------------------------------------------------------
# Per side (UP and DOWN), placed together on the very first tick of the
# window -- no wait, no price-band filter.
# price -> (shares, take_profit_price_for_the_FIRST_side_to_fill)
LADDER_LEVELS = [
    # price, shares, first-side TP
    (0.30, 200.0, 0.70),
    (0.20, 100.0, 0.80),
    (0.10, 50.0, 0.90),
]

# Flat TP applied to every fill on the SECOND (opposite) side to fill,
# regardless of which price tranche it was.
OPPOSITE_TP = 0.99

MAKER_REBATE_FRACTION = 0.20  # rebate earned on every resting-order fill (both entry and TP)

# Demo capital: single source of truth for the paper balance, same
# convention as the reference bot -- debited on every buy fill, credited
# on every TP fill / resolution settlement. Halts permanently if it
# ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# This engine is maker-only on both entries and exits (never crosses the
# spread), so it never pays the taker fee itself -- kept here purely as
# the basis for the maker rebate calculation above. Verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
