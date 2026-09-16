"""
Dip-recovery trading engine for Polymarket's btc-updown-5m-* markets.

Strategy
--------
1. From window open (5s wait), watch both sides' mid prices.
2. Whichever side's mid first dips below DIP_THRESHOLD (0.30) is flagged;
   the deepest mid reached during the dip is tracked.
3. When the flagged side returns to ENTRY_RECOVERY (0.48), place a
   resting LIMIT buy order at ENTRY_LIMIT (0.48) for ENTRY_SHARES (500).
   The limit price guarantees no fill worse than 0.48.
4. Fill is confirmed by price walk-through: once the flagged side's ask
   trades at or below ENTRY_LIMIT, the order is booked at 0.48.
5. No stop loss.  TP at 0.99 redeems $1.00/share (fee-free).
6. Max one trade per window.  No martingale.
"""
import time
from typing import Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _midpoint(bid, ask):
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return ask if ask is not None else bid


class Engine:
    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.balance: float = config.STARTING_CAPITAL
        self.halted: bool = False

        self.window: Optional[WindowMarket] = None
        self.position: Optional[dict] = None
        self.order_pending: Optional[dict] = None   # {side, shares, limit, fired_ts}
        self.done_for_window: bool = False

        self.last_tick: Optional[float] = None
        self.dipped_side: Optional[Side] = None
        self.dip_min_price: float = 1.0

        # Book snapshot per tick
        self._up_bid = self._up_ask = None
        self._down_bid = self._down_ask = None
        self._up_bid_levels = self._up_ask_levels = None
        self._down_bid_levels = self._down_ask_levels = None

        # Lifetime stats
        self.total_entries: int = 0
        self.total_tp_hits: int = 0
        self.total_wins: int = 0
        self.total_losses: int = 0
        self.last_window_pnl: float = 0.0
        self.total_pnl: float = 0.0
        self.equity_curve: list = []

    # ---- logging ----------------------------------------------------------

    def _log(self, event: str, **kw):
        self.broker.log_event(
            "BOT", self.window.slug if self.window else "",
            event, balance_after=round(self.balance, 2), **kw,
        )

    # ---- window lifecycle --------------------------------------------------

    def reset_for_window(self, window: WindowMarket):
        if self.halted:
            return
        self.window = window
        self.position = None
        self.order_pending = None
        self.done_for_window = False
        self.last_tick = window.open_ts
        self.dipped_side = None
        self.dip_min_price = 1.0
        self._log("WINDOW_OPEN", note=(
            f"window open -- waiting {config.WAIT_AFTER_OPEN_SECONDS}s, then watching "
            f"dip below {config.DIP_THRESHOLD:.2f} → recover to {config.ENTRY_RECOVERY:.2f} "
            f"→ limit buy {config.ENTRY_SHARES:.0f}sh @ {config.ENTRY_LIMIT:.2f}. "
            f"No SL. TP {config.TP_PRICE:.2f}. balance ${self.balance:.2f}"
        ))

    # ---- dip monitor (no pending order yet) --------------------------------

    def _tick_dip_monitor(self, up_mid, down_mid, now):
        # 1) Flag whichever side first dips below DIP_THRESHOLD
        if self.dipped_side is None:
            if up_mid is not None and up_mid < config.DIP_THRESHOLD:
                self.dipped_side = Side.UP
                self.dip_min_price = up_mid
                self._log("SIDE_DIPPED", side="UP", price=round(up_mid, 4), note=(
                    f"UP dipped below {config.DIP_THRESHOLD:.2f} (mid={up_mid:.4f}) -- "
                    f"waiting for return to {config.ENTRY_RECOVERY:.2f} to place limit order"))
            elif down_mid is not None and down_mid < config.DIP_THRESHOLD:
                self.dipped_side = Side.DOWN
                self.dip_min_price = down_mid
                self._log("SIDE_DIPPED", side="DOWN", price=round(down_mid, 4), note=(
                    f"DOWN dipped below {config.DIP_THRESHOLD:.2f} (mid={down_mid:.4f}) -- "
                    f"waiting for return to {config.ENTRY_RECOVERY:.2f} to place limit order"))
            return

        # 2) Track deepest dip
        mid = up_mid if self.dipped_side == Side.UP else down_mid
        if mid is not None and mid < self.dip_min_price:
            self.dip_min_price = mid

        # 3) When mid returns to ENTRY_RECOVERY, place the limit order
        if mid is not None and mid >= config.ENTRY_RECOVERY:
            self._place_limit(now, mid)

    # ---- limit order placement + fill confirmation -------------------------

    def _place_limit(self, now, mid):
        side = self.dipped_side
        self.order_pending = {
            "side": side,
            "shares": config.ENTRY_SHARES,
            "limit": config.ENTRY_LIMIT,
            "fired_ts": now,
        }
        self._log("LIMIT_ORDER_PLACED", side=side.value,
                  price=config.ENTRY_LIMIT, shares=config.ENTRY_SHARES, note=(
            f"{side.value} mid returned to {mid:.4f} (>= {config.ENTRY_RECOVERY:.2f}) -- "
            f"placed resting limit buy {config.ENTRY_SHARES:.0f}sh @ {config.ENTRY_LIMIT:.2f}"))

    def _tick_pending_order(self, up_bid, up_ask, down_bid, down_ask, now):
        side = self.order_pending["side"]
        ask = up_ask if side == Side.UP else down_ask
        limit = self.order_pending["limit"]
        shares = self.order_pending["shares"]

        if ask is not None and ask <= limit:
            # Price walked through limit — fill at exactly limit price
            fill = limit
            fee = self.broker.taker_fee_amount(shares, fill)
            cost = shares * fill + fee
            self.balance -= cost
            if self.balance < 0:
                self.halted = True
            self.position = {"side": side, "shares": shares,
                             "entry_price": fill, "entry_fee": fee,
                             "cost": cost, "entry_ts": now}
            self.total_entries += 1
            self._log("ENTRY_FILL", side=side.value, price=round(fill, 4),
                      shares=shares, fee=round(fee, 4), note=(
                f"limit buy {side.value} @ {fill:.2f} confirmed "
                f"(ask walked through to {ask:.4f}) -> {shares:.0f}sh, "
                f"fee ${fee:.4f}. No SL, TP {config.TP_PRICE:.2f}."))
            self.order_pending = None

    # ---- position management -----------------------------------------------

    def _tick_position(self, up_bid, up_ask, up_bid_levels,
                       down_bid, down_ask, down_bid_levels, down_ask_levels, now):
        pos = self.position
        side = pos["side"]
        mark = _midpoint(up_bid, up_ask) if side == Side.UP else _midpoint(down_bid, down_ask)
        if mark is None:
            return

        # TP check
        if mark >= config.TP_PRICE:
            proceeds = pos["shares"] * 1.0
            pnl = proceeds - pos["cost"]
            self.balance += proceeds
            self.total_tp_hits += 1
            self.total_wins += 1
            self.last_window_pnl = pnl
            self.total_pnl += pnl
            self.done_for_window = True
            self._record_equity()
            self._log("TP_HIT", side=side.value, price=1.0, shares=pos["shares"],
                      pnl=round(pnl, 2), note=(
                f"TP {config.TP_PRICE:.2f}: redeemed {pos['shares']:.0f}sh at $1.00/share, "
                f"fee-free. PnL ${pnl:.2f}"))
            self.position = None

    # ---- window close settlement -------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.halted or self.window is None:
            return

        # Cancel unfilled limit order
        if self.order_pending is not None:
            self._log("ORDER_EXPIRED",
                      side=self.order_pending["side"].value,
                      shares=self.order_pending["shares"], note=(
                f"limit @ {self.order_pending['limit']:.2f} never walked through -- cancelled"))
            self.order_pending = None
            self.done_for_window = True
            self._record_equity()
            return

        if self.position is not None and not self.done_for_window:
            pos = self.position
            if winning_side is not None and winning_side == pos["side"]:
                proceeds = pos["shares"] * 1.0
                pnl = proceeds - pos["cost"]
                self.balance += proceeds
                self.total_wins += 1
                self.last_window_pnl = pnl
                self.total_pnl += pnl
                self._log("RESOLUTION_WIN", side=pos["side"].value, price=1.0,
                          shares=pos["shares"], pnl=round(pnl, 2), note=(
                    f"window won by {winning_side.value} -- "
                    f"{pos['shares']:.0f}sh redeemed at $1.00. PnL ${pnl:.2f}"))
            else:
                pnl = -pos["cost"]
                self.total_losses += 1
                self.last_window_pnl = pnl
                self.total_pnl += pnl
                self._log("RESOLUTION_LOSS", side=pos["side"].value, price=0.0,
                          shares=pos["shares"], pnl=round(pnl, 2), note=(
                    f"window won by {winning_side.value if winning_side else 'unknown'} -- "
                    f"{pos['side'].value} expires worthless. PnL ${pnl:.2f}"))
            self.position = None
            self._record_equity()
            return

        if self.position is None and not self.done_for_window:
            self._log("NO_TRADE", note="neither side met dip+recovery criteria this window")
        self._record_equity()

    # ---- helpers -----------------------------------------------------------

    def _ask_for(self, side):  return self._up_ask if side == Side.UP else self._down_ask
    def _bid_for(self, side):  return self._up_bid if side == Side.UP else self._down_bid
    def _mid_for(self, side):  return _midpoint(self._bid_for(side), self._ask_for(side))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close=None, now=None,
                up_bid_levels=None, up_ask_levels=None,
                down_bid_levels=None, down_ask_levels=None):
        if self.window is None or self.halted or self.done_for_window:
            return
        now = now if now is not None else time.time()
        # ignore ticks before the post-open waiting period
        if now < self.window.open_ts + config.WAIT_AFTER_OPEN_SECONDS:
            self._up_bid, self._up_ask = up_bid, up_ask
            self._down_bid, self._down_ask = down_bid, down_ask
            return
        # store book data for helper lookups
        self._up_bid, self._up_ask = up_bid, up_ask
        self._down_bid, self._down_ask = down_bid, down_ask
        self._up_bid_levels, self._up_ask_levels = up_bid_levels, up_ask_levels
        self._down_bid_levels, self._down_ask_levels = down_bid_levels, down_ask_levels

        up_mid = _midpoint(up_bid, up_ask)
        down_mid = _midpoint(down_bid, down_ask)

        if self.position is not None:
            self._tick_position(up_bid, up_ask, up_bid_levels,
                                down_bid, down_ask, down_bid_levels, down_ask_levels, now)
        elif self.order_pending is not None:
            self._tick_pending_order(up_bid, up_ask, down_bid, down_ask, now)
        else:
            self._tick_dip_monitor(up_mid, down_mid, now)

    @staticmethod
    def _realistic_fill_price(levels, shares, fallback_price):
        if levels is None:
            return fallback_price
        if not levels:
            return None
        remaining = shares; cost = 0.0; worst = levels[-1][0]
        for px, sz in levels:
            if remaining <= 1e-9: break
            take = min(remaining, sz) if sz and sz > 0 else 0.0
            if take <= 0: continue
            cost += take * px; remaining -= take
        if remaining > 1e-9:
            cost += remaining * worst
        return cost / shares

    def _record_equity(self):
        self.equity_curve.append({"window": self.window.slug if self.window else "",
                                  "ts": time.time(), "balance": round(self.balance, 2)})
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    # ---- dashboard snapshot -------------------------------------------------

    def snapshot(self):
        pos = self.position
        position = None
        if pos is not None:
            mark = self._mid_for(pos["side"]) or pos["entry_price"]
            position = {"side": pos["side"].value, "shares": pos["shares"],
                        "entry_price": round(pos["entry_price"], 4), "entry_fee": round(pos["entry_fee"], 4),
                        "cost": round(pos["cost"], 4), "mark": round(mark, 4),
                        "unrealized_pnl": round(pos["shares"] * mark - pos["cost"], 2)}

        if self.halted:
            status = "halted"
        elif position is not None:
            status = "in_position"
        elif self.order_pending is not None:
            status = "order_pending"
        elif self.dipped_side is not None:
            status = "waiting_recovery"
        else:
            status = "monitoring_dip"

        return {
            "status": status,
            "balance": round(self.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.halted,
            "position": position,
            "unrealized_pnl": position["unrealized_pnl"] if position else 0.0,
            "dipped_side": self.dipped_side.value if self.dipped_side else None,
            "dip_min_price": round(self.dip_min_price, 4) if self.dipped_side else None,
            "entry_shares": config.ENTRY_SHARES,
            "entry_limit": config.ENTRY_LIMIT,
            "order_pending": self.order_pending["side"].value if self.order_pending else None,

            "total_entries": self.total_entries,
            "total_tp_hits": self.total_tp_hits,
            "total_wins": self.total_wins,
            "total_losses": self.total_losses,
            "last_window_pnl": round(self.last_window_pnl, 2),
            "total_pnl": round(self.total_pnl, 2),
            "win_rate": round(100 * self.total_wins / (self.total_wins + self.total_losses), 1)
            if (self.total_wins + self.total_losses) else None,
            "equity_curve": self.equity_curve,
            "def": {
                "dip_threshold": config.DIP_THRESHOLD,
                "entry_recovery": config.ENTRY_RECOVERY,
                "entry_limit": config.ENTRY_LIMIT,
                "entry_shares": config.ENTRY_SHARES,
                "tp_price": config.TP_PRICE,
            },
        }
