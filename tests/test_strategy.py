"""The signal rule, exactly as specified: UP = min2 < min1 and avg(min3-5) > avg(min1-2); DOWN = mirror."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from app.strategy import evaluate, closes_for_window
from app.binance import MinuteCandle
from app.models import Side

# UP: dip at minute 2, then minutes 3-5 average above minutes 1-2
r = evaluate([100.0, 99.0, 99.8, 100.2, 100.5])
assert r.side == Side.UP and r.min2_below_min1 and r.last3_above_first2, r
# DOWN: mirror
r = evaluate([100.0, 101.0, 100.2, 99.8, 99.5])
assert r.side == Side.DOWN and r.min2_above_min1 and r.last3_below_first2, r
print("1 ok: UP and DOWN patterns")

# min2 below min1 but minutes 3-5 did NOT recover above minutes 1-2 -> nothing
assert evaluate([100.0, 99.0, 99.2, 99.3, 99.4]).side is None
# recovery above, but min2 was not below min1 (min2 above) -> not UP (and not DOWN either)
assert evaluate([100.0, 100.5, 101.0, 101.2, 101.4]).side is None
# opposite mirror cases
assert evaluate([100.0, 101.0, 100.6, 100.7, 100.8]).side is None
assert evaluate([100.0, 99.5, 99.0, 98.8, 98.6]).side is None
print("2 ok: half-patterns don't fire")

# equalities never fire
assert evaluate([100.0, 100.0, 101.0, 101.0, 101.0]).side is None
assert evaluate([100.0, 99.0, 99.5, 99.5, 99.5]).side is None      # avg345 == avg12 (99.5)
print("3 ok: ties don't fire")

# averaging matters: the SUM of three prices always beats the sum of two, so a raw-sum test would fire here.
c = [100.0, 99.0, 99.4, 99.4, 99.4]           # sum(c3..c5)=298.2 > sum(c1,c2)=199 but mean 99.4 < mean 99.5
assert evaluate(c).side is None
print("4 ok: compares averages, not raw sums")

# exactly one of UP/DOWN/none, never both, over many random paths
import random
rnd = random.Random(7); n = {"UP": 0, "DOWN": 0, None: 0}
for _ in range(20000):
    cl = [60000 + rnd.gauss(0, 30) for _ in range(5)]
    r = evaluate(cl); n[r.side.value if r.side else None] += 1
    assert not (r.min2_below_min1 and r.min2_above_min1)
print(f"5 ok: random paths -> UP {n['UP']}, DOWN {n['DOWN']}, none {n[None]} (UP~DOWN, symmetric)")
assert abs(n["UP"] - n["DOWN"]) < 0.1 * (n["UP"] + n["DOWN"])

# closes_for_window: only finished minute candles of THIS window count
P = 1_800_000_000
def mc(i, close, finished=True):
    o = P + 60 * i
    return MinuteCandle(open_time=o, close=close, close_time=o + 59.999)
full = [mc(i, 100 + i) for i in range(5)]
assert closes_for_window(full, P, now=P + 300.5) == [100, 101, 102, 103, 104]
assert closes_for_window(full, P, now=P + 299.0) is None              # minute 5 not closed yet
assert closes_for_window(full[:4], P, now=P + 400) is None            # a minute missing
wrong_window = [mc(i, 100) for i in range(5)]
assert closes_for_window(wrong_window, P + 300, now=P + 700) is None  # candles of another window
print("6 ok: candle selection never uses a forming/missing/foreign minute")
print("STRATEGY TESTS PASSED")
