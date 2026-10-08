# Polymarket BTC 5-Minute Paper Bot

Demo-only Polymarket BTC five-minute UP/DOWN bot. Gamma supplies market metadata and token IDs; the public Polymarket CLOB supplies quotes, trade prints for modeled paper fills, and the paper close classification.

## Strategy

- UP and DOWN are independent: each side has its own paper order, position, and consecutive-loss counter. Both use one shared $1,000 demo cash pool.
- When the current market is available, reserve one post-only paper limit buy on each side at $0.45. Each starts at 10 shares. It is considered resting only while the best ask is above $0.45; a later public CLOB SELL trade print at or below the limit can fill up to the print size. Every simulated entry share is booked at exactly $0.45, never at a lower price. Unfilled size remains reserved through the window.
- After a side's finalized losing trade, only that side's next order grows by 1.8×: `10 × 1.8^consecutive_losses` shares. A finalized win resets only that side to 10 shares. A pending or unfilled order is not a loss. If the shared cash pool cannot reserve the full order, that side is skipped; the target is not silently reduced.
- Each open position gets a post-only paper take-profit sell at $0.99. It rests only when the best bid is below $0.99; a later public CLOB BUY trade print at or above the limit can fill up to the print size. Every simulated exit share is booked at exactly $0.99. Maker fees charged in the paper ledger are $0; there is no stop loss and no forced sale before expiry.
- At window close, any unfilled limit remainder is cancelled. Remaining shares are paper-settled at $1/$0 using the final three seconds of CLOB best bids: if exactly one side is above $0.98, it wins; otherwise the higher bid wins. If a final-three-second quote is unavailable, the latest in-window CLOB bid is used. A quote tie is broken by the fresher quote, then deterministically by UP if timestamps also tie or both quotes are missing. There is no pending-resolution state, so closed positions cannot hold the bot idle. Martingale results include earlier TP fills.

## Safety and limitations

`DemoTrader` reads public CLOB books only. The feed also listens for public `last_trade_price` events. The paper bot has no wallet, signer, authentication, or order-writing methods. `LIVE_TRADING=true` is rejected at startup. No private API credentials or live-order endpoints are used.

Public trade prints do not reveal the hypothetical order's queue position or prove that it would have been filled. The model waits 250 ms after a fresh non-crossing quote before treating an order as resting, but does not know actual network/venue acceptance or queue priority. A print-triggered fill is only a paper assumption, not a live execution. No fees are charged to paper cash or P&L. The dashboard shows an **indicative maker-rebate estimate** separately, calculated as `shares × 0.07 × price × (1-price) × 20%`; it is never added to cash, equity, or realized P&L. Polymarket's actual rebate is distributed daily pro rata by market from the rebate pool and has a $1 minimum payout, so the estimate is not a promise or record of earnings.

The CLOB close rule is an internal paper classification, **not Polymarket's official settlement** and not a claim about the actual token payout. A three-second quote proxy can disagree with the venue's resolution, especially during stale data, a price gap, or a thin book; every trade records the observed bids and fallback source. The $1,000 cash balance, side loss streaks, positions, and trade history are in memory and reset on restart. The dashboard distinguishes cash, post-only order reserves, and available cash. Neither the estimated rebate nor paper fills are evidence of live execution or profitability.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000`. The mobile-friendly dashboard shows UP and DOWN in separate columns, a shared global equity curve, independent order states and loss streaks, fills, P&L, and the CLOB close-price paper outcome.
