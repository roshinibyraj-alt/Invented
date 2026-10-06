# CLOB tranche bot demo runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard reports $10,000 paper capital, $500 per side, $250 per tranche, a $0.90 entry cap, a $0.50 hard stop, and forced exit at T−10 seconds.

## Expected behavior

- UP and DOWN evaluate their own asks and positions; either side can enter without the other.
- On either side, tranche A uses a $0.80 ask trigger and tranche B uses $0.90; UP and DOWN remain independent. The $0.90 entry cap still applies, so B enters only at the cap.
- No new entries are allowed during the first 90 seconds after a five-minute window starts. TP, hard-stop, forced-exit, and settlement handling remain active during the delay.
- The simulator sweeps visible CLOB depth. A thin book may partially fill; any unspent part of the tranche allocation remains available.
- On either side, when a best bid reaches or falls below $0.50, the stop latches and the simulator attempts to sell the remaining shares at available bids (so a gap may fill below $0.50). It retries on new quotes if no bid is available. After a full stop sale, that tranche may rearm once when its ask recovers to the original A ($0.80) or B ($0.90) trigger.
- Every position has a fixed TP threshold of best bid $0.99, regardless of its average fill. The simulator sells only at CLOB bids at or above $0.99. For each share actually filled, demo accounting credits $1.00; it records the actual CLOB average separately and estimates fees from that actual fill.
- Each A/B tranche may make at most one follow-up entry per window after either its first TP or stop exit. After TP, the re-entry target starts from the higher of $0.99 and the ask observed at exit, then trails the highest observed ask by $0.10. A buy occurs when the ask pulls back to that target, using the tranche's available allocation plus net TP proceeds. After a stop, re-entry waits for the original ask trigger. Once the follow-up position closes, no further rearm is allowed that window.
- At T−10 seconds, the simulator stops entries and attempts to sell all open tranches concurrently against visible bids. It retries while the window remains open. Shares that do not sell remain pending until Gamma marks the market closed and UMA resolution as resolved, with Up/Down outcome prices exactly $0/$1. The bot then books the remaining shares at the official $1 win or $0 loss payout; it never invents a pre-expiry sale.

## Reading the output

- Dashboard tranche rows show each entry threshold, available budget, average fill, fixed TP, TP re-entry / hard-stop rearm ask, rearm count, and open shares. Trade history distinguishes the accounted exit/share from the actual CLOB exit average.
- Net, realized, unrealized, and per-trade P&L are green when positive and red when negative; win and loss counts have separate colored badges.
- `[bot]` stdout records window discovery, entries, TP/forced exits, unfilled exits, and a 30-second health heartbeat.
- Partial-sale P&L is recorded immediately. Equity marks current-window open positions to the latest best bid. Expired shares awaiting official resolution show the last bid only as a stale reference and are excluded from equity/P&L; Gamma resolution polling runs every 15 seconds. Once resolved, the remaining shares are settled to $1/$0 and realized P&L is updated. Taker fees are estimated, and paper fills are not evidence of live execution or profitability.
