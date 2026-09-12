"""
Trading engine -- buy both sides immediately at window open, trail a
stop on each side independently once it moves into favor.

See app/config.py for the full strategy write-up. Summary: no cold
start, no arm/threshold ladder. The instant a window is live, buy
SHARES_PER_SIDE of BOTH tokens as taker orders. Each side then runs its
own completely independent trailing-stop: no SL until price first hits
0.60, then a stop at 0.50 that ratchets up by 0.10 every time price
climbs another 0.10. TP is a flat 0.99 for both sides throughout. All
entries and exits are taker orders, filled at the real bid/ask read at
the moment they fire.
"""
import time
from dataclasses import dataclass, field
from typing import Optional

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
    equity_curve: list = field(default_factory=list)

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
# Per-side position with its own independent trailing stop
# ---------------------------------------------------------------------------

@dataclass
class SidePosition:
    side: Side
    entry_price: float          # real ask paid at window open
    shares: float
    cost: float
    entry_ts: float

    trail_sl: Optional[float] = None   # None until this side's own price first hits TRAIL_ARM_PRICE
    last_trail_level: float = 0.0      # last TRAIL_ARM_PRICE + n*TRAIL_STEP level this side has reached


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    entries_done: bool = False   # both-side entry attempted/complete for this window
    up_position: Optional[SidePosition] = None
    down_position: Optional[SidePosition] = None

    fills_this_window: int = 0
    last_window_pnl: float = 0.0

    total_entries: int = 0
    total_tp_fills: int = 0
    total_sl_fills: int = 0
    total_trail_updates: int = 0
    total_forced_closes: int = 0
    no_trade_windows: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0


class Engine:
    """Dual-entry trailing-stop engine, driven off its own capital pool.
    Kept as the class name `Engine` / constructed the same way
    (Engine(broker)) so app/state.py doesn't need structural changes."""

    name = "TRAIL"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def reset_for_window(self, window: WindowMarket):
        self.s = EngineState(window=window)

        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return

        self._log("WINDOW_OPEN", note=(
            f"buying both sides immediately, {config.SHARES_PER_SIDE:.0f}sh each, taker -- "
            f"trailing stop arms per-side at {config.TRAIL_ARM_PRICE}, TP {config.TP_PRICE} for both"
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask

        if not self.s.entries_done:
            self._enter_both(now)

        self._check_side(Side.UP, now)
        self._check_side(Side.DOWN, now)

    # ---- entry: both sides, immediately, taker --------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _enter_both(self, now: float):
        """Fires each side's entry the first tick a live ask is available
        for it. If only one side has a quote yet, that side goes in and
        the other is retried next tick -- entries_done only flips once
        both are actually filled."""
        if self.s.up_position is None:
            self._fire_entry(Side.UP, now)
        if self.s.down_position is None:
            self._fire_entry(Side.DOWN, now)
        if self.s.up_position is not None and self.s.down_position is not None:
            self.s.entries_done = True

    def _fire_entry(self, side: Side, now: float):
        ask = self._ask_for(side)
        if ask is None:
            return  # no live ask yet -- retry next tick
        shares = config.SHARES_PER_SIDE
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        self.capital.balance -= cost
        self.s.total_entries += 1

        self._log("ENTRY_FILL", side=side.value, price=ask, shares=shares, fee=fee,
                   note=(f"window-open taker buy: {shares:.0f}sh @ real ask {ask} (fee ${fee:.4f}) -- "
                         f"no SL yet, arms at {config.TRAIL_ARM_PRICE}; TP {config.TP_PRICE}"))

        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return

        pos = SidePosition(side=side, entry_price=ask, shares=shares, cost=cost, entry_ts=now)
        if side == Side.UP:
            self.s.up_position = pos
        else:
            self.s.down_position = pos

    # ---- per-side: trail update, then SL/TP check -----------------------

    def _check_side(self, side: Side, now: float):
        pos = self.s.up_position if side == Side.UP else self.s.down_position
        if pos is None:
            return
        bid = self._bid_for(side)
        if bid is None:
            return

        if bid >= config.TP_PRICE:
            self._close(pos, price=bid, reason="TP_FILL", note_prefix="take profit hit")
            self.s.total_tp_fills += 1
            self._clear(side)
            return

        if pos.trail_sl is not None and bid <= pos.trail_sl:
            self._close(pos, price=bid, reason="SL_FILL", note_prefix="trailing stop hit")
            self.s.total_sl_fills += 1
            self._clear(side)
            return

        self._advance_trail(pos, bid)

    def _advance_trail(self, pos: SidePosition, bid: float):
        """Ratchets pos.trail_sl up every time price reaches a new
        TRAIL_ARM_PRICE + n*TRAIL_STEP level. Never moves down. Example
        with TRAIL_ARM_PRICE=0.60, TRAIL_STEP=0.10: price hits 0.60 ->
        SL 0.50; price hits 0.70 -> SL 0.60; price hits 0.80 -> SL 0.70."""
        next_level = pos.last_trail_level + config.TRAIL_STEP if pos.last_trail_level > 0 else config.TRAIL_ARM_PRICE
        moved = False
        while bid >= next_level:
            pos.last_trail_level = next_level
            new_sl = round(next_level - config.TRAIL_STEP, 4)
            if pos.trail_sl is None or new_sl > pos.trail_sl:
                pos.trail_sl = new_sl
            moved = True
            next_level = round(next_level + config.TRAIL_STEP, 4)
        if moved:
            self.s.total_trail_updates += 1
            self._log("TRAIL_UPDATE", side=pos.side.value, price=bid,
                       note=f"price reached {pos.last_trail_level:.2f} -- stop loss now {pos.trail_sl}")

    def _clear(self, side: Side):
        if side == Side.UP:
            self.s.up_position = None
        else:
            self.s.down_position = None

    def _close(self, pos: SidePosition, price: float, reason: str, note_prefix: str):
        fee = self.broker.taker_fee_amount(pos.shares, price)
        proceeds = pos.shares * price - fee
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        self.s.fills_this_window += 1
        if pnl >= 0:
            self.s.wins += 1
        else:
            self.s.losses += 1
        self._log(reason, side=pos.side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee,
                   note=(f"{note_prefix} (taker, real fill @ {price}): {pos.shares:.0f}sh sold "
                         f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted:
            for side, pos in ((Side.UP, self.s.up_position), (Side.DOWN, self.s.down_position)):
                if pos is None:
                    continue
                bid = self._bid_for(side)
                close_price = bid if bid is not None else pos.entry_price
                self._close(pos, price=close_price, reason="FORCED_CLOSE",
                            note_prefix="window closed, forced taker close")
                self.s.total_forced_closes += 1
                self._clear(side)

        if not self.capital.halted and self.s.total_entries == 0:
            self.s.no_trade_windows += 1
            self._log("NO_TRADE", note="never got a live ask to enter either side this window")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def _position_payload(self, pos: Optional[SidePosition], side: Side) -> Optional[dict]:
        if pos is None:
            return None
        now = time.time()
        bid = self._bid_for(side)
        mark = bid if bid is not None else pos.entry_price
        market_value = pos.shares * mark
        pos_pnl = market_value - pos.cost
        return {
            "side": pos.side.value, "entry_price": pos.entry_price, "shares": pos.shares,
            "cost": round(pos.cost, 4), "mark_price": mark,
            "unrealized_pnl": round(pos_pnl, 4), "seconds_since_entry": round(now - pos.entry_ts, 1),
            "trail_sl": pos.trail_sl, "trail_armed": pos.trail_sl is not None,
            "last_trail_level": pos.last_trail_level or None,
        }

    def snapshot(self) -> dict:
        up_payload = self._position_payload(self.s.up_position, Side.UP)
        down_payload = self._position_payload(self.s.down_position, Side.DOWN)
        open_positions = [p for p in (up_payload, down_payload) if p is not None]

        unrealized_pnl = sum(p["unrealized_pnl"] for p in open_positions)
        open_market_value = sum(p["shares"] * p["mark_price"] for p in open_positions)
        realized_pnl = round(self.s.total_pnl, 4)

        if self.capital.halted:
            status = "halted"
        elif open_positions:
            status = "open"
        elif self.s.entries_done:
            status = "closed"
        else:
            status = "entering"

        return {
            "engine": "TRAIL", "label": "Dual-entry trailing stop",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": realized_pnl,
            "unrealized_pnl": round(unrealized_pnl, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "up_position": up_payload,
            "down_position": down_payload,
            "open_positions": open_positions,

            "fills_this_window": self.s.fills_this_window,
            "total_entries": self.s.total_entries,
            "total_tp_fills": self.s.total_tp_fills,
            "total_sl_fills": self.s.total_sl_fills,
            "total_trail_updates": self.s.total_trail_updates,
            "total_forced_closes": self.s.total_forced_closes,
            "no_trade_windows": self.s.no_trade_windows,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,

            "def": {
                "shares_per_side": config.SHARES_PER_SIDE,
                "trail_arm_price": config.TRAIL_ARM_PRICE,
                "trail_step": config.TRAIL_STEP,
                "tp_price": config.TP_PRICE,
            },
        }
