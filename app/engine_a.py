"""
Engine A
--------
At window open: two resting limit buys at 0.30 (one per side).
First fill wins -> cancel the other resting order.
No stop loss.
Guard: once held side touches >=0.60, arm it. If price then falls back to
<=0.50, market-sell immediately.
Otherwise hold to expiry. The "0.90+ in the last 2 seconds" rule is used
only to log which side was the winner -- no action is taken on it.
"""
import time
from typing import Optional

from . import config
from .models import EngineAPhase, Position, Side, WindowMarket
from .paper_broker import PaperBroker


class EngineA:
    name = "A"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.phase = EngineAPhase.FLAT
        self.window: Optional[WindowMarket] = None
        self.position: Optional[Position] = None
        self.resting_orders = {}  # side -> limit price, while both still open
        self.winner_logged = False

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        self.position = None
        self.winner_logged = False
        self.resting_orders = {Side.UP: config.ENGINE_A_LIMIT_PRICE,
                                Side.DOWN: config.ENGINE_A_LIMIT_PRICE}
        self.phase = EngineAPhase.WAITING_FILL
        self.broker.log_event(self.name, window.slug, "WINDOW_OPEN",
                               note="Placed 0.30 limit buys on both sides")

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float):
        if self.window is None:
            return
        prices = {Side.UP: up_price, Side.DOWN: down_price}

        if self.phase == EngineAPhase.WAITING_FILL:
            self._check_fill(prices)

        elif self.phase in (EngineAPhase.HOLDING, EngineAPhase.ARMED):
            self._manage_position(prices)

        # Resolution logging (no action), only near close, only once.
        if (not self.winner_logged and seconds_to_close <= config.RESOLUTION_WINDOW_SECONDS
                and seconds_to_close >= 0):
            self._log_resolution_signal(prices)

    def _check_fill(self, prices):
        for side, limit_price in list(self.resting_orders.items()):
            p = prices.get(side)
            if p is not None and p <= limit_price:
                # Filled. Cancel the other side.
                other = side.other()
                self.resting_orders.pop(side, None)
                if other in self.resting_orders:
                    self.resting_orders.pop(other, None)
                    self.broker.log_event(self.name, self.window.slug, "CANCEL",
                                           side=other.value,
                                           note="Other side canceled after fill")
                self.position = self.broker.buy(
                    self.name, self.window.slug, side,
                    config.ENGINE_A_BASE_SHARES, limit_price,
                    note="Limit fill at 0.30",
                )
                self.phase = EngineAPhase.HOLDING
                return

    def _manage_position(self, prices):
        pos = self.position
        if pos is None:
            return
        p = prices.get(pos.side)
        if p is None:
            return

        if self.phase == EngineAPhase.HOLDING and p >= config.ENGINE_A_ARM_PRICE:
            self.phase = EngineAPhase.ARMED
            self.broker.log_event(self.name, self.window.slug, "GUARD_ARMED",
                                   side=pos.side.value, price=p,
                                   note=f"Touched {config.ENGINE_A_ARM_PRICE}+")
            return

        if self.phase == EngineAPhase.ARMED and p <= config.ENGINE_A_GUARD_EXIT_PRICE:
            self.broker.sell(self.name, self.window.slug, pos, p,
                              note="Guard exit: retraced to 0.50 after arming")
            self.position = None
            self.phase = EngineAPhase.EXITED_GUARD

    def _log_resolution_signal(self, prices):
        winner = None
        for side, p in prices.items():
            if p is not None and p >= config.ENGINE_A_RESOLUTION_PRICE:
                winner = side
                break
        if winner is not None:
            self.winner_logged = True
            self.broker.log_event(self.name, self.window.slug, "RESOLUTION_SIGNAL",
                                   side=winner.value, price=prices[winner],
                                   note="Logging only, no action taken")

    def finalize_window(self, winning_side: Optional[Side]):
        """Called by the orchestrator once the market has actually resolved."""
        if self.position is not None and winning_side is not None:
            won = self.position.side == winning_side
            self.broker.resolve_expiry(self.name, self.window.slug, self.position,
                                        won, note="Held to expiry")
            self.position = None
        self.phase = EngineAPhase.RESOLVED

    def snapshot(self) -> dict:
        return {
            "phase": self.phase.value,
            "window": self.window.slug if self.window else None,
            "position": None if not self.position else {
                "side": self.position.side.value,
                "shares": self.position.shares,
                "entry_price": self.position.entry_price,
            },
            "resting_orders": {s.value: p for s, p in self.resting_orders.items()},
        }
