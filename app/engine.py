"""
Dual-strategy BTC 5-minute up/down paper bot with alternating activation.

Two independent strategies share one position slot per window:

Strategy A — dip-recovery
  After 5s wait, flag whichever side first dips below 0.30. When that
  side returns to 0.48, place a resting limit buy at 0.48 for 500sh.
  Fill confirmed by ask walk-through at/below 0.48.

Strategy B — spike-reversal (exact opposite of A)
  After 5s wait, flag whichever side first spikes above 0.70. When that
  side comes back down to 0.50, place a resting limit buy at 0.48 for
  500sh. Fill confirmed by ask walk-through at/below 0.48.

Both strategies share TP at 0.99 (redeem $1.00/share, fee-free),
no stop-loss, max one trade per window, hold to resolution.

Alternation: A starts active. When the active strategy wins (TP or
resolution), it sleeps for the next window and the other activates.
Losses keep the same strategy active.
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

        # Window state (shared between strategies)
        self.window: Optional[WindowMarket] = None
        self.position: Optional[dict] = None
        self.order_pending: Optional[dict] = None
        self.done_for_window: bool = False

        # Book snapshot per tick
        self._up_bid = self._up_ask = None
        self._down_bid = self._down_ask = None

        # ---- alternation ----
        self.active_strategy = "A"        # which strategy trades this window
        self.swap_next_window = False      # set True when active strategy wins

        # ---- Strategy A (dip-recovery) ----
        self.a_flagged_side: Optional[Side] = None
        self.a_flag_price: float = 1.0     # tracks deepest dip

        # ---- Strategy B (spike-reversal) ----
        self.b_flagged_side: Optional[Side] = None
        self.b_flag_price: float = 0.0     # tracks highest spike

        # ---- lifetime stats (per strategy) ----
        self.total_entries: int = 0
        self.total_tp_hits: int = 0
        self.a_wins: int = 0
        self.b_wins: int = 0
        self.a_losses: int = 0
        self.b_losses: int = 0
        self.last_window_pnl: float = 0.0
        self.total_pnl: float = 0.0
        self.equity_curve: list = []

    @property
    def a_total(self):
        return self.a_wins + self.a_losses

    @property
    def b_total(self):
        return self.b_wins + self.b_losses

    @property
    def total_wins(self):
        return self.a_wins + self.b_wins

    @property
    def total_losses(self):
        return self.a_losses + self.b_losses

    # ---- logging ------------------------------------------------------------

    def _log(self, event: str, **kw):
        self.broker.log_event(
            f"BOT-{self.active_strategy}",
            self.window.slug if self.window else "",
            event, balance_after=round(self.balance, 2), **kw,
        )

    # ---- window lifecycle ----------------------------------------------------

    def reset_for_window(self, window: WindowMarket):
        if self.halted:
            return
        self.window = window
        self.position = None
        self.order_pending = None
        self.done_for_window = False

        # alternation: swap if previous window was a win
        if self.swap_next_window:
            prev = self.active_strategy
            self.active_strategy = "B" if self.active_strategy == "A" else "A"
            self.swap_next_window = False
            self._log("STRATEGY_SWAP", note=(
                f"{prev} won last window -- now activating strategy {self.active_strategy}"))

        # reset strategy-specific flags for this window
        self.a_flagged_side = None
        self.a_flag_price = 1.0
        self.b_flagged_side = None
        self.b_flag_price = 0.0

        label = "dip-recovery" if self.active_strategy == "A" else "spike-reversal"
        if self.active_strategy == "A":
            note = (
                f"strategy A ({label}) active -- waiting {config.WAIT_AFTER_OPEN_SECONDS}s, "
                f"then dip below {config.DIP_THRESHOLD:.2f} → recover to {config.ENTRY_RECOVERY:.2f} "
                f"→ limit buy {config.ENTRY_SHARES:.0f}sh @ {config.ENTRY_LIMIT:.2f}. "
                f"TP {config.TP_PRICE:.2f}. balance ${self.balance:.2f}")
        else:
            note = (
                f"strategy B ({label}) active -- waiting {config.WAIT_AFTER_OPEN_SECONDS}s, "
                f"then spike above {config.SPIKE_THRESHOLD:.2f} → return to {config.B_RECOVERY:.2f} "
                f"→ limit buy {config.ENTRY_SHARES:.0f}sh @ {config.ENTRY_LIMIT:.2f}. "
                f"TP {config.TP_PRICE:.2f}. balance ${self.balance:.2f}")
        self._log("WINDOW_OPEN", note=note)

    # ---- main tick dispatch --------------------------------------------------

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close=None, now=None,
                up_bid_levels=None, up_ask_levels=None,
                down_bid_levels=None, down_ask_levels=None):
        if self.window is None or self.halted or self.done_for_window:
            return
        now = now if now is not None else time.time()
        # wait period
        if now < self.window.open_ts + config.WAIT_AFTER_OPEN_SECONDS:
            self._up_bid, self._up_ask = up_bid, up_ask
            self._down_bid, self._down_ask = down_bid, down_ask
            return
        # store book data
        self._up_bid, self._up_ask = up_bid, up_ask
        self._down_bid, self._down_ask = down_bid, down_ask

        up_mid = _midpoint(up_bid, up_ask)
        down_mid = _midpoint(down_bid, down_ask)

        if self.position is not None:
            self._tick_position(up_bid, up_ask, up_bid_levels,
                                down_bid, down_ask, down_bid_levels, down_ask_levels, now)
        elif self.order_pending is not None:
            self._tick_pending_order(up_bid, up_ask, down_bid, down_ask, now)
        elif self.active_strategy == "A":
            self._tick_dip_monitor(up_mid, down_mid, now)
        else:
            self._tick_spike_monitor(up_mid, down_mid, now)

    # ---- Strategy A: dip monitor --------------------------------------------

    def _tick_dip_monitor(self, up_mid, down_mid, now):
        if self.a_flagged_side is None:
            if up_mid is not None and up_mid < config.DIP_THRESHOLD:
                self.a_flagged_side = Side.UP
                self.a_flag_price = up_mid
                self._log("SIDE_DIPPED", side="UP", price=round(up_mid, 4), note=(
                    f"UP dipped below {config.DIP_THRESHOLD:.2f} (mid={up_mid:.4f}) -- "
                    f"waiting return to {config.ENTRY_RECOVERY:.2f}"))
            elif down_mid is not None and down_mid < config.DIP_THRESHOLD:
                self.a_flagged_side = Side.DOWN
                self.a_flag_price = down_mid
                self._log("SIDE_DIPPED", side="DOWN", price=round(down_mid, 4), note=(
                    f"DOWN dipped below {config.DIP_THRESHOLD:.2f} (mid={down_mid:.4f}) -- "
                    f"waiting return to {config.ENTRY_RECOVERY:.2f}"))
            return
        mid = up_mid if self.a_flagged_side == Side.UP else down_mid
        if mid is not None and mid < self.a_flag_price:
            self.a_flag_price = mid
        if mid is not None and mid >= config.ENTRY_RECOVERY:
            self._place_limit(self.a_flagged_side, now, f"recovery to {config.ENTRY_RECOVERY:.2f}")

    # ---- Strategy B: spike monitor ------------------------------------------

    def _tick_spike_monitor(self, up_mid, down_mid, now):
        if self.b_flagged_side is None:
            if up_mid is not None and up_mid > config.SPIKE_THRESHOLD:
                self.b_flagged_side = Side.UP
                self.b_flag_price = up_mid
                self._log("SIDE_SPIKED", side="UP", price=round(up_mid, 4), note=(
                    f"UP spiked above {config.SPIKE_THRESHOLD:.2f} (mid={up_mid:.4f}) -- "
                    f"waiting return to {config.B_RECOVERY:.2f}"))
            elif down_mid is not None and down_mid > config.SPIKE_THRESHOLD:
                self.b_flagged_side = Side.DOWN
                self.b_flag_price = down_mid
                self._log("SIDE_SPIKED", side="DOWN", price=round(down_mid, 4), note=(
                    f"DOWN spiked above {config.SPIKE_THRESHOLD:.2f} (mid={down_mid:.4f}) -- "
                    f"waiting return to {config.B_RECOVERY:.2f}"))
            return
        mid = up_mid if self.b_flagged_side == Side.UP else down_mid
        if mid is not None and mid > self.b_flag_price:
            self.b_flag_price = mid
        if mid is not None and mid <= config.B_RECOVERY:
            self._place_limit(self.b_flagged_side, now, f"return to {config.B_RECOVERY:.2f}")

    # ---- limit order placement + fill confirmation ---------------------------

    def _place_limit(self, side, now, trigger_desc):
        self.order_pending = {
            "side": side,
            "shares": config.ENTRY_SHARES,
            "limit": config.ENTRY_LIMIT,
            "fired_ts": now,
        }
        self._log("LIMIT_ORDER_PLACED", side=side.value,
                  price=config.ENTRY_LIMIT, shares=config.ENTRY_SHARES, note=(
            f"{side.value}: {trigger_desc} -- "
            f"resting limit buy {config.ENTRY_SHARES:.0f}sh @ {config.ENTRY_LIMIT:.2f}"))

    def _tick_pending_order(self, up_bid, up_ask, down_bid, down_ask, now):
        side = self.order_pending["side"]
        ask = up_ask if side == Side.UP else down_ask
        limit = self.order_pending["limit"]
        shares = self.order_pending["shares"]
        if ask is not None and ask <= limit:
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
                f"fee ${fee:.4f}. TP {config.TP_PRICE:.2f}."))
            self.order_pending = None

    # ---- position management -------------------------------------------------

    def _tick_position(self, up_bid, up_ask, up_bid_levels,
                       down_bid, down_ask, down_bid_levels, down_ask_levels, now):
        pos = self.position
        side = pos["side"]
        mark = _midpoint(up_bid, up_ask) if side == Side.UP else _midpoint(down_bid, down_ask)
        if mark is None:
            return
        if mark >= config.TP_PRICE:
            proceeds = pos["shares"] * 1.0
            pnl = proceeds - pos["cost"]
            self.balance += proceeds
            self.total_tp_hits += 1
            self.last_window_pnl = pnl
            self.total_pnl += pnl
            self.done_for_window = True
            self.swap_next_window = True
            if self.active_strategy == "A":
                self.a_wins += 1
            else:
                self.b_wins += 1
            self._record_equity()
            self._log("TP_HIT", side=side.value, price=1.0, shares=pos["shares"],
                      pnl=round(pnl, 2), note=(
                f"TP {config.TP_PRICE:.2f}: redeemed {pos['shares']:.0f}sh at $1.00/share, "
                f"fee-free. PnL ${pnl:.2f}"))
            self.position = None

    # ---- window close settlement ---------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.halted or self.window is None:
            return

        # cancel unfilled limit order
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
                self.last_window_pnl = pnl
                self.total_pnl += pnl
                self.swap_next_window = True  # win → swap next window
                self._log("RESOLUTION_WIN", side=pos["side"].value, price=1.0,
                          shares=pos["shares"], pnl=round(pnl, 2), note=(
                    f"window won by {winning_side.value} -- "
                    f"{pos['shares']:.0f}sh redeemed at $1.00. PnL ${pnl:.2f}"))
            else:
                pnl = -pos["cost"]
                self.last_window_pnl = pnl
                self.total_pnl += pnl
                self._log("RESOLUTION_LOSS", side=pos["side"].value, price=0.0,
                          shares=pos["shares"], pnl=round(pnl, 2), note=(
                    f"window won by {winning_side.value if winning_side else 'unknown'} -- "
                    f"{pos['side'].value} expires worthless. PnL ${pnl:.2f}"))
            # update per-strategy stats
            is_win = (winning_side is not None and winning_side == pos["side"])
            if self.active_strategy == "A":
                if is_win:
                    self.a_wins += 1
                else:
                    self.a_losses += 1
            else:
                if is_win:
                    self.b_wins += 1
                else:
                    self.b_losses += 1
            self.position = None
            self._record_equity()
            return

        # also update stats for TP win (already done in _tick_position via swap flag)
        # handle edge: if TP already set swap_next_window but we need stats
        if self.swap_next_window and self.done_for_window:
            # TP was hit in _tick_position — stats already counted via swap_next_window
            pass

        if self.position is None and not self.done_for_window:
            self._log("NO_TRADE",
                      note=f"strategy {self.active_strategy} -- no trigger this window")
            self._record_equity()

    # ---- helpers -------------------------------------------------------------

    def _ask_for(self, side):  return self._up_ask if side == Side.UP else self._down_ask
    def _bid_for(self, side):  return self._up_bid if side == Side.UP else self._down_bid
    def _mid_for(self, side):  return _midpoint(self._bid_for(side), self._ask_for(side))

    def _record_equity(self):
        self.equity_curve.append({"window": self.window.slug if self.window else "",
                                  "ts": time.time(), "balance": round(self.balance, 2)})
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    # ---- dashboard snapshot ---------------------------------------------------

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
        elif self.active_strategy == "A" and self.a_flagged_side is not None:
            status = "waiting_recovery"
        elif self.active_strategy == "B" and self.b_flagged_side is not None:
            status = "waiting_recovery"
        else:
            status = "monitoring"

        flagged_side = None
        flag_price = None
        if self.active_strategy == "A" and self.a_flagged_side is not None:
            flagged_side = self.a_flagged_side.value
            flag_price = round(self.a_flag_price, 4)
        elif self.active_strategy == "B" and self.b_flagged_side is not None:
            flagged_side = self.b_flagged_side.value
            flag_price = round(self.b_flag_price, 4)

        return {
            "status": status,
            "active_strategy": self.active_strategy,
            "balance": round(self.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.halted,
            "position": position,
            "unrealized_pnl": position["unrealized_pnl"] if position else 0.0,
            "flagged_side": flagged_side,
            "flag_price": flag_price,
            "entry_shares": config.ENTRY_SHARES,
            "entry_limit": config.ENTRY_LIMIT,
            "order_pending": self.order_pending["side"].value if self.order_pending else None,

            "total_entries": self.total_entries,
            "total_tp_hits": self.total_tp_hits,
            "a_wins": self.a_wins,
            "a_losses": self.a_losses,
            "b_wins": self.b_wins,
            "b_losses": self.b_losses,
            "total_wins": self.total_wins,
            "total_losses": self.total_losses,
            "last_window_pnl": round(self.last_window_pnl, 2),
            "total_pnl": round(self.total_pnl, 2),
            "win_rate": round(100 * self.total_wins / (self.total_wins + self.total_losses), 1)
            if (self.total_wins + self.total_losses) else None,
            "equity_curve": self.equity_curve,
            "def": {
                "a_label": f"A: dip below {config.DIP_THRESHOLD} → recover to {config.ENTRY_RECOVERY}",
                "b_label": f"B: spike above {config.SPIKE_THRESHOLD} → return to {config.B_RECOVERY}",
                "entry_limit": config.ENTRY_LIMIT,
                "entry_shares": config.ENTRY_SHARES,
                "tp_price": config.TP_PRICE,
            },
        }
