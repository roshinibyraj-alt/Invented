'use strict';

const WebSocket = require('ws');
const MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function bestFromBook(event) {
  const bids = (event.bids || []).map((x) => numberOrNull(x.price)).filter((x) => x != null);
  const asks = (event.asks || []).map((x) => numberOrNull(x.price)).filter((x) => x != null);
  return { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null };
}

function startMarketFeed(assetIds, onQuote, onError = () => {}) {
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

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    const type = event.event_type || event.type;
    if (type === 'book') {
      const q = bestFromBook(event);
      publish(event.asset_id || event.assetId, q.bid, q.ask);
      return;
    }
    if (type === 'best_bid_ask') {
      publish(event.asset_id || event.assetId, numberOrNull(event.best_bid ?? event.bestBid), numberOrNull(event.best_ask ?? event.bestAsk));
      return;
    }
    if (type === 'price_change') {
      for (const change of (event.price_changes || event.priceChanges || [])) {
        publish(change.asset_id || change.assetId || change.token_id || change.tokenId,
          numberOrNull(change.best_bid ?? change.bestBid), numberOrNull(change.best_ask ?? change.bestAsk));
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
