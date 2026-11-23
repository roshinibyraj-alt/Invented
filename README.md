# Invented BTC/ETH 5-minute cross-pair paper bot

Invented tracks the Polymarket BTC and ETH UP/DOWN markets on 5-minute windows. It is a paper simulator only: it does not submit real orders or use wallet credentials.

## Strategy

Four cross-pairs are evaluated independently:

- BTC UP + ETH DOWN
- ETH UP + BTC DOWN
- BTC UP + ETH UP
- BTC DOWN + ETH DOWN

For each pair, the bot watches the two fresh best asks from the Polymarket CLOB WebSocket. When their sum is strictly below $0.80, it makes one paper taker entry for that pair in the current 5-minute window. All four pairs can enter independently during the same window.

Each leg always requests 100 shares, regardless of previous results. The paper simulator sweeps visible asks up to $0.99, records actual filled quantities, volume-weighted entry prices, and modeled taker fees, and cancels any unfilled remainder. Entry is skipped while the same cross-pair has an earlier position awaiting official resolution.

The four pairs are inverse-linked: BTC UP + ETH UP ↔ BTC DOWN + ETH DOWN, and BTC UP + ETH DOWN ↔ BTC DOWN + ETH UP. When one pair's own fresh combined best asks reach $1.22 or higher, the bot sells that pair's remaining shares against visible bids, recording actual swept proceeds and sell fees. If the visible bid depth is insufficient, it sells what is available and retries the remainder on later fresh book updates. The inverse pair is not sold by this event and may enter only if its own fresh ask sum is below $0.80.

The previous per-side exits are restored: a best bid at or above $0.99 closes the remaining quantity with a modeled $1 payout per share; a fresh empty bid book triggers the $0 stop-loss. Any remaining shares at window end wait for the official result of their exact BTC or ETH market. The bot checks pending markets every 5 seconds and settles only after Polymarket publishes a closed market and a definitive winning outcome. Before the window ends, dashboard cards show the live bid and floating P&L; resolution-waiting cards retain the last pre-expiry mark.

Wins and losses do not change sizing. Each pair can have one entry per window. A delayed official result delays the next entry for that same pair, but does not block the other pairs.

## Data and dashboard

Market metadata and official outcomes come from Polymarket Gamma. The live order books use a Polymarket CLOB WebSocket subscription for the active BTC and ETH token IDs. The mobile-first dashboard puts balance and performance at the top, followed by four cross-pair cards. Each card shows its inverse pair, entry and exit thresholds, both legs' shares, average entry, cost and fees, live bid, sold/remaining quantities, floating P&L, and final exit or resolution result.

## Persistent paper history

On Railway, `PAPER_LEDGER_PATH` should point into the mounted persistent volume. This release uses a new strategy ID, so deployment starts with a clean paper ledger and saves the fresh state to the configured ledger path. Later restarts restore the four-pair history and open positions.

## Run

```sh
npm test
npm start
```
