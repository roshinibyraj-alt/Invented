"""
Kronos-driven side selection.

Replaces the previous strict UP/DOWN/UP/DOWN alternation: on every new
5-minute window we ask Kronos -- Tsinghua's open-source K-line foundation
model (https://github.com/shiyu-coder/Kronos), a decoder-only transformer
pretrained on 12B+ real OHLCV candles across 45+ exchanges -- to forecast
the next few 1-minute BTC candles, and only take a side if that forecast
is directionally confident. If it isn't, the window is skipped entirely.

Two moving pieces:

  - CandleFeed: a rolling buffer of real 1m BTC/USDT OHLCV candles, pulled
    from Binance's public klines REST endpoint (no auth). Kronos needs
    genuine market history to condition its forecast on -- Polymarket's
    own token prices are a binary contract *on* this same BTC price, not
    the underlying series, so they're the wrong thing to feed the model.
    Kept on its own refresh cycle, independent of the Polymarket poll
    loop, so a Polymarket hiccup doesn't starve the model of data.

  - KronosSignal: lazily loads the tokenizer + model once (first call),
    then serves cached (side, confidence) results, re-running inference
    at most every KRONOS_REFRESH_SECONDS rather than on every 1s tick --
    a transformer forward pass is far too slow to run every poll.

The Kronos model package is vendored in the project's model/ directory.
The first inference downloads the configured tokenizer and model weights
from Hugging Face into the runtime cache.

This module is defensive by design: any import, load, or inference
failure is caught and logged, and get_signal() just returns (None, 0.0)
so the engine treats it exactly like "no confident call this window" --
it never raises into the trading loop.
"""
import logging
import time
from collections import deque
from typing import Optional

import httpx

from . import config
from .models import Side

log = logging.getLogger("kronos_signal")


class CandleFeed:
    """Rolling buffer of 1m BTC/USDT OHLCV candles from Binance's public
    klines endpoint."""

    def __init__(self, maxlen: int = None):
        self._client = httpx.AsyncClient(timeout=8.0)
        self.candles: "deque[dict]" = deque(maxlen=maxlen or config.KRONOS_CONTEXT_BARS)

    async def close(self):
        await self._client.aclose()

    async def warm_up(self):
        """One-shot backfill on startup so the model has real context
        immediately instead of waiting ~maxlen minutes to fill tick by tick."""
        try:
            resp = await self._client.get(
                "https://api.binance.com/api/v3/klines",
                params={"symbol": "BTCUSDT", "interval": "1m", "limit": self.candles.maxlen},
            )
            resp.raise_for_status()
            for row in resp.json():
                self._push(row)
            log.info("Kronos candle feed warmed up with %d bars", len(self.candles))
        except Exception as e:
            log.warning("Kronos candle backfill failed: %s", e)

    async def refresh(self):
        """Pull the last couple of candles and merge them in. Cheap
        enough to call every poll tick -- Binance updates the
        in-progress candle continuously; closed ones roll over once a
        minute."""
        try:
            resp = await self._client.get(
                "https://api.binance.com/api/v3/klines",
                params={"symbol": "BTCUSDT", "interval": "1m", "limit": 3},
            )
            resp.raise_for_status()
            for row in resp.json():
                self._push(row)
        except Exception as e:
            log.warning("Kronos candle refresh failed: %s", e)

    def _push(self, row):
        open_time = int(row[0])
        candle = {
            "timestamps": open_time // 1000,
            "open": float(row[1]), "high": float(row[2]),
            "low": float(row[3]), "close": float(row[4]),
            "volume": float(row[5]),
        }
        if self.candles and self.candles[-1]["timestamps"] == candle["timestamps"]:
            self.candles[-1] = candle          # update the still-forming bar
        else:
            self.candles.append(candle)

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

    def get_signal(self, now: Optional[float] = None) -> "tuple[Optional[Side], float]":
        """Returns (side, confidence 0..1). (None, 0.0) means: buffer not
        warm yet, model unavailable, forecast too weak to act on, or
        inference errored -- caller should skip the window in all cases."""
        now = now if now is not None else time.time()
        if now - self._cached_at < config.KRONOS_REFRESH_SECONDS:
            return self._cached_side, self._cached_conf
        self._cached_at = now

        if not self.feed.is_warm() or not self._ensure_loaded():
            self._cached_side, self._cached_conf = None, 0.0
            return self._cached_side, self._cached_conf

        try:
            import pandas as pd
            rows = list(self.feed.candles)
            df = pd.DataFrame(rows)
            df["timestamps"] = pd.to_datetime(df["timestamps"], unit="s")
            y_timestamp = pd.Series(pd.date_range(
                df["timestamps"].iloc[-1], periods=config.KRONOS_PRED_LEN + 1, freq="1min",
            )[1:])
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

            if conf < config.KRONOS_MIN_CONFIDENCE:
                self._cached_side, self._cached_conf = None, conf
            else:
                self._cached_side = Side.UP if move > 0 else Side.DOWN
                self._cached_conf = conf
        except Exception as e:
            log.warning("Kronos inference failed: %s", e)
            self._cached_side, self._cached_conf = None, 0.0

        return self._cached_side, self._cached_conf
