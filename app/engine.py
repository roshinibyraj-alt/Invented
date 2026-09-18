"""
Trading engine -- one resting limit buy per window, direction decided
by the color of the PREVIOUS window's own last 1-minute Binance spot
candle.

See app/config.py for the full strategy write-up. Summary: the instant
a new window opens, read the just-finished window's [240s,300s) minute
candle -- green -> resting limit buy UP @ 0.45, red -> resting limit
buy DOWN @ 0.45, flat -> no trade. Real MAKER fill (own exact price, no
fee) whenever that side's ask reaches it. No SL. TP 0.99, real taker
exit. One order/trade max per window; no re-arm.
"""
import time
from dataclasses import dataclass, field
from typing import Optional

from . import config
from .binance_client import BinanceKlineFeed
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
    """Volume-weighted average price to actually trade `shares` against a
    real order book, instead of assuming the whole size fills at the
    single best quote. Used only for the TAKER TP exit / forced close --
    the entry itself is a resting maker order that fills at its own
    exact limit price, no walk needed.

    - levels is None -> no depth data this tick; fall back to filling
      the whole size at `fallback_price`.
    - levels is [] -> book fetched fine, genuinely nothing resting on
      this side; return None, caller must not invent a fill.
    - levels is non-empty -> walk best-price-first; any shortfall in
      visible depth is priced at the worst level seen.
    """
    if levels is None:
        return fallback_price
    if not levels:
        return None
    remaining = shares
    cost = 0.0
    worst_price = levels[-1][0]
    for price, size in levels:
        if remaining <= 1e-9:
            break
        take = min(remaining, size) if size and size > 0 else 0.0
        if take <= 0:
            continue
        cost += take * price
        remaining -= take
    if remaining > 1e-9:
        cost += remaining * worst_price
    return cost / shares


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
class RestingOrder:
    side: Side
    price: float
    shares: float
    status: str = "resting"   # resting | filled | cancelled
    is_contrarian: bool = False
    signal_side: Optional[Side] = None   # the real (pre-flip) signal side, for logging


@dataclass
class Position:
    side: Side
    entry_price: float
    shares: float
    cost: float
    entry_ts: float
    is_contrarian: bool = False
    signal_side: Optional[Side] = None


@dataclass
class EngineState:
    """Per-window transient state -- fully replaced by reset_for_window()
    at the start of every window. Cumulative stats (totals, win/loss
    counts, streak) live on the Engine itself, below, so they survive
    across windows instead of getting wiped every 5 minutes."""
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    order: Optional[RestingOrder] = None
    position: Optional[Position] = None
    decision_made: bool = False     # True once the signal candle has been read (whichever way it went)
    decided_color: Optional[str] = None   # "green" | "red" | "flat", once known

    last_window_pnl: float = 0.0


class Engine:
    """Previous-window-momentum engine, driven off a single shared
    capital pool. Constructed as Engine(broker, binance_feed) --
    app/state.py owns the BinanceKlineFeed instance and passes it in."""

    name = "PREVCANDLE"

    def __init__(self, broker: PaperBroker, binance_feed: BinanceKlineFeed):
        self.broker = broker
        self.binance_feed = binance_feed
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)

        # ---- cumulative stats, survive across windows ----------------------
        self.total_orders_placed = 0
        self.total_order_fills = 0
        self.total_tp_fills = 0
        self.total_forced_closes = 0
        self.total_unfilled_cancels = 0
        self.total_flat_candles = 0
        self.total_no_signal_windows = 0
        self.total_illiquid_skips = 0
        self.total_rsi_vetoes = 0
        self.total_pnl = 0.0
        self.wins = 0
        self.losses = 0

        # ---- win-streak contrarian filter -----------------------------------
        # After WIN_STREAK_TRIGGER consecutive wins on normal (real-signal)
        # trades, the next trade fades the signal (opposite side) instead of
        # following it. That one contrarian trade settles either way, then
        # win_streak resets to 0 and normal signal-following resumes.
        self.win_streak = 0
        self.total_contrarian_trades = 0
        self.wins_normal = 0
        self.losses_normal = 0
        self.wins_contrarian = 0
        self.losses_contrarian = 0

    def _record_trade_result(self, pos: Position, pnl: float):
        """Called once per settled trade (TP fill or forced window-close
        close) to update win/loss counts and the streak filter."""
        win = pnl >= 0
        if win:
            self.wins += 1
        else:
            self.losses += 1
        if pos.is_contrarian:
            if win:
                self.wins_contrarian += 1
            else:
                self.losses_contrarian += 1
            self.win_streak = 0   # contrarian bet resolved -- back to normal
        else:
            if win:
                self.wins_normal += 1
                self.win_streak += 1
            else:
                self.losses_normal += 1
                self.win_streak = 0

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def reset_for_window(self, window: WindowMarket):
        self.s = EngineState(window=window)
        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return
        self._log("WINDOW_OPEN", note=(
            f"reading previous window's last-minute candle -- green->resting buy UP @ {config.ORDER_PRICE}, "
            f"red->resting buy DOWN @ {config.ORDER_PRICE}, flat->no trade, RSI({config.RSI_PERIOD}) veto "
            f"if overbought/oversold in that direction, then fade the signal after "
            f"{config.WIN_STREAK_TRIGGER} normal wins in a row (win_streak={self.win_streak}). "
            f"{config.ORDER_SHARES:.0f}sh, maker, no SL, TP {config.TP_PRICE}"
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None,
                up_bid_levels: Optional[list] = None, up_ask_levels: Optional[list] = None,
                down_bid_levels: Optional[list] = None, down_ask_levels: Optional[list] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        self.s.up_bid_levels, self.s.up_ask_levels = up_bid_levels, up_ask_levels
        self.s.down_bid_levels, self.s.down_ask_levels = down_bid_levels, down_ask_levels

        if self.s.position is not None:
            self._check_exit(now)
            return

        if not self.s.decision_made:
            self._check_signal(now)
            return

        if self.s.order is not None and self.s.order.status == "resting":
            self._check_fill(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    # ---- signal: read the PREVIOUS window's last-minute candle --------------

    def _check_signal(self, now: float):
        # The previous window's last minute is exactly the 60 seconds
        # right before this window opened -- i.e. [this_open-60, this_open).
        signal_open_ts = self.s.window.open_ts - 60
        candle = self.binance_feed.get_candle(signal_open_ts)

        if candle is None or not candle.closed:
            # Binance data for this candle isn't in yet -- keep waiting,
            # retried every tick. It should normally already be closed
            # (it ended exactly when this window opened), but feed lag
            # or a reconnect can delay it briefly.
            return

        if candle.close > candle.open:
            color = "green"
        elif candle.close < candle.open:
            color = "red"
        else:
            color = "flat"

        self.s.decided_color = color
        self._log("CANDLE_READ", price=candle.close,
                   note=(f"previous window's last-minute candle: open {candle.open}, close {candle.close} -> "
                         f"{color} (open_time {candle.open_time})"))

        self.s.decision_made = True
        if color == "flat":
            self.total_flat_candles += 1
            self._log("NO_TRADE", note="flat candle (close == open) -- no directional signal, skipping this window")
            return

        side = Side.UP if color == "green" else Side.DOWN

        rsi = self.binance_feed.get_rsi(signal_open_ts, config.RSI_PERIOD)
        if rsi is not None:
            if side == Side.UP and rsi > config.RSI_OVERBOUGHT:
                self.total_rsi_vetoes += 1
                self._log("RSI_VETO", side=side.value, note=(
                    f"{color} signal for UP but RSI({config.RSI_PERIOD}) {rsi:.1f} > "
                    f"{config.RSI_OVERBOUGHT} (overbought) -- skipping, momentum looks exhausted"))
                return
            if side == Side.DOWN and rsi < config.RSI_OVERSOLD:
                self.total_rsi_vetoes += 1
                self._log("RSI_VETO", side=side.value, note=(
                    f"{color} signal for DOWN but RSI({config.RSI_PERIOD}) {rsi:.1f} < "
                    f"{config.RSI_OVERSOLD} (oversold) -- skipping, momentum looks exhausted"))
                return

        # RSI veto is checked against the real signal side only, above.
        # The win-streak filter is applied after that, and only flips
        # which side the order actually goes on.
        is_contrarian = self.win_streak >= config.WIN_STREAK_TRIGGER
        trade_side = side.other() if is_contrarian else side
        if is_contrarian:
            self.total_contrarian_trades += 1
            self._log("CONTRARIAN_FLIP", side=trade_side.value, note=(
                f"win streak at {self.win_streak} (>= {config.WIN_STREAK_TRIGGER}) -- fading the {color} "
                f"signal: real signal was {side.value}, betting {trade_side.value} instead"))

        self.s.order = RestingOrder(side=trade_side, price=config.ORDER_PRICE, shares=config.ORDER_SHARES,
                                     is_contrarian=is_contrarian, signal_side=side)
        self.total_orders_placed += 1
        rsi_note = f", RSI({config.RSI_PERIOD}) {rsi:.1f}" if rsi is not None else ", RSI n/a (insufficient history)"
        contrarian_note = f" [CONTRARIAN, real signal {side.value}]" if is_contrarian else ""
        self._log("RUNG_PLACED", side=trade_side.value, price=config.ORDER_PRICE, shares=config.ORDER_SHARES,
                   note=(f"{color} signal{rsi_note}{contrarian_note} -> resting limit buy {trade_side.value}: "
                         f"{config.ORDER_SHARES:.0f}sh @ {config.ORDER_PRICE}"))

    def _check_fill(self, now: float):
        order = self.s.order
        ask = self._ask_for(order.side)
        if ask is None or ask > order.price:
            return
        order.status = "filled"
        cost = order.shares * order.price
        self.capital.balance -= cost
        self.total_order_fills += 1
        self._log("RUNG_FILL", side=order.side.value, price=order.price, shares=order.shares, fee=0.0,
                   note=f"resting buy filled (maker, no fee): {order.shares:.0f}sh @ {order.price}")
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
        self.s.position = Position(side=order.side, entry_price=order.price, shares=order.shares, cost=cost,
                                    entry_ts=now, is_contrarian=order.is_contrarian, signal_side=order.signal_side)

    # ---- exit: TP only, no SL ------------------------------------------------

    def _check_exit(self, now: float):
        pos = self.s.position
        bid = self._bid_for(pos.side)
        if bid is None or bid < config.TP_PRICE:
            return
        levels = self._bid_levels_for(pos.side)
        fill_price = _realistic_fill_price(levels, pos.shares, bid)
        if fill_price is None:
            self.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=pos.side.value, price=bid, note=f"TP triggered @ {bid} but zero bid depth -- waiting")
            return
        fee = self.broker.taker_fee_amount(pos.shares, fill_price)
        proceeds = pos.shares * fill_price - fee
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.total_pnl += pnl
        self.s.last_window_pnl += pnl
        self._record_trade_result(pos, pnl)
        self.total_tp_fills += 1
        self._log("TP_FILL", side=pos.side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee,
                   note=(f"TP hit, real fill @ {fill_price:.4f} (triggered @ {bid}) "
                         f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()
        self.s.position = None

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted:
            if self.s.position is not None:
                pos = self.s.position
                bid = self._bid_for(pos.side)
                levels = self._bid_levels_for(pos.side)
                fill_price = _realistic_fill_price(levels, pos.shares, bid)
                if fill_price is None:
                    fill_price = 0.0
                    self._log("NO_LIQUIDITY", side=pos.side.value, price=bid,
                               note="window closed with zero bid depth -- assuming worst case $0")
                fee = self.broker.taker_fee_amount(pos.shares, fill_price)
                proceeds = pos.shares * fill_price - fee
                pnl = proceeds - pos.cost
                self.capital.balance += proceeds
                self.total_pnl += pnl
                self.s.last_window_pnl += pnl
                self.total_forced_closes += 1
                self._record_trade_result(pos, pnl)
                self._log("FORCED_CLOSE", side=pos.side.value, price=pos.entry_price, shares=pos.shares,
                           pnl=pnl, fee=fee,
                           note=(f"window closed, forced taker close @ {fill_price:.4f} "
                                 f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
                self.capital.check_halt()
                self.s.position = None
            elif self.s.order is not None and self.s.order.status == "resting":
                self.s.order.status = "cancelled"
                self.total_unfilled_cancels += 1
                self._log("RUNG_CANCELLED", side=self.s.order.side.value, price=self.s.order.price,
                           note="window closed, resting order never filled -- cancelled, no penalty")
            elif not self.s.decision_made:
                self.total_no_signal_windows += 1
                self._log("NO_TRADE", note="previous window's last-minute candle never arrived/closed in time")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        pos = self.s.position
        pos_payload = None
        open_market_value = 0.0
        unrealized = 0.0
        if pos is not None:
            bid = self._bid_for(pos.side)
            mark = bid if bid is not None else pos.entry_price
            open_market_value = pos.shares * mark
            unrealized = open_market_value - pos.cost
            pos_payload = {
                "side": pos.side.value, "entry_price": pos.entry_price, "shares": pos.shares,
                "cost": round(pos.cost, 4), "mark_price": mark, "unrealized_pnl": round(unrealized, 4),
                "seconds_since_entry": round(time.time() - pos.entry_ts, 1),
            }

        order_payload = None
        if self.s.order is not None:
            order_payload = {
                "side": self.s.order.side.value, "price": self.s.order.price,
                "shares": self.s.order.shares, "status": self.s.order.status,
                "is_contrarian": self.s.order.is_contrarian,
                "signal_side": self.s.order.signal_side.value if self.s.order.signal_side else None,
            }

        if self.capital.halted:
            status = "halted"
        elif pos is not None:
            status = "open"
        elif order_payload is not None and order_payload["status"] == "resting":
            status = "order_resting"
        elif self.s.decision_made:
            status = "done"
        else:
            status = "awaiting_signal"

        def _rate(w, l):
            return round(100 * w / (w + l), 1) if (w + l) else None

        return {
            "engine": "PREVCANDLE", "label": "Previous-window last-candle momentum",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": round(self.total_pnl, 4),
            "unrealized_pnl": round(unrealized, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "position": pos_payload,
            "order": order_payload,
            "decision_made": self.s.decision_made,
            "decided_color": self.s.decided_color,
            "binance": self.binance_feed.status(),

            "total_orders_placed": self.total_orders_placed,
            "total_order_fills": self.total_order_fills,
            "total_tp_fills": self.total_tp_fills,
            "total_forced_closes": self.total_forced_closes,
            "total_unfilled_cancels": self.total_unfilled_cancels,
            "total_flat_candles": self.total_flat_candles,
            "total_no_signal_windows": self.total_no_signal_windows,
            "total_illiquid_skips": self.total_illiquid_skips,
            "total_rsi_vetoes": self.total_rsi_vetoes,

            "wins": self.wins,
            "losses": self.losses,
            "win_rate": _rate(self.wins, self.losses),

            "win_streak": self.win_streak,
            "win_streak_trigger": config.WIN_STREAK_TRIGGER,
            "total_contrarian_trades": self.total_contrarian_trades,
            "wins_normal": self.wins_normal,
            "losses_normal": self.losses_normal,
            "win_rate_normal": _rate(self.wins_normal, self.losses_normal),
            "wins_contrarian": self.wins_contrarian,
            "losses_contrarian": self.losses_contrarian,
            "win_rate_contrarian": _rate(self.wins_contrarian, self.losses_contrarian),

            "status": status,

            "def": {
                "shares": config.ORDER_SHARES,
                "order_price": config.ORDER_PRICE,
                "tp_price": config.TP_PRICE,
            },
        }
