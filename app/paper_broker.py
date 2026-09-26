"""Paper trade event log and simulated fee calculator; sends no orders."""
import time
from typing import List, Optional

from . import config
from .models import TradeLogEntry


class PaperBroker:
    def __init__(self):
        self.log: List[TradeLogEntry] = []
        self.on_event = None

    def _push_log(self, entry: TradeLogEntry):
        self.log.append(entry)
        if len(self.log) > config.LOG_MAX_ENTRIES:
            self.log.pop(0)
        if self.on_event is not None:
            self.on_event(entry)

    def taker_fee_amount(self, shares: float, price: float) -> float:
        if not config.APPLY_TAKER_FEES:
            return 0.0
        return (
            shares
            * price
            * config.TAKER_FEE_RATE
            * (price * (1 - price)) ** config.TAKER_FEE_EXPONENT
        )

    def log_event(
        self,
        engine: str,
        window_slug: str,
        event: str,
        note: str = "",
        side: Optional[str] = None,
        price: Optional[float] = None,
        shares: Optional[float] = None,
        fee: Optional[float] = None,
        pnl: Optional[float] = None,
        balance_after: Optional[float] = None,
    ):
        self._push_log(TradeLogEntry(
            ts=time.time(),
            engine=engine,
            window_slug=window_slug,
            event=event,
            side=side,
            price=price,
            shares=shares,
            fee=fee,
            pnl=pnl,
            balance_after=balance_after,
            note=note,
        ))