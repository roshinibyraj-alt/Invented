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


@dataclass
class EngineSpec:
    """Static definition of one of the nine engines."""
    engine_id: int
    kind: str               # "LIMIT" (resting buy both sides) or "TAKER" (aggressive on trigger)
    entry_price: float      # limit price for LIMIT engines / trigger price for TAKER engines
    sl_price: Optional[float] = None   # TAKER engines only
    skip_windows: int = 0   # LIMIT engines only: windows to skip after a win
    base_shares: float = 100.0
    starting_capital: float = 500.0


@dataclass
class PricePoint:
    ts: float
    up: Optional[float]
    down: Optional[float]


@dataclass
class TradeLogEntry:
    ts: float
    engine: str          # "E1".."E9" or "SYS"
    window_slug: str
    event: str            # human readable event name
    side: Optional[str] = None
    price: Optional[float] = None
    shares: Optional[float] = None
    fee: Optional[float] = None
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
