"""
Trading engine -- one resting limit buy per window. Direction is
decided by an online AI signal engine (app/ai_signal.py) predicting
the next window's outcome, then FADED: the bot always trades the
opposite side of that prediction.

See app/config.py for the full strategy write-up. Summary: the instant
a new window opens, compute AI features off the Binance feed and get a
prediction -- confident UP -> real signal UP, confident DOWN -> real
signal DOWN, not confident (or model still cold-starting) -> no trade.
RSI veto is checked against that real signal side. If it survives, the
bot places a resting limit buy on the OPPOSITE side, always, @ 0.45.
Real MAKER fill (own exact price, no fee) whenever that side's ask
reaches it. No SL. TP 0.99, real taker exit. One order/trade max per
window; no re-arm. Every window's true outcome is fed back into the AI
engine as one online training step, whether or not a trade happened.
"""
import time
from dataclasses import dataclass, field
from typing import Optional

from . import config
from .ai_signal import AISignalEngine
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
    signal_side: Optional[Side] = None   # the real (pre-fade) signal side, for logging


@dataclass
class Position:
    side: Side
    entry_price: float
    shares: float
    cost: float
    entry_ts: float
    signal_side: Optional[Side] = None


@dataclass
class EngineState:
    """Per-window transient state -- fully replaced by reset_for_window()
    at the start of every window. Cumulative stats live on the Engine
    itself, below, so they survive across windows instead of getting
    wiped every 5 minutes."""
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
    decision_made: bool = False     # True once the AI signal has been decided (whichever way it went)
    decided_color: Optional[str] = None   # "green" | "red" | "flat", the signal candle's own color (one AI feature, for display)
    ai_features: Optional[list] = None    # feature vector computed at signal time, kept for the learn() step at window close
    ai_predicted_side: Optional[Side] = None   # the real (pre-fade) AI prediction, if confident enough to trade
    ai_confidence: Optional[float] = None
    ai_p_up: Optional[float] = None       # raw P(up), even when below the confidence band / not yet trading

    last_window_pnl: float = 0.0


class Engine:
    """Previous-window-momentum-faded engine, driven off a single shared
    capital pool. Constructed as Engine(broker, binance_feed) --
    app/state.py owns the BinanceKlineFeed instance and passes it in."""

    name = "PREVCANDLE"

    def __init__(self, broker: PaperBroker, binance_feed: BinanceKlineFeed):
        self.broker = broker
        self.binance_feed = binance_feed
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)
        self.ai = AISignalEngine()

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

    def _record_trade_result(self, pnl: float):
        if pnl >= 0:
            self.wins += 1
        else:
            self.losses += 1

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def reset_for_window(self, window: WindowMarket):
        self.s = EngineState(window=window)
        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return
        self._log("WINDOW_OPEN", note=(
            f"AI signal engine predicts next window (trained on {self.ai.n_trained} past windows, "
            f"min {config.AI_MIN_SAMPLES_TO_PREDICT} to trade) -- RSI({config.RSI_PERIOD}) veto on the real "
            f"predicted side if overbought/oversold, then FADE: resting limit buy is placed on the OPPOSITE "
            f"side, always, @ {config.ORDER_PRICE}. {config.ORDER_SHARES:.0f}sh, maker, no SL, TP {config.TP_PRICE}"
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

    # ---- signal: AI prediction off the Binance feed --------------------------

    def _check_signal(self, now: float):
        # The previous window's last minute is exactly the 60 seconds
        # right before this window opened -- i.e. [this_open-60, this_open).
        # Still needed: it's the candle the AI feature set is computed
        # relative to, and its own color is one of those features.
        signal_open_ts = self.s.window.open_ts - 60
        candle = self.binance_feed.get_candle(signal_open_ts)

        if candle is None or not candle.closed:
            # Binance data for this candle isn't in yet -- keep waiting,
            # retried every tick. It should normally already be closed
            # (it ended exactly when this window opened), but feed lag
            # or a reconnect can delay it briefly.
            return

        color = "green" if candle.close > candle.open else ("red" if candle.close < candle.open else "flat")
        self.s.decided_color = color
        self._log("CANDLE_READ", price=candle.close,
                   note=(f"previous window's last-minute candle: open {candle.open}, close {candle.close} -> "
                         f"{color} (open_time {candle.open_time}) -- one input feature for the AI signal"))

        feats = self.ai.compute_features(self.binance_feed, signal_open_ts)
        self.s.ai_features = feats
        self.s.decision_made = True

        if feats is None:
            self.total_no_signal_windows += 1
            self._log("NO_TRADE", note="AI signal engine missing feature history (startup/reconnect) -- skipping")
            return

        side, p_up_or_conf = self.ai.predict(feats)
        self.s.ai_p_up = p_up_or_conf if side is None else None

        if side is None:
            self.total_flat_candles += 1   # reused as "AI gave no tradeable signal this window"
            if self.ai.n_trained < config.AI_MIN_SAMPLES_TO_PREDICT:
                reason = f"cold start, only trained on {self.ai.n_trained}/{config.AI_MIN_SAMPLES_TO_PREDICT} windows so far"
            else:
                reason = f"low confidence (P(up)={p_up_or_conf:.2f}, inside the {config.AI_CONFIDENCE_BAND} no-trade band)"
            self._log("NO_TRADE", note=f"AI signal: {reason} -- skipping this window")
            return

        confidence = p_up_or_conf
        self.s.ai_predicted_side = side
        self.s.ai_confidence = confidence
        self._log("AI_SIGNAL", side=side.value, price=candle.close,
                   note=f"AI predicts {side.value} (confidence {confidence:.2f}), trained on {self.ai.n_trained} windows")

        rsi = self.binance_feed.get_rsi(signal_open_ts, config.RSI_PERIOD)
        if rsi is not None:
            if side == Side.UP and rsi > config.RSI_OVERBOUGHT:
                self.total_rsi_vetoes += 1
                self._log("RSI_VETO", side=side.value, note=(
                    f"real AI signal UP but RSI({config.RSI_PERIOD}) {rsi:.1f} > "
                    f"{config.RSI_OVERBOUGHT} (overbought) -- skipping, momentum looks exhausted"))
                return
            if side == Side.DOWN and rsi < config.RSI_OVERSOLD:
                self.total_rsi_vetoes += 1
                self._log("RSI_VETO", side=side.value, note=(
                    f"real AI signal DOWN but RSI({config.RSI_PERIOD}) {rsi:.1f} < "
                    f"{config.RSI_OVERSOLD} (oversold) -- skipping, momentum looks exhausted"))
                return

        # Always fade: trade the opposite side of the real AI prediction.
        trade_side = side.other()

        self.s.order = RestingOrder(side=trade_side, price=config.ORDER_PRICE, shares=config.ORDER_SHARES,
                                     signal_side=side)
        self.total_orders_placed += 1
        rsi_note = f", RSI({config.RSI_PERIOD}) {rsi:.1f}" if rsi is not None else ", RSI n/a (insufficient history)"
        self._log("RUNG_PLACED", side=trade_side.value, price=config.ORDER_PRICE, shares=config.ORDER_SHARES,
                   note=(f"AI signal {side.value} (conf {confidence:.2f}){rsi_note} -> FADED -> resting limit buy "
                         f"{trade_side.value}: {config.ORDER_SHARES:.0f}sh @ {config.ORDER_PRICE}"))

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
                                    entry_ts=now, signal_side=order.signal_side)

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
        self._record_trade_result(pnl)
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

        # AI online learning: one gradient step per window, as long as we
        # both computed features for it and know the true outcome -- this
        # runs whether or not a trade was actually placed (RSI veto /
        # illiquidity can still block a trade the AI called correctly),
        # and even if the engine is halted, so the model keeps improving.
        if self.s.ai_features is not None and winning_side is not None:
            actual_up = (winning_side == Side.UP)
            self.ai.learn(self.s.ai_features, actual_up)
            self.ai.record_prediction_result(self.s.ai_predicted_side, actual_up)
            self._log("AI_LEARN", note=(
                f"window resolved {winning_side.value} -- AI trained on this window "
                f"(n_trained now {self.ai.n_trained})"))

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
                self._record_trade_result(pnl)
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
                "signal_side": pos.signal_side.value if pos.signal_side else None,
            }

        order_payload = None
        if self.s.order is not None:
            order_payload = {
                "side": self.s.order.side.value, "price": self.s.order.price,
                "shares": self.s.order.shares, "status": self.s.order.status,
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

        win_rate = round(100 * self.wins / (self.wins + self.losses), 1) if (self.wins + self.losses) else None

        return {
            "engine": "PREVCANDLE", "label": "AI signal (faded)",

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
            "ai_predicted_side": self.s.ai_predicted_side.value if self.s.ai_predicted_side else None,
            "ai_confidence": round(self.s.ai_confidence, 3) if self.s.ai_confidence is not None else None,
            "ai_p_up": round(self.s.ai_p_up, 3) if self.s.ai_p_up is not None else None,
            "ai": self.ai.status(),
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
            "win_rate": win_rate,

            "status": status,

            "def": {
                "shares": config.ORDER_SHARES,
                "order_price": config.ORDER_PRICE,
                "tp_price": config.TP_PRICE,
            },
        }
