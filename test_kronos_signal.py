import unittest
from collections import deque

import pandas as pd

from app.kronos_signal import KronosSignal
from app.models import Side


class FakeCandleFeed:
    def __init__(self):
        start = 1_700_000_000
        self.candles = deque(
            (
                {
                    "timestamps": start + i * 60,
                    "open": 100.0 + i * 0.01,
                    "high": 100.05 + i * 0.01,
                    "low": 99.95 + i * 0.01,
                    "close": 100.0 + i * 0.01,
                    "volume": 1.0,
                }
                for i in range(60)
            ),
            maxlen=60,
        )

    def is_warm(self):
        return True


class DatetimeIndexAwarePredictor:
    def __init__(self):
        self.y_timestamp = None

    def predict(self, *, df, x_timestamp, y_timestamp, pred_len, **kwargs):
        self.y_timestamp = y_timestamp
        # Mirrors model/kronos.py:calc_time_stamps, which accesses .dt.
        _ = y_timestamp.dt.minute
        forecast_close = float(df["close"].iloc[-1]) + 1.0
        return pd.DataFrame({"close": [forecast_close] * pred_len})


class KronosSignalTimestampTest(unittest.TestCase):
    def test_get_signal_passes_series_for_future_timestamps(self):
        signal = KronosSignal(FakeCandleFeed())
        predictor = DatetimeIndexAwarePredictor()
        signal._predictor = predictor

        side, confidence = signal.get_signal(now=1_000.0)

        self.assertIsInstance(predictor.y_timestamp, pd.Series)
        self.assertEqual(len(predictor.y_timestamp), 5)
        self.assertEqual(side, Side.UP)
        self.assertGreaterEqual(confidence, 0.15)


if __name__ == "__main__":
    unittest.main()
