# Polymarket BTC 5-Minute Independent Paper Strategies

Polymarket BTC 5-minute paper trading with two independent strategies. Each strategy has its own $10,000 demo account ($20,000 total demo capital). The bot sends no live orders and holds no wallet credentials.

## Strategy A: 4-minute two-rung limit strategy

- From 4:00 until the 5-minute window ends, the bot checks every 500ms for either side's fresh best ask to be strictly above $0.32 and below $0.70.
- The first qualifying tick latches the trigger and places four resting limit buys: 300 UP and 300 DOWN at $0.20, plus 300 UP and 300 DOWN at $0.10. The trigger stays active if that side's price later leaves the band.
- A limit buy fills only against visible ask size at or below its limit, and is recorded at its fixed limit price. Actual partial fills are booked as the actual number of shares and the unfilled remainder is canceled.
- Each fill immediately gets a resting limit sell: the $0.20 rung targets $0.80 and the $0.10 rung targets $0.90.
- When a take-profit fills, the other side's remaining TP orders move to $0.99. A $0.99 fill records proceeds as $1 per share; rung TPs at $0.80 or $0.90 record their stated price.
- Any position without a TP fill by the market window's end waits for that market's official Polymarket resolution.
- Maker limit buys and sells have no taker fee; estimated maker rebates are displayed but not credited to cash. Resolution payouts have no fee.
- The dashboard shows accumulated UP and DOWN shares and fee-inclusive average cost for the active 5-minute window. It does not show order activity.

## Strategy B: one-minute candle pre-buy

- This strategy runs in a separate bot instance with its own $10,000 demo balance, positions, win rate, and equity curve.
- It begins scanning for the upcoming BTC 5-minute market during the final 10 seconds before open.
- Three seconds before open, it compares the live BTC price with the close of the previous completed one-minute candle. This is the final 57-second segment, from roughly second 241 to second 297 of the ending window. A higher price is green/UP; an equal or lower price is red/DOWN.
- Two seconds before open, it attempts one market buy of 500 shares on the signaled side, only if that side's order book is fresh. It skips rather than entering late.
- Immediately after the window opens, it creates a $0.99 limit take-profit for shares filled on that side; the payout is counted as $1 per share.
- Strategy 2 has no stop loss. Shares without a take-profit fill by window end wait for official market resolution.
- Market buys sweep visible ask depth and incur taker fees. Limit sells have no taker fee; the estimated maker rebate is displayed but is not added to demo cash.
- Shares still open at window end wait for the original market's official Polymarket resolution.

The dashboard displays two distinct account panels with separate balances, performance, and equity curves. Combined totals are shown separately and do not feed back into either strategy's account.

The dashboard refreshes every 2 seconds. Paper state is kept in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
