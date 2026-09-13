"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- two fully independent non-overlapping limit-order grids
(one per side), running for the first 120s of each window, then a
combined profit-target exit:

  1. Grid building (first GRID_DURATION_SECONDS / 120s of the window):
     every tick, on EACH side independently, compute a candidate rung
     price = (current mid price) - GRID_SPACING (0.05). If that
     candidate isn't within GRID_SPACING of any order already placed on
     that side (resting, filled, or cancelled), place a new resting
     limit BUY there for GRID_ORDER_SHARES (100) shares. This produces
     a ladder of buy orders that are never closer than 0.05 apart, and
     that keeps extending as price explores new territory in either
     direction (a new low pulls the ladder down; a bounce back up past
     the lowest rungs can add a new rung near the new price too, as
     long as it's >=0.05 from everything already placed).
  2. Fills: a resting limit buy on a side fills -- at its own limit
     price, no slippage -- the moment that side's best ask drops to or
     through it. This is a real maker fill (no taker fee) since it's a
     resting order, not a market sweep. Fills only happen during the
     120s grid-building window -- see (3) for what happens the instant
     it times out.
  3. Grid-building timeout (120s): the instant GRID_DURATION_SECONDS
     elapses, no more new orders are placed AND any rung still resting
     (never filled) is cancelled outright, on both sides, once. Shares
     that already filled are untouched and carry forward. From here on
     the bot just watches. Every tick it totals the UNREALIZED profit across
     every filled share on BOTH sides combined (mark-to-market minus
     cost basis, summed UP + DOWN). The instant that combined total
     reaches PROFIT_TARGET_USD ($100), it sells EVERYTHING on both
     sides as taker orders (priced by walking real book depth, not
     just top-of-book -- see Engine._realistic_fill_price) and is done
     for the rest of that window: no more orders, no more monitoring.
  4. Window close: if the profit target was never hit, cancel any
     still-resting unfilled orders (no penalty) and force a taker close
     on any shares still held, same depth-aware pricing as the exit
     above.

Merges (fee-free, independent of the above): every tick, regardless of
grid-building/watching phase, check whether we're holding filled shares
on BOTH sides at once. UP+DOWN are complementary tokens of the same
condition, so min(up_shares, down_shares) of them can be merged straight
back into that many dollars of USDC via Polymarket's CTF contract --
no orderbook, no taker fee, no slippage. The moment that merge's profit
(the $1/pair redemption minus the pair's combined cost basis) clears
MERGE_PROFIT_THRESHOLD_USD ($10), the bot merges that many shares off
both books immediately and banks the profit, leaving any leftover
imbalance (whichever side has more shares) resting for the grid/exit
logic above to handle normally.

Sizing is flat -- GRID_ORDER_SHARES (100) per rung, no progression.
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

# ---- Independent dual-grid engine ---------------------------------------
GRID_ORDER_SHARES = 100.0        # flat size per resting rung
GRID_SPACING = 0.05              # minimum distance between any two rungs on the same side
GRID_DURATION_SECONDS = 120      # stop placing NEW orders after this long; resting orders stay live
PROFIT_TARGET_USD = 100.0        # combined unrealized profit (both sides) that triggers sell-everything

# ---- CTF merge (fee-free) ------------------------------------------------
# UP and DOWN are complementary outcome tokens of the SAME condition --
# 1 UP share + 1 DOWN share can be merged back into $1.00 of USDC
# collateral directly through Polymarket's CTF contract (mergePositions),
# with no orderbook, no taker fee, and no slippage. Since every grid rung
# on both sides buys BELOW mid, whenever we hold filled shares on both
# sides at once, their combined cost basis per pair is very often under
# $1 -- that gap is a locked-in profit the instant it's merged, no need
# to wait for a favorable price move or pay a taker fee to realize it.
# Checked every tick; fires the moment the mergeable pair profit clears
# this bar (kept well above $0 so we're not merging over dust/rounding).
MERGE_PROFIT_THRESHOLD_USD = 10.0

# Demo capital: single source of truth for the paper balance -- debited
# on every buy fill, credited on every sell settlement. Halts
# permanently if it ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Grid rungs are resting MAKER limit orders -- they fill at their own
# limit price with no fee (no rebate modeled either, just flat zero).
# The profit-target sell-everything exit and any forced window-end
# close are TAKER market orders and pay the fee for real, priced by
# walking real book depth. Verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
