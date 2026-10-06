# Independent CLOB Tranche Bot

Demo-only Polymarket BTC five-minute UP/DOWN bot. Market metadata is discovered through Gamma; every price trigger and simulated fill uses the public Polymarket CLOB.

## Strategy

- UP and DOWN enter independently. Each starts with one $100 tranche per five-minute window.
- New entries are blocked for the first 90 seconds after each window starts. Existing positions continue to be monitored for TP, hard stop, forced exit, and settlement during the delay.
- Each side's single tranche enters when its best ask reaches $0.90. The $0.90 cap remains in force, so asks above $0.90 are skipped; thin books can result in a partial simulated fill.
- For every open UP or DOWN position, a best bid at or below $0.70 latches a hard stop and attempts to sell all remaining shares at available bids. It keeps retrying on new quotes if no bid is executable; a gap can therefore fill below $0.70. Positions never rearm or re-enter within the same window.
- The martingale is shared by both sides and advances once per window when a hard stop is triggered. Each side's next-window stake follows $100 → $200 → $400 (two doublings maximum). A winning position resets both sides to $100; a stop at the $400 step resets the following window to $100. A window without a win or stop leaves the current step unchanged.
- Every position has a fixed TP threshold: the CLOB best bid must reach $0.99. For shares actually filled by the TP order, demo accounting credits $1.00 per share; estimated fees are calculated from the actual CLOB fill average, which is recorded separately from the accounted exit price. Unfilled shares remain open and retry on later quotes.
- Ten seconds before expiry, new entries stop and open positions are sold concurrently against available CLOB bids. Any remainder with no bid stays pending until Gamma confirms the market is closed and resolved with a final binary outcome price. The demo then books each remaining share at $1 for the winning outcome or $0 for the losing outcome.

## Safety and limitations

`DemoTrader` reads public CLOB books and simulates fills locally. It has no wallet, signer, authentication, or live order methods. `LIVE_TRADING=true` is rejected at startup. Gamma's finalized outcomes are read only for demo settlement; CCXT/spot-price signals, the old trigger/hedge rules, unconfirmed settlement guesses, and live-trading dependencies are not part of this bot.

Demo balance, martingale level, tranche balances, positions, and trade history live in memory and reset on restart. Partial-sale P&L is recorded immediately. Unsold shares remain pending until Gamma reports a closed, resolved market with $0/$1 outcome prices; account equity/net P&L are withheld until then. Settlement uses only the official final outcome, never a stale CLOB quote. Taker fees are estimates; CLOB depth and simulated fills are not evidence of live execution or profitability.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000` for the dashboard. The dashboard and `[bot]` stdout events show quotes, tranche state, fills, exits, and positions awaiting official resolution.
