"""Orchestration with a fake Binance + fake Polymarket: candle fetch/retry, window rolling, late join, the full path."""
import os, sys, asyncio, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from app import config, state as S
from app.binance import MinuteCandle
from app.models import WindowMarket

T0 = 1_800_000_000
clock = {"now": float(T0 + 100)}
class FakeTime:
    @staticmethod
    def time(): return clock["now"]
S.time = FakeTime

books = {"u": {"bid": 0.44, "ask": 0.46, "asks": [(0.46, 1000)], "bids": [(0.44, 1000)]},
         "d": {"bid": 0.52, "ask": 0.54, "asks": [(0.54, 1000)], "bids": [(0.52, 1000)]}}
class FakeClient:
    async def get_active_window(self, now):
        o = int(now // 300) * 300
        return WindowMarket(f"btc-updown-5m-{o}", "c", "u", "d", float(o), float(o + 300)), None
    async def get_book_full(self, token):
        b = books[token]
        return {"best_bid": b["bid"], "best_ask": b["ask"], "bids": b["bids"], "asks": b["asks"]}
    async def close(self): pass

fetch_log = []
avail = {"minutes": 5}          # how many of the previous window's minute candles Binance has "closed"
prev_closes = {"c": [100.0, 99.0, 99.8, 100.2, 100.5]}
async def fake_fetch(client, open_ts):
    fetch_log.append(open_ts)
    return [MinuteCandle(open_time=open_ts + 60 * i, close=prev_closes["c"][i], close_time=open_ts + 60 * i + 59.999)
            for i in range(avail["minutes"])]
S.fetch_window_minutes = fake_fetch

async def run_to(bs, t_end, step=1.0):
    while clock["now"] < t_end:
        clock["now"] += step
        await bs._tick()

async def main():
    bs = S.BotState(); bs.client = FakeClient()
    # start 100s into a window -> late join, no trade in it
    await bs._tick()
    assert bs.engine.s.signal_status == "late_join" and bs.engine.s.order is None
    print("1 ok: joined mid-window -> skipped")

    # roll into the next window; only 4 of 5 minute candles closed at first -> waits, then trades
    avail["minutes"] = 4
    await run_to(bs, T0 + 300 + 2)
    assert bs.engine.s.signal_status == "pending" and "4/5" in (bs.signal_error or "")
    assert fetch_log and all(o == T0 for o in fetch_log), fetch_log        # reads the PREVIOUS window's minutes
    avail["minutes"] = 5
    await run_to(bs, T0 + 300 + 4)
    e = bs.engine
    assert e.s.signal_status == "armed" and e.s.order.side.value == "UP" and e.s.order.status == "resting"
    print("2 ok: waited for the 5th minute, then UP signal -> limit placed:", bs.broker.log[-1].note[:70])

    # UP ask stays 0.46 (> 0.40): limit unfilled; at +120s it is cancelled; ask 0.46 < 0.60 -> taker buys 300
    await run_to(bs, T0 + 300 + 118)
    assert e.s.order.status == "resting" and e.s.position is None
    await run_to(bs, T0 + 300 + 124)
    assert e.s.order.status == "cancelled" and e.s.position and e.s.position.shares == 300 and e.s.position.entry_type == "taker"
    print("3 ok: 2-minute timeout -> taker 300sh @", round(e.s.position.entry_price, 4))

    # next window: pattern absent -> no trade; position from previous window was force-closed at the roll
    prev_closes["c"] = [100.0, 100.0, 100.0, 100.0, 100.0]
    await run_to(bs, T0 + 600 + 5)
    assert e.total_forced_closes + e.total_tp_fills == 1 and e.s.signal_status == "no_pattern" and e.s.order is None
    assert e.history[0]["entry"] == "taker"
    print("4 ok: window rolled -> old position closed, flat candles -> no trade")

    # candles never arrive -> gives up after SIGNAL_MAX_WAIT_SECONDS
    avail["minutes"] = 0
    await run_to(bs, T0 + 900 + int(config.SIGNAL_MAX_WAIT_SECONDS) + 3)
    assert e.s.signal_status == "no_data" and e.total_no_data == 1
    print("5 ok: candles never arrive -> window skipped after", int(config.SIGNAL_MAX_WAIT_SECONDS), "s")

    # DOWN pattern in the following window -> limit on DOWN; DOWN ask falls to 0.40 -> maker fill
    avail["minutes"] = 5; prev_closes["c"] = [100.0, 101.0, 100.2, 99.8, 99.5]
    await run_to(bs, T0 + 1200 + 3)
    assert e.s.order.side.value == "DOWN"
    books["d"].update(ask=0.40, asks=[(0.40, 1000)])
    await run_to(bs, T0 + 1200 + 8)
    assert e.s.position and e.s.position.entry_type == "maker" and e.s.position.shares == 200 and e.s.position.side.value == "DOWN"
    print("6 ok: DOWN pattern -> limit on DOWN, filled @ 0.40 as maker")
    snap = bs.snapshot(); json.dumps(snap)
    assert snap["engine"]["history"] and snap["signal_error"] is None
    print("7 ok: dashboard snapshot serialises; history rows:", len(snap["engine"]["history"]))
asyncio.run(main())
print("STATE TESTS PASSED")
