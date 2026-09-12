"""
Trading engine -- ladder breakout with immediate at-mid limit entries.

See app/config.py for the full strategy write-up. Summary: sit out the
first minute of each window, then watch for either side to break 0.65.
Once armed, place a resting limit buy right at the current mid the
instant price climbs through each threshold (0.65/0.75/0.85). Each fill
is its own 100-share position with a shared SL (0.50) and TP (0.99).
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


# ---------------------------------------------------------------------------
# Shared capital -- single balance the engine debits/credits.
# ---------------------------------------------------------------------------

@dataclass
class CapitalPool:
    balance: float
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)

    def record_equity_point(self, window_slug: Optional[str]):
        self.equity_curve.append({
            "window": window_slug, "ts": time.time(), "balance": round(self.balance, 2),
        })
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    def check_halt(self) -> bool:
        if not self.halted and self.balance < 0:
            self.halted = True
        return self.halted


# ---------------------------------------------------------------------------
# Ladder breakout engine
# ---------------------------------------------------------------------------

@dataclass
class RestingOrder:
    threshold: float      # the price level whose crossing placed this rung
    limit_price: float    # placed at the mid price when this rung's threshold was crossed
    shares: float
    placed_ts: float


@dataclass
class LadderPosition:
    threshold: float
    entry_price: float
    shares: float
    cost: float
    entry_ts: float


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    armed_side: Optional[Side] = None
    next_threshold_idx: int = 0
    resting_orders: List[RestingOrder] = field(default_factory=list)
    positions: List[LadderPosition] = field(default_factory=list)

    fills_this_window: int = 0
    last_window_pnl: float = 0.0

    total_rungs_placed: int = 0
    total_fills: int = 0
    total_tp_fills: int = 0
    total_sl_fills: int = 0
    total_forced_closes: int = 0
    total_cancelled_rungs: int = 0
    no_trade_windows: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0


class Engine:
    """Ladder breakout / pullback limit entries, driven off its own
    capital pool. Kept as the class name `Engine` / constructed the same
    way (Engine(broker)) so app/state.py doesn't need structural
    changes."""

    name = "LADDER"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.armed_side = None
        self.s.next_threshold_idx = 0
        self.s.resting_orders = []
        self.s.positions = []
        self.s.fills_this_window = 0
        self.s.last_window_pnl = 0.0

        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return

        self._log("WINDOW_OPEN", note=(
            f"cold start for {config.LADDER_ARM_DELAY_SECONDS}s, then watching for either side "
            f"to reach {config.LADDER_THRESHOLDS[0]}"
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask

        if now - self.s.window.open_ts < config.LADDER_ARM_DELAY_SECONDS:
            return  # cold start -- do nothing at all yet

        if self.s.armed_side is None:
            self._check_arm(now)
        else:
            self._check_ladder_extend(now)
            self._check_rung_fills(now)
            self._check_exits(now)

    # ---- arm: first side to cross the first threshold -----------------------

    def _check_arm(self, now: float):
        up_mid = _midpoint(self.s.up_bid, self.s.up_ask)
        down_mid = _midpoint(self.s.down_bid, self.s.down_ask)
        first_threshold = config.LADDER_THRESHOLDS[0]
        # deterministic tie-break: UP checked first if both cross the same tick
        if up_mid is not None and up_mid >= first_threshold:
            self._arm(Side.UP, now)
        elif down_mid is not None and down_mid >= first_threshold:
            self._arm(Side.DOWN, now)

    def _arm(self, side: Side, now: float):
        self.s.armed_side = side
        mid = self._armed_mid()
        self._log("ARMED", side=side.value, price=mid,
                   note=f"{side.value} reached {config.LADDER_THRESHOLDS[0]} -- watching this side only from here")
        self._place_rung(config.LADDER_THRESHOLDS[0], mid, now)
        self.s.next_threshold_idx = 1

    # ---- ladder: place a new resting rung each time price climbs a step -----

    def _armed_mid(self) -> Optional[float]:
        if self.s.armed_side == Side.UP:
            return _midpoint(self.s.up_bid, self.s.up_ask)
        return _midpoint(self.s.down_bid, self.s.down_ask)

    def _armed_ask(self) -> Optional[float]:
        return self.s.up_ask if self.s.armed_side == Side.UP else self.s.down_ask

    def _armed_bid(self) -> Optional[float]:
        return self.s.up_bid if self.s.armed_side == Side.UP else self.s.down_bid

    def _check_ladder_extend(self, now: float):
        mid = self._armed_mid()
        if mid is None:
            return
        while self.s.next_threshold_idx < len(config.LADDER_THRESHOLDS) and \
                mid >= config.LADDER_THRESHOLDS[self.s.next_threshold_idx]:
            self._place_rung(config.LADDER_THRESHOLDS[self.s.next_threshold_idx], mid, now)
            self.s.next_threshold_idx += 1

    def _place_rung(self, threshold: float, mid_price: float, now: float):
        limit_price = round(mid_price, 4)  # placed immediately at the current mid, no offset
        order = RestingOrder(threshold=threshold, limit_price=limit_price,
                              shares=config.LADDER_SHARES_PER_RUNG, placed_ts=now)
        self.s.resting_orders.append(order)
        self.s.total_rungs_placed += 1
        self._log("RUNG_PLACED", side=self.s.armed_side.value, price=limit_price,
                   shares=order.shares,
                   note=f"{self.s.armed_side.value} crossed {threshold} -- resting limit buy "
                        f"{order.shares:.0f}sh @ {limit_price} (placed at current mid)")

    # ---- fills: resting buy fills when the ask pulls back to/through it ----

    def _check_rung_fills(self, now: float):
        ask = self._armed_ask()
        if ask is None or not self.s.resting_orders:
            return
        still_resting = []
        for order in self.s.resting_orders:
            if ask <= order.limit_price:
                self._fill_rung(order, now)
            else:
                still_resting.append(order)
        self.s.resting_orders = still_resting

    def _fill_rung(self, order: RestingOrder, now: float):
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(order.shares, order.limit_price)
        cost = order.shares * order.limit_price - rebate
        self.capital.balance -= cost
        self.s.fills_this_window += 1
        self.s.total_fills += 1

        self._log("RUNG_FILL", side=self.s.armed_side.value, price=order.limit_price, shares=order.shares,
                   fee=-rebate,
                   note=(f"pullback to {order.limit_price} filled the {order.threshold} rung -- "
                         f"{order.shares:.0f}sh @ {order.limit_price} (rebate ${rebate:.4f}) -- "
                         f"TP {config.LADDER_TP_PRICE}, SL {config.LADDER_SL_PRICE}"))
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return

        self.s.positions.append(LadderPosition(
            threshold=order.threshold, entry_price=order.limit_price,
            shares=order.shares, cost=cost, entry_ts=now,
        ))

    # ---- exits: SL (taker) or TP (maker), independent per position ---------

    def _check_exits(self, now: float):
        if not self.s.positions:
            return
        bid = self._armed_bid()
        if bid is None:
            return
        still_open = []
        for pos in self.s.positions:
            if bid <= config.LADDER_SL_PRICE:
                self._close_taker(pos, price=bid, reason="SL_FILL", note_prefix="stop loss hit")
                self.s.total_sl_fills += 1
            elif bid >= config.LADDER_TP_PRICE:
                self._close_maker(pos, price=config.LADDER_TP_PRICE, reason="TP_FILL", note_prefix="TP hit")
                self.s.total_tp_fills += 1
            else:
                still_open.append(pos)
        self.s.positions = still_open

    def _close_maker(self, pos: LadderPosition, price: float, reason: str, note_prefix: str):
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(pos.shares, price)
        proceeds = pos.shares * price + rebate
        pnl = proceeds - pos.cost
        self._settle(pos, proceeds, pnl, reason, fee=rebate,
                      note=f"{note_prefix} (maker): rung {pos.threshold} {pos.shares:.0f}sh sold @ {price} "
                           f"(entry {pos.entry_price}, rebate ${rebate:.4f}, pnl ${pnl:.4f})")

    def _close_taker(self, pos: LadderPosition, price: float, reason: str, note_prefix: str):
        fee = self.broker.taker_fee_amount(pos.shares, price)
        proceeds = pos.shares * price - fee
        pnl = proceeds - pos.cost
        self._settle(pos, proceeds, pnl, reason, fee=fee,
                      note=f"{note_prefix} (taker): rung {pos.threshold} {pos.shares:.0f}sh sold @ {price} "
                           f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})")

    def _settle(self, pos: LadderPosition, proceeds: float, pnl: float, reason: str, fee: float, note: str):
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        if pnl >= 0:
            self.s.wins += 1
        else:
            self.s.losses += 1
        self._log(reason, side=self.s.armed_side.value if self.s.armed_side else None,
                   price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee, note=note)
        self.capital.check_halt()

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted and self.s.resting_orders:
            for order in self.s.resting_orders:
                self.s.total_cancelled_rungs += 1
                self._log("RUNG_CANCELLED", side=self.s.armed_side.value if self.s.armed_side else None,
                           price=order.limit_price,
                           note=f"window closed -- cancelling unfilled {order.threshold} rung @ {order.limit_price}")
            self.s.resting_orders = []

        if not self.capital.halted and self.s.positions:
            bid = self._armed_bid()
            for pos in list(self.s.positions):
                close_price = bid if bid is not None else pos.entry_price
                self._close_taker(pos, price=close_price, reason="FORCED_CLOSE",
                                   note_prefix="window closed, forced taker close")
                self.s.total_forced_closes += 1
            self.s.positions = []

        if not self.capital.halted and self.s.armed_side is None:
            self.s.no_trade_windows += 1
            self._log("NO_TRADE", note=f"price never reached {config.LADDER_THRESHOLDS[0]} this window -- never armed")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        now = time.time()
        bid = self._armed_bid() if self.s.armed_side else None

        resting_orders = [{
            "threshold": o.threshold, "limit_price": o.limit_price, "shares": o.shares,
            "seconds_resting": round(now - o.placed_ts, 1),
        } for o in self.s.resting_orders]

        open_positions = []
        unrealized_pnl = 0.0
        open_market_value = 0.0
        for pos in self.s.positions:
            mark = bid if bid is not None else pos.entry_price
            market_value = pos.shares * mark
            pos_pnl = market_value - pos.cost
            unrealized_pnl += pos_pnl
            open_market_value += market_value
            open_positions.append({
                "threshold": pos.threshold, "entry_price": pos.entry_price, "shares": pos.shares,
                "cost": round(pos.cost, 4), "mark_price": mark, "unrealized_pnl": round(pos_pnl, 4),
                "seconds_since_entry": round(now - pos.entry_ts, 1),
            })

        realized_pnl = round(self.s.total_pnl, 4)
        next_threshold = (config.LADDER_THRESHOLDS[self.s.next_threshold_idx]
                           if self.s.next_threshold_idx < len(config.LADDER_THRESHOLDS) else None)

        if self.capital.halted:
            status = "halted"
        elif self.s.positions:
            status = "open"
        elif self.s.resting_orders:
            status = "resting"
        elif self.s.armed_side:
            status = "armed"
        else:
            status = "waiting"

        return {
            "engine": "LADDER", "label": "Ladder breakout 0.65 / 0.75 / 0.85",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": realized_pnl,
            "unrealized_pnl": round(unrealized_pnl, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "armed_side": self.s.armed_side.value if self.s.armed_side else None,
            "next_threshold": next_threshold,
            "resting_orders": resting_orders,
            "open_positions": open_positions,

            "fills_this_window": self.s.fills_this_window,
            "total_rungs_placed": self.s.total_rungs_placed,
            "total_fills": self.s.total_fills,
            "total_tp_fills": self.s.total_tp_fills,
            "total_sl_fills": self.s.total_sl_fills,
            "total_forced_closes": self.s.total_forced_closes,
            "total_cancelled_rungs": self.s.total_cancelled_rungs,
            "no_trade_windows": self.s.no_trade_windows,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,

            "def": {
                "arm_delay_seconds": config.LADDER_ARM_DELAY_SECONDS,
                "thresholds": config.LADDER_THRESHOLDS,
                "sl_price": config.LADDER_SL_PRICE,
                "tp_price": config.LADDER_TP_PRICE,
                "shares_per_rung": config.LADDER_SHARES_PER_RUNG,
            },
        }
