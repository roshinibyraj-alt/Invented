# Invented BTC/ETH 5-minute dip-and-bounce paper bot

Invented tracks Polymarket BTC and ETH UP/DOWN markets on 5-minute windows only. It is a paper simulator only and does not submit real orders or use wallet credentials.

## Strategy

Each BTC and ETH 5-minute market is independent. From the time its CLOB feed is first observed during the active window:

1. Watch both UP and DOWN midpoints.
2. When either side's midpoint goes below $0.35, arm that side.
3. The first armed side whose midpoint later reaches $0.50 or higher owns that market window; block the opposite side and immediately sweep visible asks for that asset's next scheduled share size, capped at $0.99.
4. Each asset starts at 100 shares and keeps its own sizing progression. After a loss, add 100 shares to that asset's next entry. After a win, subtract 100 shares, with a 100-share floor. From the first loss in a recovery round, accumulate realized net P&L after entry fees. Once that round reaches at least +$40, reset that asset's next entry directly to 100 shares and begin a fresh recovery round. A zero stop counts as a loss; a $0.99 take-profit remains a win and credits a modeled $1 per share, not a sell order. Record the volume-weighted fill price and available quantity, including partial fills. Deduct entry taker fees using market metadata (BTC fallback rate 0.05; ETH fallback rate 0.01) and `shares * rate * price * (1-price)` per level. No sell fees or maker rebates are credited. This remains simulated, not real execution.
5. If a filled position's best bid reaches $0.99, close it at a modeled $1.00 payout per share. If the best bid reaches $0.00 or the bid book is empty, record a zero-payout loss without submitting a sell or applying a sell fee. If neither exit hits by the market's end, hold the position for its official resolution.
6. Cancel any unfilled taker remainder immediately; no resting entries remain.

The paper ledger starts at $3,000. On Railway, `PAPER_LEDGER_PATH` points to a mounted persistent volume; positions, orders, events, equity history, and independent sizing/recovery state are saved atomically so they survive deployments and restarts. When moving the existing in-memory ledger to persistent storage, import the live `/api/state` snapshot once before removing the bootstrap value.

## Data and dashboard

Market metadata and official results come from Polymarket Gamma; live order-book updates come from one Polymarket CLOB WebSocket subscription covering active token IDs. There is no Binance price input or REST order-book fallback. If a market or feed is unavailable, the affected market waits for data while the other markets continue.

The mobile-first dashboard puts open positions and their live P&L first, followed by recovery progress and next size for each asset, account summary, the two active markets, recent paper orders, events, and an equity curve. Strategy rules and paper-only limitations are visible on the page.

## Run

```sh
npm test
npm start
```
