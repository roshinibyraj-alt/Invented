"""
Engine B (v5) -- momentum-confirmed signal strategy. The only engine running.

Rationale
---------
Buying on a fixed clock regardless of price action has no edge in an
efficient market: it's a coin flip minus the fee. This version only
takes a position when there is an actual signal (recent momentum) AND
the price sits in a sane confirmation band, sizes by how strong that
signal is, and hard-caps total exposure per window so a bad read can't
compound. It is a hypothesis, not a proven edge -- validate in paper
mode across many real windows before trusting it with real capital.

Flow
----
Regular scan -- every MOM_CHECK_INTERVAL_SECONDS from MOM_ENTRY_START to
MOM_ENTRY_END:
    For each side, compare its current price to its price
    MOM_LOOKBACK_SECONDS ago. A side qualifies if it rose by at least
    MOM_MIN_DELTA over that lookback AND its current price is inside
    [MOM_CONFIRM_MIN_PRICE, MOM_CONFIRM_MAX_PRICE]. If both sides
    qualify, take the stronger momentum. If neither qualifies, skip --
    no forced trade. Size scales with signal strength between
    MOM_BASE_SHARES and MOM_MAX_SHARES.

Late snipe -- a single check at MOM_LATE_SNIPE_AT:
    Take whichever side has accumulated more shares so far this window
    (the "dominant" side). If its price is inside
    [MOM_LATE_SNIPE_MIN_PRICE, MOM_LATE_SNIPE_MAX_PRICE], add
    MOM_LATE_SNIPE_SHARES more.

Every fill from both is an independent leg, held to resolution. No
exit logic. Total shares bought (either side, all legs) never exceeds
MOM_MAX_TOTAL_SHARES_PER_WINDOW.
"""
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple

from . import config
from .models import Position, Side, WindowMarket
from .paper_broker import PaperBroker


@dataclass
class Leg:
    position: Position
    tag: str           # "momentum" or "late_snipe"
    tick_seconds: int   # scheduled elapsed-time this leg fired at


class EngineB:
    name = "B"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.window: Optional[WindowMarket] = None
        self.legs: List[Leg] = []
        self._history: List[Tuple[float, float, float]] = []  # (elapsed, up, down)
        self._checks: List[dict] = []
        self._total_shares: float = 0.0

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        self.legs = []
        self._history = []
        self._total_shares = 0.0

        schedule = [(t, "scan") for t in range(
            config.MOM_ENTRY_START, config.MOM_ENTRY_END + 1, config.MOM_CHECK_INTERVAL_SECONDS
        )]
        schedule.append((config.MOM_LATE_SNIPE_AT, "snipe"))
        self._checks = [
            {"tick": t, "kind": kind, "status": "pending",
             "side": None, "price": None, "shares": None, "delta": None, "note": None}
            for t, kind in schedule
        ]

        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=(f"Momentum scan every {config.MOM_CHECK_INTERVAL_SECONDS}s "
                  f"{config.MOM_ENTRY_START}s-{config.MOM_ENTRY_END}s "
                  f"(lookback {config.MOM_LOOKBACK_SECONDS}s, min delta {config.MOM_MIN_DELTA}, "
                  f"band {config.MOM_CONFIRM_MIN_PRICE}-{config.MOM_CONFIRM_MAX_PRICE}, "
                  f"size {config.MOM_BASE_SHARES}-{config.MOM_MAX_SHARES}); "
                  f"late snipe @ {config.MOM_LATE_SNIPE_AT}s; "
                  f"exposure cap {config.MOM_MAX_TOTAL_SHARES_PER_WINDOW} shares"),
        )

    def _price_lookback(self, target_elapsed: float) -> Optional[Tuple[float, float, float]]:
        """Latest history sample at or before target_elapsed, or None if
        we don't have history reaching back that far."""
        candidate = None
        for e, up, down in self._history:
            if e <= target_elapsed:
                candidate = (e, up, down)
            else:
                break
        return candidate

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.window is None:
            return
        now = now or time.time()
        elapsed = now - self.window.open_ts
        if up_price is None or down_price is None:
            return

        self._history.append((elapsed, up_price, down_price))

        for check in self._checks:
            if check["status"] != "pending" or elapsed < check["tick"]:
                continue
            if check["kind"] == "scan":
                self._run_scan_check(check, elapsed, up_price, down_price)
            else:
                self._run_snipe_check(check, elapsed, up_price, down_price)

    def _remaining_budget(self) -> float:
        return max(0.0, config.MOM_MAX_TOTAL_SHARES_PER_WINDOW - self._total_shares)

    def _run_scan_check(self, check: dict, elapsed: float, up_price: float, down_price: float):
        past = self._price_lookback(elapsed - config.MOM_LOOKBACK_SECONDS)
        if past is None:
            check["status"] = "skipped"
            check["note"] = "not enough history for lookback yet"
            return

        _, past_up, past_down = past
        delta_up = up_price - past_up
        delta_down = down_price - past_down

        candidates = []
        if (delta_up >= config.MOM_MIN_DELTA
                and config.MOM_CONFIRM_MIN_PRICE <= up_price <= config.MOM_CONFIRM_MAX_PRICE):
            candidates.append((Side.UP, delta_up, up_price))
        if (delta_down >= config.MOM_MIN_DELTA
                and config.MOM_CONFIRM_MIN_PRICE <= down_price <= config.MOM_CONFIRM_MAX_PRICE):
            candidates.append((Side.DOWN, delta_down, down_price))

        if not candidates:
            check["status"] = "skipped"
            check["note"] = f"no signal (Δup={delta_up:+.3f} Δdown={delta_down:+.3f})"
            return

        candidates.sort(key=lambda c: c[1], reverse=True)
        side, delta, price = candidates[0]

        remaining = self._remaining_budget()
        if remaining <= 0:
            check["status"] = "skipped"
            check["note"] = "exposure cap reached"
            return

        strength = min(delta / config.MOM_NORMALIZE_DELTA, 1.0)
        raw_shares = config.MOM_BASE_SHARES + strength * (config.MOM_MAX_SHARES - config.MOM_BASE_SHARES)
        shares = min(round(raw_shares), remaining)
        if shares <= 0:
            check["status"] = "skipped"
            check["note"] = "exposure cap reached"
            return

        self._fill(check, side, shares, price, tag="momentum",
                    note=f"momentum Δ={delta:+.3f}, strength={strength:.2f}")

    def _run_snipe_check(self, check: dict, elapsed: float, up_price: float, down_price: float):
        up_shares = sum(l.position.shares for l in self.legs if l.position.side == Side.UP)
        down_shares = sum(l.position.shares for l in self.legs if l.position.side == Side.DOWN)
        if up_shares == 0 and down_shares == 0:
            dominant = Side.UP if up_price >= down_price else Side.DOWN
        else:
            dominant = Side.UP if up_shares >= down_shares else Side.DOWN
        price = up_price if dominant == Side.UP else down_price

        if not (config.MOM_LATE_SNIPE_MIN_PRICE <= price <= config.MOM_LATE_SNIPE_MAX_PRICE):
            check["status"] = "skipped"
            check["note"] = f"dominant side {dominant.value} @ {price:.2f} outside snipe band"
            return

        remaining = self._remaining_budget()
        if remaining <= 0:
            check["status"] = "skipped"
            check["note"] = "exposure cap reached"
            return

        shares = min(config.MOM_LATE_SNIPE_SHARES, remaining)
        self._fill(check, dominant, shares, price, tag="late_snipe",
                    note=f"dominant side add ({up_shares:.0f}UP/{down_shares:.0f}DOWN so far)")

    def _fill(self, check: dict, side: Side, shares: float, price: float, tag: str, note: str):
        position = self.broker.buy(
            self.name, self.window.slug, side, shares, price,
            note=f"{tag} leg entry @ t={check['tick']}s ({note})",
        )
        self._total_shares += shares
        self.broker.log_event(
            self.name, self.window.slug, "LEG_OPENED",
            side=side.value, price=price,
            note=f"{tag} (t={check['tick']}s): {shares} shares -- {note}",
        )
        leg = Leg(position=position, tag=tag, tick_seconds=check["tick"])
        self.legs.append(leg)
        check["status"] = "bought"
        check["side"] = side.value
        check["price"] = price
        check["shares"] = shares
        check["note"] = note

    def finalize_window(self, winning_side: Optional[Side]):
        if winning_side is not None:
            for leg in self.legs:
                won = leg.position.side == winning_side
                self.broker.resolve_expiry(self.name, self.window.slug, leg.position,
                                            won, note=f"{leg.tag} leg (t={leg.tick_seconds}s) held to expiry")
        self.legs = []

    def snapshot(self) -> dict:
        positions = {Side.UP: [], Side.DOWN: []}
        for leg in self.legs:
            positions[leg.position.side].append(leg.position)

        def _agg(side: Side) -> dict:
            legs_for_side = positions[side]
            total_shares = sum(p.shares for p in legs_for_side)
            avg_price = (sum(p.shares * p.entry_price for p in legs_for_side) / total_shares
                         if total_shares else None)
            total_fees = sum(p.fee for p in legs_for_side)
            total_cost = sum(p.cost for p in legs_for_side)
            return {
                "shares": total_shares,
                "avg_entry_price": avg_price,
                "total_fees": total_fees,
                "total_cost": total_cost,
                "num_legs": len(legs_for_side),
            }

        checks_done = sum(1 for c in self._checks if c["status"] != "pending")
        if checks_done < len(self._checks):
            phase = "scanning"
        else:
            phase = "done"

        return {
            "phase": phase,
            "window": self.window.slug if self.window else None,
            "checks_done": checks_done,
            "checks_total": len(self._checks),
            "exposure_used": self._total_shares,
            "exposure_cap": config.MOM_MAX_TOTAL_SHARES_PER_WINDOW,
            "up_position": _agg(Side.UP),
            "down_position": _agg(Side.DOWN),
            "checks": self._checks,
            "legs": [
                {
                    "tag": leg.tag,
                    "tick_seconds": leg.tick_seconds,
                    "side": leg.position.side.value,
                    "shares": leg.position.shares,
                    "entry_price": leg.position.entry_price,
                }
                for leg in self.legs
            ],
        }
