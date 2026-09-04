"""
Engine B (v2) -- the only engine running. Engine A has been removed.

Flow
----
1. Wait ENGINE_B_ENTRY_WAIT_SECONDS (45s) after window open. No action
   before that.
2. At the 45s mark, buy the cheaper of the two sides, provided its price
   is below ENGINE_B_ENTRY_MAX_PRICE (0.70). Since Up+Down prices are
   complementary (~1.0), at least one side is always below 0.70 in
   practice; the check exists mainly to skip the rare degenerate case
   where the book is too thin/wide to tell.
3. Exit rule depends on the entry price tier:
     entry <  0.30            -> take profit at 0.50
     entry >= 0.60            -> hold to resolution (no early exit)
     entry in [0.30, 0.60)    -> no rule was specified; defaults to
                                  "hold to resolution" (a 0.50 TP would
                                  guarantee a loss for any entry above
                                  0.50, so it can't extend into this band)
4. Stop loss at (entry price - ENGINE_B_STOP_LOSS_OFFSET), active from
   the moment the position is opened.
5. After entering, wait another 45s, then watch the *other* side (not
   the one held). The first time it prints inside [0.70, 0.72], double
   the position: buy the same number of shares again, on the side
   already held, at that side's current price, and blend the average
   entry price. This fires once per window.
6. The 0.90+-in-the-last-2-seconds signal is still logged for visibility
   but never triggers an action on its own -- exits only happen via TP,
   SL, or expiry.
"""
import time
from typing import Optional

from . import config
from .models import EngineBPhase, Position, Side, WindowMarket
from .paper_broker import PaperBroker


class EngineB:
    name = "B"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.phase = EngineBPhase.FLAT
        self.window: Optional[WindowMarket] = None
        self.position: Optional[Position] = None
        self.entry_time: Optional[float] = None
        self.stop_loss_price: Optional[float] = None
        self.tp_price: Optional[float] = None  # None means "hold to resolution"
        self.doubled = False
        self.winner_logged = False

    def reset_for_window(self, window: WindowMarket):
        self.window = window
        self.position = None
        self.entry_time = None
        self.stop_loss_price = None
        self.tp_price = None
        self.doubled = False
        self.winner_logged = False
        self.phase = EngineBPhase.WAITING_ENTRY
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

        if self.phase == EngineBPhase.WAITING_ENTRY:
            if elapsed >= config.ENGINE_B_ENTRY_WAIT_SECONDS:
                self._attempt_entry(prices, now)

        elif self.phase == EngineBPhase.ENTERED_WAITING:
            if self._manage_exits(prices):
                pass  # exited via TP/SL
            elif self.entry_time is not None and \
                    (now - self.entry_time) >= config.ENGINE_B_POST_ENTRY_WAIT_SECONDS:
                self.phase = EngineBPhase.WATCHING_DOUBLE

        elif self.phase == EngineBPhase.WATCHING_DOUBLE:
            if not self._manage_exits(prices):
                self._check_double_trigger(prices)

        elif self.phase == EngineBPhase.DOUBLED:
            self._manage_exits(prices)

        if (not self.winner_logged and seconds_to_close <= config.RESOLUTION_WINDOW_SECONDS
                and seconds_to_close >= 0):
            self._log_resolution_signal(prices)

    def _attempt_entry(self, prices, now: float):
        up_p, down_p = prices.get(Side.UP), prices.get(Side.DOWN)
        if up_p is None or down_p is None:
            return
        cheaper_side = Side.UP if up_p <= down_p else Side.DOWN
        entry_price = prices[cheaper_side]

        if entry_price >= config.ENGINE_B_ENTRY_MAX_PRICE:
            self.phase = EngineBPhase.NO_ENTRY
            self.broker.log_event(self.name, self.window.slug, "NO_ENTRY",
                                   note=f"Both sides >= {config.ENGINE_B_ENTRY_MAX_PRICE} at entry check -- skipped")
            return

        self.position = self.broker.buy(
            self.name, self.window.slug, cheaper_side,
            config.ENGINE_B_BASE_SHARES, entry_price,
            note="45s entry: bought cheaper side",
        )
        self.entry_time = now
        self.stop_loss_price = entry_price - config.ENGINE_B_STOP_LOSS_OFFSET

        if entry_price < config.ENGINE_B_LOW_TIER_MAX:
            self.tp_price = config.ENGINE_B_LOW_TIER_TP
            tier_note = f"low tier -> TP {self.tp_price}"
        else:
            self.tp_price = None  # hold to resolution (high tier, or the
                                    # unspecified middle band defaulting here)
            tier_note = "hold to resolution"

        self.phase = EngineBPhase.ENTERED_WAITING
        self.broker.log_event(
            self.name, self.window.slug, "ENTRY_TIER",
            side=cheaper_side.value, price=entry_price,
            note=f"{tier_note}; SL {self.stop_loss_price:.2f}",
        )

    def _manage_exits(self, prices) -> bool:
        """Checks SL then TP. Returns True if the position was closed."""
        pos = self.position
        if pos is None:
            return False
        p = prices.get(pos.side)
        if p is None:
            return False

        if self.stop_loss_price is not None and p <= self.stop_loss_price:
            self.broker.sell(self.name, self.window.slug, pos, p,
                              note=f"Stop loss hit at {self.stop_loss_price:.2f}")
            self.position = None
            self.phase = EngineBPhase.STOPPED_OUT
            return True

        if self.tp_price is not None and p >= self.tp_price:
            self.broker.sell(self.name, self.window.slug, pos, p,
                              note=f"Take profit hit at {self.tp_price:.2f}")
            self.position = None
            self.phase = EngineBPhase.TP_EXIT
            return True

        return False

    def _check_double_trigger(self, prices):
        if self.doubled or self.position is None:
            return
        other_side = self.position.side.other()
        p = prices.get(other_side)
        if p is None:
            return
        if config.ENGINE_B_DOUBLE_BAND_LOW <= p <= config.ENGINE_B_DOUBLE_BAND_HIGH:
            held_side_price = prices.get(self.position.side)
            if held_side_price is None:
                return
            extra_shares = self.position.shares  # double total size
            self.broker.buy_add(
                self.name, self.window.slug, self.position,
                extra_shares, held_side_price,
                note=f"Doubled: other side printed {p:.2f} (band {config.ENGINE_B_DOUBLE_BAND_LOW}-{config.ENGINE_B_DOUBLE_BAND_HIGH})",
            )
            self.doubled = True
            self.phase = EngineBPhase.DOUBLED
            # Stop loss stays anchored to the blended average entry.
            self.stop_loss_price = self.position.entry_price - config.ENGINE_B_STOP_LOSS_OFFSET

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
        if self.position is not None and winning_side is not None:
            won = self.position.side == winning_side
            self.broker.resolve_expiry(self.name, self.window.slug, self.position,
                                        won, note="Held to expiry")
            self.position = None
        self.phase = EngineBPhase.RESOLVED

    def snapshot(self) -> dict:
        return {
            "phase": self.phase.value,
            "window": self.window.slug if self.window else None,
            "entry_time": self.entry_time,
            "stop_loss_price": self.stop_loss_price,
            "tp_price": self.tp_price,
            "doubled": self.doubled,
            "position": None if not self.position else {
                "side": self.position.side.value,
                "shares": self.position.shares,
                "entry_price": self.position.entry_price,
            },
        }
