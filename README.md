# Invented BTC every-5m paired 5m/15m paper bot

Invented runs a paper-only paired strategy across Polymarket BTC 5-minute and 15-minute UP/DOWN markets. It does not submit live orders or use wallet credentials.

## Strategy

- Consider each of the three 5-minute slots in every active 15-minute BTC market. Enter at most once per 5-minute slot.
- At each slot, compare the two complementary cross-timeframe pairings: UP in 5m with DOWN in 15m, or DOWN in 5m with UP in 15m. Choose whichever eligible pairing has the lower combined best ask; Binance beat prices do not select or gate entries.
- Both selected asks must be at least $0.20, and their sum must be strictly below $0.85.
- Buy 300 shares in the selected 5-minute market and add 300 shares to the selected 15-minute outcome on every qualifying slot. This can add up to 900 shares in a 15-minute market. Since the cheapest pairing is reselected for each new entry, a 15-minute market can accumulate both UP and DOWN shares if the chosen direction changes; already-filled positions are not sold or reversed.
- Polymarket CLOB WebSocket books are the only price input for entries. If the CLOB WebSocket or required fresh quotes are unavailable, pause entry; Binance is informational only and does not block trading.
- Paper buys sweep visible asks up to $0.99 per share and model taker fees. Both legs must have full visible ask depth and enough paper cash. There is no additional edge or minimum-payout filter after the ask-sum gate; sweep prices and fees can make actual cost higher than displayed best asks.
- Paper buys sweep visible asks up to $0.99 per share and model taker fees. Both legs must have full visible ask depth and enough paper cash. There is no additional edge or minimum-payout filter after the ask-sum gate; sweep prices and fees can make actual cost higher than the displayed best asks.
- A leg exits at take-profit when its best bid reaches $0.99; the paper ledger books $1.00 per share. If it does not hit before that leg's market ends, keep it pending for that market's official resolution. Since the 5m and 15m legs resolve at different times, this is not guaranteed arbitrage; both legs can lose.

The Binance feed connects to the public market-data WebSocket and records timestamped aggregate trades. The Polymarket CLOB WebSocket supplies the UP/DOWN books; the strategy does not use REST book polling as a fallback. Polymarket's API is still used to discover active market IDs and check official resolutions, not as an alternate price feed.

## Dashboard and runtime

The mobile-first dashboard puts paired trade history at the top, consolidates each 5m/15m market pair into one panel, and groups similar positions. It shows current positions, take-profit and resolution status, floating P&L, the selected pair, fees, equity, and win rate. Strategy and feed details are collapsed at the bottom. The ledger is held in process memory and resets when Railway restarts.

Run `npm test` for ask-only pair selection, the $0.20 per-ask floor, strict $0.85 ask-sum threshold, Binance-independent entry behavior, one entry per 5m slot, 300-share paired entries across all three slots, next-entry side reselection without position reversals, $0.99 entry sweeps and take-profit, depth and cash checks, duplicate-entry prevention, per-market resolution timing, paired settlement accounting, API routes, live floating P&L, and dashboard content.
