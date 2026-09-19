"""On pure random data the noise-calibrated miner must (almost) never invent situations,
and on data with a planted pattern it must find it."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from synth import make
from app import mtf_engine as M

total_noise_rules = 0
for seed in (3, 4, 5, 6):
    data, now = make(130, seed=seed, plant=False)
    recs = M.build_records(data, now=now, days=7)
    p = M.MTFPredictor(); p.load_records(recs)
    total_noise_rules += len(p.rules)
    oos = p.summary["out_of_sample"]
    assert oos["rules"] <= 1, oos
print(f"noise ok: {total_noise_rules} situations kept across 4 pure-noise weeks (chance-level false positives only)")

found = 0
for seed in (3, 5, 7):
    data, now = make(130, seed=seed, plant=True)
    recs = M.build_records(data, now=now, days=7)
    p = M.MTFPredictor(); p.load_records(recs)
    if any({"15m candle RED", "T 08-12h UTC"} <= r.token_set and r.direction == "UP" for r in p.rules):
        found += 1
assert found >= 2, found
print(f"planted pattern (15m candle RED + T 08-12h UTC -> UP) recovered in {found}/3 weeks")
print("NOISE TESTS PASSED")
