'use strict';

function candleColor(open, close, high, low) {
  const range = Number(high) - Number(low);
  const body = Math.abs(Number(close) - Number(open));
  if (range > 0 && body / range <= 0.1) return 'DOJI';
  return Number(close) > Number(open) ? 'GREEN' : Number(close) < Number(open) ? 'RED' : 'DOJI';
}

function aggregateCompleteCandles(minuteCandles, windowMs) {
  const count = windowMs / 60_000;
  const groups = new Map();
  for (const row of minuteCandles || []) {
    const start = Math.floor(Number(row.t) / windowMs) * windowMs;
    const rows = groups.get(start) || [];
    rows.push(row);
    groups.set(start, rows);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([start, rows]) => {
    rows.sort((a, b) => a.t - b.t);
    if (rows.length !== count || rows.some((row, index) => row.t !== start + index * 60_000)) return [];
    const open = Number(rows[0].o);
    const close = Number(rows.at(-1).c);
    const high = Math.max(...rows.map(row => Number(row.h)));
    const low = Math.min(...rows.map(row => Number(row.l)));
    return [{ start, end: start + windowMs, open, close, high, low, color: candleColor(open, close, high, low) }];
  });
}

function candleParts(candle) {
  const open = Number(candle.open);
  const close = Number(candle.close);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const bodyHigh = Math.max(open, close);
  const bodyLow = Math.min(open, close);
  const range = Math.max(0, high - low);
  const body = Math.abs(close - open);
  return {
    open, close, high, low, body, range, bodyHigh, bodyLow,
    upperWick: Math.max(0, high - bodyHigh),
    lowerWick: Math.max(0, bodyLow - low),
    bullish: close > open,
    bearish: close < open,
  };
}

function trendBefore(candles, endIndex) {
  const sample = candles.slice(Math.max(0, endIndex - 3), endIndex + 1);
  if (sample.length < 3) return null;
  const movement = sample.at(-1).close - sample[0].open;
  return movement > 0 ? 'UP' : movement < 0 ? 'DOWN' : null;
}

function detectPatternCandidates(candles) {
  const n = candles.length;
  if (!n) return [];
  const current = candleParts(candles[n - 1]);
  const previous = n >= 2 ? candleParts(candles[n - 2]) : null;
  const third = n >= 3 ? candleParts(candles[n - 3]) : null;
  const matches = [];
  const add = (pattern, side) => matches.push({ pattern, side });
  const small = part => part && part.range > 0 && part.body / part.range <= 0.35;
  const long = part => part && part.range > 0 && part.body / part.range >= 0.55;
  const priorTrend = n >= 2 ? trendBefore(candles, n - 2) : null;

  if (third && previous && long(third) && small(previous) && long(current)) {
    const midpoint = (third.open + third.close) / 2;
    if (third.bearish && current.bullish && current.close > midpoint) add('MORNING_STAR', 'UP');
    if (third.bullish && current.bearish && current.close < midpoint) add('EVENING_STAR', 'DOWN');
  }

  if (previous && previous.bearish && current.bullish &&
      current.bodyLow <= previous.bodyLow && current.bodyHigh >= previous.bodyHigh) {
    add('BULLISH_ENGULFING', 'UP');
  }
  if (previous && previous.bullish && current.bearish &&
      current.bodyLow <= previous.bodyLow && current.bodyHigh >= previous.bodyHigh) {
    add('BEARISH_ENGULFING', 'DOWN');
  }

  if (previous && long(previous) && small(current) &&
      current.bodyHigh <= previous.bodyHigh && current.bodyLow >= previous.bodyLow) {
    if (previous.bearish && current.bullish) add('BULLISH_HARAMI', 'UP');
    if (previous.bullish && current.bearish) add('BEARISH_HARAMI', 'DOWN');
  }

  if (previous && previous.bearish && current.bullish &&
      current.open < previous.close && current.close > (previous.open + previous.close) / 2 &&
      current.close < previous.open) add('PIERCING_LINE', 'UP');
  if (previous && previous.bullish && current.bearish &&
      current.open > previous.close && current.close < (previous.open + previous.close) / 2 &&
      current.close > previous.open) add('DARK_CLOUD_COVER', 'DOWN');

  const doji = current.range > 0 && current.body / current.range <= 0.1;
  if (doji && current.lowerWick >= current.range * 0.6 && current.upperWick <= current.range * 0.1) {
    add('DRAGONFLY_DOJI', 'UP');
  } else if (doji && current.upperWick >= current.range * 0.6 && current.lowerWick <= current.range * 0.1) {
    add('GRAVESTONE_DOJI', 'DOWN');
  } else if (doji) {
    add('DOJI', priorTrend === 'DOWN' ? 'UP' : priorTrend === 'UP' ? 'DOWN' : null);
  }

  if (current.range > 0 && current.body / current.range <= 0.35 &&
      current.lowerWick >= Math.max(current.body * 2, current.range * 0.55) &&
      current.upperWick <= Math.max(current.body * 0.5, current.range * 0.1)) {
    if (priorTrend === 'DOWN') add('HAMMER', 'UP');
    if (priorTrend === 'UP') add('HANGING_MAN', 'DOWN');
  }
  if (current.range > 0 && current.body / current.range <= 0.35 &&
      current.upperWick >= Math.max(current.body * 2, current.range * 0.55) &&
      current.lowerWick <= Math.max(current.body * 0.5, current.range * 0.1)) {
    if (priorTrend === 'DOWN') add('INVERTED_HAMMER', 'UP');
    if (priorTrend === 'UP') add('SHOOTING_STAR', 'DOWN');
  }

  if (n >= 3) {
    const a = candleParts(candles[n - 3]);
    const b = candleParts(candles[n - 2]);
    if (a.bullish && b.bullish && current.bullish &&
        b.close > a.close && current.close > b.close &&
        b.open >= a.bodyLow && b.open <= a.bodyHigh &&
        current.open >= b.bodyLow && current.open <= b.bodyHigh) {
      add('THREE_WHITE_SOLDIERS', 'UP');
    }
    if (a.bearish && b.bearish && current.bearish &&
        b.close < a.close && current.close < b.close &&
        b.open >= a.bodyLow && b.open <= a.bodyHigh &&
        current.open >= b.bodyLow && current.open <= b.bodyHigh) {
      add('THREE_BLACK_CROWS', 'DOWN');
    }
  }

  const priority = {
    MORNING_STAR: 0, EVENING_STAR: 0,
    BULLISH_ENGULFING: 1, BEARISH_ENGULFING: 1,
    BULLISH_HARAMI: 2, BEARISH_HARAMI: 2,
    PIERCING_LINE: 3, DARK_CLOUD_COVER: 3,
    HAMMER: 4, HANGING_MAN: 4, INVERTED_HAMMER: 4, SHOOTING_STAR: 4,
    THREE_WHITE_SOLDIERS: 5, THREE_BLACK_CROWS: 5,
    DRAGONFLY_DOJI: 6, GRAVESTONE_DOJI: 6, DOJI: 7,
  };
  return matches.sort((a, b) => (priority[a.pattern] ?? 99) - (priority[b.pattern] ?? 99));
}

function signalForPrevious(candles) {
  if (!candles.length) return {
    side: null,
    pattern: 'WAITING_FOR_COMPLETE_CANDLE',
    matchedPatterns: [],
    reason: 'No previous complete 5-minute candle is available; waiting for candle data',
  };
  const matches = detectPatternCandidates(candles);
  const previous = candles.at(-1);
  if (previous.color === 'GREEN') return {
    side: 'UP', pattern: 'PREVIOUS_GREEN', matchedPatterns: matches, previous,
    reason: 'UP because the latest completed candle closed higher than it opened',
  };
  if (previous.color === 'RED') return {
    side: 'DOWN', pattern: 'PREVIOUS_RED', matchedPatterns: matches, previous,
    reason: 'DOWN because the latest completed candle closed lower than it opened',
  };
  let red = 0;
  let green = 0;
  for (let index = candles.length - 2; index >= 0; index--) {
    if (candles[index].color === 'RED' && !green) red++;
    else if (candles[index].color === 'GREEN' && !red) green++;
    else break;
  }
  if (previous.color === 'DOJI' && red >= 2) return {
    side: 'UP', pattern: 'DOJI_AFTER_RED_RUN', matchedPatterns: matches, previous,
    reason: 'UP because a doji followed a run of at least two bearish candles',
  };
  if (previous.color === 'DOJI' && green >= 2) return {
    side: 'DOWN', pattern: 'DOJI_AFTER_GREEN_RUN', matchedPatterns: matches, previous,
    reason: 'DOWN because a doji followed a run of at least two bullish candles',
  };
  const priorDirection = [...candles.slice(0, -1)].reverse().find(candle => ['GREEN', 'RED'].includes(candle.color));
  return {
    side: null,
    pattern: 'DOJI_NO_DIRECTION',
    matchedPatterns: matches,
    previous,
    reason: 'No directional doji rule or named formation matched',
  };
}

module.exports = { candleColor, aggregateCompleteCandles, detectPatternCandidates, signalForPrevious };
