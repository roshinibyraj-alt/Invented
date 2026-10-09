# Polymarket BTC demo bot runbook

## Safe startup

1. Keep `LIVE_TRADING` unset. No wallet key or trading credential is used.
2. Run `npm install`, `npm test`, then `npm start`.
3. Open `http://localhost:3000` and confirm **DEMO ONLY**.
4. Confirm the dashboard reports $1,000 shared paper cash, paired $0.30 limit buys, first-fill cancellation of the opposite side, $0.99 TP credited at $1/share, no stop loss, and one shared 1.4× loss streak.

## Expected behavior

- As soon as the active market is found, the bot posts one $0.30 paper limit buy on both UP and DOWN for the same current target quantity. Orders become eligible after 250ms modeled arrival. At modeled arrival, asks at or below $0.30 can cross and fill from visible depth; otherwise the orders rest. There is no entry above $0.30 and no opening-delay grace period.
- A resting order can fill only from eligible public SELL trade prints at or below $0.30, with visible queue at the limit estimated from the latest CLOB book. A first fill of any size cancels the opposite outcome. A simultaneous crossing book is resolved by a deterministic UP/DOWN priority that alternates by five-minute window. Remaining same-side limit quantity can stay open until it fills or the window closes.
- Marketable limit portions pay the per-level modeled taker fee `shares × 0.07 × price × (1-price)` and debit demo cash. Passive entry fills have no modeled entry fee. The book, trade prints, modeled latency, and queue estimate cannot confirm actual venue fills.
- There is one shared loss streak because only one outcome can open per window. A finalized loss multiplies the next target by 1.4 (`10 × 1.4^losses`); a profitable finalized win resets it to 10 shares. Flat outcomes and windows with no fill do not change the streak. The shared $1,000 cash balance caps fills.
- Each open position places a post-only paper TP sell at $0.99 when the best bid is below $0.99, after a modeled 250ms delay. A later public CLOB BUY trade print at or above $0.99 models a partial or full fill up to the print size; by request, each TP share is credited as $1.00 in paper proceeds, with zero modeled exit fee. There is no hard stop or forced pre-expiry sale.
- At the five-minute close, any unfilled TP remainder is cancelled. Open shares are immediately paper-settled at $1/$0 from final-three-second CLOB bids: a sole bid above $0.98 wins; otherwise the higher bid wins. Missing final quotes use the latest in-window bid; quote ties use the fresher timestamp, then default to UP if still tied or both quotes are missing. This outcome is only a CLOB-price paper proxy, not official Polymarket settlement.
- The $1,000 shared demo capital, shared loss streak, positions, and trade history reset on process restart.

## Reading the output

- Dashboard side rows show both limit orders, target/filled/cancelled shares, limit/average fill prices, TP order status, and the shared loss streak. No cash is reserved for unfilled paper orders.
- Net, realized, unrealized, and per-trade P&L are green when positive and red when negative; win and loss counts have separate colored badges.
- `[bot]` stdout records paired order posting, limit arrival, first-fill cancellation, crossing and resting fills, TP state/fills, CLOB close classifications, shared martingale changes, and a 30-second heartbeat.
- Partial TP P&L is recorded immediately; current-window open shares are marked to the latest best bid. At close, the CLOB-price paper outcome finalizes any remaining position and updates equity and the shared streak. The selected price proxy can disagree with Polymarket's official resolution. The dashboard's maker-rebate estimate is based on the fee-equivalent curve and 20% rate, but actual Polymarket payout is daily and pro rata by market, with a $1 minimum; the estimate is not cash, is not included in P&L, and may differ from actual payout.
