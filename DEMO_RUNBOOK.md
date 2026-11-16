# Paper order-flow bot runbook

1. The bot is paper-only and does not submit wallet or live trading orders.
2. It reads Binance BTCUSDT aggregate trades and Polymarket's CLOB books and public trade stream continuously.
3. On each one-second evaluation, it calculates five-second pressure scores. Both sources must agree, each must exceed its minimum, and the combined score must pass threshold for three consecutive checks.
4. Every new confirmed signal immediately submits a 100-share paper taker sweep through displayed ask levels from lowest to highest, up to $0.99/share. Orders use fill-and-kill behavior: any unfilled remainder is cancelled immediately.
5. The paper sweep respects the visible quantity at each ask level and models taker fees from the market fee schedule. If depth or cash is insufficient, the entry can be partial or unfilled. Entry buys do not earn maker rebates.
6. An opposite signal never sells the other side. Each current-window position is closed in the paper ledger when its fresh best bid reaches $0.99 (payout counted as $1/share) or falls to $0.01 or below (payout counted as $0/share).
7. Shares that hit neither threshold by window end move out of the current UP/DOWN boxes and wait for the official resolution of their original market.
8. The dashboard shows feed freshness, component and combined scores, confirmation count, independent current-window positions, pending-resolution positions, taker orders and fees, the global equity curve, completed-window win rate, and estimated take-profit rebates. Railway restarts reset the in-memory paper ledger.
