# Invented multi-asset dip-and-bounce paper bot

Invented tracks Polymarket BTC, ETH, SOL, and DOGE UP/DOWN markets on both 5-minute and 15-minute windows. It is a paper simulator only and does not submit real orders or use wallet credentials.

## Strategy

Each of the eight asset/timeframe markets is independent. From the time its CLOB feed is first observed during the active window:

1. Watch the UP and DOWN midpoint independently.
2. When a side's midpoint goes below $0.40, arm that side.
3. When its midpoint later reaches $0.50 or higher, place one simulated resting limit buy for 100 shares at $0.48.
4. Count the full 100-share paper fill at exactly $0.48 only after a later Polymarket CLOB book update shows that side's best bid at or below $0.47. This is the requested paper touch rule, not a claim that a real resting order filled.
5. If a filled position's best bid reaches $0.99, close it at a modeled $1.00 payout per share. There is no stop-loss. If take-profit has not hit by the market's end, hold the position for its official resolution.
6. Cancel unfilled resting limits at their market's own window end.

The paper ledger starts at $3,000 and is held in process memory. A Railway deployment/restart clears the prior positions, orders, and results and starts a fresh ledger. No old strategy state is imported.

## Data and dashboard

Market metadata and official results come from Polymarket Gamma; live order-book updates come from one Polymarket CLOB WebSocket subscription covering active token IDs. There is no Binance price input or REST order-book fallback. If a market or feed is unavailable, the affected market waits for data while the other markets continue.

The mobile-first dashboard shows the account summary, all eight market windows, each side's midpoint/dip/bounce/order state, open or resolution-pending positions, recent paper orders, events, and an equity curve. Strategy rules and paper-only limitations are visible on the page.

## Run

```sh
npm test
npm start
```
