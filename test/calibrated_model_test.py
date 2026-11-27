import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location("model", Path(__file__).parents[1] / "calibrated_model.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class TrainingTests(unittest.TestCase):
    def bars(self, count=130):
        start = 1800000000000 // 900000 * 900000
        return [[start+i*60000, 60000+i, 60002+i, 59999+i, 60001+i] for i in range(count)]

    def test_features_never_use_future_or_current_unclosed_row(self):
        bars = self.bars()
        for minutes in [5, 15]:
            before = m.features(bars, 121, minutes, bars[120][1])
            for row in bars[121:]:
                row[1:] = [1, 999999, 1, 999999]
            after = m.features(bars, 121, minutes, bars[120][1])
            self.assertEqual(before, after)
            self.assertEqual(len(after), len(m.FEATURES))

    def test_whole_windows_are_exclusive_and_embargoed(self):
        groups = np.repeat(np.arange(1000), 4)
        tr, ca, te = m.chronological_split(groups)
        sets = [set(groups[x]) for x in (tr, ca, te)]
        self.assertFalse(sets[0] & sets[1])
        self.assertFalse(sets[1] & sets[2])
        self.assertLess(max(sets[0])+1, min(sets[1]))
        self.assertLess(max(sets[1])+1, min(sets[2]))

    def test_missing_history_rejects_features(self):
        bars = self.bars()
        bars[110][0] += 1
        with self.assertRaises(ValueError):
            m.features(bars, 121, 5, 60000)

    def test_training_does_not_include_window_end_snapshot(self):
        x, y, groups = m.dataset(self.bars(180), 5)
        self.assertTrue(len(x) > 0)
        self.assertTrue(np.all(x[:, 1] > 0))
        self.assertTrue(np.all(x[:, 1] < 1))
        self.assertTrue(np.all(y == 1))

    def test_insufficient_training_windows_fail_explicitly(self):
        with self.assertRaises(ValueError):
            m.chronological_split(np.arange(499))


if __name__ == "__main__":
    unittest.main()
