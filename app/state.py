"""Shared runtime state + the background loop that drives both engines."""
import asyncio
import time
from collections import deque
from typing import Optional

from . import config
from .engine_a import EngineA
from .engine_b import EngineB
from .models import PricePoint, Side, WindowMarket
from .paper_broker import PaperBroker
from .polymarket_client import PolymarketClient


class BotState:
    def __init__(self):
        self.broker = PaperBroker(config.STARTING_BALANCE_USDC)
        self.engine_a = EngineA(self.broker)
        self.engine_b = EngineB(self.broker)
        self.client = PolymarketClient()
        self.current_window: Optional[WindowMarket] = None
        self.price_history: deque = deque(maxlen=300)  # ~5 min at 1s ticks
        self.last_up_price: Optional[float] = None
        self.last_down_price: Optional[float] = None
        self.status = "starting"
        self.error: Optional[str] = None
        self._task: Optional[asyncio.Task] = None

    async def start(self):
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
        await self.client.close()

    async def _run_loop(self):
        self.status = "running"
        while True:
            try:
                await self._tick()
            except Exception as e:  # keep the loop alive no matter what
                self.error = str(e)
            await asyncio.sleep(config.POLL_INTERVAL_SECONDS)

    async def _tick(self):
        now = time.time()
        window = await self.client.get_active_window(now)
        if window is None:
            self.error = "No market found for current window slug"
            return
        self.error = None

        if self.current_window is None or window.slug != self.current_window.slug:
            await self._roll_window(window)

        up_price = await self.client.get_price(self.current_window.token_up)
        down_price = await self.client.get_price(self.current_window.token_down)
        self.last_up_price, self.last_down_price = up_price, down_price
        self.price_history.append(PricePoint(ts=now, up=up_price, down=down_price))

        seconds_to_close = self.current_window.close_ts - now
        self.engine_a.on_tick(up_price, down_price, seconds_to_close)
        self.engine_b.on_tick(up_price, down_price, seconds_to_close)

    async def _roll_window(self, new_window: WindowMarket):
        # Finalize the previous window before starting the new one.
        if self.current_window is not None:
            winning_side = self._infer_winner()
            self.engine_a.finalize_window(winning_side)
            self.engine_b.finalize_window(winning_side)

        self.current_window = new_window
        self.price_history.clear()
        self.engine_a.reset_for_window(new_window)
        self.engine_b.reset_for_window(new_window)

    def _infer_winner(self) -> Optional[Side]:
        """Best-effort winner inference from the last observed prices of the
        window that just ended: whichever side priced higher wins (resolves
        to $1). This is a paper-trading approximation of on-chain resolution."""
        if self.last_up_price is None or self.last_down_price is None:
            return None
        return Side.UP if self.last_up_price >= self.last_down_price else Side.DOWN

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        return {
            "status": self.status,
            "error": self.error,
            "server_time": time.time(),
            "window": None if not self.current_window else {
                "slug": self.current_window.slug,
                "open_ts": self.current_window.open_ts,
                "close_ts": self.current_window.close_ts,
            },
            "prices": {
                "up": self.last_up_price,
                "down": self.last_down_price,
            },
            "price_history": [
                {"ts": p.ts, "up": p.up, "down": p.down}
                for p in list(self.price_history)[-120:]
            ],
            "balance": round(self.broker.balance, 2),
            "starting_balance": self.broker.starting_balance,
            "pnl_total": round(self.broker.balance - self.broker.starting_balance, 2),
            "engine_a": self.engine_a.snapshot(),
            "engine_b": self.engine_b.snapshot(),
            "log": [
                {
                    "ts": e.ts, "engine": e.engine, "window": e.window_slug,
                    "event": e.event, "side": e.side, "price": e.price,
                    "shares": e.shares, "pnl": e.pnl,
                    "balance_after": e.balance_after, "note": e.note,
                }
                for e in reversed(self.broker.log[-100:])
            ],
        }
