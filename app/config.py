"""
Central configuration, all overridable via environment variables
(set these in Railway's Variables tab).
"""
import os
from dataclasses import dataclass


def _f(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _i(name: str, default: int) -> int:
    return int(os.getenv(name, default))


# ---- Mode -------------------------------------------------------------
# PAPER (demo) mode only: reads Polymarket's real, public order books but
# never signs or submits a real order. All fills, balances, and P&L are
# simulated against virtual bankrolls.
PAPER_MODE = True

# ---- Window -------------------------------------------------------------
WINDOW_SECONDS = _i("WINDOW_SECONDS", 300)     # 5-minute windows
WINDOW_LABEL = os.getenv("WINDOW_LABEL", "5m")  # gamma slug segment: "{asset}-updown-5m-{ts}"

# ---- Engines --------------------------------------------------------------
# 4 independent engines, each dedicated to ONE outcome token. Each fires
# exactly one $ENTRY_DOLLARS entry per window, at (or very near) window
# open -- when the token price is closest to a coin-flip ($0.50) -- so
# the win rate is close to 50% "by time decay": with no directional edge
# at entry, the price simply decays toward $0 or $1 as the window
# resolves, and a symmetric TP/SL around 0.50 catches roughly half of
# that decay each way.
@dataclass(frozen=True)
class EngineConfig:
    label: str      # "E1_BTC_UP" etc -- used in logs, storage keys, dashboard
    asset: str      # "btc" / "eth"
    outcome: str    # "Up" / "Down"
    color: str      # ANSI color name for logging


ENGINES = [
    EngineConfig(label="E1_BTC_UP",   asset="btc", outcome="Up",   color="cyan"),
    EngineConfig(label="E2_BTC_DOWN", asset="btc", outcome="Down", color="magenta"),
    EngineConfig(label="E3_ETH_UP",   asset="eth", outcome="Up",   color="green"),
    EngineConfig(label="E4_ETH_DOWN", asset="eth", outcome="Down", color="yellow"),
]

STARTING_CAPITAL_PER_ENGINE = _f("STARTING_CAPITAL_PER_ENGINE", 1000.0)
ENTRY_DOLLARS = _f("ENTRY_DOLLARS", 100.0)   # flat $ notional per engine per window

# ---- Take-profit / stop-loss -----------------------------------------------
# Token price levels (entry is near $0.50). Default +-40%.
TAKE_PROFIT_PRICE = _f("TAKE_PROFIT_PRICE", 0.70)
STOP_LOSS_PRICE = _f("STOP_LOSS_PRICE", 0.30)

# ---- Execution --------------------------------------------------------------
BUY_SLIPPAGE_CEILING = _f("BUY_SLIPPAGE_CEILING", 0.99)
SELL_SLIPPAGE_FLOOR = _f("SELL_SLIPPAGE_FLOOR", 0.01)

# ---- Fees -------------------------------------------------------------------
FALLBACK_TAKER_FEE_RATE = _f("FALLBACK_TAKER_FEE_RATE", 0.07)

# ---- Resolution (time decay / hold-to-close path) ----------------------------
# Primary: Polymarket's own official resolution via Gamma (closed +
# outcomePrices) -- the real oracle-based settlement. If Gamma hasn't
# confirmed within GAMMA_RESOLUTION_TIMEOUT_SECONDS of window close, fall
# back to the CLOB's actual last-traded price (never bid/ask/midpoint --
# those are unsafe right at window close; see app/clobbook.py notes).
GAMMA_RESOLUTION_CONFIDENCE = _f("GAMMA_RESOLUTION_CONFIDENCE", 0.99)
GAMMA_RESOLUTION_TIMEOUT_SECONDS = _f("GAMMA_RESOLUTION_TIMEOUT_SECONDS", 90.0)
CLOB_FALLBACK_PRICE_THRESHOLD = _f("CLOB_FALLBACK_PRICE_THRESHOLD", 0.97)

# ---- Polling ---------------------------------------------------------------
POLL_INTERVAL_SECONDS = _f("POLL_INTERVAL_SECONDS", 1.5)
RESOLUTION_POLL_SECONDS = _f("RESOLUTION_POLL_SECONDS", 2.0)
RESOLUTION_POLL_TIMEOUT_SECONDS = _f("RESOLUTION_POLL_TIMEOUT_SECONDS", 180.0)

# ---- Market discovery ---------------------------------------------------------
ASSETS = ["btc", "eth"]
GAMMA_BASE = os.getenv("GAMMA_BASE", "https://gamma-api.polymarket.com")
CLOB_BASE = os.getenv("CLOB_BASE", "https://clob.polymarket.com")

# ---- Storage ---------------------------------------------------------------
DB_PATH = os.getenv("DB_PATH", "/data/pool_bot_state.db" if os.path.isdir("/data") else "pool_bot_state.db")

# ---- Web server -------------------------------------------------------------
PORT = _i("PORT", 8080)
