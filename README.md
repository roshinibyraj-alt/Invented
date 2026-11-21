# Invented BTC every-5m paired 5m/15m paper bot

Invented runs a paper-only paired strategy across Polymarket BTC 5-minute and 15-minute UP/DOWN markets. It does not submit live orders or use wallet credentials.

## Strategy

- Attempt one paired entry in every 5-minute BTC market, using the active 15-minute market that contains that 5-minute window. The same 15-minute market may therefore be used in three consecutive pairs.
- Compare each market's BTC beat price at its start. The preferred beat is the nearest Binance BTCUSDT aggregate-trade tick within 2 seconds of the market start; Chainlink Data Streams and timestamped CoinGecko history are fallback sources. If the 15-minute beat is higher beyond the current volatility band, buy UP in 5m and DOWN in 15m; if the 5-minute beat is higher beyond the band, reverse those legs. When the gap is within the band, choose the lower-cost of the two pairings.
- The equal-beat tolerance is the Binance BTC high-low price range over the prior 60 seconds, clamped between $2 and $100. Binance beat estimates are not the official Chainlink resolution price.
- If either market-start beat or the fresh volatility band is unavailable, use the pairing with the lower current ask sum instead of skipping solely for missing signal references.
- Request 100 shares per leg. A combined best-ask sum below $0.50 is the target, not a hard gate: if the target is missed, the selected pair is still entered.
- Paper buys sweep visible asks up to $0.99 per share and model taker fees. Both legs must have full visible depth and enough paper cash. There is no edge or minimum-payout filter; the combined cost may exceed the payout on one winning leg.
- Hold each leg until the official result for its own Polymarket market is available. Since the 5m and 15m legs resolve at different times, this is not guaranteed arbitrage; both legs can lose. Reusing a 15m market can accumulate up to 300 shares on that leg within one 15m window.

The Binance feed connects to the public market-data WebSocket and records timestamped aggregate trades. For starts missed during a reconnect or service restart, the fallback provider tries Chainlink Data Streams and then timestamped CoinGecko history. It does not substitute a current spot quote for a missing historical start price.

## Dashboard and runtime

The dashboard shows the active 5m/15m markets and their beat prices, the live Binance feed and rolling volatility band, all four CLOB books, the chosen pair, the $0.50 target/override state, modeled fees, paper equity, paired win rate, and resolved pair history. The ledger is held in process memory and resets when Railway restarts.

Run `npm test` for Binance tick parsing and freshness, volatility-band sizing, beat-price source labeling, 5m/15m containment, direction selection, forced entries above the ask-sum target, $0.99 book sweeps, depth and cash checks, duplicate-entry prevention, paired settlement accounting, API routes, and dashboard content.
