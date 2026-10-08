# Polymarket BTC demo bot runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard reports $1,000 shared paper cash, 10 base shares per side, independent market buys after a 3-second opening delay, $0.99 post-only TP, no stop loss, modeled taker fees, and separate UP/DOWN loss streaks.

## Expected behavior

- At window open + 3 seconds, the bot fetches the CLOB ask books and submits independent paper market buys for UP and DOWN. It allows at most 10 seconds of extra delay for startup/data readiness; if that grace expires, the whole window is skipped rather than entering late. The $0.45 level is only a reference; there is no floor or price cap. Each side targets its current martingale share size, sweeps asks in ascending price order, and records a depth-weighted fill price. Available visible depth and the shared cash balance cap the fill; a partial remainder is cancelled, while a missing book is retried within the grace period.
- These fills use one public order-book snapshot and are not proof of real execution: the depth can change before an order reaches the venue. Taker fees are modeled per ask level using `shares × 0.07 × price × (1-price)` and deducted from demo cash and P&L.
- Each side tracks its own loss streak. A finalized loss multiplies only that side's next target by 1.8; a finalized win resets only that side to 10 shares. Pending positions and unfilled orders do not change a streak.
- Each position places a post-only paper TP sell at $0.99 when the best bid is below $0.99, after a modeled 250ms delay. A later public CLOB BUY trade print at or above $0.99 models a partial or full fill up to the print size; the fill is booked exactly at $0.99, with zero modeled maker fee. There is no hard stop or forced pre-expiry sale.
- At the five-minute close, any unfilled TP remainder is cancelled. Open shares are immediately paper-settled at $1/$0 from final-three-second CLOB bids: a sole bid above $0.98 wins; otherwise the higher bid wins. Missing final quotes use the latest in-window bid; quote ties use the fresher timestamp, then default to UP if still tied or both quotes are missing. This outcome is only a CLOB-price paper proxy, not official Polymarket settlement.
- The $1,000 shared demo capital, both loss streaks, positions, and trade history reset on process restart.

## Reading the output

- Dashboard side rows show the independent market order, target/filled shares, depth-weighted average fill, taker fee, TP order status, and side loss streak. Market-order remainders do not rest or reserve cash.
- Net, realized, unrealized, and per-trade P&L are green when positive and red when negative; win and loss counts have separate colored badges.
- `[bot]` stdout records window discovery, the 3-second entry trigger, visible-depth market fills, TP maker-order state changes, public-print TP fills, CLOB close classifications, and a 30-second heartbeat.
- Partial TP P&L is recorded immediately; current-window open shares are marked to the latest best bid. At close, the CLOB-price paper outcome finalizes every remaining position, releases the capital, updates equity, and updates only that side's streak. The selected price proxy can disagree with Polymarket's official resolution. The dashboard's maker-rebate estimate is based on the fee-equivalent curve and 20% rate, but actual Polymarket payout is daily and pro rata by market, with a $1 minimum; the estimate is not cash, is not included in P&L, and may differ from actual payout.
