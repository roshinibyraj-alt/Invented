"""Shared runtime state + the background loop that drives the engine."""
import asyncio
import time
from collections import deque
from typing import Optional

import httpx

from . import config
from .backtest import run_prebacktest
from .engine import Engine
from .marketdata import fetch_live_frames
from .models import PricePoint, Side, WindowMarket
from .mtf_engine import MTFPredictor, price_at
from .paper_broker import PaperBroker
from .polymarket_client import PolymarketClient

FRAMES_RETRY_SECONDS = 3.0        # how often to retry a failed/incomplete candle fetch within a window
BACKTEST_RETRY_SECONDS = 60.0     # how often to retry the startup pre-backtest if it failed
REBUILD_AFTER_SECONDS = 20.0      # start a periodic re-mine this long after a window opens (never at rollover)


class BotState:
    def __init__(self):
        self.broker = PaperBroker()
        self.predictor = MTFPredictor()
        self.engine = Engine(self.broker, self.predictor)
        self.client = PolymarketClient()
        self.http = httpx.AsyncClient(timeout=10)      # Binance market-data client (analysis only)
        self.current_window: Optional[WindowMarket] = None
        self.price_history: deque = deque(maxlen=300)  # ~5 min at 1s ticks
        self.last_up_bid: Optional[float] = None
        self.last_up_ask: Optional[float] = None
        self.last_down_bid: Optional[float] = None
        self.last_down_ask: Optional[float] = None
        self.status = "starting"
        self.error: Optional[str] = None
        self.backtest_status = {"done": False, "windows": 0, "rules": 0, "error": None}
        self.frames_error: Optional[str] = None
        self._frames_last_attempt = 0.0
        self._backtest_last_attempt = 0.0
        self._backtest_running = False
        self._rebuild_scheduled = False
        self._task: Optional[asyncio.Task] = None

    async def start(self):
        # The pre-backtest runs BEFORE the live loop starts, so the very first
        # window already has its validated situations to match against.
        await self._run_backtest()
        self._task = asyncio.create_task(self._run_loop())

    async def _run_backtest(self):
        if self._backtest_running:
            return
        self._backtest_running = True
        self._backtest_last_attempt = time.time()
        try:
            result = await run_prebacktest(self.predictor)
            self.backtest_status = {"done": True, **result}
            if result["error"]:
                self.broker.log_event(
                    "SYS", "", "PREBACKTEST",
                    note=f"pre-backtest failed ({result['error']}) -- no situations yet, will retry every "
                         f"{BACKTEST_RETRY_SECONDS:.0f}s; no trades until it succeeds")
            else:
                sm = self.predictor.summary
                oos = sm.get("out_of_sample", {})
                self.broker.log_event(
                    "SYS", "", "PREBACKTEST",
                    note=(f"backtested {result['windows']} windows over the last {config.MTF_BACKTEST_DAYS:g} days -> "
                          f"{result['rules']} validated situations. Out-of-sample: accuracy {oos.get('accuracy')} "
                          f"on {oos.get('predicted')} predicted windows (z={oos.get('z')}, coverage {oos.get('coverage')})"))
        finally:
            self._backtest_running = False

    async def stop(self):
        if self._task:
            self._task.cancel()
        await self.http.aclose()
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
        window, error_reason = await self.client.get_active_window(now)
        if window is None:
            self.error = error_reason or "No market found for current window slug"
            return
        self.error = None

        if self.current_window is None or window.slug != self.current_window.slug:
            await self._roll_window(window)

        # CLOB order book only -- no Gamma price fallback. Full depth (not
        # just top-of-book) so the engine can price fills realistically
        # against actual available size instead of assuming unlimited
        # depth at the best quote.
        up_book = await self.client.get_book_full(self.current_window.token_up)
        down_book = await self.client.get_book_full(self.current_window.token_down)
        up_bid = up_book["best_bid"] if up_book else None
        up_ask = up_book["best_ask"] if up_book else None
        down_bid = down_book["best_bid"] if down_book else None
        down_ask = down_book["best_ask"] if down_book else None
        self.last_up_bid, self.last_up_ask = up_bid, up_ask
        self.last_down_bid, self.last_down_ask = down_bid, down_ask

        up_mid = self._midpoint(up_bid, up_ask)
        down_mid = self._midpoint(down_bid, down_ask)
        self.price_history.append(PricePoint(ts=now, up=up_mid, down=down_mid))

        await self._ensure_frames(now)
        # Re-mine the situations only well after the window's entry has fired: the
        # worker thread shares the GIL with this loop, and the +2s entry must not
        # be delayed by CPU work at window rollover.
        if (self.predictor.needs_rebuild() and not self._rebuild_scheduled
                and now - self.current_window.open_ts >= REBUILD_AFTER_SECONDS):
            self._rebuild_scheduled = True
            asyncio.create_task(self._rebuild_rules())
        if (not self.backtest_status.get("windows") and not self._backtest_running
                and now - self._backtest_last_attempt >= BACKTEST_RETRY_SECONDS):
            asyncio.create_task(self._run_backtest())

        seconds_to_close = self.current_window.close_ts - now
        self.engine.on_tick(
            up_bid, up_ask, down_bid, down_ask, seconds_to_close, now=now,
            up_bid_levels=up_book["bids"] if up_book else None,
            up_ask_levels=up_book["asks"] if up_book else None,
            down_bid_levels=down_book["bids"] if down_book else None,
            down_ask_levels=down_book["asks"] if down_book else None,
        )

    async def _ensure_frames(self, now: float):
        """Fetch the 1D/4H/1H/15m (+5m) candles for the current window's
        snapshot, retrying every few seconds until the engine has them."""
        if not self.engine.needs_frames() or now - self._frames_last_attempt < FRAMES_RETRY_SECONDS:
            return
        self._frames_last_attempt = now
        try:
            frames = await fetch_live_frames(self.http)
            price = price_at(frames["5m"], self.current_window.open_ts)
            if self.engine.set_frames(frames, price):
                self.frames_error = None
            else:
                self.frames_error = "incomplete candle data (a timeframe empty or window-open price missing)"
        except Exception as e:
            self.frames_error = f"{type(e).__name__}: {e}"

    async def _rebuild_rules(self):
        try:
            await asyncio.to_thread(self.predictor.rebuild)
        finally:
            self._rebuild_scheduled = False
        sm = self.predictor.summary
        oos = sm.get("out_of_sample", {})
        self.broker.log_event(
            "SYS", "", "MTF_REBUILD",
            note=(f"re-mined situations on {len(self.predictor.records)} windows -> {len(self.predictor.rules)} kept. "
                  f"Out-of-sample accuracy {oos.get('accuracy')} on {oos.get('predicted')} windows (z={oos.get('z')})"))

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
        self.engine.reset_for_window(new_window)

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
            "backtest": self.backtest_status,
            "frames_error": self.frames_error,
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
