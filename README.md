# Invented BTC every-5m paired 5m/15m paper bot

Invented runs a paper-only paired strategy across Polymarket BTC 5-minute and 15-minute UP/DOWN markets. It does not submit live orders or use wallet credentials.

## Strategy

- Attempt one paired entry in every 5-minute BTC market, using the active 15-minute market that contains that 5-minute window. The same 15-minute market may therefore be used in three consecutive pairs.
- Compare each market's BTC beat price at its start using the nearest Binance BTCUSDT aggregate-trade WebSocket tick within 2 seconds. If the 15-minute beat is higher beyond the current volatility band, buy UP in 5m and DOWN in 15m; if the 5-minute beat is higher beyond the band, reverse those legs. When the gap is within the band, choose the lower-cost of the two pairings.
- The equal-beat tolerance is the Binance BTC high-low price range over the prior 60 seconds, clamped between $2 and $100. Binance beat estimates are not the official Chainlink resolution price.
- Price inputs are WebSocket-only. If Binance is disconnected, the rolling volatility sample is stale, a market-start beat was not captured, or a required Polymarket book is stale/missing, pause entries instead of substituting another data source.
- Request 100 shares per leg. Enter once at each of three strictly-below combined ask-sum levels: $0.80, $0.70, and $0.60. If one price update crosses several unused levels, attempt each qualifying entry once. If asks remain at or above $0.80, monitor through the 5-minute window and skip it when the window ends.
- Paper buys sweep visible asks up to $0.99 per share and model taker fees. Both legs must have full visible ask depth and enough paper cash. There is no additional edge or minimum-payout filter after the ask-sum gate; sweep prices and fees can make actual cost higher than the displayed best asks.
- A leg exits at take-profit when its best bid reaches $0.99; the paper ledger books $1.00 per share. If it does not hit before that leg's market ends, keep it pending for that market's official resolution. Since the 5m and 15m legs resolve at different times, this is not guaranteed arbitrage; both legs can lose. Reusing a 15m market can accumulate up to 300 shares on that leg within one 15m window.

The Binance feed connects to the public market-data WebSocket and records timestamped aggregate trades. The Polymarket CLOB WebSocket supplies the UP/DOWN books; the strategy does not use REST book polling as a fallback. Polymarket's API is still used to discover active market IDs and check official resolutions, not as an alternate price feed.

## Dashboard and runtime

The mobile-first dashboard puts paired trade history at the top, consolidates each 5m/15m market pair into one panel, and groups similar positions. It shows current positions, take-profit and resolution status, floating P&L, the selected pair, entry tiers, fees, equity, and win rate. Strategy and feed details are collapsed at the bottom. The ledger is held in process memory and resets when Railway restarts.

Run `npm test` for Binance tick parsing and freshness, volatility-band sizing, WebSocket-only pause behavior, 5m/15m containment, direction selection, all three ask-sum entry tiers, $0.99 entry sweeps and take-profit, depth and cash checks, duplicate-entry prevention, per-market resolution timing, paired settlement accounting, API routes, live floating P&L, and dashboard content.
