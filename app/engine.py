"""
Trading engine — breakout-limit-buy ladder (100 shares/rung).

Flow per 5-min window:
  1. WAITING phase (first 60s): observe prices, no orders.
  2. MONITORING phase (after 60s): watch both sides. The first side
     whose price ticks above BREAKOUT_THRESHOLD (0.75) becomes the
     tracked side for the rest of the window.
  3. LADDER phase: while the tracked side's price keeps ticking up,
     place a resting BUY limit order at (current_price − LIMIT_OFFSET)
     for SHARES_PER_FILL (100) shares:
       - price ticks 0.75 → limit buy at 0.65
       - price ticks 0.85 → limit buy at 0.75
       - price ticks 0.95 → limit buy at 0.85
     Each new tick level adds one more resting buy (all levels race —
     the first to fill wins; the rest keep resting and may fill too).
  4. FILL: every filled rung immediately becomes its own position with:
     - SL: market sell at 0.50 (fires the instant the exit price ≤ 0.50)
     - TP: resting limit sell at 0.99
  5. RESOLUTION: any position still open at window close settles at
     Polymarket's real outcome ($1/share win, $0/share loss).
"""
import time
from dataclasses import dataclass, field
from typing import List, Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _midpoint(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return ask if ask is not None else bid


@dataclass
class RestingBuy:
    side: Side
    price: float
    shares: float


@dataclass
class Position:
    side: Side
    shares: float
    entry_price: float
    cost: float
    tp_price: float


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    phase: str = "waiting"          # waiting, monitoring, ladder, done
    window_start_ts: float = 0.0

    tracked_side: Optional[Side] = None

    resting_buys: List[RestingBuy] = field(default_factory=list)
    placed_limits: List[float] = field(default_factory=list)
    positions: List[Position] = field(default_factory=list)

    fills_this_window: int = 0
    sl_exits: int = 0
    tp_exits: int = 0
    total_fills: int = 0
    no_trade_windows: int = 0
    resolution_wins: int = 0
    resolution_losses: int = 0
    total_pnl: float = 0.0

    balance: float = 0.0
    halted: bool = False
    equity_curve: list = field(default_factory=list)


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.s = EngineState(balance=config.STARTING_CAPITAL)
        self.s.equity_curve.append({
            "window": None, "ts": time.time(), "balance": round(self.s.balance, 2),
        })

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.phase = "waiting"
        self.s.window_start_ts = time.time()
        self.s.tracked_side = None
        self.s.resting_buys = []
        self.s.placed_limits = []
        self.s.positions = []
        self.s.fills_this_window = 0

        if self.s.halted:
            self.broker.log_event(
                self.name, window.slug, "HALTED",
                note="Bot is halted — no trades this window",
            )

    # ---- main tick -------------------------------------------------------

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close, now=None):
        if self.s.halted or self.s.window is None:
            return

        now = now or time.time()
        self.s.up_bid = up_bid
        self.s.up_ask = up_ask
        self.s.down_bid = down_bid
        self.s.down_ask = down_ask

        elapsed = now - self.s.window_start_ts

        if self.s.phase == "waiting":
            if elapsed >= config.WAIT_SECONDS:
                self.s.phase = "monitoring"
                self.broker.log_event(
                    self.name, self.s.window.slug, "MONITORING",
                    note=(f"{config.WAIT_SECONDS}s elapsed — watching for a side "
                          f"above {config.BREAKOUT_THRESHOLD}"),
                )
            return

        if self.s.phase == "monitoring":
            self._watch_for_breakout()
            return

        if self.s.phase in ("ladder",):
            self._ladder_tick()
            self._manage_positions()
            return

    # ---- monitoring ------------------------------------------------------

    def _watch_for_breakout(self):
        up_mid = _midpoint(self.s.up_bid, self.s.up_ask)
        down_mid = _midpoint(self.s.down_bid, self.s.down_ask)

        if up_mid is not None and up_mid >= config.BREAKOUT_THRESHOLD:
            self._start_ladder(Side.UP, up_mid)
            return
        if down_mid is not None and down_mid >= config.BREAKOUT_THRESHOLD:
            self._start_ladder(Side.DOWN, down_mid)
            return

    def _start_ladder(self, side: Side, price: float):
        self.s.tracked_side = side
        self.s.phase = "ladder"
        self.broker.log_event(
            self.name, self.s.window.slug, "LADDER_START",
            side=side.value, price=price,
            note=f"tracked {side.value} first above {config.BREAKOUT_THRESHOLD} @ {price:.3f}",
        )
        self._place_rung(price)

    def _place_rung(self, current_price: float):
        limit = current_price - config.LIMIT_OFFSET
        if limit <= 0:
            return
        # place one resting buy per new limit level (dedupe)
        if any(abs(l - limit) < 1e-9 for l in self.s.placed_limits):
            return
        self.s.placed_limits.append(limit)
        self.s.resting_buys.append(RestingBuy(
            side=self.s.tracked_side,
            price=limit,
            shares=config.SHARES_PER_FILL,
        ))
        self.broker.log_event(
            self.name, self.s.window.slug, "LIMIT_BUY",
            side=self.s.tracked_side.value, price=limit,
            shares=config.SHARES_PER_FILL,
            note=(f"price {current_price:.3f} → limit buy "
                  f"{config.SHARES_PER_FILL:.0f}sh @ {limit:.3f}"),
        )

    # ---- ladder tick -----------------------------------------------------

    def _ladder_tick(self):
        # re-evaluate the tracked side's ask and add new rungs as it rises
        if self.s.tracked_side == Side.UP:
            ask = self.s.up_ask
        else:
            ask = self.s.down_ask
        if ask is None:
            return
        if ask >= config.BREAKOUT_THRESHOLD:
            self._place_rung(ask)

        # fill check: a resting buy fills when the tracked side's ASK
        # walks down to (or through) the limit price
        for order in list(self.s.resting_buys):
            if self.s.tracked_side == Side.UP:
                fill_ref = self.s.up_ask
            else:
                fill_ref = self.s.down_ask
            if fill_ref is not None and fill_ref <= order.price:
                self._fill_buy(order)

    def _fill_buy(self, order: RestingBuy):
        if order not in self.s.resting_buys:
            return
        self.s.resting_buys.remove(order)

        cost = order.shares * order.price
        self.s.balance -= cost
        self.s.positions.append(Position(
            side=order.side,
            shares=order.shares,
            entry_price=order.price,
            cost=cost,
            tp_price=config.TP_PRICE,
        ))
        self.s.fills_this_window += 1
        self.s.total_fills += 1

        self.broker.log_event(
            self.name, self.s.window.slug, "FILL",
            side=order.side.value, price=order.price, shares=order.shares,
            balance_after=self.s.balance,
            note=(f"limit buy {order.shares:.0f}sh filled @ {order.price:.3f} "
                  f"— SL {config.SL_PRICE} / TP {config.TP_PRICE}"),
        )

    # ---- position management (SL / TP) -----------------------------------

    def _manage_positions(self):
        for pos in list(self.s.positions):
            if pos.side == Side.UP:
                bid = self.s.up_bid
            else:
                bid = self.s.down_bid
            if bid is None:
                continue

            # SL fires immediately if the exit price is at/below 0.50
            if bid <= config.SL_PRICE:
                self._close_position(pos, bid, "SL")
            elif bid >= pos.tp_price:
                self._close_position(pos, pos.tp_price, "TP")

    def _close_position(self, pos: Position, exit_price: float, reason: str):
        if pos not in self.s.positions:
            return
        self.s.positions.remove(pos)

        proceeds = pos.shares * exit_price
        pnl = proceeds - pos.cost
        self.s.balance += proceeds
        self.s.total_pnl += pnl

        if reason == "SL":
            self.s.sl_exits += 1
        else:
            self.s.tp_exits += 1

        self.broker.log_event(
            self.name, self.s.window.slug, reason,
            side=pos.side.value, price=exit_price, shares=pos.shares,
            pnl=pnl, balance_after=self.s.balance,
            note=(f"{reason} @ {exit_price:.3f} (entry {pos.entry_price:.3f}): "
                  f"{'+$' if pnl >= 0 else '-$'}{abs(pnl):.2f}"),
        )

        if self.s.balance < 0:
            self._halt()

    # ---- window finalize -------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        # settle any positions still open at window close
        for pos in list(self.s.positions):
            self.s.positions.remove(pos)
            won = winning_side is not None and pos.side == winning_side
            proceeds = pos.shares * (1.0 if won else 0.0)
            pnl = proceeds - pos.cost
            self.s.balance += proceeds
            self.s.total_pnl += pnl
            event = "RESOLVE_WIN" if won else "RESOLVE_LOSS"
            self.broker.log_event(
                self.name, self.s.window.slug, event,
                side=pos.side.value, shares=pos.shares, pnl=pnl,
                balance_after=self.s.balance,
                note=(f"resolution: {'won $1/sh' if won else 'lost $0/sh'} "
                      f"(entry {pos.entry_price:.3f}, {pos.shares:.0f} shares)"),
            )
            if won:
                self.s.resolution_wins += 1
            else:
                self.s.resolution_losses += 1
            if self.s.balance < 0:
                self._halt()

        if self.s.fills_this_window == 0:
            self.s.no_trade_windows += 1

        self.s.equity_curve.append({
            "window": self.s.window.slug if self.s.window else None,
            "ts": time.time(),
            "balance": round(self.s.balance, 2),
        })
        if len(self.s.equity_curve) > 500:
            self.s.equity_curve = self.s.equity_curve[-500:]

        # drop any unused resting buys (they don't carry over)
        self.s.resting_buys = []

    def _halt(self):
        self.s.halted = True
        self.broker.log_event(
            self.name, self.s.window.slug or "SYS", "HALT",
            note=f"Balance negative (${self.s.balance:.2f}) — bot halted",
        )

    # ---- dashboard payload -----------------------------------------------

    def snapshot(self) -> dict:
        open_positions = []
        unrealized_pnl = 0.0
        open_market_value = 0.0

        for pos in self.s.positions:
            if pos.side == Side.UP:
                mark = self.s.up_bid
            else:
                mark = self.s.down_bid
            mark_for_calc = mark if mark is not None else pos.entry_price
            market_value = pos.shares * mark_for_calc
            pos_unrealized = market_value - pos.cost
            unrealized_pnl += pos_unrealized
            open_market_value += market_value
            open_positions.append({
                "side": pos.side.value,
                "entry_price": pos.entry_price,
                "shares": pos.shares,
                "cost": round(pos.cost, 4),
                "tp_price": pos.tp_price,
                "mark_price": mark,
                "unrealized_pnl": round(pos_unrealized, 4),
            })

        return {
            "balance": round(self.s.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.s.halted,
            "equity_curve": self.s.equity_curve,
            "realized_pnl": round(self.s.total_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),
            "equity": round(self.s.balance + open_market_value, 4),
            "phase": self.s.phase,
            "tracked_side": self.s.tracked_side.value if self.s.tracked_side else None,
            "pending_buys": [
                {"side": o.side.value, "price": o.price, "shares": o.shares}
                for o in self.s.resting_buys
            ],
            "open_positions": open_positions,
            "fills_this_window": self.s.fills_this_window,
            "sl_exits": self.s.sl_exits,
            "tp_exits": self.s.tp_exits,
            "total_fills": self.s.total_fills,
            "no_trade_windows": self.s.no_trade_windows,
            "resolution_wins": self.s.resolution_wins,
            "resolution_losses": self.s.resolution_losses,
            "status": ("halted" if self.s.halted else self.s.phase),
            "def": {
                "wait_seconds": config.WAIT_SECONDS,
                "breakout_threshold": config.BREAKOUT_THRESHOLD,
                "limit_offset": config.LIMIT_OFFSET,
                "shares_per_fill": config.SHARES_PER_FILL,
                "sl_price": config.SL_PRICE,
                "tp_price": config.TP_PRICE,
            },
        }
