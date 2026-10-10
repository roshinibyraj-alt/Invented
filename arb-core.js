'use strict';

const CRYPTO_WORDS = /\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|xrp|dogecoin|doge|bnb|cardano|ada|chainlink|avax|polygon|matic|token|coinbase|binance|crypto currency|cryptocurrency)\b/i;

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch (_) {} }
  return [];
}

function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function isCryptoMarket(market) {
  const text = [market.title, market.question, market.description, market.category,
    ...(Array.isArray(market.tags) ? market.tags.map(t => typeof t === 'string' ? t : t.name) : [])]
    .filter(Boolean).join(' ');
  return CRYPTO_WORDS.test(text);
}

function normalizeMarket(market, venue) {
  const title = market.title || market.question || market.name || '';
  const outcomes = parseArray(market.outcomes);
  const tokens = parseArray(market.clobTokenIds || market.outcomeTokenIds || market.tokens);
  if (!title || outcomes.length !== 2 || isCryptoMarket({ ...market, title })) return null;
  const mapped = {};
  outcomes.forEach((o, i) => {
    const label = typeof o === 'string' ? o : (o.label || o.name || o.title || '');
    const token = tokens[i];
    const id = typeof token === 'string' ? token
      : token && (token.tokenId || token.id || token.token_id)
        || (venue === 'PREDICT' && ['yes', 'no'].includes(normalizeText(label)) ? normalizeText(label) : '');
    if (label && id) mapped[normalizeText(label)] = String(id);
  });
  if (Object.keys(mapped).length !== 2 || (venue === 'POLY' && Object.keys(mapped).length !== tokens.length)) return null;
  const id = market.id || market.conditionId || market.slug;
  if (venue === 'PREDICT' && !id) return null;
  return {
    venue, id: String(id || ''),
    title, matchKey: normalizeText(title), outcomes: mapped,
    raw: market,
  };
}

function matchBinaryMarkets(polyMarkets, predictMarkets) {
  const predictByTitle = new Map();
  for (const m of predictMarkets) {
    const normalized = normalizeMarket(m, 'PREDICT');
    if (!normalized) continue;
    const list = predictByTitle.get(normalized.matchKey) || [];
    list.push(normalized);
    predictByTitle.set(normalized.matchKey, list);
  }
  const polyByTitle = new Map();
  for (const m of polyMarkets) {
    const normalized = normalizeMarket(m, 'POLY');
    if (!normalized) continue;
    const list = polyByTitle.get(normalized.matchKey) || [];
    list.push(normalized);
    polyByTitle.set(normalized.matchKey, list);
  }
  const pairs = [];
  for (const [key, polys] of polyByTitle) {
    const preds = predictByTitle.get(key) || [];
    // Duplicate exact titles are ambiguous (often different fixtures); never guess.
    if (polys.length !== 1 || preds.length !== 1) continue;
    const poly = polys[0], pred = preds[0], labels = Object.keys(poly.outcomes);
    if (labels.length === 2 && labels.every(label => pred.outcomes[label])) {
      pairs.push({ key, title: poly.title, poly, predict: pred, labels });
    }
  }
  return pairs;
}

function normalizeLevels(levels) {
  return (Array.isArray(levels) ? levels : []).map(x => ({
    price: Number(Array.isArray(x) ? x[0] : x.price),
    size: Number(Array.isArray(x) ? x[1] : (x.size ?? x.quantity)),
  })).filter(x => Number.isFinite(x.price) && x.price > 0 && x.price <= 1
    && Number.isFinite(x.size) && x.size > 0).sort((a, b) => a.price - b.price);
}

function sweepAsks(levels, shares, feeFn = () => 0) {
  let remaining = shares, total = 0, fees = 0;
  const fills = [];
  for (const level of normalizeLevels(levels)) {
    if (remaining <= 1e-8) break;
    const size = Math.min(remaining, level.size);
    const fee = Math.max(0, Number(feeFn(level.price, size)) || 0);
    fills.push({ price: level.price, shares: size, notional: size * level.price, fee });
    total += size * level.price;
    fees += fee;
    remaining -= size;
  }
  return { filledShares: shares - remaining, remainingShares: remaining, notional: total, fees, totalCost: total + fees, fills };
}

function findArbitrage(pair, books, options = {}) {
  const shares = Number(options.shares || 500);
  const minEdge = Number(options.minEdge || 0.03);
  const directions = [];
  for (const label of pair.labels) {
    const opposite = pair.labels.find(x => x !== label);
    const polyAsks = books.poly[pair.poly.outcomes[label]] || [];
    const predictAsks = books.predict[pair.predict.outcomes[opposite]] || [];
    const a = sweepAsks(polyAsks, shares, options.polyFee || (() => 0));
    const b = sweepAsks(predictAsks, shares, options.predictFee || (() => 0));
    if (a.remainingShares > 1e-7 || b.remainingShares > 1e-7) continue;
    const edgePerShare = 1 - (a.totalCost + b.totalCost) / shares;
    directions.push({
      direction: `POLY ${label} + PREDICT ${opposite}`,
      label, opposite, shares, edgePerShare,
      totalCost: a.totalCost + b.totalCost, legs: { poly: a, predict: b },
    });
  }
  return directions.filter(x => x.edgePerShare >= minEdge)
    .sort((a, b) => b.edgePerShare - a.edgePerShare);
}

module.exports = { parseArray, normalizeText, isCryptoMarket, normalizeMarket, matchBinaryMarkets,
  normalizeLevels, sweepAsks, findArbitrage };
