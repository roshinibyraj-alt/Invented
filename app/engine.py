"""
Trading engine -- delayed expensive-side entry, continuous 0.15 trailing
stop, one flat-size flip, TP redemption.

See app/config.py for the full strategy write-up. Summary: 90s after
window open, buy whichever side is more expensive (by MID price) if
(and only if) that mid is inside the 0.35-0.80 entry zone. From then on, a
continuous trailing stop sits 0.15 behind the position's high-water
MID and only ever tightens -- mid price is what triggers every
decision (entry zone check, TP, stop), but every actual fill is a real
taker execution priced off real ask/bid order-book depth (see
Engine._realistic_fill_price), so mid and fill price can differ by the
spread. If mid reaches 0.99, redeem at a flat $1.00/share, fee-free,
done for the window. If the trailing stop is hit instead, immediately
flip into the opposite side at the same flat size (no zone check on
flips, real taker buy against ask depth), and the same trailing-stop
logic applies to the new position. Flips are capped at
MAX_FLIPS_PER_WINDOW (1) -- after that one flip, any further stop-out
just ends the window flat. No new entry or flip fires once
NO_TRADE_AFTER_SECONDS has elapsed in the window. No martingale anywhere; every entry is BASE_ORDER_SHARES.
Every fill except TP is a taker order and pays the taker fee; TP is
the sole fee-free exception since it's a CTF resolution redemption,
not an orderbook trade.
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
# The single open position for a window, if any.
# ---------------------------------------------------------------------------

@dataclass
class Position:
    side: Side
    shares: float
    entry_price: float
    entry_fee: float
    entry_ts: float
    flip_number: int            # 0 = initial entry, 1 = first flip, 2 = second flip, ...
    high_water_mark: float = 0.0   # best bid seen since entry -- drives the continuous trailing stop

    @property
    def cost(self) -> float:
        return self.shares * self.entry_price + self.entry_fee


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
    entry_checked: bool = False     # the one t=ENTRY_WAIT_SECONDS entry check has happened (fired or skipped)
    done_for_window: bool = False   # TP hit, or window closed with nothing open -- nothing left to watch
    flip_count: int = 0             # flips taken so far this window

    total_entries_attempted: int = 0   # t=ENTRY_WAIT_SECONDS checks where a side was in-zone and a buy was attempted
    total_no_entry_zone: int = 0       # t=ENTRY_WAIT_SECONDS checks where the expensive side was outside the entry zone
    total_flips: int = 0
    total_tp_hits: int = 0
    total_stop_hits: int = 0
    total_forced_closes: int = 0       # window closed before TP/stop was reached
    no_trade_windows: int = 0          # entry zone missed at t=ENTRY_WAIT_SECONDS, nothing ever opened
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    last_window_pnl: float = 0.0


class Engine:
    """Delayed expensive-side entry / continuous 0.15 trailing stop / one
    flat-size flip, driven off its own capital pool. Kept as the class
    name `Engine` / constructed the same way (Engine(broker)) so
    app/state.py doesn't need structural changes."""

    name = "FLIP"

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

        self._log("WINDOW_OPEN", shares=config.BASE_ORDER_SHARES, note=(
            f"waiting {config.ENTRY_WAIT_SECONDS:.0f}s, then buying the cheaper side if it's within "
            f"[{config.ENTRY_ZONE_LOW}, {config.ENTRY_ZONE_HIGH}] -- flat {config.BASE_ORDER_SHARES:.0f}sh, "
            f"no martingale. TP {config.TP_PRICE} (redeem $1) / continuous {config.TRAIL_DISTANCE} trailing "
            f"stop, up to {config.MAX_FLIPS_PER_WINDOW} flip(s) on stop-out."
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

        if self.s.position is None:
            if not self.s.entry_checked:
                self._check_initial_entry(now)
        else:
            self._check_exit(now)

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

    # ---- initial entry: single check at t=ENTRY_WAIT_SECONDS, expensive side, zone-gated ------

    def _check_initial_entry(self, now: float):
        elapsed = now - self.s.window.open_ts
        if elapsed < config.ENTRY_WAIT_SECONDS:
            return   # not yet -- keep waiting, don't mark checked

        self.s.entry_checked = True

        if elapsed > config.NO_TRADE_AFTER_SECONDS:
            self.s.no_trade_windows += 1
            self.s.done_for_window = True
            self._log("NO_TRADE", note=(
                f"entry check didn't run until {elapsed:.1f}s in, past the "
                f"{config.NO_TRADE_AFTER_SECONDS:.0f}s no-new-trades cutoff -- skipping window"
            ))
            return

        up_mid, down_mid = self._mid_for(Side.UP), self._mid_for(Side.DOWN)
        if up_mid is None or down_mid is None:
            # no price data at the check moment -- skip the window rather
            # than guess
            self.s.no_trade_windows += 1
            self.s.done_for_window = True
            self._log("NO_TRADE", note=f"no price data at the {config.ENTRY_WAIT_SECONDS:.0f}s entry check -- skipping window")
            return

        side = Side.UP if up_mid >= down_mid else Side.DOWN
        price = up_mid if side == Side.UP else down_mid

        if not (config.ENTRY_ZONE_LOW <= price <= config.ENTRY_ZONE_HIGH):
            self.s.total_no_entry_zone += 1
            self.s.no_trade_windows += 1
            self.s.done_for_window = True
            self._log("NO_TRADE", side=side.value, price=round(price, 4), note=(
                f"expensive side ({side.value}) mid @ {price:.4f} is outside the entry zone "
                f"[{config.ENTRY_ZONE_LOW}, {config.ENTRY_ZONE_HIGH}] at the {config.ENTRY_WAIT_SECONDS:.0f}s "
                f"check -- no trade this window"
            ))
            return

        self.s.total_entries_attempted += 1
        self._open_position(side, now, flip_number=0, zone_note=f"expensive side, in-zone @ mid {price:.4f}")

    # ---- position open (initial or flip) -----------------------------------

    def _open_position(self, side: Side, now: float, flip_number: int, zone_note: str):
        elapsed = now - self.s.window.open_ts
        if elapsed > config.NO_TRADE_AFTER_SECONDS:
            self.s.done_for_window = True
            self._log("NO_TRADE", side=side.value, note=(
                f"{'entry' if flip_number == 0 else f'flip #{flip_number}'} would open at {elapsed:.1f}s, "
                f"past the {config.NO_TRADE_AFTER_SECONDS:.0f}s no-new-trades cutoff -- skipped"
            ))
            if flip_number == 0:
                self.s.no_trade_windows += 1
            return

        shares = config.BASE_ORDER_SHARES
        ask = self._ask_for(side)
        levels = self._ask_levels_for(side)
        fill_price = self._realistic_fill_price(levels, shares, ask)

        if fill_price is None:
            self._log("NO_LIQUIDITY", side=side.value,
                       note=f"no ask liquidity on {side.value} -- {'entry' if flip_number == 0 else 'flip'} skipped")
            self.s.done_for_window = True
            if flip_number == 0:
                self.s.no_trade_windows += 1
            return

        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        mid_now = self._mid_for(side)
        hwm_start = mid_now if mid_now is not None else fill_price
        self.s.position = Position(side=side, shares=shares, entry_price=fill_price, entry_fee=fee,
                                    entry_ts=now, flip_number=flip_number, high_water_mark=hwm_start)
        event = "ENTRY_FILL" if flip_number == 0 else "FLIP_FILL"
        self._log(event, side=side.value, price=round(fill_price, 4), shares=shares, fee=round(fee, 4),
                   note=(f"{'entry' if flip_number == 0 else f'flip #{flip_number}'} buy filled (taker, real ask "
                         f"depth): {shares:.0f}sh @ {fill_price:.4f} ({zone_note}, fee ${fee:.4f}) -- "
                         f"TP {config.TP_PRICE} (redeem $1) / stop starts {config.TRAIL_DISTANCE} below entry mid"))
        self.capital.check_halt()

    # ---- exit: TP redemption or continuous trailing-stop hit -> flip -------

    @staticmethod
    def _effective_stop(high_water_mark: float) -> float:
        """Continuous trail: always exactly TRAIL_DISTANCE behind the
        high-water mark, rounded to the price tick. Monotonically
        non-decreasing since the caller always feeds in the cumulative
        HWM, never the raw current price -- so it only ever tightens."""
        stop = high_water_mark - config.TRAIL_DISTANCE
        return round(stop / config.PRICE_TICK) * config.PRICE_TICK

    def _check_exit(self, now: float):
        pos = self.s.position
        mid = self._mid_for(pos.side)
        if mid is None:
            return
        if mid > pos.high_water_mark:
            pos.high_water_mark = mid

        if mid >= config.TP_PRICE:
            self.s.total_tp_hits += 1
            self._close_position(now, reason="TP_HIT",
                                  note_prefix=f"take-profit hit ({config.TP_PRICE} mid)",
                                  fill_price_override=1.0, fee_override=0.0, is_terminal=True)
            return

        stop = self._effective_stop(pos.high_water_mark)
        if mid <= stop:
            self.s.total_stop_hits += 1
            self._close_position(now, reason="STOP_HIT",
                                  note_prefix=(f"continuous trailing stop hit at mid {stop:.4f} "
                                               f"(high-water mid {pos.high_water_mark:.4f}, "
                                               f"{config.TRAIL_DISTANCE} trail)"),
                                  is_terminal=False)

    def _close_position(self, now: float, reason: str, note_prefix: str,
                         fill_price_override: Optional[float] = None, fee_override: Optional[float] = None,
                         is_terminal: bool = False):
        pos = self.s.position
        if fill_price_override is not None:
            # TP: booked as a CTF resolution redemption, not an orderbook
            # trade -- flat $1.00/share, no fee, no book-depth lookup.
            fill_price = fill_price_override
            fee = fee_override if fee_override is not None else 0.0
        else:
            # Real taker sell against actual bid depth -- mid only decides
            # WHEN to exit, never what price it fills at.
            bid = self._bid_for(pos.side)
            levels = self._bid_levels_for(pos.side)
            fill_price = self._realistic_fill_price(levels, pos.shares, bid)
            if fill_price is None:
                # confirmed empty book -- nobody bidding at all right now
                fill_price = 0.0
                self._log("NO_LIQUIDITY", side=pos.side.value, price=bid,
                           note=f"{reason} but book has zero bid depth on {pos.side.value} -- assuming worst case $0")
            fee = self.broker.taker_fee_amount(pos.shares, fill_price)

        proceeds = pos.shares * fill_price - fee
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        win = pnl >= 0
        if win:
            self.s.wins += 1
        else:
            self.s.losses += 1

        self._log(reason, side=pos.side.value, price=round(fill_price, 4), shares=pos.shares,
                   fee=round(fee, 4), pnl=round(pnl, 4),
                   note=(f"{note_prefix} ({'redemption, fee-free' if fill_price_override is not None else 'taker'}, "
                         f"@ {fill_price:.4f}): {pos.shares:.0f}sh (entry {pos.entry_price:.4f}, "
                         f"fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()
        self.s.position = None

        if is_terminal or self.capital.halted:
            # TP, or a forced window-end close -- no flip.
            self.s.done_for_window = True
            return

        if self.s.flip_count >= config.MAX_FLIPS_PER_WINDOW:
            # Already used the window's one flip -- this stop-out just
            # ends the window flat, no further re-entry.
            self.s.done_for_window = True
            self._log("NO_TRADE", side=pos.side.value, note=(
                f"stop hit but the window's {config.MAX_FLIPS_PER_WINDOW} flip(s) already used -- "
                f"staying flat for the rest of this window"
            ))
            return

        # Stop hit, flip budget remaining -> flip, flat size, no zone check,
        # regardless of whether this position closed up or down overall.
        self.s.flip_count += 1
        self.s.total_flips += 1
        flip_side = pos.side.other()
        self._open_position(flip_side, now, flip_number=self.s.flip_count,
                             zone_note=f"flip #{self.s.flip_count}, no zone check")

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted:
            if self.s.position is not None:
                self.s.total_forced_closes += 1
                self._close_position(time.time(), reason="FORCED_CLOSE",
                                      note_prefix="window closed before TP/stop, forced taker close",
                                      is_terminal=True)
            elif not self.s.entry_checked:
                self.s.no_trade_windows += 1
                self._log("NO_TRADE", note="window closed before the entry check ever ran")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def _position_payload(self) -> Optional[dict]:
        pos = self.s.position
        if pos is None:
            return None
        mid = self._mid_for(pos.side)
        mark = mid if mid is not None else pos.entry_price
        hwm = max(pos.high_water_mark, mark)
        stop = self._effective_stop(hwm)
        market_value = pos.shares * mark
        unrealized = market_value - pos.cost
        to_tp = round(config.TP_PRICE - mark, 4)
        to_stop = round(mark - stop, 4)
        return {
            "side": pos.side.value,
            "shares": pos.shares,
            "entry_price": round(pos.entry_price, 4),
            "entry_fee": round(pos.entry_fee, 4),
            "entry_ts": pos.entry_ts,
            "flip_number": pos.flip_number,
            "mark_price": mark,
            "high_water_mark": round(hwm, 4),
            "market_value": round(market_value, 4),
            "unrealized_pnl": round(unrealized, 4),
            "tp_price": config.TP_PRICE,
            "stop_price": round(stop, 4),
            "trail_distance": config.TRAIL_DISTANCE,
            "distance_to_tp": to_tp,
            "distance_to_stop": to_stop,
        }

    def snapshot(self) -> dict:
        position = self._position_payload()
        market_value = position["market_value"] if position else 0.0
        unrealized = position["unrealized_pnl"] if position else 0.0
        realized_pnl = round(self.s.total_pnl, 4)

        if self.capital.halted:
            status = "halted"
        elif position is not None:
            status = "in_position"
        elif not self.s.entry_checked:
            status = "waiting_entry"
        else:
            status = "done"

        up_mid = self._mid_for(Side.UP)
        down_mid = self._mid_for(Side.DOWN)

        return {
            "engine": "FLIP", "label": "Delayed expensive-side entry, continuous 0.15 trail, one flip",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + market_value, 4),

            "realized_pnl": realized_pnl,
            "unrealized_pnl": round(unrealized, 4),
            "open_market_value": round(market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "up_mid": up_mid,
            "down_mid": down_mid,
            "entry_checked": self.s.entry_checked,
            "position": position,
            "done_for_window": self.s.done_for_window,
            "flip_count": self.s.flip_count,

            "base_order_shares": config.BASE_ORDER_SHARES,

            "total_entries_attempted": self.s.total_entries_attempted,
            "total_no_entry_zone": self.s.total_no_entry_zone,
            "total_flips": self.s.total_flips,
            "total_tp_hits": self.s.total_tp_hits,
            "total_stop_hits": self.s.total_stop_hits,
            "total_forced_closes": self.s.total_forced_closes,
            "no_trade_windows": self.s.no_trade_windows,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,

            "def": {
                "entry_wait_seconds": config.ENTRY_WAIT_SECONDS,
                "entry_zone_low": config.ENTRY_ZONE_LOW,
                "entry_zone_high": config.ENTRY_ZONE_HIGH,
                "tp_price": config.TP_PRICE,
                "trail_distance": config.TRAIL_DISTANCE,
                "base_order_shares": config.BASE_ORDER_SHARES,
                "max_flips_per_window": config.MAX_FLIPS_PER_WINDOW,
            },
        }
