"""Public Binance BTC/USDT 5-minute candle source."""
import time
from typing import List, Optional

import httpx

from . import config


KLINES_URL = "https://api.binance.com/api/v3/klines"


class BinanceCandleClient:
    def __init__(self):
        self._client = httpx.AsyncClient(timeout=8.0)

    async def close(self):
        await self._client.aclose()

    async def get_closed_candles(self, limit: int = 10) -> List[dict]:
        """Return the latest closed five-minute candles, oldest first."""
        try:
            response = await self._client.get(
                KLINES_URL,
                params={
                    "symbol": config.BINANCE_SYMBOL,
                    "interval": "5m",
                    "limit": limit + 1,
                },
            )
            response.raise_for_status()
            rows = response.json()
        except Exception:
            return []
        if not isinstance(rows, list):
            return []

        now_ms = time.time() * 1000
        candles = []
        for row in rows:
            try:
                open_ms = float(row[0])
                open_price = float(row[1])
                close_price = float(row[4])
                close_ms = float(row[6])
            except (IndexError, TypeError, ValueError):
                continue
            if close_ms > now_ms:
                continue
            color = "green" if close_price > open_price else (
                "red" if close_price < open_price else "doji"
            )
            candles.append({
                "open_time_ms": open_ms,
                "close_time_ms": close_ms,
                "open": open_price,
                "close": close_price,
                "color": color,
            })
        return candles

    async def get_candle_for_close_ts(self, close_ts: float) -> Optional[dict]:
        candles = await self.get_closed_candles(limit=5)
        target_ms = close_ts * 1000
        for candle in candles:
            if abs((candle["close_time_ms"] + 1) - target_ms) < 2000:
                return candle
        return None
