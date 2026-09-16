"""
Candle-pattern trading engine for Polymarket's btc-updown-5m-* markets.

Strategy
--------
1. From window open, sample the UP-side CLOB mid every tick to build
   one-minute candles (mid up over the minute = green, mid down = red).
2. When the 3rd candle closes (~180s into the window), evaluate the
   pattern of the first three candles:
       red, red, green      -> buy UP (taker at ask)
       green, green, red    -> buy DOWN (taker at ask)
   Any other combination -> no trade this window.
3. Flat ENTRY_SHARES (500) per trade. No stop-loss. TP at 0.99 redeems
   $1.00/share (fee-free); otherwise the window settles by the inferred
   CLOB winner. One trade max per window.
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

        # window state
        self.window: Optional[WindowMarket] = None
        self.position: Optional[dict] = None
        self.done_for_window: bool = False

        # book snapshot per tick
        self._up_bid = self._up_ask = None
        self._down_bid = self._down_ask = None

        # candle state
        self.candle_colors: list = []          # "red" | "green" (closed candles)
        self.candle_bucket: list = []          # UP mids sampled during current candle
        self.building_candle: int = -1         # candle index being built (0-based)
        self.signal_fired: bool = False

        # lifetime stats
        self.total_entries: int = 0
        self.total_tp_hits: int = 0
        self.total_wins: int = 0
        self.total_losses: int = 0
        self.last_window_pnl: float = 0.0
        self.total_pnl: float = 0.0
        self.equity_curve: list = []

    # ---- logging ------------------------------------------------------------

    def _log(self, event: str, **kw):
        self.broker.log_event(
            "BOT", self.window.slug if self.window else "",
            event, balance_after=round(self.balance, 2), **kw,
        )

    # ---- window lifecycle ----------------------------------------------------

    def reset_for_window(self, window: WindowMarket):
        if self.halted:
            return
        self.window = window
        self.position = None
        self.done_for_window = False
        self.candle_colors = []
        self.candle_bucket = []
        self.building_candle = -1
        self.signal_fired = False
        self._log("WINDOW_OPEN", note=(
            f"window open -- building 5x 1-min candles from UP mid. "
            f"Pattern red/red/green -> buy UP, green/green/red -> buy DOWN. "
            f"No SL. TP {config.TP_PRICE:.2f}. balance ${self.balance:.2f}"
        ))

    # ---- main tick -----------------------------------------------------------

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close=None, now=None,
                up_bid_levels=None, up_ask_levels=None,
                down_bid_levels=None, down_ask_levels=None):
        if self.window is None or self.halted or self.done_for_window:
            return
        now = now if now is not None else time.time()
        # store book data for helpers
        self._up_bid, self._up_ask = up_bid, up_ask
        self._down_bid, self._down_ask = down_bid, down_ask

        up_mid = _midpoint(up_bid, up_ask)
        down_mid = _midpoint(down_bid, down_ask)

        if self.position is not None:
            self._tick_position(up_mid, down_mid, now)
        elif not self.signal_fired:
            self._tick_candle_builder(up_mid, now)

    # ---- candle building + signal --------------------------------------------

    def _tick_candle_builder(self, up_mid, now):
        idx = int((now - self.window.open_ts) // config.CANDLE_SECONDS)
        idx = min(idx, config.PATTERN_CANDLES)  # only need the first 3 candles

        # crossing a candle boundary -> close the previous candle
        if idx != self.building_candle:
            self._close_candle()
            self.building_candle = idx
            self.candle_bucket = []

        if up_mid is not None:
            self.candle_bucket.append(up_mid)

        # once 3 candles are closed, evaluate the pattern once
        if len(self.candle_colors) >= config.PATTERN_CANDLES and not self.signal_fired:
            self._evaluate_pattern(now)

    def _close_candle(self):
        if not self.candle_bucket:
            return
        first = self.candle_bucket[0]
        last = self.candle_bucket[-1]
        if last > first + 1e-6:
            self.candle_colors.append("green")
        elif last < first - 1e-6:
            self.candle_colors.append("red")
        else:
            self.candle_colors.append("flat")
        self._log("CANDLE_CLOSE", price=round(last, 4), note=(
            f"candle #{len(self.candle_colors)} "
            f"{self.candle_colors[-1].upper()} (open {first:.4f} -> close {last:.4f})"))
        self.candle_bucket = []

    def _evaluate_pattern(self, now):
        pattern = tuple(self.candle_colors[:config.PATTERN_CANDLES])
        self.signal_fired = True
        if pattern == ("red", "red", "green"):
            self._buy(Side.UP, now, pattern)
        elif pattern == ("green", "green", "red"):
            self._buy(Side.DOWN, now, pattern)
        else:
            self._log("NO_PATTERN", note=(
                f"pattern {pattern} does not match red/red/green or green/green/red -- no trade"))

    # ---- entry ---------------------------------------------------------------

    def _buy(self, side, now, pattern):
        shares = config.ENTRY_SHARES
        ask = self._ask_for(side)
        if ask is None:
            self._log("NO_LIQUIDITY", side=side.value, shares=shares,
                      note="no ask on entry side -- skip")
            self.done_for_window = True
            return
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        self.balance -= cost
        if self.balance < 0:
            self.halted = True
        self.position = {"side": side, "shares": shares,
                         "entry_price": ask, "entry_fee": fee,
                         "cost": cost, "entry_ts": now}
        self.total_entries += 1
        self._log("ENTRY_FILL", side=side.value, price=round(ask, 4),
                  shares=shares, fee=round(fee, 4), note=(
            f"pattern {'/'.join(pattern)} -> taker buy {side.value} "
            f"{shares:.0f}sh @ {ask:.4f}, fee ${fee:.4f}. TP {config.TP_PRICE:.2f}."))

    # ---- position management -------------------------------------------------

    def _tick_position(self, up_mid, down_mid, now):
        pos = self.position
        side = pos["side"]
        mark = up_mid if side == Side.UP else down_mid
        if mark is None:
            return
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

    # ---- window close settlement ---------------------------------------------

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
            self._log("NO_TRADE", note="no pattern match or no fill this window")
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

    # ---- dashboard snapshot ----------------------------------------------------

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
        elif self.signal_fired:
            status = "done_signal"
        elif len(self.candle_colors) < config.PATTERN_CANDLES:
            status = "building_candles"
        else:
            status = "monitoring"

        return {
            "status": status,
            "balance": round(self.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.halted,
            "position": position,
            "unrealized_pnl": position["unrealized_pnl"] if position else 0.0,
            "candle_colors": list(self.candle_colors),
            "building": self.building_candle,
            "signal_fired": self.signal_fired,

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
                "candle_seconds": config.CANDLE_SECONDS,
                "pattern_candles": config.PATTERN_CANDLES,
                "entry_shares": config.ENTRY_SHARES,
                "tp_price": config.TP_PRICE,
                "buy_up_pattern": "red, red, green",
                "buy_down_pattern": "green, green, red",
            },
        }
