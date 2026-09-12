"""
Trading engine -- ladder breakout with immediate taker entries.

See app/config.py for the full strategy write-up. Summary: sit out the
first minute of each window, then watch for either side to break 0.65.
Once armed, fire an immediate taker buy the instant price climbs through
each threshold (0.65/0.75/0.85) -- no resting orders, so every rung is
guaranteed to fill (subject to the fee spent to guarantee it). The real
best-ask price at the moment of firing is what actually gets paid, not
the mid price that triggered the threshold. Each fill is its own share
position with a shared SL (0.50) and TP (0.99). Every stop-loss hit
doubles the size used for every rung placed for the rest of the window
(cumulative -- a second SL doubles again, on top of the first).
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
class LadderPosition:
    side: Side             # recorded at fill time -- stays fixed even if the engine later rearms onto the other side
    threshold: float
    entry_price: float     # the REAL ask the taker buy actually paid, not the mid that triggered it
    trigger_mid: float     # the mid price that crossed the threshold, kept for reference/logging only
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
    positions: List[LadderPosition] = field(default_factory=list)

    shares_per_rung: float = 0.0  # set from config in reset_for_window; doubles every time a SL fires
    rearms_this_window: int = 0

    fills_this_window: int = 0
    last_window_pnl: float = 0.0

    total_rungs_placed: int = 0
    total_fills: int = 0
    total_tp_fills: int = 0
    total_sl_fills: int = 0
    total_forced_closes: int = 0
    total_cancelled_rungs: int = 0
    total_rearms: int = 0
    no_trade_windows: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0


class Engine:
    """Ladder breakout / taker entries, driven off its own capital pool.
    Kept as the class name `Engine` / constructed the same way
    (Engine(broker)) so app/state.py doesn't need structural changes."""

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
        self.s.positions = []
        self.s.shares_per_rung = config.LADDER_SHARES_PER_RUNG
        self.s.rearms_this_window = 0
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

        # Exits run every tick regardless of arm state -- a rearm can leave
        # positions open on a side that's no longer the (new) armed side,
        # and those still need their own SL/TP watched every tick.
        self._check_exits(now)

        if self.s.armed_side is None:
            self._check_arm(now)
        else:
            self._check_ladder_extend(now)

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
        self._fire_entry(config.LADDER_THRESHOLDS[0], mid, now)
        self.s.next_threshold_idx = 1

    # ---- ladder: fire an immediate taker buy each time price climbs a step --

    def _armed_mid(self) -> Optional[float]:
        if self.s.armed_side == Side.UP:
            return _midpoint(self.s.up_bid, self.s.up_ask)
        return _midpoint(self.s.down_bid, self.s.down_ask)

    def _armed_ask(self) -> Optional[float]:
        return self.s.up_ask if self.s.armed_side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _check_ladder_extend(self, now: float):
        mid = self._armed_mid()
        if mid is None:
            return
        while self.s.next_threshold_idx < len(config.LADDER_THRESHOLDS) and \
                mid >= config.LADDER_THRESHOLDS[self.s.next_threshold_idx]:
            self._fire_entry(config.LADDER_THRESHOLDS[self.s.next_threshold_idx], mid, now)
            self.s.next_threshold_idx += 1

    def _fire_entry(self, threshold: float, trigger_mid: float, now: float):
        """Taker buy, fired the instant the threshold is crossed. Filled at
        the REAL best ask from the book (self._armed_ask()), not the mid
        that triggered it -- that ask is checked fresh right here so the
        recorded entry price is the realistic fill, not an assumption."""
        ask = self._armed_ask()
        if ask is None:
            # no live ask to fill against yet -- skip this tick, the ladder
            # extend loop will retry crossing this same threshold next tick
            self._log("RUNG_SKIPPED", side=self.s.armed_side.value, price=trigger_mid,
                       note=f"{threshold} crossed but no live ask to fill a taker buy against -- waiting for a quote")
            self.s.next_threshold_idx -= 0  # no-op, kept for clarity: idx is only advanced by the caller on success
            return

        shares = self.s.shares_per_rung
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        self.capital.balance -= cost
        self.s.fills_this_window += 1
        self.s.total_fills += 1
        self.s.total_rungs_placed += 1

        slip = round(ask - trigger_mid, 4)
        self._log("RUNG_FILL", side=self.s.armed_side.value, price=ask, shares=shares, fee=fee,
                   note=(f"{threshold} rung, taker buy: {shares:.0f}sh @ real ask {ask} "
                         f"(crossed at mid {trigger_mid}, slippage {slip:+.4f}, fee ${fee:.4f}) -- "
                         f"TP {config.LADDER_TP_PRICE}, SL {config.LADDER_SL_PRICE}"))

        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return

        self.s.positions.append(LadderPosition(
            side=self.s.armed_side, threshold=threshold, entry_price=ask, trigger_mid=trigger_mid,
            shares=shares, cost=cost, entry_ts=now,
        ))

    # ---- exits: SL and TP, both taker, independent per position -------------

    def _check_exits(self, now: float):
        if not self.s.positions:
            return
        still_open = []
        for pos in self.s.positions:
            bid = self._bid_for(pos.side)
            if bid is None:
                still_open.append(pos)
                continue
            if bid <= config.LADDER_SL_PRICE:
                self._close_taker(pos, price=bid, reason="SL_FILL", note_prefix="stop loss hit")
                self.s.total_sl_fills += 1
                # Every SL hit rearms -- not just the first one in a window.
                self._rearm(now)
            elif bid >= config.LADDER_TP_PRICE:
                # taker sell at the REAL current bid (not the 0.99 target
                # itself) -- that bid is what a market sell actually fills at
                self._close_taker(pos, price=bid, reason="TP_FILL", note_prefix="take profit hit")
                self.s.total_tp_fills += 1
            else:
                still_open.append(pos)
        self.s.positions = still_open

    def _rearm(self, now: float):
        """Fires on EVERY stop loss hit in a window (not just the first):
        cancel nothing (there's nothing resting to cancel -- entries fire
        instantly now), forget which side was armed so the engine watches
        both sides again from scratch, and double the per-rung size for
        everything placed from here on. This compounds: 2nd SL in the same
        window doubles again on top of the first, etc. The SL/TP price
        levels themselves (config.LADDER_SL_PRICE / LADDER_TP_PRICE) never
        change with size -- every rung, at any size, shares the exact same
        stop loss and take profit."""
        self.s.rearms_this_window += 1
        self.s.total_rearms += 1

        self.s.armed_side = None
        self.s.next_threshold_idx = 0
        self.s.shares_per_rung = self.s.shares_per_rung * 2

        self._log("REARMED", note=(
            f"stop loss hit -- rearming to watch either side again, now {self.s.shares_per_rung:.0f}sh/rung "
            f"({self.s.rearms_this_window} rearm(s) this window, {2 ** self.s.rearms_this_window:.0f}x base size) "
            f"-- SL stays {config.LADDER_SL_PRICE} / TP stays {config.LADDER_TP_PRICE} for these too"
        ))

    def _close_taker(self, pos: LadderPosition, price: float, reason: str, note_prefix: str):
        fee = self.broker.taker_fee_amount(pos.shares, price)
        proceeds = pos.shares * price - fee
        pnl = proceeds - pos.cost
        self._settle(pos, proceeds, pnl, reason, fee=fee,
                      note=f"{note_prefix} (taker, real fill @ {price}): rung {pos.threshold} {pos.shares:.0f}sh sold "
                           f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})")

    def _settle(self, pos: LadderPosition, proceeds: float, pnl: float, reason: str, fee: float, note: str):
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        if pnl >= 0:
            self.s.wins += 1
        else:
            self.s.losses += 1
        self._log(reason, side=pos.side.value,
                   price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee, note=note)
        self.capital.check_halt()

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted and self.s.positions:
            for pos in list(self.s.positions):
                bid = self._bid_for(pos.side)
                close_price = bid if bid is not None else pos.entry_price
                self._close_taker(pos, price=close_price, reason="FORCED_CLOSE",
                                   note_prefix="window closed, forced taker close")
                self.s.total_forced_closes += 1
            self.s.positions = []

        if not self.capital.halted and self.s.fills_this_window == 0:
            self.s.no_trade_windows += 1
            self._log("NO_TRADE", note=f"price never reached {config.LADDER_THRESHOLDS[0]} this window -- never armed")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        now = time.time()

        open_positions = []
        unrealized_pnl = 0.0
        open_market_value = 0.0
        for pos in self.s.positions:
            bid = self._bid_for(pos.side)
            mark = bid if bid is not None else pos.entry_price
            market_value = pos.shares * mark
            pos_pnl = market_value - pos.cost
            unrealized_pnl += pos_pnl
            open_market_value += market_value
            open_positions.append({
                "side": pos.side.value, "threshold": pos.threshold, "entry_price": pos.entry_price,
                "shares": pos.shares, "cost": round(pos.cost, 4), "mark_price": mark,
                "unrealized_pnl": round(pos_pnl, 4), "seconds_since_entry": round(now - pos.entry_ts, 1),
            })

        realized_pnl = round(self.s.total_pnl, 4)
        next_threshold = (config.LADDER_THRESHOLDS[self.s.next_threshold_idx]
                           if self.s.next_threshold_idx < len(config.LADDER_THRESHOLDS) else None)

        if self.capital.halted:
            status = "halted"
        elif self.s.positions:
            status = "open"
        elif self.s.armed_side:
            status = "armed"
        elif self.s.rearms_this_window:
            status = "rearmed"
        else:
            status = "waiting"

        return {
            "engine": "LADDER", "label": "Ladder breakout 0.65 / 0.75 / 0.85 (taker)",

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
            "resting_orders": [],  # kept for API/dashboard compatibility -- taker fills are instant, nothing ever rests
            "open_positions": open_positions,

            "rearm_used": self.s.rearms_this_window > 0,
            "rearms_this_window": self.s.rearms_this_window,
            "current_shares_per_rung": self.s.shares_per_rung,

            "fills_this_window": self.s.fills_this_window,
            "total_rungs_placed": self.s.total_rungs_placed,
            "total_fills": self.s.total_fills,
            "total_tp_fills": self.s.total_tp_fills,
            "total_sl_fills": self.s.total_sl_fills,
            "total_forced_closes": self.s.total_forced_closes,
            "total_cancelled_rungs": self.s.total_cancelled_rungs,
            "total_rearms": self.s.total_rearms,
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
                "rearm_shares_per_rung": config.LADDER_SHARES_PER_RUNG * 2,
            },
        }
