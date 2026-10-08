'use strict';

const WebSocket = require('ws');
const MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function positiveOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function bestFromBook(event) {
  const bids = (event.bids || []).map((x) => numberOrNull(x.price)).filter((x) => x != null);
  const asks = (event.asks || []).map((x) => numberOrNull(x.price)).filter((x) => x != null);
  return { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null };
}

function decodeMarketEvent(event) {
  if (!event || typeof event !== 'object') return [];
  const type = event.event_type || event.type;
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload : event;
  const assetId = payload.asset_id || payload.assetId
    || payload.token_id || payload.tokenId;

  if (type === 'book') {
    return [{ kind: 'quote', assetId, quote: bestFromBook(payload) }];
  }
  if (type === 'best_bid_ask') {
    return [{
      kind: 'quote', assetId,
      quote: {
        bid: numberOrNull(payload.best_bid ?? payload.bestBid),
        ask: numberOrNull(payload.best_ask ?? payload.bestAsk),
      },
    }];
  }
  if (type === 'price_change') {
    return (payload.price_changes || payload.priceChanges || []).map((change) => ({
      kind: 'quote',
      assetId: change.asset_id || change.assetId || change.token_id || change.tokenId,
      quote: {
        bid: numberOrNull(change.best_bid ?? change.bestBid),
        ask: numberOrNull(change.best_ask ?? change.bestAsk),
      },
    }));
  }
  if (type === 'last_trade_price') {
    return [{
      kind: 'trade',
      assetId,
      trade: {
        price: numberOrNull(payload.price),
        size: positiveOrNull(payload.size),
        side: String(payload.side || '').toUpperCase(),
        timestamp: payload.timestamp ?? null,
        transactionHash: payload.transaction_hash || payload.transactionHash || null,
      },
    }];
  }
  return [];
}

function startMarketFeed(assetIds, onQuote, onError = () => {}, onTrade = () => {}) {
  const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let staleTimer = null;
  let reconnectDelay = 1000;
  let lastMessageAt = Date.now();

  function report(error) {
    if (stopped) return;
    try { onError(error instanceof Error ? error : new Error(String(error))); } catch (_) {}
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function publish(assetId, bid, ask) {
    if (!assetId || !ids.includes(String(assetId))) return;
    try { onQuote(String(assetId), { bid, ask }); } catch (error) { report(error); }
  }

  function publishTrade(assetId, trade) {
    if (!assetId || !ids.includes(String(assetId))) return;
    try { onTrade(String(assetId), trade); } catch (error) { report(error); }
  }

  function handleEvent(event) {
    for (const decoded of decodeMarketEvent(event)) {
      if (decoded.kind === 'quote') {
        publish(decoded.assetId, decoded.quote.bid, decoded.quote.ask);
      } else if (decoded.kind === 'trade') {
        publishTrade(decoded.assetId, decoded.trade);
      }
    }
  }

  function connect() {
    if (stopped) return;
    try { socket = new WebSocket(MARKET_WS); }
    catch (error) { report(error); scheduleReconnect(); return; }
    socket.on('open', () => {
      reconnectDelay = 1000;
      lastMessageAt = Date.now();
      socket.send(JSON.stringify({ assets_ids: ids, custom_feature_enabled: true, type: 'market' }));
      clearInterval(heartbeatTimer);
      clearInterval(staleTimer);
      heartbeatTimer = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send('PING');
      }, 10_000);
      staleTimer = setInterval(() => {
        if (socket && Date.now() - lastMessageAt > 45_000) socket.terminate();
      }, 5_000);
    });
    socket.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'PONG') { lastMessageAt = Date.now(); return; }
      lastMessageAt = Date.now();
      try {
        const data = JSON.parse(text);
        for (const event of (Array.isArray(data) ? data : [data])) handleEvent(event);
      } catch (error) { report(new Error('CLOB WebSocket message: ' + error.message)); }
    });
    socket.on('error', (error) => report(new Error('CLOB WebSocket: ' + error.message)));
    socket.on('close', () => {
      clearInterval(heartbeatTimer);
      clearInterval(staleTimer);
      if (!stopped) scheduleReconnect();
    });
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    clearInterval(staleTimer);
    if (socket) { try { socket.close(); } catch (_) {} }
  };
}

module.exports = startMarketFeed;
module.exports.decodeMarketEvent = decodeMarketEvent;
