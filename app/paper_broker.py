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

    def buy(self, engine: str, window_slug: str, side: Side, shares: float,
            price: float, note: str = "") -> Position:
        cost = shares * price
        self.balance -= cost
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event="BUY", side=side.value, price=price, shares=shares,
            balance_after=self.balance, note=note,
        ))
        return Position(side=side, shares=shares, entry_price=price)

    def buy_add(self, engine: str, window_slug: str, position: Position,
                extra_shares: float, price: float, note: str = "") -> Position:
        """Add shares to an existing position (used by the doubling
        mechanic), blending the average entry price."""
        cost = extra_shares * price
        self.balance -= cost
        position.add(extra_shares, price)
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event="BUY_ADD", side=position.side.value, price=price,
            shares=extra_shares, balance_after=self.balance, note=note,
        ))
        return position

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
