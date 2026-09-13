"""
Chop engine -- independent per-side range trade. A second, separate
strategy that runs alongside the trailing-stop engine (engine.py),
sharing the same PaperBroker (so events interleave in one log) but with
its own capital pool so P&L is directly comparable, not mixed with
TRAIL's.

See app/config.py's CHOP_* knobs for the tunable levels and the full
rationale. Summary:

  - UP and DOWN are two completely independent state machines. Either,
    both, or neither can be holding a position at the same time -- there
    is no shared "one position across both sides" constraint like the
    TRAIL engine has.
  - Entry: buy CHOP_SHARES_PER_ENTRY shares (taker, real depth-weighted
    price) when that side's mid pulls back into a band around
    CHOP_BUY_PRICE (0.40) -- [0.40 - CHOP_ENTRY_MAX_CHASE, 0.40 +
    CHOP_ENTRY_MAX_CHASE]. The band is symmetric (unlike TRAIL's
    one-sided band) because 0.40 can be approached from either
    direction. A gap straight through the band, in either direction, is
    skipped -- no chase -- and that side keeps watching for a real
    pullback into the band.
  - Exit: fixed absolute levels, not relative to entry -- take profit at
    CHOP_TP_PRICE (0.60), stop loss at CHOP_SL_PRICE (0.20).
  - Re-arm: EITHER exit (SL or TP) re-arms that side to watch for the
    next pullback to 0.40. Unlike TRAIL, a TP does not end trading for
    the window -- "multiple entry allowed after sold if price comes back
    to 0.40" applies after both kinds of exit here.
  - Same window-open entry lockout (CHOP_ENTRY_LOCKOUT_SECONDS) and
    pre-close time-based force-sell (CHOP_FORCE_SELL_AFTER_SECONDS)
    safety nets as TRAIL, applied independently per side.
  - All fills are taker orders, priced by walking real order-book depth
    (same approach as Engine._realistic_fill_price in engine.py,
    duplicated here as a static helper to keep this module
    self-contained).
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


@dataclass
class SessionStats:
    """Lifetime, persists across windows -- see the identical rationale
    in engine.py's SessionStats. Never reset by reset_for_window()."""
    total_entries: int = 0
    total_rearms: int = 0
    total_tp_fills: int = 0
    total_sl_fills: int = 0
    total_forced_closes: int = 0
    total_time_force_closes: int = 0
    total_illiquid_skips: int = 0
    no_trade_windows: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0


@dataclass
class Position:
    side: Side
    entry_price: float          # real depth-weighted fill, not just top-of-book ask
    shares: float
    cost: float
    entry_ts: float


@dataclass
class SideState:
    """Per-side (UP or DOWN), per-window transient state."""
    position: Optional[Position] = None
    entries_this_window: int = 0
    fills_this_window: int = 0
    # True while mid is currently outside the entry band -- used to log
    # the "not chasing" note once per overshoot episode, not every tick.
    chasing: bool = False


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    up: SideState = field(default_factory=SideState)
    down: SideState = field(default_factory=SideState)

    last_window_pnl: float = 0.0


class ChopEngine:
    """Independent per-side range-trade engine. See module docstring."""

    name = "CHOP"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.CHOP_STARTING_CAPITAL)
        self.stats = SessionStats()
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
            f"watching UP and DOWN independently -- buy on a pullback to {config.CHOP_BUY_PRICE} "
            f"({config.CHOP_SHARES_PER_ENTRY:.0f}sh, taker), SL {config.CHOP_SL_PRICE}, "
            f"TP {config.CHOP_TP_PRICE} -- either exit re-arms that side to watch again"
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None,
                now: Optional[float] = None,
                up_bid_levels: Optional[list] = None, up_ask_levels: Optional[list] = None,
                down_bid_levels: Optional[list] = None, down_ask_levels: Optional[list] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()

        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        self.s.up_bid_levels, self.s.up_ask_levels = up_bid_levels, up_ask_levels
        self.s.down_bid_levels, self.s.down_ask_levels = down_bid_levels, down_ask_levels

        self._tick_side(Side.UP, self.s.up, now)
        self._tick_side(Side.DOWN, self.s.down, now)

    def _elapsed_since_open(self, now: float) -> float:
        return now - self.s.window.open_ts

    def _mid_for(self, side: Side) -> Optional[float]:
        return _midpoint(self.s.up_bid, self.s.up_ask) if side == Side.UP else _midpoint(self.s.down_bid, self.s.down_ask)

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    @staticmethod
    def _realistic_fill_price(levels: Optional[list], shares_needed: float, fallback_price: Optional[float]) -> Optional[float]:
        """Walk order-book depth for `shares_needed` size; if depth
        doesn't cover it, price the shortfall at the worst level seen.
        None levels = no depth data this tick (fall back to the scalar
        price); empty levels = confirmed empty book (returns None, a
        real no-liquidity signal for the caller to handle)."""
        if levels is None:
            return fallback_price
        if not levels:
            return None
        remaining = shares_needed
        cost = 0.0
        worst_price = levels[0][0]
        for price, size in levels:
            worst_price = price
            take = min(remaining, size)
            cost += take * price
            remaining -= take
            if remaining <= 0:
                break
        if remaining > 0:
            cost += remaining * worst_price
        return cost / shares_needed if shares_needed else None

    # ---- per-side tick: entry or exit, never both in the same tick ---------

    def _tick_side(self, side: Side, ss: SideState, now: float):
        if ss.position is not None:
            self._check_exit(side, ss, now)
            return

        if self._elapsed_since_open(now) < config.CHOP_ENTRY_LOCKOUT_SECONDS:
            return

        mid = self._mid_for(side)
        if mid is None:
            return

        band_lo = round(config.CHOP_BUY_PRICE - config.CHOP_ENTRY_MAX_CHASE, 4)
        band_hi = round(config.CHOP_BUY_PRICE + config.CHOP_ENTRY_MAX_CHASE, 4)

        if band_lo <= mid <= band_hi:
            ss.chasing = False
            self._enter(side, ss, now)
        elif not ss.chasing:
            ss.chasing = True
            self._log("NO_ENTRY_CHASE", side=side.value, price=mid,
                       note=(f"{side.value} mid at {mid:.4f}, outside the {band_lo:.2f}-{band_hi:.2f} "
                             f"entry band around {config.CHOP_BUY_PRICE} -- not chasing, waiting for "
                             f"a pullback into the band"))

    def _enter(self, side: Side, ss: SideState, now: float):
        ask = self._ask_for(side)
        if ask is None:
            return
        shares = config.CHOP_SHARES_PER_ENTRY
        levels = self._ask_levels_for(side)
        fill_price = self._realistic_fill_price(levels, shares, ask)
        if fill_price is None:
            self.stats.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=side.value, price=ask,
                       note=f"{side.value} pulled back to {config.CHOP_BUY_PRICE} but book has zero ask depth -- waiting")
            return

        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        self.stats.total_entries += 1
        ss.entries_this_window += 1
        ss.position = Position(side=side, entry_price=fill_price, shares=shares, cost=cost, entry_ts=now)

        slip_note = ""
        if abs(fill_price - config.CHOP_BUY_PRICE) > 1e-9:
            slip_note = f" (near {config.CHOP_BUY_PRICE}, book-depth-weighted real fill {fill_price:.4f})"
        self._log("ENTRY_FILL", side=side.value, price=fill_price, shares=shares, fee=fee,
                   note=(f"{side.value} pulled back to {config.CHOP_BUY_PRICE} -- taker buy {shares:.0f}sh "
                         f"@ real fill {fill_price:.4f}{slip_note} (fee ${fee:.4f}) -- "
                         f"SL {config.CHOP_SL_PRICE}, TP {config.CHOP_TP_PRICE}"))

    # ---- exit ----------------------------------------------------------------

    def _check_exit(self, side: Side, ss: SideState, now: float):
        bid = self._bid_for(side)
        if bid is None:
            return

        if bid >= config.CHOP_TP_PRICE:
            self._try_close(side, ss, trigger_bid=bid, reason="TP_FILL",
                             note_prefix="take profit hit", now=now)
            return

        if self._elapsed_since_open(now) >= config.CHOP_FORCE_SELL_AFTER_SECONDS:
            self._try_close(side, ss, trigger_bid=bid, reason="TIME_FORCE_CLOSE",
                             note_prefix=(f"neither TP nor SL hit by "
                                          f"{config.CHOP_FORCE_SELL_AFTER_SECONDS:.0f}s into the window -- forced close"),
                             now=now)
            return

        if bid <= config.CHOP_SL_PRICE:
            self._try_close(side, ss, trigger_bid=bid, reason="SL_FILL",
                             note_prefix="stop loss hit", now=now)
            return

    def _try_close(self, side: Side, ss: SideState, trigger_bid: float, reason: str, note_prefix: str, now: float):
        pos = ss.position
        levels = self._bid_levels_for(side)
        fill_price = self._realistic_fill_price(levels, pos.shares, trigger_bid)
        if fill_price is None:
            # confirmed empty book -- can't close yet, keep waiting for depth
            self.stats.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=side.value, price=trigger_bid,
                       note=f"{side.value} {reason} triggered but book has zero bid depth -- waiting for depth to return")
            return

        if reason == "TP_FILL":
            self.stats.total_tp_fills += 1
        elif reason == "TIME_FORCE_CLOSE":
            self.stats.total_time_force_closes += 1
        else:
            self.stats.total_sl_fills += 1

        self._close(side, pos, price=fill_price, reason=reason, note_prefix=note_prefix, trigger_price=trigger_bid)
        ss.position = None

        # Always re-arms -- both SL and TP go back to watching for the next
        # pullback to CHOP_BUY_PRICE ("multiple entry allowed after sold if
        # price comes back to 0.40" applies to both exit types here).
        self.stats.total_rearms += 1
        self._log("REARMED", side=side.value,
                   note=f"{side.value} closed out -- watching for the next pullback to {config.CHOP_BUY_PRICE}")

    def _close(self, side: Side, pos: Position, price: float, reason: str, note_prefix: str,
               trigger_price: Optional[float] = None):
        fee = self.broker.taker_fee_amount(pos.shares, price)
        proceeds = pos.shares * price - fee
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.stats.total_pnl += pnl
        self.s.last_window_pnl += pnl
        ss = self.s.up if side == Side.UP else self.s.down
        ss.fills_this_window += 1
        if pnl >= 0:
            self.stats.wins += 1
        else:
            self.stats.losses += 1
        slip_note = ""
        if trigger_price is not None and abs(price - trigger_price) > 1e-9:
            slip_note = f" (triggered @ {trigger_price}, book-depth-weighted real fill {price:.4f})"
        self._log(reason, side=side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee,
                   note=(f"{note_prefix} (taker, real fill @ {price:.4f}{slip_note}): {pos.shares:.0f}sh sold "
                         f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()

    # ---- window close ----------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        for side, ss in ((Side.UP, self.s.up), (Side.DOWN, self.s.down)):
            if self.capital.halted or ss.position is None:
                continue
            pos = ss.position
            bid = self._bid_for(side)
            levels = self._bid_levels_for(side)
            fill_price = self._realistic_fill_price(levels, pos.shares, bid)
            if fill_price is None and levels is not None:
                fill_price = 0.0
                self._log("NO_LIQUIDITY", side=side.value, price=bid,
                           note="window closed with zero bid depth on this side -- assuming worst case $0, not entry price")
            elif fill_price is None:
                fill_price = pos.entry_price
                self._log("NO_LIQUIDITY", side=side.value, price=bid,
                           note="window closed with no book data at all on this side -- falling back to entry price, not a confirmed $0")
            self._close(side, pos, price=fill_price, reason="FORCED_CLOSE",
                        note_prefix="window closed, forced taker close", trigger_price=bid)
            self.stats.total_forced_closes += 1
            ss.position = None

        if not self.capital.halted and self.s.up.entries_this_window == 0 and self.s.down.entries_this_window == 0:
            self.stats.no_trade_windows += 1
            self._log("NO_TRADE", note=f"price never pulled back to {config.CHOP_BUY_PRICE} on either side this window")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload ---------------------------------------------------

    def _position_payload(self, side: Side, ss: SideState) -> Optional[dict]:
        pos = ss.position
        if pos is None:
            return None
        now = time.time()
        bid = self._bid_for(side)
        mark = bid if bid is not None else pos.entry_price
        market_value = pos.shares * mark
        pos_pnl = market_value - pos.cost
        return {
            "side": side.value, "entry_price": pos.entry_price, "shares": pos.shares,
            "cost": round(pos.cost, 4), "mark_price": mark,
            "unrealized_pnl": round(pos_pnl, 4), "seconds_since_entry": round(now - pos.entry_ts, 1),
        }

    def snapshot(self) -> dict:
        up_payload = self._position_payload(Side.UP, self.s.up) if self.s.window else None
        down_payload = self._position_payload(Side.DOWN, self.s.down) if self.s.window else None
        open_positions = [p for p in (up_payload, down_payload) if p]

        unrealized_pnl = sum(p["unrealized_pnl"] for p in open_positions)
        open_market_value = sum(p["shares"] * p["mark_price"] for p in open_positions)
        realized_pnl = round(self.stats.total_pnl, 4)

        now = time.time()
        elapsed_since_open = self._elapsed_since_open(now) if self.s.window is not None else None
        in_lockout = elapsed_since_open is not None and elapsed_since_open < config.CHOP_ENTRY_LOCKOUT_SECONDS

        if self.capital.halted:
            status = "halted"
        elif open_positions:
            status = "open"
        elif in_lockout:
            status = "lockout"
        else:
            status = "watching"

        return {
            "engine": "CHOP", "label": "Independent chop range-trade",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.CHOP_STARTING_CAPITAL,
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

            "lockout_seconds_left": (round(max(0.0, config.CHOP_ENTRY_LOCKOUT_SECONDS - elapsed_since_open), 1)
                                      if in_lockout else 0.0),

            "total_entries": self.stats.total_entries,
            "total_rearms": self.stats.total_rearms,
            "total_tp_fills": self.stats.total_tp_fills,
            "total_sl_fills": self.stats.total_sl_fills,
            "total_forced_closes": self.stats.total_forced_closes,
            "total_time_force_closes": self.stats.total_time_force_closes,
            "total_illiquid_skips": self.stats.total_illiquid_skips,
            "no_trade_windows": self.stats.no_trade_windows,
            "wins": self.stats.wins,
            "losses": self.stats.losses,
            "win_rate": (round(100 * self.stats.wins / (self.stats.wins + self.stats.losses), 1)
                         if (self.stats.wins + self.stats.losses) else None),

            "status": status,

            "def": {
                "shares_per_entry": config.CHOP_SHARES_PER_ENTRY,
                "buy_price": config.CHOP_BUY_PRICE,
                "sl_price": config.CHOP_SL_PRICE,
                "tp_price": config.CHOP_TP_PRICE,
                "entry_lockout_seconds": config.CHOP_ENTRY_LOCKOUT_SECONDS,
                "force_sell_after_seconds": config.CHOP_FORCE_SELL_AFTER_SECONDS,
                "entry_max_chase": config.CHOP_ENTRY_MAX_CHASE,
            },
        }
