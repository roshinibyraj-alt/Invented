# ⚡ ALPHASTRIKE — BTC 5m up/down bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Strategy:
**the current window decides the next window.**

## The signal (`app/strategy.py`)

From the five 1-minute BTC closes `c1..c5` of the window that just closed:

- **UP** — minute 2 closed *below* minute 1 (early dip) **and**
  `avg(c3, c4, c5) > avg(c1, c2)` (then recovered).
- **DOWN** — exactly the opposite: minute 2 *above* minute 1 **and**
  `avg(c3, c4, c5) < avg(c1, c2)`.
- Anything else (including any tie) → no pattern → **no trade** next window.

Averages are compared rather than raw sums, because three prices always
add up to more than two; the mean makes "minutes 3–5 vs minutes 1–2" a
fair comparison. Minute prices are Binance BTCUSDT 1-minute closes
(public REST, no key); the bot reads the previous window's five candles
the moment the new window opens (retrying each second until the last
minute has finished closing, giving up after 60s).

## The trade (`app/engine.py`), in the NEXT window, on the signalled side

1. As soon as the signal is known (window open): resting **limit buy**,
   **200 shares @ 0.40** (maker — fills at its own price, no fee, if that
   side's ask drops to/through 0.40).
2. Unfilled **2 minutes** after placement → cancelled. From then until the
   window closes, the first tick that side's best ask is strictly **below
   0.60**, buy **300 shares at market** (taker: priced by walking real ask
   depth, fee paid and included in cost basis). If the ask never gets
   below 0.60, no trade that window.
3. One entry per window: the 200-share limit fill **or** the 300-share
   taker buy, never both.
4. No stop-loss. Take profit at **0.99** (real taker sell, depth-walked);
   otherwise force-closed at window end.

A bot that starts mid-window skips that window and trades from the next.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # all vars optional
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000: the previous window's five minute
closes with the two tests ✓/✗, the resting order / taker watch / open
position, a history of recent windows (signal, winner, what happened,
P&L, running signal accuracy), stats, equity curve and event log. If your
host is geo-blocked from `api.binance.com`, set `BINANCE_KLINES_URL` to a
mirror such as `https://api.binance.us/api/v3/klines`.

## Layout

- `app/strategy.py` — the signal (pure functions) + candle selection
- `app/binance.py` — Binance 1-minute klines
- `app/engine.py` — limit order → timeout → taker fallback → TP / forced close
- `app/state.py` — runtime loop, previous-window candle fetch, window rolling
- `app/polymarket_client.py`, `app/paper_broker.py`, `app/models.py` —
  Polymarket CLOB access, fee/log helper, shared types
- `tests/` — `python tests/run_all.py` (no network needed): the signal
  rule and its edge cases, the full order flow (limit fill, 2-minute
  timeout, taker fallback, skips, exits) and the orchestration with a
  fake Binance and fake Polymarket

## Config (`app/config.py`, env-overridable)

`LIMIT_PRICE` (0.40), `LIMIT_SHARES` (200), `LIMIT_TIMEOUT_SECONDS` (120),
`TAKER_SHARES` (300), `TAKER_MAX_PRICE` (0.60), `TP_PRICE` (0.99),
`STARTING_CAPITAL` ($2000).

## Notes / assumptions

- "Minute N price" = the close of the Nth 1-minute candle.
- Limit fills are all-or-nothing in paper mode, and fill when the side's
  best ask reaches the limit price; there is no queue-position modelling,
  so real fills at exactly 0.40 would be harder than paper suggests.
- Outcomes (signal right/wrong, win/loss) come from the last observed
  Polymarket CLOB midpoint at window rollover (`state.py`'s
  `_infer_winner`), not Polymarket's own settled resolution. Polymarket
  settles on the Chainlink BTC/USD stream; the signal uses Binance
  prices, which track it closely but not identically.
- Taker fee uses `TAKER_FEE_RATE`/`TAKER_FEE_EXPONENT` in `config.py`;
  verify against Polymarket's fee-rate endpoint before real money.
- This is a fixed rule, not a fitted model: nothing here has been
  backtested. Whether the pattern has an edge is an open question — the
  dashboard's signal-accuracy tally is there to measure it as it runs.
