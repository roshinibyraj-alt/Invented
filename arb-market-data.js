'use strict';

const GAMMA = 'https://gamma-api.polymarket.com';
const POLY_CLOB = 'https://clob.polymarket.com';
const PREDICT = 'https://api.predict.fun/v1';

async function json(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

async function getPolymarketMarkets() {
  const all = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const data = await json(`${GAMMA}/markets?active=true&closed=false&limit=100&offset=${offset}`);
    const rows = Array.isArray(data) ? data : data.markets || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

async function getPredictMarkets(apiKey) {
  if (!apiKey) throw new Error('PREDICT_API_KEY is missing from Railway server variables');
  const all = [];
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const offset = page * 100;
    const url = `${PREDICT}/markets?status=OPEN&limit=100${cursor
      ? `&cursor=${encodeURIComponent(cursor)}` : `&offset=${offset}`}`;
    const data = await json(url, { headers: { 'x-api-key': apiKey } });
    const rows = Array.isArray(data) ? data : data.data || data.markets || [];
    all.push(...rows);
    cursor = data.nextCursor || data.next_cursor || data.pagination?.nextCursor || '';
    if (rows.length === 0 || (!cursor && rows.length < 100)) break;
  }
  return all;
}

async function getPolyBook(tokenId) {
  return json(`${POLY_CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
}

async function getPredictBook(marketId, apiKey) {
  const data = await json(`${PREDICT}/markets/${encodeURIComponent(marketId)}/orderbook`,
    { headers: { 'x-api-key': apiKey } });
  return data.data || data.orderbook || data;
}

async function getPolyMarket(id) { return json(`${GAMMA}/markets/${encodeURIComponent(id)}`); }
async function getPredictMarket(id, apiKey) {
  const data = await json(`${PREDICT}/markets/${encodeURIComponent(id)}`, { headers: { 'x-api-key': apiKey } });
  return data.data || data.market || data;
}

module.exports = { getPolymarketMarkets, getPredictMarkets, getPolyBook, getPredictBook,
  getPolyMarket, getPredictMarket };
