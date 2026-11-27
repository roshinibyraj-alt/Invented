# BTC Calibrated Edge — paper research bot

This replaces Invented's prior active reversal strategy. `node index.js` runs
only `calibrated-bot.js` and `calibrated-worker.js`; old strategy modules are
not loaded. No wallet, signing or exchange trading API is used. Startup refuses
`LIVE_TRADING=true`.

## Models and honest interpretation

- Two independently trained LightGBM classifiers: BTC 5-minute and 15-minute.
- Thirty days of Binance BTCUSDT completed one-minute bars.
- Features: multi-horizon returns, volatility, EMA distances, candle structure,
  elapsed time and distance from the Binance window open. No Polymarket order
  pressure, traded volume, funding, or future candle data.
- Each minute-close snapshot predicts its window's final direction.
- Whole windows remain within chronological train/calibration/test folds
  (60/20/20), with a full-window embargo between folds.
- Sigmoid calibration uses only the middle fold; the last fold is untouched.
- A model is eligible only if held-out Brier loss beats the training-prevalence
  baseline. Brier, log loss, reliability bins and fold counts are displayed.
- Retrain every six hours. A model older than eight hours is ineligible.
- Predictions refresh after completed one-minute candles, not unfinished bars.
  Minute zero has no prediction. Missing/stale observations block trading.

**Important limitation:** Labels are Binance window close/open outcomes, not
historical Chainlink/oracle ground truth. These probabilities are calibrated
on that proxy, not verified settlement probabilities. Polymarket's oracle and
TWAP can differ. Held-out directional accuracy is not a profitable trading
backtest and does not establish edge after trading costs.

## Paper strategy

- Separate $1,500 accounts ($3,000 total), positions, trades and equity histories.
- At most one entry per timeframe/window. No flip, martingale, TP or SL.
- Prefer the higher-probability side, requiring confidence at least 58%.
- Each swept ask level must retain at least $0.04 estimated edge/share after
  the market's supplied fee-rate/exponent; no guessed fees.
- Target 50 shares, reduced to fit 2% of that account's remaining cash.
- Price levels outside $0.05–$0.95 are not used.
- Require a subsequent fresh matching book after at least 500ms before filling.
  With two-second REST polling, effective simulation delay is generally longer.
- Execution uses actual visible depth, allows partial fills, rounds modeled
  entry fees per level, and rejects wrong/stale token books.
- No new entry during the final 30 seconds. No forced fallback trades.
- Hold to the exact market's official resolution. Poll pending results every
  ten seconds; never infer settlement from Binance or near-$1 quotes.
- Floating equity uses depth-backed bid liquidation value net of estimated
  exit fees. Missing depth/stale marks mean unknown equity, not zero value.
  Settled balance and cash remain visible separately.

## Storage, reset and operation

`PAPER_LEDGER_PATH` should remain on the existing `/data` Railway volume.
Changing the strategy identifier archives the old ledger and creates a fresh
active one. Same-strategy restarts restore both accounts without resetting.
The old bootstrap history, if configured, is not used when a volume ledger
already exists. Model candle cache lives separately beside the ledger.

The dashboard is read-only at `/`; `/api/state` and `/api/healthz` are public
read-only endpoints. No secret values are returned.

```sh
npm test
npm run test:model
npm start
```

Legacy strategy tests remain as historical references; the active test command
targets this strategy and the reused market/persistence utilities.
