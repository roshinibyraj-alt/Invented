'use strict';

/**
 * Market discovery (Gamma API) + real settlement for the BTC 5-min
 * up/down series. Ported from the paper-trading bot's
 * app/polymarket_client.py -- same slug convention, same "/events"
 * endpoint quirk (this 5-min series is NOT addressable via
 * /markets?slug=..., only /events?slug=... with the market nested one
 * level down at event.markets[0]), same defensive fallbacks.
 *
 * This module is read-only -- it never places an order. Real money only
 * moves through polymarket-trader.js.
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
    const res = await fetch(url);
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

/** Real settlement -- polls Gamma for the market's own resolved outcome
 * (closed=true + a decisive outcomePrices split, winner priced >=0.99),
 * NOT a price guess. Returns 'UP', 'DOWN', or null if not resolved yet. */
async function fetchResolution(slug) {
  const { market } = await fetchMarketBySlug(slug);
  if (!market || !market.closed) return null;

  let outcomePrices = market.outcomePrices;
  let outcomes = market.outcomes;
  if (typeof outcomePrices === 'string') {
    try { outcomePrices = JSON.parse(outcomePrices); } catch (_) { return null; }
  }
  if (typeof outcomes === 'string') {
    try { outcomes = JSON.parse(outcomes); } catch (_) { return null; }
  }
  if (!outcomePrices || !outcomes || outcomePrices.length < 2) return null;

  const prices = outcomePrices.map((p) => parseFloat(p));
  const maxP = Math.max(...prices);
  if (maxP < 0.99) return null; // not decisively resolved yet

  const winIdx = prices.indexOf(maxP);
  const winLabel = String(outcomes[winIdx]).toLowerCase();
  if (winLabel === 'up' || winLabel === 'yes') return 'UP';
  if (winLabel === 'down' || winLabel === 'no') return 'DOWN';
  return null;
}

module.exports = {
  WINDOW_SECONDS, SLUG_PREFIX,
  currentWindowOpenTs, slugForTs, fetchMarketBySlug, extractTokenIds,
  getActiveWindow, fetchResolution,
};
