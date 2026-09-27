"""Fixed UP/DOWN/SKIP cycle with a dollar-denominated demo Martingale."""
import time
from dataclasses import dataclass, field
from typing import List, Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


@dataclass
class CapitalPool:
    balance: float
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)
    peak_equity: float = 0.0
    max_drawdown: float = 0.0
    max_drawdown_pct: float = 0.0

    def __post_init__(self):
        self.peak_equity = self.balance

    def record_equity_point(self, window_slug: Optional[str]):
        self.equity_curve.append({
            "window": window_slug,
            "ts": time.time(),
            "balance": round(self.balance, 2),
        })
        self.equity_curve = self.equity_curve[-500:]

    def update_drawdown(self, equity: float):
        if equity > self.peak_equity:
            self.peak_equity = equity
        drawdown = self.peak_equity - equity
        if drawdown > self.max_drawdown:
            self.max_drawdown = drawdown
            self.max_drawdown_pct = (
                drawdown / self.peak_equity * 100 if self.peak_equity else 0.0
            )

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
    budget_usd: float = config.DEMO_BASE_USD
    pattern_skipped_windows: int = 0
    total_pnl: float = 0.0
    fills: int = 0
    tp_fills: int = 0
    settled_wins: int = 0
    settled_losses: int = 0
    no_signal_windows: int = 0
    price_skipped_windows: int = 0
    skipped_signal_wins: int = 0
    skipped_signal_losses: int = 0
    wins: int = 0
    losses: int = 0


class Engine:
    """Trade a UTC-epoch anchored three-window cycle."""

    name = "E2"
    label = "UP → DOWN → SKIP"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)

    def _log(self, event, **kw):
        self.broker.log_event(
            self.name,
            self.s.window.slug if self.s.window else "",
            event,
            balance_after=self.capital.balance,
            **kw,
        )

    def begin_window(self, window: WindowMarket):
        """Clear the prior window's signal before selecting this window's phase."""
        self.s.window = window
        self.s.entry_side_this_window = None
        self.s.entered_this_window = False

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.entry_side_this_window = None
        self.s.entered_this_window = False
        if self.capital.halted:
            return

        # Derive phase from the market's five-minute timestamp, not from
        # process uptime. Restarts and missing windows cannot shift the cycle.
        phase = (int(window.open_ts) // config.WINDOW_SECONDS) % 3
        if phase == 2:
            self.s.pattern_skipped_windows += 1
            self._log("PATTERN_SKIP", note="scheduled SKIP -- no buy or size change")
            return

        side = Side.UP if phase == 0 else Side.DOWN
        self.s.entry_side_this_window = side
        self._log(
            "PATTERN_SIGNAL",
            side=side.value,
            note=f"fixed cycle {side.value}; next demo stake ${self.s.budget_usd:.2f}",
        )

    def on_tick(
        self,
        up_bid,
        up_ask,
        down_bid,
        down_ask,
        seconds_to_close: float = None,
        now: Optional[float] = None,
    ):
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        if self.capital.halted or self.s.window is None:
            return
        if (
            self.s.entry_side_this_window is not None
            and not self.s.entered_this_window
            and self.s.position is None
            and now >= self.s.window.open_ts + config.ENTRY_DELAY_SECONDS
            and now < self.s.window.close_ts
        ):
            ask = up_ask if self.s.entry_side_this_window == Side.UP else down_ask
            if ask is not None and 0 < ask < config.ENTRY_MAX_ASK:
                self._enter(self.s.entry_side_this_window, ask, now)
                self.s.entered_this_window = True
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
        # Budget includes the simulated taker fee, not just the ask proceeds.
        shares = self.s.budget_usd / (ask + self.broker.taker_fee_amount(1, ask))
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        if cost > self.capital.balance + 1e-9:
            self.capital.halted = True
            self._log(
                "HALTED",
                note=f"demo stake ${self.s.budget_usd:.2f} exceeds available capital ${self.capital.balance:.2f}",
            )
            return
        self.capital.balance -= cost
        self.s.fills += 1
        self._log(
            "CANDLE_BUY",
            side=side.value,
            price=ask,
            shares=shares,
            fee=fee,
            note=(
                f"taker buy {shares:.4f}sh {side.value} @ {ask} for ${cost:.2f} after "
                f"{config.ENTRY_DELAY_SECONDS:g}s delay with ask below "
                f"${config.ENTRY_MAX_ASK:.2f} (fee ${fee:.4f})"
            ),
        )
        self.s.position = Position(side, ask, shares, cost, now)

    def _check_tp(self):
        pos = self.s.position
        if pos is None:
            return
        bid = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
        if bid is None or bid < config.ENGINE_TP_PRICE:
            return
        rebate = (
            config.MAKER_REBATE_FRACTION
            * self.broker.taker_fee_amount(pos.shares, config.ENGINE_TP_PRICE)
        )
        proceeds = pos.shares * config.ENGINE_TP_COUNTS_AS + rebate
        pnl = proceeds - pos.cost
        self._settle(
            pos,
            proceeds,
            pnl,
            "TP_FILL",
            fee=rebate,
            note=(
                f"TP hit -- {pos.shares:.0f}sh sold @ {config.ENGINE_TP_PRICE} "
                f"(maker, rebate ${rebate:.4f}), booked @ "
                f"${config.ENGINE_TP_COUNTS_AS:.2f}/sh "
                f"(entry {pos.entry_price}, pnl ${pnl:.4f})"
            ),
        )
        self.s.tp_fills += 1
        self.s.position = None

    def finalize_window(self, winning_side: Optional[Side]):
        window_slug = self.s.window.slug if self.s.window else None
        pos = self.s.position
        if pos is not None:
            if winning_side is None:
                self._settle(
                    pos, pos.cost, 0.0, "SETTLE_UNKNOWN", fee=0.0,
                    note="window closed with no observed winner -- settled at cost (no gain/loss)",
                )
            elif pos.side == winning_side:
                proceeds = pos.shares
                pnl = proceeds - pos.cost
                self._settle(
                    pos, proceeds, pnl, "SETTLE_WIN", fee=0.0,
                    note=f"last midpoint favored {pos.side.value}; {pos.shares:.0f}sh paid $1.00/sh (pnl ${pnl:.4f})",
                )
                self.s.settled_wins += 1
            else:
                pnl = -pos.cost
                self._settle(
                    pos, 0.0, pnl, "SETTLE_LOSS", fee=0.0,
                    note=f"last midpoint favored {winning_side.value}; {pos.side.value} paid $0.00/sh (pnl ${pnl:.4f})",
                )
                self.s.settled_losses += 1
            self.s.position = None
        elif (
            self.s.window is not None
            and self.s.entry_side_this_window is not None
            and not self.s.entered_this_window
            and not self.capital.halted
        ):
            side = self.s.entry_side_this_window
            self.s.price_skipped_windows += 1
            if winning_side is None:
                self._log(
                    "PRICE_FILTER_SKIPPED_UNKNOWN",
                    side=side.value,
                    note=(
                        f"no {side.value} ask below ${config.ENTRY_MAX_ASK:.2f} was observed; "
                        "no observed winner, no trade or size change"
                    ),
                )
            else:
                is_win = side == winning_side
                if is_win:
                    self.s.wins += 1
                    self.s.skipped_signal_wins += 1
                else:
                    self.s.losses += 1
                    self.s.skipped_signal_losses += 1
                self._log(
                    "PRICE_FILTER_SKIPPED_WIN" if is_win else "PRICE_FILTER_SKIPPED_LOSS",
                    side=side.value,
                    note=(
                        f"no {side.value} ask below ${config.ENTRY_MAX_ASK:.2f} was observed; "
                        f"last midpoint favored {winning_side.value}, so signal "
                        f"{'won' if is_win else 'lost'}; no trade or P&L"
                    ),
                )
                self._adjust_size(is_win)
        self.capital.update_drawdown(self._live_equity())
        self.capital.record_equity_point(window_slug)
        self.s.window = None

    def _settle(self, pos: Position, proceeds: float, pnl: float, reason: str, fee: float, note: str):
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        if reason != "SETTLE_UNKNOWN":
            if pnl >= 0:
                self.s.wins += 1
            else:
                self.s.losses += 1
        self._log(
            reason,
            side=pos.side.value,
            price=pos.entry_price,
            shares=pos.shares,
            pnl=pnl,
            fee=fee,
            note=note,
        )
        self.capital.check_halt()
        self.capital.update_drawdown(self._live_equity())
        if reason in ("SETTLE_WIN", "TP_FILL"):
            self._adjust_size(is_win=True)
        elif reason == "SETTLE_LOSS":
            self._adjust_size(is_win=False)

    def _adjust_size(self, is_win: bool):
        old_size = self.s.budget_usd
        self.s.budget_usd = config.DEMO_BASE_USD if is_win else old_size * 2
        if self.s.budget_usd != old_size:
            self._log(
                "SIZE_ADJUST",
                side=self.s.entry_side_this_window.value if self.s.entry_side_this_window else None,
                note=f"{'win' if is_win else 'loss'}: next demo stake ${old_size:.2f} -> ${self.s.budget_usd:.2f}",
            )

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
                "side": pos.side.value,
                "entry_price": pos.entry_price,
                "shares": round(pos.shares, 2),
                "cost": round(pos.cost, 4),
                "tp_price": config.ENGINE_TP_PRICE,
                "seconds_since_entry": round(elapsed, 1),
                "mark_price": mark,
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
        return {
            "engine": self.name,
            "label": self.label,
            "base_budget_usd": config.DEMO_BASE_USD,
            "budget_usd": self.s.budget_usd,
            "next_budget_if_win": config.DEMO_BASE_USD,
            "next_budget_if_loss": self.s.budget_usd * 2,
            "pattern_skipped_windows": self.s.pattern_skipped_windows,
            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),
            "peak_equity": round(self.capital.peak_equity, 2),
            "max_drawdown": round(self.capital.max_drawdown, 2),
            "max_drawdown_pct": round(self.capital.max_drawdown_pct, 2),
            "realized_pnl": round(self.s.total_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),
            "entry_side_this_window": (
                self.s.entry_side_this_window.value if self.s.entry_side_this_window else None
            ),
            "entered_this_window": self.s.entered_this_window,
            "entry_max_ask": config.ENTRY_MAX_ASK,
            "position": position_payload,
            "fills": self.s.fills,
            "tp_fills": self.s.tp_fills,
            "settled_wins": self.s.settled_wins,
            "settled_losses": self.s.settled_losses,
            "no_signal_windows": self.s.no_signal_windows,
            "price_skipped_windows": self.s.price_skipped_windows,
            "skipped_signal_wins": self.s.skipped_signal_wins,
            "skipped_signal_losses": self.s.skipped_signal_losses,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": (
                round(100 * self.s.wins / (self.s.wins + self.s.losses), 1)
                if self.s.wins + self.s.losses else None
            ),
            "status": status,
        }