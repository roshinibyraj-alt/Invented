"""
Trading engine -- one trade per window, direction decided by the color
of BTC's own second 1-minute spot candle (Binance).

See app/config.py for the full strategy write-up. Summary: watch
minute 1 do nothing; the instant minute 2's Binance candle closes,
green -> buy DOWN, red -> buy UP, flat -> no trade. Real taker buy on
Polymarket's own book (Binance is signal-only, never execution). No SL.
TP 0.99, real taker exit. One trade max per window; no re-arm.
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
    single best quote.

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
class Position:
    side: Side
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
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    position: Optional[Position] = None
    decision_made: bool = False     # True once the minute-2 candle has been read (whichever way it went)
    decided_color: Optional[str] = None   # "green" | "red" | "flat", for display, once known

    total_entries: int = 0
    total_tp_fills: int = 0
    total_forced_closes: int = 0
    total_flat_candles: int = 0
    total_no_signal_windows: int = 0   # Binance data never arrived in time
    total_illiquid_skips: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    last_window_pnl: float = 0.0


class Engine:
    """Candle-color engine, driven off a single shared capital pool.
    Constructed as Engine(broker, binance_feed) -- app/state.py owns
    the BinanceKlineFeed instance and passes it in so this engine never
    manages the websocket connection itself, only reads from it."""

    name = "CANDLE"

    def __init__(self, broker: PaperBroker, binance_feed: BinanceKlineFeed):
        self.broker = broker
        self.binance_feed = binance_feed
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
            f"watching minute 1 (0-60s), reading Binance's minute-2 candle "
            f"({config.SIGNAL_MINUTE_OFFSET}-{config.SIGNAL_MINUTE_OFFSET+config.SIGNAL_MINUTE_DURATION}s) for color -- "
            f"green->DOWN, red->UP, flat->no trade. {config.BASE_SHARES:.0f}sh, taker, no SL, TP {config.TP_PRICE}"
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

        if self.s.decision_made:
            return  # already decided this window (traded, or a flat candle skip) -- no re-arm

        elapsed = now - self.s.window.open_ts
        if elapsed < config.SIGNAL_MINUTE_OFFSET + config.SIGNAL_MINUTE_DURATION:
            return  # minute 2 hasn't finished yet

        self._check_signal(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    # ---- signal: read the minute-2 Binance candle ---------------------------

    def _check_signal(self, now: float):
        minute2_open_ts = self.s.window.open_ts + config.SIGNAL_MINUTE_OFFSET
        candle = self.binance_feed.get_candle(minute2_open_ts)

        if candle is None or not candle.closed:
            # Binance data for this candle isn't in yet -- keep waiting,
            # retried every tick. Not a skip; just not ready.
            return

        if candle.close > candle.open:
            color = "green"
        elif candle.close < candle.open:
            color = "red"
        else:
            color = "flat"

        self.s.decided_color = color
        self._log("CANDLE_READ", price=candle.close,
                   note=(f"Binance minute-2 candle: open {candle.open}, close {candle.close} -> {color} "
                         f"(open_time {candle.open_time})"))

        if color == "flat":
            self.s.total_flat_candles += 1
            self.s.decision_made = True
            self._log("NO_TRADE", note="flat candle (close == open) -- no directional signal, skipping this window")
            return

        side = Side.DOWN if color == "green" else Side.UP
        self._enter(side, now)
        self.s.decision_made = True

    def _enter(self, side: Side, now: float):
        ask = self._ask_for(side)
        if ask is None:
            self.s.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=side.value, note=f"signal fired ({side.value}) but no live ask yet -- skipping entry this window")
            return
        levels = self._ask_levels_for(side)
        fill_price = _realistic_fill_price(levels, config.BASE_SHARES, ask)
        if fill_price is None:
            self.s.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=side.value, price=ask,
                       note=f"signal fired ({side.value}) but book has zero ask depth -- skipping entry this window")
            return
        shares = config.BASE_SHARES
        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        self.s.total_entries += 1
        self._log("ENTRY_FILL", side=side.value, price=fill_price, shares=shares, fee=fee,
                   note=(f"candle signal {self.s.decided_color} -> taker buy {side.value}: {shares:.0f}sh @ "
                         f"real fill {fill_price:.4f} (fee ${fee:.4f}) -- no SL, TP {config.TP_PRICE}"))
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
        self.s.position = Position(side=side, entry_price=fill_price, shares=shares, cost=cost, entry_ts=now)

    # ---- exit: TP only, no SL ------------------------------------------------

    def _check_exit(self, now: float):
        pos = self.s.position
        bid = self._bid_for(pos.side)
        if bid is None or bid < config.TP_PRICE:
            return
        levels = self._bid_levels_for(pos.side)
        fill_price = _realistic_fill_price(levels, pos.shares, bid)
        if fill_price is None:
            self.s.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=pos.side.value, price=bid,
                       note=f"TP triggered @ {bid} but zero bid depth -- waiting")
            return
        fee = self.broker.taker_fee_amount(pos.shares, fill_price)
        proceeds = pos.shares * fill_price - fee
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        self.s.wins += 1
        self.s.total_tp_fills += 1
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
                self.s.total_pnl += pnl
                self.s.last_window_pnl += pnl
                self.s.total_forced_closes += 1
                if pnl >= 0:
                    self.s.wins += 1
                else:
                    self.s.losses += 1
                self._log("FORCED_CLOSE", side=pos.side.value, price=pos.entry_price, shares=pos.shares,
                           pnl=pnl, fee=fee,
                           note=(f"window closed, forced taker close @ {fill_price:.4f} "
                                 f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
                self.capital.check_halt()
                self.s.position = None
            elif not self.s.decision_made:
                self.s.total_no_signal_windows += 1
                self._log("NO_TRADE", note="minute-2 Binance candle never arrived/closed in time this window")

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

        elapsed = (time.time() - self.s.window.open_ts) if self.s.window else None
        signal_ready_at = config.SIGNAL_MINUTE_OFFSET + config.SIGNAL_MINUTE_DURATION
        seconds_until_signal = (signal_ready_at - elapsed) if (elapsed is not None and elapsed < signal_ready_at) else None

        if self.capital.halted:
            status = "halted"
        elif pos is not None:
            status = "open"
        elif self.s.decision_made:
            status = "done"
        elif elapsed is not None and elapsed < signal_ready_at:
            status = "watching_candle"
        else:
            status = "awaiting_signal"

        return {
            "engine": "CANDLE", "label": "BTC minute-2 candle color",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": round(self.s.total_pnl, 4),
            "unrealized_pnl": round(unrealized, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "position": pos_payload,
            "decision_made": self.s.decision_made,
            "decided_color": self.s.decided_color,
            "seconds_until_signal": round(seconds_until_signal, 1) if seconds_until_signal is not None else None,
            "binance": self.binance_feed.status(),

            "total_entries": self.s.total_entries,
            "total_tp_fills": self.s.total_tp_fills,
            "total_forced_closes": self.s.total_forced_closes,
            "total_flat_candles": self.s.total_flat_candles,
            "total_no_signal_windows": self.s.total_no_signal_windows,
            "total_illiquid_skips": self.s.total_illiquid_skips,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,

            "def": {
                "shares": config.BASE_SHARES,
                "signal_minute_offset": config.SIGNAL_MINUTE_OFFSET,
                "signal_minute_duration": config.SIGNAL_MINUTE_DURATION,
                "tp_price": config.TP_PRICE,
            },
        }
