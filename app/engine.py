"""
Trading engine -- buy both sides immediately at window open, trail a
stop on each side independently once it moves into favor.

See app/config.py for the full strategy write-up. Summary: no cold
start, no arm/threshold ladder. The instant a window is live, buy
SHARES_PER_SIDE of BOTH tokens as taker orders. Each side then runs its
own completely independent trailing-stop: no SL until price first hits
0.60 (and at least TRAIL_MIN_SECONDS have passed since window open),
then a stop at 0.50 that ratchets up by 0.10 every time price climbs
another 0.10. TP is a flat 0.99 for both sides throughout. All entries
and exits are taker orders, priced by walking the real order book depth
for the required size (see _realistic_fill_price) rather than assuming
the whole order fills at the single best bid/ask -- that assumption is
what silently understated losses on a side that goes illiquid late in a
window (a thin, stale-looking top-of-book quote isn't what 300 shares
actually sells for).
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
# Per-side position with its own independent trailing stop
# ---------------------------------------------------------------------------

@dataclass
class SidePosition:
    side: Side
    entry_price: float          # real ask paid at window open
    shares: float
    cost: float
    entry_ts: float

    trail_sl: Optional[float] = None   # None until this side's own price first hits TRAIL_ARM_PRICE
    last_trail_level: float = 0.0      # last TRAIL_ARM_PRICE + n*TRAIL_STEP level this side has reached


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

    entries_done: bool = False   # both-side entry attempted/complete for this window
    up_position: Optional[SidePosition] = None
    down_position: Optional[SidePosition] = None

    fills_this_window: int = 0
    last_window_pnl: float = 0.0

    total_entries: int = 0
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
    """Dual-entry trailing-stop engine, driven off its own capital pool.
    Kept as the class name `Engine` / constructed the same way
    (Engine(broker)) so app/state.py doesn't need structural changes."""

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
            f"buying both sides immediately, {config.SHARES_PER_SIDE:.0f}sh each, taker -- "
            f"trailing stop can only arm after {config.TRAIL_MIN_SECONDS}s AND price at {config.TRAIL_ARM_PRICE}+, "
            f"TP {config.TP_PRICE} for both from the start"
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

        if not self.s.entries_done:
            self._enter_both(now)

        self._check_side(Side.UP, now)
        self._check_side(Side.DOWN, now)

    # ---- entry: both sides, immediately, taker --------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    @staticmethod
    def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
        """Volume-weighted average price to actually trade `shares`
        against a real order book, instead of assuming the whole size
        fills at the single best quote.

        This is the fix for a side going illiquid late in a window: if
        only a few shares are resting at the best bid/ask and the rest
        of the book is thin or empty, a 300-share taker order does NOT
        realistically fill entirely at that top price -- it walks down
        through worse levels. Pricing the whole order at the best quote
        (the old behavior) silently understates the loss on a losing
        side whose book has gone quiet.

        - levels is None -> no depth data was available this tick
          (e.g. the API only gave us a bare best bid/ask, or the book
          fetch failed outright); fall back to filling the whole size
          at `fallback_price`, same as before.
        - levels is [] -> the book was fetched successfully and there
          is truly nothing resting on this side right now; there is
          nothing to realistically trade against, so return None (the
          caller should NOT invent a fill).
        - levels is non-empty -> walk it best-price-first. If the
          visible depth doesn't cover the full size, the unfilled
          remainder is conservatively priced at the worst level seen
          (walking further out never gets a *better* price than that,
          only the same or worse), so a thin book pulls the average
          fill price down instead of quietly pretending it doesn't
          matter.
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

    def _enter_both(self, now: float):
        """Fires each side's entry the first tick a live ask is available
        for it. If only one side has a quote yet, that side goes in and
        the other is retried next tick -- entries_done only flips once
        both are actually filled."""
        if self.s.up_position is None:
            self._fire_entry(Side.UP, now)
        if self.s.down_position is None:
            self._fire_entry(Side.DOWN, now)
        if self.s.up_position is not None and self.s.down_position is not None:
            self.s.entries_done = True

    def _fire_entry(self, side: Side, now: float):
        ask = self._ask_for(side)
        if ask is None:
            return  # no live ask yet -- retry next tick
        shares = config.SHARES_PER_SIDE
        levels = self._ask_levels_for(side)
        fill_price = self._realistic_fill_price(levels, shares, ask)
        if fill_price is None:
            # book fetched fine but genuinely has no offers right now --
            # can't buy into nothing; retry next tick
            self.s.total_illiquid_skips += 1
            return
        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        self.s.total_entries += 1

        slip_note = f" (book-depth-weighted, best ask was {ask})" if abs(fill_price - ask) > 1e-9 else ""
        self._log("ENTRY_FILL", side=side.value, price=fill_price, shares=shares, fee=fee,
                   note=(f"window-open taker buy: {shares:.0f}sh @ real fill {fill_price:.4f}{slip_note} "
                         f"(fee ${fee:.4f}) -- no SL yet, arms at {config.TRAIL_ARM_PRICE}; TP {config.TP_PRICE}"))

        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return

        pos = SidePosition(side=side, entry_price=fill_price, shares=shares, cost=cost, entry_ts=now)
        if side == Side.UP:
            self.s.up_position = pos
        else:
            self.s.down_position = pos

    # ---- per-side: trail update, then SL/TP check -----------------------

    def _check_side(self, side: Side, now: float):
        pos = self.s.up_position if side == Side.UP else self.s.down_position
        if pos is None:
            return
        bid = self._bid_for(side)
        if bid is None:
            return

        if bid >= config.TP_PRICE:
            self._try_close(pos, side, trigger_bid=bid, reason="TP_FILL", note_prefix="take profit hit")
            return

        if pos.trail_sl is not None and bid <= pos.trail_sl:
            self._try_close(pos, side, trigger_bid=bid, reason="SL_FILL", note_prefix="trailing stop hit")
            return

        if self._trail_filter_open(now):
            self._advance_trail(pos, bid)

    def _try_close(self, pos: SidePosition, side: Side, trigger_bid: float, reason: str, note_prefix: str):
        """A trigger condition (TP or trailing SL) has been met based on
        the top-of-book bid. The actual fill is priced against real book
        depth, which can be materially worse than that trigger price if
        the side has gone illiquid -- that gap is exactly what used to
        get silently ignored."""
        levels = self._bid_levels_for(side)
        fill_price = self._realistic_fill_price(levels, pos.shares, trigger_bid)
        if fill_price is None:
            # trigger fired but there's truly nothing to sell into this
            # instant -- don't invent a fill, wait for the book to show
            # something (position stays open, will be re-checked next tick)
            self.s.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=side.value, price=trigger_bid,
                       note=f"{reason} triggered at bid {trigger_bid} but book has zero depth to sell into -- waiting")
            return
        if reason == "TP_FILL":
            self.s.total_tp_fills += 1
        else:
            self.s.total_sl_fills += 1
        self._close(pos, price=fill_price, reason=reason, note_prefix=note_prefix, trigger_price=trigger_bid)
        self._clear(side)

    def _trail_filter_open(self, now: float) -> bool:
        """Trailing-stop activation filter: even if price already reached
        TRAIL_ARM_PRICE, the trail is not allowed to arm/advance until at
        least TRAIL_MIN_SECONDS have passed since the window opened. This
        only gates *arming/advancing* the trail -- TP stays live from the
        very first tick regardless, and once a trail has armed it keeps
        being checked for a stop-out every tick same as always."""
        if self.s.window is None:
            return False
        return (now - self.s.window.open_ts) >= config.TRAIL_MIN_SECONDS

    def _advance_trail(self, pos: SidePosition, bid: float):
        """Ratchets pos.trail_sl up every time price reaches a new
        TRAIL_ARM_PRICE + n*TRAIL_STEP level. Never moves down. Example
        with TRAIL_ARM_PRICE=0.60, TRAIL_STEP=0.10: price hits 0.60 ->
        SL 0.50; price hits 0.70 -> SL 0.60; price hits 0.80 -> SL 0.70."""
        next_level = pos.last_trail_level + config.TRAIL_STEP if pos.last_trail_level > 0 else config.TRAIL_ARM_PRICE
        moved = False
        while bid >= next_level:
            pos.last_trail_level = next_level
            new_sl = round(next_level - config.TRAIL_STEP, 4)
            if pos.trail_sl is None or new_sl > pos.trail_sl:
                pos.trail_sl = new_sl
            moved = True
            next_level = round(next_level + config.TRAIL_STEP, 4)
        if moved:
            self.s.total_trail_updates += 1
            self._log("TRAIL_UPDATE", side=pos.side.value, price=bid,
                       note=f"price reached {pos.last_trail_level:.2f} -- stop loss now {pos.trail_sl}")

    def _clear(self, side: Side):
        if side == Side.UP:
            self.s.up_position = None
        else:
            self.s.down_position = None

    def _close(self, pos: SidePosition, price: float, reason: str, note_prefix: str, trigger_price: Optional[float] = None):
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

        if not self.capital.halted:
            for side, pos in ((Side.UP, self.s.up_position), (Side.DOWN, self.s.down_position)):
                if pos is None:
                    continue
                bid = self._bid_for(side)
                levels = self._bid_levels_for(side)
                fill_price = self._realistic_fill_price(levels, pos.shares, bid)
                if fill_price is None and levels is not None:
                    # levels was a confirmed empty list (book fetched fine,
                    # truly nothing resting) -- for a binary market about
                    # to settle, nobody bidding on this side means it's
                    # realistically worth close to nothing. Falling back
                    # to pos.entry_price (flat, no loss) here would be the
                    # same understatement bug as the trigger-price issue;
                    # $0 is the honest worst case.
                    fill_price = 0.0
                    self._log("NO_LIQUIDITY", side=side.value, price=bid,
                               note="window closed with zero bid depth on this side -- assuming worst case $0, not entry price")
                elif fill_price is None:
                    # levels was None too (no depth data at all this
                    # tick, not a confirmed-empty book) -- genuine data
                    # gap rather than confirmed illiquidity, so fall back
                    # to the old flat assumption instead of guessing $0.
                    fill_price = pos.entry_price
                    self._log("NO_LIQUIDITY", side=side.value, price=bid,
                               note="window closed with no book data at all on this side -- falling back to entry price, not a confirmed $0")
                self._close(pos, price=fill_price, reason="FORCED_CLOSE",
                            note_prefix="window closed, forced taker close", trigger_price=bid)
                self.s.total_forced_closes += 1
                self._clear(side)

        if not self.capital.halted and self.s.total_entries == 0:
            self.s.no_trade_windows += 1
            self._log("NO_TRADE", note="never got a live ask to enter either side this window")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def _position_payload(self, pos: Optional[SidePosition], side: Side) -> Optional[dict]:
        if pos is None:
            return None
        now = time.time()
        bid = self._bid_for(side)
        mark = bid if bid is not None else pos.entry_price
        market_value = pos.shares * mark
        pos_pnl = market_value - pos.cost
        return {
            "side": pos.side.value, "entry_price": pos.entry_price, "shares": pos.shares,
            "cost": round(pos.cost, 4), "mark_price": mark,
            "unrealized_pnl": round(pos_pnl, 4), "seconds_since_entry": round(now - pos.entry_ts, 1),
            "trail_sl": pos.trail_sl, "trail_armed": pos.trail_sl is not None,
            "last_trail_level": pos.last_trail_level or None,
        }

    def snapshot(self) -> dict:
        up_payload = self._position_payload(self.s.up_position, Side.UP)
        down_payload = self._position_payload(self.s.down_position, Side.DOWN)
        open_positions = [p for p in (up_payload, down_payload) if p is not None]

        unrealized_pnl = sum(p["unrealized_pnl"] for p in open_positions)
        open_market_value = sum(p["shares"] * p["mark_price"] for p in open_positions)
        realized_pnl = round(self.s.total_pnl, 4)

        trail_filter_open = self._trail_filter_open(time.time())
        seconds_until_trail_active = None
        if self.s.window is not None and not trail_filter_open:
            seconds_until_trail_active = round(
                config.TRAIL_MIN_SECONDS - (time.time() - self.s.window.open_ts), 1)

        if self.capital.halted:
            status = "halted"
        elif open_positions:
            status = "open"
        elif self.s.entries_done:
            status = "closed"
        else:
            status = "entering"

        return {
            "engine": "TRAIL", "label": "Dual-entry trailing stop",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
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

            "trail_filter_open": trail_filter_open,
            "seconds_until_trail_active": seconds_until_trail_active,

            "fills_this_window": self.s.fills_this_window,
            "total_entries": self.s.total_entries,
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
                "trail_min_seconds": config.TRAIL_MIN_SECONDS,
                "tp_price": config.TP_PRICE,
            },
        }
