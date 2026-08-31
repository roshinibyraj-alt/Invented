# Version History

## v070-pullback-analyzed  ← `git tag v070-pullback-analyzed`
- Commit: `4505e22`
- The version whose logs were analyzed (uploaded `logs.1788121909006.csv`, Aug 30 13:20–20:30 UTC).
- Strategy: wait 45s · **first entry AT/BELOW 0.70** (pullback, no 0.65–0.70 band yet) · SL 0.50 · re-enter ≥0.65 ×2 · ceiling 0.99 · **base 10% · NO carry**
- Known behavior in this version: first entry could buy the cheap side (0.12–0.30); profitable "SL at 0.50" still escalated the martingale.

## LATEST: equity chart on top + lifetime stats
- Commits up to `f19bbf1`
- First entry only in **0.65–0.70 band** (no cheap-side buys) · lifetime equity curve · max drawdown from peak · highest martingale tracker.

## LATEST: cheap-side initial entry
- First entry: buys the CHEAP side (lower ask) after 45s wait — always takes the underdog.
- Martingale re-entries unchanged (any side at ≥0.65 with 2× shares).
- Added win-at-3 with timing fix (SLs fire when opposite side ask < 0.65).
