"""
Binance public REST klines (no API key) -- OHLCV for the four analysis
timeframes (1D, 4H, 1H, 15m).

  * 1D / 4H / 1H / 15m  -> inputs to the indicators (app/indicators.py)
  * 15m (again)         -> the price at each window's open and, for the
                           backtest, each window's true outcome. Windows
                           sit on the epoch-multiple-of-900s grid, so a
                           15m Binance candle IS one Polymarket window:
                           it opens at the window's open, closes at its
                           close. (At window open, the newest 15m candle
                           is the just-started window itself: its OPEN is
                           the window-open price, its other fields are
                           still unknown and are never read.)

Nothing here prices or executes anything -- all order pricing and fills
are against Polymarket's own CLOB book (polymarket_client.py).

Every fetch is best-effort and raises on failure; callers decide how to
degrade (see backtest.py / state.py).
"""
import asyncio
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

import httpx

from . import config

# name -> (Binance interval string, seconds)
TIMEFRAMES: Dict[str, tuple] = {
    "1D": ("1d", 86400),
    "4H": ("4h", 14400),
    "1H": ("1h", 3600),
    "15m": ("15m", 900),
}
TF_ORDER = ["1D", "4H", "1H", "15m"]   # display / rule-text order, slowest first
WINDOW_TF = "15m"                       # the timeframe whose candles ARE the market windows
KLINES_LIMIT = 1000                     # Binance's per-request cap


@dataclass
class Candle:
    open_time: float    # unix seconds
    open: float
    high: float
    low: float
    close: float
    volume: float


def _row_to_candle(row) -> Candle:
    # kline row: [openTime, open, high, low, close, volume, closeTime, ...]
    return Candle(open_time=row[0] / 1000.0, open=float(row[1]), high=float(row[2]),
                  low=float(row[3]), close=float(row[4]), volume=float(row[5]))


async def fetch_klines(client: httpx.AsyncClient, interval: str, start_s: Optional[float] = None,
                       end_s: Optional[float] = None, limit: Optional[int] = None) -> List[Candle]:
    """Ascending candles. With start_s (and optionally end_s) it paginates
    in 1000-candle chunks; with only `limit` it returns the most recent
    `limit` candles (the newest one may still be forming)."""
    if start_s is None:
        resp = await client.get(config.BINANCE_KLINES_URL, params={
            "symbol": config.BINANCE_SYMBOL, "interval": interval, "limit": min(limit or 500, KLINES_LIMIT)})
        resp.raise_for_status()
        return [_row_to_candle(r) for r in resp.json()]

    out: List[Candle] = []
    cursor_ms = int(start_s * 1000)
    end_ms = int((end_s if end_s is not None else time.time()) * 1000)
    while cursor_ms < end_ms:
        resp = await client.get(config.BINANCE_KLINES_URL, params={
            "symbol": config.BINANCE_SYMBOL, "interval": interval,
            "startTime": cursor_ms, "endTime": end_ms, "limit": KLINES_LIMIT})
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        out.extend(_row_to_candle(r) for r in batch)
        cursor_ms = int(batch[-1][0]) + 1
        if len(batch) < KLINES_LIMIT:
            break
    return out


async def fetch_backtest_data(days: float) -> Dict[str, List[Candle]]:
    """History for the backtest: for every analysis timeframe (15m doubles
    as the window candles), `days` of candles PLUS config.MTF_WARMUP_CANDLES
    of extra history before them so the slow indicators (EMA50, ADX, MACD)
    are fully converged on the very first backtest window."""
    now = time.time()
    start = now - days * 86400
    async with httpx.AsyncClient(timeout=25) as client:
        jobs = {}
        for name in TF_ORDER:
            interval, secs = TIMEFRAMES[name]
            jobs[name] = fetch_klines(client, interval, start_s=start - config.MTF_WARMUP_CANDLES * secs, end_s=now)
        results = await asyncio.gather(*jobs.values())
    return dict(zip(jobs.keys(), results))


async def fetch_live_frames(client: Optional[httpx.AsyncClient] = None) -> Dict[str, List[Candle]]:
    """Most recent candles for every timeframe, for a live prediction.
    Newest candle in each list may still be forming; the tokenizer only
    reads fully-closed candles as of the window's open (plus the forming
    candle's OPEN price, which is already known)."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=10)
    try:
        jobs = {}
        for name in TF_ORDER:
            jobs[name] = fetch_klines(client, TIMEFRAMES[name][0], limit=config.MTF_WARMUP_CANDLES + 20)
        results = await asyncio.gather(*jobs.values())
        return dict(zip(jobs.keys(), results))
    finally:
        if own:
            await client.aclose()
