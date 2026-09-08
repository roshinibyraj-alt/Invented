"""
Thin wrapper around Polymarket's public (no-auth) CLOB REST endpoints.
We never sign or submit real orders -- this bot only reads live market
data and simulates fills against it.

/book (bids/asks) is used for live trading (entries, TP/SL exits, and the
dashboard's price display) -- NOT for resolution. Resolution's primary
signal is Polymarket's own official result (Gamma); if that hasn't
confirmed in time, the fallback is get_last_trade_price() (an actual
executed trade), never bid/ask/midpoint -- those can be unsafe right at
window close (liquidity can thin out or vanish on one side, e.g. the
WINNING token can show ask=0.000 simply because no resting sell order is
left; Polymarket's own docs confirm /midpoint is literally
(best_bid+best_ask)/2, so it inherits the same problem).
"""
import logging
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import httpx

from . import config

log = logging.getLogger("clobbook")


@dataclass
class OrderBook:
    token_id: str
    bids: List[Tuple[float, float]] = field(default_factory=list)  # (price, size) desc by price
    asks: List[Tuple[float, float]] = field(default_factory=list)  # (price, size) asc by price

    @property
    def best_bid(self):
        return self.bids[0][0] if self.bids else None

    @property
    def best_ask(self):
        return self.asks[0][0] if self.asks else None


class ClobClient:
    def __init__(self):
        self._client = httpx.AsyncClient(base_url=config.CLOB_BASE, timeout=8.0)

    async def close(self):
        await self._client.aclose()

    async def get_book(self, token_id: str) -> OrderBook:
        resp = await self._client.get("/book", params={"token_id": token_id})
        resp.raise_for_status()
        data = resp.json()

        def parse_levels(levels, reverse):
            out = []
            for lvl in levels or []:
                try:
                    out.append((float(lvl["price"]), float(lvl["size"])))
                except (KeyError, TypeError, ValueError):
                    continue
            out.sort(key=lambda x: x[0], reverse=reverse)
            return out

        bids = parse_levels(data.get("bids"), reverse=True)
        asks = parse_levels(data.get("asks"), reverse=False)
        return OrderBook(token_id=token_id, bids=bids, asks=asks)

    async def get_last_trade_price(self, token_id: str) -> Optional[float]:
        """GET /last-trade-price -- the price of the most recent actual
        executed trade for this token. Used ONLY as the resolution
        fallback (see strategy._try_resolve)."""
        try:
            resp = await self._client.get("/last-trade-price", params={"token_id": token_id})
            resp.raise_for_status()
            data = resp.json()
            price = data.get("price")
            return float(price) if price is not None else None
        except Exception as e:
            log.debug("get_last_trade_price failed for %s: %s", token_id, e)
            return None
