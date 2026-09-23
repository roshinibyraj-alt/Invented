"""
Runtime orchestration: owns the poll loop, rolls windows, reads each window's winner from the
CLOB in its last second, and feeds ticks to the Engine. No Binance / no external price feed --
everything here comes from Polymarket's own CLOB.
"""
import asyncio
import time
from typing import Optional

from . import config
from .engine import Engine
from .models import Side, WindowMarket
from .paper_broker import PaperBroker
from .polymarket_client import PolymarketClient


class BotState:
    def __init__(self):
        self.client = PolymarketClient()
        self.broker = PaperBroker()
        self.engine = Engine(self.broker)

        self.current_window: Optional[WindowMarket] = None
        self.market_error: Optional[str] = None
        self.status = "starting"
        self.error: Optional[str] = None
        self._task: Optional[asyncio.Task] = None

        # Last-second CLOB read of the window that is about to close (see _watch_close).
        self._last_second_prices = None

    async def start(self):
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
        await self.client.close()

    async def _run_loop(self):
        self.status = "running"
        loop = asyncio.get_running_loop()
        while True:
            started = loop.time()
            try:
                await self._tick()
            except Exception as e:  # keep the loop alive no matter what
                self.error = str(e)
            interval = self._poll_interval()
            # sleep only what is left of the interval, so slow ticks don't stretch the cadence
            await asyncio.sleep(max(0.0, interval - (loop.time() - started)))

    def _poll_interval(self) -> float:
        w = self.current_window
        if w is not None and w.close_ts - time.time() <= config.CLOSE_PHASE_SECONDS:
            return config.CLOSE_PHASE_POLL_SECONDS       # poll fast right at the close, for the 0.95 read
        return config.POLL_INTERVAL_SECONDS

    async def _tick(self):
        now = time.time()
        window, reason = await self.client.get_active_window(now)
        if window is None:
            self.market_error = reason
            return
        self.market_error = None

        if self.current_window is None or window.slug != self.current_window.slug:
            await self._roll_window(window, now)

        up_bid, up_ask, up_bid_lv, up_ask_lv = None, None, None, None
        down_bid, down_ask, down_bid_lv, down_ask_lv = None, None, None, None
        if window.token_up and window.token_down:
            up_book, down_book = await asyncio.gather(
                self.client.get_book_full(window.token_up),
                self.client.get_book_full(window.token_down),
            )
            if up_book:
                up_bid, up_ask = up_book["best_bid"], up_book["best_ask"]
                up_bid_lv, up_ask_lv = up_book["bids"], up_book["asks"]
            if down_book:
                down_bid, down_ask = down_book["best_bid"], down_book["best_ask"]
                down_bid_lv, down_ask_lv = down_book["bids"], down_book["asks"]

        self.engine.on_tick(up_bid, up_ask, down_bid, down_ask, now=now,
                            up_bid_levels=up_bid_lv, up_ask_levels=up_ask_lv,
                            down_bid_levels=down_bid_lv, down_ask_levels=down_ask_lv)

        # Last-second winner read, while it's still the live window. Keep overwriting with
        # the FRESHEST reading available right up to close, rather than gating on one exact
        # tick landing in a narrow 1s sliver -- a single missed/late poll tick there used to
        # mean no read was ever captured, and the window fell back to "undecided" forever.
        # _read_result() bounds staleness with SETTLE_MAX_STALENESS_SECONDS, so this just
        # maximizes the chance of having *some* recent-enough reading by close.
        if (now < window.close_ts and window.close_ts - now <= config.CLOSE_PHASE_SECONDS
                and up_bid is not None and down_bid is not None):
            self._last_second_prices = (up_bid, up_ask, down_bid, down_ask, now)

    async def _roll_window(self, window: WindowMarket, now: float):
        prev = self.current_window
        # A window we only see well after it opened (bot just started) is watched, but not
        # traded: the previous window's result is the signal, and there is none yet.
        late = prev is None and (now - window.open_ts) > (config.WINDOW_SECONDS / 2)

        if prev is not None:
            result = self._read_result(prev)
            self.engine.finalize_window(result)

        self.current_window = window
        self._last_second_prices = None
        self.engine.reset_for_window(window, now=now)
        if late:
            self.engine._no_signal("bot started mid-window -- watching this one to read its result")

    def _read_result(self, window: WindowMarket) -> dict:
        """The window that just closed: who won, from the freshest close-phase CLOB read
        captured in _tick(). WIN_PRICE (0.95) or higher on a side's bid = that side won.
        Neither side there, no read was captured at all (e.g. an empty book the whole close
        phase), or the freshest read we did get is older than SETTLE_MAX_STALENESS_SECONDS
        (i.e. we never got a fresh tick in right before close) = undecided."""
        up = down = None
        age = None
        snap = getattr(self, "_last_second_prices", None)
        if snap is not None:
            up_bid, up_ask, down_bid, down_ask, ts = snap
            age = round(window.close_ts - ts, 2)
            if age <= config.SETTLE_MAX_STALENESS_SECONDS:
                up, down = up_bid, down_bid
        winner = None
        if up is not None and up >= config.WIN_PRICE:
            winner = Side.UP
        elif down is not None and down >= config.WIN_PRICE:
            winner = Side.DOWN
        return {"winner": winner, "up": up, "down": down, "age": age}

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        now = time.time()
        w = self.current_window
        window_payload = None
        seconds_left = None
        if w is not None:
            seconds_left = max(0.0, w.close_ts - now)
            window_payload = {"slug": w.slug, "open_ts": w.open_ts, "close_ts": w.close_ts,
                              "seconds_left": round(seconds_left, 1)}

        s = self.engine.s
        book = {
            "up_bid": s.up_bid, "up_ask": s.up_ask, "down_bid": s.down_bid, "down_ask": s.down_ask,
        }

        return {
            "server_time": now,
            "status": self.status,
            "error": self.error,
            "market_error": self.market_error,
            "window": window_payload,
            "book": book,
            "engine": self.engine.snapshot(),
            "log": [
                {"ts": e.ts, "engine": e.engine, "window": e.window_slug, "event": e.event,
                 "side": e.side, "price": e.price, "shares": e.shares, "fee": e.fee, "pnl": e.pnl,
                 "balance_after": e.balance_after, "note": e.note}
                for e in reversed(self.broker.log[-100:])
            ],
        }
