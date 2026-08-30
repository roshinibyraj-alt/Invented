# RecoveryBot — BTC 5m Signal Follower with 4x Recovery

BTC-led 5-minute Polymarket paper bot driven by a 7-indicator Binance signal composite, with a 4x recovery-ladder sizing engine.

## Strategy
- Watch the `btc-updown-5m-*` market only.
- Compute a composite score from 7 indicators on Binance 1m candles + tick data:
  Window Delta, Micro Momentum, Acceleration, EMA 9/21, RSI 14, Volume Surge, Tick Trend.
- Lean = UP (score > 0) or DOWN (score < 0). Confidence = |score| / 7.0.
- Wait 10 seconds after the window opens, then follow the signal at confidence >= 70% (`HIGH_CONF`):
  - lean UP → buy UP
  - lean DOWN → buy DOWN
- Single trade per window, no intra-window flip.
- **Stop loss**: applies to ANY position once the window is at least
  `STOP_LOSS_AFTER` (240s) old — if the held side's price touches `STOP_LOSS_PRICE`
  (0.20) or lower, the position is sold immediately at 0.20.
- Otherwise hold to resolution: during the final two seconds the highest UP/DOWN
  CLOB prices are sampled; `>= 0.90` side (or higher side) wins and settles.

## Recovery Sizing (2x → 3x → 4x)
- Base shares: 1000 (`FLAT_SHARES`).
- On a loss the bot enters recovery mode: ladder `RECOVERY_LEVELS = [2, 3, 4]`,
  held up to `RECOVERY_HOLD` (3) windows per level, stepping up on each loss until
  the accumulated debt is fully recovered, then back to base size.
- Max-risk guard: a recovery bet is skipped if it would risk more than
  `MAX_RISK_PCT` (25%) of bankroll.

## Pricing
All market prices come from batched CLOB `/books` snapshots. Signal data comes from Binance public REST (candles + tick price).
