# Independent CLOB Tranche Bot

Demo-only Polymarket BTC five-minute UP/DOWN bot. Market metadata is discovered through Gamma; every price trigger and simulated fill uses the public Polymarket CLOB.

## Strategy

- UP and DOWN are independent. Each side starts each five-minute window with a $500 allocation split into two $250 tranches.
- On both UP and DOWN, tranche A buys when that side's best ask reaches $0.60; tranche B has its own $0.70 ask trigger. The sides remain independent.
- Entry orders spend the tranche's available USDC and never pay above a $0.90 ask. Thin books can result in a partial simulated fill.
- For every open UP or DOWN tranche, a best bid at or below $0.50 latches a hard stop and attempts to sell all remaining shares at available bids. It keeps retrying on new quotes if no bid is executable; a gap can therefore fill below $0.50. After the first full stop sale, the tranche can rearm when its ask recovers to its original entry trigger ($0.60 for A, $0.70 for B), using its remaining budget and net stop-sale proceeds.
- Every position has a fixed TP threshold: the CLOB best bid must reach $0.99. For shares actually filled by the TP order, demo accounting credits $1.00 per share; estimated fees are calculated from the actual CLOB fill average, which is recorded separately from the accounted exit price. Unfilled shares remain open and retry on later quotes.
- Each A/B tranche may make at most one follow-up entry per five-minute window, whether its first position closes by TP or hard stop. After a TP, the re-entry ask starts from the higher of the TP price and the ask observed at exit, then trails the highest observed ask by $0.10. On a pullback to that target, it re-enters using its remaining allocation plus net TP proceeds. After a stop, it can rearm at its original entry trigger. Once that one rearm's position closes, the tranche is done for the window.
- Ten seconds before expiry, new entries stop and open positions are sold concurrently against available CLOB bids. Any remainder with no bid stays pending until Gamma confirms the market is closed and resolved with a final binary outcome price. The demo then books each remaining share at $1 for the winning outcome or $0 for the losing outcome.

## Safety and limitations

`DemoTrader` reads public CLOB books and simulates fills locally. It has no wallet, signer, authentication, or live order methods. `LIVE_TRADING=true` is rejected at startup. Gamma's finalized outcomes are read only for demo settlement; CCXT/spot-price signals, the old trigger/hedge rules, unconfirmed settlement guesses, and live-trading dependencies are not part of this bot.

Demo balance, tranche balances, positions, and trade history live in memory and reset on restart. Partial-sale P&L is recorded immediately. Unsold shares remain pending until Gamma reports a closed, resolved market with $0/$1 outcome prices; account equity/net P&L are withheld until then. Settlement uses only the official final outcome, never a stale CLOB quote. Taker fees are estimates; CLOB depth and simulated fills are not evidence of live execution or profitability.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000` for the dashboard. The dashboard and `[bot]` stdout events show quotes, tranche state, fills, exits, and positions awaiting official resolution.
