# Polymarket BTC Correlation Combo Bot

Autonomous 5-minute paper bot built on live Polymarket CLOB order-book WebSockets.

## Strategy
- BTC is the only anchor asset.
- Six independent BTC-anchor combinations are monitored:
  - BTC UP + ETH DOWN
  - BTC UP + SOL DOWN
  - BTC UP + XRP DOWN
  - BTC DOWN + ETH UP
  - BTC DOWN + SOL UP
  - BTC DOWN + XRP UP
- No altcoin-to-altcoin combination is allowed.
- When a combo's combined CLOB midpoint is below `0.75`, buy `100 shares` of each leg at executable CLOB ask prices.
- All six combinations can run concurrently; multiple combos may share a BTC side.
- There is no intra-window take-profit or stop-loss.
- Every combo holds to resolution.
- During the final two seconds each market's highest UP/DOWN midpoints are sampled. If one side exceeds `0.90`, that side is declared the winner and combo P&L settles immediately.
- Winning legs pay shares × $1; losing legs pay zero.

## Risk / Dashboard
Default demo bankroll is `$20,000`. The dashboard shows every live bid, ask, midpoint, spread and short-window delta for BTC, ETH, SOL and XRP, plus open combo marks, floating P&L, execution legs, resolved results, global equity curve and server logs. Prices come only from the CLOB WebSocket stream; if CLOB fails, trading stops.
