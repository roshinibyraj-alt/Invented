# CLOB tranche bot demo runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard reports $10,000 paper capital, $500 per side, $250 per tranche, a $0.90 entry cap, a $0.30 hard stop, and forced exit at T−10 seconds.

## Expected behavior

- UP and DOWN evaluate their own asks and positions; either side can enter without the other.
- On either side, tranche A uses a $0.60 ask trigger and tranche B uses $0.70; UP and DOWN remain independent. The $0.90 entry cap still applies.
- The simulator sweeps visible CLOB depth. A thin book may partially fill; any unspent part of the tranche allocation remains available.
- On either side, when a best bid reaches or falls below $0.30, the stop latches and the simulator attempts to sell the remaining shares at available bids (so a gap may fill below $0.30). It retries on new quotes if no bid is available, and a stopped tranche cannot re-enter that window.
- Each tranche's TP is calculated from its own average fill, not the trigger ask. The simulator sells only at bids at or above that TP.
- After the complete TP sale, the tranche's available allocation plus its full net sale proceeds are used on the next buy when its ask reaches TP−$0.10. The other tranche's balance and state do not change.
- An entry above $0.80 has an unreachable +$0.20 TP and stays open until the forced-exit cutoff.
- At T−10 seconds, the simulator stops entries and attempts to sell all open tranches concurrently against visible bids. It retries while the window remains open. Shares that do not sell remain pending until Gamma marks the market closed and UMA resolution as resolved, with Up/Down outcome prices exactly $0/$1. The bot then books the remaining shares at the official $1 win or $0 loss payout; it never invents a pre-expiry sale.

## Reading the output

- Dashboard tranche rows show each entry threshold, available budget, average fill, TP, re-entry ask, and open shares.
- `[bot]` stdout records window discovery, entries, TP/forced exits, unfilled exits, and a 30-second health heartbeat.
- Partial-sale P&L is recorded immediately. Equity marks current-window open positions to the latest best bid. Expired shares awaiting official resolution show the last bid only as a stale reference and are excluded from equity/P&L; Gamma resolution polling runs every 15 seconds. Once resolved, the remaining shares are settled to $1/$0 and realized P&L is updated. Taker fees are estimated, and paper fills are not evidence of live execution or profitability.
