"""Every window must get a call + reason (tiered fallback), the tier must be honest,
and strict mode must still be able to refuse to trade."""
import os, sys, random
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from synth import make
from app import mtf_engine as M, config
from app.models import Side

# ---- 1. pure-noise week: nothing validates, yet EVERY window still gets a call with a reason
data, now = make(130, seed=4, plant=False)
recs = M.build_records(data, now=now, days=7)
p = M.MTFPredictor(); p.load_records(recs)
assert len(p.rules) <= 1
none = 0; tiers = {}
for r in recs:
    pr = p.predict(r.tokens, {})
    if pr is None: none += 1; continue
    tiers[pr.tier] = tiers.get(pr.tier, 0) + 1
    assert pr.reasons and 0.5 <= pr.confidence <= 1.0 and pr.side in (Side.UP, Side.DOWN)
    assert pr.tier in M.TIER_LABELS
assert none == 0, none
print(f"1 ok: noise week -> {len(recs)}/{len(recs)} windows got a call; tiers {tiers}; validated rules={len(p.rules)}")
oos = p.summary["out_of_sample"]
assert oos["coverage"] == 1.0 and set(oos["by_tier"]) <= set(M.TIER_LABELS)
print(f"   honest OOS on noise: accuracy {oos['accuracy']} on {oos['predicted']} windows (z={oos['z']}), by tier {oos['by_tier']}")

# ---- 2. strict mode: validated-only -> no call when nothing validated matches
config.MTF_ALLOW_FALLBACK = False
strict_none = sum(1 for r in recs if p.predict(r.tokens, {}) is None)
assert strict_none >= len(recs) - 60, strict_none
config.MTF_ALLOW_FALLBACK = True
print(f"2 ok: strict mode refuses {strict_none}/{len(recs)} noise windows")

# ---- 3. baseline direction sanity on hand-made data
rnd = random.Random(1)
recs2 = []
for i in range(600):
    x = rnd.random() < 0.5                       # token "X" present
    up = (rnd.random() < 0.8) if x else (rnd.random() < 0.2)   # X -> UP 80%, not-X -> UP 20%
    toks = {"X present" if x else "X absent", "filler A", "T 00-04h UTC"}
    recs2.append(M.WindowRecord(ts=1_700_000_000 + i * 300, tokens=frozenset(toks), up=up))
b = M.Baseline(recs2)
assert b.vote(frozenset({"X present", "filler A"}))["p_up"] > 0.6
assert b.vote(frozenset({"X absent", "filler A"}))["p_up"] < 0.4
# a drifting (60% up) week with uninformative tokens must NOT make the baseline always say UP
recs3 = [M.WindowRecord(ts=1_700_000_000 + i * 300, tokens=frozenset({"noise A", "noise B"}), up=(rnd.random() < 0.6)) for i in range(800)]
b3 = M.Baseline(recs3)
pu = b3.vote(frozenset({"noise A", "noise B"}))["p_up"]
assert 0.45 < pu < 0.55, pu
print(f"3 ok: baseline follows informative readings (UP {b.vote(frozenset({'X present'}))['p_up']:.2f} / DOWN {b.vote(frozenset({'X absent'}))['p_up']:.2f}) and ignores base-rate drift ({pu:.2f})")

# ---- 4. explanation text names the tier; status is JSON-safe with per-tier numbers
import json
pr = p.predict(recs[10].tokens, {})
assert pr.tier.upper() in p.explain(pr)
st = p.status(); json.dumps(st); assert "top_candidates" in st and st["fallback"] is True
print("4 ok:", p.explain(pr)[:170])

# ---- 5. planted-signal week still resolves to the VALIDATED tier for its matching windows
data, now = make(130, seed=3, plant=True)
recs = M.build_records(data, now=now, days=7)
p = M.MTFPredictor(); p.load_records(recs)
tv = sum(1 for r in recs if (p.predict(r.tokens, {}) or pr).tier == "validated")
assert p.rules and tv > 20, (len(p.rules), tv)
print(f"5 ok: planted week -> {len(p.rules)} validated situations, {tv} windows called at the validated tier")
print("TIER TESTS PASSED")
