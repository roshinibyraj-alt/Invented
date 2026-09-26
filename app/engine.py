"""Single-candle contrarian strategy with paper/live execution."""
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Optional

from . import config
from .broker import Broker
from .models import Position, Side, WindowMarket


@dataclass
class Capital:
    balance: float
    starting: float
    peak_equity: float = 0.0
    max_drawdown: float = 0.0
    max_drawdown_pct: float = 0.0
    halted: bool = False
    equity_curve: list[dict] = field(default_factory=list)

    def __post_init__(self):
        self.peak_equity = self.balance

    def update(self, equity: float):
        self.peak_equity = max(self.peak_equity, equity)
        drawdown = self.peak_equity - equity
        if drawdown > self.max_drawdown:
            self.max_drawdown = drawdown
            self.max_drawdown_pct = drawdown / self.peak_equity * 100 if self.peak_equity else 0

    def checkpoint(self, window: Optional[str]):
        self.equity_curve.append({
            "window": window,
            "ts": time.time(),
            "balance": round(self.balance, 4),
        })
        self.equity_curve = self.equity_curve[-500:]


@dataclass
class StrategyState:
    window: Optional[WindowMarket] = None
    last_candle: Optional[dict] = None
    signal: Optional[Side] = None
    entered: bool = False
    position: Optional[Position] = None
    active: bool = True
    sleep_windows_remaining: int = 0
    session_pnl: float = 0.0
    realized_pnl: float = 0.0
    fills: int = 0
    wins: int = 0
    losses: int = 0
    tp_fills: int = 0
    settled_wins: int = 0
    settled_losses: int = 0
    no_signal_windows: int = 0
    last_exit_attempt: float = 0.0


class Engine:
    name = "BOT"
    label = "Single-candle contrarian"

    def __init__(self, broker: Broker):
        self.broker = broker
        self.capital = Capital(config.STARTING_CAPITAL, config.STARTING_CAPITAL)
        self.state = StrategyState()
        self.candle_history: Deque[str] = deque(maxlen=config.CANDLE_HISTORY_MAXLEN)
        self.trade_usd = config.BASE_TRADE_USD
        self.window_mark_up = None
        self.window_mark_down = None
        self.capital.checkpoint(None)

    def log(self, event: str, note: str = "", **fields):
        self.broker.log_event(
            event,
            note=note,
            window=self.state.window.slug if self.state.window else "",
            balance_after=self.capital.balance,
            **fields,
        )

    def record_candle(self, candle: Optional[dict]):
        self.state.last_candle = candle
        if candle:
            self.candle_history.append(candle["color"])

    def reset_for_window(self, window: WindowMarket):
        self.state.window = window
        self.state.signal = None
        self.state.entered = False
        if not self.state.active:
            if self.state.sleep_windows_remaining:
                self.state.sleep_windows_remaining -= 1
                self.log(
                    "SLEEP_WINDOW",
                    f"skipping this window; {self.state.sleep_windows_remaining} sleep windows remain",
                )
                return
            self.state.active = True
            self.state.session_pnl = 0.0
            self.log("ENGINE_RESUMED", "session P&L reset after sleep")

        if self.state.last_candle:
            color = self.state.last_candle["color"]
            if color == "red":
                self.state.signal = Side.UP
            elif color == "green":
                self.state.signal = Side.DOWN

        if self.state.signal is None:
            self.state.no_signal_windows += 1
            self.log("NO_SIGNAL", "doji or unavailable Binance candle")
        else:
            self.log(
                "SIGNAL",
                f"{self.candle_history[-1]} candle -> buy {self.state.signal.value}",
                side=self.state.signal.value,
                trade_usd=self.trade_usd,
            )

    def _equity(self) -> float:
        position = self.state.position
        if position is None:
            return self.capital.balance
        mark = (
            self.window_mark_up
            if position.side == Side.UP
            else self.window_mark_down
        )
        return self.capital.balance + position.shares * (mark or position.entry_price)

    async def on_tick(
        self,
        up_bid: Optional[float],
        up_ask: Optional[float],
        down_bid: Optional[float],
        down_ask: Optional[float],
        now: Optional[float] = None,
    ):
        now = time.time() if now is None else now
        self.window_mark_up = up_bid
        self.window_mark_down = down_bid
        self.state.up_bid = up_bid
        self.state.up_ask = up_ask
        self.state.down_bid = down_bid
        self.state.down_ask = down_ask

        if (
            self.state.active
            and self.state.signal
            and not self.state.entered
            and self.state.position is None
        ):
            ask = up_ask if self.state.signal == Side.UP else down_ask
            token = (
                self.state.window.token_up
                if self.state.signal == Side.UP
                else self.state.window.token_down
            )
            if ask is not None and token:
                self.state.entered = True
                await self._enter(self.state.signal, token, ask, now)

        position = self.state.position
        if position is not None:
            bid = up_bid if position.side == Side.UP else down_bid
            if bid is not None and bid >= config.TAKE_PROFIT_PRICE:
                await self._take_profit(position, bid, now)

        self.capital.update(self._equity())

    async def _enter(self, side: Side, token_id: str, ask: float, now: float):
        try:
            result = await self.broker.buy(token_id, self.trade_usd, ask)
        except Exception as exc:
            self.log("ENTRY_ERROR", str(exc), side=side.value, trade_usd=self.trade_usd)
            return
        if not result.get("filled"):
            self.log(
                "ENTRY_REJECTED",
                f"FOK entry did not fill: {result.get('status', 'unknown')}",
                side=side.value,
                trade_usd=self.trade_usd,
            )
            return

        shares = float(result.get("shares") or 0)
        avg_price = float(result.get("avgPrice") or ask)
        cost = float(result.get("cost") or shares * avg_price)
        if shares <= 0:
            self.log("ENTRY_REJECTED", "filled response contained no shares")
            return
        self.state.position = Position(side, token_id, avg_price, shares, cost, now)
        self.state.fills += 1
        self.capital.balance -= cost
        self.log(
            "ENTRY_FILLED",
            f"taker FOK buy {shares:.4f} {side.value} @ {avg_price:.4f}",
            side=side.value,
            price=avg_price,
            shares=shares,
            trade_usd=self.trade_usd,
            order_id=result.get("orderId"),
        )

    async def _take_profit(self, position: Position, bid: float, now: float):
        if now - self.state.last_exit_attempt < 2:
            return
        self.state.last_exit_attempt = now
        try:
            result = await self.broker.sell(position.token_id, position.shares, bid)
        except Exception as exc:
            self.log("EXIT_ERROR", str(exc), side=position.side.value)
            return
        if not result.get("filled"):
            self.log("TP_REJECTED", "FOK taker exit did not fill", side=position.side.value)
            return

        shares = float(result.get("shares") or position.shares)
        avg_price = float(result.get("avgPrice") or bid)
        proceeds = float(result.get("proceeds") or shares * avg_price)
        pnl = proceeds - position.cost
        self.state.tp_fills += 1
        self._settle(position, pnl, "TAKE_PROFIT", proceeds)
        self.state.position = None
        self.log(
            "TP_FILLED",
            f"taker FOK sell {shares:.4f} {position.side.value} @ {avg_price:.4f}",
            side=position.side.value,
            price=avg_price,
            shares=shares,
            pnl=pnl,
        )

    async def finalize_window(self, winner: Optional[Side]):
        position = self.state.position
        slug = self.state.window.slug if self.state.window else None
        if position is not None:
            if winner is None:
                self._settle(position, 0.0, "SETTLE_UNKNOWN", position.cost)
            elif winner == position.side:
                proceeds = position.shares
                self._settle(position, proceeds - position.cost, "SETTLE_WIN", proceeds)
                self.state.settled_wins += 1
            else:
                self._settle(position, -position.cost, "SETTLE_LOSS", 0.0)
                self.state.settled_losses += 1
            self.state.position = None
        self.capital.update(self._equity())
        self.capital.checkpoint(slug)

    def _settle(self, position: Position, pnl: float, reason: str, proceeds: float):
        self.capital.balance += proceeds
        self.state.realized_pnl += pnl
        self.state.session_pnl += pnl
        if pnl > 0:
            self.state.wins += 1
            self.trade_usd = max(config.BASE_TRADE_USD, self.trade_usd - config.TRADE_STEP_USD)
            direction = "win -> step down"
        elif pnl < 0:
            self.state.losses += 1
            self.trade_usd = min(config.MAX_TRADE_USD, self.trade_usd + config.TRADE_STEP_USD)
            direction = "loss -> step up"
        else:
            direction = "wash -> size unchanged"
        self.log(
            reason,
            f"pnl ${pnl:.4f}; {direction}; next trade ${self.trade_usd:.2f}",
            pnl=pnl,
            next_trade_usd=self.trade_usd,
        )
        if self.state.session_pnl >= config.PROFIT_TARGET_USD and self.state.active:
            self.state.active = False
            self.state.sleep_windows_remaining = config.SLEEP_WINDOWS
            self.log(
                "ENGINE_SLEEP",
                f"session target reached; sleeping {config.SLEEP_WINDOWS} windows",
            )

    def snapshot(self) -> dict:
        position = self.state.position
        mark = None
        if position:
            mark = self.state.up_bid if position.side == Side.UP else self.state.down_bid
        unrealized = 0.0
        if position:
            unrealized = position.shares * (mark or position.entry_price) - position.cost
        wins_losses = self.state.wins + self.state.losses
        return {
            "mode": config.TRADING_MODE,
            "label": self.label,
            "active": self.state.active,
            "sleep_windows_remaining": self.state.sleep_windows_remaining,
            "trade_usd": round(self.trade_usd, 2),
            "trade_floor_usd": config.BASE_TRADE_USD,
            "trade_ceiling_usd": config.MAX_TRADE_USD,
            "signal": self.state.signal.value if self.state.signal else None,
            "balance": round(self.capital.balance, 4),
            "starting_capital": self.capital.starting,
            "wallet_balance": round(self.broker.balance, 4),
            "halted": self.capital.halted,
            "realized_pnl": round(self.state.realized_pnl, 4),
            "unrealized_pnl": round(unrealized, 4),
            "session_pnl": round(self.state.session_pnl, 4),
            "profit_target": config.PROFIT_TARGET_USD,
            "progress_pct": round(max(0, self.state.session_pnl) / config.PROFIT_TARGET_USD * 100, 2),
            "position": (
                {
                    "side": position.side.value,
                    "entry_price": position.entry_price,
                    "shares": position.shares,
                    "cost": position.cost,
                    "mark_price": mark,
                    "unrealized_pnl": unrealized,
                    "seconds_held": time.time() - position.entry_ts,
                }
                if position
                else None
            ),
            "fills": self.state.fills,
            "wins": self.state.wins,
            "losses": self.state.losses,
            "win_rate": round(self.state.wins / wins_losses * 100, 2) if wins_losses else None,
            "tp_fills": self.state.tp_fills,
            "settled_wins": self.state.settled_wins,
            "settled_losses": self.state.settled_losses,
            "no_signal_windows": self.state.no_signal_windows,
            "last_candle": self.state.last_candle,
            "candle_history": list(self.candle_history)[-10:],
            "equity_curve": self.capital.equity_curve,
            "peak_equity": self.capital.peak_equity,
            "max_drawdown": self.capital.max_drawdown,
            "max_drawdown_pct": self.capital.max_drawdown_pct,
        }
