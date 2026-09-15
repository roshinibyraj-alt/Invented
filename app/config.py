"""
Central configuration for the 9-engine BTC 5-minute up/down paper bot.

Nine independent engines, each with its own split of the $4,500 demo
capital ($500/engine). Paper mode only -- no real order placement, no
private keys.

  Engines 1-5 (LIMIT, resting buy limits on BOTH sides):
    E1 @ 0.10, skip next 5 windows after a win
    E2 @ 0.20, skip next 4 windows after a win
    E3 @ 0.30, skip next 3 windows after a win
    E4 @ 0.40, skip next 2 windows after a win
    E5 @ 0.50, skip next 1 window after a win

    After the window opens, a resting buy-limit order is placed on each
    side at the engine's price. Whichever side's best ask crosses the
    limit first is filled at exactly the limit price (maker fill: no
    slippage, no fee) and the other side's order is cancelled. No stop
    loss; TP at 0.99 redeems the position at $1.00/share, fee-free; if
    still open at window close it settles at the inferred winner
    ($1.00/share) or $0.00.

    Skip rule: after any win the engine skips the next `skip_windows`
    windows but keeps monitoring. Each skipped window it records which
    side WOULD have filled first; at window end, if that side would
    have won, the skip counter resets to the full count, otherwise it
    decrements. Once it reaches 0 the engine trades normally again.

  Engines 6-9 (TAKER, aggressive buy the moment a side hits the trigger):
    E6 trigger 0.60 · E7 trigger 0.70 · E8 trigger 0.80 · E9 trigger 0.90

    Whichever side's mid first reaches the trigger is bought immediately
    as a taker at real ask depth (VWAP fill + taker fee). No stop loss.
    TP at 0.99 redeems at $1.00/share, fee-free; an open position at
    close settles at the inferred winner. No skip logic, no re-entry
    after exit.

Shared rules: flat BASE_ORDER_SHARES (100) per engine, no martingale.
CLOB-only live pricing -- Gamma is used purely for one-time window
metadata (slug -> token ids); every live price/book read goes to CLOB.
No fallback anywhere.
"""
import os

from .models import EngineSpec

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / pricing ---------------------------------------
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "0.5"))

# ---- TP / sizing ------------------------------------------------------
TP_PRICE = 0.99                 # mid >= this -> redeem at $1.00/share, fee-free
BASE_ORDER_SHARES = 100.0       # flat size for every engine, no martingale
ENGINE_CAPITAL = 500.0          # per-engine bankroll (9 engines -> $4,500 demo)
STARTING_CAPITAL = ENGINE_CAPITAL * 9

# ---- Engine definitions ------------------------------------------------
ENGINE_SPECS = [
    EngineSpec(engine_id=1, kind="LIMIT", entry_price=0.10, skip_windows=5),
    EngineSpec(engine_id=2, kind="LIMIT", entry_price=0.20, skip_windows=4),
    EngineSpec(engine_id=3, kind="LIMIT", entry_price=0.30, skip_windows=3),
    EngineSpec(engine_id=4, kind="LIMIT", entry_price=0.40, skip_windows=2),
    EngineSpec(engine_id=5, kind="LIMIT", entry_price=0.50, skip_windows=1),
    EngineSpec(engine_id=6, kind="TAKER", entry_price=0.60),
    EngineSpec(engine_id=7, kind="TAKER", entry_price=0.70),
    EngineSpec(engine_id=8, kind="TAKER", entry_price=0.80),
    EngineSpec(engine_id=9, kind="TAKER", entry_price=0.90),
]

# ---- Trading fees -----------------------------------------------------
# LIMIT engines fill as resting maker orders -> no fee, no slippage
# (they fill exactly at their limit price). TAKER engines buy
# aggressively and pay the taker fee for real, priced by walking real
# book depth. TP is booked as a resolution redemption / CTF settlement
# ($1.00/share) and pays no fee at all.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 800
