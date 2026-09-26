"""Small shared data structures used by the strategy and dashboard."""
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class Side(str, Enum):
    UP = "UP"
    DOWN = "DOWN"


@dataclass
class WindowMarket:
    slug: str
    condition_id: Optional[str]
    token_up: Optional[str]
    token_down: Optional[str]
    open_ts: float
    close_ts: float


@dataclass
class Position:
    side: Side
    token_id: str
    entry_price: float
    shares: float
    cost: float
    entry_ts: float
