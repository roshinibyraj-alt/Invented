# Polymarket BTC 5-Minute Paper Bot

Demo-only Polymarket BTC five-minute UP/DOWN bot. Gamma supplies market metadata and token IDs; the public Polymarket CLOB supplies quotes, trade prints for modeled paper fills, and the paper close classification.

## Strategy

- UP and DOWN are independent: each side has its own paper order, position, and consecutive-loss counter. Both use one shared $1,000 demo cash pool.
- Three seconds after each five-minute window opens, submit one independent simulated market buy for each side. The $0.45 value is only a reference point, not a floor or cap; the bot accepts the current ask at any price and sweeps public CLOB ask levels until it buys the side's target shares, runs out of visible depth, or reaches the shared cash limit. Fills are depth-weighted at the actual displayed ask levels. A market order can still be partial or unfilled, and any unfilled remainder is cancelled rather than left resting.
- After a side's finalized losing trade, only that side's next order grows by 1.8×: `10 × 1.8^consecutive_losses` shares. A finalized win resets only that side to 10 shares. A pending or unfilled order is not a loss. If visible depth or shared cash is insufficient for the full size, the order records the available partial fill and cancels its remainder.
- Market-entry taker fees are modeled per ask level as `shares × 0.07 × price × (1-price)` and deducted from cash and P&L. Ask depth can change before a real order arrives, so displayed-book paper fills are not confirmation of a live fill.
- Each open position gets a post-only paper take-profit sell at $0.99. It rests only when the best bid is below $0.99, after a modeled 250ms delay; a later public CLOB BUY trade print at or above the limit can fill up to the print size. TP shares are booked exactly at $0.99 with zero modeled maker fee; any rebate estimate is illustrative, separately displayed, and excluded from cash/equity/P&L. There is no stop loss or forced sale before expiry.
- At window close, any unfilled TP remainder is cancelled. Remaining shares are paper-settled at $1/$0 using the final three seconds of CLOB best bids: if exactly one side is above $0.98, it wins; otherwise the higher bid wins. If a final-three-second quote is unavailable, the latest in-window CLOB bid is used. A quote tie is broken by the fresher quote, then deterministically by UP if timestamps also tie or both quotes are missing. There is no pending-resolution state, so closed positions cannot hold the bot idle. Martingale results include earlier TP fills.

## Safety and limitations

`DemoTrader` reads public CLOB books only. The feed also listens for public `last_trade_price` events. The paper bot has no wallet, signer, authentication, or order-writing methods. `LIVE_TRADING=true` is rejected at startup. No private API credentials or live-order endpoints are used.

Market entries use a REST order-book snapshot fetched after the 3-second delay and sweep the visible asks without a price cap. The snapshot cannot guarantee that those shares will still be available by the time any real order reaches Polymarket; this demo does not send orders. TP exits remain print-modeled makers and cannot account for queue position. Taker fees are charged on paper market entries; the dashboard separately shows an **indicative maker-rebate estimate** for TP sales, calculated as `shares × 0.07 × price × (1-price) × 20%`. It is never added to cash, equity, or realized P&L. Polymarket's actual rebate is distributed daily pro rata by market from the rebate pool and has a $1 minimum payout, so the estimate is not a promise or record of earnings.

The CLOB close rule is an internal paper classification, **not Polymarket's official settlement** and not a claim about the actual token payout. A three-second quote proxy can disagree with the venue's resolution, especially during stale data, a price gap, or a thin book; every trade records the observed bids and fallback source. The $1,000 cash balance, side loss streaks, positions, and trade history are in memory and reset on restart. The dashboard distinguishes cash from open-position value; there is no cash reservation for instant market orders. Neither the estimated rebate nor paper fills are evidence of live execution or profitability.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000`. The mobile-friendly dashboard shows UP and DOWN in separate columns, a shared global equity curve, independent order states and loss streaks, fills, P&L, and the CLOB close-price paper outcome.
