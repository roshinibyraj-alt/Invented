"""Shared runtime state and background market loop."""
import asyncio
import time
from collections import deque
from typing import Optional

from . import config
from .binance_client import BinanceCandleClient
from .engine import Engine
from .live_bridge import LiveBridge
from .models import PricePoint, Side, WindowMarket
from .paper_broker import PaperBroker
from .polymarket_client import PolymarketClient


class BotState:
    def __init__(self):
        self.broker = PaperBroker()
        self.engine = Engine(self.broker)
        self.real = LiveBridge()
        self.broker.on_event = self._mirror_event
        self.client = PolymarketClient()
        self.binance = BinanceCandleClient()
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
        await self.real.start()
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
        await self.real.close()

    def _mirror_event(self, entry):
        try:
            if entry.event == "CANDLE_BUY" and self.engine.capital.balance < 0:
                self.real.broker.log_event(
                    "LIVE_BUY_SKIPPED", window=entry.window_slug,
                    note="demo has insufficient capital to hold the entry",
                )
                return
            self.real.on_demo_event(
                entry, self.current_window,
                self.engine.s.up_bid, self.engine.s.down_bid,
            )
        except Exception as exc:
            # A real-order bridge error must never change the demo's ledger.
            self.real.broker.log_event(
                "LIVE_EVENT_ERROR", window=entry.window_slug, note=str(exc),
            )

    async def _run_loop(self):
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.error = str(exc)
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

        up_bid, up_ask = await self.client.get_book(self.current_window.token_up)
        down_bid, down_ask = await self.client.get_book(self.current_window.token_down)
        self.last_up_bid, self.last_up_ask = up_bid, up_ask
        self.last_down_bid, self.last_down_ask = down_bid, down_ask

        self.price_history.append(PricePoint(
            ts=now,
            up=self._midpoint(up_bid, up_ask),
            down=self._midpoint(down_bid, down_ask),
        ))
        seconds_to_close = self.current_window.close_ts - now
        self.engine.on_tick(
            up_bid, up_ask, down_bid, down_ask, seconds_to_close, now=now
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
                "SYS",
                self.current_window.slug,
                "SETTLED_BY_PRICE",
                side=winning_side.value if winning_side else None,
                note=(
                    f"settled by last observed CLOB midpoint: up={up_mid}, "
                    f"down={down_mid} (official Polymarket resolution is not used)"
                ),
            )
            self.engine.finalize_window(winning_side)

        candle = await self.binance.get_candle_for_close_ts(new_window.open_ts)
        self.engine.record_candle(candle)
        self.broker.log_event(
            "SYS",
            new_window.slug,
            "CANDLE",
            note=(
                f"Binance {config.BINANCE_SYMBOL} candle: {candle['color']} "
                f"(open {candle['open']}, close {candle['close']})"
                if candle
                else "Binance candle unavailable this window -- no candle signal"
            ),
        )
        self.current_window = new_window
        self.price_history.clear()
        self.last_up_bid = self.last_up_ask = None
        self.last_down_bid = self.last_down_ask = None
        self.engine.reset_for_window(new_window)

    def _infer_winner(self) -> Optional[Side]:
        """Settle by whichever side had the higher last observed midpoint."""
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
            "trading_mode": config.TRADING_MODE,
            "demo_mode": "paper",
            "real_trading": self.real.snapshot(),
            "server_time": time.time(),
            "window": None if not self.current_window else {
                "slug": self.current_window.slug,
                "open_ts": self.current_window.open_ts,
                "close_ts": self.current_window.close_ts,
                "seconds_remaining": max(
                    0, self.current_window.close_ts - time.time()
                ),
            },
            "book": {
                "up_bid": self.last_up_bid,
                "up_ask": self.last_up_ask,
                "down_bid": self.last_down_bid,
                "down_ask": self.last_down_ask,
            },
            "prices": {
                "up": self._midpoint(self.last_up_bid, self.last_up_ask),
                "down": self._midpoint(self.last_down_bid, self.last_down_ask),
            },
            "price_history": [
                {"ts": point.ts, "up": point.up, "down": point.down}
                for point in list(self.price_history)[-120:]
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
                    "ts": entry.ts,
                    "engine": entry.engine,
                    "window": entry.window_slug,
                    "event": entry.event,
                    "side": entry.side,
                    "price": entry.price,
                    "shares": entry.shares,
                    "pnl": entry.pnl,
                    "balance_after": entry.balance_after,
                    "note": entry.note,
                }
                for entry in reversed(self.broker.log[-100:])
            ],
        }