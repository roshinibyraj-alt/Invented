# CLOB tranche bot demo runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard reports $10,000 paper capital, $500 per side, $250 per tranche, a $0.90 entry cap, a $0.50 hard stop, and forced exit at T−10 seconds.

## Expected behavior

- UP and DOWN evaluate their own asks and positions; either side can enter without the other.
- On either side, tranche A uses a $0.60 ask trigger and tranche B uses $0.70; UP and DOWN remain independent. The $0.90 entry cap still applies.
- The simulator sweeps visible CLOB depth. A thin book may partially fill; any unspent part of the tranche allocation remains available.
- On either side, when a best bid reaches or falls below $0.50, the stop latches and the simulator attempts to sell the remaining shares at available bids (so a gap may fill below $0.50). It retries on new quotes if no bid is available. After a full stop sale, the tranche rearms when its ask recovers to the original A ($0.60) or B ($0.70) trigger.
- Each tranche's TP is calculated from its own average fill, not the trigger ask. The simulator sells only at bids at or above that TP.
- TP is average fill +$0.10. After the full TP sale, re-entry initially targets TP−$0.10, then trails the highest observed ask by $0.10. For example, a $0.60 average fill targets $0.70; if ask rises to $0.80, the re-entry target rises to $0.70. A buy occurs when ask pulls back to the target, using the tranche's available allocation plus all net TP proceeds.
- An average fill at the $0.90 entry cap targets $1.00; that TP is only reachable at a $1.00 best bid and otherwise remains open for forced exit or official settlement.
- At T−10 seconds, the simulator stops entries and attempts to sell all open tranches concurrently against visible bids. It retries while the window remains open. Shares that do not sell remain pending until Gamma marks the market closed and UMA resolution as resolved, with Up/Down outcome prices exactly $0/$1. The bot then books the remaining shares at the official $1 win or $0 loss payout; it never invents a pre-expiry sale.

## Reading the output

- Dashboard tranche rows show each entry threshold, available budget, average fill, TP, TP re-entry / hard-stop rearm ask, and open shares. A hard-stopped tranche rearms only after its full stop sale completes and its ask recovers to that tranche's original entry trigger.
- Net, realized, unrealized, and per-trade P&L are green when positive and red when negative; win and loss counts have separate colored badges.
- `[bot]` stdout records window discovery, entries, TP/forced exits, unfilled exits, and a 30-second health heartbeat.
- Partial-sale P&L is recorded immediately. Equity marks current-window open positions to the latest best bid. Expired shares awaiting official resolution show the last bid only as a stale reference and are excluded from equity/P&L; Gamma resolution polling runs every 15 seconds. Once resolved, the remaining shares are settled to $1/$0 and realized P&L is updated. Taker fees are estimated, and paper fills are not evidence of live execution or profitability.
