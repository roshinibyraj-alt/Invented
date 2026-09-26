"""
Kronos-driven side selection.

Replaces the previous strict UP/DOWN/UP/DOWN alternation: on every new
5-minute window we ask Kronos -- Tsinghua's open-source K-line foundation
model (https://github.com/shiyu-coder/Kronos), a decoder-only transformer
pretrained on 12B+ real OHLCV candles across 45+ exchanges -- to forecast
the next few 1-minute BTC candles, and only take a side if that forecast
is directionally confident. If it isn't, the window is skipped entirely
(same "no trade this window" behavior the old price filter already had).

Two moving pieces:

  - CandleFeed: a rolling buffer of real 1m BTC/USD(T) OHLCV candles.
    Binance's public klines endpoint (no auth) is tried first; some hosts
    (Railway, AWS, GCP, etc.) get 403/451'd by Binance, so on failure it
    falls back through Coinbase Exchange, Kraken, then Bybit's public
    endpoints (see CANDLE_SOURCES below) until one responds. A source that
    just failed is skipped for SOURCE_BACKOFF_SECONDS rather than retried
    every tick. Kronos needs genuine market history to condition its
    forecast on -- Polymarket's own token prices are a binary contract
    *on* this same BTC price, not the underlying series, so they're the
    wrong thing to feed the model. Kept on its own refresh cycle,
    independent of the Polymarket poll loop, so a Polymarket hiccup
    doesn't starve the model of data.

  - KronosSignal: lazily loads the tokenizer + model once (first call),
    then serves cached (side, confidence) results, re-running inference
    at most every KRONOS_REFRESH_SECONDS rather than on every 1s tick --
    a transformer forward pass is far too slow to run every poll.

Install (not on PyPI, and not vendored here):
    pip install torch huggingface_hub pandas numpy
    # then pull the Kronos package itself from its repo -- see the
    # project's README for the current recommended install step -- and
    # make sure `from model import Kronos, KronosTokenizer, KronosPredictor`
    # resolves (e.g. drop the repo's `model/` package next to this file,
    # or `pip install -e` a checkout of it).

This module is defensive by design: any import, load, or inference
failure is caught and logged, and get_signal() just returns (None, 0.0)
so the engine treats it exactly like "no confident call this window" --
it never raises into the trading loop.
"""
import logging
import math
import time
from collections import deque
from typing import List, Optional

import httpx

from . import config
from .models import Side

log = logging.getLogger("kronos_signal")


# ---------------------------------------------------------------------------
# Candle sources -- Binance is tried first, but some hosts (Railway, AWS,
# GCP, etc.) get 403/451'd by Binance's public API, so we fall back through
# a couple of other exchanges' public, no-auth REST endpoints. Every source
# normalizes to the same list-of-dicts shape, oldest bar first:
#   {"timestamps": <unix seconds>, "open", "high", "low", "close", "volume"}
# ---------------------------------------------------------------------------

class CandleSource:
    name = "base"

    async def fetch(self, client: httpx.AsyncClient, limit: int) -> List[dict]:
        raise NotImplementedError


class BinanceSource(CandleSource):
    name = "binance"

    async def fetch(self, client, limit):
        resp = await client.get(
            "https://api.binance.com/api/v3/klines",
            params={"symbol": "BTCUSDT", "interval": "1m", "limit": limit},
        )
        resp.raise_for_status()
        return [
            {
                "timestamps": int(r[0]) // 1000,
                "open": float(r[1]), "high": float(r[2]),
                "low": float(r[3]), "close": float(r[4]),
                "volume": float(r[5]),
            }
            for r in resp.json()
        ]


class CoinbaseSource(CandleSource):
    """Coinbase Exchange's public candles endpoint. Caps out around 300
    bars per call and ignores `limit` beyond that -- fine, refresh() tops
    the buffer up over time anyway."""
    name = "coinbase"

    async def fetch(self, client, limit):
        resp = await client.get(
            "https://api.exchange.coinbase.com/products/BTC-USD/candles",
            params={"granularity": 60},
        )
        resp.raise_for_status()
        rows = resp.json()[:limit]  # newest first: [time, low, high, open, close, volume]
        out = [
            {
                "timestamps": int(r[0]),
                "low": float(r[1]), "high": float(r[2]),
                "open": float(r[3]), "close": float(r[4]),
                "volume": float(r[5]),
            }
            for r in rows
        ]
        out.sort(key=lambda c: c["timestamps"])
        return out


class KrakenSource(CandleSource):
    name = "kraken"

    async def fetch(self, client, limit):
        resp = await client.get(
            "https://api.kraken.com/0/public/OHLC",
            params={"pair": "XBTUSD", "interval": 1},
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("error"):
            raise RuntimeError(f"Kraken error: {data['error']}")
        result = data.get("result", {})
        pair_key = next((k for k in result if k != "last"), None)
        if pair_key is None:
            raise RuntimeError("Kraken response missing OHLC series")
        rows = result[pair_key][-limit:]
        return [
            {
                "timestamps": int(r[0]),
                "open": float(r[1]), "high": float(r[2]),
                "low": float(r[3]), "close": float(r[4]),
                "volume": float(r[6]),
            }
            for r in rows
        ]


class BybitSource(CandleSource):
    name = "bybit"

    async def fetch(self, client, limit):
        resp = await client.get(
            "https://api.bybit.com/v5/market/kline",
            params={"category": "spot", "symbol": "BTCUSDT", "interval": "1", "limit": limit},
        )
        resp.raise_for_status()
        rows = resp.json().get("result", {}).get("list", [])  # newest first
        out = [
            {
                "timestamps": int(r[0]) // 1000,
                "open": float(r[1]), "high": float(r[2]),
                "low": float(r[3]), "close": float(r[4]),
                "volume": float(r[5]),
            }
            for r in rows
        ]
        out.sort(key=lambda c: c["timestamps"])
        return out


CANDLE_SOURCES: List[CandleSource] = [BinanceSource(), CoinbaseSource(), KrakenSource(), BybitSource()]
SOURCE_BACKOFF_SECONDS = config.HTTP_RECONNECT_BACKOFF_SECONDS


class CandleFeed:
    """Rolling buffer of 1m BTC/USD(T) OHLCV candles, sourced from
    whichever exchange in CANDLE_SOURCES currently responds."""

    def __init__(self, maxlen: int = None):
        self._client = httpx.AsyncClient(timeout=config.HTTP_TIMEOUT_SECONDS)
        self.candles: "deque[dict]" = deque(maxlen=maxlen or config.KRONOS_CONTEXT_BARS)
        self.active_source: Optional[str] = None
        self._source_failed_until: dict = {}  # source name -> ts before which we skip it
        self.reconnects = 0

    async def close(self):
        await self._client.aclose()

    async def _reconnect(self):
        old_client = self._client
        self._client = httpx.AsyncClient(timeout=config.HTTP_TIMEOUT_SECONDS)
        self.reconnects += 1
        try:
            await old_client.aclose()
        except Exception:
            pass

    async def _fetch_from_any_source(self, limit: int) -> Optional[List[dict]]:
        now = time.time()
        # Try the currently-working source first so we're not re-probing
        # every exchange on every single tick once one is healthy.
        ordered = sorted(CANDLE_SOURCES, key=lambda s: s.name != self.active_source)
        for source in ordered:
            if now < self._source_failed_until.get(source.name, 0):
                continue
            try:
                rows = await source.fetch(self._client, limit)
                if not rows:
                    raise RuntimeError("empty response")
                if source.name != self.active_source:
                    log.info("Kronos candle feed using %s%s", source.name,
                             " (switched from " + self.active_source + ")" if self.active_source else "")
                    self.active_source = source.name
                self._source_failed_until.pop(source.name, None)
                return rows
            except httpx.RequestError as e:
                await self._reconnect()
                log.warning("Kronos candle source %s disconnected: %s", source.name, e)
                self._source_failed_until[source.name] = now + SOURCE_BACKOFF_SECONDS
            except Exception as e:
                log.warning("Kronos candle source %s failed: %s", source.name, e)
                self._source_failed_until[source.name] = now + SOURCE_BACKOFF_SECONDS
        self.active_source = None
        return None

    async def warm_up(self):
        """One-shot backfill on startup so the model has real context
        immediately instead of waiting ~maxlen minutes to fill tick by tick."""
        rows = await self._fetch_from_any_source(self.candles.maxlen)
        if rows:
            for row in rows:
                self._push(row)
            log.info("Kronos candle feed warmed up with %d bars from %s", len(self.candles), self.active_source)
        else:
            log.warning("Kronos candle backfill failed on every source -- will keep retrying on refresh()")

    async def refresh(self):
        """Pull the last couple of candles and merge them in. Cheap
        enough to call every poll tick -- exchanges update the
        in-progress candle continuously; closed ones roll over once a
        minute. Also used to keep retrying a backfill that failed on
        every source at startup."""
        rows = await self._fetch_from_any_source(3 if self.candles else self.candles.maxlen)
        if rows:
            for row in rows:
                self._push(row)
        # else: every source is down or backing off -- leave the buffer as
        # it is and try again next tick.

    def _push(self, row):
        if self.candles and self.candles[-1]["timestamps"] == row["timestamps"]:
            self.candles[-1] = row             # update the still-forming bar
        else:
            self.candles.append(row)

    def is_warm(self) -> bool:
        return len(self.candles) >= config.KRONOS_MIN_CONTEXT_BARS


class KronosSignal:
    """Lazily-loaded Kronos model, plus a cached (side, confidence) call
    refreshed at most every KRONOS_REFRESH_SECONDS."""

    def __init__(self, feed: CandleFeed):
        self.feed = feed
        self._predictor = None
        self._load_failed = False
        self._cached_side: Optional[Side] = None
        self._cached_conf: float = 0.0
        self._cached_at: float = 0.0
        self._cached_window_key: Optional[str] = None
        self.last_volatility: Optional[float] = None
        self.last_threshold: float = config.KRONOS_MIN_CONFIDENCE

    def _ensure_loaded(self) -> bool:
        if self._predictor is not None:
            return True
        if self._load_failed:
            return False
        try:
            from model import Kronos, KronosTokenizer, KronosPredictor  # from the Kronos repo
            tokenizer = KronosTokenizer.from_pretrained(config.KRONOS_TOKENIZER_ID)
            model = Kronos.from_pretrained(config.KRONOS_MODEL_ID)
            self._predictor = KronosPredictor(
                model, tokenizer, device=config.KRONOS_DEVICE, max_context=self.feed.candles.maxlen,
            )
            log.info("Kronos model loaded (%s / %s)", config.KRONOS_MODEL_ID, config.KRONOS_TOKENIZER_ID)
            return True
        except Exception as e:
            log.error(
                "Kronos failed to load (%s) -- side selection has nothing to key off "
                "of, so every window will be skipped (no trade) until this is fixed.", e,
            )
            self._load_failed = True
            return False

    def _confidence_threshold(self, closes) -> float:
        """Lower the confidence floor as recent 1m volatility increases."""
        lookback = max(2, config.KRONOS_VOLATILITY_LOOKBACK)
        recent = [float(value) for value in closes[-lookback:]]
        returns = [
            math.log(current / previous)
            for previous, current in zip(recent, recent[1:])
            if previous > 0 and current > 0
        ]
        volatility = (
            (sum((value - (sum(returns) / len(returns))) ** 2 for value in returns)
             / len(returns)) ** 0.5
            if returns else 0.0
        )
        self.last_volatility = volatility

        low = config.KRONOS_VOLATILITY_LOW
        high = max(low, config.KRONOS_VOLATILITY_HIGH)
        scale = 1.0 if high == low else max(0.0, min(1.0, (volatility - low) / (high - low)))
        floor = min(config.KRONOS_MIN_CONFIDENCE_FLOOR, config.KRONOS_MIN_CONFIDENCE)
        threshold = config.KRONOS_MIN_CONFIDENCE - (
            scale * (config.KRONOS_MIN_CONFIDENCE - floor)
        )
        self.last_threshold = threshold
        return threshold

    def get_signal(
        self,
        now: Optional[float] = None,
        window_key: Optional[str] = None,
    ) -> "tuple[Optional[Side], float]":
        """Returns (side, confidence 0..1). (None, 0.0) means: buffer not
        warm yet, model unavailable, forecast too weak to act on, or
        inference errored -- caller should skip the window in all cases.

        A cache entry is valid only for the same window. This prevents a
        signal generated near one boundary from being reused for the next
        window when the boundary arrives within KRONOS_REFRESH_SECONDS.
        """
        now = now if now is not None else time.time()
        same_window = window_key is not None and window_key == self._cached_window_key
        if same_window and now - self._cached_at < config.KRONOS_REFRESH_SECONDS:
            return self._cached_side, self._cached_conf
        self._cached_at = now
        self._cached_window_key = window_key

        if not self.feed.is_warm() or not self._ensure_loaded():
            self._cached_side, self._cached_conf = None, 0.0
            return self._cached_side, self._cached_conf

        try:
            import pandas as pd
            rows = list(self.feed.candles)
            df = pd.DataFrame(rows)
            df["timestamps"] = pd.to_datetime(df["timestamps"], unit="s")
            y_timestamp = pd.date_range(
                df["timestamps"].iloc[-1], periods=config.KRONOS_PRED_LEN + 1, freq="1min",
            )[1:]
            pred = self._predictor.predict(
                df=df[["open", "high", "low", "close", "volume"]],
                x_timestamp=df["timestamps"],
                y_timestamp=y_timestamp,
                pred_len=config.KRONOS_PRED_LEN,
                T=config.KRONOS_TEMPERATURE,
                top_p=config.KRONOS_TOP_P,
                sample_count=config.KRONOS_SAMPLE_COUNT,
            )
            last_close = float(df["close"].iloc[-1])
            forecast_close = float(pred["close"].iloc[-1])
            move = (forecast_close - last_close) / last_close
            conf = min(1.0, abs(move) / config.KRONOS_MOVE_SCALE)
            threshold = self._confidence_threshold(df["close"].tolist())

            if conf < threshold:
                self._cached_side, self._cached_conf = None, conf
            else:
                self._cached_side = Side.UP if move > 0 else Side.DOWN
                self._cached_conf = conf
        except Exception as e:
            log.warning("Kronos inference failed: %s", e)
            self._cached_side, self._cached_conf = None, 0.0

        return self._cached_side, self._cached_conf
