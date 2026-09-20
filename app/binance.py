"""
Binance public REST 1-minute klines (no API key) -- the minute prices the
strategy reads. Analysis data only; nothing here prices or executes orders.

A 5-minute Polymarket window opens on an epoch-multiple-of-300s boundary, so
its five 1-minute candles are the Binance 1m candles opening at
open_ts, open_ts+60, ... open_ts+240 (each aligned to a minute boundary).
"""
from dataclasses import dataclass
from typing import List, Optional

import httpx

from . import config


@dataclass
class MinuteCandle:
    open_time: float     # unix seconds
    close: float
    close_time: float    # unix seconds (open_time + 59.999)


async def fetch_window_minutes(client: httpx.AsyncClient, window_open_ts: float) -> List[MinuteCandle]:
    """The (up to) five 1-minute candles of the window that opened at
    window_open_ts. Raises on network/HTTP failure."""
    resp = await client.get(config.BINANCE_KLINES_URL, params={
        "symbol": config.BINANCE_SYMBOL, "interval": "1m",
        "startTime": int(window_open_ts * 1000), "limit": 5,
    })
    resp.raise_for_status()
    # row: [openTime, open, high, low, close, volume, closeTime, ...]
    return [MinuteCandle(open_time=r[0] / 1000.0, close=float(r[4]), close_time=r[6] / 1000.0)
            for r in resp.json()]
