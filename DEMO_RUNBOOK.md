# Demo-mode runbook

Use this checklist to exercise the paired-limit strategy without real orders. `DemoTrader` reads public Polymarket books and simulates fills locally; it does not sign or submit orders.

## Safe startup

1. Keep `LIVE_TRADING` unset or set to anything other than the exact text `true`. No wallet key is needed.
2. Run `npm install`, then `npm test`.
3. Start with `npm start` and open `http://localhost:3000`.
4. Confirm the dashboard says **DEMO MODE**, shows **$10,000** starting capital, and reports **500 shares at $0.30**.
5. Set `LIVE_TRADING=true` only in a controlled test if verifying the guard; startup must exit before wallet authentication.

## What to check

- On an active BTC 5-minute window, two resting BUY limits are simulated: 500 UP shares at $0.30 and 500 DOWN shares at $0.30. The bot checks that available demo cash covers the full $300 pair cost before posting either.
- When one side fills, it cancels the opposite order and holds the filled shares to settlement. The orders are not exchange-native OCO: if both fill before cancellation completes, both positions are recorded and an `OCO_RACE_FILL` event is logged.
- At window close, any unfilled entry orders are canceled. Open shares remain subject to the existing held-side CLOB thresholds: midpoint at or above $0.99 counts as a $1 payout; best bid at or below $0.01 counts as a $0 payout. If neither threshold is reached, Gamma's official resolution remains the fallback.
- A settled loss adds 250 shares to the next pair. A settled win resets the next pair to the 500-share base.
- Equity is available cash plus the marked value of all open shares, including positions from previous windows. Total P&L is equity minus starting capital.

## Interpret results

Demo cash, stake progression, and trade history are in memory and reset when the process restarts. The public book is used as a fill simulation; fills, estimated maker rebates, settlement thresholds, and P&L are not evidence of live execution or profitability. Stop the process with Ctrl+C.