# Polymarket BTC 5-Minute Paper Bot

Demo-only Polymarket BTC five-minute UP/DOWN bot. Gamma supplies market metadata and token IDs; the public Polymarket CLOB supplies quotes, trade prints for modeled paper fills, and the paper close classification.

## Strategy

- Each five-minute window starts with one paper limit buy on UP and one on DOWN, both at `$0.30` for the same target number of shares. Orders are posted once the market is discovered and become eligible after 250ms modeled arrival latency. A limit buy can never fill above `$0.30`.
- If an ask is at or below `$0.30` when the order arrives, the marketable portion is simulated against visible ask depth at those actual prices and charged the per-level Polymarket taker fee `shares × 0.07 × price × (1-price)`. Otherwise the order rests and can fill only from an eligible public SELL print at or below `$0.30`; visible queue at the limit is estimated from the CLOB book. Passive fills carry no modeled entry fee. These are paper estimates, not confirmed venue fills.
- The first fill on either outcome—including a partial fill—locks that side for the window and cancels the opposite order. If both asks are marketable in the same fetched snapshot, a deterministic window-based UP/DOWN priority selects which is processed first. Remaining same-side order quantity may continue resting; any unfilled quantity is canceled at window close. A window with no fills is not counted as a loss.
- Only one outcome position can be opened per window. The shared loss streak applies to both sides: target shares are `10 × 1.4^consecutive_losses`, so after one loss the next target is 14 shares, then 19.6, and so on. A profitable finalized trade resets the next target to 10; a losing finalized trade increments the streak. A flat result or a window with no fills leaves the streak unchanged. The shared `$1,000` paper balance caps actual simulated fills.
- An open position receives a post-only paper take-profit sell at `$0.99`, after a modeled 250ms delay. A later public CLOB BUY print at or above the limit can fill up to the print size. By request, each modeled TP share credits `$1.00` to paper proceeds despite the `$0.99` trigger; no exit fee is modeled. Any rebate estimate is illustrative and excluded from cash/equity/P&L. There is no stop loss or forced sale before expiry.
- At window close, unfilled entry and TP remainders are canceled. Remaining shares are paper-settled at `$1/$0` using the final three seconds of CLOB best bids: if exactly one side is above `$0.98`, it wins; otherwise the higher bid wins. If a final-three-second quote is unavailable, the latest in-window CLOB bid is used. A quote tie is broken by the fresher quote, then deterministically by UP if timestamps also tie or both quotes are missing. This is an internal CLOB price proxy, not official Polymarket settlement.

## Safety and limitations

`DemoTrader` reads public CLOB books only. The feed also listens for public `last_trade_price` events. The paper bot has no wallet, signer, authentication, or order-writing methods. `LIVE_TRADING=true` is rejected at startup. No private API credentials or live-order endpoints are used.

Crossing-limit fills use REST ask-depth snapshots, while resting fills depend on public SELL print size and a visible queue estimate; neither can confirm a live fill or model hidden liquidity. TP exits are print-modeled and cannot account for true queue position. A limit that crosses is charged the paper taker fee; passive fills and TP exits have no modeled fees. The dashboard separately shows an **indicative maker-rebate estimate** for TP sales, calculated as `shares × 0.07 × price × (1-price) × 20%`. It is never added to cash, equity, or realized P&L. Polymarket's actual rebate is distributed daily pro rata by market from the rebate pool and has a $1 minimum payout, so the estimate is not a promise or record of earnings.

The CLOB close rule is an internal paper classification, **not Polymarket's official settlement** and not a claim about the actual token payout. A three-second quote proxy can disagree with the venue's resolution, especially during stale data, a price gap, or a thin book; every trade records the observed bids and fallback source. The `$1,000` cash balance, shared loss streak, positions, and trade history are in memory and reset on restart. The dashboard distinguishes cash from open-position value. Neither the estimated rebate nor paper fills are evidence of live execution or profitability.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000`. The mobile-friendly dashboard shows UP and DOWN in separate columns, a shared global equity curve, paired limit-order states, the first-fill side lock, shared loss streak and next share size, fills, P&L, and the CLOB close-price paper outcome.
