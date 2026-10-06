'use strict';

/**
 * Read-only market discovery for BTC five-minute windows.
 * Price data and simulated execution come from the public Polymarket CLOB.
 */

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const SLUG_PREFIX = 'btc-updown-5m-';
const WINDOW_SECONDS = 300;

function currentWindowOpenTs(nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS;
}

function slugForTs(ts) {
  return `${SLUG_PREFIX}${ts}`;
}

/** Returns { market, reason } -- market is null on any failure, with
 * `reason` explaining exactly which step failed (surfaced in the
 * dashboard's error banner instead of a generic "not found"). */
async function fetchMarketBySlug(slug) {
  const url = `${GAMMA_API_BASE}/events?slug=${encodeURIComponent(slug)}`;
  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { market: null, reason: `Gamma /events HTTP ${res.status} for slug=${slug}` };
    data = await res.json();
  } catch (e) {
    return { market: null, reason: `Gamma /events request failed for slug=${slug}: ${e.message}` };
  }

  let event = null;
  if (Array.isArray(data) && data.length) event = data[0];
  else if (data && Array.isArray(data.events) && data.events.length) event = data.events[0];
  else if (data && data.slug) event = data;

  if (!event || typeof event !== 'object') {
    return { market: null, reason: `Gamma /events returned no event for slug=${slug}` };
  }

  const markets = event.markets;
  if (Array.isArray(markets) && markets.length) return { market: markets[0], reason: null };
  if (event.clobTokenIds != null) return { market: event, reason: null };
  return { market: null, reason: `Gamma event found for slug=${slug} but no markets array / clobTokenIds -- response shape may have changed` };
}

function parseResolvedOutcome(marketJson) {
  if (!marketJson || marketJson.closed !== true
    || String(marketJson.umaResolutionStatus || '').toLowerCase() !== 'resolved') {
    return { resolved: false, reason: 'Gamma has not marked the market closed and resolved.' };
  }

  const outcomes = parseArray(marketJson.outcomes);
  const prices = parseArray(marketJson.outcomePrices);
  if (!outcomes || !prices || outcomes.length !== prices.length) {
    return { resolved: false, reason: 'Gamma did not return matching outcomes and outcome prices.' };
  }

  const byOutcome = new Map();
  outcomes.forEach((outcome, index) => {
    byOutcome.set(String(outcome).trim().toLowerCase(), Number(prices[index]));
  });
  const up = byOutcome.get('up');
  const down = byOutcome.get('down');
  const finalBinaryPrice = (price) => Number.isFinite(price)
    && (Math.abs(price) <= 1e-6 || Math.abs(price - 1) <= 1e-6);
  if (!finalBinaryPrice(up) || !finalBinaryPrice(down)
    || Math.abs(up + down - 1) > 1e-6 || up === down) {
    return { resolved: false, reason: 'Gamma outcome prices are not a final binary $0/$1 result.' };
  }

  return {
    resolved: true,
    winningSide: up === 1 ? 'UP' : 'DOWN',
    payoutPerShare: { UP: up, DOWN: down },
  };
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function fetchResolvedOutcomeBySlug(slug) {
  const { market, reason } = await fetchMarketBySlug(slug);
  if (!market) return { resolved: false, reason };
  return parseResolvedOutcome(market);
}

/** clobTokenIds is a JSON-encoded string list, in the same order as
 * `outcomes` (e.g. ["Up", "Down"]). */
function extractTokenIds(marketJson) {
  let rawTokens = marketJson.clobTokenIds;
  let outcomes = marketJson.outcomes;
  if (typeof rawTokens === 'string') {
    try { rawTokens = JSON.parse(rawTokens); } catch (_) { rawTokens = null; }
  }
  if (typeof outcomes === 'string') {
    try { outcomes = JSON.parse(outcomes); } catch (_) { outcomes = null; }
  }
  if (!rawTokens || !outcomes || rawTokens.length < 2) return { tokenUp: null, tokenDown: null };

  const pairs = {};
  outcomes.forEach((o, i) => { pairs[String(o).toLowerCase()] = rawTokens[i]; });
  let tokenUp = pairs['up'] || pairs['yes'];
  let tokenDown = pairs['down'] || pairs['no'];
  if (!tokenUp || !tokenDown) {
    // fallback: assume first outcome is Up if labels didn't match
    tokenUp = rawTokens[0];
    tokenDown = rawTokens[1];
  }
  return { tokenUp, tokenDown };
}

/** Resolve the market covering `now`. Primary candidate is the current
 * window's open_ts (confirmed slug convention) -- deliberately does NOT
 * fall through to guessing the *next* window's slug if Gamma hasn't
 * listed the current one yet; caller should just retry on the next
 * tick. */
async function getActiveWindow(nowMs = Date.now()) {
  const openTs = currentWindowOpenTs(nowMs);
  const slug = slugForTs(openTs);
  const { market, reason } = await fetchMarketBySlug(slug);
  if (!market) return { window: null, reason };

  const { tokenUp, tokenDown } = extractTokenIds(market);
  if (!tokenUp || !tokenDown) {
    return {
      window: null,
      reason: `Gamma market found for slug=${slug} but token ids couldn't be extracted `
        + `(clobTokenIds=${JSON.stringify(market.clobTokenIds)}, outcomes=${JSON.stringify(market.outcomes)})`,
    };
  }

  return {
    window: {
      slug,
      conditionId: market.conditionId || null,
      tokenUp,
      tokenDown,
      openTs,
      closeTs: openTs + WINDOW_SECONDS,
    },
    reason: null,
  };
}

module.exports = {
  WINDOW_SECONDS, SLUG_PREFIX,
  currentWindowOpenTs, slugForTs, fetchMarketBySlug, fetchResolvedOutcomeBySlug,
  parseResolvedOutcome, extractTokenIds, getActiveWindow,
};
