"""In-memory paper broker. Simulates order fills against observed prices.
No real funds move; this is the safety layer before wiring up py-clob-client.
"""
import time
from typing import Optional, List

from . import config
from .models import Position, Side, TradeLogEntry


class PaperBroker:
    def __init__(self, starting_balance: float):
        self.balance = starting_balance
        self.starting_balance = starting_balance
        self.log: List[TradeLogEntry] = []

    def _push_log(self, entry: TradeLogEntry):
        self.log.append(entry)
        if len(self.log) > config.LOG_MAX_ENTRIES:
            self.log.pop(0)

    def _taker_fee(self, shares: float, price: float) -> float:
        if not config.APPLY_TAKER_FEES:
            return 0.0
        # fee = shares * price * feeRate * (price * (1 - price)) ** exponent
        return shares * price * config.TAKER_FEE_RATE * (price * (1 - price)) ** config.TAKER_FEE_EXPONENT

    def buy(self, engine: str, window_slug: str, side: Side, shares: float,
            price: float, note: str = "") -> Position:
        notional = shares * price
        fee = self._taker_fee(shares, price)
        self.balance -= (notional + fee)
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event="BUY", side=side.value, price=price, shares=shares,
            fee=fee, balance_after=self.balance,
            note=f"{note} (fee ${fee:.4f})" if fee else note,
        ))
        return Position(side=side, shares=shares, entry_price=price, fee=fee)

    def sell(self, engine: str, window_slug: str, position: Position,
              price: float, note: str = "") -> float:
        proceeds = position.shares * price
        pnl = proceeds - position.cost
        self.balance += proceeds
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event="SELL", side=position.side.value, price=price,
            shares=position.shares, pnl=pnl, balance_after=self.balance,
            note=note,
        ))
        return pnl

    def resolve_expiry(self, engine: str, window_slug: str, position: Position,
                        won: bool, note: str = "") -> float:
        """Settle a held-to-expiry position: winning side pays $1/share,
        losing side pays $0."""
        payout_price = 1.0 if won else 0.0
        proceeds = position.shares * payout_price
        pnl = proceeds - position.cost
        self.balance += proceeds
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event="RESOLVE_WIN" if won else "RESOLVE_LOSS", side=position.side.value,
            price=payout_price, shares=position.shares, pnl=pnl,
            balance_after=self.balance, note=note,
        ))
        return pnl

    def log_event(self, engine: str, window_slug: str, event: str, note: str = "",
                   side: Optional[str] = None, price: Optional[float] = None):
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event=event, side=side, price=price, balance_after=self.balance,
            note=note,
        ))
