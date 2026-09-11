"""
Central configuration for the BTC 5-min up/down ladder-martingale bot.

Strategy (see app/engine.py for the full write-up):
  1. At the very first tick of each 5-min window, unconditionally place a
     2-level resting BUY ladder on BOTH sides at once: LADDER_LEVELS.
     No wait, no price-band filter.
  2. Rung-level race: the moment either side's rung fills, the SAME rung
     on the OPPOSITE side is immediately cancelled (each rung -- 0.40,
     0.30 -- races independently; the other rung is unaffected).
  3. Every fill, on any rung/side, gets a resting TP sell at the flat
     TP_PRICE (0.99). No tiered/first-side TP anymore.
  4. No stop loss -- if a TP never hits before the window closes, that
     position rides to resolution: $1/share if its side won, $0 if it
     lost. Resolution outcome IS the win/loss for the martingale below
     (a TP fill always counts as a win for its rung).
  5. Per-rung martingale: each rung (0.40 / 0.30) tracks its own
     consecutive-loss streak, counted since its last win, and persisting
     across windows. Every time that streak reaches another multiple of
     RUNG_LOSS_DOUBLE_THRESHOLDS[rung], the share size for that rung
     doubles again (compounding -- e.g. for the 0.30 rung: loss #2 -> 2x,
     loss #4 -> 4x, loss #6 -> 8x, ...). The 0.40 rung follows the same
     compounding logic as the 0.30 rung. Any win on a rung resets its
     streak and share size back to base.
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
# window -- no wait, no price-band filter. "shares" here is the BASE
# size for that rung; actual order size = base * current rung multiplier
# (see RUNG_LOSS_DOUBLE_THRESHOLDS below).
# price -> base_shares
LADDER_LEVELS = [
    (0.40, 20.0),
    (0.30, 15.0),
]

# Flat TP applied to every fill, on any rung, any side.
TP_PRICE = 0.99

# Per-rung martingale: number of consecutive losses (since that rung's
# last win) needed before its share size doubles again. Compounding --
# reached again every N more losses, not just once.
RUNG_LOSS_DOUBLE_THRESHOLDS = {
    0.40: 2,
    0.30: 2,
}

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
