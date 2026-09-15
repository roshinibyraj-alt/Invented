"""
Trading engine -- momentum-continuation entry (follows the previous
window's winning side, not the cheap side), continuous trailing stop
that arms 3 minutes after window open and tightens above 0.85, a hard
stop-loss override once deep ITM, single trade per window, TP
redemption.

See app/config.py for the full strategy write-up. Summary: 10s after
window open, lock in whichever side won the PREVIOUS window (by last
observed price) -- regardless of whether that side is currently cheap
or expensive. If it's already at/below the 0.50 dip threshold, the
0.20-0.80 entry zone is checked immediately and the trade fires (or is
skipped) right there; if it's above 0.50, the bot keeps watching that
side every tick, no deadline, until it dips to/below 0.50, at which
point the zone check happens and the trade fires or is skipped. If
there's no prior window result yet (e.g. the very first window after
startup, or the previous window's winner couldn't be inferred), the
window is skipped entirely rather than guessing -- no side is even
locked in. From
then on, TP is live immediately, but the trailing stop doesn't arm
until TRAIL_START_DELAY_SECONDS (180s / 3min) after the WINDOW OPENED
(not after entry) -- before that, only TP can close the position. The
high-water mark keeps tracking the whole time regardless, so once the
stop arms it starts from wherever price has already gotten to, not
from scratch. Once armed, the stop sits behind the position's
high-water MID -- 0.20 back normally, narrowing to 0.10 back once the
high-water mark has gone above 0.85 -- and only ever tightens.
Independent of that arming delay, the moment the high-water mark
reaches HARD_STOP_TRIGGER_PRICE (0.90), the trailing stop is
permanently deactivated for that position and replaced with a fixed
HARD_STOP_PRICE (0.60) stop-loss -- much wider than the tightened
trail would be, deliberately giving a deep-ITM position room to wobble
without getting stopped out; this never reverts even if price falls
back under 0.90. Mid price is what triggers every decision (entry zone
check, TP, stop), but every actual fill is a real taker execution
priced off real ask/bid order-book depth (see
Engine._realistic_fill_price), so mid and fill price can differ by the
spread. If mid reaches 0.99, redeem at a flat $1.00/share, fee-free,
done for the window. If the trailing stop or hard stop is hit instead,
the position is closed and the window is done -- no flip, no re-entry
on the other side, at most one trade per window. No martingale
anywhere; every entry is BASE_ORDER_SHARES. Every fill except TP is a
taker order and pays the taker fee; TP is the sole fee-free exception
since it's a CTF resolution redemption, not an orderbook trade.
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
    high_water_mark: float = 0.0   # best bid seen since entry -- drives the continuous trailing stop
    hard_stop_active: bool = False # once high-water mark >= HARD_STOP_TRIGGER_PRICE, trailing is permanently
                                    # replaced by the fixed HARD_STOP_PRICE stop -- never reverts

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
    entry_checked: bool = False     # the t=10s side-lock-in has happened (side chosen, or window skipped)
    momentum_side: Optional[Side] = None   # side locked in at the t=10s check; None if the window was
                                            # skipped outright (no prior winner) rather than just still waiting
    awaiting_dip: bool = False      # side is locked in and was above the dip threshold -- watching every
                                     # tick for it to fall to/below ENTRY_DIP_THRESHOLD before firing
    done_for_window: bool = False   # TP or stop hit, or window closed with nothing open -- nothing left to watch

    total_entries_attempted: int = 0   # t=10s checks where a side was in-zone and a buy was attempted
    total_no_entry_zone: int = 0       # t=10s checks where the cheap side was outside the entry zone
    total_tp_hits: int = 0
    total_stop_hits: int = 0           # trailing-stop closes only
    total_hard_stop_hits: int = 0      # fixed hard-stop closes only (position ran to 0.90+ first)
    total_forced_closes: int = 0       # window closed before TP/stop was reached
    no_trade_windows: int = 0          # entry zone missed at t=10s, nothing ever opened
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    last_window_pnl: float = 0.0


class Engine:
    """Momentum-continuation entry (follows previous window's winning
    side, not the cheap side) / trailing stop that arms 3 minutes after
    window open, tightens above 0.85, and gets permanently overridden by
    a fixed hard stop above 0.90 / single trade per window, driven off
    its own capital pool. Kept as the class name `Engine` / constructed
    the same way (Engine(broker)) so app/state.py doesn't need
    structural changes."""

    name = "FLIP"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)
        # Persists across windows (unlike EngineState, which is replaced
        # wholesale in reset_for_window): which side the previous window
        # resolved to, used to pick this window's entry side. None until
        # a window has actually finalized with a known winner.
        self.last_winning_side: Optional[Side] = None

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def reset_for_window(self, window: WindowMarket):
        self.s = EngineState(window=window)

        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return

        momentum_note = (f"following {self.last_winning_side.value} (previous window closed "
                          f"{self.last_winning_side.value} by price)" if self.last_winning_side is not None
                          else "no prior window result yet -- this window will be skipped")
        self._log("WINDOW_OPEN", shares=config.BASE_ORDER_SHARES, note=(
            f"waiting {config.ENTRY_WAIT_SECONDS:.0f}s, then locking in the momentum side -- {momentum_note} -- "
            f"regardless of whether it's the cheap or expensive side. Fires right away if it's at/below "
            f"{config.ENTRY_DIP_THRESHOLD} and within [{config.ENTRY_ZONE_LOW}, {config.ENTRY_ZONE_HIGH}]; "
            f"if it's above {config.ENTRY_DIP_THRESHOLD}, waits (no deadline) for a dip to/below that level "
            f"before checking the zone and firing -- flat {config.BASE_ORDER_SHARES:.0f}sh, no martingale. "
            f"TP {config.TP_PRICE} (redeem $1) live immediately / trailing stop arms "
            f"{config.TRAIL_START_DELAY_SECONDS:.0f}s after window open, {config.TRAIL_DISTANCE} trail "
            f"(tightens to {config.TRAIL_DISTANCE_TIGHT} above {config.TRAIL_TIGHTEN_PRICE}, permanently "
            f"replaced by a fixed {config.HARD_STOP_PRICE} hard stop above {config.HARD_STOP_TRIGGER_PRICE}), "
            f"one trade per window -- no flip on stop-out."
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
            self._check_entry(now)
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

    # ---- entry: t=10s side lock-in, then fire immediately or wait for a --
    # ---- dip to ENTRY_DIP_THRESHOLD before the zone-gated buy ------------

    def _check_entry(self, now: float):
        if not self.s.entry_checked:
            elapsed = now - self.s.window.open_ts
            if elapsed < config.ENTRY_WAIT_SECONDS:
                return   # not yet -- keep waiting, don't lock in a side

            self.s.entry_checked = True
            side = self.last_winning_side
            if side is None:
                self.s.no_trade_windows += 1
                self.s.done_for_window = True
                self._log("NO_TRADE", note="no prior window result to follow yet -- skipping window")
                return

            self.s.momentum_side = side
            self._log("ENTRY_SIDE_LOCKED", side=side.value, note=(
                f"momentum side locked in: {side.value} (previous window closed {side.value} by price) "
                f"at the {config.ENTRY_WAIT_SECONDS:.0f}s check"
            ))

        side = self.s.momentum_side
        if side is None:
            return   # already skipped this window above (done_for_window is True)

        price = self._mid_for(side)
        if price is None:
            return   # no price data this tick -- keep waiting, try again next tick

        if price > config.ENTRY_DIP_THRESHOLD:
            if not self.s.awaiting_dip:
                self.s.awaiting_dip = True
                self._log("AWAITING_DIP", side=side.value, price=round(price, 4), note=(
                    f"{side.value} mid @ {price:.4f} is above the {config.ENTRY_DIP_THRESHOLD} dip threshold -- "
                    f"waiting for it to fall to/below {config.ENTRY_DIP_THRESHOLD} before firing"
                ))
            return   # keep watching every tick, no deadline other than window close

        if not (config.ENTRY_ZONE_LOW <= price <= config.ENTRY_ZONE_HIGH):
            self.s.total_no_entry_zone += 1
            self.s.no_trade_windows += 1
            self.s.done_for_window = True
            self._log("NO_TRADE", side=side.value, price=round(price, 4), note=(
                f"momentum side {side.value} dipped to {price:.4f} but that's outside the entry zone "
                f"[{config.ENTRY_ZONE_LOW}, {config.ENTRY_ZONE_HIGH}] -- no trade this window"
            ))
            return

        self.s.total_entries_attempted += 1
        dip_note = " after waiting for the dip" if self.s.awaiting_dip else ""
        self._open_position(side, now, zone_note=(
            f"momentum continuation of {side.value} (previous window closed {side.value} by price), "
            f"in-zone @ mid {price:.4f}{dip_note}, bought regardless of cheap/expensive"
        ))

    # ---- position open (single entry per window) ---------------------------

    def _open_position(self, side: Side, now: float, zone_note: str):
        shares = config.BASE_ORDER_SHARES
        ask = self._ask_for(side)
        levels = self._ask_levels_for(side)
        fill_price = self._realistic_fill_price(levels, shares, ask)

        if fill_price is None:
            self._log("NO_LIQUIDITY", side=side.value,
                       note=f"no ask liquidity on {side.value} -- entry skipped")
            self.s.done_for_window = True
            self.s.no_trade_windows += 1
            return

        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        mid_now = self._mid_for(side)
        hwm_start = mid_now if mid_now is not None else fill_price
        self.s.position = Position(side=side, shares=shares, entry_price=fill_price, entry_fee=fee,
                                    entry_ts=now, high_water_mark=hwm_start)
        self._log("ENTRY_FILL", side=side.value, price=round(fill_price, 4), shares=shares, fee=round(fee, 4),
                   note=(f"entry buy filled (taker, real ask depth): {shares:.0f}sh @ {fill_price:.4f} "
                         f"({zone_note}, fee ${fee:.4f}) -- TP {config.TP_PRICE} (redeem $1) / "
                         f"trailing stop arms {config.TRAIL_START_DELAY_SECONDS:.0f}s after window open"))
        self.capital.check_halt()

    # ---- exit: TP redemption or continuous trailing-stop hit ---------------

    @staticmethod
    def _effective_stop(high_water_mark: float) -> float:
        """Continuous trail: TRAIL_DISTANCE behind the high-water mark,
        narrowing to TRAIL_DISTANCE_TIGHT once the high-water mark has
        gone above TRAIL_TIGHTEN_PRICE, rounded to the price tick.
        Monotonically non-decreasing since the caller always feeds in
        the cumulative HWM, never the raw current price -- so it only
        ever tightens (both from the HWM rising and from crossing the
        tighten threshold)."""
        trail = config.TRAIL_DISTANCE_TIGHT if high_water_mark > config.TRAIL_TIGHTEN_PRICE else config.TRAIL_DISTANCE
        stop = high_water_mark - trail
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
                                  fill_price_override=1.0, fee_override=0.0)
            return

        # Hard stop: the instant the position has run deep enough ITM,
        # permanently swap the trailing stop for a fixed, much wider
        # stop-loss -- independent of the trail-arm delay below, and it
        # never reverts even if price pulls back under the trigger
        # afterwards.
        if not pos.hard_stop_active and pos.high_water_mark >= config.HARD_STOP_TRIGGER_PRICE:
            pos.hard_stop_active = True
            self._log("HARD_STOP_ARMED", price=round(pos.high_water_mark, 4), note=(
                f"high-water mid reached {config.HARD_STOP_TRIGGER_PRICE} -- trailing stop deactivated, "
                f"hard stop-loss now fixed at {config.HARD_STOP_PRICE} for the rest of this position"
            ))

        if pos.hard_stop_active:
            if mid <= config.HARD_STOP_PRICE:
                self.s.total_hard_stop_hits += 1
                self._close_position(now, reason="HARD_STOP_HIT", note_prefix=(
                    f"hard stop-loss hit at {config.HARD_STOP_PRICE:.4f} (fixed -- trailing stop was "
                    f"deactivated once high-water mid passed {config.HARD_STOP_TRIGGER_PRICE})"
                ))
            return   # hard-stop mode: trailing logic below no longer applies to this position

        if now - self.s.window.open_ts < config.TRAIL_START_DELAY_SECONDS:
            return   # stop isn't armed yet -- only TP can close in this window

        stop = self._effective_stop(pos.high_water_mark)
        if mid <= stop:
            self.s.total_stop_hits += 1
            trail = (config.TRAIL_DISTANCE_TIGHT if pos.high_water_mark > config.TRAIL_TIGHTEN_PRICE
                     else config.TRAIL_DISTANCE)
            self._close_position(now, reason="STOP_HIT",
                                  note_prefix=(f"continuous trailing stop hit at mid {stop:.4f} "
                                               f"(high-water mid {pos.high_water_mark:.4f}, {trail} trail)"))

    def _close_position(self, now: float, reason: str, note_prefix: str,
                         fill_price_override: Optional[float] = None, fee_override: Optional[float] = None):
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

        # TP, stop, or a forced window-end close -- every close is terminal
        # now: one trade per window, no flip/re-entry on stop-out.
        self.s.done_for_window = True

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted:
            if self.s.position is not None:
                self.s.total_forced_closes += 1
                self._close_position(time.time(), reason="FORCED_CLOSE",
                                      note_prefix="window closed before TP/stop, forced taker close")
            elif not self.s.entry_checked:
                self.s.no_trade_windows += 1
                self._log("NO_TRADE", note="window closed before the 10s entry check ever ran")
            elif not self.s.done_for_window:
                # side was locked in and (usually) was waiting for a dip to
                # ENTRY_DIP_THRESHOLD that never came before the window ended
                self.s.no_trade_windows += 1
                note = (f"window closed while still waiting for {self.s.momentum_side.value} to dip to/below "
                         f"{config.ENTRY_DIP_THRESHOLD} -- no trade this window" if self.s.awaiting_dip
                         else "window closed before a trade fired -- no trade this window")
                self._log("NO_TRADE", note=note)

        # Feeds next window's entry-side filter -- whichever side this
        # window closed to (by last observed price) is what next
        # window's momentum-continuation entry will follow. A None here
        # (winner couldn't be inferred) clears the signal rather than
        # leaving a stale one, so next window's entry is skipped too.
        self.last_winning_side = winning_side

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
        hard_stop_active = pos.hard_stop_active or hwm >= config.HARD_STOP_TRIGGER_PRICE
        market_value = pos.shares * mark
        unrealized = market_value - pos.cost
        to_tp = round(config.TP_PRICE - mark, 4)

        window_open_ts = self.s.window.open_ts if self.s.window is not None else pos.entry_ts
        elapsed_since_open = time.time() - window_open_ts
        stop_armed = elapsed_since_open >= config.TRAIL_START_DELAY_SECONDS
        stop_arms_in = round(max(0.0, config.TRAIL_START_DELAY_SECONDS - elapsed_since_open), 1)

        if hard_stop_active:
            stop = config.HARD_STOP_PRICE
        else:
            stop = self._effective_stop(hwm)
        to_stop = round(mark - stop, 4)

        return {
            "side": pos.side.value,
            "shares": pos.shares,
            "entry_price": round(pos.entry_price, 4),
            "entry_fee": round(pos.entry_fee, 4),
            "entry_ts": pos.entry_ts,
            "mark_price": mark,
            "high_water_mark": round(hwm, 4),
            "market_value": round(market_value, 4),
            "unrealized_pnl": round(unrealized, 4),
            "tp_price": config.TP_PRICE,
            "stop_price": round(stop, 4),
            "stop_armed": stop_armed,
            "stop_arms_in": stop_arms_in,
            "hard_stop_active": hard_stop_active,
            "hard_stop_trigger_price": config.HARD_STOP_TRIGGER_PRICE,
            "hard_stop_price": config.HARD_STOP_PRICE,
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
        elif self.s.awaiting_dip and not self.s.done_for_window:
            status = "waiting_dip"
        else:
            status = "done"

        up_mid = self._mid_for(Side.UP)
        down_mid = self._mid_for(Side.DOWN)

        return {
            "engine": "FLIP", "label": "Momentum-continuation entry (follows prior window's winner), continuous trail (tightens above 0.85), single trade",

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
            "last_winning_side": self.last_winning_side.value if self.last_winning_side else None,
            "entry_checked": self.s.entry_checked,
            "momentum_side": self.s.momentum_side.value if self.s.momentum_side else None,
            "awaiting_dip": self.s.awaiting_dip,
            "position": position,
            "done_for_window": self.s.done_for_window,

            "base_order_shares": config.BASE_ORDER_SHARES,

            "total_entries_attempted": self.s.total_entries_attempted,
            "total_no_entry_zone": self.s.total_no_entry_zone,
            "total_tp_hits": self.s.total_tp_hits,
            "total_stop_hits": self.s.total_stop_hits,
            "total_hard_stop_hits": self.s.total_hard_stop_hits,
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
                "entry_dip_threshold": config.ENTRY_DIP_THRESHOLD,
                "tp_price": config.TP_PRICE,
                "trail_distance": config.TRAIL_DISTANCE,
                "trail_distance_tight": config.TRAIL_DISTANCE_TIGHT,
                "trail_tighten_price": config.TRAIL_TIGHTEN_PRICE,
                "trail_start_delay_seconds": config.TRAIL_START_DELAY_SECONDS,
                "hard_stop_trigger_price": config.HARD_STOP_TRIGGER_PRICE,
                "hard_stop_price": config.HARD_STOP_PRICE,
                "base_order_shares": config.BASE_ORDER_SHARES,
            },
        }
