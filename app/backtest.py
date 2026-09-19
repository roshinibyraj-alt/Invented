"""
Historical pretraining for the AI signal engine (app/ai_signal.py).

Binance's public REST klines endpoint needs no API key and serves
years of history, so at startup the bot fetches the last
config.AI_BACKTEST_DAYS of 1-minute BTC/USDT candles and replays them
through the EXACT same feature computation (AISignalEngine.compute_features)
and the same 5-minute window grid the live bot uses (windows align to
epoch multiples of WINDOW_SECONDS -- see polymarket_client.py's
current_window_open_ts()), training the model on all of it before the
first live tick. This removes the old live cold-start almost entirely:
the model already has real learned weights from minute one instead of
starting from all-zero weights.

Label used for each historical window: whether BTC's own spot price
finished the window higher than it opened. The live bot's true label
comes from Polymarket's own order book at window rollover (see
state.py's _infer_winner) -- Polymarket doesn't expose historical
order books, but these are BTC up/down markets, so BTC's own price
move over the window is the real thing they resolve on, making it a
solid proxy label for pretraining.

Network failures here are non-fatal by design: if Binance's REST API
is unreachable (offline dev environment, rate limit, outage), the bot
just starts with an untrained model and learns online instead, same
as before this feature existed. Nothing about this module can prevent
the bot from starting.
"""
import time
from typing import Optional

import httpx

from . import config
from .ai_signal import AISignalEngine
from .binance_client import BinanceKlineFeed, Candle

KLINES_LIMIT = 1000   # Binance's per-request cap


async def fetch_historical_klines(days: float) -> list:
    """Returns a list of (open_time_seconds, open, close) 1-minute
    candles, ascending, fetched via Binance's public REST klines
    endpoint (GET /api/v3/klines) -- no API key required. Paginates in
    1000-candle chunks since that's Binance's per-request cap."""
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - int(days * 86400 * 1000)
    out = []
    async with httpx.AsyncClient(timeout=20) as client:
        cursor = start_ms
        while cursor < end_ms:
            resp = await client.get(config.AI_BACKTEST_BASE_URL, params={
                "symbol": "BTCUSDT", "interval": "1m", "startTime": cursor, "limit": KLINES_LIMIT,
            })
            resp.raise_for_status()
            batch = resp.json()
            if not batch:
                break
            for row in batch:
                # kline row: [openTime, open, high, low, close, volume, closeTime, ...]
                out.append((row[0] / 1000.0, float(row[1]), float(row[4])))
            cursor = batch[-1][0] + 60_000   # one minute past the last candle's open time
            if len(batch) < KLINES_LIMIT:
                break   # caught up to "now"
    return out


def pretrain_from_klines(ai: AISignalEngine, klines: list) -> int:
    """Replays historical 1-minute candles as if they were live,
    training `ai` window-by-window exactly the way the live engine
    would (same signal-candle offset, same feature computation).
    Returns the number of windows trained on. Safe to call with an
    empty/short klines list -- just trains on whatever full windows
    fit."""
    if not klines:
        return 0

    # Reuse BinanceKlineFeed itself as the data source -- it's just a
    # dict + a few pure read methods until .start() is called, so this
    # gets compute_features()'s RSI/momentum/streak logic for free
    # instead of re-implementing it here and risking drift.
    feed = BinanceKlineFeed()
    for open_time, o, c in klines:
        key = int(open_time // 60) * 60
        feed.candles[float(key)] = Candle(open_time=key, open=o, close=c, closed=True)

    times = sorted(feed.candles.keys())
    start, end = times[0], times[-1]
    window_seconds = config.WINDOW_SECONDS

    # Align to the same 5-minute grid the live bot's windows use
    # (open_ts = floor(now / WINDOW_SECONDS) * WINDOW_SECONDS).
    first_open = (int(start // window_seconds) + 1) * window_seconds

    n_trained = 0
    t = first_open
    while t + window_seconds <= end:
        signal_open_ts = t - 60   # same offset _check_signal uses live
        open_candle = feed.get_candle(t)
        close_candle = feed.get_candle(t + window_seconds - 60)
        feats = ai.compute_features(feed, signal_open_ts)
        if feats is not None and open_candle is not None and close_candle is not None:
            actual_up = close_candle.close > open_candle.open
            ai.learn(feats, actual_up, pretrain=True)
            n_trained += 1
        t += window_seconds

    return n_trained


async def pretrain_ai(ai: AISignalEngine) -> "tuple[int, Optional[str]]":
    """Top-level entry point called once at startup. Returns
    (windows_trained, error_message). error_message is None on
    success; on any failure, windows_trained is 0 and the caller
    should just proceed -- this is best-effort warm-starting, never a
    hard requirement to run."""
    try:
        klines = await fetch_historical_klines(config.AI_BACKTEST_DAYS)
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"
    try:
        n = pretrain_from_klines(ai, klines)
        return n, None
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"
