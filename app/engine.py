"""
Trading engine -- alternating-side, win/loss-driven size ladder. See
app/config.py for the full strategy write-up.
"""
import time
from dataclasses import dataclass, field
from typing import List, Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


# ---------------------------------------------------------------------------
# Capital -- balance, equity curve, and running peak / max-drawdown tracking.
# ---------------------------------------------------------------------------

@dataclass
class CapitalPool:
    balance: float
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)

    peak_equity: float = 0.0
    max_drawdown: float = 0.0       # largest $ drop from a peak, ever observed
    max_drawdown_pct: float = 0.0   # that drop as a % of the peak it fell from

    def __post_init__(self):
        self.peak_equity = self.balance

    def record_equity_point(self, window_slug: Optional[str]):
        self.equity_curve.append({
            "window": window_slug, "ts": time.time(), "balance": round(self.balance, 2),
        })
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    def update_drawdown(self, equity: float):
        """Call on every live equity read (balance + open position's
        current market value) so intra-window swings count, not just the
        balance at settlement."""
        if equity > self.peak_equity:
            self.peak_equity = equity
        drawdown = self.peak_equity - equity
        if drawdown > self.max_drawdown:
            self.max_drawdown = drawdown
            self.max_drawdown_pct = (drawdown / self.peak_equity * 100) if self.peak_equity else 0.0

    def check_halt(self) -> bool:
        if not self.halted and self.balance < 0:
            self.halted = True
        return self.halted


@dataclass
class Position:
    side: Side
    entry_price: float
    shares: float
    cost: float
    entry_ts: float = 0.0


# ---------------------------------------------------------------------------
# Engine state
# ---------------------------------------------------------------------------

@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    entry_side_this_window: Optional[Side] = None
    entered_this_window: bool = False
    position: Optional[Position] = None

    next_side: Side = Side.UP          # strict alternation, independent of win/loss
    current_shares: float = config.ENGINE2_SHARES
    pinned_at_cap: bool = False        # True while stuck at the 1000sh cap, recovering
    session_pnl: float = 0.0           # cumulative $ P&L since the last reset (floor or cap-recovery)

    total_pnl: float = 0.0
    fills: int = 0
    tp_fills: int = 0
    settled_wins: int = 0
    settled_losses: int = 0
    resets: int = 0
    skipped_price: int = 0             # windows where ask never dropped below the entry ceiling
    wins: int = 0
    losses: int = 0


class Engine:
    """Alternates UP/DOWN every window no matter what. Position size
    starts at 500sh; each win steps it down 100sh, each loss steps it up
    100sh. Hitting the 0sh floor after a win resets straight back to
    500sh next window. Hitting the 1000sh cap after a loss pins size at
    1000sh -- ignoring further win/loss stepping -- until cumulative
    realized P&L since the last reset recovers to >=$0, then it resets
    to 500sh. Resting TP at 0.99 (booked as $1/share); otherwise rides
    to the window's real $0/$1 settlement. Runs continuously."""

    name = "E2"
    label = "Alternating win/loss ladder"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    # ---- side selection: strict alternation, every window -------------------

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.entered_this_window = False

        if self.capital.halted:
            self.s.entry_side_this_window = None
            return

        self.s.entry_side_this_window = self.s.next_side
        self.s.next_side = Side.DOWN if self.s.next_side == Side.UP else Side.UP

    # ---- tick: fire the entry (once, on the first tick with a live ask),
    # watch for TP, and track live equity for max-drawdown -------------------

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None):
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        if self.capital.halted or self.s.window is None:
            return

        if (self.s.entry_side_this_window is not None
                and not self.s.entered_this_window and self.s.position is None):
            ask = up_ask if self.s.entry_side_this_window == Side.UP else down_ask
            if ask is not None and ask < config.ENGINE2_MAX_ENTRY_PRICE:
                self._enter(self.s.entry_side_this_window, ask, now)
                self.s.entered_this_window = True
            # else: keep watching every tick this window -- ask may still
            # drop below the entry ceiling before the window closes

        self._check_tp()
        self.capital.update_drawdown(self._live_equity())

    def _live_equity(self) -> float:
        pos = self.s.position
        if pos is None:
            return self.capital.balance
        mark = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
        mark = mark if mark is not None else pos.entry_price
        return self.capital.balance + pos.shares * mark

    def _enter(self, side: Side, ask: float, now: float):
        shares = self.s.current_shares
        if shares <= 0:
            return  # floor edge case -- nothing to enter with until the reset lands next window
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        self.capital.balance -= cost
        self.s.fills += 1
        self._log("CANDLE_BUY", side=side.value, price=ask, shares=shares, fee=fee,
                   note=f"taker buy {shares:.0f}sh {side.value} @ {ask} on window open (fee ${fee:.4f})")
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
        self.s.position = Position(side=side, entry_price=ask, shares=shares, cost=cost, entry_ts=now)

    def _check_tp(self):
        pos = self.s.position
        if pos is None:
            return
        bid = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
        if bid is None or bid < config.ENGINE_TP_PRICE:
            return
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(pos.shares, config.ENGINE_TP_PRICE)
        proceeds = pos.shares * config.ENGINE_TP_COUNTS_AS + rebate
        pnl = proceeds - pos.cost
        self._settle(pos, proceeds, pnl, "TP_FILL", fee=rebate,
                      note=(f"TP hit -- {pos.shares:.0f}sh sold @ {config.ENGINE_TP_PRICE} "
                            f"(maker, rebate ${rebate:.4f}), booked @ ${config.ENGINE_TP_COUNTS_AS:.2f}/sh "
                            f"(entry {pos.entry_price}, pnl ${pnl:.4f})"))
        self.s.tp_fills += 1
        self.s.position = None

    def finalize_window(self, winning_side: Optional[Side]):
        """Called once per window close -- an open position must still
        resolve. If TP already closed it, there's nothing left to do."""
        window_slug = self.s.window.slug if self.s.window else None
        pos = self.s.position
        if pos is not None:
            if winning_side is None:
                # no observed outcome (e.g. missing book data right at the
                # boundary) -- settle at cost rather than silently losing
                # the debit or guessing a winner. Neutral -- doesn't step
                # the ladder either way.
                self._settle(pos, pos.cost, 0.0, "SETTLE_UNKNOWN", fee=0.0,
                              note="window closed with no observed winner -- settled at cost (no gain/loss)")
            elif pos.side == winning_side:
                proceeds = pos.shares * 1.0
                pnl = proceeds - pos.cost
                self._settle(pos, proceeds, pnl, "SETTLE_WIN", fee=0.0,
                              note=f"window resolved -- {pos.side.value} won, {pos.shares:.0f}sh paid $1.00/sh (pnl ${pnl:.4f})")
                self.s.settled_wins += 1
            else:
                pnl = 0.0 - pos.cost
                self._settle(pos, 0.0, pnl, "SETTLE_LOSS", fee=0.0,
                              note=f"window resolved -- {pos.side.value} lost, {pos.shares:.0f}sh paid $0.00/sh (pnl ${pnl:.4f})")
                self.s.settled_losses += 1
            self.s.position = None
        elif self.s.entry_side_this_window is not None and not self.s.entered_this_window:
            # signalled side never got a qualifying (<0.50) ask all window --
            # no trade at all, ladder untouched, side selection still alternates next window
            self.s.skipped_price += 1
            self._log("SKIPPED_PRICE",
                       side=self.s.entry_side_this_window.value,
                       note=(f"{self.s.entry_side_this_window.value} never traded below "
                             f"{config.ENGINE2_MAX_ENTRY_PRICE} this window -- no entry taken"))

        self.capital.update_drawdown(self._live_equity())
        self.capital.record_equity_point(window_slug)
        self.s.window = None

    def _settle(self, pos: Position, proceeds: float, pnl: float, reason: str, fee: float, note: str):
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        if pnl >= 0:
            self.s.wins += 1
        else:
            self.s.losses += 1
        self._log(reason, side=pos.side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee, note=note)
        self.capital.check_halt()
        self.capital.update_drawdown(self._live_equity())

        if reason in ("TP_FILL", "SETTLE_WIN"):
            self._apply_ladder(pnl, is_win=True)
        elif reason == "SETTLE_LOSS":
            self._apply_ladder(pnl, is_win=False)
        # SETTLE_UNKNOWN -- neutral, no ladder step

    # ---- the ladder itself: floor is a plain count-based reset, cap is a
    # dollar-P&L-gated recovery -------------------------------------------

    def _apply_ladder(self, pnl: float, is_win: bool):
        self.s.session_pnl += pnl

        if self.s.pinned_at_cap:
            if self.s.session_pnl >= 0:
                self._reset_ladder(
                    f"pinned at {config.ENGINE2_MAX_SHARES:.0f}sh -- cumulative P&L since pin recovered "
                    f"(+${self.s.session_pnl:.2f}) -- resetting to base {config.ENGINE2_SHARES:.0f}sh")
            # else: stays pinned at the cap, still recovering
            return

        if is_win:
            self.s.current_shares = max(config.ENGINE2_MIN_SHARES, self.s.current_shares - config.ENGINE2_SIZE_STEP)
            if self.s.current_shares <= config.ENGINE2_MIN_SHARES:
                self._reset_ladder(f"hit the {config.ENGINE2_MIN_SHARES:.0f}sh floor after a win -- resetting to base {config.ENGINE2_SHARES:.0f}sh")
        else:
            self.s.current_shares = min(config.ENGINE2_MAX_SHARES, self.s.current_shares + config.ENGINE2_SIZE_STEP)
            if self.s.current_shares >= config.ENGINE2_MAX_SHARES:
                self.s.pinned_at_cap = True
                self._log("PINNED_AT_CAP",
                           note=(f"hit the {config.ENGINE2_MAX_SHARES:.0f}sh cap after a loss -- staying here until "
                                 f"cumulative P&L since pin (currently ${self.s.session_pnl:.2f}) recovers to >=$0"))

    def _reset_ladder(self, note: str):
        self.s.current_shares = config.ENGINE2_SHARES
        self.s.pinned_at_cap = False
        self.s.session_pnl = 0.0
        self.s.resets += 1
        self._log("LADDER_RESET", note=note)

    # ---- dashboard payload --------------------------------------------------

    def snapshot(self) -> dict:
        pos = self.s.position
        position_payload = None
        unrealized_pnl = 0.0
        open_market_value = 0.0
        if pos is not None:
            mark = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
            mark_for_calc = mark if mark is not None else pos.entry_price
            open_market_value = pos.shares * mark_for_calc
            unrealized_pnl = open_market_value - pos.cost
            elapsed = max(0.0, time.time() - pos.entry_ts)
            position_payload = {
                "side": pos.side.value, "entry_price": pos.entry_price, "shares": round(pos.shares, 2),
                "cost": round(pos.cost, 4), "tp_price": config.ENGINE_TP_PRICE,
                "seconds_since_entry": round(elapsed, 1), "mark_price": mark,
                "unrealized_pnl": round(unrealized_pnl, 4),
            }

        if self.capital.halted:
            status = "halted"
        elif pos is not None:
            status = "open"
        elif self.s.entry_side_this_window is not None and not self.s.entered_this_window:
            status = "armed"
        else:
            status = "waiting"

        equity = round(self.capital.balance + open_market_value, 4)

        return {
            "engine": self.name, "label": self.label,

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": equity,

            "peak_equity": round(self.capital.peak_equity, 2),
            "max_drawdown": round(self.capital.max_drawdown, 2),
            "max_drawdown_pct": round(self.capital.max_drawdown_pct, 2),

            "realized_pnl": round(self.s.total_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),

            "entry_side_this_window": self.s.entry_side_this_window.value if self.s.entry_side_this_window else None,
            "next_side": self.s.next_side.value,
            "current_shares": self.s.current_shares,
            "base_shares": config.ENGINE2_SHARES,
            "min_shares": config.ENGINE2_MIN_SHARES,
            "max_shares": config.ENGINE2_MAX_SHARES,
            "pinned_at_cap": self.s.pinned_at_cap,
            "session_pnl": round(self.s.session_pnl, 4),
            "position": position_payload,

            "fills": self.s.fills, "tp_fills": self.s.tp_fills,
            "settled_wins": self.s.settled_wins, "settled_losses": self.s.settled_losses,
            "resets": self.s.resets, "skipped_price": self.s.skipped_price,
            "max_entry_price": config.ENGINE2_MAX_ENTRY_PRICE,
            "wins": self.s.wins, "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,
        }
