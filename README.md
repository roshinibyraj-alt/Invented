# Candle-color engine — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. One trade
per window, direction decided by the color of BTC's own second
1-minute spot candle, read live from Binance's websocket.

## Strategy

1. **Minute 1 (0–60s of the window)**: no action — just elapses while
   Binance's first 1-minute candle for this window forms.
2. **Minute 2 (60–120s)**: the instant this candle closes (Binance
   sends its final update, `x: true`), compare close to open:
   - **green** (close > open) → buy **UP**
   - **red** (close < open) → buy **DOWN**
   - **flat** (close == open) → no trade this window
3. Binance's spot price is used **only** to decide the color — it
   never prices or executes anything. The actual entry is a real
   **taker** buy against Polymarket's own order book (real
   depth-weighted fill, real fee), fired the instant the candle color
   is known.
4. **No stop-loss.** Take profit is fixed at 0.99 — a real taker sell,
   priced by walking actual book depth, the moment the bid reaches it.
5. **No re-arming**: one entry per window, maximum. If TP never hits,
   the position is force-closed at window end (taker, real
   depth-weighted price).
6. If Binance's data for the relevant candle hasn't arrived by the
   120s mark (feed lag, reconnect, etc.), the engine keeps checking
   every tick and fires the instant it becomes available — it doesn't
   guess or skip early.

500 shares, flat, no progression.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## New: Binance websocket feed

`app/binance_client.py` is a new module — a long-lived, auto-reconnecting
websocket connection to `wss://stream.binance.com:9443/ws/btcusdt@kline_1m`,
started alongside the main poll loop in `state.py`. It keeps a rolling
~30-minute cache of 1-minute candles (open, close, closed-or-not),
keyed by minute-aligned open time. The engine only ever reads from this
cache (`get_candle(ts)`) — it never touches the websocket directly.

This is a genuinely separate data source from Polymarket's CLOB: BTC's
real spot price on Binance decides direction; Polymarket's own UP/DOWN
order book is where every actual buy/sell is priced and filled.

## Config knobs (`app/config.py`)

- `BASE_SHARES`, `SIGNAL_MINUTE_OFFSET`, `SIGNAL_MINUTE_DURATION`, `TP_PRICE`
- `STARTING_CAPITAL` ($2000, single shared pool)
- Taker fee constants (every fill in this engine is a real taker order)

## Notes / assumptions

- The "minute 2" candle is defined as the Binance 1-minute kline whose
  open time is exactly `window.open_ts + 60s` — since Polymarket's
  5-minute windows are clock-aligned (`:00`, `:05`, `:10`, ...), this
  lines up exactly with Binance's own minute boundaries.
- A flat candle (close exactly equals open) results in no trade for
  that window at all — counted separately from a real loss.
- If Binance data never arrives for the whole window (feed down the
  entire time), that window is logged as a no-signal window — also not
  a loss, just never traded.
- Entry, TP, and the forced window-end close are all real taker fills,
  priced by walking actual order-book depth (`_realistic_fill_price`) —
  not a flat settlement shortcut of any kind.
- This reuses `models.py`, `paper_broker.py`, and
  `polymarket_client.py` unchanged. `state.py` gained ownership of the
  new `BinanceKlineFeed` (started/stopped alongside the existing poll
  loop) and now constructs `Engine(broker, binance_feed)` instead of
  `Engine(broker)`.
