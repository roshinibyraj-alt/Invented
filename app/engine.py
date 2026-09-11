"""
Trading engine -- immediate-entry ladder, per-rung race + per-rung martingale.

Entry: on the very first tick of each new window, unconditionally place
config.LADDER_LEVELS as resting BUY limit orders on BOTH UP and DOWN
simultaneously (2 price rungs each, 4 orders total). No wait, no
price-band filter -- it fires immediately, once per window. Order size
per rung = base size * that rung's current martingale multiplier (see
below). Pure maker orders -- never cross the spread.

Per-rung race: the moment a rung fills on one side, the SAME rung
(same price) on the OPPOSITE side is immediately cancelled -- each of
the 2 rungs races independently between UP and DOWN. The other rung
keeps resting untouched.

Exit: every fill (any rung, any side) immediately gets its own resting
TP sell limit at the flat config.TP_PRICE (0.99). TP orders are maker
too (fill when the book's bid on that side rises to/through TP). There
is no stop loss -- if a TP never hits, that position rides to window
resolution instead: $1/share if its side won, $0 if it lost.

Per-rung martingale: each rung price (0.40 / 0.30) tracks its
own consecutive-loss streak (a "loss" = a filled position at that rung
that never hit TP and then lost at resolution; a TP fill always counts
as a win). The streak persists across windows and only resets to 0 on
a win at that rung. Every time the streak reaches another multiple of
config.RUNG_LOSS_DOUBLE_THRESHOLDS[rung], that rung's share-size
multiplier doubles again (compounding). The 0.40 rung uses the same
threshold/compounding logic as the 0.30 rung.

No re-arming: once a window has had its ladder placed, it is never
placed again in that window. Each new 5-minute window is a brand-new
market/token, so per-window state resets in reset_for_window() -- but
the per-rung loss-streak/multiplier state is engine-lifetime, not reset
per window.
"""
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

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
    price: float          # entry limit price == the rung
    shares: float          # already includes the current rung multiplier


@dataclass
class RestingSell:
    side: Side
    tp_price: float
    shares: float
    entry_price: float    # the rung this position was entered at
    cost: float            # actual cash paid (post maker-rebate) for this position


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None

    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    # ladder-entry bookkeeping
    ladder_placed: bool = False

    # resting orders / open positions
    pending_buys: List[RestingBuy] = field(default_factory=list)
    pending_sells: List[RestingSell] = field(default_factory=list)  # = open (floating) positions

    # per-rung martingale state -- ENGINE-LIFETIME, not reset per window
    rung_loss_streak: Dict[float, int] = field(default_factory=dict)
    rung_multiplier: Dict[float, int] = field(default_factory=dict)

    fills_this_window: int = 0
    tp_fills_this_window: int = 0
    last_window_pnl: float = 0.0

    total_fills: int = 0
    total_tp_fills: int = 0
    no_trade_windows: int = 0
    resolution_wins: int = 0
    resolution_losses: int = 0
    total_pnl: float = 0.0  # realized pnl, lifetime

    balance: float = 0.0
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.s = EngineState(balance=config.STARTING_CAPITAL)
        for price, _ in config.LADDER_LEVELS:
            self.s.rung_loss_streak[price] = 0
            self.s.rung_multiplier[price] = 1

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.ladder_placed = False
        self.s.pending_buys = []
        self.s.pending_sells = []
        self.s.fills_this_window = 0
        self.s.tp_fills_this_window = 0
        self.s.last_window_pnl = 0.0

        if self.s.halted:
            self.broker.log_event(
                self.name, window.slug, "HALTED",
                note=f"engine halted (balance ${self.s.balance:.2f} < $0) -- no trading",
                balance_after=self.s.balance,
            )
            return

        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note="placing ladder immediately on the first tick -- no wait, no price-band filter",
            balance_after=self.s.balance,
        )

    def on_tick(self, up_bid: Optional[float], up_ask: Optional[float],
                down_bid: Optional[float], down_ask: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.s.window is None:
            return
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        if self.s.halted:
            return

        if not self.s.ladder_placed:
            self._place_ladder()

        self._check_buy_fills()
        self._check_sell_fills()

    # ---- immediate ladder entry -------------------------------------------

    def _place_ladder(self):
        self.s.ladder_placed = True
        self.broker.log_event(
            self.name, self.s.window.slug, "LADDER_ENTRY",
            note="first tick of window -- placing ladder on both sides unconditionally",
            balance_after=self.s.balance,
        )
        for side in (Side.UP, Side.DOWN):
            for price, base_shares in config.LADDER_LEVELS:
                mult = self.s.rung_multiplier[price]
                shares = base_shares * mult
                self.s.pending_buys.append(RestingBuy(side=side, price=price, shares=shares))
                self.broker.log_event(
                    self.name, self.s.window.slug, "ORDER_PLACED", side=side.value, price=price,
                    shares=shares, balance_after=self.s.balance,
                    note=(f"resting buy: {side.value} {shares:.0f}sh @ {price} "
                          f"(base {base_shares:.0f}sh x{mult} martingale, maker, "
                          f"cancelled only if opposite side fills this rung)"),
                )

    # ---- buy fills + per-rung opposite cancellation -----------------------

    def _check_buy_fills(self):
        if not self.s.pending_buys:
            return
        # deterministic ordering: UP before DOWN, cheapest rung first
        ordered = sorted(self.s.pending_buys, key=lambda o: (o.side != Side.UP, o.price))
        removed_ids = set()
        for order in ordered:
            if id(order) in removed_ids:
                continue  # already cancelled by an opposite-side fill this tick
            current_ask = self.s.up_ask if order.side == Side.UP else self.s.down_ask
            if current_ask is not None and current_ask <= order.price:
                self._fill_buy(order)
                removed_ids.add(id(order))
                opposite_side = Side.DOWN if order.side == Side.UP else Side.UP
                for other in ordered:
                    if (other.side == opposite_side and other.price == order.price
                            and id(other) not in removed_ids):
                        removed_ids.add(id(other))
                        self._cancel_opposite(other)
        if removed_ids:
            self.s.pending_buys = [o for o in self.s.pending_buys if id(o) not in removed_ids]

    def _cancel_opposite(self, order: RestingBuy):
        self.broker.log_event(
            self.name, self.s.window.slug, "CANCELLED", side=order.side.value, price=order.price,
            shares=order.shares, balance_after=self.s.balance,
            note=(f"opposite-side same-rung order cancelled: {order.side.value} {order.shares:.0f}sh "
                  f"@ {order.price} (other side filled this rung first)"),
        )

    def _fill_buy(self, order: RestingBuy):
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(order.shares, order.price)
        cost = order.shares * order.price - rebate
        self.s.balance -= cost
        self.s.fills_this_window += 1
        self.s.total_fills += 1

        self.broker.log_event(
            self.name, self.s.window.slug, "BUY", side=order.side.value, price=order.price,
            shares=order.shares, fee=-rebate, balance_after=self.s.balance,
            note=(f"ladder fill (maker): {order.side.value} {order.shares:.0f}sh @ {order.price} "
                  f"(rebate ${rebate:.4f}) -- TP set at {config.TP_PRICE}"),
        )
        if self.s.balance < 0:
            self._halt()
            return

        self.s.pending_sells.append(RestingSell(
            side=order.side, tp_price=config.TP_PRICE, shares=order.shares,
            entry_price=order.price, cost=cost,
        ))
        self.broker.log_event(
            self.name, self.s.window.slug, "TP_PLACED", side=order.side.value, price=config.TP_PRICE,
            shares=order.shares, balance_after=self.s.balance,
            note=f"resting TP sell: {order.side.value} {order.shares:.0f}sh @ {config.TP_PRICE} (entry {order.price})",
        )

    # ---- TP (sell) fills ----------------------------------------------------

    def _check_sell_fills(self):
        if not self.s.pending_sells:
            return
        still_pending = []
        for order in self.s.pending_sells:
            current_bid = self.s.up_bid if order.side == Side.UP else self.s.down_bid
            if current_bid is not None and current_bid >= order.tp_price:
                self._fill_sell(order)
            else:
                still_pending.append(order)
        self.s.pending_sells = still_pending

    def _fill_sell(self, order: RestingSell):
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(order.shares, order.tp_price)
        proceeds = order.shares * order.tp_price + rebate
        pnl = proceeds - order.cost

        self.s.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        self.s.tp_fills_this_window += 1
        self.s.total_tp_fills += 1

        self.broker.log_event(
            self.name, self.s.window.slug, "TP_FILL", side=order.side.value, price=order.tp_price,
            shares=order.shares, pnl=pnl, fee=rebate, balance_after=self.s.balance,
            note=(f"TP hit: {order.side.value} {order.shares:.0f}sh sold @ {order.tp_price} "
                  f"(entry {order.entry_price}, pnl ${pnl:.4f})"),
        )
        self._record_rung_outcome(order.entry_price, won=True)
        if self.s.balance < 0:
            self._halt()

    # ---- per-rung martingale ------------------------------------------------

    def _record_rung_outcome(self, rung_price: float, won: bool):
        if rung_price not in self.s.rung_loss_streak:
            self.s.rung_loss_streak[rung_price] = 0
            self.s.rung_multiplier[rung_price] = 1

        if won:
            prev_streak = self.s.rung_loss_streak[rung_price]
            prev_mult = self.s.rung_multiplier[rung_price]
            self.s.rung_loss_streak[rung_price] = 0
            self.s.rung_multiplier[rung_price] = 1
            if prev_streak or prev_mult != 1:
                self.broker.log_event(
                    self.name, self.s.window.slug if self.s.window else "", "RUNG_RESET",
                    price=rung_price, balance_after=self.s.balance,
                    note=f"rung {rung_price} won -- loss streak reset 0, multiplier reset to 1x (was {prev_mult}x)",
                )
        else:
            self.s.rung_loss_streak[rung_price] += 1
            threshold = config.RUNG_LOSS_DOUBLE_THRESHOLDS.get(rung_price)
            streak = self.s.rung_loss_streak[rung_price]
            if threshold and streak % threshold == 0:
                old_mult = self.s.rung_multiplier[rung_price]
                self.s.rung_multiplier[rung_price] = old_mult * 2
                self.broker.log_event(
                    self.name, self.s.window.slug if self.s.window else "", "RUNG_DOUBLED",
                    price=rung_price, balance_after=self.s.balance,
                    note=(f"rung {rung_price}: {streak} consecutive losses (threshold {threshold}) -- "
                          f"multiplier {old_mult}x -> {old_mult * 2}x"),
                )

    def _halt(self):
        self.s.halted = True
        self.broker.log_event(
            self.name, self.s.window.slug if self.s.window else "", "HALTED",
            balance_after=self.s.balance,
            note=f"balance ${self.s.balance:.2f} < $0 -- bankrupt, engine stopped permanently",
        )

    # ---- window close -----------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return

        for order in self.s.pending_buys:
            self.broker.log_event(
                self.name, self.s.window.slug, "EXPIRED", side=order.side.value, price=order.price,
                shares=order.shares, balance_after=self.s.balance,
                note=f"unfilled ladder order expired with the window: {order.side.value} {order.shares:.0f}sh @ {order.price}",
            )
        self.s.pending_buys = []

        if not self.s.halted:
            for order in self.s.pending_sells:
                self._settle_position(order, winning_side)
        self.s.pending_sells = []

        if not self.s.halted and self.s.fills_this_window == 0:
            self.s.no_trade_windows += 1
            self.broker.log_event(
                self.name, self.s.window.slug, "NO_TRADE",
                balance_after=self.s.balance,
                note="ladder placed but never got hit this window -- no fills",
            )

        self._record_equity_point()
        self.s.window = None

    def _settle_position(self, order: RestingSell, winning_side: Optional[Side]):
        won = winning_side is not None and order.side == winning_side
        proceeds = order.shares * (1.0 if won else 0.0)
        pnl = proceeds - order.cost
        self.s.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        if won:
            self.s.resolution_wins += 1
        else:
            self.s.resolution_losses += 1
        event = "RESOLVE_WIN" if won else "RESOLVE_LOSS"
        self.broker.log_event(
            self.name, self.s.window.slug, event, side=order.side.value, shares=order.shares, pnl=pnl,
            balance_after=self.s.balance,
            note=(f"TP never hit, position ({order.side.value} {order.shares:.0f}sh, entry {order.entry_price}) "
                  f"settled at resolution: {'won $1/sh' if won else 'lost, $0/sh'}"),
        )
        self._record_rung_outcome(order.entry_price, won=won)
        if self.s.balance < 0:
            self._halt()

    def _record_equity_point(self):
        self.s.equity_curve.append({
            "window": self.s.window.slug if self.s.window else None,
            "ts": time.time(),
            "balance": round(self.s.balance, 2),
        })
        if len(self.s.equity_curve) > 500:
            self.s.equity_curve = self.s.equity_curve[-500:]

    # ---- dashboard payload -------------------------------------------------

    def _mark_price(self, side: Side) -> Optional[float]:
        # what you could sell at right now -- the current bid on that side
        bid = self.s.up_bid if side == Side.UP else self.s.down_bid
        return bid

    def snapshot(self) -> dict:
        open_positions = []
        unrealized_pnl = 0.0
        open_market_value = 0.0
        for o in self.s.pending_sells:
            mark = self._mark_price(o.side)
            mark_for_calc = mark if mark is not None else o.entry_price
            market_value = o.shares * mark_for_calc
            pos_unrealized = market_value - o.cost
            unrealized_pnl += pos_unrealized
            open_market_value += market_value
            open_positions.append({
                "side": o.side.value,
                "entry_price": o.entry_price,
                "shares": o.shares,
                "cost": round(o.cost, 4),
                "tp_price": o.tp_price,
                "mark_price": mark,
                "unrealized_pnl": round(pos_unrealized, 4),
            })

        return {
            "balance": round(self.s.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.s.halted,
            "equity_curve": self.s.equity_curve[-150:],

            "realized_pnl": round(self.s.total_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),
            "equity": round(self.s.balance + open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "ladder_placed": self.s.ladder_placed,
            "open_positions": open_positions,

            "pending_buys": [
                {"side": o.side.value, "price": o.price, "shares": o.shares}
                for o in self.s.pending_buys
            ],
            "pending_sells": [
                {"side": o.side.value, "price": o.tp_price, "shares": o.shares, "entry": o.entry_price}
                for o in self.s.pending_sells
            ],

            "fills_this_window": self.s.fills_this_window,
            "tp_fills_this_window": self.s.tp_fills_this_window,
            "total_fills": self.s.total_fills,
            "total_tp_fills": self.s.total_tp_fills,
            "no_trade_windows": self.s.no_trade_windows,
            "resolution_wins": self.s.resolution_wins,
            "resolution_losses": self.s.resolution_losses,

            "status": ("halted" if self.s.halted else
                       ("open" if (self.s.pending_buys or self.s.pending_sells) else
                        ("traded" if self.s.fills_this_window > 0 else "waiting"))),

            "rung_state": {
                str(price): {
                    "base_shares": base_shares,
                    "multiplier": self.s.rung_multiplier.get(price, 1),
                    "current_shares": base_shares * self.s.rung_multiplier.get(price, 1),
                    "loss_streak": self.s.rung_loss_streak.get(price, 0),
                    "double_threshold": config.RUNG_LOSS_DOUBLE_THRESHOLDS.get(price),
                }
                for price, base_shares in config.LADDER_LEVELS
            },

            "def": {
                "ladder_levels": [{"price": p, "base_shares": s} for p, s in config.LADDER_LEVELS],
                "tp_price": config.TP_PRICE,
                "rung_loss_double_thresholds": config.RUNG_LOSS_DOUBLE_THRESHOLDS,
            },
        }
