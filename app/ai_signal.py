"""
Lightweight online AI signal engine -- a from-scratch logistic
regression, trained continuously (one gradient step per resolved
window) on features computed off the Binance 1-minute feed. No
external ML dependencies (numpy/scikit-learn) and no external API
calls (no Claude/LLM call in the trading-decision path) -- pure
Python, so it's cheap to deploy and fast enough to run every tick.

Predicts P(next window resolves UP) from:
  - RSI(14)
  - 3-candle and 10-candle momentum (% return)
  - 10-candle return volatility (%)
  - the signal candle's own color (the old strategy's entire signal,
    now just one input feature among several)
  - current same-color candle streak length (signed: +3 = 3 green in a
    row, -2 = 2 red in a row)

Trains online (partial-fit, one step per window) each time a window's
true outcome becomes known via record_outcome() -- there's no separate
offline training step and no historical dataset required. Cold-starts
with no predictions at all until AI_MIN_SAMPLES_TO_PREDICT windows have
been learned from; before that, predict() returns (None, None) so the
engine just skips trading that window, same as the old "flat candle"
skip used to.
"""
import math
from dataclasses import dataclass
from typing import Optional

from . import config
from .binance_client import BinanceKlineFeed
from .models import Side

FEATURE_NAMES = ["rsi", "mom_3", "mom_10", "vol_10", "last_color", "streak"]
N_FEATURES = len(FEATURE_NAMES)


@dataclass
class _RunningStat:
    """Welford's online mean/variance -- used to standardize each raw
    feature before it hits the regression, so gradient steps stay
    well-scaled without needing a fixed offline-fit scaler. Improves
    as more windows are learned from, same as the model weights do."""
    n: int = 0
    mean: float = 0.0
    m2: float = 0.0

    def update(self, x: float):
        self.n += 1
        delta = x - self.mean
        self.mean += delta / self.n
        self.m2 += delta * (x - self.mean)

    def normalize(self, x: float) -> float:
        if self.n < 2:
            return 0.0
        var = self.m2 / (self.n - 1)
        std = math.sqrt(var) if var > 1e-9 else 1.0
        return (x - self.mean) / std


def _sigmoid(z: float) -> float:
    # numerically stable both directions
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    ez = math.exp(z)
    return ez / (1.0 + ez)


class AISignalEngine:
    """Online logistic regression predicting P(next window resolves UP).
    One instance lives on the Engine and persists for the process
    lifetime, same as the capital pool and cumulative stats."""

    def __init__(self):
        self.weights = [0.0] * N_FEATURES
        self.bias = 0.0
        self.stats = [_RunningStat() for _ in range(N_FEATURES)]
        self.n_trained = 0
        self.total_predictions = 0
        self.correct_predictions = 0

    # ---- feature engineering -------------------------------------------

    def _streak(self, feed: BinanceKlineFeed, signal_open_ts: float) -> float:
        """Signed run length of same-color candles ending at signal_open_ts
        (e.g. +3 for 3 greens in a row, -2 for 2 reds in a row, 0 if the
        signal candle itself is flat or history is unavailable)."""
        streak, direction = 0, 0
        for i in range(config.AI_STREAK_LOOKBACK):
            c = feed.get_candle(signal_open_ts - i * 60)
            if c is None or not c.closed or c.close == c.open:
                break
            color = 1 if c.close > c.open else -1
            if direction == 0:
                direction, streak = color, 1
            elif color == direction:
                streak += 1
            else:
                break
        return float(streak * direction)

    def compute_features(self, feed: BinanceKlineFeed, signal_open_ts: float) -> Optional[list]:
        """None if there isn't enough closed-candle history yet (startup
        or a feed reconnect) -- caller should treat that as no-signal."""
        rsi = feed.get_rsi(signal_open_ts, config.RSI_PERIOD)
        closes = feed.get_recent_closes(signal_open_ts, 11)   # need 10 candles back + the signal candle itself
        candle = feed.get_candle(signal_open_ts)
        if rsi is None or closes is None or candle is None:
            return None

        mom_3 = (closes[-1] - closes[-4]) / closes[-4] * 100 if closes[-4] else 0.0
        mom_10 = (closes[-1] - closes[0]) / closes[0] * 100 if closes[0] else 0.0
        rets = [(closes[i + 1] - closes[i]) / closes[i] for i in range(len(closes) - 1) if closes[i]]
        if rets:
            mean_r = sum(rets) / len(rets)
            vol_10 = (sum((r - mean_r) ** 2 for r in rets) / len(rets)) ** 0.5 * 100
        else:
            vol_10 = 0.0
        last_color = 1.0 if candle.close > candle.open else (-1.0 if candle.close < candle.open else 0.0)
        streak = self._streak(feed, signal_open_ts)

        return [rsi, mom_3, mom_10, vol_10, last_color, streak]

    def _standardize(self, feats: list) -> list:
        return [self.stats[i].normalize(feats[i]) for i in range(N_FEATURES)]

    def _predict_proba(self, feats: list) -> float:
        x = self._standardize(feats)
        z = self.bias + sum(w * xi for w, xi in zip(self.weights, x))
        return _sigmoid(z)

    # ---- predict / learn --------------------------------------------------

    def predict(self, feats: Optional[list]):
        """Returns (side, confidence) where confidence is P(that side
        wins), or (None, p_up) if the model isn't trained on enough
        windows yet or the prediction is inside the no-trade confidence
        band -- p_up is still returned for logging/dashboard purposes
        even when no trade results."""
        if feats is None:
            return None, None
        if self.n_trained < config.AI_MIN_SAMPLES_TO_PREDICT:
            return None, None
        p_up = self._predict_proba(feats)
        if abs(p_up - 0.5) < config.AI_CONFIDENCE_BAND:
            return None, p_up
        side = Side.UP if p_up >= 0.5 else Side.DOWN
        confidence = p_up if side == Side.UP else 1 - p_up
        return side, confidence

    def learn(self, feats: Optional[list], actual_up: bool):
        """One online SGD step with L2 regularization. Updates the
        running per-feature mean/variance first (so standardization
        keeps improving too), then a single logistic-regression
        gradient step."""
        if feats is None:
            return
        for i, raw in enumerate(feats):
            self.stats[i].update(raw)
        x = self._standardize(feats)
        p = self._predict_proba(feats)
        y = 1.0 if actual_up else 0.0
        error = p - y
        for i in range(N_FEATURES):
            grad = error * x[i] + config.AI_L2_REG * self.weights[i]
            self.weights[i] -= config.AI_LEARNING_RATE * grad
        self.bias -= config.AI_LEARNING_RATE * error
        self.n_trained += 1

    def record_prediction_result(self, predicted_side: Optional[Side], actual_up: bool):
        """Tracks the model's own directional hit rate -- independent of
        whether a trade was actually placed (RSI veto / illiquidity can
        still block a trade the AI called correctly)."""
        if predicted_side is None:
            return
        self.total_predictions += 1
        actual_side = Side.UP if actual_up else Side.DOWN
        if predicted_side == actual_side:
            self.correct_predictions += 1

    # ---- dashboard payload --------------------------------------------------

    def status(self) -> dict:
        accuracy = (round(100 * self.correct_predictions / self.total_predictions, 1)
                    if self.total_predictions else None)
        return {
            "n_trained": self.n_trained,
            "min_samples_to_predict": config.AI_MIN_SAMPLES_TO_PREDICT,
            "ready": self.n_trained >= config.AI_MIN_SAMPLES_TO_PREDICT,
            "total_predictions": self.total_predictions,
            "correct_predictions": self.correct_predictions,
            "accuracy": accuracy,
            "weights": dict(zip(FEATURE_NAMES, [round(w, 4) for w in self.weights])),
            "bias": round(self.bias, 4),
        }
