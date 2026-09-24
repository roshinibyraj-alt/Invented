"""
Central configuration for DIPHUNTER -- BTC 5-minute up/down, "follow the last window".

  SIGNAL: whichever side won the PREVIOUS window is the side to trade in the next one.
  WINNER: read from Polymarket's own CLOB prices in the last second of the window --
          the side whose price is 0.95+ won. Neither at 0.95+ -> undecided -> no signal.

  ENTRY (next window, traded side, size = current base): TWO phases.
    Phase 1 (0s to LIMIT_ENTRY_TIMEOUT_SECONDS after open): a resting limit buy at
      LIMIT_ENTRY_PRICE (0.40). Fills (maker, no fee) the moment the ask reaches 0.40 or below.
    Phase 2 (after LIMIT_ENTRY_TIMEOUT_SECONDS): the limit is cancelled. From then until the
      window closes, the bot buys at market (taker, depth-walked fill, taker fee) the instant the
      ask is at or below MARKET_ENTRY_CAP (0.50) -- immediately if it's already there, or whenever
      it comes back down to it. Never reaching the cap before close means no trade that window.
  EXIT: none. The position is held to the window end and settled by the 0.95 rule:
        winner pays $1/share, loser $0.

  SIZE: one shared base, in DOLLARS, starts at BASE_DOLLARS (500). Every win takes off
        DOLLARS_STEP (100), floor 0. Any loss resets it to 500. At 0 the bot skips
        same-direction signals; the first opposite-direction signal trades 500 and restarts the
        base. Shares bought = base dollars / actual fill price, so the dollar risk per trade is
        fixed but share count scales with price. A window with no fill still moves the ladder as
        a "paper" win/loss once the signalled side is decided (no cash moved either way) -- only
        a genuinely undecided window, a no-signal window, or a floor-skip leaves it untouched.

Everything is priced/filled against Polymarket's CLOB book. No other data source.
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / pricing ---------------------------------------
# CLOB only for prices. Gamma is used purely for one-time window metadata
# (slug -> token ids) in polymarket_client.py.
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

# ---- Polling cadence -----------------------------------------------------
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))
# Faster polling in the last seconds of a window, so the 0.95 winner read is as close to the
# final second as possible.
CLOSE_PHASE_POLL_SECONDS = float(os.getenv("CLOSE_PHASE_POLL_SECONDS", "0.25"))
CLOSE_PHASE_SECONDS = 3.0

# ---- Entry: resting limit first, then a capped market buy ---------------
LIMIT_ENTRY_PRICE = float(os.getenv("LIMIT_ENTRY_PRICE", "0.40"))              # phase 1 resting limit price
LIMIT_ENTRY_TIMEOUT_SECONDS = float(os.getenv("LIMIT_ENTRY_TIMEOUT_SECONDS", "30"))  # cancel + switch to market after this long
MARKET_ENTRY_CAP = float(os.getenv("MARKET_ENTRY_CAP", "0.50"))                # phase 2: buy at market once ask <= this

# ---- Sizing ladder (dollars, not shares) ---------------------------------
BASE_DOLLARS = float(os.getenv("BASE_DOLLARS", "500"))
DOLLARS_STEP = float(os.getenv("DOLLARS_STEP", "100"))

# ---- Winner rule --------------------------------------------------------------
WIN_PRICE = float(os.getenv("WIN_PRICE", "0.95"))                 # side priced at/above this at the close won
SETTLE_MAX_STALENESS_SECONDS = float(os.getenv("SETTLE_MAX_STALENESS_SECONDS", "3"))  # older reads don't count

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "5000"))

# ---- Trading fees -----------------------------------------------------
# Phase 1 (resting limit) fill is a maker fill: no fee. Phase 2 (market buy, capped at
# MARKET_ENTRY_CAP) is a taker order and pays the real fee, priced by walking real order-book
# depth. Settlement at window end is a redemption: no fee.
# Verify against GET https://clob.polymarket.com/fee-rate?token_id=... before real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
