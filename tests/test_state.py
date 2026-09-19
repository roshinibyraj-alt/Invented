import os
import sys, asyncio, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from synth import make
from app import mtf_engine as M, config, state as S, backtest as B
from app import marketdata as MD
from app.models import Side, WindowMarket

data, now = make(130, seed=5, plant=True)

async def main():
    # patch network
    async def fake_backtest_data(days): return data
    B.fetch_backtest_data = fake_backtest_data
    bs = S.BotState()
    # pin "now" for build_records: backtest uses time.time(); emulate by patching the module fn
    orig = M.build_records
    B.build_records = lambda d: orig(d, now=now)
    await bs._run_backtest()
    print("backtest status:", bs.backtest_status, "| log:", bs.broker.log[-1].note[:200])
    assert bs.backtest_status["windows"] == 2016 and bs.backtest_status["error"] is None

    # window at a matched time
    rec = next(r for r in bs.predictor.records if bs.predictor.predict(r.tokens, {}))
    t = rec.ts
    def frames_at(tt):
        import copy
        f={}
        for name, cs in data.items():
            f[name]=[copy.copy(c) for c in cs if c.open_time <= tt][-320:]
        return f
    calls={"n":0, "fail_first":True}
    async def fake_live(client=None):
        calls["n"]+=1
        if calls["fail_first"] and calls["n"]==1: raise RuntimeError("boom")
        return frames_at(t)
    S.fetch_live_frames = fake_live

    w = WindowMarket("w", None, "u", "d", float(t), float(t+300))
    bs.current_window = w
    bs.engine.reset_for_window(w)
    await bs._ensure_frames(time.time())
    assert bs.frames_error and "boom" in bs.frames_error and bs.engine.needs_frames()
    await bs._ensure_frames(time.time())                 # inside retry interval -> no new call
    assert calls["n"] == 1
    await bs._ensure_frames(time.time() + 4)             # after interval -> retries and succeeds
    assert bs.frames_error is None and not bs.engine.needs_frames(), bs.frames_error
    print("frames: retry after failure OK (calls:", calls["n"], ")")

    bs.engine.on_tick(0.4,0.5,0.4,0.5,300,now=float(t))
    assert bs.engine.s.entry_pending
    snap = bs.snapshot()
    import json; json.dumps(snap)
    print("state snapshot ok:", snap["backtest"], "| status:", snap["engine"]["status"])

    # rebuild scheduling: after 12 windows appended
    for k in range(config.MTF_REFRESH_EVERY_WINDOWS):
        bs.predictor.add_record(now + 300*(k+1), rec.tokens, True)
    assert bs.predictor.needs_rebuild()
    # re-mining is deferred until well after the window opens (never at rollover, when the +2s entry fires)
    bs.current_window = WindowMarket("w2", None, "u", "d", time.time(), time.time()+300)
    assert time.time() - bs.current_window.open_ts < S.REBUILD_AFTER_SECONDS
    t0=time.time(); await bs._rebuild_rules(); print(f"rebuild in thread ok ({time.time()-t0:.1f}s):", bs.broker.log[-1].note[:160])
    assert not bs.predictor.needs_rebuild() and bs.predictor.windows_since_rebuild == 0

    # failure path: backtest network failure
    async def bad(days): raise ConnectionError("blocked")
    B.fetch_backtest_data = bad
    bs2 = S.BotState(); await bs2._run_backtest()
    assert bs2.backtest_status["error"] and not bs2.predictor.rules
    print("backtest failure non-fatal:", bs2.backtest_status["error"])
asyncio.run(main())
print("STATE TESTS PASSED")
