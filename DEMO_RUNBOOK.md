# Polymarket BTC demo bot runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard reports $1,000 shared paper cash, two independent $0.45 post-only orders, 10 base shares per side, $0.99 post-only TP, no stop loss, zero fees, and separate UP/DOWN loss streaks.

## Expected behavior

- UP and DOWN reserve independent post-only paper limit buys at $0.45 when the Polymarket five-minute market is discovered. Each starts at 10 shares, subject to reserving the full amount from shared cash. The order becomes resting only if the best ask is above $0.45.
- Quotes never trigger fills. After a fresh non-crossing quote, the model waits 250 ms before treating the order as resting. A later public CLOB SELL trade print at or below $0.45 models a partial or full fill up to that print's size; the fill is booked exactly at $0.45. Duplicate prints are deduplicated. Since public prints do not show hypothetical queue position or venue acceptance, these fills are optimistic estimates, not evidence of actual execution.
- Each side tracks its own loss streak. A finalized loss multiplies only that side's next target by 1.8; a finalized win resets only that side to 10 shares. Pending positions and unfilled orders do not change a streak.
- Each position places a post-only paper TP sell at $0.99 when the best bid is below $0.99. A later public CLOB BUY trade print at or above $0.99 models a partial or full fill up to the print size; the fill is booked exactly at $0.99. Paper fees are zero; there is no hard stop or forced pre-expiry sale.
- At the five-minute close, any unfilled limit remainder is cancelled and its reservation released. Open shares are immediately paper-settled at $1/$0 from final-three-second CLOB bids: a sole bid above $0.98 wins; otherwise the higher bid wins. Missing final quotes use the latest in-window bid; quote ties use the fresher timestamp, then default to UP if still tied or both quotes are missing. This outcome is only a CLOB-price paper proxy, not official Polymarket settlement.
- The $1,000 shared demo capital, both loss streaks, positions, and trade history reset on process restart.

## Reading the output

- Dashboard side rows show the independent post-only order, target/remaining shares, cash reservation, average fill, TP order status, and side loss streak. Available cash is shown after waiting/resting-order reservations.
- Net, realized, unrealized, and per-trade P&L are green when positive and red when negative; win and loss counts have separate colored badges.
- `[bot]` stdout records window discovery, post-only order state changes, public-print paper fills, TP exits, CLOB close classifications, and a 30-second health heartbeat.
- Partial TP P&L is recorded immediately; current-window open shares are marked to the latest best bid. At close, the CLOB-price paper outcome finalizes every remaining position, releases the capital, updates equity, and updates only that side's streak. The selected price proxy can disagree with Polymarket's official resolution. The dashboard's maker-rebate estimate is based on the fee-equivalent curve and 20% rate, but actual Polymarket payout is daily and pro rata by market, with a $1 minimum; the estimate is not cash, is not included in P&L, and may differ from actual payout.
