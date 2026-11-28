# BTC 5-minute 94-cent paper bot

This is a paper-only price-trigger strategy, not live trading.

- BTC 5-minute UP/DOWN markets only; no model or 15-minute trading.
- When exactly one side's fresh best ask is at least $0.94, buy a flat 300 shares.
- Require enough visible asks and cash for all 300 shares, including fees. Do not resize or fabricate fills.
- Wait at least 500 ms and observe a later fresh book before filling; actual ask sweep prices may exceed $0.94.
- One entry per window; no re-entry after a stop, flips, recovery or compounding.
- A held-side best bid at or below $0.90 latches a stop. After latency, sell into actual visible bids, including taker fees. Partial sales continue without reusing unchanged consumed depth. Sale proceeds are not guaranteed to equal $0.90.
- Otherwise hold to official market resolution: winning shares pay $1, losing shares pay $0. A $0.99 quote is not a simulated $1 sale.
- At expiry, any unsold remainder waits for official settlement and is never moved into the next market.

The five-minute paper account starts at $1,500. Changing from the previous strategy archives the old ledger and resets history once. Subsequent restarts restore this strategy's saved positions, stops, and history.

## Run

Node.js 22 or later, no Python model worker required:

```sh
npm test
npm start
```

Set `PAPER_LEDGER_PATH` to a file on persistent storage (Railway volume mounted at `/data`). `PORT` defaults to 3000. Setting `LIVE_TRADING=true` refuses startup; no real order execution exists here.

Dashboard `/`; state `/api/state`; health `/api/healthz`. Missing executable marks are shown as unknown, not zero. Paper fills cannot reproduce real queueing, market impact, or guaranteed availability after latency.
