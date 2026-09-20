"""
The signal: the window that just closed decides the next window's side.

Inputs: the five 1-minute closes c1..c5 of the CURRENT (just-closed) window.

  UP   : c2 < c1                      (minute 2 dipped below minute 1)
         and mean(c3, c4, c5) > mean(c1, c2)   (minutes 3-5 recovered above minutes 1-2)
  DOWN : c2 > c1 and mean(c3, c4, c5) < mean(c1, c2)   (exactly the mirror)
  none : anything else (including any equality) -> no trade next window.

Averages are compared rather than raw sums because three prices always sum
to more than two; the mean makes "minutes 3-5 vs minutes 1-2" a fair test.
Pure functions, no I/O.
"""
from dataclasses import dataclass, field
from typing import List, Optional, Sequence

from .models import Side


@dataclass
class SignalResult:
    side: Optional[Side]
    closes: List[float]
    avg_first2: float
    avg_last3: float
    min2_below_min1: bool
    min2_above_min1: bool
    last3_above_first2: bool
    last3_below_first2: bool
    reason: str

    def to_dict(self) -> dict:
        return {
            "side": self.side.value if self.side else None,
            "closes": [round(c, 2) for c in self.closes],
            "avg_first2": round(self.avg_first2, 2),
            "avg_last3": round(self.avg_last3, 2),
            "min2_below_min1": self.min2_below_min1,
            "min2_above_min1": self.min2_above_min1,
            "last3_above_first2": self.last3_above_first2,
            "last3_below_first2": self.last3_below_first2,
            "reason": self.reason,
        }


def evaluate(closes: Sequence[float]) -> SignalResult:
    if len(closes) != 5:
        raise ValueError("need exactly five 1-minute closes")
    c1, c2, c3, c4, c5 = closes
    avg12 = (c1 + c2) / 2.0
    avg345 = (c3 + c4 + c5) / 3.0
    below, above = c2 < c1, c2 > c1
    rec_up, rec_down = avg345 > avg12, avg345 < avg12

    if below and rec_up:
        side = Side.UP
        reason = (f"min2 {c2:.2f} < min1 {c1:.2f} (dip) and avg(min3-5) {avg345:.2f} > "
                  f"avg(min1-2) {avg12:.2f} (recovery) -> UP")
    elif above and rec_down:
        side = Side.DOWN
        reason = (f"min2 {c2:.2f} > min1 {c1:.2f} (pop) and avg(min3-5) {avg345:.2f} < "
                  f"avg(min1-2) {avg12:.2f} (fade) -> DOWN")
    else:
        side = None
        first = "min2 below min1" if below else "min2 above min1" if above else "min2 equals min1"
        second = ("avg(min3-5) above avg(min1-2)" if rec_up else
                  "avg(min3-5) below avg(min1-2)" if rec_down else "avg(min3-5) equals avg(min1-2)")
        reason = f"no pattern: {first}, {second}"
    return SignalResult(side=side, closes=list(closes), avg_first2=avg12, avg_last3=avg345,
                        min2_below_min1=below, min2_above_min1=above,
                        last3_above_first2=rec_up, last3_below_first2=rec_down, reason=reason)


def closes_for_window(candles, window_open_ts: float, now: float) -> Optional[List[float]]:
    """The five 1-minute closes of the window opening at window_open_ts, or
    None if any minute is missing or hasn't finished closing yet (the caller
    just retries next tick). Never uses a still-forming candle."""
    by_open = {round(c.open_time): c for c in candles}
    closes = []
    for i in range(5):
        c = by_open.get(round(window_open_ts + 60 * i))
        if c is None or c.close_time >= now:
            return None
        closes.append(c.close)
    return closes
