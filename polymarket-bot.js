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
const HARD_SELL_SECS   = 15;   // absolute sell deadline

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
  ws.send(JSON.stringify({ auth: {}, type: 'Market', assets_ids: tokenIds }));
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
  if (secsToEnd <= 0 || secsToEnd > WINDOW_SECS + 5) return;

  const windowStartMs = endTime - WINDOW_SECS * 1000;

  // Cache tickSize + negRisk — avoids 2 extra API calls on every order
  let upTickSize = '0.01', upNegRisk = false;
  let dnTickSize = '0.01', dnNegRisk = false;
  try {
    [upTickSize, upNegRisk, dnTickSize, dnNegRisk] = await Promise.all([
      trader._clob.getTickSize(ids[0]).catch(() => '0.01'),
      trader._clob.getNegRisk(ids[0]).catch(() => false),
      trader._clob.getTickSize(ids[1]).catch(() => '0.01'),
      trader._clob.getNegRisk(ids[1]).catch(() => false),
    ]);
  } catch (_) {}

  log(`🔍 ${pair} window found: ${slug} ends in ${Math.floor(secsToEnd)}s`);

  markets[slug] = {
    slug, pair,
    upTokenId: ids[0], downTokenId: ids[1],
    endTime, windowStartMs,
    upMid: 0, downMid: 0, lastPriceAt: 0,
    loopRunning: false, done: false,
    upTickSize, upNegRisk, dnTickSize, dnNegRisk,
  };

  wsTokenMap[ids[0]] = slug;
  wsTokenMap[ids[1]] = slug;
  wsSubscribe([ids[0], ids[1]]);
  await restRefreshPrice(markets[slug]);

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

// ── Entry: FOK only, retry every 2s ──
// NO GTC — GTC fills silently after timeout and stacks positions
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

    // Price guard — skip if market is nearly decided (thin book, bad fills)
    if (price < MIN_ENTRY_PRICE || price > MAX_ENTRY_PRICE) {
      log(`⛔ ${m.pair} ${side.toUpperCase()} price ${f4(price)} outside safe range [${MIN_ENTRY_PRICE}–${MAX_ENTRY_PRICE}], skip`);
      return null;
    }

    const dollarAmount = f2(SHARES * price);
    attempt++;
    log(`🛒 ${m.pair} BUY ${side.toUpperCase()} ${SHARES}sh @ ~${f4(price)} ($${dollarAmount}) FOK attempt #${attempt}`);

    try {
      const resp = await trader._clob.createAndPostMarketOrder(
        { tokenID: tokenId, amount: dollarAmount, side: Side.BUY, orderType: OrderType.FOK },
        { tickSize, negRisk },
        OrderType.FOK
      );
      const id        = resp?.orderID ?? resp?.id ?? null;
      const status    = resp?.status || (id ? 'UNKNOWN' : 'FAILED');
      const remaining = parseFloat(resp?.remaining_size ?? '999');
      const isFilled  = status === 'FILLED' || (resp?.match_status || '').toLowerCase() === 'filled' || remaining === 0;
      const fillPrice = parseFloat(resp?.avg_fill_price || resp?.price || price);

      if (isFilled) {
        log(`✅ BUY filled ${m.pair} ${side.toUpperCase()} @${f4(fillPrice)} (attempt #${attempt})`);
        return fillPrice;
      }
      log(`⏭️  FOK nofill ${m.pair} ${side.toUpperCase()} — retry in ${FOK_RETRY_MS}ms`);
    } catch (e) {
      log(`⚠️  FOK BUY error ${m.pair}: ${e.message.slice(0, 80)} — retry`);
    }

    await sleep(FOK_RETRY_MS);
  }
}

// ── Exit: FOK only, hard retry until HARD_SELL_SECS ──
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

    attempt++;
    log(`📤 ${m.pair} SELL attempt #${attempt} (${Math.floor(secsLeft)}s left)`);

    try {
      const resp = await trader._clob.createAndPostMarketOrder(
        { tokenID: tokenId, amount: SHARES, side: Side.SELL, orderType: OrderType.FOK },
        { tickSize, negRisk },
        OrderType.FOK
      );
      const id        = resp?.orderID ?? resp?.id ?? null;
      const status    = resp?.status || (id ? 'UNKNOWN' : 'FAILED');
      const remaining = parseFloat(resp?.remaining_size ?? '999');
      const isFilled  = status === 'FILLED' || (resp?.match_status || '').toLowerCase() === 'filled' || remaining === 0;
      const fillPrice = parseFloat(resp?.avg_fill_price || resp?.price || '0');

      if (isFilled) {
        log(`✅ SELL confirmed ${m.pair} ${side.toUpperCase()} @${f4(fillPrice)} (attempt #${attempt})`);
        return true;
      }
      log(`⏭️  FOK SELL nofill ${m.pair} ${side.toUpperCase()}, retry in ${FOK_SELL_RETRY_MS}ms…`);
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

    // ── BUY — FOK only, no GTC ──
    const entryPrice = await buyShares(m, currentSide);
    if (entryPrice === null) {
      // Price outside safe range or ran out of time — stop trying
      m.done = true; break;
    }

    trades.unshift({
      ts: new Date().toTimeString().slice(0, 8),
      pair: m.pair, side: currentSide.toUpperCase(),
      action: 'BUY', price: f4(entryPrice), shares: SHARES,
    });
    if (trades.length > 200) trades.length = 200;

    // ── TRAILING STOP WATCH — 200ms loop, WS keeps price fresh ──
    let peakPrice = entryPrice;
    log(`👀 ${m.pair} trailing watch — peak:${f4(peakPrice)}`);

    let sellReason = '';
    while (true) {
      await sleep(200);

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
      const exitPrice = currentSide === 'up' ? m.upMid : m.downMid;
      const pnl       = f2((exitPrice - entryPrice) * SHARES);
      trades.unshift({
        ts: new Date().toTimeString().slice(0, 8),
        pair: m.pair, side: currentSide.toUpperCase(),
        action: 'SELL', price: f4(exitPrice), shares: SHARES, pnl,
      });
      if (trades.length > 200) trades.length = 200;
      log(`💰 ${m.pair} trade closed pnl:$${pnl}`);
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
async function setDryRun() { log('⚠️  setDryRun called — live-only bot, ignored'); }
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
