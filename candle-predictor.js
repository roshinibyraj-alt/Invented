'use strict';

const cfg = require('./config');

function number(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid candle ${name}.`);
  return parsed;
}

function normalizeCandle(candle) {
  const values = Array.isArray(candle)
    ? {
      openTime: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5],
      closeTime: candle[6],
    }
    : candle;
  const open = number(values?.open, 'open');
  const high = number(values?.high, 'high');
  const low = number(values?.low, 'low');
  const close = number(values?.close, 'close');
  const volume = number(values?.volume, 'volume');
  if (high < low || volume < 0) throw new Error('Invalid candle range or volume.');
  return {
    openTime: Number(values.openTime) || null,
    closeTime: Number(values.closeTime) || null,
    open,
    high,
    low,
    close,
    volume,
  };
}

function predictNextCandle(inputCandles, options = {}) {
  const lookback = Number(options.lookback ?? cfg.PREDICTOR_LOOKBACK);
  const wickWeight = Number(options.wickWeight ?? cfg.PREDICTOR_WICK_WEIGHT);
  const bodyWeight = Number(options.bodyWeight ?? cfg.PREDICTOR_BODY_WEIGHT);
  const volumeWeight = Number(options.volumeWeight ?? cfg.PREDICTOR_VOLUME_WEIGHT);
  const sensitivity = Number(options.sensitivity ?? cfg.PREDICTOR_SENSITIVITY);

  if (!Number.isInteger(lookback) || lookback < 2 || lookback > 20) {
    throw new Error('Predictor lookback must be an integer from 2 through 20.');
  }
  if (![wickWeight, bodyWeight, volumeWeight, sensitivity].every(Number.isFinite) ||
      wickWeight < 0 || bodyWeight < 0 || volumeWeight < 0 || sensitivity < 0) {
    throw new Error('Predictor weights and sensitivity must be non-negative numbers.');
  }
  if (!Array.isArray(inputCandles) || inputCandles.length < lookback) {
    throw new Error(`Predictor needs ${lookback} completed candles.`);
  }

  const candles = inputCandles.slice(-lookback).map(normalizeCandle);
  const averageVolume = candles.reduce((sum, candle) => sum + candle.volume, 0) / lookback;
  const bars = candles.map(candle => {
    const body = Math.abs(candle.close - candle.open);
    const wick = Math.max(0, candle.high - candle.low - body);
    const candleDirection = candle.close > candle.open ? 1
      : candle.close < candle.open ? -1 : 0;
    const relativeVolume = averageVolume > 0 ? candle.volume / averageVolume : 0;
    const volumeFactor = Math.max(relativeVolume, 0.1);
    const strength = (body * bodyWeight + wick * wickWeight) *
      volumeFactor * volumeWeight * candleDirection;
    return {
      ...candle,
      body,
      wick,
      candleDirection,
      relativeVolume,
      strength,
    };
  });
  const score = bars.reduce((sum, bar) => sum + bar.strength, 0) / lookback;
  const direction = score > sensitivity ? 'BULLISH'
    : score < -sensitivity ? 'BEARISH' : 'NEUTRAL';
  const side = direction === 'BULLISH' ? 'UP'
    : direction === 'BEARISH' ? 'DOWN' : null;

  return {
    direction,
    side,
    score: Number(score.toFixed(6)),
    sensitivity,
    lookback,
    averageBody: Number((bars.reduce((sum, bar) => sum + bar.body, 0) / lookback).toFixed(6)),
    averageWick: Number((bars.reduce((sum, bar) => sum + bar.wick, 0) / lookback).toFixed(6)),
    averageRelativeVolume: Number((bars.reduce((sum, bar) => sum + bar.relativeVolume, 0) / lookback).toFixed(6)),
    latestRelativeVolume: Number(bars[bars.length - 1].relativeVolume.toFixed(6)),
    bullishCandles: bars.filter(bar => bar.candleDirection > 0).length,
    bearishCandles: bars.filter(bar => bar.candleDirection < 0).length,
    neutralCandles: bars.filter(bar => bar.candleDirection === 0).length,
    latestCandleCloseTime: bars[bars.length - 1].closeTime,
    bars: bars.map(bar => ({
      openTime: bar.openTime,
      closeTime: bar.closeTime,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      direction: bar.candleDirection > 0 ? 'BULLISH'
        : bar.candleDirection < 0 ? 'BEARISH' : 'NEUTRAL',
      body: Number(bar.body.toFixed(6)),
      wick: Number(bar.wick.toFixed(6)),
      relativeVolume: Number(bar.relativeVolume.toFixed(6)),
      strength: Number(bar.strength.toFixed(6)),
    })),
  };
}

module.exports = { predictNextCandle, normalizeCandle };
