"""
Engine B
--------
Watches both sides after open. The first side to touch 0.70 is skipped
for the window. If the OTHER side then reaches 0.70, market-buy it
(base 200 shares, martingale-adjusted). Stop loss at 0.50. Same
logging-only 0.90+ resolution rule as Engine A. On a stop-loss loss,
next window's size doubles; a win resets size back to base.
"""
import time
from typing import Optional

from . import config
from .models import EngineBPhase, Position, Side, WindowMarket
from .paper_broker import PaperBroker


class EngineB:
    name = "B"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.phase = EngineBPhase.FLAT
        self.window: Optional[WindowMarket] = None
        self.position: Optional[Position] = None
        self.skipped_side: Optional[Side] = None
        self.current_shares = config.ENGINE_B_BASE_SHARES
        self.winner_logged = False

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        self.position = None
        self.skipped_side = None
        self.winner_logged = False
        self.phase = EngineBPhase.WATCHING
        self.broker.log_event(self.name, window.slug, "WINDOW_OPEN",
                               note=f"Watching for first 0.70 touch (size={self.current_shares})")

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float):
        if self.window is None:
            return
        prices = {Side.UP: up_price, Side.DOWN: down_price}

        if self.phase == EngineBPhase.WATCHING:
            self._check_first_touch(prices)
        elif self.phase == EngineBPhase.ONE_SIDE_SKIPPED:
            self._check_entry(prices)
        elif self.phase == EngineBPhase.IN_POSITION:
            self._manage_position(prices)

        if (not self.winner_logged and seconds_to_close <= config.RESOLUTION_WINDOW_SECONDS
                and seconds_to_close >= 0):
            self._log_resolution_signal(prices)

    def _check_first_touch(self, prices):
        for side, p in prices.items():
            if p is not None and p >= config.ENGINE_B_TRIGGER_PRICE:
                self.skipped_side = side
                self.phase = EngineBPhase.ONE_SIDE_SKIPPED
                self.broker.log_event(self.name, self.window.slug, "SIDE_SKIPPED",
                                       side=side.value, price=p,
                                       note="First to touch 0.70 -- skipped")
                return

    def _check_entry(self, prices):
        target_side = self.skipped_side.other()
        p = prices.get(target_side)
        if p is not None and p >= config.ENGINE_B_TRIGGER_PRICE:
            self.position = self.broker.buy(
                self.name, self.window.slug, target_side,
                self.current_shares, p, note="Market buy on 0.70 trigger",
            )
            self.phase = EngineBPhase.IN_POSITION

    def _manage_position(self, prices):
        pos = self.position
        if pos is None:
            return
        p = prices.get(pos.side)
        if p is None:
            return
        if p <= config.ENGINE_B_STOP_LOSS_PRICE:
            self.broker.sell(self.name, self.window.slug, pos, p,
                              note="Stop loss hit at 0.50")
            self.position = None
            self.phase = EngineBPhase.STOPPED_OUT
            self.current_shares *= config.ENGINE_B_MARTINGALE_MULTIPLIER
            self.broker.log_event(self.name, self.window.slug, "MARTINGALE_UP",
                                   note=f"Next window size -> {self.current_shares}")

    def _log_resolution_signal(self, prices):
        winner = None
        for side, p in prices.items():
            if p is not None and p >= config.ENGINE_B_RESOLUTION_PRICE:
                winner = side
                break
        if winner is not None:
            self.winner_logged = True
            self.broker.log_event(self.name, self.window.slug, "RESOLUTION_SIGNAL",
                                   side=winner.value, price=prices[winner],
                                   note="Logging only, no action taken")

    def finalize_window(self, winning_side: Optional[Side]):
        if self.position is not None and winning_side is not None:
            won = self.position.side == winning_side
            self.broker.resolve_expiry(self.name, self.window.slug, self.position,
                                        won, note="Held to expiry")
            if won:
                self.current_shares = config.ENGINE_B_BASE_SHARES
                self.broker.log_event(self.name, self.window.slug, "MARTINGALE_RESET",
                                       note=f"Win -> size reset to {self.current_shares}")
            self.position = None
        elif self.phase not in (EngineBPhase.STOPPED_OUT,):
            # No position was ever taken this window (both sides skipped
            # scenario, or trigger never hit) -- size stays as-is.
            pass
        self.phase = EngineBPhase.RESOLVED

    def snapshot(self) -> dict:
        return {
            "phase": self.phase.value,
            "window": self.window.slug if self.window else None,
            "skipped_side": self.skipped_side.value if self.skipped_side else None,
            "current_shares": self.current_shares,
            "position": None if not self.position else {
                "side": self.position.side.value,
                "shares": self.position.shares,
                "entry_price": self.position.entry_price,
            },
        }
