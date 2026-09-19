"""
Startup pre-backtest for the multi-timeframe engine (app/mtf_engine.py).

Fetches the last config.MTF_BACKTEST_DAYS (7) days of 1D / 4H / 1H / 15m
candles (with warm-up history so the slow indicators are converged),
replays every completed 15-minute window -- snapshot at window open,
outcome at window close -- and mines the situations that were reliably
right. See mtf_engine.py for the method and the out-of-sample honesty
check.

Window outcome = whether the window's own 15-minute BTC/USDT candle closed
at or above its open (Polymarket's "Up" rule). Windows sit on the
epoch-multiple-of-900s grid (same as Polymarket's), so a Binance 15m
candle is exactly one window. Polymarket settles on the Chainlink BTC/USD
stream, not Binance, and doesn't expose historical order books, but the two
prices track closely, so this is a solid proxy label.

Network failures are non-fatal by design: the bot still starts, just
with no models (so no trades) until a retry succeeds.
"""
import asyncio

from . import config
from .marketdata import fetch_backtest_data
from .mtf_engine import MTFPredictor, build_records


async def run_prebacktest(predictor: MTFPredictor) -> dict:
    try:
        data = await fetch_backtest_data(config.MTF_BACKTEST_DAYS)
    except Exception as e:
        return {"windows": 0, "rules": 0, "error": f"{type(e).__name__}: {e}"}
    try:
        records = await asyncio.to_thread(build_records, data)
        if not records:
            return {"windows": 0, "rules": 0,
                    "error": "no complete windows could be built from the fetched candles"}
        await asyncio.to_thread(predictor.load_records, records)
        return {"windows": len(records), "rules": len(predictor.rules), "error": None}
    except Exception as e:
        return {"windows": 0, "rules": 0, "error": f"{type(e).__name__}: {e}"}
