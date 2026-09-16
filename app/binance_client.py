"""Minimal Binance WebSocket spot-price feed for BTCUSDT.

Used ONLY to determine candle color in the engine (real BTC spot
direction vs. the noisy CLOB probability price). Everything else in the
bot keeps using the Polymarket CLOB -- entry ask, TP, dashboard prices
and resolution inference are untouched.
"""
import asyncio
import json
import time
from typing import Optional

import httpx
import websockets

from . import config


class BinanceClient:
    def __init__(self):
        self.last_price: Optional[float] = None
        self.last_update_ts: Optional[float] = None
        self.connected: bool = False
        self.error: Optional[str] = None
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._task: Optional[asyncio.Task] = None
        self._client = httpx.AsyncClient(timeout=8.0)

    async def start(self):
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        await self._client.aclose()

    async def _seed_price(self):
        """One REST fetch to seed the spot price before the WS fills in."""
        try:
            resp = await self._client.get(
                f"{config.BINANCE_API_BASE}/api/v3/ticker/price",
                params={"symbol": config.BINANCE_SYMBOL},
            )
            resp.raise_for_status()
            price = float(resp.json().get("price"))
            self.last_price = price
            self.last_update_ts = time.time()
        except Exception as e:
            self.error = f"binance seed failed: {e}"

    async def _run(self):
        await self._seed_price()
        delay = 1.0
        while True:
            try:
                self.error = None
                async with websockets.connect(config.BINANCE_WS_URL, ping_interval=20) as ws:
                    self._ws = ws
                    self.connected = True
                    delay = 1.0
                    async for raw in ws:
                        try:
                            data = json.loads(raw)
                            price = float(data.get("p"))
                            if price > 0:
                                self.last_price = price
                                self.last_update_ts = time.time()
                        except Exception:
                            continue
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.connected = False
                self.error = f"binance ws: {e}"
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)
