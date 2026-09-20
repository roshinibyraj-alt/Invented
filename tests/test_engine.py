import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from app import config
from app.engine import Engine
from app.models import Side, WindowMarket
from app.paper_broker import PaperBroker
from app.strategy import evaluate

T = 1_800_000_000
UP_CLOSES = [100.0, 99.0, 99.8, 100.2, 100.5]
DOWN_CLOSES = [100.0, 101.0, 100.2, 99.8, 99.5]
FLAT_CLOSES = [100.0, 100.0, 100.0, 100.0, 100.0]

def mk(closes=UP_CLOSES, late=False, signal=True):
    e = Engine(PaperBroker())
    w = WindowMarket("w", None, "u", "d", float(T), float(T + 300))
    e.reset_for_window(w, late_join=late)
    if signal and not late:
        e.set_signal(evaluate(closes), now=float(T))
    return e

def tick(e, ts, ua, da, ul=None, dl=None, ub=0.30, db=0.30):
    e.on_tick(ub, ua, db, da, 300, now=ts, up_bid_levels=[(ub, 1000)], down_bid_levels=[(db, 1000)],
              up_ask_levels=ul, down_ask_levels=dl)

def ev(e): return [x.event for x in e.broker.log]

# ---- 1. UP signal -> resting limit on UP @ 0.40 x 200 the moment the window opens
e = mk(UP_CLOSES)
o = e.s.order
assert o.side == Side.UP and o.price == 0.40 and o.shares == 200 and o.status == "resting"
assert "SIGNAL" in ev(e) and "LIMIT_PLACED" in ev(e) and e.snapshot()["status"] == "limit_resting"
print("1 ok: UP signal -> resting limit buy UP 200 @ 0.40")

# ---- 2. limit fills at its own price when the ask reaches it; maker = no fee; nothing more is bought
e = mk(UP_CLOSES); bal0 = e.capital.balance
tick(e, T + 5, 0.45, 0.55); assert e.s.position is None
tick(e, T + 30, 0.40, 0.60)
p = e.s.position
assert p and p.side == Side.UP and p.shares == 200 and p.entry_price == 0.40 and p.entry_type == "maker"
assert abs(p.cost - 80.0) < 1e-9 and abs(bal0 - e.capital.balance - 80.0) < 1e-9
tick(e, T + 200, 0.50, 0.50)                       # later: ask < 0.60 must NOT trigger a second (taker) buy
assert e.s.position.shares == 200 and e.total_taker_entries == 0 and e.total_limit_fills == 1
print("2 ok: limit fills @ 0.40 (maker, no fee, $80), no taker follow-up")

# ---- 3. DOWN signal is the exact mirror: order on DOWN, UP's price is irrelevant
e = mk(DOWN_CLOSES)
assert e.s.order.side == Side.DOWN and e.s.order.price == 0.40
tick(e, T + 5, 0.30, 0.45); assert e.s.position is None
tick(e, T + 6, 0.30, 0.39); assert e.s.position and e.s.position.side == Side.DOWN
print("3 ok: DOWN signal -> order on DOWN")

# ---- 4. 2-minute timeout: cancel, then taker 300 sh (depth-walked, with fee) once ask < 0.60
e = mk(UP_CLOSES); bal0 = e.capital.balance
tick(e, T + 119, 0.55, 0.45); assert e.s.order.status == "resting" and e.s.position is None
lv = [(0.55, 100), (0.58, 400)]
tick(e, T + 120, 0.55, 0.45, ul=lv)
p = e.s.position
vwap = (100 * 0.55 + 200 * 0.58) / 300
assert e.s.order.status == "cancelled" and "LIMIT_TIMEOUT" in ev(e)
assert p and p.side == Side.UP and p.shares == 300 and p.entry_type == "taker" and abs(p.entry_price - vwap) < 1e-9
fee = e.broker.taker_fee_amount(300, vwap)
assert abs(p.cost - (300 * vwap + fee)) < 1e-9 and abs(bal0 - e.capital.balance - p.cost) < 1e-9
print(f"4 ok: cancelled at 120s, taker 300sh @ {vwap:.4f} (depth-walked), fee ${fee:.3f} in cost")

# ---- 5. after the timeout, ask >= 0.60 -> keep checking every tick; buy first tick strictly below 0.60
e = mk(UP_CLOSES)
tick(e, T + 121, 0.70, 0.30); assert e.s.position is None and e.s.taker_watching
tick(e, T + 150, 0.60, 0.40); assert e.s.position is None            # exactly 0.60 is not below
tick(e, T + 200, 0.65, 0.35); assert e.s.position is None
tick(e, T + 280, 0.59, 0.41, ul=[(0.59, 1000)])
assert e.s.position and e.s.position.shares == 300 and e.s.position.entry_price == 0.59
assert ev(e).count("TAKER_WAIT") == 1
print("5 ok: waits until ask < 0.60 (checked every tick until close)")

# ---- 6. never below 0.60 -> skipped, nothing spent
e = mk(UP_CLOSES)
tick(e, T + 130, 0.72, 0.28); tick(e, T + 290, 0.80, 0.20)
e.finalize_window(Side.UP)
assert e.total_taker_skips == 1 and e.total_pnl == 0 and e.capital.balance == config.STARTING_CAPITAL
assert e.history[0]["result"].startswith("limit timed out")
print("6 ok: ask never < 0.60 -> no trade, balance untouched")

# ---- 7. fill beats timeout on the same tick
e = mk(UP_CLOSES)
tick(e, T + 120, 0.39, 0.61); assert e.s.position and e.s.position.entry_type == "maker" and e.total_limit_timeouts == 0
print("7 ok: fill checked before timeout")

# ---- 8. no pattern / no data / late join -> nothing placed
e = mk(FLAT_CLOSES); assert e.s.order is None and e.s.signal_status == "no_pattern" and e.total_no_pattern == 1
tick(e, T + 5, 0.30, 0.30); tick(e, T + 200, 0.50, 0.50); assert e.s.position is None
e = mk(signal=False); assert e.needs_signal(); e.set_signal_unavailable("boom"); assert e.s.signal_status == "no_data" and e.s.order is None
e = mk(late=True); assert not e.needs_signal() and e.s.signal_status == "late_join"
tick(e, T + 200, 0.30, 0.30); assert e.s.order is None and e.s.position is None
print("8 ok: no pattern / no data / late join -> no order")

# ---- 9. exits: TP on a maker entry, and forced close; exit works for taker entries too
e = mk(UP_CLOSES); tick(e, T + 5, 0.40, 0.60)
e.on_tick(0.99, 1.0, 0.01, 0.02, 200, now=T + 60, up_bid_levels=[(0.99, 1000)])
assert e.s.position is None and e.total_tp_fills == 1 and e.total_pnl > 0
assert abs(e.total_pnl - (200 * 0.99 - e.broker.taker_fee_amount(200, 0.99) - 80.0)) < 1e-9
e = mk(UP_CLOSES); tick(e, T + 5, 0.40, 0.60)
tick(e, T + 100, 0.30, 0.70, ub=0.20); e.finalize_window(Side.DOWN)
assert e.total_forced_closes == 1 and e.total_pnl < 0 and e.losses == 1
print("9 ok: TP exit (+) and forced close (-)")

# ---- 10. signal accuracy tracking + history rows + JSON snapshot
e = mk(UP_CLOSES); e.finalize_window(Side.UP)
e2 = mk(DOWN_CLOSES); e2.finalize_window(Side.UP)
assert e.signal_right == 1 and e2.signal_wrong == 1
h = e.history[0]; assert h["signal"] == "UP" and h["winner"] == "UP" and h["closes"] == [100.0, 99.0, 99.8, 100.2, 100.5]
e3 = mk(UP_CLOSES); tick(e3, T + 5, 0.40, 0.60)
snap = e3.snapshot(); json.dumps(snap)
assert snap["position"]["entry_type"] == "maker" and snap["signal"]["side"] == "UP" and snap["def"]["limit_price"] == 0.40
print("10 ok: signal accuracy + history + JSON snapshot")

# ---- 11. zero ask depth after the timeout -> no fabricated fill, retries
e = mk(UP_CLOSES); tick(e, T + 121, 0.55, 0.45, ul=[])
assert e.s.position is None and e.total_illiquid_skips == 1
tick(e, T + 122, 0.55, 0.45, ul=[(0.55, 1000)]); assert e.s.position and e.s.position.shares == 300
print("11 ok: empty book -> retries, no fake fill")
print("ALL PASSED")
