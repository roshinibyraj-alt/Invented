"""Background market loop and dashboard state."""
import asyncio
import time
from collections import deque
from typing import Optional

from . import config
from .binance_client import BinanceCandleClient
from .broker import Broker
from .engine import Engine
from .models import WindowMarket
from .polymarket_client import PolymarketClient


class BotState:
    def __init__(self):
        self.broker = Broker()
        self.engine = Engine(self.broker)
        self.client = PolymarketClient()
        self.binance = BinanceCandleClient()
        self.current_window: Optional[WindowMarket] = None
        self.last_up_bid = None
        self.last_up_ask = None
        self.last_down_bid = None
        self.last_down_ask = None
        self.status = "starting"
        self.error = None
        self._task: Optional[asyncio.Task] = None
        self._ticks = 0
        self._pending_settlement_slug: Optional[str] = None

    async def start(self):
        await self.broker.start()
        if config.TRADING_MODE == "live":
            initial_balance = float(self.broker.balance)
            self.engine.capital.balance = initial_balance
            self.engine.capital.starting = initial_balance
            self.engine.capital.peak_equity = initial_balance
            self.engine.capital.equity_curve.clear()
            self.engine.capital.checkpoint(None)
        self.status = "running"
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self.client.close()
        await self.binance.close()
        await self.broker.close()

    async def _run_loop(self):
        while True:
            try:
                await self._tick()
                self.error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.error = str(exc)
                self.broker.log_event("LOOP_ERROR", note=str(exc))
            await asyncio.sleep(config.POLL_INTERVAL_SECONDS)

    async def _tick(self):
        now = time.time()
        window = await self.client.get_active_window(now)
        if window is None:
            self.error = "No current Polymarket market found"
            return
        if self.current_window is None or window.slug != self.current_window.slug:
            await self._roll_window(window)
            if self.current_window is None or self.current_window.slug != window.slug:
                return

        up_bid, up_ask = await self.client.get_book(self.current_window.token_up)
        down_bid, down_ask = await self.client.get_book(self.current_window.token_down)
        self.last_up_bid, self.last_up_ask = up_bid, up_ask
        self.last_down_bid, self.last_down_ask = down_bid, down_ask
        await self.engine.on_tick(up_bid, up_ask, down_bid, down_ask, now)

        self._ticks += 1
        if config.TRADING_MODE == "live" and self._ticks % 15 == 0:
            try:
                await self.broker.get_balance()
            except Exception as exc:
                self.broker.log_event("BALANCE_ERROR", note=str(exc))

    async def _roll_window(self, new_window: WindowMarket):
        if self.current_window is not None:
            winner = None
            if self.engine.state.position is not None:
                winner = await self.client.fetch_resolution(self.current_window.slug)
                if winner is None:
                    if self._pending_settlement_slug != self.current_window.slug:
                        self.broker.log_event(
                            "WINDOW_SETTLEMENT_PENDING",
                            window=self.current_window.slug,
                            note="waiting for official Polymarket resolution; new entries paused",
                        )
                        self._pending_settlement_slug = self.current_window.slug
                    return
                self.broker.log_event(
                    "WINDOW_SETTLED",
                    window=self.current_window.slug,
                    side=winner.value,
                    note="settlement source: official Polymarket resolution",
                )
            await self.engine.finalize_window(winner)
            self._pending_settlement_slug = None

        candle = await self.binance.get_candle_for_close_ts(new_window.open_ts)
        self.engine.record_candle(candle)
        self.broker.log_event(
            "CANDLE",
            window=new_window.slug,
            note=(
                f"{config.BINANCE_SYMBOL} {candle['color']} "
                f"open={candle['open']} close={candle['close']}"
                if candle
                else "Binance candle unavailable; no signal"
            ),
        )
        self.current_window = new_window
        self.last_up_bid = self.last_up_ask = None
        self.last_down_bid = self.last_down_ask = None
        self.engine.reset_for_window(new_window)

    def snapshot(self) -> dict:
        engine = self.engine.snapshot()
        return {
            "status": self.status,
            "error": self.error,
            "trading_mode": config.TRADING_MODE,
            "server_time": time.time(),
            "window": (
                {
                    "slug": self.current_window.slug,
                    "open_ts": self.current_window.open_ts,
                    "close_ts": self.current_window.close_ts,
                    "seconds_remaining": max(0, self.current_window.close_ts - time.time()),
                }
                if self.current_window
                else None
            ),
            "book": {
                "up_bid": self.last_up_bid,
                "up_ask": self.last_up_ask,
                "down_bid": self.last_down_bid,
                "down_ask": self.last_down_ask,
            },
            "engine": engine,
            "log": list(reversed(self.broker.events[-100:])),
        }
