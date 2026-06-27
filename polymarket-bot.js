'use strict';

const WebSocket        = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Timing ──
const TICK_MS           = 500;
const DISCOVER_EVERY_MS = 15000;
const WINDOW_SECS       = 300;

// ── Strategy ──
const ENTRY_WAIT_SECS  = 10;
const SHARES           = 6;
const TRAILING_DIST    = 0.05;
const FORCE_CLOSE_SECS = 30;   // trigger sell at 4m30s (30s before end)
const HARD_SELL_SECS   = 15;   // absolute sell deadline — after this, shares auto-resolve

// ── Price guard — do NOT enter if price is outside this range ──
// Prices <0.10 or >0.90 mean the market is nearly decided, book is empty
const MIN_ENTRY_PRICE  = 0.10;
const MAX_ENTRY_PRICE  = 0.90;

// ── Order config ──
const FOK_RETRY_MS     = 2000;  // retry FOK buy every 2s if nofill
const FOK_SELL_RETRY_MS = 500;  // retry FOK sell every 500ms

const TARGET_PAIRS = ['BTC', 'ETH'];

let emitFn     = () => {};
let slog       = () => {};
let trader     = null;
let balance    = 0;
let startBalance = 0;
let startTime  = Date.now();

const logs   = [];
const trades = [];
const markets = {};

let lastDiscoverAt = 0;

// ── Helpers ──
const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts   = new Date().toTimeString().slice(0, 8);
  const line = `[${ts}] ${msg}`;
  logs.unshift(line);
  if (logs.length > 300) logs.length = 300;
  if (slog) slog(line);
}

async function getJSON(url) {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 8000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? r.json() : null;
  } catch (_) { return null; }
}

// ── WebSocket price feed ──
let ws           = null;
let wsReady      = false;
let wsPingTimer  = null;
const wsTokenMap = {};

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log('🔌 Connecting price WebSocket…');
  ws = new WebSocket(CLOB_WS);

  ws.on('open', () => {
    wsReady = true;
    log('✅ Price WebSocket connected');
    const tokenIds = Object.keys(wsTokenMap);
    if (tokenIds.length > 0) wsSubscribe(tokenIds);
    wsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20000);
  });

  ws.on('message', (raw) => {
    try {
      const msgs = JSON.parse(raw);
      const arr  = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of arr) {
        const tokenId = msg.asset_id;
        const price   = parseFloat(msg.price || msg.mid_price || '0');
        if (!tokenId || !price) continue;
        const slug = wsTokenMap[tokenId];
        if (!slug || !markets[slug]) continue;
        const m = markets[slug];
        if (tokenId === m.upTokenId)   { m.upMid  = f4(price); m.lastPriceAt = Date.now(); }
        if (tokenId === m.downTokenId) { m.downMid = f4(price); m.lastPriceAt = Date.now(); }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    wsReady = false;
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    log('⚠️  Price WebSocket closed — reconnecting in 2s');
    setTimeout(wsConnect, 2000);
  });

  ws.on('error', (e) => {
    log(`⚠️  WS error: ${e.message}`);
    try { ws.terminate(); } catch (_) {}
  });
}

function wsSubscribe(tokenIds) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Lowercase 'market' is required by Polymarket CLOB WS
  ws.send(JSON.stringify({ auth: {}, type: 'market', assets_ids: tokenIds }));
}

async function restRefreshPrice(m) {
  const [ur, dr] = await Promise.all([
    getJSON(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
    getJSON(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
  ]);
  if (ur?.mid) m.upMid   = f4(parseFloat(ur.mid));
  if (dr?.mid) m.downMid = f4(parseFloat(dr.mid));
  m.lastPriceAt = Date.now();
}

async function ensureFreshPrice(m) {
  const stale = !m.lastPriceAt || (Date.now() - m.lastPriceAt) > 3000;
  if (stale) await restRefreshPrice(m);
}

// ── Market Discovery ──
function currentWindowStart() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
}

async function discoverMarket(pair) {
  const ws_ts = currentWindowStart();
  const slug  = `${pair.toLowerCase()}-updown-5m-${ws_ts}`;
  if (markets[slug]) return;

  const d = await getJSON(`${GAMMA}/events?slug=${slug}`);
  if (!Array.isArray(d) || !d[0]?.markets?.[0]) return;

  const mk = d[0].markets[0];
  if (!mk.clobTokenIds) return;

  let ids;
  try { ids = JSON.parse(mk.clobTokenIds); } catch (_) { return; }
  if (ids.length < 2) return;

  const endTime = mk.endDate ? new Date(mk.endDate).getTime() : null;
  if (!endTime) return;

  const secsToEnd = (endTime - Date.now()) / 1000;
  if (secsToEnd < 10 || secsToEnd > WINDOW_SECS + 30) return;

  const upTokenId   = ids[0];
  const downTokenId = ids[1];

  let tickSize = '0.01';
  let negRisk  = false;
  try {
    const tsData = await getJSON(`${CLOB}/tick-size?token_id=${upTokenId}`);
    if (tsData?.minimum_tick_size) tickSize = tsData.minimum_tick_size;
    const nrData = await getJSON(`${CLOB}/neg-risk?token_id=${upTokenId}`);
    if (nrData?.neg_risk !== undefined) negRisk = nrData.neg_risk;
  } catch (_) {}

  const windowStartMs = ws_ts * 1000;

  markets[slug] = {
    slug, pair,
    upTokenId, downTokenId,
    upMid: 0, downMid: 0,
    lastPriceAt: 0,
    endTime,
    windowStartMs,
    upTickSize: tickSize, dnTickSize: tickSize,
    upNegRisk: negRisk, dnNegRisk: negRisk,
    loopRunning: false,
    done: false,
  };

  wsTokenMap[upTokenId]   = slug;
  wsTokenMap[downTokenId] = slug;

  // Subscribe if WS already open
  if (wsReady) wsSubscribe([upTokenId, downTokenId]);
  log(`📡 ${pair} market: ${slug}`);

  // Prime initial prices
  await restRefreshPrice(markets[slug]);
  log(`📊 ${pair} UP:${f4(markets[slug].upMid)} DOWN:${f4(markets[slug].downMid)}`);

  tradeLoop(markets[slug]).catch(e => log(`❌ Loop crash ${pair}: ${e.message}`));
}

async function discover() {
  await Promise.allSettled(TARGET_PAIRS.map(p => discoverMarket(p)));
  for (const [slug, m] of Object.entries(markets)) {
    if (Date.now() > m.endTime + 15000) {
      delete wsTokenMap[m.upTokenId];
      delete wsTokenMap[m.downTokenId];
      delete markets[slug];
    }
  }
}

// ── Entry: FOK limit order with exact share count + poll confirmation ──
// Places a FOK limit order for exactly SHARES shares at the current mid price.
// Then polls getOrder() for 5s to CONFIRM fill before returning.
// Never places a second order unless the first is confirmed cancelled.
async function buyShares(m, side) {
  const tokenId  = side === 'up' ? m.upTokenId  : m.downTokenId;
  const tickSize = side === 'up' ? m.upTickSize  : m.dnTickSize;
  const negRisk  = side === 'up' ? m.upNegRisk   : m.dnNegRisk;
  const { Side, OrderType } = require('@polymarket/clob-client-v2');

  let attempt = 0;
  while (true) {
    const secsLeft = (m.endTime - Date.now()) / 1000;
    if (secsLeft <= FORCE_CLOSE_SECS) {
      log(`⏳ ${m.pair} no time to enter (${Math.floor(secsLeft)}s left)`);
      return null;
    }

    await ensureFreshPrice(m);
    const price = side === 'up' ? m.upMid : m.downMid;

    if (price < MIN_ENTRY_PRICE || price > MAX_ENTRY_PRICE) {
      log(`⛔ ${m.pair} ${side.toUpperCase()} price ${f4(price)} outside safe range [${MIN_ENTRY_PRICE}–${MAX_ENTRY_PRICE}], skip`);
      return null;
    }

    attempt++;
    log(`🛒 ${m.pair} BUY ${side.toUpperCase()} ${SHARES}sh @ ${f4(price)} FOK attempt #${attempt}`);

    try {
      // FOK limit order with exact price + share count = guarantees exactly SHARES shares if filled
      const resp = await trader._clob.createAndPostOrder(
        { tokenID: tokenId, price: f4(price), size: SHARES, side: Side.BUY },
        { tickSize, negRisk },
        OrderType.FOK
      );
      const id        = resp?.orderID ?? resp?.id ?? null;
      const fillPrice = parseFloat(resp?.avg_fill_price || resp?.price || price);

      if (id) {
        // Poll CLOB to CONFIRM fill — don't trust the initial response alone
        const confirm = await trader.waitForFill(id, 5000);
        if (confirm.filled) {
          log(`✅ BUY confirmed ${m.pair} ${side.toUpperCase()} ${SHARES}sh@${f4(fillPrice)}`);
          const cost = f2(SHARES * fillPrice);
          balance = f2(balance - cost);
          log(`💰 Balance: $${f2(balance)} (-$${cost})`);
          return fillPrice;
        }
        log(`⏭️  FOK nofill ${m.pair} ${side.toUpperCase()} — order cancelled or timeout`);
      } else {
        log(`⏭️  FOK rejected ${m.pair} ${side.toUpperCase()} — no orderID returned`);
      }
    } catch (e) {
      log(`⚠️  FOK BUY error ${m.pair}: ${e.message.slice(0, 80)} — retry`);
    }

    await sleep(FOK_RETRY_MS);
  }
}

// ── Exit: FOK limit order with exact share count + poll confirmation ──
async function sellShares(m, side, reason) {
  const tokenId  = side === 'up' ? m.upTokenId  : m.downTokenId;
  const tickSize = side === 'up' ? m.upTickSize  : m.dnTickSize;
  const negRisk  = side === 'up' ? m.upNegRisk   : m.dnNegRisk;
  const { Side, OrderType } = require('@polymarket/clob-client-v2');

  log(`📤 ${m.pair} SELL ${side.toUpperCase()} ${SHARES}sh — ${reason}`);

  let attempt = 0;
  while (true) {
    const secsLeft = (m.endTime - Date.now()) / 1000;

    if (secsLeft < HARD_SELL_SECS) {
      log(`⌛ ${m.pair} HARD DEADLINE (${Math.floor(secsLeft)}s left) — shares auto-resolve on-chain`);
      return false;
    }

    await ensureFreshPrice(m);
    const price = side === 'up' ? m.upMid : m.downMid;

    attempt++;
    log(`📤 ${m.pair} SELL attempt #${attempt} ${SHARES}sh @ ${f4(price)} (${Math.floor(secsLeft)}s left)`);

    try {
      // FOK limit order with exact share count
      const resp = await trader._clob.createAndPostOrder(
        { tokenID: tokenId, price: f4(price), size: SHARES, side: Side.SELL },
        { tickSize, negRisk },
        OrderType.FOK
      );
      const id = resp?.orderID ?? resp?.id ?? null;

      if (id) {
        // Poll CLOB to CONFIRM fill
        const confirm = await trader.waitForFill(id, 5000);
        if (confirm.filled) {
          const fillPrice = parseFloat(resp?.avg_fill_price || resp?.price || price);
          log(`✅ SELL confirmed ${m.pair} ${side.toUpperCase()} ${SHARES}sh@${f4(fillPrice)}`);
          const proceeds = f2(SHARES * fillPrice);
          balance = f2(balance + proceeds);
          log(`💰 Balance: $${f2(balance)} (+$${proceeds})`);
          return true;
        }
        log(`⏭️  FOK SELL nofill ${m.pair} ${side.toUpperCase()}, retry…`);
      } else {
        log(`⏭️  FOK SELL rejected ${m.pair} ${side.toUpperCase()} — no orderID`);
      }
    } catch (e) {
      log(`⚠️  FOK SELL error ${m.pair}: ${e.message.slice(0, 80)}, retrying…`);
    }

    await sleep(FOK_SELL_RETRY_MS);
  }
}

// ── Core Trade Loop — one per market, fully sequential ──
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;
  log(`🚀 ${m.pair} trade loop started`);

  // Wait 10s from window open
  const entryOpenAt = m.windowStartMs + ENTRY_WAIT_SECS * 1000;
  const waitMs      = entryOpenAt - Date.now();
  if (waitMs > 0) {
    log(`⏳ ${m.pair} waiting ${Math.ceil(waitMs / 1000)}s before entry`);
    await sleep(waitMs);
  }

  let currentSide = null;

  while (true) {
    const secsLeft = (m.endTime - Date.now()) / 1000;

    if (secsLeft <= 0) {
      log(`🏁 ${m.pair} window ended`);
      m.done = true; break;
    }

    if (secsLeft <= FORCE_CLOSE_SECS && currentSide === null) {
      log(`⏳ ${m.pair} ≤${FORCE_CLOSE_SECS}s left, no entry`);
      m.done = true; break;
    }

    // Pick side: cheapest on first entry, flip after each sell
    if (currentSide === null) {
      await ensureFreshPrice(m);
      currentSide = m.upMid <= m.downMid ? 'up' : 'down';
      log(`🎯 ${m.pair} cheapest = ${currentSide.toUpperCase()} (up:${f4(m.upMid)} dn:${f4(m.downMid)})`);
    }

    // ── BUY — FOK limit order, exact 6 shares ──
    const entryPrice = await buyShares(m, currentSide);
    if (entryPrice === null) {
      m.done = true; break;
    }

    trades.unshift({
      ts: new Date().toTimeString().slice(0, 8),
      pair: m.pair, side: currentSide.toUpperCase(),
      action: 'BUY', price: f4(entryPrice), shares: SHARES,
    });
    if (trades.length > 200) trades.length = 200;

    // ── TRAILING STOP WATCH — 200ms loop, refreshes price every 1s ──
    let peakPrice = entryPrice;
    log(`👀 ${m.pair} trailing watch — peak:${f4(peakPrice)}`);

    let sellReason = '';
    let refreshCounter = 0;
    while (true) {
      await sleep(200);

      // Refresh REST price every 5 ticks (1s) to ensure trailing stop works
      // even if WS feed is slow
      refreshCounter++;
      if (refreshCounter % 5 === 0) await ensureFreshPrice(m);

      const cp      = currentSide === 'up' ? m.upMid : m.downMid;
      const secsNow = (m.endTime - Date.now()) / 1000;

      if (cp > 0 && cp > peakPrice) {
        peakPrice = cp;
        log(`📈 ${m.pair} new peak ${f4(peakPrice)}`);
      }

      if (cp > 0 && (peakPrice - cp) >= TRAILING_DIST) {
        sellReason = `trailing stop (peak:${f4(peakPrice)} now:${f4(cp)} drop:${f4(peakPrice - cp)})`;
        break;
      }
      if (secsNow <= FORCE_CLOSE_SECS) {
        sellReason = `force close (${Math.floor(secsNow)}s left)`;
        break;
      }
    }

    log(`🔶 ${m.pair} ${currentSide.toUpperCase()} EXIT trigger — ${sellReason}`);

    // ── SELL ──
    const sold = await sellShares(m, currentSide, sellReason);

    if (sold) {
      // Use the actual sell price from the order response (already captured in sellShares)
      // but we don't return it, so use current midpoint as approximation
      const exitPrice = currentSide === 'up' ? m.upMid : m.downMid;
      const pnl       = f2((exitPrice - entryPrice) * SHARES);
      trades.unshift({
        ts: new Date().toTimeString().slice(0, 8),
        pair: m.pair, side: currentSide.toUpperCase(),
        action: 'SELL', price: f4(exitPrice), shares: SHARES, pnl,
      });
      if (trades.length > 200) trades.length = 200;
      log(`💰 ${m.pair} trade closed pnl:$${pnl}`);
    } else {
      // Sell failed — the position is stuck. Don't flip, don't retry.
      log(`❌ ${m.pair} SELL failed — position may still be open. Stopping this window.`);
      m.done = true; break;
    }

    // Time check before flipping
    const secsAfterSell = (m.endTime - Date.now()) / 1000;
    if (secsAfterSell <= FORCE_CLOSE_SECS) {
      log(`🏁 ${m.pair} no time for another trade (${Math.floor(secsAfterSell)}s left)`);
      m.done = true; break;
    }

    // ── FLIP SIDE ──
    const prev = currentSide;
    currentSide = currentSide === 'up' ? 'down' : 'up';
    log(`🔄 ${m.pair} FLIP ${prev.toUpperCase()} → ${currentSide.toUpperCase()}`);
  }

  log(`✅ ${m.pair} loop finished`);
  m.loopRunning = false;
}

// ── Main tick ──
async function tick() {
  const now = Date.now();
  if (now - lastDiscoverAt >= DISCOVER_EVERY_MS) {
    lastDiscoverAt = now;
    await discover();
  }
  emitFn('snapshot', snapshot());
}

// ── Snapshot ──
function snapshot() {
  const activeMarkets = Object.values(markets).map(m => ({
    slug:        m.slug,
    pair:        m.pair,
    upMid:       f4(m.upMid),
    dnMid:       f4(m.downMid),
    secsLeft:    Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
    loopRunning: m.loopRunning,
    done:        m.done,
  }));

  return {
    balance:      f2(balance),
    startBalance: f2(startBalance),
    pnl:          f2(balance - startBalance),
    uptime:       Math.floor((Date.now() - startTime) / 1000),
    activeMarkets,
    totalTrades:  trades.length,
    recentTrades: trades.slice(0, 60),
    activityLog:  logs.slice(0, 80),
    strategy: {
      shares:          SHARES,
      trailingDist:    TRAILING_DIST,
      entryWaitSecs:   ENTRY_WAIT_SECS,
      forceCloseSecs:  FORCE_CLOSE_SECS,
      minEntryPrice:   MIN_ENTRY_PRICE,
      maxEntryPrice:   MAX_ENTRY_PRICE,
    },
  };
}

// ── Stubs for index.js compatibility ──
async function setDryRun(dryRun) {
  log(`⚠️  setDryRun(${dryRun}) called — live-only bot, ignored`);
}
function getDryRun() { return false; }

// ── Start ──
async function start(emit, logFn) {
  emitFn    = emit   || (() => {});
  slog      = logFn  || (() => {});
  startTime = Date.now();

  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    console.error('❌ POLYMARKET_PRIVATE_KEY not set');
    process.exit(1);
  }

  try {
    trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY);
    trader.setLogFn(log);
    log('🔑 Authenticating…');
    await trader.authenticate();
    log(`✅ Auth: ${trader.address}`);
    const realBal = await trader.getBalance();
    if (realBal > 0) { balance = realBal; startBalance = realBal; }
    log(`💰 Balance: $${f2(balance)}`);
  } catch (e) {
    log(`❌ Auth failed: ${e.message}`);
    process.exit(1);
  }

  wsConnect();
  log('🔴 LIVE — starting main loop');
  setInterval(tick, TICK_MS);
}

module.exports = { start, snapshot, setDryRun, getDryRun };
