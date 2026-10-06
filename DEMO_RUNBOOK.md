# CLOB tranche bot demo runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard reports $10,000 paper capital, one $100 base tranche per side, a $0.90 entry ask/cap, a $0.70 hard stop, the current shared martingale step, and forced exit at T−10 seconds.

## Expected behavior

- UP and DOWN evaluate their own asks and positions; either side can enter without the other. Each side has one tranche, sized equally according to the shared martingale level.
- Each side enters when its best ask reaches $0.90. The $0.90 cap means asks above $0.90 are skipped.
- No new entries are allowed during the first 90 seconds after a five-minute window starts. TP, hard-stop, forced-exit, and settlement handling remain active during the delay.
- The simulator sweeps visible CLOB depth. A thin book may partially fill; any unspent part of the tranche allocation remains available.
- On either side, when a best bid reaches or falls below $0.70, the stop latches and the simulator attempts to sell the remaining shares at available bids (so a gap may fill below $0.70). It retries on new quotes if no bid is available. A position cannot rearm or re-enter in the same five-minute window.
- The martingale is shared: a stop in a window advances both UP and DOWN next-window stakes once, from $100 each to $200 each, then to $400 each. A win resets both to $100; another stop at the $400 cap resets the following window to base stakes. The level and stake reset on process restart with the demo state.
- Every position has a fixed TP threshold of best bid $0.99, regardless of its average fill. The simulator sells only at CLOB bids at or above $0.99. For each share actually filled, demo accounting credits $1.00; it records the actual CLOB average separately and estimates fees from that actual fill.
- At T−10 seconds, the simulator stops entries and attempts to sell all open tranches concurrently against visible bids. It retries while the window remains open. Shares that do not sell remain pending until Gamma marks the market closed and UMA resolution as resolved, with Up/Down outcome prices exactly $0/$1. The bot then books the remaining shares at the official $1 win or $0 loss payout; it never invents a pre-expiry sale.

## Reading the output

- Dashboard tranche rows show each entry threshold, initial and available budget, average fill, fixed TP, and open shares. The martingale badge shows the current level and the next-window stake for both sides. Trade history distinguishes the accounted exit/share from the actual CLOB exit average.
- Net, realized, unrealized, and per-trade P&L are green when positive and red when negative; win and loss counts have separate colored badges.
- `[bot]` stdout records window discovery, entries, TP/forced exits, unfilled exits, and a 30-second health heartbeat.
- Partial-sale P&L is recorded immediately. Equity marks current-window open positions to the latest best bid. Expired shares awaiting official resolution show the last bid only as a stale reference and are excluded from equity/P&L; Gamma resolution polling runs every 15 seconds. Once resolved, the remaining shares are settled to $1/$0 and realized P&L is updated. Taker fees are estimated, and paper fills are not evidence of live execution or profitability.
