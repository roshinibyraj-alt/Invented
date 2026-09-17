"""
Binance 1-minute kline websocket feed for BTC/USDT spot.

Used ONLY to determine candle color (red/green) for the entry decision
in app/engine.py -- it never prices or executes anything. All actual
order pricing and fills are against Polymarket's own CLOB order book,
handled entirely in polymarket_client.py / engine.py.

Runs as a long-lived background task (started alongside the main poll
loop in state.py) that keeps a reconnecting websocket open to Binance's
public kline stream and stores a small rolling window of recent
candles, keyed by each candle's open time (minute-aligned, in seconds).
"""
import asyncio
import json
import time
from dataclasses import dataclass
from typing import Optional

import websockets

STREAM_URL = "wss://stream.binance.com:9443/ws/btcusdt@kline_1m"
MAX_CANDLES = 30            # ~30 minutes of history is plenty
RECONNECT_BACKOFF_SECONDS = 3


@dataclass
class Candle:
    open_time: float   # unix seconds, minute-aligned
    open: float
    close: float
    closed: bool        # True once Binance has sent the final update for this candle


class BinanceKlineFeed:
    def __init__(self):
        self.candles: "dict[float, Candle]" = {}
        self.connected = False
        self.last_error: Optional[str] = None
        self.last_message_ts: Optional[float] = None
        self._stop = False
        self._task: Optional[asyncio.Task] = None

    def start(self):
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        self._stop = True
        if self._task:
            self._task.cancel()

    async def _run(self):
        while not self._stop:
            try:
                async with websockets.connect(STREAM_URL, ping_interval=20, ping_timeout=20) as ws:
                    self.connected = True
                    self.last_error = None
                    async for raw in ws:
                        self._handle_message(raw)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.connected = False
                self.last_error = f"{type(e).__name__}: {e}"
            if not self._stop:
                await asyncio.sleep(RECONNECT_BACKOFF_SECONDS)

    def _handle_message(self, raw: str):
        try:
            data = json.loads(raw)
            k = data.get("k") or {}
            open_time_ms = k.get("t")
            open_price = k.get("o")
            close_price = k.get("c")
            is_closed = bool(k.get("x", False))
            if open_time_ms is None or open_price is None or close_price is None:
                return
            open_time_s = open_time_ms / 1000.0
            self.candles[open_time_s] = Candle(
                open_time=open_time_s, open=float(open_price), close=float(close_price), closed=is_closed,
            )
            self.last_message_ts = time.time()
            self._trim()
        except Exception:
            pass  # a single malformed message should never kill the feed

    def _trim(self):
        if len(self.candles) > MAX_CANDLES:
            oldest = sorted(self.candles)[: len(self.candles) - MAX_CANDLES]
            for k in oldest:
                del self.candles[k]

    def get_candle(self, minute_open_ts: float) -> Optional[Candle]:
        """minute_open_ts: unix seconds for the start of the target minute
        (any timestamp within that minute is fine -- it's floored here)."""
        key = int(minute_open_ts // 60) * 60
        return self.candles.get(float(key))

    def status(self) -> dict:
        return {
            "connected": self.connected,
            "last_error": self.last_error,
            "last_message_age_s": (round(time.time() - self.last_message_ts, 1)
                                    if self.last_message_ts else None),
            "candles_cached": len(self.candles),
        }
