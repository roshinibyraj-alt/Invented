from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import time
import itertools

from . import config

_trade_id_counter = itertools.count(1)


class Side(str, Enum):
    UP = "UP"
    DOWN = "DOWN"


class OrderStatus(str, Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"


class Outcome(str, Enum):
    WIN = "WIN"
    LOSS = "LOSS"
    NO_FILL = "NO_FILL"


class RungMode(str, Enum):
    ACTIVE = "ACTIVE"      # trades for real, real capital at risk
    SHADOW = "SHADOW"      # observes only — same logic, zero capital, no real orders


@dataclass
class SimOrder:
    side: Side
    price: float
    size: int
    status: OrderStatus = OrderStatus.PENDING
    fill_price: Optional[float] = None
    filled_at: Optional[float] = None

    def to_dict(self):
        return {
            "side": self.side.value,
            "price": self.price,
            "size": self.size,
            "status": self.status.value,
            "fill_price": self.fill_price,
        }


@dataclass
class TradeRecord:
    id: int
    window_slug: str
    rung_price: float
    outcome: Outcome
    side_filled: Optional[str]
    size: int
    cost: float
    pnl: float
    balance_after: float
    settled_at: float

    def to_dict(self):
        return {
            "id": self.id,
            "window_slug": self.window_slug,
            "rung_price": self.rung_price,
            "outcome": self.outcome.value,
            "side_filled": self.side_filled,
            "size": self.size,
            "cost": round(self.cost, 2),
            "pnl": round(self.pnl, 2),
            "balance_after": round(self.balance_after, 2),
            "settled_at": self.settled_at,
        }


@dataclass
class RungState:
    """Persistent, independent strategy for one price level (e.g. 0.40).
    Lives across many windows. Mode, streaks and capital move; size never does.
    """
    price: float
    mode: RungMode = RungMode.ACTIVE
    capital_start: float = config.CAPITAL_PER_RUNG
    capital_balance: float = field(default=config.CAPITAL_PER_RUNG)
    wins: int = 0
    losses: int = 0
    no_fills: int = 0
    win_streak: int = 0
    total_pnl: float = 0.0
    history: list[TradeRecord] = field(default_factory=list)

    # shadow-mode observation stats (no capital, informational only)
    shadow_wins: int = 0
    shadow_losses: int = 0
    shadow_no_fills: int = 0
    shadow_log: list[dict] = field(default_factory=list)

    @property
    def total_trades(self) -> int:
        return self.wins + self.losses

    @property
    def win_rate(self) -> float:
        if self.total_trades == 0:
            return 0.0
        return self.wins / self.total_trades

    def record_real_outcome(self, window_slug: str, side_filled: Optional[Side],
                             size: int, outcome: Outcome, now: float):
        """Settle a real (capital-at-risk) trade. A WIN sends this rung into
        SHADOW mode for the next window; a LOSS or NO_FILL leaves it ACTIVE."""
        cost = size * self.price if side_filled else 0.0
        if outcome == Outcome.WIN:
            payout = size * 1.0
            pnl = payout - cost
            self.capital_balance += pnl
            self.total_pnl += pnl
            self.wins += 1
            self.win_streak += 1
            self.mode = RungMode.SHADOW
        elif outcome == Outcome.LOSS:
            pnl = -cost
            self.capital_balance += pnl
            self.total_pnl += pnl
            self.losses += 1
            self.win_streak = 0
            # mode stays ACTIVE
        else:  # NO_FILL
            pnl = 0.0
            self.no_fills += 1
            # mode stays ACTIVE

        rec = TradeRecord(
            id=next(_trade_id_counter),
            window_slug=window_slug,
            rung_price=self.price,
            outcome=outcome,
            side_filled=side_filled.value if side_filled else None,
            size=size,
            cost=cost,
            pnl=pnl,
            balance_after=self.capital_balance,
            settled_at=now,
        )
        self.history.append(rec)
        if len(self.history) > config.MAX_HISTORY:
            self.history.pop(0)
        return rec

    def record_shadow_outcome(self, window_slug: str, side_filled: Optional[Side],
                               size: int, outcome: Outcome, now: float):
        """Settle a SHADOW (observation-only) window. No capital moves.
        LOSS -> resume ACTIVE next window. WIN -> stay SHADOW, skip again.
        NO_FILL -> neutral, stay SHADOW, keep waiting for a resolved outcome."""
        if outcome == Outcome.WIN:
            self.shadow_wins += 1
            self.mode = RungMode.SHADOW   # keep skipping
        elif outcome == Outcome.LOSS:
            self.shadow_losses += 1
            self.mode = RungMode.ACTIVE   # resume for real next window
        else:  # NO_FILL — neutral, don't resolve the shadow streak either way
            self.shadow_no_fills += 1
            # mode stays SHADOW

        entry = {
            "window_slug": window_slug,
            "outcome": outcome.value,
            "side_filled": side_filled.value if side_filled else None,
            "size": size,
            "settled_at": now,
            "resulting_mode": self.mode.value,
        }
        self.shadow_log.append(entry)
        if len(self.shadow_log) > config.MAX_HISTORY:
            self.shadow_log.pop(0)
        return entry

    def to_dict(self):
        return {
            "price": self.price,
            "mode": self.mode.value,
            "size": config.RUNG_SIZE,
            "capital_start": self.capital_start,
            "capital_balance": round(self.capital_balance, 2),
            "wins": self.wins,
            "losses": self.losses,
            "no_fills": self.no_fills,
            "win_streak": self.win_streak,
            "total_trades": self.total_trades,
            "win_rate": round(self.win_rate * 100, 1),
            "total_pnl": round(self.total_pnl, 2),
            "shadow_wins": self.shadow_wins,
            "shadow_losses": self.shadow_losses,
            "shadow_no_fills": self.shadow_no_fills,
        }


@dataclass
class RungOrders:
    up: SimOrder
    down: SimOrder
    filled_side: Optional[Side] = None
    settled: bool = False
    cutoff_applied: bool = False
    is_shadow: bool = False   # snapshot of the rung's mode at the moment this window's orders were placed


@dataclass
class WindowState:
    slug: str
    start_ts: float
    end_ts: float
    up_token_id: str
    down_token_id: str
    rungs: dict = field(default_factory=dict)   # price -> RungOrders
    last_up_price: Optional[float] = None
    last_down_price: Optional[float] = None
    winner: Optional[Side] = None
    settled: bool = False
    settle_ready_at: float = 0.0
    orders_placed: bool = False

    def to_dict(self):
        rungs_out = {}
        for price, ro in self.rungs.items():
            position = None
            if ro.filled_side is not None:
                order = ro.up if ro.filled_side == Side.UP else ro.down
                mark = self.last_up_price if ro.filled_side == Side.UP else self.last_down_price
                entry = order.fill_price
                size = order.size
                unrealized = None
                mark_value = None
                if mark is not None and entry is not None:
                    unrealized = round(size * (mark - entry), 4)
                    mark_value = round(size * mark, 2)
                position = {
                    "side": ro.filled_side.value,
                    "size": size,
                    "entry_price": entry,
                    "mark_price": mark,
                    "cost_basis": round(size * entry, 2) if entry is not None else None,
                    "mark_value": mark_value,
                    "unrealized_pnl": unrealized,
                    "settled": ro.settled,
                    "is_shadow": ro.is_shadow,
                }
            rungs_out[str(price)] = {
                "up": ro.up.to_dict(),
                "down": ro.down.to_dict(),
                "filled_side": ro.filled_side.value if ro.filled_side else None,
                "settled": ro.settled,
                "position": position,
                "is_shadow": ro.is_shadow,
            }
        return {
            "slug": self.slug,
            "start_ts": self.start_ts,
            "end_ts": self.end_ts,
            "last_up_price": self.last_up_price,
            "last_down_price": self.last_down_price,
            "winner": self.winner.value if self.winner else None,
            "settled": self.settled,
            "rungs": rungs_out,
        }
