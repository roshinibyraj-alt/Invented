"""Shared runtime state + the background loop that drives the engine."""
import asyncio
import time
from collections import deque
from typing import Optional

from . import config
from .engine import Engine
from .models import PricePoint, Side, WindowMarket
from .paper_broker import PaperBroker
from .polymarket_client import PolymarketClient


class BotState:
    def __init__(self):
        self.broker = PaperBroker()
        self.engine = Engine(self.broker)
        self.client = PolymarketClient()
        self.current_window: Optional[WindowMarket] = None
        self.price_history: deque = deque(maxlen=300)
        self.last_up_bid: Optional[float] = None
        self.last_up_ask: Optional[float] = None
        self.last_down_bid: Optional[float] = None
        self.last_down_ask: Optional[float] = None
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
            except Exception as e:
                self.error = str(e)
            await asyncio.sleep(config.POLL_INTERVAL_SECONDS)

    async def _tick(self):
        now = time.time()

        if self.current_window is not None and now < self.current_window.close_ts:
            window = self.current_window
        else:
            window, error_reason = await self.client.get_active_window(now)
            if window is None:
                self.error = error_reason or "No market found for current window slug"
                return
            self.error = None
            if self.current_window is None or window.slug != self.current_window.slug:
                await self._roll_window(window)

        up_book, down_book = await asyncio.gather(
            self.client.get_book_full(self.current_window.token_up),
            self.client.get_book_full(self.current_window.token_down),
        )
        up_bid = up_book["best_bid"] if up_book else None
        up_ask = up_book["best_ask"] if up_book else None
        down_bid = down_book["best_bid"] if down_book else None
        down_ask = down_book["best_ask"] if down_book else None
        self.last_up_bid, self.last_up_ask = up_bid, up_ask
        self.last_down_bid, self.last_down_ask = down_bid, down_ask

        up_mid = self._midpoint(up_bid, up_ask)
        down_mid = self._midpoint(down_bid, down_ask)
        self.price_history.append(PricePoint(ts=now, up=up_mid, down=down_mid))

        self.engine.on_tick(
            up_bid, up_ask, down_bid, down_ask,
            self.current_window.close_ts - now, now=now,
            up_bid_levels=up_book["bids"] if up_book else None,
            up_ask_levels=up_book["asks"] if up_book else None,
            down_bid_levels=down_book["bids"] if down_book else None,
            down_ask_levels=down_book["asks"] if down_book else None,
        )

    @staticmethod
    def _midpoint(bid, ask):
        if bid is not None and ask is not None:
            return (bid + ask) / 2
        return ask if ask is not None else bid

    async def _roll_window(self, new_window: WindowMarket):
        if self.current_window is not None:
            winning_side = self._infer_winner()
            up_mid = self._midpoint(self.last_up_bid, self.last_up_ask)
            down_mid = self._midpoint(self.last_down_bid, self.last_down_ask)
            self.broker.log_event(
                "SYS", self.current_window.slug, "SETTLED_BY_PRICE",
                side=winning_side.value if winning_side else None,
                note=(f"settled by last observed CLOB midpoint: up={up_mid}, "
                      f"down={down_mid}"),
            )
            self.engine.finalize_window(winning_side)

        self.current_window = new_window
        self.price_history.clear()
        self.last_up_bid = self.last_up_ask = None
        self.last_down_bid = self.last_down_ask = None
        self.engine.reset_for_window(new_window)

    def _infer_winner(self) -> Optional[Side]:
        up_mid = self._midpoint(self.last_up_bid, self.last_up_ask)
        down_mid = self._midpoint(self.last_down_bid, self.last_down_ask)
        if up_mid is None or down_mid is None:
            return None
        return Side.UP if up_mid >= down_mid else Side.DOWN

    def snapshot(self) -> dict:
        eng = self.engine.snapshot()
        return {
            "status": self.status,
            "error": self.error,
            "server_time": time.time(),
            "window": None if not self.current_window else {
                "slug": self.current_window.slug,
                "open_ts": self.current_window.open_ts,
                "close_ts": self.current_window.close_ts,
                "seconds_to_close": round(self.current_window.close_ts - time.time(), 1),
            },
            "book": {
                "up_bid": self.last_up_bid, "up_ask": self.last_up_ask,
                "down_bid": self.last_down_bid, "down_ask": self.last_down_ask,
            },
            "prices": {
                "up": self._midpoint(self.last_up_bid, self.last_up_ask),
                "down": self._midpoint(self.last_down_bid, self.last_down_ask),
            },
            "price_history": [
                {"ts": p.ts, "up": p.up, "down": p.down}
                for p in list(self.price_history)[-120:]
            ],
            "engine": eng,
            "log": [
                {"ts": e.ts, "engine": e.engine, "window": e.window_slug,
                 "event": e.event, "side": e.side, "price": e.price,
                 "shares": e.shares, "pnl": e.pnl,
                 "balance_after": e.balance_after, "note": e.note}
                for e in reversed(self.broker.log[-100:])
            ],
        }
