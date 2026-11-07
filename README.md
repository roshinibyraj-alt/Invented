# Polymarket BTC 5-Minute Signal Paper Bot

A single BTC 5-minute paper strategy with a $10,000 demo account. It sends no live orders and stores no wallet credentials.

## Signal and entry

- During the final 10 seconds before a window opens, scan the upcoming market and candle feed.
- At T−3 seconds, compare live BTC with the previous completed one-minute candle close. This uses the final 57 seconds of the ending window: higher means UP; equal or lower means DOWN.
- At the first bot poll at or just after window open (500ms polling), place one $0.45 limit buy for 500 shares on the signalled side.
- If fresh ask depth is available at or below $0.45, book the actual better ask price. The paper model charges no taker fee and credits an estimated maker rebate.
- If shares remain unfilled one second after order placement, paper-fill the remainder at $0.45 and credit the estimated maker rebate. This is a simulation rule, not a guaranteed real-market fill.
- The buy order expires at the market window's end.

## Exit and account

- Once any shares fill, place a $0.99 resting limit sell for the filled quantity. A filled sell pays $1 per share in the paper ledger.
- There is no stop loss.
- Shares without a TP fill by window end wait for the original market's official resolution.
- The dashboard shows the single account's cash, equity, win rate, equity curve, open positions, UP/DOWN inventory, limit-order status, fees, and estimated maker rebate.
- Paper account history is held in process memory and resets on restart or redeployment.

## Run and verify

```sh
npm test
npm start
```

Dashboard: `/` · State: `/api/state` · Health: `/api/healthz`.
