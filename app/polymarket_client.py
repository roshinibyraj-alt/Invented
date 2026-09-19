"""
Thin client around Polymarket's public read APIs.

Three APIs are involved:
  - Gamma API (metadata): market question, slug, close time, and the two
    CLOB token ids (one per outcome: Up / Down).
  - CLOB API (live pricing): midpoint/last-trade price per token id, and
    the real order book (best bid / best ask) via get_book().

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
    #
    # Polymarket's btc-updown-15m-<ts> slug keys off the window's OPEN time,
    # not its close time (confirmed against a live window). Using ceil()
    # here -- i.e. treating <ts> as a close time -- silently resolves to
    # the *next* window's open timestamp instead, which is exactly the bug
    # where the bot always shows the upcoming window instead of the live
    # one. We still probe a couple of alternate candidates defensively in
    # case Polymarket changes convention or a market is momentarily
    # missing from Gamma right at the boundary.
    #
    # IMPORTANT: for the short-window crypto series, Gamma's `/markets?slug=...`
    # returns an empty list -- these markets are only addressable by slug
    # through the `/events?slug=...` endpoint (each event wraps exactly one
    # market for this series, in event["markets"][0]). Confirmed against a
    # live event (5m series): `/markets?slug=btc-updown-5m-<ts>` -> [], while
    # `/events?slug=btc-updown-5m-<ts>` -> [{ ..., "markets": [{...}] }]. The
    # 15m series uses the same event slug pattern (btc-updown-15m-<open ts>).

    def _slug_for_ts(self, ts: int) -> str:
        return f"{config.SLUG_PREFIX}{ts}"

    def current_window_open_ts(self, now: Optional[float] = None) -> int:
        now = now or time.time()
        return int(math.floor(now / config.WINDOW_SECONDS) * config.WINDOW_SECONDS)

    async def fetch_market_by_slug(self, slug: str) -> "tuple[Optional[dict], Optional[str]]":
        """Returns (market_json, error_reason). error_reason is None on
        success, otherwise a short diagnostic string explaining exactly
        which step failed -- this is what should show up in the
        dashboard's error banner instead of a generic 'not found'."""
        url = f"{config.GAMMA_API_BASE}/events"
        try:
            resp = await self._client.get(url, params={"slug": slug})
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            return None, f"Gamma /events request failed for slug={slug}: {e}"

        event = None
        if isinstance(data, list) and data:
            event = data[0]
        elif isinstance(data, dict) and data.get("events"):
            events = data["events"]
            event = events[0] if events else None
        elif isinstance(data, dict) and data.get("slug"):
            # some Gamma responses return the event object directly (not a list)
            event = data

        if not isinstance(event, dict):
            return None, f"Gamma /events returned no event for slug={slug} (response shape: {type(data).__name__}, empty or unrecognized)"

        markets = event.get("markets")
        if isinstance(markets, list) and markets:
            return markets[0], None
        # extremely defensive fallback: if Gamma ever returns the market
        # fields flattened directly on the event (no nested "markets"),
        # treat the event itself as the market record.
        if event.get("clobTokenIds") is not None:
            return event, None
        return None, f"Gamma event found for slug={slug} but it has no 'markets' array and no clobTokenIds on the event itself -- response shape may have changed"

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

    async def get_active_window(self, now: Optional[float] = None) -> "tuple[Optional[WindowMarket], Optional[str]]":
        """Resolve the market for the window covering `now`.

        Primary candidate is the current window's open_ts (confirmed slug
        convention). If Gamma hasn't listed it yet (e.g. we're a beat
        early right at the boundary), we retry on the next tick rather
        than falling through to the *next* window's slug -- doing that
        was the original bug, so we deliberately don't guess forward here.

        Returns (WindowMarket, None) on full success. Returns (None,
        reason) if EITHER the market lookup fails OR the market was
        found but its CLOB token ids couldn't be extracted -- a window
        with unusable token ids is treated as a failure here, not a
        half-valid result, since silently returning token_up=None would
        make every subsequent price fetch fail forever with no visible
        error (this was a real bug: the dashboard showed 'live' with no
        error while prices stayed blank)."""
        now = now or time.time()
        open_ts = self.current_window_open_ts(now)
        slug = self._slug_for_ts(open_ts)
        market_json, reason = await self.fetch_market_by_slug(slug)
        if not market_json:
            return None, reason
        token_up, token_down = self._extract_token_ids(market_json)
        if not token_up or not token_down:
            return None, (
                f"Gamma market found for slug={slug} but token ids couldn't be extracted "
                f"(clobTokenIds={market_json.get('clobTokenIds')!r}, outcomes={market_json.get('outcomes')!r}) "
                f"-- check _extract_token_ids for a field-name mismatch"
            )
        return WindowMarket(
            slug=slug,
            condition_id=market_json.get("conditionId"),
            token_up=token_up,
            token_down=token_down,
            open_ts=open_ts,
            close_ts=open_ts + config.WINDOW_SECONDS,
        ), None

    # ---- resolution (real settlement, not a price guess) ---------------------
    #
    # NOT CALLED anywhere right now -- state.py settles every window off
    # the last observed CLOB price instead (see BotState._infer_winner),
    # per explicit request to keep outcomes deterministic and simple
    # rather than waiting on/confirming Polymarket's real resolution.
    # Left in place in case you want real-resolution settlement back;
    # wiring it in is a one-line change in state.py's _roll_window.

    async def fetch_resolution(self, slug: str):
        """Returns the real winning Side once Polymarket has settled this
        market, or None if it isn't resolved yet. Uses `closed` + a
        decisive outcomePrices split (winner priced >=0.99) rather than
        just reading the live CLOB price, since the live price can be
        noisy/stale right at the boundary."""
        from .models import Side  # local import avoids a circular import
        market_json, _reason = await self.fetch_market_by_slug(slug)
        if not market_json:
            return None
        if not market_json.get("closed"):
            return None
        outcome_prices = market_json.get("outcomePrices")
        outcomes = market_json.get("outcomes")
        if isinstance(outcome_prices, str):
            try:
                outcome_prices = json.loads(outcome_prices)
            except Exception:
                return None
        if isinstance(outcomes, str):
            try:
                outcomes = json.loads(outcomes)
            except Exception:
                return None
        if not outcome_prices or not outcomes or len(outcome_prices) < 2:
            return None
        try:
            prices = [float(p) for p in outcome_prices]
        except Exception:
            return None
        if max(prices) < 0.99:
            return None  # closed but not yet decisively settled -- wait
        pairs = dict(zip([o.lower() for o in outcomes], prices))
        up_p = pairs.get("up") or pairs.get("yes")
        down_p = pairs.get("down") or pairs.get("no")
        if up_p is None or down_p is None:
            return None
        return Side.UP if up_p > down_p else Side.DOWN

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

    async def get_book(self, token_id: str) -> "tuple[Optional[float], Optional[float]]":
        """Best bid and best ask for a token -- thin wrapper around
        get_book_full() kept for any caller that only wants the top of
        book. Either can be None if that side of the book is empty or
        the request fails."""
        full = await self.get_book_full(token_id)
        if full is None:
            return None, None
        return full["best_bid"], full["best_ask"]

    async def get_book_full(self, token_id: str) -> "Optional[dict]":
        """Full order book for a token, not just the top price -- this is
        what lets a caller price a real fill by walking through available
        size instead of assuming unlimited depth at the best quote (which
        badly overstates achievable fill quality once a side goes
        illiquid, e.g. late in a window once one side is clearly losing).

        Returns None if the request fails outright (unknown book state --
        caller should treat this tick as "no data" and fall back to
        whatever it had). Returns {"best_bid", "best_ask", "bids", "asks"}
        on success, where "bids"/"asks" are lists of (price, size) tuples,
        best price first, size in shares -- an empty list is a real
        signal that the book has NO resting orders on that side right
        now (as opposed to None, which means the fetch itself failed).

        Convention: ask is always >= bid (ask = lowest price a seller
        will accept, bid = highest price a buyer will pay). The /book
        response's bids/asks arrays aren't guaranteed sorted here, so we
        sort bids descending (best/highest first) and asks ascending
        (best/lowest first)."""
        if not token_id:
            return None
        try:
            resp = await self._client.get(
                f"{config.CLOB_API_BASE}/book", params={"token_id": token_id}
            )
            if resp.status_code != 200:
                return None
            data = resp.json()
        except Exception:
            return None
        if not isinstance(data, dict):
            return None

        def parse_levels(levels):
            out = []
            for lvl in levels or []:
                try:
                    price = float(lvl.get("price"))
                except Exception:
                    continue
                try:
                    size = float(lvl.get("size"))
                except Exception:
                    size = 0.0
                out.append((price, size))
            return out

        bids = parse_levels(data.get("bids"))
        asks = parse_levels(data.get("asks"))
        # If the API didn't actually give us usable size data on any
        # level, we can't walk the book for a realistic fill -- treat
        # depth as unknown (None) rather than pretending every level is
        # zero-size, which would make nothing ever fillable.
        bids_have_size = any(size > 0 for _, size in bids)
        asks_have_size = any(size > 0 for _, size in asks)

        bids.sort(key=lambda ps: -ps[0])
        asks.sort(key=lambda ps: ps[0])
        best_bid = bids[0][0] if bids else None
        best_ask = asks[0][0] if asks else None

        return {
            "best_bid": best_bid, "best_ask": best_ask,
            "bids": bids if bids_have_size else (None if bids else []),
            "asks": asks if asks_have_size else (None if asks else []),
        }
