# Invented BTC synchronized 5m/15m arbitrage paper bot

Invented now runs a paper-only paired strategy across Polymarket BTC 5-minute and 15-minute UP/DOWN markets. It does not submit live orders or use wallet credentials.

## Strategy

- Evaluate only when the 5-minute and 15-minute markets have the exact same official end time. This occurs on the last 5-minute interval inside each 15-minute window.
- Compare each market's BTC beat price at its start. The preferred beat is the nearest Binance BTCUSDT aggregate-trade tick within 2 seconds of the market start; Chainlink Data Streams and timestamped CoinGecko history are fallback sources. If the 15-minute beat is higher beyond the current tolerance, buy UP in 5m and DOWN in 15m; if the 5-minute beat is higher beyond tolerance, reverse those legs. When the beat gap is within tolerance, check both pairings.
- The equal-beat tolerance is the Binance BTC high-low price range over the prior 60 seconds, clamped between $2 and $100. The bot waits for fresh Binance ticks rather than using a stale or current-spot quote as a market-start price. Binance beat estimates are not the official Chainlink resolution price.
- Enter one pair per shared end time when the paired best asks sum to less than $0.90. The default is 10 shares per leg.
- Model stronger opportunities as market-style fills; nearer-threshold opportunities use per-leg limit caps with at most 2% slippage. Both legs must have full visible ask depth. The paper pair is recorded only if both legs fill and the combined cost plus modeled taker fees is below the $10 minimum combined payout.
- Hold each leg until the official result for its own Polymarket market is available. Pair P&L combines both payouts and both entry costs.

The Binance feed connects to the public market-data WebSocket and records timestamped aggregate trades. For starts missed during a reconnect or service restart, the fallback provider tries Chainlink Data Streams and then timestamped CoinGecko history. It does not substitute a current spot quote for a missing historical start price.

## Dashboard and runtime

The dashboard shows synchronized market times and beat prices with their sources, the live Binance feed and rolling volatility band, all four CLOB books, the paired entry check, modeled fees, paper equity, paired win rate, and resolved pair history. The ledger is held in process memory and resets when Railway restarts.

Run `npm test` for Binance tick parsing and freshness, volatility-band sizing, beat-price source labeling, timestamp alignment, all three arbitrage cases, depth and fee checks, duplicate-entry prevention, paired settlement accounting, API routes, and dashboard content.
