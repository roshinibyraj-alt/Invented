"""
Simulates taker (marketable) orders against a *real* snapshot of
Polymarket's public order book, so paper P&L reflects real depth/slippage
instead of assuming an instant fill at the top-of-book price.

Entries are sized by DOLLAR notional (config.ENTRY_DOLLARS = $100 flat),
not a fixed share count, since each engine spends a flat $ amount per
window regardless of the entry price. Exits (TP/SL) sell the exact share
count held, walking the bid side.
"""
from dataclasses import dataclass, field
from typing import List, Tuple

from . import config


@dataclass
class FillResult:
    requested_notional: float       # for buys: dollars requested; for sells: shares requested
    filled_shares: float
    avg_price: float
    lots: List[Tuple[float, float]] = field(default_factory=list)  # (price, shares)
    fully_filled: bool = False

    @property
    def notional(self) -> float:
        return sum(p * s for p, s in self.lots)


def simulate_buy_dollars(asks: List[Tuple[float, float]], dollars_wanted: float) -> FillResult:
    """Walk asks (ascending price) spending up to dollars_wanted, capped at
    BUY_SLIPPAGE_CEILING. Returns however many shares that dollar amount
    actually bought (partial fill if the book is too thin under the cap)."""
    remaining_dollars = dollars_wanted
    lots = []
    for price, size in asks:
        if price > config.BUY_SLIPPAGE_CEILING:
            break
        if remaining_dollars <= 1e-9:
            break
        level_notional = price * size
        if level_notional <= remaining_dollars:
            # take the whole level
            lots.append((price, size))
            remaining_dollars -= level_notional
        else:
            # partial level -- take only what the remaining budget buys
            shares = remaining_dollars / price
            lots.append((price, shares))
            remaining_dollars = 0.0
            break

    filled_shares = sum(s for _, s in lots)
    spent = sum(p * s for p, s in lots)
    avg = (spent / filled_shares) if filled_shares > 0 else 0.0
    return FillResult(
        requested_notional=dollars_wanted,
        filled_shares=filled_shares,
        avg_price=avg,
        lots=lots,
        fully_filled=remaining_dollars <= 1e-9,
    )


def simulate_sell(bids: List[Tuple[float, float]], shares_wanted: float) -> FillResult:
    """Walk bids (descending price) down to SELL_SLIPPAGE_FLOOR."""
    remaining = shares_wanted
    lots = []
    for price, size in bids:
        if price < config.SELL_SLIPPAGE_FLOOR:
            break
        take = min(remaining, size)
        if take <= 0:
            continue
        lots.append((price, take))
        remaining -= take
        if remaining <= 1e-9:
            break
    filled = shares_wanted - remaining
    avg = (sum(p * s for p, s in lots) / filled) if filled > 0 else 0.0
    return FillResult(
        requested_notional=shares_wanted,
        filled_shares=filled,
        avg_price=avg,
        lots=lots,
        fully_filled=remaining <= 1e-9,
    )
