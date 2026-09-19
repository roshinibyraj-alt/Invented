import os
import random, math, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.marketdata import Candle, TIMEFRAMES

def gen_5m(days, seed=1, plant=False, start_ts=1_760_000_000//86400*86400):
    """Random-walk BTC as 5-minute bars, generated one 15-minute WINDOW (3 bars) at a time.
    plant=True: in UTC 08-12h, if the last closed 15m candle is RED, the next 15m window
    finishes UP w.p. 0.85 (otherwise 0.5)."""
    rnd = random.Random(seed)
    n_windows = int(days * 96)
    out = []; price = 60000.0
    for k in range(n_windows):
        t = start_ts + k * 900
        up_prob = 0.5
        if plant and 8 <= (t // 3600) % 24 < 12 and len(out) >= 3:
            prev = out[-3:]
            if prev[-1].close < prev[0].open:
                up_prob = 0.85
        sign = 1 if rnd.random() < up_prob else -1
        mag = abs(rnd.gauss(0, 0.002))
        noise = [rnd.gauss(0, 0.0004) for _ in range(3)]
        mean = sum(noise) / 3
        for j in range(3):
            ret = sign * mag / 3 + (noise[j] - mean)      # zero-sum noise keeps the window's net sign
            o = price; c = o * (1 + ret)
            h = max(o, c) * (1 + abs(rnd.gauss(0, 0.0003))); l = min(o, c) * (1 - abs(rnd.gauss(0, 0.0003)))
            out.append(Candle(t + j * 300, o, h, l, c, rnd.uniform(50, 150)))
            price = c
    return out

def agg(c5, secs):
    out=[]; cur=None
    for c in c5:
        b=(c.open_time//secs)*secs
        if cur is None or cur.open_time!=b:
            if cur is not None: out.append(cur)
            cur=Candle(b,c.open,c.high,c.low,c.close,c.volume)
        else:
            cur.high=max(cur.high,c.high); cur.low=min(cur.low,c.low); cur.close=c.close; cur.volume+=c.volume
    if cur is not None: out.append(cur)
    return out

def make(days=130, seed=1, plant=False):
    c5=gen_5m(days,seed,plant)
    data={}
    for tf,(iv,secs) in TIMEFRAMES.items():
        data[tf]=agg(c5,secs)
    now=c5[-1].open_time+300
    return data, now
