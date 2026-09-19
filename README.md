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
3. **Live call — every window gets one, and says how solid it is.** The
   current snapshot is matched in three tiers, strongest evidence first,
   and the tier is shown with the call:
   - **VALIDATED** — situations that passed the noise test above. The
     strongest matches vote (hit rates shrunk toward 50% for small
     samples, averaged in log-odds). Shown with hit rate, sample size,
     z-score, the time of day they worked best, and whether their last
     six matches were right.
   - **WEAK PATTERN** — situations that looked strong in the last 7 days
     (z ≥ 2.0, same consistency filters) but did *not* clear the noise
     test, so they may be luck. Used only when no validated situation
     matches.
   - **BASELINE** — nothing above matches, so every current reading is
     weighed together: how did windows with each reading tend to end
     over the week (shrunk toward the base rate, damped for overlap, week
     drift subtracted so it doesn't always say UP). Shown as the
     readings that pulled hardest.
   `MTF_ALLOW_FALLBACK=0` restores validated-only trading (windows with
   no validated match are then skipped — on real BTC data that is often
   every window).
4. **Honesty check.** The same procedure (all three tiers) is also run on
   the first 70% of the week and scored on the untouched last 30% —
   overall and per tier. That out-of-sample accuracy (with z-score and a
   plain-language verdict) is on the dashboard next to the in-sample
   number, which is optimistic by construction, and next to the live
   accuracy per tier as windows resolve.
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
  state orchestration, noise-vs-planted-pattern checks, and the tiered
  fallback, on synthetic data

## Config knobs (`app/config.py`)

- Execution: `ORDER_SHARES` (200), `ENTRY_DELAY_SECONDS` (2),
  `ENTRY_MAX_PRICE` (0.60), `TP_PRICE` (0.99), `STARTING_CAPITAL` ($2000)
- Signal: `MTF_ALLOW_FALLBACK` (on), `MTF_BACKTEST_DAYS` (7), `MTF_MIN_SAMPLES` (25), `MTF_MIN_Z`
  (2.6, floor), `MTF_PERMUTATIONS` (30, `0` disables the noise
  calibration and leaves only `MTF_MIN_Z` — many more situations will
  pass, most of them luck), `MTF_TOP_RULES` (7 voters),
  `MTF_MAX_RULE_SIZE` (3), `MTF_REFRESH_EVERY_WINDOWS` (12)

## Notes / assumptions

- **Trading a weak signal.** Five-minute BTC direction is close to a coin
  flip. When nothing validates, the WEAK PATTERN / BASELINE tiers still
  produce a call so the bot trades every window — but on random data
  their measured out-of-sample accuracy is ~50%, and a taker buy at
  ~0.5–0.6 plus fees needs roughly 55%+ to break even. The dashboard
  shows the real out-of-sample and live accuracy per tier; if they sit
  at ~50%, the bot is paying fees for a coin flip. Watch the per-tier
  live accuracy, and use `MTF_ALLOW_FALLBACK=0` to trade only validated
  situations.
- Window outcome in the backtest = the window's own Binance 5m candle
  closed above its open. Live outcomes (history append, win/loss
  settlement) come from the last observed Polymarket CLOB midpoint at
  window rollover (`state.py`'s `_infer_winner`), not Polymarket's own
  settled resolution.
- The 0.60 gate uses the best ask; a 200-share fill on a thin book can
  average slightly above it, and taker fills pay the fee.
- Windows are skipped only for missing market data, the engine having no
  history yet (pre-backtest failed), or the ask staying at/above the
  cap all window (plus, in strict mode, no validated situation);
  each is counted separately on the dashboard.
