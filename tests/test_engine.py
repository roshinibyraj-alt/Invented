import os
import sys, copy
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from synth import make
from app import mtf_engine as M, config
from app.engine import Engine
from app.marketdata import TF_ORDER, TIMEFRAMES, Candle
from app.models import Side, WindowMarket
from app.paper_broker import PaperBroker

data, now = make(130, seed=5, plant=True)
recs = M.build_records(data, now=now, days=7)
pred = M.MTFPredictor(); pred.load_records(recs)
assert len(pred.rules) > 0

# ---- 1. train/serve consistency + no-lookahead: live path == backtest tokens at the same t
def live_frames_at(t, garble=True):
    f = {}
    for name, cs in data.items():
        secs = 300 if name=="5m" else TIMEFRAMES[name][1]
        keep = [copy.copy(c) for c in cs if c.open_time <= t][-(config.MTF_WARMUP_CANDLES+20):]
        if garble:
            # the newest candle in each list is the FORMING one (open_time <= t < open_time+secs): its
            # high/low/close/volume are not known at t -> replace with garbage; only its open is legit
            last = keep[-1]
            if last.open_time + secs > t:
                last.high, last.low, last.close, last.volume = last.open*1.5, last.open*0.5, last.open*1.4, 1e9
        f[name] = keep
    return f

checked = 0
for rec in recs[::37]:
    t = rec.ts
    frames = live_frames_at(t)
    price = M.price_at(frames["5m"], t)
    res = M.window_tokens(M.prepare_frames(frames), t, price)
    assert res is not None, t
    assert res[0] == rec.tokens, (t, res[0] ^ rec.tokens)
    checked += 1
print(f"1 ok: live tokens == backtest tokens on {checked} windows, even with garbage in forming candles (no lookahead)")

# ---- 2. staleness: missing latest closed 15m candle -> None (never guess)
t = recs[100].ts
frames = live_frames_at(t)
frames["15m"] = [c for c in frames["15m"] if c.open_time < (t // 900) * 900 - 900]      # drop last closed candle + forming
assert M.window_tokens(M.prepare_frames(frames), t, M.price_at(frames["5m"], t)) is None
print("2 ok: stale timeframe -> no snapshot")

# ---- 3. engine end-to-end: signal -> taker buy of the PREDICTED side at window open + 2s
def mk_engine(t):
    e = Engine(PaperBroker(), pred)
    w = WindowMarket("w", None, "u", "d", float(t), float(t + 300))
    e.reset_for_window(w)
    return e, w

target = None
for rec in recs:
    r = pred.predict(rec.tokens, {})
    if r is not None: target = (rec, r); break
assert target, "no matched window"
rec, expected = target
t = rec.ts
frames = live_frames_at(t)
price_now = M.price_at(frames["5m"], t)

def tick(e, ts, ua, da, ul=None, dl=None, ub=0.4, db=0.4):
    e.on_tick(ub, ua, db, da, 300, now=ts, up_bid_levels=[(ub,1000)], down_bid_levels=[(db,1000)], up_ask_levels=ul, down_ask_levels=dl)

def asks_for(side, pred_side_ask, other_ask):
    return (pred_side_ask, other_ask) if side == Side.UP else (other_ask, pred_side_ask)

e, w = mk_engine(t)
assert e.needs_frames() and e.set_frames(frames, price_now)
side = expected.side
bal0 = e.capital.balance
tick(e, t + 0.3, *asks_for(side, 0.52, 0.48))            # signal decided, but too early to buy
assert e.s.entry_pending and e.s.position is None and e.capital.balance == bal0
assert not hasattr(e.s, "order") and e.snapshot()["status"] == "entry_pending"
assert e.snapshot()["entry"]["side"] == side.value
tick(e, t + 1.9, *asks_for(side, 0.52, 0.48))
assert e.s.position is None, "must not buy before +2s"
lv = [(0.52, 100), (0.55, 300)]
tick(e, t + 2.0, *asks_for(side, 0.52, 0.48), **({"ul": lv} if side == Side.UP else {"dl": lv}))
p = e.s.position
vwap = (100 * .52 + 100 * .55) / 200
assert p and p.side == side and p.entry_type == "taker" and abs(p.entry_price - vwap) < 1e-9, p
fee = e.broker.taker_fee_amount(200, vwap)
assert abs(p.cost - (200 * vwap + fee)) < 1e-9 and abs(bal0 - e.capital.balance - p.cost) < 1e-9
assert not e.s.entry_pending and e.total_entries == 1
ev = [x.event for x in e.broker.log]
assert "SIGNAL_ARMED" in ev and "TAKER_ENTRY" in ev and not any(x.startswith("RUNG") for x in ev), ev
print(f"3 ok: signal {side.value}; no buy before +2s; taker fill at +2.0s @ {p.entry_price:.4f} (depth-walked, fee ${fee:.3f} in cost)")
print("   ", [x.note for x in e.broker.log if x.event == "MTF_SIGNAL"][0][:200])

# ---- 4. ask >= 0.60 at +2s -> keep checking every tick; buy first tick strictly below 0.60
e, w = mk_engine(t); e.set_frames(frames, price_now)
tick(e, t + 2.5, *asks_for(side, 0.70, 0.30)); assert e.s.position is None and e.s.entry_pending
tick(e, t + 10, *asks_for(side, 0.60, 0.40)); assert e.s.position is None        # exactly 0.60 is NOT below
tick(e, t + 100, *asks_for(side, 0.65, 0.35)); assert e.s.position is None
lv = [(0.59, 500)]
tick(e, t + 200, *asks_for(side, 0.59, 0.41), **({"ul": lv} if side == Side.UP else {"dl": lv}))
assert e.s.position and e.s.position.side == side and e.s.position.entry_price == 0.59
assert [x.event for x in e.broker.log].count("ENTRY_WAIT") == 1
print("4 ok: ask >= 0.60 -> waits (checked every tick), buys first tick below 0.60")

# ---- 5. never below the cap -> ENTRY_SKIPPED, nothing spent
e, w = mk_engine(t); e.set_frames(frames, price_now)
tick(e, t + 3, *asks_for(side, 0.75, 0.25)); tick(e, t + 250, *asks_for(side, 0.80, 0.20))
e.finalize_window(Side.UP)
assert e.total_entry_skips == 1 and e.total_pnl == 0 and e.capital.balance == config.STARTING_CAPITAL
assert "ENTRY_SKIPPED" in [x.event for x in e.broker.log]
print("5 ok: ask never below cap -> skipped window, balance untouched")

# ---- 6. zero ask depth -> no fabricated fill, retries
e, w = mk_engine(t); e.set_frames(frames, price_now)
tick(e, t + 3, *asks_for(side, 0.55, 0.45), **({"ul": []} if side == Side.UP else {"dl": []}))
assert e.s.position is None and e.s.entry_pending and e.total_illiquid_skips == 1
print("6 ok: empty ask book -> no fill, keeps trying")

# ---- 7. TP exit and forced close work off the taker entry
e, w = mk_engine(t); e.set_frames(frames, price_now)
tick(e, t + 2, *asks_for(side, 0.52, 0.48)); assert e.s.position
if side == Side.UP:
    e.on_tick(0.99, 1.0, 0.01, 0.02, 200, now=t + 60, up_bid_levels=[(0.99, 1000)])
else:
    e.on_tick(0.01, 0.02, 0.99, 1.0, 200, now=t + 60, down_bid_levels=[(0.99, 1000)])
assert e.s.position is None and e.total_tp_fills == 1 and e.total_pnl > 0
e, w = mk_engine(t); e.set_frames(frames, price_now)
tick(e, t + 2, *asks_for(side, 0.52, 0.48)); e.finalize_window(Side.DOWN if side == Side.UP else Side.UP)
assert e.total_forced_closes == 1 and e.total_pnl < 0
print("7 ok: TP exit and forced close")

# ---- 8. engine with no models at all -> NO_TRADE, nothing armed
e, w = mk_engine(t); e.set_frames(frames, price_now)
saved = pred.models; pred.models = None
tick(e, t + 0.3, 0.5, 0.5); pred.models = saved
assert not e.s.entry_pending and e.total_no_match_windows == 1 and e.s.decision_made and e.s.position is None
tick(e, t + 5, 0.5, 0.5); assert e.s.position is None
print("8 ok: no models -> no trade")

# ---- 9. close: history append + prediction scoring
n0 = len(pred.records)
e, w = mk_engine(t + 300 * 10**6)
e.s.tokens = rec.tokens; e.s.predicted_side = Side.UP
before = pred.total_predictions
e.finalize_window(Side.UP)
assert len(pred.records) == min(n0 + 1, 2016) and pred.records[-1].ts > recs[-1].ts and pred.total_predictions == before + 1
print("9 ok: resolved window appended to history + live accuracy tracked")

# ---- 10. snapshot serialises
import json
e2, w2 = mk_engine(t); e2.set_frames(frames, price_now); tick(e2, t + 0.3, 0.5, 0.5)
snap = e2.snapshot(); json.dumps(snap)
assert snap["prediction"]["reasons"] and snap["prediction"]["tier"] in ("validated","candidate","baseline") and snap["def"]["entry_delay_s"] == 2.0 and snap["def"]["entry_max_price"] == 0.60
print("10 ok: snapshot JSON | status:", snap["status"])
print("ALL PASSED")
