# Version History

## v070-pullback-analyzed  ← `git tag v070-pullback-analyzed`
- Commit: `4505e22`
- The version whose logs were analyzed (uploaded `logs.1788121909006.csv`, Aug 30 13:20–20:30 UTC).
- Strategy: wait 45s · **first entry AT/BELOW 0.70** (pullback, no 0.65–0.70 band yet) · SL 0.50 · re-enter ≥0.65 ×2 · ceiling 0.99 · **base 10% · NO carry**
- Known behavior in this version: first entry could buy the cheap side (0.12–0.30); profitable "SL at 0.50" still escalated the martingale.

## v080-any-side-fees  ← current
- Reverted to v070 entry logic: **fire ANY side ≤ 0.70** (not cheap-side specific). May buy the underdog — this produced the profitable analyzed logs.
- **Polymarket taker fees added**: `fee = shares × 0.07 × price × (1 − price)` on every buy and sell.
- **TP label fixed**: exits at 0.50 with entry < 0.50 correctly labeled as **TP** (profit), not STOP-LOSS. Martingale still escalates after TP (unchanged).
- **Frozen-market skip removed**: bot trades every window regardless of price stagnation.
- 45-second wait after window open retained.
- **Config**: 10% base · no carry · max 2 martingale per window.
