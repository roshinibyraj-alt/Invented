# Polymarket BTC 5-Minute Paper Bot

Demo-only Polymarket BTC five-minute UP/DOWN bot. Gamma supplies market metadata and token IDs; the public Polymarket CLOB supplies quotes, public trade prints for modeled paper fills, and the internal close classification.

## Strategy

- The shared demo bankroll is `$1,000`. UP and DOWN do not have separate bankrolls. At most one side can open in a window: the low rung posts both outcomes and the first fill (even partial) cancels the opposite order; the high rung places only one order on the first side whose fresh best bid reaches `$0.70`.
- **Low rung ($0.30):** on each window, post one post-only maker limit buy at exactly `$0.30` on UP and DOWN, for `10 × 1.4^low-rung consecutive losses` shares. A profitable low-rung close resets that rung's loss streak and activates the high rung in the next window. A low-rung loss keeps the low rung active and increases its next size by 1.4×; flat or unfilled windows do not change it. There is no low-rung stop loss.
- **High rung ($0.70):** it is activated by a low-rung win and pauses the low rung. When one fresh best bid reaches `$0.70`, immediately simulate one market-taker buy by sweeping that token's currently visible CLOB asks: 30 shares on the first attempt, or 100 shares for the one retry after a first loss. The actual average fill can be above `$0.70`; each ask level incurs its modeled taker fee and no maker rebate. Any quantity that cannot be filled from visible depth and shared cash is cancelled, not counted as a loss. A win returns to the low rung; the first loss arms the 100-share retry; a second loss returns to the low rung. The high rung has no 1.4× martingale.
- **Low-rung maker fill model:** the `$0.30` post-only entries receive 250ms modeled arrival latency. If a buy would cross the ask on arrival, the order waits instead of taking liquidity. Visible asks never create a low-rung entry fill. A resting entry fills only after a later public CLOB SELL print at or below `$0.30`, and its paper fill price is exactly `$0.30`. Queue ahead includes visible bids at the limit and better prices. Public prints and visible depth are still only a paper fill estimate, not proof of a live fill.
- **Exits:** a post-only paper take-profit sell rests at `$0.99` after 250ms and can fill on a later public BUY print at or above that price. Each TP share is credited as `$1.00` in this demo. The high rung alone has a stop: when a fresh best bid reaches `$0.30` or less, the remaining shares are paper-sold at the observed bid and charged the modeled Polymarket taker fee `shares × 0.07 × bid × (1-bid)`. No stop loss is used on the low rung.
- **Fees and rebates:** maker entry and TP fills have zero modeled fees. Each maker fill receives a paper rebate credit calculated at 20% of the Polymarket taker-fee-equivalent curve `shares × 0.07 × price × (1-price)`. This credit is included in demo cash, equity, and P&L. High-rung market entries and stop-loss exits pay modeled taker fees `shares × 0.07 × price × (1-price)` at each fill price. This rebate is a configurable simulation assumption, **not a promise or record of actual Polymarket rebate earnings**; actual maker rebate distributions may differ.
- At window close, unfilled entry and TP remainders are canceled. Remaining shares are paper-settled at `$1/$0` using the final three seconds of CLOB best bids: if exactly one side is above `$0.98`, it wins; otherwise the higher bid wins. If a final-three-second quote is unavailable, the latest in-window CLOB bid is used. A quote tie is broken by the fresher quote, then deterministically by UP if timestamps also tie or both quotes are missing. This is an internal CLOB price proxy, not official Polymarket settlement. An unfilled order or an expired window with no position is not a loss.

## Safety and limitations

`DemoTrader` reads public CLOB books only. The feed also listens for public `last_trade_price` events. The paper bot has no wallet, signer, authentication, or order-writing methods. `LIVE_TRADING=true` is rejected at startup. No private API credentials or live-order endpoints are used.

Low-rung fills use public trade prints, modeled latency, and an estimated visible queue; hidden liquidity, cancellations, actual order priority, and real execution latency are not known. High-rung entry sweeps the visible ask snapshot only; the demo cannot guarantee that depth remains executable after real network and venue latency. The high-rung stop uses the displayed best bid for its paper exit and does not sweep depth, so its simulated fill can be more favorable than a real market exit. Maker rebate credits are simulation-only and included in paper accounting; they are not a claim about actual Polymarket payouts.

The CLOB close rule is an internal paper classification, **not Polymarket's official settlement** and not a claim about the actual token payout. A three-second quote proxy can disagree with the venue's resolution, especially during stale data, a price gap, or a thin book; every trade records the observed bids and fallback source. The `$1,000` cash balance, rung mode, loss streaks, positions, and trade history are in memory and reset on restart. Neither modeled fills nor rebate credits are evidence of live execution or profitability.

## Run

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000`. The mobile-friendly dashboard shows UP and DOWN in separate columns, the active strategy rung and its trigger/retry, a shared global equity curve, post-only order states, fills, P&L, maker-rebate credits, and the CLOB close-price paper outcome.
