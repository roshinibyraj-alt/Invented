# Previous-window momentum — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. One
resting limit order per window, direction decided by the color of the
**previous window's own last 1-minute Binance spot candle**.

## Strategy

1. The instant a new window opens, read the just-finished window's
   last 1-minute Binance candle (the `[240s, 300s)` minute of the
   window that just closed — by the time the new window starts, this
   candle has necessarily already closed):
   - **green** (close > open) → place a resting limit buy on **UP**,
     200 shares, @ **0.45**
   - **red** (close < open) → place a resting limit buy on **DOWN**,
     200 shares, @ **0.45**
   - **flat** (close == open) → no trade this window
2. This is a real **maker** limit order — it fills at its own exact
   price (0.45), no slippage, no fee, the moment that side's ask drops
   to/through it. It is **not** a taker/market buy.
3. **10-second fill timeout**: if that resting order is still unfilled
   10 seconds after the window opened, it's cancelled immediately and
   the same size is bought **at market instead** — a real taker buy,
   priced by walking actual order-book depth, real fee. This
   guarantees the signal actually gets acted on rather than risking a
   window where price never revisits 0.45 at all.
4. **No stop-loss.** Take profit is fixed at 0.99 — a real taker sell,
   priced by walking actual book depth, the moment the bid reaches it.
5. Only one order, one trade max per window — no re-arming. If the
   order fills (either the resting maker fill or the 10s market
   fallback) but TP never hits, the position is force-closed at window
   end (taker, real depth-weighted price).
6. If Binance's data for that candle hasn't arrived yet right at the
   window boundary (feed lag), the engine keeps checking every tick
   and places the order the instant it becomes available — the 10s
   fill-timeout clock only starts once an order actually exists, but
   is still measured from window open, so a late-placed order can
   trigger its own market fallback on the very next tick if window
   open + 10s has already passed by the time it's placed.

This completely replaces the earlier "read minute 2 of the current
window" strategy — Binance is still signal-only (never prices or
executes anything), just reading a different candle now.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `ORDER_SHARES` (200), `ORDER_PRICE` (0.45), `RESTING_ORDER_TIMEOUT_SECONDS` (10), `TP_PRICE` (0.99)
- `STARTING_CAPITAL` ($2000, single shared pool)
- Taker fee constants (the resting entry is a fee-free maker fill; the 10s market fallback, the TP exit, and any forced close all pay a real fee)

## Notes / assumptions

- The signal candle's open time is always `window.open_ts - 60` —
  i.e. the 60 seconds immediately preceding this window's start. This
  is unambiguous and doesn't depend on `SIGNAL_CANDLE_OFFSET` at
  runtime; that constant in `config.py` is documentation only (it
  records which minute of the *previous* window this is: the 240–300s
  one).
- A flat candle (close exactly equals open) results in no trade for
  that window — counted separately from a real loss.
- If Binance data never arrives at all for a window (feed down the
  entire time), that's logged as a no-signal window — also not a loss.
- The entry fills fully at its exact limit price with no fee (maker
  convention, same as every resting-order engine in this project). The
  depth-aware realistic-fill-price logic only applies to the TP exit
  and the forced window-end close (both real taker fills).
- This reuses `models.py`, `paper_broker.py`, `binance_client.py`, and
  `polymarket_client.py` unchanged. `state.py`'s
  `Engine(broker, binance_feed)` construction is unchanged from the
  previous version — only `config.py` and `engine.py` (and the
  dashboard) changed for this strategy.
