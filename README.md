# Invented BTC fixed-side 5m/15m paper bot

Invented runs a paper-only strategy across Polymarket BTC 5-minute and 15-minute UP/DOWN markets. It does not submit live orders or use wallet credentials.

## Strategy

- At every 5-minute market start, enter once: buy 300 DOWN shares in that 5-minute market and buy 300 UP shares in the active 15-minute market.
- Over the three 5-minute slots in a 15-minute market, the strategy can add up to 900 UP shares to that same 15-minute market. It does not change sides or sell early.
- There is no combined-ask condition and no individual ask floor. Prices do not choose the sides.
- Fresh Polymarket CLOB WebSocket asks are still required for the scheduled markets. If the feed or either required quote is missing or stale, wait for data.
- Paper buys sweep visible asks up to $0.99 per share and model taker fees. Both 300-share legs must have full visible ask depth and enough paper cash; if either leg cannot fill fully within the cap, neither leg is recorded as filled.
- A leg exits at take-profit when its best bid reaches $0.99; the paper ledger books $1.00 per share. If it does not hit before that leg's market ends, keep it pending for that market's official resolution. Since the 5m and 15m legs resolve at different times, this is not guaranteed arbitrage; both legs can lose.

The Binance feed connects to the public market-data WebSocket and records timestamped aggregate trades. The Polymarket CLOB WebSocket supplies the UP/DOWN books; the strategy does not use REST book polling as a fallback. Polymarket's API is still used to discover active market IDs and check official resolutions, not as an alternate price feed.

## Dashboard and runtime

The mobile-first dashboard puts paired trade history at the top, consolidates each 5m/15m entry into one panel, and groups similar positions. It shows current positions, take-profit and resolution status, floating P&L, fixed entry sides, fees, equity, and win rate. Strategy and feed details are collapsed at the bottom. The ledger is held in process memory and resets when Railway restarts.

Run `npm test` for fixed-side selection, combined-ask independence, one entry per 5m slot, 300-share entries across all three slots, $0.99 entry sweeps and take-profit, depth and cash checks, duplicate-entry prevention, per-market resolution timing, paired settlement accounting, API routes, live floating P&L, and dashboard content.
