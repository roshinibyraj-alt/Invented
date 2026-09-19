# AI signal (traded with the signal) — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. One entry
attempt **every** window (no-skip mode), direction decided by an AI
signal engine predicting the next window's outcome. The bot trades
**with** that signal (no fade).

## Strategy

1. The instant a new window opens, compute features off the Binance
   BTC/USDT 1-minute feed — RSI(14), 3- and 10-candle momentum,
   10-candle volatility, the signal candle's own color, and the
   current same-color candle streak — and feed them to the AI signal
   engine (`app/ai_signal.py`), a small logistic regression predicting
   P(next window resolves UP).
2. **No-skip mode**: the model always returns UP or DOWN. RSI is
   computed and logged against the predicted side for visibility, but
   it does **not** block the trade.
3. The bot places a resting **maker** limit buy on the **signalled**
   side @ 0.45 (`ORDER_PRICE`). It fills at its own exact price, no
   slippage, no fee, the moment that side's ask drops to/through it.
4. **30-second timeout** (`ORDER_TIMEOUT_SECONDS`): if the resting
   order hasn't filled 30s after it was placed, it is cancelled.
5. **Taker fallback**: from the cancel until the window closes, the
   first tick the signalled side's best ask is strictly **below 0.60**
   (`TAKER_FALLBACK_MAX_PRICE`), the bot buys at market — a real
   taker fill priced by walking actual ask depth for the full size,
   paying the taker fee. The 0.60 gate is checked against the best
   ask, so a 200-share fill on a thin book can average slightly above
   0.60. If the ask never gets below 0.60 before the window closes,
   there is no trade that window.
6. **No stop-loss.** Take profit is fixed at 0.99 — a real taker sell,
   priced by walking actual book depth, the moment the bid reaches it.
7. Only one entry, one trade max per window — no re-arming. If the
   position is open but TP never hits, it is force-closed at window
   end (taker, real depth-weighted price).
8. Every window's true outcome (once known, via the last observed CLOB
   midpoint at window rollover) is fed back into the AI signal engine
   as one online training step — whether or not a trade was placed.

The only thing that can skip a window for data reasons is missing
candle history from the live Binance feed. See "Startup warm-start"
below for why that's rare.

## Startup warm-start (`app/backtest.py`)

At process startup, **before** the live Binance websocket connects,
the bot fetches `AI_BACKTEST_DAYS` (default 3) of 1-minute BTC/USDT
candles from Binance's free public REST klines endpoint (no API key
needed) and uses that one fetch for two things:

- **Pretrains the model's weights** by replaying the history through
  the exact same feature computation and 5-minute window grid the
  live bot uses. Label: whether BTC's own price finished each
  historical window higher than it opened (Polymarket's own
  historical order book isn't available, but that's the real thing
  these markets resolve on).
- **Seeds the live feed's candle cache** with the most recent ~30
  candles from that same fetch. This matters separately from
  pretraining: the model's weights being trained doesn't help if the
  live feed's own candle cache is still empty — that cache normally
  needs ~15 real minutes to fill (RSI(14) + the 10-candle lookback)
  before features can be computed at all. Seeding it means a full
  lookback is available from the very first live tick instead.

Both steps are best-effort: if Binance's REST API is unreachable, the
bot just starts fully cold (untrained model, empty feed cache) and
learns/fills in online instead — same as if this module didn't exist.
Nothing here can prevent the bot from starting.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed, all vars are optional
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `ORDER_SHARES` (200), `ORDER_PRICE` (0.45), `ORDER_TIMEOUT_SECONDS` (30), `TAKER_FALLBACK_MAX_PRICE` (0.60), `TP_PRICE` (0.99)
- `RSI_PERIOD` / `RSI_OVERBOUGHT` / `RSI_OVERSOLD` — informational flag only, doesn't block trades
- `AI_LEARNING_RATE`, `AI_L2_REG`, `AI_STREAK_LOOKBACK` — online logistic regression hyperparameters
- `AI_BACKTEST_DAYS` (env: `AI_BACKTEST_DAYS`, default 3) — how much history to pretrain/seed from at startup
- `STARTING_CAPITAL` (env: `STARTING_CAPITAL`, default $2000, single shared pool)
- Taker fee constants — the resting entry is a fee-free maker fill; the taker-fallback entry, the TP exit and any forced close all pay a real fee

## Notes / assumptions

- The signal candle's open time is always `window.open_ts - 60` — the
  60 seconds immediately preceding this window's start.
- If Binance data is unavailable for a window (feed down, or too
  early after a fresh process start for the lookback to be full even
  after seeding), that's logged as a no-signal window — not a loss.
- The resting entry fills fully at its exact limit price with no fee
  (maker convention). The taker-fallback entry, the TP exit and the
  forced window-end close use the depth-aware realistic-fill-price
  logic and pay the taker fee (the entry fee is included in the
  position's cost basis).
- The 30s timeout is measured from when the order is placed (right
  after the signal is computed), not from window open, and is checked
  on the 1s poll loop, so it fires within ~1s of 30s.
- The true win/loss label used both for online learning and for
  settling trades comes from the last observed Polymarket CLOB
  midpoint at window rollover (`state.py`'s `_infer_winner`) — a
  live-market read, not Polymarket's own settled resolution.
- This reuses `models.py`, `paper_broker.py`, `binance_client.py`, and
  `polymarket_client.py` largely unchanged from earlier iterations of
  this bot — `config.py`, `engine.py`, `ai_signal.py`, `backtest.py`,
  and the dashboard are what implement the current strategy.
