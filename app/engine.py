"""
Trading engine -- one position at a time, re-armed after every stop out.

See app/config.py for the full strategy write-up. Summary: no cold
start. Watch both sides' mid-price; the instant either one reaches 0.60,
buy that side (taker, real depth-weighted price) and immediately arm a
trailing stop at 0.50, ratcheting up 0.10 at a time as price climbs.
If the trailing stop hits, the position closes and, after a
REARM_COOLDOWN_SECONDS (10s) pause, the engine goes right back to
watching both sides for the next 0.60 cross -- this can repeat any
number of times in a window. The cooldown exists because a trailing
stop can itself fire exactly at 0.60 (ratcheted up from an earlier
run to 0.70+, then pulled back), and re-watching immediately would
re-trigger on that same 0.60 cross the stop just exited on. If TP
(0.99) hits instead, the engine stops re-arming for the rest of that
window. All fills are taker orders priced by walking real order-book
depth (see _realistic_fill_price), not just the top-of-book quote.
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
# The single open position (if any) and its trailing stop
# ---------------------------------------------------------------------------

@dataclass
class Position:
    side: Side
    entry_price: float          # real depth-weighted fill, not just top-of-book ask
    shares: float
    cost: float
    entry_ts: float

    # Entry only ever happens right as price crosses TRAIL_ARM_PRICE, so
    # the trail is armed immediately at entry -- never None like the
    # dual-entry version, where a side could sit unprotected pre-arm.
    trail_sl: float = 0.0
    last_trail_level: float = 0.0


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

    position: Optional[Position] = None
    done_for_window: bool = False   # set True after a TP hit -- no more entries this window
    rearm_at: float = 0.0           # monotonic ts; entries are blocked until now >= this (post trailing-stop cooldown)

    fills_this_window: int = 0
    last_window_pnl: float = 0.0

    total_entries: int = 0
    total_rearms: int = 0            # number of times watching resumed after a trailing-stop exit
    total_tp_fills: int = 0
    total_sl_fills: int = 0
    total_trail_updates: int = 0
    total_forced_closes: int = 0
    total_illiquid_skips: int = 0
    no_trade_windows: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0


class Engine:
    """One-way re-arming trailing-stop engine, driven off its own
    capital pool. Kept as the class name `Engine` / constructed the
    same way (Engine(broker)) so app/state.py doesn't need structural
    changes."""

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
            f"watching both sides -- first to reach {config.TRAIL_ARM_PRICE} gets bought "
            f"({config.SHARES_PER_SIDE:.0f}sh, taker), trail arms immediately at "
            f"{config.TRAIL_ARM_PRICE - config.TRAIL_STEP:.2f}, TP {config.TP_PRICE} -- "
            f"a stop-out re-arms and watches again, a TP does not"
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
        elif not self.s.done_for_window and now >= self.s.rearm_at:
            self._check_entry(now)

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

    @staticmethod
    def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
        """Volume-weighted average price to actually trade `shares`
        against a real order book, instead of assuming the whole size
        fills at the single best quote.

        - levels is None -> no depth data was available this tick; fall
          back to filling the whole size at `fallback_price`.
        - levels is [] -> the book was fetched successfully and there
          is truly nothing resting on this side right now; return None
          -- the caller should NOT invent a fill.
        - levels is non-empty -> walk it best-price-first. If the
          visible depth doesn't cover the full size, the unfilled
          remainder is conservatively priced at the worst level seen,
          so a thin book pulls the average fill price accordingly
          instead of quietly pretending it doesn't matter.
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

    # ---- entry: first side to reach TRAIL_ARM_PRICE ------------------------

    def _check_entry(self, now: float):
        up_mid = self._mid_for(Side.UP)
        down_mid = self._mid_for(Side.DOWN)
        # deterministic tie-break: UP checked first if both cross the same tick
        if up_mid is not None and up_mid >= config.TRAIL_ARM_PRICE:
            self._enter(Side.UP, now)
        elif down_mid is not None and down_mid >= config.TRAIL_ARM_PRICE:
            self._enter(Side.DOWN, now)

    def _enter(self, side: Side, now: float):
        ask = self._ask_for(side)
        if ask is None:
            return  # no live ask yet -- retry next tick
        shares = config.SHARES_PER_SIDE
        levels = self._ask_levels_for(side)
        fill_price = self._realistic_fill_price(levels, shares, ask)
        if fill_price is None:
            # book fetched fine but genuinely has no offers right now --
            # can't buy into nothing; keep watching, retry next tick
            self.s.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=side.value, price=ask,
                       note=f"{side.value} reached {config.TRAIL_ARM_PRICE} but book has zero ask depth -- waiting")
            return

        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        self.s.total_entries += 1

        slip_note = f" (book-depth-weighted, best ask was {ask})" if abs(fill_price - ask) > 1e-9 else ""
        trail_sl = round(config.TRAIL_ARM_PRICE - config.TRAIL_STEP, 4)
        self._log("ENTRY_FILL", side=side.value, price=fill_price, shares=shares, fee=fee,
                   note=(f"{side.value} reached {config.TRAIL_ARM_PRICE} -- taker buy {shares:.0f}sh @ real fill "
                         f"{fill_price:.4f}{slip_note} (fee ${fee:.4f}) -- trail armed immediately, SL {trail_sl}, "
                         f"TP {config.TP_PRICE}"))

        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return

        self.s.position = Position(
            side=side, entry_price=fill_price, shares=shares, cost=cost, entry_ts=now,
            trail_sl=trail_sl, last_trail_level=config.TRAIL_ARM_PRICE,
        )

    # ---- exit: trailing stop (re-arms) or TP (does not) --------------------

    def _check_exit(self, now: float):
        pos = self.s.position
        if pos is None:
            return
        bid = self._bid_for(pos.side)
        if bid is None:
            return

        if bid >= config.TP_PRICE:
            self._try_close(pos, trigger_bid=bid, reason="TP_FILL", note_prefix="take profit hit", rearm=False, now=now)
            return

        if bid <= pos.trail_sl:
            self._try_close(pos, trigger_bid=bid, reason="SL_FILL", note_prefix="trailing stop hit", rearm=True, now=now)
            return

        self._advance_trail(pos, bid)

    def _try_close(self, pos: Position, trigger_bid: float, reason: str, note_prefix: str, rearm: bool, now: float):
        """A trigger condition (TP or trailing SL) has been met based on
        the top-of-book bid. The actual fill is priced against real book
        depth, which can be materially worse than that trigger price if
        the side has gone illiquid."""
        levels = self._bid_levels_for(pos.side)
        fill_price = self._realistic_fill_price(levels, pos.shares, trigger_bid)
        if fill_price is None:
            # trigger fired but there's truly nothing to sell into this
            # instant -- don't invent a fill, wait for the book to show
            # something (position stays open, re-checked next tick)
            self.s.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=pos.side.value, price=trigger_bid,
                       note=f"{reason} triggered at bid {trigger_bid} but book has zero depth to sell into -- waiting")
            return

        if reason == "TP_FILL":
            self.s.total_tp_fills += 1
        else:
            self.s.total_sl_fills += 1
        self._close(pos, price=fill_price, reason=reason, note_prefix=note_prefix, trigger_price=trigger_bid)
        self.s.position = None

        if rearm:
            self.s.total_rearms += 1
            self.s.rearm_at = now + config.REARM_COOLDOWN_SECONDS
            self._log("REARMED", note=(
                f"trailing stop closed it out -- cooling down {config.REARM_COOLDOWN_SECONDS:.0f}s before "
                f"watching both sides again for the next {config.TRAIL_ARM_PRICE} cross "
                f"({self.s.total_rearms} rearm(s) this window)"
            ))
        else:
            self.s.done_for_window = True
            self._log("DONE_FOR_WINDOW", note="take profit hit -- no more entries for the rest of this window")

    def _advance_trail(self, pos: Position, bid: float):
        """Ratchets pos.trail_sl up every time price reaches a new
        TRAIL_ARM_PRICE + n*TRAIL_STEP level. Never moves down. Example
        with TRAIL_ARM_PRICE=0.60, TRAIL_STEP=0.10: entry (price hit
        0.60) -> SL 0.50; price hits 0.70 -> SL 0.60; price hits 0.80 ->
        SL 0.70."""
        next_level = round(pos.last_trail_level + config.TRAIL_STEP, 4)
        moved = False
        while bid >= next_level:
            pos.last_trail_level = next_level
            new_sl = round(next_level - config.TRAIL_STEP, 4)
            if new_sl > pos.trail_sl:
                pos.trail_sl = new_sl
            moved = True
            next_level = round(next_level + config.TRAIL_STEP, 4)
        if moved:
            self.s.total_trail_updates += 1
            self._log("TRAIL_UPDATE", side=pos.side.value, price=bid,
                       note=f"price reached {pos.last_trail_level:.2f} -- stop loss now {pos.trail_sl}")

    def _close(self, pos: Position, price: float, reason: str, note_prefix: str, trigger_price: Optional[float] = None):
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
        slip_note = ""
        if trigger_price is not None and abs(price - trigger_price) > 1e-9:
            slip_note = f" (triggered @ {trigger_price}, book-depth-weighted real fill {price:.4f})"
        self._log(reason, side=pos.side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee,
                   note=(f"{note_prefix} (taker, real fill @ {price:.4f}{slip_note}): {pos.shares:.0f}sh sold "
                         f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted and self.s.position is not None:
            pos = self.s.position
            bid = self._bid_for(pos.side)
            levels = self._bid_levels_for(pos.side)
            fill_price = self._realistic_fill_price(levels, pos.shares, bid)
            if fill_price is None and levels is not None:
                # confirmed empty book right at window close -- for a
                # binary market about to settle, nobody bidding on this
                # side means it's realistically worth close to nothing.
                fill_price = 0.0
                self._log("NO_LIQUIDITY", side=pos.side.value, price=bid,
                           note="window closed with zero bid depth on this side -- assuming worst case $0, not entry price")
            elif fill_price is None:
                # no depth data at all this tick (fetch gap, not a
                # confirmed-empty book) -- fall back to the old flat
                # assumption instead of guessing $0
                fill_price = pos.entry_price
                self._log("NO_LIQUIDITY", side=pos.side.value, price=bid,
                           note="window closed with no book data at all on this side -- falling back to entry price, not a confirmed $0")
            self._close(pos, price=fill_price, reason="FORCED_CLOSE",
                        note_prefix="window closed, forced taker close", trigger_price=bid)
            self.s.total_forced_closes += 1
            self.s.position = None

        if not self.capital.halted and self.s.total_entries == 0:
            self.s.no_trade_windows += 1
            self._log("NO_TRADE", note=f"price never reached {config.TRAIL_ARM_PRICE} on either side this window")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def _position_payload(self) -> Optional[dict]:
        pos = self.s.position
        if pos is None:
            return None
        now = time.time()
        bid = self._bid_for(pos.side)
        mark = bid if bid is not None else pos.entry_price
        market_value = pos.shares * mark
        pos_pnl = market_value - pos.cost
        return {
            "side": pos.side.value, "entry_price": pos.entry_price, "shares": pos.shares,
            "cost": round(pos.cost, 4), "mark_price": mark,
            "unrealized_pnl": round(pos_pnl, 4), "seconds_since_entry": round(now - pos.entry_ts, 1),
            "trail_sl": pos.trail_sl, "trail_armed": True,
            "last_trail_level": pos.last_trail_level,
        }

    def snapshot(self) -> dict:
        payload = self._position_payload()
        open_positions = [payload] if payload else []

        unrealized_pnl = payload["unrealized_pnl"] if payload else 0.0
        open_market_value = payload["shares"] * payload["mark_price"] if payload else 0.0
        realized_pnl = round(self.s.total_pnl, 4)

        now = time.time()
        cooling_down = self.s.rearm_at > now
        if self.capital.halted:
            status = "halted"
        elif payload:
            status = "open"
        elif self.s.done_for_window:
            status = "done"
        elif cooling_down:
            status = "cooldown"
        else:
            status = "watching"

        return {
            "engine": "TRAIL", "label": "One-way re-arming trailing stop",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": realized_pnl,
            "unrealized_pnl": round(unrealized_pnl, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "position": payload,
            "open_positions": open_positions,
            "done_for_window": self.s.done_for_window,
            "cooldown_seconds_left": round(max(0.0, self.s.rearm_at - now), 1) if cooling_down else 0.0,

            "fills_this_window": self.s.fills_this_window,
            "total_entries": self.s.total_entries,
            "total_rearms": self.s.total_rearms,
            "total_tp_fills": self.s.total_tp_fills,
            "total_sl_fills": self.s.total_sl_fills,
            "total_trail_updates": self.s.total_trail_updates,
            "total_forced_closes": self.s.total_forced_closes,
            "total_illiquid_skips": self.s.total_illiquid_skips,
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
