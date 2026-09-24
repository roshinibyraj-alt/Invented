"""
Thin async client over Polymarket's public, no-auth-required endpoints:

  Gamma API  (https://gamma-api.polymarket.com) — event/market discovery
  CLOB API   (https://clob.polymarket.com)      — live prices

No API key, no wallet, no signing. Pure market-data reads, which is all
paper trading needs.
"""
from __future__ import annotations
import time
import logging
from typing import Optional
import httpx

from . import config

log = logging.getLogger("polymarket_client")


def window_start_for(ts: float) -> int:
    """Every BTC 5-minute up/down window starts on a clean 300s boundary."""
    return int(ts // config.WINDOW_SECONDS) * config.WINDOW_SECONDS


def slug_for_window(window_start: int) -> str:
    return f"{config.ASSET_SLUG_PREFIX}-{window_start}"


class PolymarketClient:
    def __init__(self):
        self._client = httpx.AsyncClient(timeout=config.GAMMA_FETCH_TIMEOUT)

    async def close(self):
        await self._client.aclose()

    async def get_event_by_slug(self, slug: str) -> Optional[dict]:
        """Returns the raw Gamma event dict, or None if not found (market
        may not be listed yet — normal in the seconds right before a
        window opens)."""
        try:
            resp = await self._client.get(
                f"{config.GAMMA_API}/events", params={"slug": slug}
            )
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, list) and data:
                return data[0]
            return None
        except Exception as e:
            log.warning("gamma fetch failed for %s: %s", slug, e)
            return None

    async def get_up_down_token_ids(self, slug: str) -> Optional[tuple[str, str]]:
        """Returns (up_token_id, down_token_id) for a btc-updown-5m event."""
        event = await self.get_event_by_slug(slug)
        if not event:
            return None
        markets = event.get("markets") or []
        if not markets:
            return None
        market = markets[0]
        raw_tokens = market.get("clobTokenIds")
        if not raw_tokens:
            return None
        import json
        tokens = raw_tokens if isinstance(raw_tokens, list) else json.loads(raw_tokens)
        if len(tokens) < 2:
            return None

        # outcomes tells us which token index is "Up" vs "Down"
        outcomes_raw = market.get("outcomes")
        outcomes = outcomes_raw if isinstance(outcomes_raw, list) else (
            json.loads(outcomes_raw) if outcomes_raw else ["Up", "Down"]
        )
        up_idx, down_idx = 0, 1
        for i, o in enumerate(outcomes):
            lo = str(o).strip().lower()
            if lo in ("up", "yes"):
                up_idx = i
            elif lo in ("down", "no"):
                down_idx = i
        return tokens[up_idx], tokens[down_idx]

    async def get_price(self, token_id: str, side: str = "buy") -> Optional[float]:
        """Best price to `side` (buy/sell) this token right now."""
        try:
            resp = await self._client.get(
                f"{config.CLOB_API}/price",
                params={"token_id": token_id, "side": side},
                timeout=config.PRICE_FETCH_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            price = data.get("price")
            return float(price) if price is not None else None
        except Exception as e:
            log.debug("price fetch failed for token %s: %s", token_id, e)
            return None
