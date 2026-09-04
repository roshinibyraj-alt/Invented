"""
Engine B (v3) -- the only engine running.

Flow
----
1. Wait ENGINE_B_ENTRY_WAIT_SECONDS (45s) after window open. No action
   before that.
2. At the 45s mark, buy the cheaper of the two sides, provided its price
   is below ENGINE_B_ENTRY_MAX_PRICE (0.70). This becomes the "primary"
   leg.
3. Exit rule for a leg depends on ITS OWN entry price tier:
     entry <  0.30            -> take profit at 0.50
     entry >= 0.60            -> hold to resolution (no early exit)
     entry in [0.30, 0.60)    -> hold to resolution (no rule was given
                                  for this band; defaulted here since a
                                  0.50 TP would guarantee a loss above
                                  entry 0.50)
   Stop loss for a leg is always (that leg's entry price - 0.15),
   active from the moment the leg opens.
4. After the primary leg opens, wait another 45s, then watch the OTHER
   side (not the one held). The first time it prints inside
   [0.70, 0.72], open a SECOND, FULLY INDEPENDENT leg: buy the same
   share count again on the held side, at whatever that side's current
   price is. This leg gets its OWN entry price, its OWN stop loss
   (leg entry - 0.15), and its OWN TP tier -- it is NOT blended into
   the primary leg's average. Fires at most once per window.
5. Each leg is monitored and exited independently for the rest of the
   window -- one can hit its TP or SL while the other keeps running (or
   is later added). Both are on the same side, but they are two
   separate positions in the ledger.
6. A side printing 0.90+ in the last 2 seconds before close is logged
   for visibility but never triggers an action on its own.
7. At window close, any legs still open are settled at Polymarket's
   real outcome: $1/share if the leg's side won, $0/share if it lost.
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
    stop_loss_price: float
    tp_price: Optional[float]  # None means "hold to resolution"
    tag: str  # "primary" or "double"


class EngineB:
    name = "B"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.window: Optional[WindowMarket] = None
        self.legs: List[Leg] = []
        self.side: Optional[Side] = None
        self.entry_time: Optional[float] = None
        self.entry_attempted = False
        self.no_entry = False
        self.doubled = False
        self.winner_logged = False

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        self.legs = []
        self.side = None
        self.entry_time = None
        self.entry_attempted = False
        self.no_entry = False
        self.doubled = False
        self.winner_logged = False
        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=f"Waiting {config.ENGINE_B_ENTRY_WAIT_SECONDS}s before entry (size={config.ENGINE_B_BASE_SHARES})",
        )

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.window is None:
            return
        now = now or time.time()
        elapsed = now - self.window.open_ts
        prices = {Side.UP: up_price, Side.DOWN: down_price}

        if not self.entry_attempted:
            if elapsed >= config.ENGINE_B_ENTRY_WAIT_SECONDS:
                self._attempt_entry(prices, now)
        else:
            self._manage_exits(prices)
            if (not self.doubled and self.legs and self.entry_time is not None
                    and (now - self.entry_time) >= config.ENGINE_B_POST_ENTRY_WAIT_SECONDS):
                self._check_double_trigger(prices)

        if (not self.winner_logged and seconds_to_close <= config.RESOLUTION_WINDOW_SECONDS
                and seconds_to_close >= 0):
            self._log_resolution_signal(prices)

    def _build_leg(self, side: Side, shares: float, price: float, tag: str) -> Leg:
        position = self.broker.buy(
            self.name, self.window.slug, side, shares, price,
            note=f"{tag} leg entry",
        )
        stop_loss_price = price - config.ENGINE_B_STOP_LOSS_OFFSET
        tp_price = config.ENGINE_B_LOW_TIER_TP if price < config.ENGINE_B_LOW_TIER_MAX else None
        tier_note = f"TP {tp_price}" if tp_price is not None else "hold to resolution"
        self.broker.log_event(
            self.name, self.window.slug, "LEG_OPENED",
            side=side.value, price=price,
            note=f"{tag} leg: {tier_note}; SL {stop_loss_price:.2f}",
        )
        return Leg(position=position, stop_loss_price=stop_loss_price,
                   tp_price=tp_price, tag=tag)

    def _attempt_entry(self, prices, now: float):
        up_p, down_p = prices.get(Side.UP), prices.get(Side.DOWN)
        if up_p is None or down_p is None:
            return  # retry next tick, don't mark as attempted yet
        self.entry_attempted = True

        cheaper_side = Side.UP if up_p <= down_p else Side.DOWN
        entry_price = prices[cheaper_side]

        if entry_price >= config.ENGINE_B_ENTRY_MAX_PRICE:
            self.no_entry = True
            self.broker.log_event(self.name, self.window.slug, "NO_ENTRY",
                                   note=f"Both sides >= {config.ENGINE_B_ENTRY_MAX_PRICE} at entry check -- skipped")
            return

        self.side = cheaper_side
        self.entry_time = now
        leg = self._build_leg(cheaper_side, config.ENGINE_B_BASE_SHARES, entry_price, tag="primary")
        self.legs.append(leg)

    def _manage_exits(self, prices):
        if not self.legs or self.side is None:
            return
        p = prices.get(self.side)
        if p is None:
            return
        remaining = []
        for leg in self.legs:
            if p <= leg.stop_loss_price:
                self.broker.sell(self.name, self.window.slug, leg.position, p,
                                  note=f"{leg.tag} leg stop loss hit at {leg.stop_loss_price:.2f}")
                continue
            if leg.tp_price is not None and p >= leg.tp_price:
                self.broker.sell(self.name, self.window.slug, leg.position, p,
                                  note=f"{leg.tag} leg take profit hit at {leg.tp_price:.2f}")
                continue
            remaining.append(leg)
        self.legs = remaining

    def _check_double_trigger(self, prices):
        if self.doubled or not self.legs or self.side is None:
            return
        other_side = self.side.other()
        other_p = prices.get(other_side)
        if other_p is None:
            return
        if config.ENGINE_B_DOUBLE_BAND_LOW <= other_p <= config.ENGINE_B_DOUBLE_BAND_HIGH:
            held_price = prices.get(self.side)
            if held_price is None:
                return
            leg = self._build_leg(self.side, config.ENGINE_B_BASE_SHARES, held_price, tag="double")
            self.legs.append(leg)
            self.doubled = True
            self.broker.log_event(
                self.name, self.window.slug, "DOUBLED",
                note=f"Other side printed {other_p:.2f} inside {config.ENGINE_B_DOUBLE_BAND_LOW}-{config.ENGINE_B_DOUBLE_BAND_HIGH} -- opened independent second leg",
            )

    def _log_resolution_signal(self, prices):
        winner = None
        for side, p in prices.items():
            if p is not None and p >= config.ENGINE_B_RESOLUTION_PRICE:
                winner = side
                break
        if winner is not None:
            self.winner_logged = True
            self.broker.log_event(self.name, self.window.slug, "RESOLUTION_SIGNAL",
                                   side=winner.value, price=prices[winner],
                                   note="Logging only, no action taken")

    def finalize_window(self, winning_side: Optional[Side]):
        if winning_side is not None:
            for leg in self.legs:
                won = leg.position.side == winning_side
                self.broker.resolve_expiry(self.name, self.window.slug, leg.position,
                                            won, note=f"{leg.tag} leg held to expiry")
        self.legs = []

    def snapshot(self) -> dict:
        if not self.entry_attempted:
            phase = "waiting_entry"
        elif self.no_entry:
            phase = "no_entry"
        elif self.legs:
            phase = "doubled" if self.doubled else "in_position"
        else:
            phase = "closed"  # all legs already exited via TP/SL this window
        return {
            "phase": phase,
            "window": self.window.slug if self.window else None,
            "side": self.side.value if self.side else None,
            "entry_time": self.entry_time,
            "doubled": self.doubled,
            "legs": [
                {
                    "tag": leg.tag,
                    "side": leg.position.side.value,
                    "shares": leg.position.shares,
                    "entry_price": leg.position.entry_price,
                    "stop_loss_price": leg.stop_loss_price,
                    "tp_price": leg.tp_price,
                }
                for leg in self.legs
            ],
        }
