"""Shared dataclasses / enums."""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import time


class Side(str, Enum):
    UP = "UP"
    DOWN = "DOWN"

    def other(self) -> "Side":
        return Side.DOWN if self == Side.UP else Side.UP


class EngineAPhase(str, Enum):
    WAITING_FILL = "waiting_fill"        # two resting limit orders live
    HOLDING = "holding"                  # one side filled, holding to expiry
    ARMED = "armed"                      # holding + touched 0.60+, guard active
    EXITED_GUARD = "exited_guard"        # sold early on 0.50 retrace
    RESOLVED = "resolved"                # window closed
    FLAT = "flat"                        # no market yet / between windows


class EngineBPhase(str, Enum):
    WATCHING = "watching"                # waiting for first 0.70 touch
    ONE_SIDE_SKIPPED = "one_side_skipped"  # first side hit 0.70, now watching the other
    IN_POSITION = "in_position"
    STOPPED_OUT = "stopped_out"
    RESOLVED = "resolved"
    FLAT = "flat"


@dataclass
class PricePoint:
    ts: float
    up: Optional[float]
    down: Optional[float]


@dataclass
class Position:
    side: Side
    shares: float
    entry_price: float
    opened_at: float = field(default_factory=time.time)

    @property
    def cost(self) -> float:
        return self.shares * self.entry_price


@dataclass
class TradeLogEntry:
    ts: float
    engine: str          # "A" or "B"
    window_slug: str
    event: str            # human readable event name
    side: Optional[str] = None
    price: Optional[float] = None
    shares: Optional[float] = None
    pnl: Optional[float] = None
    balance_after: Optional[float] = None
    note: Optional[str] = None


@dataclass
class WindowMarket:
    slug: str
    condition_id: Optional[str]
    token_up: Optional[str]
    token_down: Optional[str]
    open_ts: float
    close_ts: float
