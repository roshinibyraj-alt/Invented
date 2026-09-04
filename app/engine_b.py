"""
Engine B (v4) -- interval accumulation strategy. The only engine running.

Flow
----
Phase 1 (cheap-side scalping), t in [PHASE1_START, PHASE1_END], every
INTERVAL_SECONDS (default: 15s, 30s, ..., 120s):
    Look at both UP and DOWN prices. Whichever is cheaper is the
    candidate. If that price is below PHASE1_MAX_PRICE (0.40), buy
    PHASE1_SHARES (20) of it. Otherwise skip this tick -- no action.
    The side bought can flip from tick to tick depending on which side
    happens to be cheaper at that moment.

Dead zone: (PHASE1_END, PHASE2_START) -- no buying.

Phase 2 (expensive-side momentum), t in [PHASE2_START, PHASE2_END],
every INTERVAL_SECONDS (default: 135s, 150s, ..., 255s):
    Look at both UP and DOWN prices. Whichever is MORE expensive is
    the candidate. If that price is above PHASE2_MIN_PRICE (0.60), buy
    PHASE2_SHARES (40) of it. Otherwise skip this tick.

Every fill from both phases is an independent leg. There is no stop
loss, no take profit, and no exit logic of any kind -- all legs are
held until window close and settled against Polymarket's real outcome
($1/share if that leg's side won, $0/share if it lost).
"""
import time
from dataclasses import dataclass
from typing import List, Optional

from . import config
from .models import Position, Side, WindowMarket
from .paper_broker import PaperBroker


@dataclass
class Leg:
    position: Position
    tag: str          # "phase1" or "phase2"
    tick_seconds: int  # scheduled elapsed-time this leg fired at


class EngineB:
    name = "B"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.window: Optional[WindowMarket] = None
        self.legs: List[Leg] = []
        self._fired_ticks: set = set()  # elapsed-second marks already handled this window

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        self.legs = []
        self._fired_ticks = set()
        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=(f"Phase 1: {config.ENGINE_B_PHASE1_SHARES} shares of cheaper side "
                  f"every {config.ENGINE_B_INTERVAL_SECONDS}s from "
                  f"{config.ENGINE_B_PHASE1_START}s-{config.ENGINE_B_PHASE1_END}s if < "
                  f"{config.ENGINE_B_PHASE1_MAX_PRICE}. Phase 2: "
                  f"{config.ENGINE_B_PHASE2_SHARES} shares of expensive side every "
                  f"{config.ENGINE_B_INTERVAL_SECONDS}s from {config.ENGINE_B_PHASE2_START}s-"
                  f"{config.ENGINE_B_PHASE2_END}s if > {config.ENGINE_B_PHASE2_MIN_PRICE}"),
        )

    def _scheduled_ticks(self, start: int, end: int):
        t = start
        while t <= end:
            yield t
            t += config.ENGINE_B_INTERVAL_SECONDS

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.window is None:
            return
        now = now or time.time()
        elapsed = now - self.window.open_ts
        if up_price is None or down_price is None:
            return

        for tick in self._scheduled_ticks(config.ENGINE_B_PHASE1_START, config.ENGINE_B_PHASE1_END):
            key = ("p1", tick)
            if key in self._fired_ticks:
                continue
            if elapsed >= tick:
                self._fired_ticks.add(key)
                self._try_phase1(up_price, down_price, tick)

        for tick in self._scheduled_ticks(config.ENGINE_B_PHASE2_START, config.ENGINE_B_PHASE2_END):
            key = ("p2", tick)
            if key in self._fired_ticks:
                continue
            if elapsed >= tick:
                self._fired_ticks.add(key)
                self._try_phase2(up_price, down_price, tick)

    def _try_phase1(self, up_price: float, down_price: float, tick: int):
        cheap_side = Side.UP if up_price <= down_price else Side.DOWN
        cheap_price = up_price if cheap_side == Side.UP else down_price
        if cheap_price >= config.ENGINE_B_PHASE1_MAX_PRICE:
            self.broker.log_event(
                self.name, self.window.slug, "PHASE1_SKIP",
                side=cheap_side.value, price=cheap_price,
                note=f"t={tick}s: cheaper side {cheap_price:.2f} >= {config.ENGINE_B_PHASE1_MAX_PRICE}, no buy",
            )
            return
        self._build_leg(cheap_side, config.ENGINE_B_PHASE1_SHARES, cheap_price, tag="phase1", tick=tick)

    def _try_phase2(self, up_price: float, down_price: float, tick: int):
        exp_side = Side.UP if up_price >= down_price else Side.DOWN
        exp_price = up_price if exp_side == Side.UP else down_price
        if exp_price <= config.ENGINE_B_PHASE2_MIN_PRICE:
            self.broker.log_event(
                self.name, self.window.slug, "PHASE2_SKIP",
                side=exp_side.value, price=exp_price,
                note=f"t={tick}s: expensive side {exp_price:.2f} <= {config.ENGINE_B_PHASE2_MIN_PRICE}, no buy",
            )
            return
        self._build_leg(exp_side, config.ENGINE_B_PHASE2_SHARES, exp_price, tag="phase2", tick=tick)

    def _build_leg(self, side: Side, shares: float, price: float, tag: str, tick: int) -> Leg:
        position = self.broker.buy(
            self.name, self.window.slug, side, shares, price,
            note=f"{tag} leg entry @ t={tick}s",
        )
        self.broker.log_event(
            self.name, self.window.slug, "LEG_OPENED",
            side=side.value, price=price,
            note=f"{tag} leg (t={tick}s): {shares} shares, held to resolution",
        )
        leg = Leg(position=position, tag=tag, tick_seconds=tick)
        self.legs.append(leg)
        return leg

    def finalize_window(self, winning_side: Optional[Side]):
        if winning_side is not None:
            for leg in self.legs:
                won = leg.position.side == winning_side
                self.broker.resolve_expiry(self.name, self.window.slug, leg.position,
                                            won, note=f"{leg.tag} leg (t={leg.tick_seconds}s) held to expiry")
        self.legs = []

    def snapshot(self) -> dict:
        phase1_fired = sum(1 for k in self._fired_ticks if k[0] == "p1")
        phase2_fired = sum(1 for k in self._fired_ticks if k[0] == "p2")
        phase1_total = len(list(self._scheduled_ticks(config.ENGINE_B_PHASE1_START, config.ENGINE_B_PHASE1_END)))
        phase2_total = len(list(self._scheduled_ticks(config.ENGINE_B_PHASE2_START, config.ENGINE_B_PHASE2_END)))
        elapsed = (time.time() - self.window.open_ts) if self.window else 0
        if phase1_fired < phase1_total:
            phase = "phase1"
        elif elapsed < config.ENGINE_B_PHASE2_START:
            phase = "dead_zone"
        elif phase2_fired < phase2_total:
            phase = "phase2"
        else:
            phase = "done"
        return {
            "phase": phase,
            "window": self.window.slug if self.window else None,
            "phase1_checks_done": phase1_fired,
            "phase1_checks_total": phase1_total,
            "phase2_checks_done": phase2_fired,
            "phase2_checks_total": phase2_total,
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
