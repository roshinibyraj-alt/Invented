"""Shared runtime state + the background loop that drives the engine."""
import asyncio
import time
from collections import deque
from typing import Optional

from . import config
from .engine import Engine
from .kronos_signal import CandleFeed, KronosSignal
from .models import PricePoint, Side, WindowMarket
from .paper_broker import PaperBroker
from .polymarket_client import PolymarketClient


class BotState:
    def __init__(self):
        self.broker = PaperBroker()
        self.engine = Engine(self.broker)
        self.client = PolymarketClient()
        self.candle_feed = CandleFeed()
        self.kronos = KronosSignal(self.candle_feed)
        self.current_window: Optional[WindowMarket] = None
        self.price_history: deque = deque(maxlen=300)  # ~5 min at 1s ticks
        self.last_up_bid: Optional[float] = None
        self.last_up_ask: Optional[float] = None
        self.last_down_bid: Optional[float] = None
        self.last_down_ask: Optional[float] = None
        self.status = "starting"
        self.error: Optional[str] = None
        self._task: Optional[asyncio.Task] = None
        self._warmup_task: Optional[asyncio.Task] = None

    async def start(self):
        # Do not hold FastAPI startup hostage to exchange timeouts. The
        # dashboard and health endpoints should be available immediately
        # while the candle buffer warms in the background.
        self._warmup_task = asyncio.create_task(self.candle_feed.warm_up())
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self):
        tasks = [task for task in (self._task, self._warmup_task) if task]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.client.close()
        await self.candle_feed.close()

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

        # warm_up() owns the feed until it completes; avoid competing HTTP
        # calls during startup. After that, refresh it independently.
        if self._warmup_task is None or self._warmup_task.done():
            await self.candle_feed.refresh()

        if self.current_window is None or window.slug != self.current_window.slug:
            await self._roll_window(window)

        # CLOB order book only -- no Gamma price fallback.
        up_bid, up_ask = await self.client.get_book(self.current_window.token_up)
        down_bid, down_ask = await self.client.get_book(self.current_window.token_down)
        self.last_up_bid, self.last_up_ask = up_bid, up_ask
        self.last_down_bid, self.last_down_ask = down_bid, down_ask

        up_mid = self._midpoint(up_bid, up_ask)
        down_mid = self._midpoint(down_bid, down_ask)
        self.price_history.append(PricePoint(ts=now, up=up_mid, down=down_mid))

        seconds_to_close = self.current_window.close_ts - now
        self.engine.on_tick(up_bid, up_ask, down_bid, down_ask, seconds_to_close, now=now)

    @staticmethod
    def _midpoint(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
        if bid is not None and ask is not None:
            return (bid + ask) / 2
        return ask if ask is not None else bid

    async def _roll_window(self, new_window: WindowMarket):
        # Finalize the previous window before starting the new one.
        if self.current_window is not None:
            winning_side = self._infer_winner()
            up_mid = self._midpoint(self.last_up_bid, self.last_up_ask)
            down_mid = self._midpoint(self.last_down_bid, self.last_down_ask)
            self.broker.log_event(
                "SYS", self.current_window.slug, "SETTLED_BY_PRICE",
                side=winning_side.value if winning_side else None,
                note=(f"settled by last observed CLOB midpoint: up={up_mid}, "
                      f"down={down_mid} (no Polymarket resolution check)"),
            )
            self.engine.finalize_window(winning_side)

        self.current_window = new_window
        self.price_history.clear()
        self.last_up_bid = self.last_up_ask = None
        self.last_down_bid = self.last_down_ask = None

        # The window key makes this a single fresh decision per 5-minute
        # market. A cached signal from the previous window must not stick
        # across a boundary and create a late entry.
        # Kronos inference/model loading is synchronous and can take several
        # seconds on CPU. Run it outside the asyncio event loop so /api/state
        # remains responsive while the new window is being evaluated.
        side, confidence = await asyncio.to_thread(
            self.kronos.get_signal,
            now=time.time(),
            window_key=new_window.slug,
        )
        self.engine.reset_for_window(new_window, side=side, confidence=confidence)

    def _infer_winner(self) -> Optional[Side]:
        """Sole outcome source: whichever side's last observed CLOB midpoint
        was higher when the window rolled over -- a live-market read, not
        Polymarket's settled resolution. See fetch_resolution() in
        polymarket_client.py if you want real-resolution settlement instead."""
        up_mid = self._midpoint(self.last_up_bid, self.last_up_ask)
        down_mid = self._midpoint(self.last_down_bid, self.last_down_ask)
        if up_mid is None or down_mid is None:
            return None
        return Side.UP if up_mid >= down_mid else Side.DOWN

    # ---- dashboard payload -------------------------------------------------

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
            },
            "book": {
                "up_bid": self.last_up_bid, "up_ask": self.last_up_ask,
                "down_bid": self.last_down_bid, "down_ask": self.last_down_ask,
            },
            "prices": {
                "up": self._midpoint(self.last_up_bid, self.last_up_ask),
                "down": self._midpoint(self.last_down_bid, self.last_down_ask),
            },
            "kronos": {
                "volatility": self.kronos.last_volatility,
                "confidence_threshold": self.kronos.last_threshold,
            },
            "connectivity": {
                "candle_source": self.candle_feed.active_source,
                "candle_reconnects": self.candle_feed.reconnects,
                "polymarket_reconnects": self.client.reconnects,
            },
            "price_history": [
                {"ts": p.ts, "up": p.up, "down": p.down}
                for p in list(self.price_history)[-120:]
            ],
            "pnl_total": round(eng["realized_pnl"] + eng["unrealized_pnl"], 2),
            "demo_capital": {
                "balance": eng["balance"],
                "starting_capital": eng["starting_capital"],
                "halted": eng["halted"],
            },
            "engine": eng,
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
