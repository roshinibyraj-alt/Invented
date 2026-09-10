"""
Trading engine -- immediate-entry ladder with side-dependent take-profit.

Entry: on the very first tick of each new window, unconditionally place
config.LADDER_LEVELS as resting BUY limit orders on BOTH UP and DOWN
simultaneously (3 price tranches each, 6 orders total). No wait, no
price-band filter -- it fires immediately, once per window. Pure maker
orders -- never cross the spread. None of the six are ever proactively
cancelled by the engine; they only stop resting because the window
itself closes.

First side / second side: the side whose ladder gets ANY tranche filled
first (by wall-clock -- whichever fill is processed first) becomes the
"first side" for the rest of this window, permanently, even though its
other tranches may still be unfilled and fill later. Its fills use the
tiered per-price TP baked into LADDER_LEVELS (0.30->0.70, 0.20->0.80,
0.10->0.90). Every fill on the OTHER side -- which, by definition, fills
after the first side -- uses the flat config.OPPOSITE_TP (0.99)
regardless of which price tranche it was.

Exit: each fill immediately gets its own resting TP sell limit at the
price determined above. TP orders are maker too (fill when the book's
bid on that side rises to/through the TP price). There is no stop loss
and no merge exit here -- if a TP never gets hit, that inventory rides
to window resolution like everything else: $1/share if the side won,
$0 if it lost.

No re-arming: once a window has had its ladder placed, it is never
placed again in that window (the entry only ever fires on the first
tick). Each new 5-minute window is a brand-new
market/token, so state resets fully in reset_for_window().
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
    price: float          # entry limit price
    shares: float
    first_side_tp: float  # the TP this tranche would use IF its side turns out to be the first side


@dataclass
class RestingSell:
    side: Side
    tp_price: float
    shares: float
    entry_price: float    # for pnl/cost-basis bookkeeping


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None

    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    # ladder-entry bookkeeping
    ladder_placed: bool = False

    # resting orders
    pending_buys: List[RestingBuy] = field(default_factory=list)
    pending_sells: List[RestingSell] = field(default_factory=list)

    # which side filled first this window (locks in permanently once set)
    first_side: Optional[Side] = None

    # open inventory per side not yet covered by a TP fill (should
    # normally be ~0 since every buy fill immediately spawns its TP,
    # but tracked for resolution settlement of anything still open)
    up_shares: float = 0.0
    up_cost: float = 0.0
    down_shares: float = 0.0
    down_cost: float = 0.0

    fills_this_window: int = 0
    tp_fills_this_window: int = 0
    last_window_pnl: float = 0.0

    total_fills: int = 0
    total_tp_fills: int = 0
    no_trade_windows: int = 0
    resolution_wins: int = 0
    resolution_losses: int = 0
    total_pnl: float = 0.0

    balance: float = 0.0
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.s = EngineState(balance=config.STARTING_CAPITAL)

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.ladder_placed = False
        self.s.pending_buys = []
        self.s.pending_sells = []
        self.s.first_side = None
        self.s.up_shares = 0.0
        self.s.up_cost = 0.0
        self.s.down_shares = 0.0
        self.s.down_cost = 0.0
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
            up_mid = _midpoint(self.s.up_bid, self.s.up_ask)
            down_mid = _midpoint(self.s.down_bid, self.s.down_ask)
            self._place_ladder(up_mid, down_mid)

        self._check_buy_fills()
        self._check_sell_fills()

    # ---- immediate ladder entry ------------------------------------------

    def _place_ladder(self, up_mid: Optional[float], down_mid: Optional[float]):
        self.s.ladder_placed = True
        up_str = f"{up_mid:.3f}" if up_mid is not None else "n/a"
        down_str = f"{down_mid:.3f}" if down_mid is not None else "n/a"
        self.broker.log_event(
            self.name, self.s.window.slug, "LADDER_ENTRY",
            note=(f"first tick of window -- placing ladder on both sides unconditionally "
                  f"(up_mid={up_str}, down_mid={down_str})"),
            balance_after=self.s.balance,
        )
        for side in (Side.UP, Side.DOWN):
            for price, shares, tp in config.LADDER_LEVELS:
                self.s.pending_buys.append(RestingBuy(side=side, price=price, shares=shares, first_side_tp=tp))
                self.broker.log_event(
                    self.name, self.s.window.slug, "ORDER_PLACED", side=side.value, price=price,
                    shares=shares, balance_after=self.s.balance,
                    note=f"resting buy: {side.value} {shares:.0f}sh @ {price} (maker, not cancelled this window)",
                )

    # ---- buy fills --------------------------------------------------------

    def _check_buy_fills(self):
        if not self.s.pending_buys:
            return
        still_pending = []
        # deterministic ordering: process UP tranches before DOWN so a
        # same-tick simultaneous fill breaks ties toward UP as "first side"
        ordered = sorted(self.s.pending_buys, key=lambda o: (o.side != Side.UP, o.price))
        for order in ordered:
            current_ask = self.s.up_ask if order.side == Side.UP else self.s.down_ask
            if current_ask is not None and current_ask <= order.price:
                self._fill_buy(order)
            else:
                still_pending.append(order)
        self.s.pending_buys = still_pending

    def _fill_buy(self, order: RestingBuy):
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(order.shares, order.price)
        cost = order.shares * order.price - rebate
        self._add_inventory(order.side, order.shares, cost)
        self.s.balance -= cost
        self.s.fills_this_window += 1
        self.s.total_fills += 1

        if self.s.first_side is None:
            self.s.first_side = order.side

        is_first_side = order.side == self.s.first_side
        tp_price = order.first_side_tp if is_first_side else config.OPPOSITE_TP

        self.broker.log_event(
            self.name, self.s.window.slug, "BUY", side=order.side.value, price=order.price,
            shares=order.shares, fee=-rebate, balance_after=self.s.balance,
            note=(f"ladder fill (maker): {order.side.value} {order.shares:.0f}sh @ {order.price} "
                  f"(rebate ${rebate:.4f}) -- {'FIRST side' if is_first_side else 'opposite side'}, "
                  f"TP set at {tp_price}"),
        )
        if self.s.balance < 0:
            self._halt()
            return

        self.s.pending_sells.append(RestingSell(
            side=order.side, tp_price=tp_price, shares=order.shares, entry_price=order.price,
        ))
        self.broker.log_event(
            self.name, self.s.window.slug, "TP_PLACED", side=order.side.value, price=tp_price,
            shares=order.shares, balance_after=self.s.balance,
            note=f"resting TP sell: {order.side.value} {order.shares:.0f}sh @ {tp_price} (entry {order.price})",
        )

    def _add_inventory(self, side: Side, shares: float, cost: float):
        if side == Side.UP:
            self.s.up_shares += shares
            self.s.up_cost += cost
        else:
            self.s.down_shares += shares
            self.s.down_cost += cost

    def _remove_inventory(self, side: Side, shares: float, cost: float):
        if side == Side.UP:
            self.s.up_shares -= shares
            self.s.up_cost -= cost
        else:
            self.s.down_shares -= shares
            self.s.down_cost -= cost

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
        cost_basis = order.shares * order.entry_price
        pnl = proceeds - cost_basis

        self._remove_inventory(order.side, order.shares, cost_basis)
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
        if self.s.balance < 0:
            self._halt()

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

        for order in self.s.pending_sells:
            self.broker.log_event(
                self.name, self.s.window.slug, "TP_EXPIRED", side=order.side.value, price=order.tp_price,
                shares=order.shares, balance_after=self.s.balance,
                note=(f"TP never hit, window closing: {order.side.value} {order.shares:.0f}sh "
                      f"(entry {order.entry_price}) rides to resolution instead"),
            )
        self.s.pending_sells = []

        if not self.s.halted:
            self._settle_leftover(Side.UP, winning_side)
            self._settle_leftover(Side.DOWN, winning_side)

            if self.s.fills_this_window == 0:
                self.s.no_trade_windows += 1
                self.broker.log_event(
                    self.name, self.s.window.slug, "NO_TRADE",
                    balance_after=self.s.balance,
                    note="ladder placed but never got hit this window -- no fills",
                )

        self._record_equity_point()
        self.s.window = None

    def _settle_leftover(self, side: Side, winning_side: Optional[Side]):
        shares = self.s.up_shares if side == Side.UP else self.s.down_shares
        cost = self.s.up_cost if side == Side.UP else self.s.down_cost
        if shares <= 1e-9:
            return
        won = winning_side is not None and side == winning_side
        proceeds = shares * (1.0 if won else 0.0)
        pnl = proceeds - cost
        self.s.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        if won:
            self.s.resolution_wins += 1
        else:
            self.s.resolution_losses += 1
        event = "RESOLVE_WIN" if won else "RESOLVE_LOSS"
        self.broker.log_event(
            self.name, self.s.window.slug, event, side=side.value, shares=shares, pnl=pnl,
            balance_after=self.s.balance,
            note=(f"leftover {side.value} inventory ({shares:.0f}sh, TP never hit) settled at resolution: "
                  f"{'won $1/sh' if won else 'lost, $0/sh'}"),
        )
        if side == Side.UP:
            self.s.up_shares, self.s.up_cost = 0.0, 0.0
        else:
            self.s.down_shares, self.s.down_cost = 0.0, 0.0
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

    def snapshot(self) -> dict:
        return {
            "balance": round(self.s.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.s.halted,
            "equity_curve": self.s.equity_curve[-150:],
            "total_pnl": self.s.total_pnl,
            "last_window_pnl": self.s.last_window_pnl,

            "ladder_placed": self.s.ladder_placed,
            "first_side": self.s.first_side.value if self.s.first_side else None,

            "up_shares": round(self.s.up_shares, 4),
            "up_avg_price": (self.s.up_cost / self.s.up_shares) if self.s.up_shares > 1e-9 else None,
            "down_shares": round(self.s.down_shares, 4),
            "down_avg_price": (self.s.down_cost / self.s.down_shares) if self.s.down_shares > 1e-9 else None,

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
                       ("open" if (self.s.up_shares > 1e-9 or self.s.down_shares > 1e-9
                                   or self.s.pending_buys or self.s.pending_sells) else
                        ("traded" if self.s.fills_this_window > 0 else "waiting"))),

            "def": {
                "ladder_levels": [{"price": p, "shares": s, "first_side_tp": tp} for p, s, tp in config.LADDER_LEVELS],
                "opposite_tp": config.OPPOSITE_TP,
            },
        }
