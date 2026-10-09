# Polymarket BTC demo bot runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard shows `$1,000` shared demo cash, the active rung, the low-rung `$0.30` maker price or high-rung `$0.70` bid trigger, the `$0.99` take-profit, and a `$0.30` high-rung stop.

## Expected behavior

- **Low rung:** when the active market is found, the bot posts one post-only `$0.30` buy on UP and one on DOWN for `10 × 1.4^losses` shares. There is 250ms modeled order-arrival latency. If the order would cross the ask, it waits rather than taking liquidity. Visible asks alone never fill it. A later public SELL print at or below `$0.30` may confirm a paper fill at exactly `$0.30`, after estimated queue ahead. The first fill of any size cancels the opposite order. A low-rung loss keeps the low rung active and increases its next-window size by 1.4×; a low-rung win resets its loss streak and activates the high rung for the next window. Low rung has no stop loss.
- **High rung:** the low rung is paused. When a fresh Polymarket CLOB best bid on one side reaches `$0.70`, the bot immediately simulates one market-taker buy on that side by sweeping visible asks: 30 shares on its first attempt or 100 shares after one loss. Fill prices follow visible ask levels and can exceed `$0.70`; taker fees are calculated per level, with no maker rebate. Any unfilled remainder is cancelled and is not a loss. A high-rung loss on attempt one arms the 100-share attempt for the next window; a second loss returns to the low rung. A win at either size also returns to the low rung. High rung does not use the 1.4× martingale.
- **Take profit and stop:** both rungs use the post-only `$0.99` TP; an eligible later BUY print models an exit credit of `$1/share`. Maker entries and TP exits pay no modeled fees; a paper rebate is credited from the configured 20%-of-fee-equivalent assumption. The high rung's market entry and its stop both pay the modeled taker fee `shares × 0.07 × price × (1-price)` at each actual/simulated fill price.
- A no-fill window is not a loss. At five-minute close, unfilled orders are canceled; remaining shares are classified at `$1/$0` from final-three-second CLOB bids (or the latest in-window bids if those are unavailable). This is a paper proxy, not official Polymarket settlement. The shared `$1,000` cash, rung state, loss streak, positions, and trade history reset on process restart.

## Reading the output

- The dashboard shows UP and DOWN in separate columns, their entry/exit order statuses, current rung and attempt, share target, fill price, and any open position.
- Global account equity includes simulated maker-rebate credits. Fees are zero for maker entry/TP; high-rung market entries and stop exits charge modeled taker fees. Rebate credits are a paper assumption, not actual venue earnings.
- Net, realized, unrealized, and per-trade P&L use green/red states. The event log records rung switches, high-rung triggers, ask-sweep results and depth-short cancels, post-only waits, exact-price low-rung maker fills, taker fees, stop exits, and CLOB close classifications.
- CLOB quotes, books, and public trade prints do not reveal hidden liquidity, canceled queue volume, or guaranteed live execution. The stop uses top-of-book bid only and does not sweep depth; actual execution can be worse. Paper outcomes may differ from official Polymarket settlement.
