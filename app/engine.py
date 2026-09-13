"""
Trading engine -- two independent non-overlapping limit-order grids
(one per side), built for the first 120s of a window, then a combined
profit-target exit.

See app/config.py for the full strategy write-up. Summary: for the
first 120s, each side independently drops a new resting limit buy at
(current mid - 0.05) any time that price isn't within 0.05 of an order
already placed on that side. Resting orders fill (maker, no fee, at
their own limit price) whenever that side's ask reaches them, any time
during those 120s. The instant the 120s grid-building window times
out, any rung still resting (never filled) is cancelled -- no new
orders, no more waiting for stragglers to fill. From there the bot
just watches combined unrealized P&L across both sides' filled shares,
and the instant it reaches +$10, sells everything (taker, priced by
walking real book depth) and is done for the window.
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
# One resting/filled/cancelled grid rung
# ---------------------------------------------------------------------------

@dataclass
class GridOrder:
    price: float
    shares: float
    status: str = "resting"   # resting | filled | cancelled
    placed_ts: float = 0.0
    filled_ts: Optional[float] = None


@dataclass
class SideBook:
    orders: List[GridOrder] = field(default_factory=list)  # every order ever placed on this side
    shares_held: float = 0.0     # aggregate filled shares, all rungs combined
    cost_basis: float = 0.0      # aggregate cost of those shares (fee-free, maker fills)

    def rung_prices(self) -> List[float]:
        return [o.price for o in self.orders]  # includes resting + filled + cancelled -- a used price slot stays used


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    # Full order-book depth for the current tick, when available. None
    # means "no depth data this tick" (fall back to the scalar price for
    # the whole size); an empty list means "book fetched fine, there is
    # genuinely nothing resting on this side" -- a real no-liquidity
    # signal, not a data gap. See Engine._realistic_fill_price.
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    up_book: SideBook = field(default_factory=SideBook)
    down_book: SideBook = field(default_factory=SideBook)
    done_for_window: bool = False   # set True once the profit target has been hit and everything sold
    grid_timeout_handled: bool = False  # set True once resting rungs have been cancelled at the 120s grid-building timeout

    total_orders_placed: int = 0
    total_rung_fills: int = 0
    total_illiquid_skips: int = 0
    total_profit_target_hits: int = 0
    total_forced_closes: int = 0
    no_trade_windows: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    last_window_pnl: float = 0.0


class Engine:
    """Independent dual-grid engine, driven off its own capital pool.
    Kept as the class name `Engine` / constructed the same way
    (Engine(broker)) so app/state.py doesn't need structural changes."""

    name = "GRID"

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
            f"building independent grids on both sides for {config.GRID_DURATION_SECONDS}s -- "
            f"rungs {config.GRID_SPACING} apart, {config.GRID_ORDER_SHARES:.0f}sh each, maker limit buys. "
            f"At {config.GRID_DURATION_SECONDS}s: cancel any still-resting rungs, then watch combined "
            f"unrealized P&L and sell everything (taker) at +${config.PROFIT_TARGET_USD:.0f}"
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

        if self.s.done_for_window:
            return

        elapsed = now - self.s.window.open_ts
        if elapsed < config.GRID_DURATION_SECONDS:
            self._maybe_place_rung(Side.UP, now)
            self._maybe_place_rung(Side.DOWN, now)

        # Checked every tick, but after the grid-building timeout below
        # cancels all resting orders, there's nothing left here to fill.
        self._check_fills(Side.UP, now)
        self._check_fills(Side.DOWN, now)

        if elapsed >= config.GRID_DURATION_SECONDS:
            if not self.s.grid_timeout_handled:
                self._cancel_resting_orders(now)
                self.s.grid_timeout_handled = True
            self._check_profit_target(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _mid_for(self, side: Side) -> Optional[float]:
        return _midpoint(self._bid_for(side), self._ask_for(side))

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    def _book_for(self, side: Side) -> SideBook:
        return self.s.up_book if side == Side.UP else self.s.down_book

    @staticmethod
    def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
        """Volume-weighted average price to actually trade `shares`
        against a real order book, instead of assuming the whole size
        fills at the single best quote. Used for the TAKER exits only
        (profit-target sell-everything, forced window-end close) --
        resting maker rungs fill at their own exact limit price, no
        walk needed.

        - levels is None -> no depth data this tick; fall back to
          filling the whole size at `fallback_price`.
        - levels is [] -> book fetched fine, genuinely nothing resting
          on this side; return None, caller must not invent a fill.
        - levels is non-empty -> walk best-price-first; any shortfall
          in visible depth is priced at the worst level seen.
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

    # ---- grid building: independent per side -------------------------------

    def _maybe_place_rung(self, side: Side, now: float):
        mid = self._mid_for(side)
        if mid is None:
            return
        target = round(mid - config.GRID_SPACING, 4)
        if target <= 0 or target >= 1:
            return  # not a valid tradeable price

        book = self._book_for(side)
        existing_prices = book.rung_prices()
        # "must not overlap" / "0.05 distance" -- no existing order
        # (resting, filled, or cancelled) may sit closer than GRID_SPACING
        # to the candidate.
        too_close = any(abs(p - target) < config.GRID_SPACING - 1e-9 for p in existing_prices)
        if too_close:
            return

        order = GridOrder(price=target, shares=config.GRID_ORDER_SHARES, placed_ts=now)
        book.orders.append(order)
        self.s.total_orders_placed += 1
        self._log("RUNG_PLACED", side=side.value, price=target, shares=order.shares,
                   note=f"resting limit buy: {order.shares:.0f}sh @ {target} (mid was {mid}, {config.GRID_SPACING} below)")

    def _check_fills(self, side: Side, now: float):
        book = self._book_for(side)
        ask = self._ask_for(side)
        if ask is None:
            return
        for order in book.orders:
            if order.status != "resting":
                continue
            if ask <= order.price:
                # maker fill: exact limit price, no slippage, no fee.
                # This debit is the missing piece that was silently
                # inflating equity -- shares_held/cost_basis were being
                # updated on every fill without ever taking the cost out
                # of the actual capital balance, so buying looked free
                # and "equity" (balance + market value) double-counted
                # every dollar spent on a fill.
                order.status = "filled"
                order.filled_ts = now
                cost = order.shares * order.price
                self.capital.balance -= cost
                book.shares_held += order.shares
                book.cost_basis += cost
                self.s.total_rung_fills += 1
                self._log("RUNG_FILL", side=side.value, price=order.price, shares=order.shares, fee=0.0,
                           note=(f"resting buy filled (maker, no fee): {order.shares:.0f}sh @ {order.price} "
                                 f"(ask reached it) -- {side.value} now holds {book.shares_held:.0f}sh, "
                                 f"cost basis ${book.cost_basis:.2f}"))
                if self.capital.check_halt():
                    self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
                    return

    # ---- grid-building timeout: drop unfilled rungs, keep filled shares ----

    def _cancel_resting_orders(self, now: float):
        """Called once, the instant the 120s grid-building window times
        out. Any rung that never got a fill is cancelled here instead of
        being left live for the rest of the window -- only rungs that
        already filled carry forward into the profit-target watch phase.
        Filled shares are untouched; this only touches status=='resting'
        orders."""
        for side in (Side.UP, Side.DOWN):
            book = self._book_for(side)
            cancelled = 0
            for order in book.orders:
                if order.status == "resting":
                    order.status = "cancelled"
                    cancelled += 1
            if cancelled:
                self._log("GRID_TIMEOUT_CANCEL", side=side.value, note=(
                    f"grid-building window ({config.GRID_DURATION_SECONDS}s) timed out -- "
                    f"cancelled {cancelled} still-resting unfilled rung(s) on {side.value}"
                ))

    # ---- profit target: combined across both sides -------------------------

    def _combined_unrealized_pnl(self) -> float:
        total = 0.0
        for side in (Side.UP, Side.DOWN):
            book = self._book_for(side)
            if book.shares_held <= 0:
                continue
            bid = self._bid_for(side)
            mark = bid if bid is not None else (book.cost_basis / book.shares_held)
            total += book.shares_held * mark - book.cost_basis
        return total

    def _check_profit_target(self, now: float):
        combined = self._combined_unrealized_pnl()
        if combined >= config.PROFIT_TARGET_USD:
            self.s.total_profit_target_hits += 1
            self._log("PROFIT_TARGET_HIT", price=round(combined, 4),
                       note=f"combined unrealized P&L reached ${combined:.2f} (target ${config.PROFIT_TARGET_USD:.0f}) -- selling everything")
            self._sell_everything(now, reason="PROFIT_TARGET_EXIT",
                                   note_prefix="profit target hit, selling out")
            self.s.done_for_window = True

    def _sell_everything(self, now: float, reason: str, note_prefix: str):
        """Cancels any still-resting orders and taker-sells every filled
        share on both sides, priced by walking real book depth."""
        for side in (Side.UP, Side.DOWN):
            book = self._book_for(side)
            for order in book.orders:
                if order.status == "resting":
                    order.status = "cancelled"
            if book.shares_held <= 0:
                continue
            bid = self._bid_for(side)
            levels = self._bid_levels_for(side)
            fill_price = self._realistic_fill_price(levels, book.shares_held, bid)
            if fill_price is None and levels is not None:
                # confirmed empty book -- nobody bidding on this side at
                # all; realistically worth close to nothing right now
                fill_price = 0.0
                self._log("NO_LIQUIDITY", side=side.value, price=bid,
                           note=f"{reason} but book has zero bid depth on {side.value} -- assuming worst case $0")
            elif fill_price is None:
                fill_price = bid if bid is not None else (book.cost_basis / book.shares_held)
                self._log("NO_LIQUIDITY", side=side.value, price=bid,
                           note=f"{reason} but no book data at all on {side.value} -- falling back to last known price")
            self._settle_side_close(side, book, fill_price, reason, note_prefix)

    def _settle_side_close(self, side: Side, book: SideBook, price: float, reason: str, note_prefix: str):
        shares = book.shares_held
        cost = book.cost_basis
        fee = self.broker.taker_fee_amount(shares, price)
        proceeds = shares * price - fee
        pnl = proceeds - cost
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        if pnl >= 0:
            self.s.wins += 1
        else:
            self.s.losses += 1
        self._log(reason, side=side.value, price=round(cost / shares, 4) if shares else None,
                   shares=shares, pnl=pnl, fee=fee,
                   note=(f"{note_prefix} (taker, real fill @ {price:.4f}): {shares:.0f}sh sold across all "
                         f"filled rungs (avg cost {cost/shares:.4f}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()
        book.shares_held = 0.0
        book.cost_basis = 0.0

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted and not self.s.done_for_window:
            any_shares = self.s.up_book.shares_held > 0 or self.s.down_book.shares_held > 0
            for side in (Side.UP, Side.DOWN):
                book = self._book_for(side)
                for order in book.orders:
                    if order.status == "resting":
                        order.status = "cancelled"
            if any_shares:
                self._sell_everything(time.time(), reason="FORCED_CLOSE", note_prefix="window closed, forced taker close")
            self.s.total_forced_closes += 1 if any_shares else 0

        if not self.capital.halted and self.s.total_orders_placed == 0:
            self.s.no_trade_windows += 1
            self._log("NO_TRADE", note="never got a live price to place a single grid order this window")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def _side_payload(self, side: Side) -> dict:
        book = self._book_for(side)
        bid = self._bid_for(side)
        mark = bid if bid is not None else None
        market_value = book.shares_held * mark if (mark is not None and book.shares_held > 0) else None
        unrealized = (market_value - book.cost_basis) if market_value is not None else None
        orders = [{
            "price": o.price, "shares": o.shares, "status": o.status,
            "placed_ts": o.placed_ts, "filled_ts": o.filled_ts,
        } for o in book.orders]
        return {
            "side": side.value,
            "orders": orders,
            "resting_count": sum(1 for o in book.orders if o.status == "resting"),
            "filled_count": sum(1 for o in book.orders if o.status == "filled"),
            "shares_held": book.shares_held,
            "cost_basis": round(book.cost_basis, 4),
            "mark_price": mark,
            "market_value": round(market_value, 4) if market_value is not None else None,
            "unrealized_pnl": round(unrealized, 4) if unrealized is not None else None,
        }

    def snapshot(self) -> dict:
        up = self._side_payload(Side.UP)
        down = self._side_payload(Side.DOWN)
        combined_unrealized = self._combined_unrealized_pnl()
        open_market_value = (up["market_value"] or 0) + (down["market_value"] or 0)
        realized_pnl = round(self.s.total_pnl, 4)

        elapsed = (time.time() - self.s.window.open_ts) if self.s.window else None
        grid_building = elapsed is not None and elapsed < config.GRID_DURATION_SECONDS
        seconds_until_watch_phase = (config.GRID_DURATION_SECONDS - elapsed) if grid_building else None

        if self.capital.halted:
            status = "halted"
        elif self.s.done_for_window:
            status = "done"
        elif grid_building:
            status = "building"
        else:
            status = "watching"

        return {
            "engine": "GRID", "label": "Independent dual-grid, profit-target exit",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": realized_pnl,
            "unrealized_pnl": round(combined_unrealized, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "up_book": up,
            "down_book": down,
            "done_for_window": self.s.done_for_window,
            "grid_building": grid_building,
            "seconds_until_watch_phase": round(seconds_until_watch_phase, 1) if seconds_until_watch_phase is not None else None,

            "total_orders_placed": self.s.total_orders_placed,
            "total_rung_fills": self.s.total_rung_fills,
            "total_illiquid_skips": self.s.total_illiquid_skips,
            "total_profit_target_hits": self.s.total_profit_target_hits,
            "total_forced_closes": self.s.total_forced_closes,
            "no_trade_windows": self.s.no_trade_windows,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,

            "def": {
                "grid_order_shares": config.GRID_ORDER_SHARES,
                "grid_spacing": config.GRID_SPACING,
                "grid_duration_seconds": config.GRID_DURATION_SECONDS,
                "profit_target_usd": config.PROFIT_TARGET_USD,
            },
        }
