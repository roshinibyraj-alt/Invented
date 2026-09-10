"""
Engine B -- instant limit-order ladder.

At window open, place resting limit buy orders on BOTH sides at every
0.01 increment from 0.49 down to 0.02 (48 rungs per side, 96 orders
total), 10 shares each -- placed in one shot, as fast as possible.

A rung fills once that side's observed price falls to or below the
rung's price (we sweep every pending rung against the newly polled
price each tick, so a big price move between polls still fills every
rung it crossed, not just the nearest one).

No stop loss. If a side's price reaches 0.75+, everything currently
held on that side is sold immediately AND all remaining unfilled rungs
on that side are cancelled -- once a side has taken profit, it never
re-enters for the rest of the window (no re-entry, ever). Anything
still held at window close (a side that never hit TP) settles against
Polymarket's real outcome: $1/share if that side won, $0 if it lost.
"""
import time
from typing import Dict, List, Optional

from . import config
from .models import Position, Side, WindowMarket
from .paper_broker import PaperBroker, compute_maker_rebate


def _build_ladder() -> List[float]:
    """Descending list of rung prices from LADDER_HIGH to LADDER_LOW."""
    rungs = []
    price = config.LADDER_HIGH
    # round to avoid float drift (e.g. 0.49 - 0.01*3 != 0.46 exactly)
    steps = round((config.LADDER_HIGH - config.LADDER_LOW) / config.LADDER_STEP)
    for i in range(steps + 1):
        rungs.append(round(config.LADDER_HIGH - i * config.LADDER_STEP, 2))
    return rungs


class EngineB:
    name = "B"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.window: Optional[WindowMarket] = None
        # pending[side] = list of rung prices not yet filled
        self.pending: Dict[Side, List[float]] = {}
        # holdings[side] = list of open Positions on that side (not yet TP'd)
        self.holdings: Dict[Side, List[Position]] = {Side.UP: [], Side.DOWN: []}
        self.tp_fired: Dict[Side, bool] = {Side.UP: False, Side.DOWN: False}
        self.fills_log: List[Position] = []  # every fill ever made this window (for expiry settlement bookkeeping)
        self.winner_logged = False

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        rungs = _build_ladder()
        self.pending = {Side.UP: list(rungs), Side.DOWN: list(rungs)}
        self.holdings = {Side.UP: [], Side.DOWN: []}
        self.tp_fired = {Side.UP: False, Side.DOWN: False}
        self.winner_logged = False
        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=(f"Placed {len(rungs)} limit buys per side "
                  f"({config.LADDER_HIGH} down to {config.LADDER_LOW}, "
                  f"step {config.LADDER_STEP}), {config.LADDER_SHARES} shares each. "
                  f"No SL. TP at {config.LADDER_TP_PRICE}."),
        )

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.window is None:
            return
        prices = {Side.UP: up_price, Side.DOWN: down_price}

        for side in (Side.UP, Side.DOWN):
            p = prices.get(side)
            if p is None:
                continue
            self._sweep_fills(side, p)
            self._check_take_profit(side, p)

        if (not self.winner_logged and seconds_to_close <= config.RESOLUTION_WINDOW_SECONDS
                and seconds_to_close >= 0):
            self._log_resolution_signal(prices)

    def _sweep_fills(self, side: Side, price: float):
        """Fill every pending rung at or above the current price (handles
        a price move that crossed multiple rungs between polls)."""
        remaining = []
        filled_rungs = []
        for rung in self.pending[side]:
            if price <= rung:
                filled_rungs.append(rung)
            else:
                remaining.append(rung)
        self.pending[side] = remaining

        for rung in filled_rungs:
            position = self.broker.buy(
                self.name, self.window.slug, side, config.LADDER_SHARES, rung,
                note=f"Ladder rung {rung:.2f} filled (price {price:.3f})",
            )
            self.holdings[side].append(position)

    def _check_take_profit(self, side: Side, price: float):
        if price < config.LADDER_TP_PRICE:
            return
        held = self.holdings[side]
        if not held and not self.pending[side]:
            return  # already fully closed out and cancelled, nothing to do
        for position in held:
            self.broker.sell(
                self.name, self.window.slug, position, price,
                note=f"TP at {config.LADDER_TP_PRICE} (price {price:.3f})",
            )
        self.holdings[side] = []
        if self.pending[side]:
            cancelled_count = len(self.pending[side])
            self.pending[side] = []
            self.broker.log_event(
                self.name, self.window.slug, "RUNGS_CANCELLED",
                side=side.value,
                note=f"TP fired -- cancelled {cancelled_count} remaining unfilled rungs, no re-entry this window",
            )
        self.tp_fired[side] = True

    def _log_resolution_signal(self, prices):
        winner = None
        for side, p in prices.items():
            if p is not None and p >= config.LADDER_TP_PRICE:
                winner = side
                break
        if winner is not None:
            self.winner_logged = True
            self.broker.log_event(self.name, self.window.slug, "RESOLUTION_SIGNAL",
                                   side=winner.value, price=prices[winner],
                                   note="Logging only, no action taken")

    def finalize_window(self, winning_side: Optional[Side]):
        if winning_side is not None:
            for side in (Side.UP, Side.DOWN):
                for position in self.holdings[side]:
                    won = position.side == winning_side
                    self.broker.resolve_expiry(self.name, self.window.slug, position,
                                                won, note="Held to expiry")
        self.holdings = {Side.UP: [], Side.DOWN: []}
        self.pending = {Side.UP: [], Side.DOWN: []}

    # ---- dashboard payload -------------------------------------------------

    def _side_summary(self, side: Side, mark_price: Optional[float]) -> dict:
        held = self.holdings[side]
        shares = sum(p.shares for p in held)
        cost = sum(p.cost for p in held)
        rebates_earned = sum(compute_maker_rebate(p.shares, p.entry_price) for p in held)
        avg_price = (cost / shares) if shares else None
        mark_value = (shares * mark_price) if (mark_price is not None and shares) else None
        unrealized_pnl = (mark_value - cost + rebates_earned) if mark_value is not None else None
        return {
            "shares": shares,
            "avg_price": avg_price,
            "cost": cost,
            "rebates_earned": rebates_earned,
            "mark_value": mark_value,
            "unrealized_pnl": unrealized_pnl,
            "open_positions": len(held),
            "pending_rungs": len(self.pending.get(side, [])),
            "filled_rungs": [round(p.entry_price, 2) for p in held],
            "tp_fired": self.tp_fired.get(side, False),
        }

    def snapshot(self, up_price: Optional[float] = None, down_price: Optional[float] = None) -> dict:
        return {
            "window": self.window.slug if self.window else None,
            "ladder": _build_ladder(),
            "up": self._side_summary(Side.UP, up_price),
            "down": self._side_summary(Side.DOWN, down_price),
        }
