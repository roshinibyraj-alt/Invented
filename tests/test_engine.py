import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from app import config
from app.engine import Engine
from app.models import Side, WindowMarket
from app.paper_broker import PaperBroker

T = 1_800_000_000
LP = config.LIMIT_ENTRY_PRICE            # 0.40
TO = config.LIMIT_ENTRY_TIMEOUT_SECONDS  # 30
CAP = config.MARKET_ENTRY_CAP            # 0.50
BASE = config.BASE_DOLLARS               # 500
STEP = config.DOLLARS_STEP               # 100

def mk(prev=None):
    """prev: None (no signal yet) or a Side (previous window's winner)."""
    e = Engine(PaperBroker())
    if prev is not None:
        e.prev = {"slug": "w0", "open_ts": T - 300, "winner": prev, "up": 0.97, "down": 0.03, "age": 0.1}
    w = WindowMarket("w1", None, "u", "d", float(T), float(T + 300))
    e.reset_for_window(w, now=float(T))
    return e

def tick(e, ts, ua, da, ul=None, dl=None, ub=0.30, db=0.30):
    e.on_tick(ub, ua, db, da, now=ts, up_bid_levels=[(ub, 1000)], down_bid_levels=[(db, 1000)],
              up_ask_levels=ul, down_ask_levels=dl)

def ev(e): return [x.event for x in e.broker.log]
def close(e, winner=None, up=None, down=None): e.finalize_window({"winner": winner, "up": up, "down": down, "age": 0.1})

# ---- 0. sanity on the new config shape
assert LP == 0.40 and TO == 30 and CAP == 0.50 and BASE == 500 and STEP == 100
print(f"0 ok: LIMIT_ENTRY_PRICE={LP}, LIMIT_ENTRY_TIMEOUT_SECONDS={TO}, MARKET_ENTRY_CAP={CAP}, BASE_DOLLARS={BASE}, DOLLARS_STEP={STEP}")

# ---- 1. no previous window -> no signal, nothing fires
e = mk(prev=None); assert e.s.plan == "no_signal" and e.snapshot()["status"] == "no_signal"
tick(e, T + 5, 0.45, 0.55); assert e.s.position is None
print("1 ok: no previous window -> no signal, no trade")

# ---- 2. UP won previous window -> follow UP, $500, armed in the "limit" phase
e = mk(prev=Side.UP); assert e.s.plan == "trading" and e.s.side == Side.UP and e.s.dollars == 500
en = e.snapshot()["entry"]; assert en["dollars"] == 500 and en["phase"] == "limit"
tick(e, T + 1, 0.45, 0.55); tick(e, T + 10, 0.45, 0.55); assert e.s.position is None  # ask never reaches 0.40
print("2 ok: UP won last window -> armed $500 UP, resting limit, no fill above 0.40")

# ---- 3. phase 1: ask reaches LIMIT_ENTRY_PRICE within the timeout -> maker fill, no fee
e = mk(prev=Side.UP); tick(e, T + 5, LP, 0.60)
p = e.s.position
assert p and p.side == Side.UP and abs(p.entry_price - LP) < 1e-9
assert abs(p.shares - 500 / LP) < 1e-9 and abs(p.cost - 500) < 1e-9  # no fee on the maker fill
assert e.total_entries == 1 and e.snapshot()["status"] == "open" and e.snapshot()["entry"] is None
assert "LIMIT_FILLED" in ev(e)
print(f"3 ok: phase 1 limit filled @ {LP:.2f}, {p.shares:.2f}sh, no fee, cost ${p.cost:.2f}")

# ---- 4. phase 1 never reaches 0.40 -> limit cancelled at 30s, phase 2 begins
e = mk(prev=Side.UP)
tick(e, T + 5, 0.75, 0.25); tick(e, T + 29, 0.75, 0.25)
assert e.s.position is None and "LIMIT_CANCELLED" not in ev(e)
tick(e, T + TO + 0.1, 0.75, 0.25)   # still above the 0.40 limit AND above the 0.50 cap
assert "LIMIT_CANCELLED" in ev(e) and e.s.position is None  # cancelled, but 0.75 > cap so no fire yet either
print("4 ok: unfilled limit cancelled after the timeout")

# ---- 5. phase 2: ask already at/below the cap -> immediate market buy, depth-walked, taker fee
e = mk(prev=Side.UP)
tick(e, T + TO + 1, 0.45, 0.55, ul=[(0.45, 1000)])   # single deep level -> fills entirely at 0.45
p = e.s.position
assert p and abs(p.entry_price - 0.45) < 1e-9 and abs(p.shares - 500 / 0.45) < 1e-9
fee = e.broker.taker_fee_amount(p.shares, 0.45)
assert abs(p.cost - (500 + fee)) < 1e-9 and "MARKET_ENTRY" in ev(e)
print(f"5 ok: phase 2 market buy @ 0.45 (<= {CAP} cap), {p.shares:.2f}sh, fee ${fee:.4f}")

# ---- 6. phase 2: price above the cap -> waits (logs once), buys once it comes back down
e = mk(prev=Side.UP)
tick(e, T + TO + 1, 0.75, 0.25, ul=[(0.75, 1000)])
tick(e, T + TO + 20, 0.60, 0.40, ul=[(0.60, 1000)])
assert e.s.position is None and ev(e).count("WAITING_FOR_PRICE") == 1     # logs once, not every tick
tick(e, T + TO + 40, 0.48, 0.52, ul=[(0.48, 1000)])
assert e.s.position and abs(e.s.position.entry_price - 0.48) < 1e-9
print("6 ok: price above cap -> waits, buys the moment it drops back to <= cap")

# ---- 7. boundary: exactly the cap fills; deep in the money also fills
for ask in (0.50, 0.10):
    e = mk(prev=Side.UP); tick(e, T + TO + 1, ask, 1 - ask, ul=[(ask, 1000)])
    assert e.s.position and abs(e.s.position.entry_price - ask) < 1e-9
print("7 ok: fires at exactly the 0.50 cap and at any price below it")

# ---- 8. DOWN won previous window -> follows DOWN (either phase)
e = mk(prev=Side.DOWN); tick(e, T + 5, 0.30, LP)
assert e.s.position and e.s.position.side == Side.DOWN and abs(e.s.position.entry_price - LP) < 1e-9
print("8 ok: DOWN won -> follows DOWN")

# ---- 9. one entry per window: no second buy
e = mk(prev=Side.UP); tick(e, T + 5, LP, 0.60); tick(e, T + 100, 0.50, 0.50); tick(e, T + 200, 0.30, 0.70)
assert e.total_entries == 1
print("9 ok: one entry per window")

# ---- 10. no ask / empty book in phase 2: nothing invented, retries, logs once, buys when it returns
e = mk(prev=Side.UP)
tick(e, T + TO + 1, None, 0.5, ul=[]); tick(e, T + TO + 2, None, 0.5, ul=[]); tick(e, T + TO + 3, 0.48, 0.5, ul=[])
assert e.s.position is None and e.total_illiquid_skips >= 1 and ev(e).count("NO_LIQUIDITY") == 1
tick(e, T + TO + 4, 0.48, 0.52, ul=[(0.48, 1000)])
assert e.s.position and abs(e.s.position.entry_price - 0.48) < 1e-9
print("10 ok: empty book in phase 2 -> retries, no fake fill, buys when depth returns")

# ---- 11. never fills (never <=0.40, never <=0.50) -> ENTRY_MISSED at close, base unchanged
e = mk(prev=Side.UP); tick(e, T + 5, 0.90, 0.10); tick(e, T + TO + 5, 0.90, 0.10, ul=[(0.90, 1000)]); tick(e, T + 290, 0.90, 0.10)
close(e, winner=Side.UP, up=0.97, down=0.03)
assert e.total_no_fills == 1 and "ENTRY_MISSED" in ev(e) and e.capital.balance == config.STARTING_CAPITAL
assert e.base == 500 and e.history[0]["result"] == "no fill"
print("11 ok: price never reaches either threshold -> no trade, base untouched, balance untouched")

# ---- 12. no entry at/after the window close
e = mk(prev=Side.UP); tick(e, T + 300, LP, 0.60); assert e.s.position is None
print("12 ok: nothing fires at/after the window close")

# ---- 13. settlement: win pays $1/share, loss pays $0 -- and the dollar ladder moves
e = mk(prev=Side.UP); tick(e, T + 5, LP, 0.60); cost = e.s.position.cost; shares = e.s.position.shares
close(e, winner=Side.UP, up=0.97, down=0.03)
assert e.wins == 1 and e.base == 400 and abs(e.total_pnl - (shares * 1.0 - cost)) < 1e-9
e2 = mk(prev=Side.DOWN); tick(e2, T + 5, 0.60, LP); cost2 = e2.s.position.cost
close(e2, winner=Side.UP, up=0.97, down=0.03)          # followed DOWN, UP won -> loss
assert e2.losses == 1 and e2.base == 500 and abs(e2.total_pnl - (0 - cost2)) < 1e-9
print("13 ok: win -> $1/share, base -$100; loss -> $0/share, base reset to $500")

# ---- 14. undecided close (neither side 0.95+): no ladder move, open position exits at last bid
e = mk(prev=Side.UP); tick(e, T + 5, LP, 0.60)
tick(e, T + 250, 0.55, 0.60, ub=0.55)
close(e, winner=None, up=0.55, down=0.45)
assert e.total_undecided == 1 and e.wins == 0 and e.losses == 0 and e.base == 500     # undecided doesn't move the ladder
assert "no signal" not in ev(e) and e.history[0]["winner"] is None
print("14 ok: undecided window -> position exits at last bid, ladder untouched")

def next_window(prev_open_ts):
    ot = prev_open_ts + 300
    return WindowMarket(f"w{int(ot)}", None, "u", "d", float(ot), float(ot + 300)), ot

# ---- 15. the ladder: $500 -> $400 -> $300 -> $200 -> $100 -> $0, then same-side signals are skipped
e = mk(prev=Side.UP); ot = T
for expected in (500, 400, 300, 200, 100):
    assert e.s.plan == "trading" and e.s.dollars == expected, (e.s.dollars, expected)
    tick(e, ot + 5, LP, 0.60)
    close(e, winner=Side.UP, up=0.97, down=0.03)
    w, ot = next_window(ot)
    e.reset_for_window(w, now=float(ot))
assert e.base == 0 and e.floor_side == Side.UP
assert e.s.plan == "floor_skip" and e.s.plan_note.startswith("base is 0")
tick(e, ot + 5, LP, 0.60); tick(e, ot + 200, 0.30, 0.70)
assert e.s.position is None and e.total_floor_skips == 1
close(e, winner=Side.UP, up=0.97, down=0.03)
assert e.base == 0                                    # still skipped -> ladder doesn't move
print("15 ok: $500->$400->$300->$200->$100->$0, then UP signals skipped at the floor")

# ---- 16. first opposite-direction signal after the floor: trades $500, restarts the base
w, ot = next_window(ot); e.reset_for_window(w, now=float(ot))
e.prev = {"slug": "wx", "open_ts": ot, "winner": Side.DOWN, "up": 0.03, "down": 0.97, "age": 0.1}
w, ot = next_window(ot); e.reset_for_window(w, now=float(ot))
assert e.s.plan == "trading" and e.s.side == Side.DOWN and e.s.dollars == 500
assert "BASE_RESTART" in ev(e)
tick(e, ot + 5, 0.60, LP)
assert e.s.position and abs(e.s.position.cost - 500) < 1e-9
print("16 ok: opposite signal after the floor -> $500, base restarted")

# ---- 17. any loss (even mid-ladder) resets the base to $500
e = mk(prev=Side.UP); ot = T; tick(e, ot + 5, LP, 0.60)
close(e, winner=Side.UP, up=0.97, down=0.03); assert e.base == 400          # one win
w, ot = next_window(ot); e.reset_for_window(w, now=float(ot))
tick(e, ot + 5, LP, 0.60)
close(e, winner=Side.DOWN, up=0.03, down=0.97)                              # followed UP, DOWN won -> loss
assert e.base == 500 and e.floor_side is None
print("17 ok: a loss mid-ladder resets the base to $500")

# ---- 18. no signal / floor-skip / no-fill windows never move the base
e = mk(prev=None); tick(e, T + 5, LP, 0.60); close(e, winner=Side.UP, up=0.97, down=0.03)
assert e.base == 500 and e.wins == 0 and e.losses == 0
print("18 ok: no-signal window doesn't move the base")

# ---- 19. missed a window (gap) -> no signal even though prev exists
e = Engine(PaperBroker())
e.prev = {"slug": "w0", "open_ts": T - 900, "winner": Side.UP, "up": 0.97, "down": 0.03, "age": 0.1}  # 3 windows back
w = WindowMarket("w1", None, "u", "d", float(T), float(T + 300))
e.reset_for_window(w, now=float(T))
assert e.s.plan == "no_signal" and "missed a window" in e.s.plan_note
print("19 ok: gap in windows -> no signal")

# ---- 20. JSON snapshot + history rows
e = mk(prev=Side.UP); tick(e, T + 5, LP, 0.60)
snap = e.snapshot(); json.dumps(snap)
assert snap["position"]["side"] == "UP"
assert snap["def"] == {"limit_price": 0.40, "limit_timeout_s": 30, "market_cap": 0.50, "base_dollars": 500, "step": 100, "win_price": 0.95}
close(e, winner=Side.UP, up=0.97, down=0.03)
h = e.history[0]; assert h["followed"] == "UP" and h["winner"] == "UP" and h["base_after"] == 400 and h["shares"] is not None
print("20 ok: JSON snapshot + history row")
print("ALL PASSED")
