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

Each rung carries its own lifecycle (pending -> filled -> closed via TP
or settled at expiry) so the dashboard can show live floating P&L and
trade details per rung, without needing the separate trade log.
"""
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

from . import config
from .models import Position, Side, WindowMarket
from .paper_broker import PaperBroker, compute_maker_rebate


@dataclass
class Rung:
    price: float
    shares: int
    status: str = "pending"  # pending | filled | cancelled | closed_tp | settled_win | settled_loss
    fill_price: Optional[float] = None
    fill_ts: Optional[float] = None
    rebate: Optional[float] = None       # rebate earned on the entry fill
    close_price: Optional[float] = None
    close_ts: Optional[float] = None
    realized_pnl: Optional[float] = None
    position: Optional[Position] = None  # set while filled/open, cleared once closed


def _build_ladder() -> List[float]:
    rungs = []
    steps = round((config.LADDER_HIGH - config.LADDER_LOW) / config.LADDER_STEP)
    for i in range(steps + 1):
        rungs.append(round(config.LADDER_HIGH - i * config.LADDER_STEP, 2))
    return rungs


class EngineB:
    name = "B"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.window: Optional[WindowMarket] = None
        self.rungs: Dict[Side, List[Rung]] = {}
        self.tp_fired: Dict[Side, bool] = {Side.UP: False, Side.DOWN: False}
        self.winner_logged = False

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        prices = _build_ladder()
        self.rungs = {
            Side.UP: [Rung(price=p, shares=config.LADDER_SHARES) for p in prices],
            Side.DOWN: [Rung(price=p, shares=config.LADDER_SHARES) for p in prices],
        }
        self.tp_fired = {Side.UP: False, Side.DOWN: False}
        self.winner_logged = False
        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=(f"Placed {len(prices)} limit buys per side "
                  f"({config.LADDER_HIGH} down to {config.LADDER_LOW}, "
                  f"step {config.LADDER_STEP}), {config.LADDER_SHARES} shares each. "
                  f"No SL. TP at {config.LADDER_TP_PRICE}, no re-entry after TP."),
        )

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.window is None:
            return
        now = now or time.time()
        prices = {Side.UP: up_price, Side.DOWN: down_price}

        for side in (Side.UP, Side.DOWN):
            p = prices.get(side)
            if p is None:
                continue
            self._sweep_fills(side, p, now)
            self._check_take_profit(side, p, now)

        if (not self.winner_logged and seconds_to_close <= config.RESOLUTION_WINDOW_SECONDS
                and seconds_to_close >= 0):
            self._log_resolution_signal(prices)

    def _sweep_fills(self, side: Side, price: float, now: float):
        for rung in self.rungs[side]:
            if rung.status != "pending":
                continue
            if price <= rung.price:
                position = self.broker.buy(
                    self.name, self.window.slug, side, rung.shares, rung.price,
                    note=f"Ladder rung {rung.price:.2f} filled (price {price:.3f})",
                )
                rung.status = "filled"
                rung.fill_price = rung.price
                rung.fill_ts = now
                rung.rebate = compute_maker_rebate(rung.shares, rung.price)
                rung.position = position

    def _check_take_profit(self, side: Side, price: float, now: float):
        if price < config.LADDER_TP_PRICE:
            return
        open_rungs = [r for r in self.rungs[side] if r.status == "filled"]
        pending_rungs = [r for r in self.rungs[side] if r.status == "pending"]
        if not open_rungs and not pending_rungs:
            return  # already fully closed out and cancelled, nothing to do

        for rung in open_rungs:
            pnl = self.broker.sell(
                self.name, self.window.slug, rung.position, price,
                note=f"TP at {config.LADDER_TP_PRICE} (price {price:.3f})",
            )
            rung.status = "closed_tp"
            rung.close_price = price
            rung.close_ts = now
            rung.realized_pnl = pnl
            rung.position = None

        if pending_rungs:
            for rung in pending_rungs:
                rung.status = "cancelled"
            self.broker.log_event(
                self.name, self.window.slug, "RUNGS_CANCELLED",
                side=side.value,
                note=f"TP fired -- cancelled {len(pending_rungs)} remaining unfilled rungs, no re-entry this window",
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
                for rung in self.rungs.get(side, []):
                    if rung.status != "filled":
                        continue
                    won = rung.position.side == winning_side
                    pnl = self.broker.resolve_expiry(
                        self.name, self.window.slug, rung.position, won,
                        note="Held to expiry",
                    )
                    rung.status = "settled_win" if won else "settled_loss"
                    rung.close_price = 1.0 if won else 0.0
                    rung.realized_pnl = pnl
                    rung.position = None
        self.rungs = {Side.UP: [], Side.DOWN: []}

    # ---- dashboard payload -------------------------------------------------

    def _rung_view(self, rung: Rung, mark_price: Optional[float]) -> dict:
        unrealized_pnl = None
        if rung.status == "filled" and mark_price is not None:
            mark_value = rung.shares * mark_price
            unrealized_pnl = (mark_value - rung.position.cost) + (rung.rebate or 0)
        return {
            "price": rung.price,
            "shares": rung.shares,
            "status": rung.status,
            "fill_price": rung.fill_price,
            "fill_ts": rung.fill_ts,
            "rebate": rung.rebate,
            "close_price": rung.close_price,
            "realized_pnl": rung.realized_pnl,
            "unrealized_pnl": unrealized_pnl,
        }

    def _side_summary(self, side: Side, mark_price: Optional[float]) -> dict:
        rungs = self.rungs.get(side, [])
        open_rungs = [r for r in rungs if r.status == "filled"]
        shares = sum(r.shares for r in open_rungs)
        cost = sum(r.position.cost for r in open_rungs)
        rebates_earned = sum(r.rebate or 0 for r in open_rungs)
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
            "open_positions": len(open_rungs),
            "pending_rungs": len([r for r in rungs if r.status == "pending"]),
            "tp_fired": self.tp_fired.get(side, False),
            "rungs": [self._rung_view(r, mark_price) for r in rungs],
        }

    def snapshot(self, up_price: Optional[float] = None, down_price: Optional[float] = None) -> dict:
        return {
            "window": self.window.slug if self.window else None,
            "up": self._side_summary(Side.UP, up_price),
            "down": self._side_summary(Side.DOWN, down_price),
        }
