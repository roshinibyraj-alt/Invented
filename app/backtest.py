"""
Historical pretraining for the AI signal engine (app/ai_signal.py) --
AND live-feed warm-start, which matters just as much.

Binance's public REST klines endpoint needs no API key and serves
years of history, so at startup the bot fetches the last
config.AI_BACKTEST_DAYS of 1-minute BTC/USDT candles ONCE and uses
them for two separate things:

  1. pretrain_from_klines(): replays them through the EXACT same
     feature computation (AISignalEngine.compute_features) and the
     same 5-minute window grid the live bot uses (windows align to
     epoch multiples of WINDOW_SECONDS -- see polymarket_client.py's
     current_window_open_ts()), training the model's weights on all
     of it before the first live tick.
  2. seed_live_feed(): pretraining only warms up the MODEL's weights.
     The live engine's _check_signal() still computes the CURRENT
     window's features off the live BinanceKlineFeed's own candle
     cache -- that cache starts empty and needs ~15 real minutes to
     fill (RSI(14) + the 10-candle lookback) before compute_features()
     stops returning None, no matter how well-trained the model
     already is. This seeds that live cache with the same historical
     data so a full lookback is available from the very first live
     tick too -- otherwise "pretrained but still shows not-enough-
     history" is exactly what you'd see for the first ~15 minutes.

Both must run, in this order, BEFORE the live websocket
(binance_feed.start()) is started -- see pretrain_ai() below, which is
the single entry point state.py calls that does both.

Label used for each historical window: whether BTC's own spot price
finished the window higher than it opened. The live bot's true label
comes from Polymarket's own order book at window rollover (see
state.py's _infer_winner) -- Polymarket doesn't expose historical
order books, but these are BTC up/down markets, so BTC's own price
move over the window is the real thing they resolve on, making it a
solid proxy label for pretraining.

Network failures here are non-fatal by design: if Binance's REST API
is unreachable (offline dev environment, rate limit, outage), the bot
just starts with an untrained model and an empty live cache and learns
online instead, same as before this feature existed. Nothing about
this module can prevent the bot from starting.
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


def seed_live_feed(feed: BinanceKlineFeed, klines: list) -> int:
    """Pretraining warms up the MODEL's weights, but the live engine's
    _check_signal() still reads the CURRENT window's features off
    `feed` (the real BinanceKlineFeed the websocket writes into) --
    without this, that cache starts empty and needs ~15 live minutes
    to fill (RSI(14) + the 10-candle momentum/volatility lookback)
    before compute_features() stops returning None, no matter how
    well-trained the model already is. This seeds `feed.candles` with
    the tail of the same historical data used for pretraining, so
    there's already a full lookback window available from the first
    live tick. Only the most recent MAX_CANDLES are kept (matches the
    feed's own trim policy) -- older history isn't needed for feature
    computation anyway. Must be called BEFORE feed.start(), so the
    live websocket's real-time updates aren't clobbered by this
    REST-sourced data landing after it.
    Returns how many candles were seeded."""
    from .binance_client import MAX_CANDLES
    if not klines:
        return 0
    recent = klines[-MAX_CANDLES:]
    for open_time, o, c in recent:
        key = int(open_time // 60) * 60
        feed.candles[float(key)] = Candle(open_time=key, open=o, close=c, closed=True)
    feed._trim()
    return len(recent)


async def pretrain_ai(ai: AISignalEngine, live_feed: Optional[BinanceKlineFeed] = None) -> dict:
    """Top-level entry point called once at startup, before
    live_feed.start(). Fetches historical klines ONCE and uses them
    for both: (1) training the model's weights, and (2) seeding
    live_feed's candle cache so the live engine has a full feature
    lookback immediately instead of waiting ~15 live minutes for it to
    fill naturally. Returns a status dict; on any failure the model
    just starts untrained and the feed just starts empty, same as
    before this module existed -- this is best-effort warm-starting,
    never a hard requirement to run."""
    try:
        klines = await fetch_historical_klines(config.AI_BACKTEST_DAYS)
    except Exception as e:
        return {"windows_trained": 0, "candles_seeded": 0, "error": f"{type(e).__name__}: {e}"}
    try:
        n_trained = pretrain_from_klines(ai, klines)
        n_seeded = seed_live_feed(live_feed, klines) if live_feed is not None else 0
        return {"windows_trained": n_trained, "candles_seeded": n_seeded, "error": None}
    except Exception as e:
        return {"windows_trained": 0, "candles_seeded": 0, "error": f"{type(e).__name__}: {e}"}
