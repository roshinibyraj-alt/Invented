"""python tests/run_all.py  -- runs every test file, no network needed."""
import os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
ok = True
for name in ("test_indicators.py", "test_engine.py", "test_state.py", "test_noise.py"):
    print(f"\n=== {name}")
    ok &= subprocess.call([sys.executable, os.path.join(here, name)]) == 0
print("\nALL TEST FILES PASSED" if ok else "\nFAILURES")
sys.exit(0 if ok else 1)
