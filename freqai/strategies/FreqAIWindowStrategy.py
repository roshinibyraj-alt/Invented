from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from pandas import DataFrame
from freqtrade.strategy import IStrategy


class FreqAIWindowStrategy(IStrategy):
    """Prediction-only FreqAI strategy; it never opens Freqtrade orders."""

    timeframe = "1m"
    process_only_new_candles = True
    startup_candle_count = 60
    can_short = False
    minimal_roi = {"0": 1000}
    stoploss = -0.99
    use_exit_signal = False

    _last_exported_candle: int | None = None

    def feature_engineering_expand_basic(
        self, dataframe: DataFrame, metadata: dict, **kwargs
    ) -> DataFrame:
        close = dataframe["close"]
        for periods in (1, 2, 3, 5, 10, 20):
            dataframe[f"%-return-{periods}m"] = close.pct_change(periods)

        candle_range = (dataframe["high"] - dataframe["low"]) / dataframe["open"]
        body = (dataframe["close"] - dataframe["open"]) / dataframe["open"]
        upper_wick = (dataframe["high"] - dataframe[["open", "close"]].max(axis=1)) / dataframe["open"]
        lower_wick = (dataframe[["open", "close"]].min(axis=1) - dataframe["low"]) / dataframe["open"]
        dataframe["%-candle-range"] = candle_range
        dataframe["%-candle-body"] = body
        dataframe["%-upper-wick"] = upper_wick
        dataframe["%-lower-wick"] = lower_wick
        dataframe["%-close-location"] = (
            (dataframe["close"] - dataframe["low"])
            / (dataframe["high"] - dataframe["low"]).replace(0, np.nan)
        )
        volume_average = dataframe["volume"].rolling(20, min_periods=5).mean()
        dataframe["%-relative-volume"] = dataframe["volume"] / volume_average.replace(0, np.nan)
        dataframe["%-volume-change"] = dataframe["volume"].pct_change()
        dataframe["%-realized-volatility-5m"] = close.pct_change().rolling(5, min_periods=3).std()
        dataframe["%-realized-volatility-15m"] = close.pct_change().rolling(15, min_periods=5).std()
        return dataframe

    def feature_engineering_standard(
        self, dataframe: DataFrame, metadata: dict, **kwargs
    ) -> DataFrame:
        dates = pd.to_datetime(dataframe["date"], utc=True)
        minute_in_window = dates.dt.minute.mod(5) / 4
        dataframe["%-minute-in-five-minute-window"] = minute_in_window
        dataframe["%-minute-sin"] = np.sin(2 * np.pi * dates.dt.minute / 60)
        dataframe["%-minute-cos"] = np.cos(2 * np.pi * dates.dt.minute / 60)
        dataframe["%-hour-sin"] = np.sin(2 * np.pi * dates.dt.hour / 24)
        dataframe["%-hour-cos"] = np.cos(2 * np.pi * dates.dt.hour / 24)
        return dataframe

    def set_freqai_targets(
        self, dataframe: DataFrame, metadata: dict, **kwargs
    ) -> DataFrame:
        """Label every minute by its enclosing 5m candle's final direction."""
        dates = pd.to_datetime(dataframe["date"], utc=True)
        window_ids = dates.dt.floor("5min")
        grouped = dataframe.groupby(window_ids, sort=False)
        candle_count = grouped["close"].transform("count")
        window_open = grouped["open"].transform("first")
        window_close = grouped["close"].transform("last")

        labels = pd.Series(np.nan, index=dataframe.index, dtype="object")
        complete = candle_count.eq(5)
        labels.loc[complete & window_close.gt(window_open)] = "UP"
        labels.loc[complete & window_close.lt(window_open)] = "DOWN"
        dataframe["&-window-direction"] = labels
        return dataframe

    def populate_indicators(
        self, dataframe: DataFrame, metadata: dict
    ) -> DataFrame:
        dataframe = self.freqai.start(dataframe, metadata, self)
        self._export_latest_prediction(dataframe)
        return dataframe

    def _export_latest_prediction(self, dataframe: DataFrame) -> None:
        if dataframe.empty:
            return
        row = dataframe.iloc[-1]
        try:
            candle_start = int(pd.to_datetime(row["date"], utc=True).timestamp() * 1000)
        except (KeyError, TypeError, ValueError, OverflowError):
            return
        if candle_start == self._last_exported_candle:
            return
        self._last_exported_candle = candle_start

        try:
            do_predict = int(row.get("do_predict", 0)) == 1
        except (TypeError, ValueError, OverflowError):
            do_predict = False
        p_up = row.get("UP", np.nan)
        p_down = row.get("DOWN", np.nan)
        try:
            p_up = float(p_up)
            p_down = float(p_down)
        except (TypeError, ValueError):
            do_predict = False
            p_up = float("nan")
            p_down = float("nan")
        do_predict = (
            do_predict
            and np.isfinite(p_up)
            and np.isfinite(p_down)
            and p_up >= 0
            and p_down >= 0
            and p_up + p_down > 0
        )

        prediction_path = os.environ.get("FREQAI_PREDICTION_FILE")
        if not prediction_path:
            return
        candle_close_at = candle_start + 60_000
        payload = {
            "source": "FREQAI",
            "model": "LightGBMClassifier",
            "doPredict": bool(do_predict),
            "pUp": p_up if do_predict else None,
            "pDown": p_down if do_predict else None,
            "candleStart": candle_start,
            "candleCloseAt": candle_close_at,
            "windowStart": candle_start // 300_000 * 300_000,
            "writtenAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
        path = Path(prediction_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_path = tempfile.mkstemp(prefix=".prediction-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(payload, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_path, path)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)

    def populate_entry_trend(
        self, dataframe: DataFrame, metadata: dict
    ) -> DataFrame:
        dataframe["enter_long"] = 0
        dataframe["enter_tag"] = None
        return dataframe

    def populate_exit_trend(
        self, dataframe: DataFrame, metadata: dict
    ) -> DataFrame:
        dataframe["exit_long"] = 0
        dataframe["exit_tag"] = None
        return dataframe
