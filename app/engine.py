"""
Dip-recovery trading engine for Polymarket's btc-updown-5m-* markets.

Strategy
--------
1. From window open, monitor both sides' mid prices every tick.
2. Track how long each side stays *consecutively* below DIP_THRESHOLD
   (0.40). If the price bounces back above DIP_THRESHOLD, the timer
   resets to zero.
3. Once either side's consecutive-below time exceeds DIP_MIN_SECONDS
   (10s), that side is flagged as "dipped".
4. After flagging, wait for the dipped side's mid to recover to
   ENTRY_RECOVERY (0.50).  The instant mid >= 0.50, buy ORDER_SHARES
   (500) at the current ask as a taker (immediate fill, no limit wait).
5. Manage the position: SL at 0.10 (taker sell at bid depth, taker fee)
   or TP at 0.99 (redeem $1.00/share, fee-free).  If neither is hit
   before the window closes, settle by the inferred CLOB winner.
6. Max one trade per window.  No re-entry after SL or TP.
"""
import time
from typing import Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _midpoint(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return ask if ask is not None else bid


class Engine:
    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.balance: float = config.STARTING_CAPITAL
        self.halted: bool = False

        # Per-window state (reset on each new window)
        self.window: Optional[WindowMarket] = None
        self.position: Optional[dict] = None     # {side, shares, entry_price, entry_fee, cost, entry_ts}
        self.done_for_window: bool = False

        # Dip timer: consecutive seconds each side has been below DIP_THRESHOLD
        self.below_timer_up: float = 0.0
        self.below_timer_down: float = 0.0
        self.last_tick: Optional[float] = None

        # Flag
        self.dipped_side: Optional[Side] = None
        self.dipped_logged: bool = False

        # Lifetime stats
        self.total_entries: int = 0
        self.total_tp_hits: int = 0
        self.total_sl_hits: int = 0
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
        self.done_for_window = False
        self.below_timer_up = 0.0
        self.below_timer_down = 0.0
        self.last_tick = window.open_ts
        self.dipped_side = None
        self.dipped_logged = False
        self._log("WINDOW_OPEN", shares=config.ORDER_SHARES, note=(
            f"watching both sides -- whichever dips below {config.DIP_THRESHOLD:.2f} for "
            f">{config.DIP_MIN_SECONDS:.0f}s straight, then recovers to {config.ENTRY_RECOVERY:.2f} "
            f"-> buy {config.ORDER_SHARES:.0f}sh taker. SL {config.SL_PRICE:.2f} / TP {config.TP_PRICE:.2f}. "
            f"balance ${self.balance:.2f}"
        ))

    # ---- dip timer + entry -------------------------------------------------

    def _tick_dip_monitor(self, up_mid, down_mid, now):
        dt = now - self.last_tick if self.last_tick is not None else 0.0
        self.last_tick = now

        # Update consecutive-below timers
        if up_mid is not None:
            if up_mid < config.DIP_THRESHOLD:
                self.below_timer_up += dt
            else:
                self.below_timer_up = 0.0

        if down_mid is not None:
            if down_mid < config.DIP_THRESHOLD:
                self.below_timer_down += dt
            else:
                self.below_timer_down = 0.0

        # Check if either side has been below long enough to flag
        if self.dipped_side is None:
            if self.below_timer_up > config.DIP_MIN_SECONDS:
                self.dipped_side = Side.UP
            elif self.below_timer_down > config.DIP_MIN_SECONDS:
                self.dipped_side = Side.DOWN

            if self.dipped_side is not None and not self.dipped_logged:
                self.dipped_logged = True
                timer = self.below_timer_up if self.dipped_side == Side.UP else self.below_timer_down
                self._log("SIDE_DIPPED", side=self.dipped_side.value,
                          price=round(up_mid if self.dipped_side == Side.UP else down_mid, 4),
                          note=(f"{self.dipped_side.value} below {config.DIP_THRESHOLD:.2f} for "
                                f"{timer:.1f}s (>{config.DIP_MIN_SECONDS:.0f}s) -- flagged, "
                                f"waiting for recovery to {config.ENTRY_RECOVERY:.2f}"))
            return  # either not flagged yet or already waiting

        # Side is flagged -- wait for recovery to ENTRY_RECOVERY
        mid = up_mid if self.dipped_side == Side.UP else down_mid
        if mid is not None and mid >= config.ENTRY_RECOVERY:
            self._buy(now, mid)

    def _buy(self, now, mid):
        side = self.dipped_side
        shares = config.ORDER_SHARES
        ask = self._ask_for(side)
        levels = self._ask_levels_for(side)
        fill = self._realistic_fill_price(levels, shares, ask)
        if fill is None:
            self._log("NO_LIQUIDITY", side=side.value, shares=shares,
                      note=f"no ask liquidity at recovery -- skip")
            self.done_for_window = True
            return
        fee = self.broker.taker_fee_amount(shares, fill)
        cost = shares * fill + fee
        self.balance -= cost
        if self.balance < 0:
            self.halted = True
        self.position = {"side": side, "shares": shares, "entry_price": fill,
                         "entry_fee": fee, "cost": cost, "entry_ts": now}
        self.total_entries += 1
        self._log("ENTRY_FILL", side=side.value, price=round(fill, 4), shares=shares,
                  fee=round(fee, 4), note=(
            f"taker buy: {side.value} mid recovered to {config.ENTRY_RECOVERY:.2f} "
            f"-> {shares:.0f}sh @ {fill:.4f} (ask depth, fee ${fee:.4f}). "
            f"SL {config.SL_PRICE:.2f} / TP {config.TP_PRICE:.2f}."))

    # ---- position management -----------------------------------------------

    def _tick_position(self, up_bid, up_ask, up_bid_levels,
                       down_bid, down_ask, down_bid_levels, down_ask_levels, now):
        pos = self.position
        side = pos["side"]
        mark = _midpoint(up_bid, up_ask) if side == Side.UP else _midpoint(down_bid, down_ask)
        if mark is None:
            return

        # SL check
        if mark <= config.SL_PRICE:
            bid = up_bid if side == Side.UP else down_bid
            levels = up_bid_levels if side == Side.UP else down_bid_levels
            fill = self._realistic_fill_price(levels, pos["shares"], bid)
            if fill is None:
                return
            fee = self.broker.taker_fee_amount(pos["shares"], fill)
            proceeds = pos["shares"] * fill - fee
            pnl = proceeds - pos["cost"]
            self.balance += proceeds
            self.total_sl_hits += 1
            self.total_losses += 1
            self.last_window_pnl = pnl
            self.total_pnl += pnl
            self.done_for_window = True
            self._record_equity()
            self._log("SL_HIT", side=side.value, price=round(fill, 4), shares=pos["shares"],
                      fee=round(fee, 4), pnl=round(pnl, 2), note=(
                f"SL {config.SL_PRICE:.2f}: sold {pos['shares']:.0f}sh @ {fill:.4f} "
                f"(bid depth, fee ${fee:.4f}). PnL ${pnl:.2f}."))
            self.position = None
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
                f"fee-free. PnL ${pnl:.2f}."))
            self.position = None

    # ---- window close settlement -------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.halted or self.window is None:
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
                    f"{pos['shares']:.0f}sh redeemed at $1.00. PnL ${pnl:.2f}."))
            else:
                pnl = -pos["cost"]
                self.total_losses += 1
                self.last_window_pnl = pnl
                self.total_pnl += pnl
                self._log("RESOLUTION_LOSS", side=pos["side"].value, price=0.0,
                          shares=pos["shares"], pnl=round(pnl, 2), note=(
                    f"window won by {winning_side.value if winning_side else 'unknown'} -- "
                    f"{pos['side'].value} position expires worthless. PnL ${pnl:.2f}."))
            self.position = None
            self._record_equity()
            return

        # No trade this window -- still record equity
        if self.position is None and not self.done_for_window:
            self._log("NO_TRADE", note="neither side met dip+recovery criteria this window")
        self._record_equity()

    # ---- helpers -----------------------------------------------------------

    def _ask_for(self, side):  return self._up_ask if side == Side.UP else self._down_ask
    def _bid_for(self, side):  return self._up_bid if side == Side.UP else self._down_bid
    def _mid_for(self, side):  return _midpoint(self._bid_for(side), self._ask_for(side))
    def _ask_levels_for(self, side): return self._up_ask_levels if side == Side.UP else self._down_ask_levels
    def _bid_levels_for(self, side): return self._up_bid_levels if side == Side.UP else self._down_bid_levels

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close=None, now=None,
                up_bid_levels=None, up_ask_levels=None,
                down_bid_levels=None, down_ask_levels=None):
        if self.window is None or self.halted or self.done_for_window:
            return
        now = now if now is not None else time.time()
        # store book data for helper lookups
        self._up_bid, self._up_ask = up_bid, up_ask
        self._down_bid, self._down_ask = down_bid, down_ask
        self._up_bid_levels, self._up_ask_levels = up_bid_levels, up_ask_levels
        self._down_bid_levels, self._down_ask_levels = down_bid_levels, down_ask_levels

        up_mid = _midpoint(up_bid, up_ask)
        down_mid = _midpoint(down_bid, down_ask)

        if self.position is None:
            self._tick_dip_monitor(up_mid, down_mid, now)
        else:
            self._tick_position(up_bid, up_ask, up_bid_levels,
                                down_bid, down_ask, down_bid_levels, down_ask_levels, now)

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
            "below_timer_up": round(self.below_timer_up, 1),
            "below_timer_down": round(self.below_timer_down, 1),
            "total_entries": self.total_entries,
            "total_tp_hits": self.total_tp_hits,
            "total_sl_hits": self.total_sl_hits,
            "total_wins": self.total_wins,
            "total_losses": self.total_losses,
            "last_window_pnl": round(self.last_window_pnl, 2),
            "total_pnl": round(self.total_pnl, 2),
            "win_rate": round(100 * self.total_wins / (self.total_wins + self.total_losses), 1)
            if (self.total_wins + self.total_losses) else None,
            "equity_curve": self.equity_curve,
            "def": {
                "dip_threshold": config.DIP_THRESHOLD,
                "dip_min_seconds": config.DIP_MIN_SECONDS,
                "entry_recovery": config.ENTRY_RECOVERY,
                "sl_price": config.SL_PRICE,
                "tp_price": config.TP_PRICE,
                "order_shares": config.ORDER_SHARES,
            },
        }
