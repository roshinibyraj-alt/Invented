# CLOB tranche bot demo runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard reports $10,000 paper capital, $500 per side, $250 per tranche, a $0.90 entry cap, and forced exit at T−10 seconds.

## Expected behavior

- UP and DOWN evaluate their own asks and positions; either side can enter without the other.
- Both $250 tranches on either side use the $0.60 ask trigger; UP and DOWN are independent. The $0.90 entry cap still applies.
- The simulator sweeps visible CLOB depth. A thin book may partially fill; any unspent part of the tranche allocation remains available.
- Each tranche's TP is calculated from its own average fill, not the trigger ask. The simulator sells only at bids at or above that TP.
- After the complete TP sale, the tranche's available allocation plus its full net sale proceeds are used on the next buy when its ask reaches TP−$0.10. The other tranche's balance and state do not change.
- An entry above $0.80 has an unreachable +$0.20 TP and stays open until the forced-exit cutoff.
- At T−10 seconds, the simulator stops entries and attempts to sell all open tranches concurrently against visible bids. It retries while the window remains open. With no bid liquidity, the remaining shares are shown as unresolved; no synthetic sale is recorded.

## Reading the output

- Dashboard tranche rows show each entry threshold, available budget, average fill, TP, re-entry ask, and open shares.
- `[bot]` stdout records window discovery, entries, TP/forced exits, unfilled exits, and a 30-second health heartbeat.
- Partial-sale P&L is recorded immediately. Equity marks current-window open positions to the latest best bid; expired unresolved positions show their last bid as stale and are excluded from P&L valuation. If any remain unresolved, total equity/P&L is shown as unavailable. Taker fees are estimated, and paper fills are not evidence of live execution or profitability.
