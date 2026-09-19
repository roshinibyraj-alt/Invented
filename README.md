# ⚡ ALPHASTRIKE — multi-timeframe BTC 5m up/down bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. At every
5-minute window it asks one question — **UP or DOWN, and why?** — using
indicators on four timeframes (1D, 4H, 1H, 15m), and trades **with** the
answer, at the window's first seconds, as a taker. The reasons behind
every call are logged and shown on the dashboard.

## How the signal works (`app/mtf_engine.py`)

1. **Snapshot at window open.** Nine indicators on each of 1D / 4H / 1H /
   15m — RSI(14), MACD(12,26,9), EMA20/50 trend, Bollinger %B, Stochastic,
   ADX(+DI/−DI), volume vs its 20-period average, last candle colour, and
   where price is versus the still-forming candle's open (in ATRs) — plus
   the UTC time-of-day block and weekday/weekend. Each reading is bucketed
   into a token such as `4H trend UP` or `1H RSI<30`. Only fully closed
   candles as of the window open are used (plus the forming candle's
   *open*, which is already known), so nothing can look ahead. The test
   suite checks that the live path and the backtest path produce
   identical snapshots even when the forming candle's data is corrupted.
2. **Pre-backtest of the last 7 days** (~2,000 windows, run at startup).
   Every window becomes *(snapshot, did it finish UP?)*. The miner tests
   every 1-, 2- and 3-token **situation** — e.g. `4H trend UP + 1H RSI<30
   + T 08-12h UTC` — and keeps only situations that:
   - matched at least `MTF_MIN_SAMPLES` (25) windows,
   - beat a coin flip by a z-score above a cut-off **calibrated on the
     data itself**: the same search is re-run on copies with the
     outcomes shuffled (where nothing can be predictive) and the cut-off
     is the level noise reaches only 5% of the time. Without this, a
     search over thousands of situations always finds "winners" by luck —
     on pure random data a fixed cut-off keeps dozens of them,
   - pointed the same way in both halves of the week, and
   - (2-/3-condition ones) clearly beat each of their own parts.
3. **Live call.** The current snapshot is matched against the kept
   situations; the strongest matches vote (hit rates shrunk toward 50% for
   small samples, averaged in log-odds). Output: side, confidence, and the
   exact situations behind it — their historical hit rate, sample size,
   z-score, the time of day they worked best, and whether their last six
   matches were right. **If no validated situation matches, there is no
   trade** — no evidence, no side.
4. **Honesty check.** The same procedure is also run on the first 70% of
   the week and scored on the untouched last 30%. That out-of-sample
   accuracy (with z-score and a plain-language verdict) is on the
   dashboard next to the in-sample number, which is optimistic by
   construction.
5. **Keeps learning.** Every resolved window — traded or not — is
   appended to a rolling 7-day history (oldest dropped) together with
   its snapshot and true outcome, and the situations are re-mined every
   `MTF_REFRESH_EVERY_WINDOWS` windows (default 12, about hourly) in a
   worker thread, never at window rollover so it can't delay the entry.
   New situations can appear, and ones that stopped working fall away.
   Live hit rate of the calls is tracked separately on the dashboard.

## Execution (taker only, no limit orders)

1. Signal computed at window open.
2. `ENTRY_DELAY_SECONDS` (2s) after the window opens, buy `200` shares of
   the predicted side at market (taker): priced by walking real ask
   depth, taker fee paid and included in cost basis. The loop polls once
   a second, so the buy lands on the first tick at/after +2s (or on the
   tick the signal arrives, if the candle data was late).
3. Guard: only while that side's best ask is strictly below
   `ENTRY_MAX_PRICE` (0.60). If it isn't, the bot re-checks every tick and
   buys the first tick it is below; if it never is, no trade that window.
   Set `ENTRY_MAX_PRICE=1.0` to buy at any price.
4. No stop-loss. Take profit at `0.99` (real taker sell, depth-walked). If
   TP never hits, force-closed at window end.
5. One entry per window, no re-arm.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # all vars optional
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000. Startup fetches ~7 days of Binance
klines (a few seconds) and mines the situations (~5–10s) before the
first window is traded. Binance is used only for analysis; if your host
is geo-blocked from `api.binance.com`, set `BINANCE_KLINES_URL` to a
mirror such as `https://api.binance.us/api/v3/klines`.

## Layout

- `app/indicators.py` — pure-Python RSI, MACD, EMA/SMA, Bollinger,
  Stochastic, ATR, ADX (checked against pandas to ~1e-12)
- `app/marketdata.py` — Binance REST klines (1D/4H/1H/15m/5m)
- `app/mtf_engine.py` — snapshot tokens, situation miner, prediction,
  out-of-sample evaluation
- `app/backtest.py` — startup pre-backtest orchestration
- `app/engine.py` — trading engine (+2s taker entry, TP, forced close)
- `app/state.py` — runtime loop, live candle fetch, periodic re-mining
- `app/polymarket_client.py`, `app/paper_broker.py`, `app/models.py` —
  Polymarket CLOB access, fee/log helper, shared types
- `tests/` — `python tests/run_all.py` (no network needed): indicators vs
  pandas, live-vs-backtest snapshot equality / no-lookahead, order flow,
  state orchestration, and noise-vs-planted-pattern checks on synthetic data

## Config knobs (`app/config.py`)

- Execution: `ORDER_SHARES` (200), `ENTRY_DELAY_SECONDS` (2),
  `ENTRY_MAX_PRICE` (0.60), `TP_PRICE` (0.99), `STARTING_CAPITAL` ($2000)
- Signal: `MTF_BACKTEST_DAYS` (7), `MTF_MIN_SAMPLES` (25), `MTF_MIN_Z`
  (2.6, floor), `MTF_PERMUTATIONS` (30, `0` disables the noise
  calibration and leaves only `MTF_MIN_Z` — many more situations will
  pass, most of them luck), `MTF_TOP_RULES` (7 voters),
  `MTF_MAX_RULE_SIZE` (3), `MTF_REFRESH_EVERY_WINDOWS` (12)

## Notes / assumptions

- **Expect few trades.** Five-minute BTC direction is close to a coin flip;
  after the noise calibration, a week of data often yields few or no
  situations that beat chance, and the bot then simply doesn't trade. The
  dashboard says so explicitly rather than inventing a reason. Any edge
  it does find comes from ~2,000 windows, so treat it as a hypothesis to
  watch in paper trading (live accuracy is tracked), not a proven result.
- Window outcome in the backtest = the window's own Binance 5m candle
  closed above its open. Live outcomes (history append, win/loss
  settlement) come from the last observed Polymarket CLOB midpoint at
  window rollover (`state.py`'s `_infer_winner`), not Polymarket's own
  settled resolution.
- The 0.60 gate uses the best ask; a 200-share fill on a thin book can
  average slightly above it, and taker fills pay the fee.
- Windows are skipped only for missing market data, no matching
  validated situation, or the ask staying at/above the cap all window;
  each is counted separately on the dashboard.
