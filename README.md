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

There is no take-profit or stop-loss. Every filled leg stays open through the 5-minute window, then waits for the official result of its exact BTC or ETH market. The bot checks pending markets every 5 seconds and settles only after Polymarket publishes a closed market and a definitive winning outcome. Before the window ends, each dashboard card shows a provisional mark based on the latest best bid; that mark is not the final result. While a position is awaiting resolution, the card retains its last pre-expiry mark and floating P&L, clearly labeled as last mark and showing the time spent waiting.

Wins and losses do not change sizing. Each pair can have one entry per window. A delayed official result delays the next entry for that same pair, but does not block the other pairs.

## Data and dashboard

Market metadata and official outcomes come from Polymarket Gamma. The live order books use a Polymarket CLOB WebSocket subscription for the active BTC and ETH token IDs. The mobile-first dashboard puts balance and performance at the top, followed by four persistent cross-pair cards. Each card shows both legs' shares, average entry, cost and fees, live bid, provisional floating P&L, and final result after official resolution.

## Persistent paper history

On Railway, `PAPER_LEDGER_PATH` should point into the mounted persistent volume. This resolution-only release uses a new strategy ID, so deployment starts with a clean paper ledger and saves the fresh state to the configured ledger path. Later restarts restore the four-pair history and open positions.

## Run

```sh
npm test
npm start
```
