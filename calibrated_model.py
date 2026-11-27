"""Separate, chronologically calibrated BTC window classifiers.

Binance-close labels are a proxy for Polymarket's Chainlink settlement.
Only completed one-minute bars are used, identically in training and live.
"""
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.request

import numpy as np
from lightgbm import LGBMClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss

SCHEMA = "closed-minute-calibrated-v1"
API = "https://data-api.binance.vision/api/v3/klines"
FEATURES = [
    "distance_from_open", "elapsed_fraction", "minutes_remaining",
    "return_1m", "return_3m", "return_5m", "return_15m", "return_60m",
    "volatility_5m", "volatility_15m", "volatility_60m",
    "ema5_distance", "ema15_distance", "ema60_distance",
    "body", "range", "upper_wick", "lower_wick", "hour_sin", "hour_cos",
]


def get_bars(start=None, limit=1000):
    url = f"{API}?symbol=BTCUSDT&interval=1m&limit={limit}"
    if start is not None:
        url += f"&startTime={int(start)}"
    with urllib.request.urlopen(url, timeout=20) as response:
        rows = json.load(response)
    now = int(time.time() * 1000)
    return [[int(r[0]), *map(float, r[1:5])] for r in rows if int(r[6]) < now]


def features(bars, index, minutes, open_price):
    """index is the first unseen minute, never the target window's final close."""
    history = np.asarray(bars[index - 90:index], dtype=float)
    if len(history) != 90 or np.any(np.diff(history[:, 0]) != 60000):
        raise ValueError("Need 90 contiguous, completed one-minute bars")
    timestamp = int(history[-1, 0]) + 60000
    elapsed = (timestamp // 60000) % minutes
    if elapsed == 0:
        raise ValueError("No completed current-window observation at the opening boundary")
    close = history[:, 4]
    returns = np.diff(np.log(close))
    price = close[-1]
    row = history[-1]
    values = [math.log(price / open_price), elapsed / minutes, minutes - elapsed]
    values += [math.log(price / close[-1 - n]) for n in (1, 3, 5, 15, 60)]
    values += [float(np.std(returns[-n:])) for n in (5, 15, 60)]
    for n in (5, 15, 60):
        ema = close[0]
        for item in close[1:]:
            ema += 2 / (n + 1) * (item - ema)
        values.append(math.log(price / ema))
    values += [(row[4] - row[1]) / price, (row[2] - row[3]) / price,
               (row[2] - max(row[1], row[4])) / price,
               (min(row[1], row[4]) - row[3]) / price]
    hour = (timestamp / 3600000) % 24
    values += [math.sin(hour * math.tau / 24), math.cos(hour * math.tau / 24)]
    if not np.all(np.isfinite(values)):
        raise ValueError("Non-finite input features")
    return values


def dataset(bars, minutes):
    x, y, groups = [], [], []
    by_time = {int(row[0]): i for i, row in enumerate(bars)}
    duration = minutes * 60000
    for i in range(90, len(bars)):
        timestamp = int(bars[i][0])
        start = timestamp // duration * duration
        first, last = by_time.get(start), by_time.get(start + duration - 60000)
        if first is None or last is None or first + minutes > len(bars) or timestamp == start:
            continue
        # A complete window is required for a training label, never for features.
        if any(int(bars[first + j][0]) != start + j * 60000 for j in range(minutes)):
            continue
        try:
            x.append(features(bars, i, minutes, bars[first][1]))
        except ValueError:
            continue
        y.append(int(bars[last][4] >= bars[first][1]))
        groups.append(start)
    return np.asarray(x), np.asarray(y), np.asarray(groups)


def chronological_split(groups):
    windows = np.unique(groups)
    if len(windows) < 500:
        raise ValueError("At least 500 complete windows required")
    a, b = int(len(windows) * .60), int(len(windows) * .80)
    # Purge a full window at each boundary. A window can never span folds.
    return groups < windows[a - 1], ((groups >= windows[a]) & (groups < windows[b - 1])), groups >= windows[b]


def logits(probabilities):
    p = np.clip(probabilities, .0001, .9999)
    return np.log(p / (1 - p)).reshape(-1, 1)


def train(bars, minutes):
    x, y, groups = dataset(bars, minutes)
    tr, ca, te = chronological_split(groups)
    for mask in (tr, ca, te):
        if len(np.unique(y[mask])) != 2:
            raise ValueError("Each chronological fold must contain both outcomes")
    model = LGBMClassifier(n_estimators=160, learning_rate=.035, num_leaves=15,
                           max_depth=4, min_child_samples=150, reg_lambda=5,
                           random_state=42, n_jobs=2, verbosity=-1)
    model.fit(x[tr], y[tr], feature_name=FEATURES)
    calibration = LogisticRegression(C=1, random_state=42)
    calibration.fit(logits(model.predict_proba(x[ca])[:, 1]), y[ca])
    p = calibration.predict_proba(logits(model.predict_proba(x[te])[:, 1]))[:, 1]
    baseline = np.full(len(p), float(np.mean(y[tr])))
    metrics = {
        "testBrier": float(brier_score_loss(y[te], p)),
        "baselineBrier": float(brier_score_loss(y[te], baseline)),
        "testLogLoss": float(log_loss(y[te], p)),
        "testAccuracy": float(np.mean((p >= .5) == y[te])),
        "trainWindows": int(len(np.unique(groups[tr]))),
        "calibrationWindows": int(len(np.unique(groups[ca]))),
        "testWindows": int(len(np.unique(groups[te]))),
        "testSnapshots": int(te.sum()), "trainedAt": int(time.time() * 1000),
        "labelSource": "Binance BTCUSDT window close/open proxy; not Chainlink ground truth",
        "features": FEATURES, "split": "chronological 60/20/20; full-window groups; one-window embargo",
        "bins": [],
    }
    for low in np.arange(0, 1, .1):
        mask = (p >= low) & (p < low + .1)
        if mask.sum():
            metrics["bins"].append({"from": round(float(low), 1), "count": int(mask.sum()),
                                    "predicted": float(p[mask].mean()), "actual": float(y[te][mask].mean())})
    metrics["accepted"] = metrics["testBrier"] < metrics["baselineBrier"]
    return model, calibration, metrics


def emit(data):
    print(json.dumps(data, allow_nan=False), flush=True)


def load_history(path, days=30):
    earliest = int((time.time() - days * 86400) // 60 * 60000)
    rows = []
    if path.exists():
        rows = [r for r in json.loads(path.read_text()) if r[0] >= earliest]
    cursor = rows[-1][0] + 60000 if rows else earliest
    while cursor < int(time.time() // 60 * 60000) - 60000:
        chunk = get_bars(cursor)
        if not chunk:
            break
        rows += chunk
        cursor = chunk[-1][0] + 60000
        time.sleep(.1)
    rows = sorted({r[0]: r for r in rows}.values())
    path.write_text(json.dumps(rows))
    return rows


def main():
    directory = Path(os.environ.get("MODEL_DATA_DIR", "/tmp/invented-calibrated"))
    directory.mkdir(parents=True, exist_ok=True)
    history_path = directory / "btc-completed-1m.json"
    models = {}
    last_training = 0
    last_minute = None
    bars = []
    while True:
        try:
            if not models or time.time() - last_training > 21600:
                emit({"type": "status", "status": "TRAINING", "message": "Downloading completed BTC history and training separate calibrated models."})
                bars = load_history(history_path)
                new_models = {}
                for minutes in (5, 15):
                    new_models[minutes] = train(bars, minutes)
                    emit({"type": "model", "timeframe": f"{minutes}m", "metrics": new_models[minutes][2]})
                models = new_models
                last_training = time.time()
            minute = int(time.time() // 60)
            if minute != last_minute:
                recent = get_bars(limit=100)
                bars = sorted({r[0]: r for r in bars + recent}.values())
                if not bars or int(bars[-1][0]) + 60000 != minute * 60000:
                    emit({"type": "status", "status": "WAITING_FOR_CANDLE",
                          "message": "Waiting for Binance to publish the just-closed minute; no stale entries."})
                    time.sleep(2)
                    continue
                by_time = {int(r[0]): i for i, r in enumerate(bars)}
                for minutes, (model, calibration, metrics) in models.items():
                    start = minute // minutes * minutes * 60000
                    if minute % minutes == 0:
                        emit({"type": "prediction", "timeframe": f"{minutes}m", "prediction": None})
                        continue
                    first = by_time.get(start)
                    if first is None:
                        continue
                    values = features(bars, len(bars), minutes, bars[first][1])
                    raw = float(model.predict_proba(np.asarray([values]))[0, 1])
                    p = float(calibration.predict_proba(logits(np.asarray([raw])))[0, 1])
                    emit({"type": "prediction", "timeframe": f"{minutes}m", "prediction": {
                        "pUp": p, "pDown": 1-p, "rawUp": raw, "windowStart": start,
                        "observedAt": minute * 60000, "writtenAt": int(time.time()*1000),
                        "referencePrice": bars[first][1], "spotPrice": bars[-1][4],
                        "validUntil": (minute + 1) * 60000, "accepted": metrics["accepted"],
                        "schema": SCHEMA}})
                last_minute = minute
            time.sleep(2)
        except Exception as error:
            emit({"type": "status", "status": "ERROR", "message": str(error)})
            time.sleep(15)


if __name__ == "__main__":
    main()
