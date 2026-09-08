"""
Market discovery via Polymarket's public Gamma API.

Polymarket's short-dated crypto up/down markets are published as Events
with a deterministic slug: "{asset}-updown-{window_label}-{window_start_unix}",
e.g. "btc-updown-5m-1788494400", where the window start is the Unix
epoch second floored to the window's own duration boundary (UTC). Each
event contains exactly one Market with two outcomes, "Up" and "Down".

Gamma quirk (confirmed against real responses): /markets?slug=... returns
an empty list for these short-dated markets; you must use /events?slug=...
and read the nested markets[0] object instead.
"""
import json
import logging
import time
from dataclasses import dataclass
from typing import Optional

import httpx

from . import config

_default_log = logging.getLogger("gamma")


def current_window_start(window_seconds: int, now: Optional[float] = None) -> int:
    now = now if now is not None else time.time()
    return int(now - (now % window_seconds))


def slug_for(asset: str, window_start: int, window_label: str) -> str:
    return f"{asset}-updown-{window_label}-{window_start}"


@dataclass
class OutcomeToken:
    outcome: str       # "Up" or "Down"
    token_id: str
    outcome_index: int


@dataclass
class MarketWindow:
    asset: str
    window_start: int
    window_end: int
    slug: str
    condition_id: str
    tokens: dict          # outcome name -> OutcomeToken
    tick_size: float
    min_order_size: float
    taker_fee_rate: float
    fee_takes_only_taker: bool
    closed: bool = False
    outcome_prices: Optional[list] = None

    def token(self, outcome: str) -> OutcomeToken:
        return self.tokens[outcome]


class GammaClient:
    def __init__(self, log: Optional[logging.Logger] = None):
        self._client = httpx.AsyncClient(base_url=config.GAMMA_BASE, timeout=10.0)
        self.log = log or _default_log

    async def close(self):
        await self._client.aclose()

    async def fetch_event_by_slug(self, slug: str) -> Optional[dict]:
        resp = await self._client.get("/events", params={"slug": slug})
        resp.raise_for_status()
        data = resp.json()
        if not data:
            return None
        for ev in data:
            if ev.get("slug") == slug:
                return ev
        return data[0] if data else None

    async def get_window(self, asset: str, window_start: int, window_seconds: int,
                          window_label: str) -> Optional[MarketWindow]:
        slug = slug_for(asset, window_start, window_label)
        event = await self.fetch_event_by_slug(slug)
        if not event:
            self.log.warning("gamma: no event found for slug=%s (market may not be listed yet)", slug)
            return None

        markets = event.get("markets") or []
        if not markets:
            self.log.warning("gamma: event %s has no nested markets", slug)
            return None
        market = markets[0]

        condition_id = market.get("conditionId")
        outcomes = market.get("outcomes")
        clob_token_ids = market.get("clobTokenIds")
        if isinstance(outcomes, str):
            outcomes = json.loads(outcomes)
        if isinstance(clob_token_ids, str):
            clob_token_ids = json.loads(clob_token_ids)

        outcome_prices = market.get("outcomePrices")
        if isinstance(outcome_prices, str):
            try:
                outcome_prices = json.loads(outcome_prices)
            except Exception:
                outcome_prices = None

        tokens = {}
        for idx, (name, tok_id) in enumerate(zip(outcomes, clob_token_ids)):
            tokens[name] = OutcomeToken(outcome=name, token_id=tok_id, outcome_index=idx)

        fee_schedule = market.get("feeSchedule") or {}
        taker_fee_rate = float(fee_schedule.get("rate", config.FALLBACK_TAKER_FEE_RATE))
        taker_only = bool(fee_schedule.get("takerOnly", True))

        return MarketWindow(
            asset=asset,
            window_start=window_start,
            window_end=window_start + window_seconds,
            slug=slug,
            condition_id=condition_id,
            tokens=tokens,
            tick_size=float(market.get("tickSize") or market.get("minimum_tick_size") or 0.01),
            min_order_size=float(market.get("minOrderSize") or market.get("minimum_order_size") or 5),
            taker_fee_rate=taker_fee_rate,
            fee_takes_only_taker=taker_only,
            closed=bool(market.get("closed", False)),
            outcome_prices=outcome_prices,
        )
