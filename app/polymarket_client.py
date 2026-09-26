"""Read-only Gamma/CLOB market discovery and pricing client."""
import json
import math
import time
from typing import Optional

import httpx

from . import config
from .models import Side, WindowMarket


class PolymarketClient:
    def __init__(self):
        self._client = httpx.AsyncClient(timeout=8.0)

    async def close(self):
        await self._client.aclose()

    def current_window_open_ts(self, now: Optional[float] = None) -> int:
        now = time.time() if now is None else now
        return int(math.floor(now / config.WINDOW_SECONDS) * config.WINDOW_SECONDS)

    async def fetch_market_by_slug(self, slug: str) -> Optional[dict]:
        try:
            response = await self._client.get(
                f"{config.GAMMA_API_BASE}/events", params={"slug": slug}
            )
            response.raise_for_status()
            data = response.json()
        except Exception:
            return None

        if isinstance(data, list):
            event = data[0] if data else None
        elif isinstance(data, dict) and data.get("events"):
            event = data["events"][0]
        elif isinstance(data, dict):
            event = data
        else:
            event = None
        if not isinstance(event, dict):
            return None
        markets = event.get("markets")
        if isinstance(markets, list) and markets:
            return markets[0]
        return event if event.get("clobTokenIds") is not None else None

    @staticmethod
    def _token_ids(market: dict) -> tuple[Optional[str], Optional[str]]:
        raw_tokens = market.get("clobTokenIds")
        outcomes = market.get("outcomes")
        try:
            if isinstance(raw_tokens, str):
                raw_tokens = json.loads(raw_tokens)
            if isinstance(outcomes, str):
                outcomes = json.loads(outcomes)
        except Exception:
            return None, None
        if not isinstance(raw_tokens, list) or not isinstance(outcomes, list):
            return None, None
        pairs = {str(o).lower(): t for o, t in zip(outcomes, raw_tokens)}
        return (
            pairs.get("up") or pairs.get("yes") or (raw_tokens[0] if raw_tokens else None),
            pairs.get("down") or pairs.get("no") or (raw_tokens[1] if len(raw_tokens) > 1 else None),
        )

    async def get_active_window(self, now: Optional[float] = None) -> Optional[WindowMarket]:
        open_ts = self.current_window_open_ts(now)
        slug = f"{config.SLUG_PREFIX}{open_ts}"
        market = await self.fetch_market_by_slug(slug)
        if not market:
            return None
        token_up, token_down = self._token_ids(market)
        if not token_up or not token_down:
            return None
        return WindowMarket(
            slug=slug,
            condition_id=market.get("conditionId"),
            token_up=str(token_up),
            token_down=str(token_down),
            open_ts=open_ts,
            close_ts=open_ts + config.WINDOW_SECONDS,
        )

    async def get_book(self, token_id: str) -> tuple[Optional[float], Optional[float]]:
        try:
            response = await self._client.get(
                f"{config.CLOB_API_BASE}/book", params={"token_id": token_id}
            )
            response.raise_for_status()
            data = response.json()
        except Exception:
            return None, None
        if not isinstance(data, dict):
            return None, None

        def best(levels, maximum):
            values = []
            for level in levels or []:
                try:
                    values.append(float(level["price"]))
                except (KeyError, TypeError, ValueError):
                    pass
            return (max(values) if maximum else min(values)) if values else None

        return best(data.get("bids"), True), best(data.get("asks"), False)

    async def fetch_resolution(self, slug: str) -> Optional[Side]:
        market = await self.fetch_market_by_slug(slug)
        if not market or not market.get("closed"):
            return None
        try:
            prices = market.get("outcomePrices")
            outcomes = market.get("outcomes")
            if isinstance(prices, str):
                prices = json.loads(prices)
            if isinstance(outcomes, str):
                outcomes = json.loads(outcomes)
            pairs = {str(o).lower(): float(p) for o, p in zip(outcomes, prices)}
            if max(pairs.values()) < 0.99:
                return None
            up = pairs.get("up", pairs.get("yes"))
            down = pairs.get("down", pairs.get("no"))
            if up is None or down is None:
                return None
            return Side.UP if up > down else Side.DOWN
        except (TypeError, ValueError, KeyError, json.JSONDecodeError):
            return None
