# Invented BTC/ETH 5-minute cross-pair paper bot

Invented tracks the Polymarket BTC and ETH UP/DOWN markets on 5-minute windows. It is a paper simulator only: it does not submit real orders or use wallet credentials.

## Strategy

Two cross-pairs are evaluated independently:

- BTC UP + ETH DOWN
- ETH UP + BTC DOWN

For each pair, the bot watches the two fresh best asks from the Polymarket CLOB WebSocket. When their sum is strictly below $0.80, it makes one paper taker entry for that pair in the current 5-minute window. Both pairs can enter during the same window.

Each leg requests 100 shares at the base size. The paper simulator sweeps visible asks up to $0.99, records actual filled quantities, volume-weighted entry prices, and modeled taker fees, and cancels any unfilled remainder. Entry is skipped while the same cross-pair has an earlier position awaiting official resolution, so the next size is based on known outcomes.

Each filled leg is managed independently:

- When its fresh best bid reaches $0.99, the simulator closes it and credits $1.00 per share.
- When a fresh book has no bid, the simulator closes it at $0.00 payout.
- Any leg still open when the 5-minute window ends is sent to official resolution.

Once both legs in a cross-pair entry have closed, the next size is selected as follows:

- If both legs lost, that cross-pair's next qualifying entry uses 1,000 shares per leg.
- If at least one leg won, the next size remains at 100 shares per leg.
- After a 1,000-share entry closes, the next size returns to 100 shares per leg, regardless of outcome.

Sizing is tracked separately for the two cross-pairs. A delayed official result delays the next entry for that same pair, but does not block the other pair.

## Data and dashboard

Market metadata and official outcomes come from Polymarket Gamma. The live order books use a Polymarket CLOB WebSocket subscription for the active BTC and ETH token IDs. The mobile-first dashboard has a separate card for each cross-pair. Each card shows the current entry and recent trade details for both legs, live P&L, exit status, and the next size.

## Persistent paper history

On Railway, `PAPER_LEDGER_PATH` should point into the mounted persistent volume. The new strategy uses its own strategy ID. When the app starts with the old strategy's ledger, it intentionally starts a clean ledger for this replacement and saves the fresh state to the configured ledger path. Later restarts restore the cross-pair sizing state and open positions.

## Run

```sh
npm test
npm start
```
