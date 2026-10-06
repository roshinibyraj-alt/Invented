# Independent CLOB Tranche Bot

Demo-only Polymarket BTC five-minute UP/DOWN bot. Market metadata is discovered through Gamma; every price trigger and simulated fill uses the public Polymarket CLOB.

## Strategy

- UP and DOWN are independent. Each side starts each five-minute window with a $500 allocation split into two $250 tranches.
- Both $250 tranches on each side buy when that side's best ask reaches at least $0.60. The UP and DOWN sides are independent.
- Entry orders spend the tranche's available USDC and never pay above a $0.90 ask. Thin books can result in a partial simulated fill.
- Each tranche exits when its best bid reaches its average fill price plus $0.20. If the average fill is above $0.80, that TP is above the binary share's $1 ceiling; the position remains open for the forced exit instead.
- After a complete TP sale, that tranche waits for its ask to fall to TP minus $0.10, then re-enters using its remaining allocation plus all net proceeds from the sale. The other tranche is unaffected. This repeats until the window's forced-exit cutoff.
- Ten seconds before expiry, new entries stop and open positions are sold concurrently against available CLOB bids. If no bid liquidity is available, the demo leaves the remainder unresolved rather than inventing a fill.

## Safety and limitations

`DemoTrader` reads public CLOB books and simulates fills locally. It has no wallet, signer, authentication, or live order methods. `LIVE_TRADING=true` is rejected at startup. CCXT/spot-price signals, the old trigger/hedge rules, settlement guesses, and live-trading dependencies are not part of this bot.

Demo balance, tranche balances, positions, and trade history live in memory and reset on restart. Partial-sale P&L is recorded immediately. If an expired position remains unsold, its last bid is shown only as stale, and account equity/net P&L are withheld until its value is known. Taker fees are estimates; CLOB depth and simulated fills are not evidence of live execution or profitability.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000` for the dashboard. The dashboard and `[bot]` stdout events show quotes, tranche state, fills, exits, and unresolved forced exits.
