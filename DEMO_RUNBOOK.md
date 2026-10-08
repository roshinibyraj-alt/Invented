# Polymarket BTC demo bot runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard reports $1,000 shared paper cash, two independent $0.40 limit orders, 10 base shares per side, $0.99 TP, no stop loss, and separate UP/DOWN loss streaks.

## Expected behavior

- UP and DOWN place independent paper limit orders at $0.40 when the Polymarket five-minute market is discovered. The base quantity is 10 shares per side, subject to reserving the full amount from shared cash.
- A paper order fills only at visible ask levels priced at or below $0.40. Partial fills use displayed depth; unchanged book snapshots are not reused to invent extra fills. The remaining size rests until the window closes.
- Each side tracks its own loss streak. A finalized loss multiplies only that side's next target by 1.8; a finalized win resets only that side to 10 shares. Pending positions and unfilled orders do not change a streak.
- A best bid of $0.99 or higher triggers a simulated sale against visible CLOB bids at or above $0.99. Proceeds use actual fill prices and estimated fees; there is no hard stop or forced pre-expiry sale.
- At the five-minute close, any unfilled limit remainder is cancelled and its reservation released. Open shares are immediately paper-settled at $1/$0 from final-three-second CLOB bids: a sole bid above $0.98 wins; otherwise the higher bid wins. Missing final quotes use the latest in-window bid; quote ties use the fresher timestamp, then default to UP if still tied or both quotes are missing. This outcome is only a CLOB-price paper proxy, not official Polymarket settlement.
- The $1,000 shared demo capital, both loss streaks, positions, and trade history reset on process restart.

## Reading the output

- Dashboard side rows show the independent limit order, target/remaining shares, cash reservation, average fill, TP, and side loss streak. Available cash is shown after resting-order reservations.
- Net, realized, unrealized, and per-trade P&L are green when positive and red when negative; win and loss counts have separate colored badges.
- `[bot]` stdout records window discovery, limit placement, simulated fills, TP exits, CLOB close classifications, and a 30-second health heartbeat.
- Partial TP P&L is recorded immediately; current-window open shares are marked to the latest best bid. At close, the CLOB-price paper outcome finalizes every remaining position, releases the capital, updates equity, and updates only that side's streak. The selected price proxy can disagree with Polymarket's official resolution. Fees are estimates; paper fills are not evidence of live execution or profitability.
