# Invented BTC/ETH 5-minute cross-pair paper bot

Invented tracks the Polymarket BTC and ETH UP/DOWN markets on 5-minute windows. It is a paper simulator only: it does not submit real orders or use wallet credentials.

## Strategy

Only the two mixed-direction pairs can take new entries:

- BTC UP + ETH DOWN
- ETH UP + BTC DOWN

For each enabled pair, the bot watches the two fresh best asks from the Polymarket CLOB WebSocket. When their sum is strictly below $0.80, it makes one paper taker entry for that pair in the current 5-minute window. Both mixed pairs can enter independently during the same window.

Each leg always requests 100 shares, regardless of previous results. The paper simulator sweeps visible asks up to $0.99, records actual filled quantities, volume-weighted entry prices, and modeled taker fees, and cancels any unfilled remainder. Entry is skipped while the same cross-pair has an earlier position awaiting official resolution.

The two active pairs are inverse-linked: BTC UP + ETH DOWN ↔ BTC DOWN + ETH UP. When one pair's own fresh combined best asks reach $1.22 or higher, the bot sells that pair's remaining shares against visible bids, recording actual swept proceeds and sell fees. If the visible bid depth is insufficient, it sells what is available and retries the remainder on later fresh book updates. The inverse pair is not sold by this event and may enter only if its own fresh ask sum is below $0.80.

The previous per-side exits are restored: a best bid at or above $0.99 closes the remaining quantity with a modeled $1 payout per share; a fresh empty bid book triggers the $0 stop-loss. Any remaining shares at window end wait for the official result of their exact BTC or ETH market. The bot checks pending markets every 5 seconds and settles only after Polymarket publishes a closed market and a definitive winning outcome. Before the window ends, dashboard cards show the live bid and floating P&L; resolution-waiting cards retain the last pre-expiry mark.

Wins and losses do not change sizing. Each enabled pair can have one entry per window. Same-direction pairs are disabled for new entries, but any open same-direction positions from before this change continue through their existing take-profit, stop-loss, inverse-exit, and resolution handling. A delayed official result delays the next entry for that same mixed pair, but does not block the other pair.

## Data and dashboard

Market metadata and official outcomes come from Polymarket Gamma. The live order books use a Polymarket CLOB WebSocket subscription for the active BTC and ETH token IDs. The mobile-first dashboard puts balance and performance at the top, followed by an all-pairs P&L summary for the latest five 5-minute windows (newest first), the two enabled mixed-pair cards, and any disabled pair still managing an older open position. Closed windows show realized net P&L; live windows combine realized P&L with fresh floating marks; unresolved windows show the last pre-expiry mark as provisional. A paginated closed-trade log shows each pair's legs, entry and exit prices, shares, fees, exit reason, and realized P&L.

## Persistent paper history

On Railway, `PAPER_LEDGER_PATH` should point into the mounted persistent volume. This update keeps the existing strategy ID and paper ledger, so historical records and any open positions are preserved. Later restarts restore the saved history and positions from the configured ledger path.

## Run

```sh
npm test
npm start
```
