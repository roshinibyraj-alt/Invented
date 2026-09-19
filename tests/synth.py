import os
import random, math, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.marketdata import Candle, TIMEFRAMES

def gen_5m(days, seed=1, plant=False, start_ts=1_760_000_000//86400*86400):
    """5m random walk. plant=True: in UTC 08-12h, if last closed 15m candle is RED, next 5m bar is UP w.p. 0.72."""
    rnd = random.Random(seed)
    n = int(days*288)
    out=[]; price=60000.0
    for k in range(n):
        t = start_ts + k*300
        up_prob = 0.5
        if plant and 8 <= (t//3600)%24 < 12 and len(out) >= 3:
            # last closed 15m candle as of t
            i15 = (t//900)*900
            bars=[c for c in out[-6:] if i15-900 <= c.open_time < i15]
            if len(bars)==3 and bars[-1].close < bars[0].open:
                up_prob = 0.72
        mag = abs(rnd.gauss(0, 0.0012))
        ret = mag if rnd.random() < up_prob else -mag
        o = price; c = o*(1+ret)
        h = max(o,c)*(1+abs(rnd.gauss(0,0.0004))); l = min(o,c)*(1-abs(rnd.gauss(0,0.0004)))
        out.append(Candle(t,o,h,l,c,rnd.uniform(50,150)))
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
    data={"5m":c5}
    for tf,(iv,secs) in TIMEFRAMES.items():
        data[tf]=agg(c5,secs)
    now=c5[-1].open_time+300
    return data, now
