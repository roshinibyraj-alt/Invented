# Polymarket BTC Correlation Combo Bot

Autonomous 5-minute correlation-combo paper bot priced by direct Polymarket CLOB order-book snapshots.

## Strategy
- BTC is the only anchor asset.
- Two independent BTC-anchor combinations are monitored:
  - BTC UP + ETH DOWN
  - BTC DOWN + ETH UP
- No altcoin-to-altcoin combination is allowed.
- When a combo's combined CLOB midpoint is below `0.75`, buy `100 shares` of each leg at executable CLOB ask prices.
- Both combinations can run concurrently; multiple combos may share a BTC side.
- There is no intra-window take-profit or stop-loss.
- Every combo holds to resolution.
- During the final two seconds each market's highest UP/DOWN midpoints are sampled. If one side exceeds `0.90`, that side is declared the winner and combo P&L settles immediately.
- Winning legs pay shares × $1; losing legs pay zero.

## Risk / Dashboard
Default demo bankroll is `$20,000`. The dashboard shows every live bid, ask, midpoint, spread and short-window delta for BTC and ETH, plus open combo marks, floating P&L, execution legs, resolved results, global equity curve and server logs. Base size is 5 shares per leg. A filled BTC/ETH opposite-side decorrelation boosts every combo to 100 shares per leg for the next three consecutive windows. Prices come only from batched CLOB `/books` snapshots every 500 ms; if CLOB fails, trading stops.
