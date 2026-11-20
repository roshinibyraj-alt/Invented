'use strict';

const CHAINLINK_URL = 'https://data.chain.link/streams/btc-usd/reports';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range';
const MAX_REPORT_DISTANCE_MS = 15_000;
const MAX_FALLBACK_DISTANCE_MS = 60_000;

function timestampMs(value) {
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value || ''))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nearestPrice(rows, targetMs, getTimestamp, getPrice, maxDistanceMs) {
  if (!Array.isArray(rows)) return null;
  const valid = rows.map((row) => ({
    timestamp: getTimestamp(row),
    value: Number(getPrice(row)),
  })).filter((item) => Number.isFinite(item.timestamp)
    && Number.isFinite(item.value) && item.value > 0);
  if (!valid.length) return null;
  valid.sort((a, b) => Math.abs(a.timestamp - targetMs) - Math.abs(b.timestamp - targetMs));
  return Math.abs(valid[0].timestamp - targetMs) <= maxDistanceMs ? valid[0] : null;
}

class BeatPriceProvider {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetch = fetchImpl;
  }

  async getAtTimestamp(targetTimestamp) {
    const targetMs = timestampMs(targetTimestamp);
    if (!Number.isFinite(targetMs) || targetMs <= 0) {
      return { value: null, source: null, error: 'Invalid market-start timestamp.' };
    }

    const targetSeconds = Math.floor(targetMs / 1000);
    let chainlinkError = null;
    try {
      const response = await this.fetch(
        `${CHAINLINK_URL}?timestamp=${targetSeconds}`,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'InventedPaperArbitrage/1.0',
          },
          signal: AbortSignal.timeout(2000),
        },
      );
      if (!response.ok) {
        chainlinkError = `Chainlink HTTP ${response.status}`;
      } else {
        const payload = await response.json();
        const reports = Array.isArray(payload?.reports) ? payload.reports : [];
        const nearest = nearestPrice(
          reports,
          targetMs,
          (report) => timestampMs(report?.timestamp ?? report?.observationsTimestamp),
          (report) => report?.price ?? report?.answer,
          MAX_REPORT_DISTANCE_MS,
        );
        if (nearest) {
          return {
            value: nearest.value,
            source: 'CHAINLINK_DATA_STREAMS',
            sourceTimestamp: nearest.timestamp,
            exact: nearest.timestamp === targetMs,
            offsetMs: nearest.timestamp - targetMs,
            chainlinkError: null,
          };
        }
        chainlinkError = 'Chainlink returned no report close to the market start.';
      }
    } catch (error) {
      chainlinkError = error?.name === 'TimeoutError'
        ? 'Chainlink request timed out.'
        : error?.message || 'Chainlink historical price was unavailable.';
    }

    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const from = targetSeconds;
      const to = Math.min(targetSeconds + 60, nowSeconds);
      if (to < from) {
        return {
          value: null,
          source: null,
          error: 'Market start is in the future; no historical beat price is available.',
          chainlinkError,
        };
      }
      const params = new URLSearchParams({
        vs_currency: 'usd',
        from: String(from),
        to: String(to),
      });
      const response = await this.fetch(`${COINGECKO_URL}?${params}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'InventedPaperArbitrage/1.0',
        },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
      const payload = await response.json();
      const nearest = nearestPrice(
        payload?.prices,
        targetMs,
        (row) => Array.isArray(row) ? timestampMs(row[0]) : null,
        (row) => Array.isArray(row) ? row[1] : null,
        MAX_FALLBACK_DISTANCE_MS,
      );
      if (!nearest) {
        return {
          value: null,
          source: null,
          error: 'No historical BTC price was found close enough to the market start.',
          chainlinkError,
        };
      }
      return {
        value: nearest.value,
        source: 'COINGECKO_PROXY',
        sourceTimestamp: nearest.timestamp,
        exact: false,
        note: 'Approximate historical proxy; not the Chainlink resolution feed.',
        chainlinkError,
      };
    } catch (error) {
      return {
        value: null,
        source: null,
        error: error?.message || 'Historical BTC price was unavailable.',
        chainlinkError,
      };
    }
  }
}

BeatPriceProvider._test = { timestampMs, nearestPrice };

module.exports = BeatPriceProvider;
