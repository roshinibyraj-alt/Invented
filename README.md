# Invented BTC synchronized 5m/15m arbitrage paper bot

Invented now runs a paper-only paired strategy across Polymarket BTC 5-minute and 15-minute UP/DOWN markets. It does not submit live orders or use wallet credentials.

## Strategy

- Evaluate only when the 5-minute and 15-minute markets have the exact same official end time. This occurs on the last 5-minute interval inside each 15-minute window.
- Compare each market's BTC beat price at its start. If the 15-minute beat is higher, buy UP in 5m and DOWN in 15m; if the 5-minute beat is higher, reverse those legs. If the beats match, check both pairings and choose the first one below threshold.
- Enter one pair per shared end time when the paired best asks sum to less than $0.90. The default is 10 shares per leg.
- Model stronger opportunities as market-style fills; nearer-threshold opportunities use per-leg limit caps with at most 2% slippage. Both legs must have full visible ask depth. The paper pair is recorded only if both legs fill and the combined cost plus modeled taker fees is below the $10 minimum combined payout.
- Hold each leg until the official result for its own Polymarket market is available. Pair P&L combines both payouts and both entry costs.

The historical beat-price provider tries Chainlink Data Streams first. If that endpoint is unavailable, it uses a clearly labeled CoinGecko historical proxy. That proxy is not the official Chainlink resolution feed; proxy-based results are estimates, not guaranteed arbitrage or proof of the exact official strike. The dashboard shows which source was used.

## Dashboard and runtime

The dashboard shows synchronized market times and beat prices, all four CLOB books, the paired entry check, modeled fees, paper equity, paired win rate, and resolved pair history. The ledger is held in process memory and resets when Railway restarts.

Run `npm test` for beat-price source labeling, timestamp alignment, all three arbitrage cases, depth and fee checks, duplicate-entry prevention, paired settlement accounting, API routes, and dashboard content.
