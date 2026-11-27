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
    def __init__(self, rows, columns=None):
        if isinstance(rows, dict):
            rows = [rows]
        self.rows = [dict(row) for row in rows]
        self.columns = list(columns or (self.rows[0].keys() if self.rows else []))
        self.iloc = FakeIndexer(self, "iloc")
        self.loc = FakeIndexer(self, "loc")

    @property
    def empty(self):
        return not self.rows

    @property
    def index(self):
        return list(range(len(self.rows)))


class FakeIndexer:
    def __init__(self, frame, kind):
        self.frame = frame
        self.kind = kind

    def __getitem__(self, key):
        if self.kind == "iloc":
            return dict(self.frame.rows[key])
        index, column = key
        return self.frame.rows[index][column]

    def __setitem__(self, key, value):
        index, column = key
        self.frame.rows[index][column] = value


class FakeDataProvider:
    def __init__(self, dataframe):
        self.dataframe = dataframe

    def current_whitelist(self):
        return ["BTC/USDT"]

    def get_pair_dataframe(self, pair, timeframe):
        return FakeDataFrame(self.dataframe.rows, self.dataframe.columns)


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
    pandas.to_datetime = lambda value, utc=True, unit=None: (
        RealDateTime.fromtimestamp(float(value) / 1000, tz=timezone.utc)
        if unit == "ms" else value
    )
    pandas.concat = lambda frames, ignore_index=True: FakeDataFrame(
        [row for frame in frames for row in frame.rows]
    )
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
                strategy._intrabar_candle_start = start
                strategy._intrabar_observed_at = FakeClock.now_ms
                strategy._export_latest_prediction(FakeDataFrame(row))
                first = json.loads(Path(prediction_path).read_text())
                self.assertTrue(first["provisional"])
                self.assertEqual(first["pUp"], .61)
                self.assertEqual(first["observedAt"], start + 25_000)
                self.assertEqual(first["candleCloseAt"], start + 60_000)

                row["UP"], row["DOWN"] = .73, .27
                FakeClock.now_ms += 5_000
                strategy._intrabar_observed_at = FakeClock.now_ms
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

    def test_uses_supported_freqai_candle_mode_without_changing_labels(self):
        strategy_class = import_strategy()
        self.assertTrue(strategy_class.process_only_new_candles)
        self.assertEqual(strategy_class.timeframe, "1m")
        source = STRATEGY_PATH.read_text()
        self.assertIn('dataframe["&-window-direction"] = labels', source)
        self.assertNotIn("_last_exported_candle", source)
        self.assertIn("scored = self.freqai.start(dataframe, {\"pair\": pair}, self)", source)
        populate = source.split("def populate_indicators", 1)[1].split("def bot_loop_start", 1)[0]
        self.assertNotIn("_inject_intrabar_candle(dataframe)", populate)

    def test_loop_hook_calls_freqai_again_for_each_fresh_live_minute(self):
        strategy_class = import_strategy()
        strategy = strategy_class.__new__(strategy_class)
        start = 1_800_000_060_000
        now = start + 25_000
        dataframe = FakeDataFrame({
            "date": RealDateTime.fromtimestamp((start - 60_000) / 1000, timezone.utc),
            "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 5,
            "do_predict": 1, "UP": .61, "DOWN": .39,
        })
        strategy.dp = FakeDataProvider(dataframe)
        calls = []
        def score(frame, metadata, _strategy):
            calls.append(metadata["pair"])
            return frame
        strategy.freqai = types.SimpleNamespace(start=score)
        with tempfile.TemporaryDirectory() as data_dir:
            candle_path = Path(data_dir) / "intrabar.json"
            prediction_path = Path(data_dir) / "prediction.json"
            old_candle_path = os.environ.get("FREQAI_INTRABAR_CANDLE_FILE")
            old_prediction_path = os.environ.get("FREQAI_PREDICTION_FILE")
            os.environ["FREQAI_INTRABAR_CANDLE_FILE"] = str(candle_path)
            os.environ["FREQAI_PREDICTION_FILE"] = str(prediction_path)
            try:
                FakeClock.now_ms = now
                for step in (0, 5_000):
                    candle_path.write_text(json.dumps({
                        "start": start, "open": 100.5, "high": 101 + step / 100_000,
                        "low": 100.1, "close": 101 + step / 100_000, "volume": 7.5,
                        "observedAt": now + step,
                    }))
                    FakeClock.now_ms = now + step
                    strategy.bot_loop_start(FakeClock.now())
                result = json.loads(prediction_path.read_text())
                self.assertEqual(calls, ["BTC/USDT", "BTC/USDT"])
                self.assertTrue(result["provisional"])
                self.assertEqual(result["observedAt"], now + 5_000)
            finally:
                if old_candle_path is None:
                    os.environ.pop("FREQAI_INTRABAR_CANDLE_FILE", None)
                else:
                    os.environ["FREQAI_INTRABAR_CANDLE_FILE"] = old_candle_path
                if old_prediction_path is None:
                    os.environ.pop("FREQAI_PREDICTION_FILE", None)
                else:
                    os.environ["FREQAI_PREDICTION_FILE"] = old_prediction_path

    def test_injects_only_the_fresh_current_binance_minute_candle(self):
        strategy_class = import_strategy()
        strategy = strategy_class.__new__(strategy_class)
        start = 1_800_000_060_000
        now = start + 25_000
        old = {"date": RealDateTime.fromtimestamp((start - 60_000) / 1000, timezone.utc),
               "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 5}
        candle = {"start": start, "open": 100.5, "high": 101.2, "low": 100.1,
                  "close": 101, "volume": 7.5, "observedAt": now}
        with tempfile.TemporaryDirectory() as data_dir:
            candle_path = str(Path(data_dir) / "intrabar.json")
            Path(candle_path).write_text(json.dumps(candle))
            previous_path = os.environ.get("FREQAI_INTRABAR_CANDLE_FILE")
            os.environ["FREQAI_INTRABAR_CANDLE_FILE"] = candle_path
            try:
                FakeClock.now_ms = now
                frame = FakeDataFrame(old)
                updated = strategy._inject_intrabar_candle(frame)
                live = updated.iloc[-1]
                self.assertEqual(len(updated.rows), 2)
                self.assertEqual(live["date"].timestamp() * 1000, start)
                self.assertEqual([live[k] for k in ("open", "high", "low", "close", "volume")],
                                 [100.5, 101.2, 100.1, 101, 7.5])
                self.assertEqual(strategy._intrabar_candle_start, start)
                self.assertEqual(strategy._intrabar_observed_at, now)

                late_timestamp = FakeDataFrame({
                    **old, "date": RealDateTime.fromtimestamp((start + 3828) / 1000, timezone.utc),
                })
                aligned = strategy._inject_intrabar_candle(late_timestamp)
                self.assertEqual(len(aligned.rows), 1)
                self.assertEqual(aligned.iloc[-1]["date"].timestamp() * 1000, start)

                candle["observedAt"] = now - 20_000
                Path(candle_path).write_text(json.dumps(candle))
                stale = strategy._inject_intrabar_candle(FakeDataFrame(old))
                self.assertEqual(len(stale.rows), 1)
                self.assertIsNone(strategy._intrabar_candle_start)
            finally:
                if previous_path is None:
                    os.environ.pop("FREQAI_INTRABAR_CANDLE_FILE", None)
                else:
                    os.environ["FREQAI_INTRABAR_CANDLE_FILE"] = previous_path


if __name__ == "__main__":
    unittest.main()
