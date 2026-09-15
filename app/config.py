"""
Central configuration for the 9-engine BTC 5-minute up/down paper bot.

Nine independent engines, each with its own split of the $4,500 demo
capital ($500/engine). Paper mode only.

  Engines 1-5 (LIMIT): resting buy limits on BOTH sides at
  0.10/0.20/0.30/0.40/0.50. First side whose ask crosses the limit
  fills at the limit price (maker: no fee, no slippage), other cancelled.
  No stop loss. TP at 0.99 -> $1.00/share, fee-free. Skip N windows
  after a win (5/4/3/2/1); would-have-win during skip resets counter.

  Engines 6-9 (TAKER): first side whose mid reaches 0.60/0.70/0.80/0.90
  is bought immediately as taker (real ask depth + fee). Stop loss at
  0.30 for all taker engines. TP at 0.99 -> $1.00/share, fee-free.

Sizing: Kelly-optimal shares per engine, computed fresh at each window
open from the engine's current balance, entry price, a configurable
estimated edge, and (for taker engines) the stop-loss distance. A
half-Kelly fraction is applied by default for safety, and the bet is
capped at MAX_BET_PCT of the engine's bankroll to prevent overleveraging.
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

# ---- TP ---------------------------------------------------------------
TP_PRICE = 0.99                 # mid >= this -> redeem at $1.00/share, fee-free

# ---- Kelly sizing ------------------------------------------------------
EDGE_ESTIMATE  = 0.05           # assumed edge over implied (price) probability
KELLY_FRACTION = 0.5            # fraction of full Kelly to apply (0.5 = half-Kelly)
MAX_BET_PCT    = 0.50           # never risk more than this fraction of engine bankroll
MIN_SHARES     = 10.0           # floor on share count per engine per window

# ---- Engine definitions ------------------------------------------------
ENGINE_CAPITAL = 500.0
STARTING_CAPITAL = ENGINE_CAPITAL * 9

ENGINE_SPECS = [
    EngineSpec(engine_id=1, kind="LIMIT", entry_price=0.10, skip_windows=5),
    EngineSpec(engine_id=2, kind="LIMIT", entry_price=0.20, skip_windows=4),
    EngineSpec(engine_id=3, kind="LIMIT", entry_price=0.30, skip_windows=3),
    EngineSpec(engine_id=4, kind="LIMIT", entry_price=0.40, skip_windows=2),
    EngineSpec(engine_id=5, kind="LIMIT", entry_price=0.50, skip_windows=1),
    EngineSpec(engine_id=6, kind="TAKER", entry_price=0.60, sl_price=0.30),
    EngineSpec(engine_id=7, kind="TAKER", entry_price=0.70, sl_price=0.30),
    EngineSpec(engine_id=8, kind="TAKER", entry_price=0.80, sl_price=0.30),
    EngineSpec(engine_id=9, kind="TAKER", entry_price=0.90, sl_price=0.30),
]

# ---- Taker stop-loss --------------------------------------------------
SL_PRICE_TAKER = 0.30           # uniform SL for all taker engines (E6-E9)

# ---- Trading fees -----------------------------------------------------
# LIMIT fills: maker (no fee). TAKER fills: taker fee for real.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 800
