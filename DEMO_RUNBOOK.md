# Paper bot runbook

1. Verify both 5m and 15m cards show independent $10,000 bankrolls and live UP/DOWN quotes.
2. Each timeframe uses its own previous completed candle body (`abs(close-open)`) and current movement measured from that candle's close.
3. A red previous candle plus upward movement buys DOWN; a green previous candle plus downward movement buys UP.
4. At 25%, the bot attempts 200 shares; at 50%, it attempts another 100. Confirm the `entry` price in the position and event log.
5. Paper positions settle only when Polymarket's official outcome is available. All state resets if Railway restarts.
