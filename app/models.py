"""Shared market, price, and simulated trade-log models."""
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class Side(str, Enum):
    UP = "UP"
    DOWN = "DOWN"


@dataclass
class PricePoint:
    ts: float
    up: Optional[float]
    down: Optional[float]


@dataclass
class TradeLogEntry:
    ts: float
    engine: str
    window_slug: str
    event: str
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