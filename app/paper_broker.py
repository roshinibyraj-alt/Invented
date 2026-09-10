"""In-memory paper broker. Simulates order fills against observed prices.
No real funds move; this is the safety layer before wiring up py-clob-client.

Fees: modeled after Polymarket's published taker-fee formula --
  fee = shares * TAKER_FEE_RATE * price * (1 - price)
charged on every buy/sell (both are treated as taker fills here). Expiry
redemption is not a matched trade and is not fee'd.
"""
import time
from typing import Optional, List

from . import config
from .models import Position, Side, TradeLogEntry


def compute_taker_fee(shares: float, price: float) -> float:
    fee = shares * config.TAKER_FEE_RATE * price * (1 - price)
    fee = round(fee, 5)
    return fee if fee >= 0.00001 else 0.0


class PaperBroker:
    def __init__(self, starting_balance: float):
        self.balance = starting_balance
        self.starting_balance = starting_balance
        self.total_fees_paid = 0.0
        self.log: List[TradeLogEntry] = []

    def _push_log(self, entry: TradeLogEntry):
        self.log.append(entry)
        if len(self.log) > config.LOG_MAX_ENTRIES:
            self.log.pop(0)

    def buy(self, engine: str, window_slug: str, side: Side, shares: float,
            price: float, note: str = "") -> Position:
        fee = compute_taker_fee(shares, price)
        cost = shares * price
        self.balance -= (cost + fee)
        self.total_fees_paid += fee
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event="BUY", side=side.value, price=price, shares=shares,
            fee=fee, balance_after=self.balance, note=note,
        ))
        return Position(side=side, shares=shares, entry_price=price)

    def sell(self, engine: str, window_slug: str, position: Position,
              price: float, note: str = "") -> float:
        fee = compute_taker_fee(position.shares, price)
        proceeds = position.shares * price
        pnl = (proceeds - fee) - position.cost
        self.balance += (proceeds - fee)
        self.total_fees_paid += fee
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event="SELL", side=position.side.value, price=price,
            shares=position.shares, pnl=pnl, fee=fee,
            balance_after=self.balance, note=note,
        ))
        return pnl

    def resolve_expiry(self, engine: str, window_slug: str, position: Position,
                        won: bool, note: str = "") -> float:
        """Settle a held-to-expiry position: winning side pays $1/share,
        losing side pays $0. Redemption is not a matched CLOB trade, so
        no taker fee applies here."""
        payout_price = 1.0 if won else 0.0
        proceeds = position.shares * payout_price
        pnl = proceeds - position.cost
        self.balance += proceeds
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event="RESOLVE_WIN" if won else "RESOLVE_LOSS", side=position.side.value,
            price=payout_price, shares=position.shares, pnl=pnl,
            fee=0.0, balance_after=self.balance, note=note,
        ))
        return pnl

    def log_event(self, engine: str, window_slug: str, event: str, note: str = "",
                   side: Optional[str] = None, price: Optional[float] = None):
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug,
            event=event, side=side, price=price, balance_after=self.balance,
            note=note,
        ))
