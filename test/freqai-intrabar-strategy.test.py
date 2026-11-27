import importlib.util
import json
import math
import os
import sys
import tempfile
import types
import unittest
from datetime import datetime as RealDateTime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STRATEGY_PATH = ROOT / "freqai" / "strategies" / "FreqAIWindowStrategy.py"


class FakeDataFrame:
    empty = False

    def __init__(self, row):
        self.iloc = {-1: row}


class FakeClock:
    now_ms = 0

    @classmethod
    def now(cls, tz=None):
        return RealDateTime.fromtimestamp(cls.now_ms / 1000, tz=tz or timezone.utc)


def import_strategy():
    numpy = types.ModuleType("numpy")
    numpy.nan = math.nan
    numpy.isfinite = math.isfinite
    pandas = types.ModuleType("pandas")
    pandas.DataFrame = FakeDataFrame
    pandas.to_datetime = lambda value, utc=True: value
    freqtrade = types.ModuleType("freqtrade")
    strategy_module = types.ModuleType("freqtrade.strategy")
    strategy_module.IStrategy = type("IStrategy", (), {})
    sys.modules.update({
        "numpy": numpy,
        "pandas": pandas,
        "freqtrade": freqtrade,
        "freqtrade.strategy": strategy_module,
    })
    spec = importlib.util.spec_from_file_location("freqai_intrabar_strategy", STRATEGY_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.datetime = FakeClock
    return module.FreqAIWindowStrategy


class IntrabarPredictionExportTest(unittest.TestCase):
    def test_rewrites_same_minute_score_each_loop_and_marks_candle_state(self):
        strategy_class = import_strategy()
        strategy = strategy_class.__new__(strategy_class)
        start = 1_800_000_060_000
        row = {
            "date": RealDateTime.fromtimestamp(start / 1000, timezone.utc),
            "do_predict": 1,
            "UP": .61,
            "DOWN": .39,
        }
        with tempfile.TemporaryDirectory() as data_dir:
            prediction_path = str(Path(data_dir) / "latest.json")
            old_path = os.environ.get("FREQAI_PREDICTION_FILE")
            os.environ["FREQAI_PREDICTION_FILE"] = prediction_path
            try:
                FakeClock.now_ms = start + 25_000
                strategy._export_latest_prediction(FakeDataFrame(row))
                first = json.loads(Path(prediction_path).read_text())
                self.assertTrue(first["provisional"])
                self.assertEqual(first["pUp"], .61)
                self.assertEqual(first["observedAt"], start + 25_000)
                self.assertEqual(first["candleCloseAt"], start + 60_000)

                row["UP"], row["DOWN"] = .73, .27
                FakeClock.now_ms += 5_000
                strategy._export_latest_prediction(FakeDataFrame(row))
                second = json.loads(Path(prediction_path).read_text())
                self.assertTrue(second["provisional"])
                self.assertEqual(second["candleStart"], first["candleStart"])
                self.assertEqual(second["pUp"], .73)
                self.assertEqual(second["observedAt"], first["observedAt"] + 5_000)
                self.assertNotEqual(second["writtenAt"], first["writtenAt"])

                FakeClock.now_ms = start + 61_000
                strategy._export_latest_prediction(FakeDataFrame(row))
                closed = json.loads(Path(prediction_path).read_text())
                self.assertFalse(closed["provisional"])
                self.assertEqual(closed["candleStart"], start)
            finally:
                if old_path is None:
                    os.environ.pop("FREQAI_PREDICTION_FILE", None)
                else:
                    os.environ["FREQAI_PREDICTION_FILE"] = old_path

    def test_strategy_runs_indicators_each_bot_loop_without_changing_labels(self):
        strategy_class = import_strategy()
        self.assertFalse(strategy_class.process_only_new_candles)
        self.assertEqual(strategy_class.timeframe, "1m")
        source = STRATEGY_PATH.read_text()
        self.assertIn('dataframe["&-window-direction"] = labels', source)
        self.assertNotIn("_last_exported_candle", source)


if __name__ == "__main__":
    unittest.main()
