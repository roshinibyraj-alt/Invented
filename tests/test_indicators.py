"""Indicators vs pandas (skipped if pandas isn't installed)."""
import os, sys, random
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import indicators as I
try:
    import pandas as pd, numpy as np
except ImportError:
    print("pandas not installed -- skipping indicator cross-check"); sys.exit(0)

random.seed(1); n = 800
c = [100.0]
for _ in range(n - 1): c.append(c[-1] * (1 + random.gauss(0, 0.01)))
h = [x * (1 + abs(random.gauss(0, 0.004))) for x in c]; l = [x * (1 - abs(random.gauss(0, 0.004))) for x in c]
s = pd.Series(c)
def md(a, b): return max(abs(x - y) for x, y in zip(a, b) if x is not None and not np.isnan(y))
d = s.diff(); up = d.clip(lower=0).ewm(alpha=1/14, adjust=False).mean(); dn = (-d.clip(upper=0)).ewm(alpha=1/14, adjust=False).mean()
assert md(I.rsi(c)[500:], (100 - 100 / (1 + up / dn)).tolist()[500:]) < 1e-9
pl = s.ewm(span=12, adjust=False).mean() - s.ewm(span=26, adjust=False).mean()
assert md(I.macd(c)[2][500:], (pl - pl.ewm(span=9, adjust=False).mean()).tolist()[500:]) < 1e-9
sm, sd = s.rolling(20).mean(), s.rolling(20).std(ddof=0)
assert md(I.bollinger_pct_b(c)[30:], ((s - (sm - 2 * sd)) / (4 * sd)).tolist()[30:]) < 1e-9
tr = pd.concat([pd.Series(h) - pd.Series(l), (pd.Series(h) - s.shift()).abs(), (pd.Series(l) - s.shift()).abs()], axis=1).max(axis=1)
assert md(I.atr(h, l, c)[500:], tr.ewm(alpha=1/14, adjust=False).mean().tolist()[500:]) < 1e-9
print("INDICATOR TESTS PASSED")
