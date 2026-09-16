"""
Candle-pattern trading engine for Polymarket's btc-updown-5m-* markets.

Strategy
--------
1. From window open, sample the Binance BTCUSDT spot price every tick
   to build one-minute candles (spot up over the minute = green, spot
   down = red). The CLOB probability price is NOT used for candles --
   it drifts with time decay. CLOB still drives entry ask, TP and
   resolution.

2. TWO independent signals per window (up to 2 trades, ENTRY_SHARES
   each):

   Trade #1 -- when the 2nd candle closes (~120s):
       C1/C2 = red,green  -> buy UP (taker at ask)
       C1/C2 = green,red  -> buy DOWN (taker at ask)
       C1 == C2 (or flat) -> no first trade

   Trade #2 -- when the 3rd candle closes (~180s) (existing setup):
       C3 differs from C2: green 3rd (red 2nd) -> buy UP
                           red   3rd (green 2nd) -> buy DOWN
       C2 == C3 (or flat) -> no second trade

3. No stop-loss. TP at 0.99 redeems $1.00/share (fee-free) per
   position; otherwise each open position settles by the inferred CLOB
   winner at window close.
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
        self.positions: list = []
        self.done_for_window: bool = False

        # book snapshot per tick
        self._up_bid = self._up_ask = None
        self._down_bid = self._down_ask = None

        # candle state
        self.candle_colors: list = []          # "red" | "green" | "flat" (closed candles)
        self.candle_bucket: list = []          # Binance spot samples during current candle
        self.building_candle: int = -1         # candle index being built (0-based)
        self.first_signal_fired: bool = False  # 2-candle signal evaluated
        self.second_signal_fired: bool = False  # 3-candle signal (existing) evaluated

        # lifetime stats
        self.total_entries: int = 0
        self.total_tp_hits: int = 0
        self.total_wins: int = 0
        self.total_losses: int = 0
        self.last_window_pnl: float = 0.0
        self.total_pnl: float = 0.0
        self.equity_curve: list = []
        self._window_pnl: float = 0.0

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
        self.positions = []
        self.done_for_window = False
        self.candle_colors = []
        self.candle_bucket = []
        self.building_candle = -1
        self.first_signal_fired = False
        self.second_signal_fired = False
        self._window_pnl = 0.0
        self._log("WINDOW_OPEN", note=(
            f"window open -- building 5x 1-min candles from Binance BTCUSDT spot. "
            f"Trade#1 after C2: RG->UP, GR->DOWN. Trade#2 after C3: C3 differs from C2 -> "
            f"green 3rd UP, red 3rd DOWN. No SL. TP {config.TP_PRICE:.2f}. "
            f"balance ${self.balance:.2f}"
        ))

    # ---- main tick -----------------------------------------------------------

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close=None, now=None,
                up_bid_levels=None, up_ask_levels=None,
                down_bid_levels=None, down_ask_levels=None,
                btc_spot=None):
        if self.window is None or self.halted or self.done_for_window:
            return
        now = now if now is not None else time.time()
        # store book data for helpers
        self._up_bid, self._up_ask = up_bid, up_ask
        self._down_bid, self._down_ask = down_bid, down_ask

        up_mid = _midpoint(up_bid, up_ask)
        down_mid = _midpoint(down_bid, down_ask)

        # 1) manage open positions (TP per position)
        if self.positions:
            self._tick_positions(up_mid, down_mid, now)

        # 2) keep building candles + evaluating both signals
        if not (self.first_signal_fired and self.second_signal_fired):
            self._tick_candle_builder(btc_spot, now)

        # 3) window's entries are done once both signals are evaluated
        if self.first_signal_fired and self.second_signal_fired and not self.positions:
            self.done_for_window = True

    # ---- candle building + signals ------------------------------------------

    def _tick_candle_builder(self, spot, now):
        idx = int((now - self.window.open_ts) // config.CANDLE_SECONDS)
        idx = min(idx, config.PATTERN_CANDLES)  # only need the first 3 candles

        # crossing a candle boundary -> close the previous candle
        if idx != self.building_candle:
            self._close_candle()
            self.building_candle = idx
            self.candle_bucket = []

        if spot is not None:
            self.candle_bucket.append(spot)

        # Trade #1: 2-candle signal (red,green -> UP / green,red -> DOWN)
        if len(self.candle_colors) >= config.FIRST_SIGNAL_CANDLES and not self.first_signal_fired:
            self._evaluate_first_signal(now)

        # Trade #2: existing 3-candle signal (C3 differs from C2)
        if len(self.candle_colors) >= config.PATTERN_CANDLES and not self.second_signal_fired:
            self._evaluate_second_signal(now)

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

    def _evaluate_first_signal(self, now):
        colors = self.candle_colors[:config.FIRST_SIGNAL_CANDLES]
        self.first_signal_fired = True
        if len(colors) < config.FIRST_SIGNAL_CANDLES:
            return
        c1, c2 = colors[0], colors[1]
        if c1 == c2 or c1 not in ("green", "red") or c2 not in ("green", "red"):
            self._log("NO_SIGNAL_1", note=(
                f"candles {colors} -- C1/C2 must differ (RG->UP, GR->DOWN) -- no first trade"))
            return
        if c1 == "red" and c2 == "green":
            self._buy(Side.UP, now, (c1, c2), slot=1)
        else:
            self._buy(Side.DOWN, now, (c1, c2), slot=1)

    def _evaluate_second_signal(self, now):
        colors = self.candle_colors[:config.PATTERN_CANDLES]
        self.second_signal_fired = True
        if len(colors) < config.PATTERN_CANDLES:
            return
        c2 = colors[1]
        c3 = colors[2]
        if c2 == c3 or c3 not in ("green", "red"):
            self._log("NO_SIGNAL_2", note=(
                f"candles {colors} -- 3rd candle same as 2nd (or flat) -- no second trade"))
            return
        if c3 == "green":
            self._buy(Side.UP, now, (c2, c3), slot=2)
        elif c3 == "red":
            self._buy(Side.DOWN, now, (c2, c3), slot=2)

    # ---- entry ---------------------------------------------------------------

    def _buy(self, side, now, pattern, slot):
        shares = config.ENTRY_SHARES
        ask = self._ask_for(side)
        if ask is None:
            self._log("NO_LIQUIDITY", side=side.value, shares=shares,
                      note="no ask on entry side -- skip")
            return
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        self.balance -= cost
        if self.balance < 0:
            self.halted = True
        self.positions.append({"side": side, "shares": shares,
                               "entry_price": ask, "entry_fee": fee,
                               "cost": cost, "entry_ts": now, "slot": slot})
        self.total_entries += 1
        self._log("ENTRY_FILL", side=side.value, price=round(ask, 4),
                  shares=shares, fee=round(fee, 4), note=(
            f"Trade#{slot} pattern {'/'.join(pattern)} -> taker buy {side.value} "
            f"{shares:.0f}sh @ {ask:.4f}, fee ${fee:.4f}. TP {config.TP_PRICE:.2f}."))

    # ---- position management -------------------------------------------------

    def _tick_positions(self, up_mid, down_mid, now):
        remaining = []
        for pos in self.positions:
            side = pos["side"]
            mark = up_mid if side == Side.UP else down_mid
            if mark is None or mark < config.TP_PRICE:
                remaining.append(pos)
                continue
            proceeds = pos["shares"] * 1.0
            pnl = proceeds - pos["cost"]
            self.balance += proceeds
            self._window_pnl += pnl
            self.total_tp_hits += 1
            self.total_wins += 1
            self.total_pnl += pnl
            self._record_equity()
            self._log("TP_HIT", side=side.value, price=1.0, shares=pos["shares"],
                      pnl=round(pnl, 2), note=(
                f"Trade#{pos['slot']} TP {config.TP_PRICE:.2f}: redeemed {pos['shares']:.0f}sh "
                f"at $1.00/share, fee-free. PnL ${pnl:.2f}"))
        self.positions = remaining

    # ---- window close settlement ---------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.halted or self.window is None:
            return
        for pos in self.positions:
            if winning_side is not None and winning_side == pos["side"]:
                proceeds = pos["shares"] * 1.0
                pnl = proceeds - pos["cost"]
                self.balance += proceeds
                self._window_pnl += pnl
                self.total_wins += 1
                self.total_pnl += pnl
                self._log("RESOLUTION_WIN", side=pos["side"].value, price=1.0,
                          shares=pos["shares"], pnl=round(pnl, 2), note=(
                    f"Trade#{pos['slot']} window won by {winning_side.value} -- "
                    f"{pos['shares']:.0f}sh redeemed at $1.00. PnL ${pnl:.2f}"))
            else:
                pnl = -pos["cost"]
                self._window_pnl += pnl
                self.total_losses += 1
                self.total_pnl += pnl
                self._log("RESOLUTION_LOSS", side=pos["side"].value, price=0.0,
                          shares=pos["shares"], pnl=round(pnl, 2), note=(
                    f"Trade#{pos['slot']} window won by "
                    f"{winning_side.value if winning_side else 'unknown'} -- "
                    f"{pos['side'].value} expires worthless. PnL ${pnl:.2f}"))
        self.positions = []
        self.last_window_pnl = self._window_pnl
        self._window_pnl = 0.0
        if self.total_entries == 0:
            self._log("NO_TRADE", note="no pattern match or no fill this window")
        self.done_for_window = True
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
        positions = []
        unrealized = 0.0
        for pos in self.positions:
            mark = self._mid_for(pos["side"]) or pos["entry_price"]
            upnl = pos["shares"] * mark - pos["cost"]
            unrealized += upnl
            positions.append({"side": pos["side"].value, "shares": pos["shares"],
                              "slot": pos["slot"],
                              "entry_price": round(pos["entry_price"], 4),
                              "entry_fee": round(pos["entry_fee"], 4),
                              "cost": round(pos["cost"], 4), "mark": round(mark, 4),
                              "unrealized_pnl": round(upnl, 2)})
        position = positions[0] if positions else None

        if self.halted:
            status = "halted"
        elif positions:
            status = "in_position"
        elif self.first_signal_fired and self.second_signal_fired:
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
            "positions": positions,
            "unrealized_pnl": round(unrealized, 2),
            "candle_colors": list(self.candle_colors),
            "building": self.building_candle,
            "signal_fired": self.first_signal_fired and self.second_signal_fired,

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
                "first_signal_rule": "after C2: RG -> BUY UP, GR -> BUY DOWN",
                "second_signal_rule": "after C3: C3 differs from C2 -- green 3rd -> UP, red 3rd -> DOWN",
            },
        }
