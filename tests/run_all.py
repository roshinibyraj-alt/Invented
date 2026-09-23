"""Run every test module. No network -- httpx/fastapi are stubbed in _stubs.py."""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
mods = ["test_engine.py", "test_state.py"]
failed = []
for m in mods:
    print(f"\n=== {m} ===")
    r = subprocess.run([sys.executable, os.path.join(HERE, m)])
    if r.returncode != 0:
        failed.append(m)

print("\n" + ("ALL TESTS PASSED" if not failed else f"FAILED: {failed}"))
sys.exit(1 if failed else 0)
