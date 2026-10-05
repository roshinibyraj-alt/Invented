# Demo-mode runbook

Use this checklist to exercise the trigger/hedge strategy without real orders. `DemoTrader` reads public Polymarket books and simulates fills locally; it does not sign or submit orders.

## Safe startup

1. Keep `LIVE_TRADING` unset or set to anything other than the exact text `true`. No wallet key is needed.
2. Run `npm install`, then `npm test`.
3. Start with `npm start` and open `http://localhost:3000`.
4. Confirm the dashboard says **DEMO MODE**, shows **$10,000** starting capital, and reports a **$100** primary stake with `$0.69` / `$0.70` triggers.
5. Set `LIVE_TRADING=true` only in a controlled test if verifying the guard; startup must exit before wallet authentication.

## What to check

- On an active BTC 5-minute window, the first UP/DOWN best ask at or above `$0.69` triggers a marketable demo BUY for the current USDC stake. The initial primary stake is `$100`.
- After the primary entry, the opposite side is bought only when its best ask reaches `$0.70`. The hedge is 45% of the primary stake, so the sequence is `$45`, `$90`, `$180`, and so on. It is an additional position; it does not sell or close the primary.
- A primary loss doubles the next window's primary stake; a primary win resets it to `$100`. The hedge result does not change the stake progression.
- At any point while a five-minute window is active, a fresh UP or DOWN best-ask tick at or above `$0.97` declares that side the winner and the opposite side the loser. The bot settles the window's positions and updates the primary stake ladder immediately; it does not need a paired-price confirmation.
- If neither side's best ask reaches `$0.97` before the window closes, positions remain unresolved. There is no official-result or close-time leader fallback, and the next primary entry waits for the previous primary rather than using an outdated stake.
- Marketable BUY amount is a fixed USDC budget: `$100` at `$0.69` targets about **144.93 shares** with enough depth. The trigger is not a fill-price cap: execution can be above or below the triggering ask, with 100000% configured slippage, bounded by the binary contract's valid maximum of `$1`. A one-tick ask jump from `$0.65` to `$0.75` still triggers. Better fills buy more shares; thin books can leave budget unfilled. If the REST book is unavailable or has no usable asks, a cached ask no older than 2.5 seconds is used for the simulated fill. Estimated taker fees are included in paper P&L.
- Settlement uses actual filled shares: each share on the winning side returns `$1`; each losing share returns `$0`, including partial fills.
- Equity is available cash plus the marked value of all open shares, including positions from previous windows. Total P&L is equity minus starting capital.

## Interpret results

Demo cash, stake progression, and trade history are in memory and reset when the process restarts. The public book is used as a fill simulation; fills, estimated taker fees, settlement thresholds, and P&L are not evidence of live execution or profitability. Stop the process with Ctrl+C.