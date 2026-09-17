"""Trade-log + fee calculator shared by the engine. No real funds move;
this is the safety layer before wiring up py-clob-client.

This does NOT track a balance of its own -- the engine is the single
source of truth for the demo-capital balance (see Engine.s.balance /
config.STARTING_CAPITAL). Keeping only one balance in the app is
deliberate: an earlier version of this bot had the broker track its own
balance in parallel, but nothing ever fed trades into it, so it just sat
frozen at its starting value and never matched what the dashboard should
show.
"""
import time
from typing import Optional, List

from . import config
from .models import TradeLogEntry


class PaperBroker:
    def __init__(self):
        self.log: List[TradeLogEntry] = []

    def _push_log(self, entry: TradeLogEntry):
        self.log.append(entry)
        if len(self.log) > config.LOG_MAX_ENTRIES:
            self.log.pop(0)

    def taker_fee_amount(self, shares: float, price: float) -> float:
        """The taker fee that would apply to a market-order fill of this
        size/price. Used to compute the maker rebate on entry/TP fills
        (which are resting limit orders and don't pay it themselves)."""
        return self._taker_fee(shares, price)

    def _taker_fee(self, shares: float, price: float) -> float:
        if not config.APPLY_TAKER_FEES:
            return 0.0
        # fee = shares * price * feeRate * (price * (1 - price)) ** exponent
        return shares * price * config.TAKER_FEE_RATE * (price * (1 - price)) ** config.TAKER_FEE_EXPONENT

    def log_event(self, engine: str, window_slug: str, event: str, note: str = "",
                   side: Optional[str] = None, price: Optional[float] = None,
                   shares: Optional[float] = None, fee: Optional[float] = None,
                   pnl: Optional[float] = None, balance_after: Optional[float] = None):
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event=event, side=side, price=price, shares=shares, fee=fee, pnl=pnl,
            balance_after=balance_after,
            note=note,
        ))
