import os, sys, json, asyncio
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from app import config
from app.models import Side, WindowMarket
from app.state import BotState

T0 = 1_800_000_000.0    # aligned to a 300s boundary

class FakeClient:
    """Two consecutive 5-minute windows (w1: T0..T0+300, w2: T0+300..T0+600), each with a
    controllable order book. w1 resolves UP (up bid hits 0.95+ in its last second)."""
    def __init__(self):
        self.books = {
            "u1": {"bid": 0.50, "ask": 0.52, "bids": [(0.50, 1000)], "asks": [(0.52, 1000)]},
            "d1": {"bid": 0.48, "ask": 0.50, "bids": [(0.48, 1000)], "asks": [(0.50, 1000)]},
            "u2": {"bid": 0.45, "ask": 0.47, "bids": [(0.45, 1000)], "asks": [(0.47, 1000)]},
            "d2": {"bid": 0.53, "ask": 0.55, "bids": [(0.53, 1000)], "asks": [(0.55, 1000)]},
        }
        self.book_calls = []

    async def get_active_window(self, now):
        import math
        ot = T0 + 300 * math.floor((now - T0) / 300)
        tag = "1" if ot == T0 else "2"           # window 3+ reuses window 2's (flat) books
        return WindowMarket(f"btc-updown-5m-{int(ot)}", "c", f"u{tag}", f"d{tag}",
                            ot, ot + config.WINDOW_SECONDS), None

    async def get_book_full(self, token_id):
        self.book_calls.append(token_id)
        b = self.books.get(token_id)
        if b is None:
            return None
        return {"best_bid": b["bid"], "best_ask": b["ask"], "bids": b["bids"], "asks": b["asks"]}

    async def close(self):
        pass


async def main():
    bs = BotState()
    bs.client = FakeClient()
    clock = {"now": T0 + 1}

    async def run_to(target):
        while clock["now"] <= target:
            await bs._tick()
            clock["now"] += config.CLOSE_PHASE_POLL_SECONDS if (bs.current_window and
                bs.current_window.close_ts - clock["now"] <= config.CLOSE_PHASE_SECONDS) else 1.0
        return bs.snapshot()

    orig_time = __import__("time").time
    import time as time_mod
    time_mod.time = lambda: clock["now"]

    # ---- window 1: first window seen -> watched only, no signal, no trade -----------------
    await run_to(T0 + 2)
    assert bs.current_window.slug == "btc-updown-5m-1800000000"
    assert bs.engine.s.plan == "no_signal" and bs.engine.s.position is None
    print("1 ok: first window observed -> no signal, no trade")

    # ---- last second of window 1: UP bid crosses 0.95 -> captured as the winner read --------
    bs.client.books["u1"]["bid"] = 0.97
    bs.client.books["u1"]["bids"] = [(0.97, 1000)]
    await run_to(T0 + 300 - 0.5)
    up_bid, *_ = bs._last_second_prices
    assert up_bid == 0.97
    print("2 ok: last-second CLOB read captured UP at 0.97")

    # ---- roll into window 2: follows UP (window 1's winner). Window 2's UP ask sits at 0.47 --
    # the whole time: above the 0.40 phase-1 limit (never fills there), but within the 0.50
    # phase-2 cap, so it fires as a market buy once the 30s limit timeout has passed.
    await run_to(T0 + 300 + 31)
    e = bs.engine
    assert e.prev["winner"] == Side.UP and e.prev["up"] == 0.97
    assert e.s.side == Side.UP and e.s.position
    assert abs(e.s.position.entry_price - 0.47) < 1e-9      # window 2's UP ask
    assert abs(e.s.position.cost - 500) < e.s.position.cost * 0.10  # ~$500 notional + a small taker fee
    assert bs.current_window.slug == "btc-updown-5m-1800000300"
    print(f"3 ok: window 2 follows UP (won window 1), market-bought {e.s.position.shares:.2f}sh @ 0.47 after the 30s limit timeout")

    # ---- neither side reaches 0.95 by the close -> undecided, no signal for window 3 --------
    bs.client.books["u2"].update(bid=0.55, bids=[(0.55, 1000)])
    bs.client.books["d2"].update(bid=0.45, bids=[(0.45, 1000)])
    await run_to(T0 + 600 + 1)
    assert e.prev["winner"] is None and e.total_undecided == 1
    assert e.s.plan == "no_signal" and "undecided" in e.s.plan_note
    print("4 ok: neither side hit 0.95 -> undecided, window 3 has no signal")

    # ---- books fetched in parallel each tick (both tokens queried) --------------------------
    assert bs.client.book_calls.count("u2") > 0 and bs.client.book_calls.count("d2") > 0
    print("5 ok: both sides' books fetched every tick")

    # ---- dashboard snapshot is JSON-serialisable end to end ----------------------------------
    snap = bs.snapshot(); json.dumps(snap)
    assert snap["engine"]["history"] and snap["window"]["slug"] == bs.current_window.slug
    assert snap["engine"]["sizing"]["base"] in (400, 500)
    print("6 ok: dashboard snapshot serialises; history rows:", len(snap["engine"]["history"]))

    time_mod.time = orig_time

asyncio.run(main())
print("STATE TESTS PASSED")
