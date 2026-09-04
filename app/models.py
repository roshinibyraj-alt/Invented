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


class EngineBPhase(str, Enum):
    WAITING_ENTRY = "waiting_entry"          # before the 45s entry wait elapses
    ENTERED_WAITING = "entered_waiting"      # position taken, in the post-entry 45s wait
    WATCHING_DOUBLE = "watching_double"      # watching the other side for the 0.70-0.72 band
    DOUBLED = "doubled"                      # doubling has fired, holding to exit/resolution
    TP_EXIT = "tp_exit"                      # sold on the low-tier take-profit
    STOPPED_OUT = "stopped_out"              # sold on stop loss
    NO_ENTRY = "no_entry"                    # both sides were >=0.70 at the 45s mark -- skipped
    RESOLVED = "resolved"                    # window closed and settled
    FLAT = "flat"                            # no market yet / between windows


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

    def add(self, extra_shares: float, extra_price: float):
        """Blend additional shares into this position, updating the
        weighted-average entry price (used by the doubling mechanic)."""
        total_cost = self.cost + (extra_shares * extra_price)
        self.shares += extra_shares
        self.entry_price = total_cost / self.shares


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
