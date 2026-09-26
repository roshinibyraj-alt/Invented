"""Single-candle contrarian demo engine."""
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional

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
    active: bool = True
    sleep_windows_remaining: int = 0
    entry_side_this_window: Optional[Side] = None
    entered_this_window: bool = False
    position: Optional[Position] = None
    session_pnl: float = 0.0
    total_pnl: float = 0.0
    fills: int = 0
    tp_fills: int = 0
    settled_wins: int = 0
    settled_losses: int = 0
    no_signal_windows: int = 0
    wins: int = 0
    losses: int = 0


class Engine:
    """Red candles buy UP; green candles buy DOWN, 500 shares per entry."""

    name = "E2"
    label = "Single-candle contrarian"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.shares = config.ENGINE2_SHARES
        self.candle_history: Deque[str] = deque(maxlen=config.CANDLE_HISTORY_MAXLEN)
        self.last_candle: Optional[dict] = None
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

    def _wake_up(self):
        self.s.active = True
        self.s.sleep_windows_remaining = 0
        self.s.session_pnl = 0.0
        self._log(
            "ENGINE_RESUMED",
            note=f"resumed after sleep -- session P&L reset, target +${config.ENGINE_PROFIT_TARGET_USD:.0f}",
        )

    def _check_sleep(self):
        if self.s.active and self.s.session_pnl >= config.ENGINE_PROFIT_TARGET_USD:
            self.s.active = False
            self.s.sleep_windows_remaining = config.ENGINE_SLEEP_WINDOWS
            self._log(
                "ENGINE_SLEEP",
                note=(
                    f"session P&L +${self.s.session_pnl:.2f} reached target -- "
                    f"sleeping {config.ENGINE_SLEEP_WINDOWS} windows"
                ),
            )

    def record_candle(self, candle: Optional[dict]):
        self.last_candle = candle
        if candle is not None:
            self.candle_history.append(candle["color"])

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.entry_side_this_window = None
        self.s.entered_this_window = False
        if self.capital.halted:
            return
        if not self.s.active:
            if self.s.sleep_windows_remaining > 0:
                self.s.sleep_windows_remaining -= 1
                return
            self._wake_up()
        # A missing candle must not reuse yesterday's signal just because
        # older colors remain available for the demo history display.
        if self.last_candle is not None:
            last_color = self.last_candle["color"]
            if last_color == "red":
                self.s.entry_side_this_window = Side.UP
            elif last_color == "green":
                self.s.entry_side_this_window = Side.DOWN
        if self.s.entry_side_this_window is None:
            self.s.no_signal_windows += 1

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
            self.s.active
            and self.s.entry_side_this_window is not None
            and not self.s.entered_this_window
            and self.s.position is None
        ):
            ask = up_ask if self.s.entry_side_this_window == Side.UP else down_ask
            if ask is not None:
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
        shares = self.shares
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        self.capital.balance -= cost
        self.s.fills += 1
        self._log(
            "CANDLE_BUY",
            side=side.value,
            price=ask,
            shares=shares,
            fee=fee,
            note=f"taker buy {shares:.0f}sh {side.value} @ {ask} on window open (fee ${fee:.4f})",
        )
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
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
        self.capital.update_drawdown(self._live_equity())
        self.capital.record_equity_point(window_slug)
        self.s.window = None

    def _settle(self, pos: Position, proceeds: float, pnl: float, reason: str, fee: float, note: str):
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.session_pnl += pnl
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
        self._check_sleep()

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
        elif not self.s.active:
            status = "sleeping"
        elif pos is not None:
            status = "open"
        elif self.s.entry_side_this_window is not None and not self.s.entered_this_window:
            status = "armed"
        else:
            status = "waiting"
        return {
            "engine": self.name,
            "label": self.label,
            "active": self.s.active,
            "sleep_windows_remaining": self.s.sleep_windows_remaining,
            "shares": self.shares,
            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),
            "peak_equity": round(self.capital.peak_equity, 2),
            "max_drawdown": round(self.capital.max_drawdown, 2),
            "max_drawdown_pct": round(self.capital.max_drawdown_pct, 2),
            "realized_pnl": round(self.s.total_pnl, 4),
            "session_pnl": round(self.s.session_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),
            "profit_target": config.ENGINE_PROFIT_TARGET_USD,
            "progress_pct": round(
                100 * max(0.0, self.s.session_pnl) / config.ENGINE_PROFIT_TARGET_USD, 1
            ),
            "entry_side_this_window": (
                self.s.entry_side_this_window.value if self.s.entry_side_this_window else None
            ),
            "position": position_payload,
            "candle_history": list(self.candle_history)[-10:],
            "last_candle": self.last_candle,
            "fills": self.s.fills,
            "tp_fills": self.s.tp_fills,
            "settled_wins": self.s.settled_wins,
            "settled_losses": self.s.settled_losses,
            "no_signal_windows": self.s.no_signal_windows,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": (
                round(100 * self.s.wins / (self.s.wins + self.s.losses), 1)
                if self.s.wins + self.s.losses else None
            ),
            "status": status,
        }