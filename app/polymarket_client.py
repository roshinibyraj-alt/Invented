"""
Thin client around Polymarket's public read APIs.

Two APIs are involved:
  - Gamma API (metadata): market question, slug, close time, and the two
    CLOB token ids (one per outcome: Up / Down).
  - CLOB API (live pricing): current price per token id.

NOTE: Polymarket's public API surface has shifted field names between
versions in the past. This module is the single place to patch if a
response shape doesn't match what's below -- everything else in the app
only talks to WindowMarket / get_price(), not to raw HTTP responses.
Verify once against a live window after your first deploy; if a field
name is off, `_extract_token_ids` / `_parse_market_json` are the two
functions to fix.
"""
import json
import math
import time
from typing import Optional

import httpx

from . import config
from .models import WindowMarket


class PolymarketClient:
    def __init__(self):
        self._client = httpx.AsyncClient(timeout=8.0)

    async def close(self):
        await self._client.aclose()

    # ---- market discovery -------------------------------------------------

    def _slug_for_close_ts(self, close_ts: int) -> str:
        return f"{config.SLUG_PREFIX}{close_ts}"

    def current_window_close_ts(self, now: Optional[float] = None) -> int:
        now = now or time.time()
        return int(math.ceil(now / config.WINDOW_SECONDS) * config.WINDOW_SECONDS)

    async def fetch_market_by_slug(self, slug: str) -> Optional[dict]:
        url = f"{config.GAMMA_API_BASE}/markets"
        try:
            resp = await self._client.get(url, params={"slug": slug})
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            return None
        if isinstance(data, list) and data:
            return data[0]
        if isinstance(data, dict) and data.get("markets"):
            markets = data["markets"]
            return markets[0] if markets else None
        return None

    def _extract_token_ids(self, market_json: dict):
        """Gamma returns clobTokenIds as a JSON-encoded string list, in the
        same order as `outcomes` (e.g. ["Up", "Down"])."""
        raw_tokens = market_json.get("clobTokenIds")
        outcomes = market_json.get("outcomes")
        if isinstance(raw_tokens, str):
            try:
                raw_tokens = json.loads(raw_tokens)
            except Exception:
                raw_tokens = None
        if isinstance(outcomes, str):
            try:
                outcomes = json.loads(outcomes)
            except Exception:
                outcomes = None
        if not raw_tokens or not outcomes or len(raw_tokens) < 2:
            return None, None
        pairs = dict(zip([o.lower() for o in outcomes], raw_tokens))
        token_up = pairs.get("up") or pairs.get("yes")
        token_down = pairs.get("down") or pairs.get("no")
        # fallback: assume first outcome is Up if labels didn't match
        if token_up is None or token_down is None:
            token_up, token_down = raw_tokens[0], raw_tokens[1]
        return token_up, token_down

    async def get_active_window(self, now: Optional[float] = None) -> Optional[WindowMarket]:
        """Resolve the market for the window covering `now`, trying the
        current close-ts and one window ahead if the current one isn't
        listed yet."""
        now = now or time.time()
        close_ts = self.current_window_close_ts(now)
        for candidate_close in (close_ts, close_ts + config.WINDOW_SECONDS):
            slug = self._slug_for_close_ts(candidate_close)
            market_json = await self.fetch_market_by_slug(slug)
            if not market_json:
                continue
            token_up, token_down = self._extract_token_ids(market_json)
            return WindowMarket(
                slug=slug,
                condition_id=market_json.get("conditionId"),
                token_up=token_up,
                token_down=token_down,
                open_ts=candidate_close - config.WINDOW_SECONDS,
                close_ts=candidate_close,
            )
        return None

    # ---- live pricing -------------------------------------------------------

    async def get_price(self, token_id: str) -> Optional[float]:
        """Best-effort current price for a token, 0..1.
        Tries the midpoint endpoint first, falls back to last-trade price."""
        if not token_id:
            return None
        try:
            resp = await self._client.get(
                f"{config.CLOB_API_BASE}/midpoint", params={"token_id": token_id}
            )
            if resp.status_code == 200:
                data = resp.json()
                mid = data.get("mid") if isinstance(data, dict) else None
                if mid is not None:
                    return float(mid)
        except Exception:
            pass
        try:
            resp = await self._client.get(
                f"{config.CLOB_API_BASE}/last-trade-price",
                params={"token_id": token_id},
            )
            if resp.status_code == 200:
                data = resp.json()
                price = data.get("price") if isinstance(data, dict) else None
                if price is not None:
                    return float(price)
        except Exception:
            pass
        return None
