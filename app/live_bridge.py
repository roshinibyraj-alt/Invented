"""Mirror demo trade decisions into real orders without changing demo state."""
import asyncio
import os
import time
from dataclasses import dataclass
from typing import Optional

from . import config
from .broker import Broker
from .live_order_guard import LiveOrderGuard
from .models import TradeLogEntry, WindowMarket


LIVE_BASE_USD = 1.0
EPHEMERAL_GUARD_DB = "/tmp/polymarket_live_orders.sqlite"
BALANCE_REFRESH_SECONDS = 30


@dataclass(frozen=True)
class OrderIntent:
    slug: str
    side: str
    token_id: str
    reference_price: float
    close_ts: float
    budget_usd: float = 0.0
    open_ts: float = 0.0


class LiveBridge:
    """A separate, best-effort executor; its results never enter the demo."""

    def __init__(self):
        self.enabled = config.TRADING_MODE == "live"
        self.broker = Broker()
        self.budget_usd = LIVE_BASE_USD
        self._queue: asyncio.Queue[Optional[OrderIntent]] = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None
        self._failed = False
        self._buy_halted = False
        self._seen_windows: set[str] = set()
        self._guard: Optional[LiveOrderGuard] = None
        self._ephemeral_guard = False
        self._started_at: Optional[float] = None

    async def start(self):
        if self.enabled:
            guard_path = os.getenv("LIVE_ORDER_GUARD_DB", "")
            self._ephemeral_guard = not bool(guard_path)
            self._started_at = time.time()
            try:
                self._guard = LiveOrderGuard(guard_path or EPHEMERAL_GUARD_DB)
            except Exception as exc:
                self._failed = True
                self.broker.log_event("LIVE_GUARD_ERROR", note=f"real buys disabled: {exc}")
                return
            if self._ephemeral_guard:
                self.broker.log_event(
                    "LIVE_GUARD_EPHEMERAL",
                    note="temporary local guard; run one instance; startup skips the current window",
                )
            self._task = asyncio.create_task(self._run())

    async def close(self):
        if self._task:
            if not self._task.done():
                self._queue.put_nowait(None)
            await self._task

    def on_demo_event(
        self,
        entry: TradeLogEntry,
        window: Optional[WindowMarket],
    ):
        if entry.engine != "E2":
            return

        if entry.event == "CANDLE_BUY":
            if entry.window_slug in self._seen_windows:
                return
            self._seen_windows.add(entry.window_slug)
            if not self.enabled or self._failed or self._buy_halted or window is None:
                return
            if (self._ephemeral_guard and self._started_at is not None
                    and window.open_ts < self._started_at):
                self.broker.log_event(
                    "LIVE_BUY_SKIPPED", window=entry.window_slug,
                    note="started during this window; next full window can trade",
                )
                return
            token_id = window.token_up if entry.side == "UP" else window.token_down
            if token_id is None or entry.price is None:
                self.broker.log_event("LIVE_BUY_SKIPPED", window=entry.window_slug, note="missing token or ask")
                return
            self._queue.put_nowait(OrderIntent(
                entry.window_slug, entry.side or "", token_id,
                entry.price, window.close_ts, self.budget_usd, window.open_ts,
            ))
            self.broker.log_event(
                "LIVE_BUY_QUEUED", window=entry.window_slug,
                side=entry.side, trade_usd=self.budget_usd,
            )
            return

        if entry.event not in {
            "TP_FILL", "SETTLE_WIN", "SETTLE_LOSS", "SETTLE_UNKNOWN",
            "PRICE_FILTER_SKIPPED_WIN", "PRICE_FILTER_SKIPPED_LOSS",
        }:
            return

        # Scored price skips move the ladder without inventing a trade or P&L.
        # Real fills and unknown results never change the demo-driven budget.
        if entry.event == "PRICE_FILTER_SKIPPED_WIN":
            outcome = 1
        elif entry.event == "PRICE_FILTER_SKIPPED_LOSS":
            outcome = -1
        elif entry.event != "SETTLE_UNKNOWN" and entry.pnl is not None:
            outcome = entry.pnl
        else:
            return
        old_budget = self.budget_usd
        if outcome < 0:
            self.budget_usd *= 2
        elif outcome > 0:
            self.budget_usd = LIVE_BASE_USD
        if self.enabled:
            note = (
                f"demo {entry.event}: signal result={'win' if outcome > 0 else 'loss'}"
                if entry.event.startswith("PRICE_FILTER_SKIPPED_")
                else f"demo {entry.event}: pnl={entry.pnl:.4f}"
            )
            self.broker.log_event(
                "LIVE_NEXT_BUDGET", window=entry.window_slug,
                trade_usd=self.budget_usd,
                note=f"{note}; next real stake ${old_budget:.2f} -> ${self.budget_usd:.2f}",
            )

    async def _run(self):
        try:
            try:
                await self.broker.start()
            except Exception as exc:
                self._failed = True
                self.broker.log_event("LIVE_STARTUP_ERROR", note=str(exc))
                return
            while True:
                try:
                    intent = await asyncio.wait_for(
                        self._queue.get(), timeout=BALANCE_REFRESH_SECONDS,
                    )
                except asyncio.TimeoutError:
                    await self.broker.refresh_balance()
                    continue
                if intent is None:
                    return
                if time.time() >= intent.close_ts:
                    self.broker.log_event("LIVE_ORDER_EXPIRED", window=intent.slug, note="buy")
                    continue
                await self._buy(intent)
                await self.broker.refresh_balance()
        finally:
            await self.broker.close()

    async def _buy(self, intent: OrderIntent):
        if self._buy_halted:
            self.broker.log_event(
                "LIVE_BUY_SKIPPED", window=intent.slug,
                note="real buys halted after an uncertain prior order",
            )
            return
        if time.time() >= intent.close_ts:
            self.broker.log_event(
                "LIVE_ORDER_EXPIRED", window=intent.slug,
                note="buy window closed before reservation",
            )
            return
        try:
            if self._guard is None:
                raise RuntimeError("durable live buy guard is not initialized")
            reserved = self._guard.reserve(intent.slug, intent.token_id, intent.open_ts)
        except Exception as exc:
            self.broker.log_event(
                "LIVE_GUARD_ERROR", window=intent.slug,
                note=f"real buy blocked; cannot reserve window: {exc}",
            )
            return
        if not reserved:
            await self._verify_prior_buy(intent)
            return
        if time.time() >= intent.close_ts:
            try:
                self._guard.record(intent.slug, "expired")
            except Exception as exc:
                self.broker.log_event(
                    "LIVE_GUARD_ERROR", window=intent.slug,
                    note=f"window closed after reservation; status could not be saved: {exc}",
                )
            self.broker.log_event(
                "LIVE_ORDER_EXPIRED", window=intent.slug,
                note="buy window closed after reservation",
            )
            return
        try:
            result = await self.broker.buy(
                intent.token_id, intent.budget_usd, intent.reference_price,
                intent.close_ts,
            )
            try:
                self._guard.record(
                    intent.slug,
                    "expired" if result.get("status") == "WINDOW_CLOSED"
                    else "filled" if result.get("filled") else "rejected",
                    result.get("orderId"),
                )
            except Exception as exc:
                self.broker.log_event("LIVE_GUARD_ERROR", window=intent.slug,
                                      note=f"buy sent; status could not be saved: {exc}")
            if result.get("status") == "WINDOW_CLOSED":
                event = "LIVE_ORDER_EXPIRED"
            elif result.get("filled"):
                event = "LIVE_BUY_FILLED"
            else:
                event = "LIVE_BUY_REJECTED"
            self.broker.log_event(
                event, window=intent.slug, side=intent.side,
                trade_usd=intent.budget_usd,
                note=f"status={result.get('status', 'unknown')}",
            )
        except Exception as exc:
            self._buy_halted = True
            try:
                self._guard.record(intent.slug, "uncertain")
            except Exception as guard_exc:
                self.broker.log_event("LIVE_GUARD_ERROR", window=intent.slug,
                                      note=f"buy outcome uncertain; status could not be saved: {guard_exc}")
            self.broker.log_event(
                "LIVE_BUY_ERROR", window=intent.slug, side=intent.side,
                trade_usd=intent.budget_usd,
                note=f"{exc}; window reserved, further real buys halted until restart",
            )

    async def _verify_prior_buy(self, intent: OrderIntent):
        try:
            token_id, open_ts, status, order_id = self._guard.get(intent.slug)
            # The order history check is informational: an empty or stale API
            # response is NOT proof that a prior submission failed.
            result = await self.broker.verify_buy(token_id, open_ts, order_id)
            self.broker.log_event(
                "LIVE_BUY_DUPLICATE_BLOCKED", window=intent.slug,
                note=f"prior status={status}; exchange={result}; no second buy",
            )
        except Exception as exc:
            self.broker.log_event(
                "LIVE_BUY_VERIFICATION_ERROR", window=intent.slug,
                note=f"{exc}; prior reservation remains; no second buy",
            )

    def snapshot(self) -> dict:
        return {
            "enabled": self.enabled,
            "budget_usd": self.budget_usd,
            "balance_usdc": self.broker.balance if self.enabled else None,
            "balance_updated_at": self.broker.balance_updated_at if self.enabled else None,
            "startup_failed": self._failed,
            "buy_halted": self._buy_halted,
            "recent_events": list(reversed(self.broker.events[-20:])),
        }