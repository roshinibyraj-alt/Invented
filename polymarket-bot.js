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
const FORCE_CLOSE_SECS = 30;
const HARD_SELL_SECS   = 15;

// ── Price guard ──
const MIN_ENTRY_PRICE  = 0.10;
const MAX_ENTRY_PRICE  = 0.90;

// ── Order config ──
const FOK_RETRY_MS     = 2000;
const FOK_SELL_RETRY_MS = 500;

const TARGET_PAIRS = ['BTC'];

// ── Demo / Dry-Run ──
let dryRun = process.env.DRY_RUN === 'true';
const DEMO_BALANCE = parseFloat(process.env.DEMO_BALANCE || '50');

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
  log('Connecting price WebSocket...');
  ws = new WebSocket(CLOB_WS);

  ws.on('open', () => {
    wsReady = true;
    log('Price WebSocket connected');
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
    log('Price WebSocket closed - reconnecting in 2s');
    setTimeout(wsConnect, 2000);
  });

  ws.on('error', (e) => {
    log(`WS error: ${e.message}`);
    try { ws.terminate(); } catch (_) {}
  });
}

function wsSubscribe(tokenIds) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
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

async function discoverMarket(pair, customWsTs) {
  const ws_ts = customWsTs || currentWindowStart();
  const slug  = `${pair.toLowerCase()}-updown-5m-${ws_ts}`;
  if (markets[slug]) return;

  const d = await getJSON(`${GAMMA}/events?slug=${slug}`);
  if (!Array.isArray(d) || !d[0]?.markets?.[0]) return;

  const mk = d[0].markets[0];
  if (!mk.clobTokenIds) return;

  let ids;
  try { ids = JSON.parse(mk.clobTokenIds); } catch (_) { return; }
  if (ids.length < 2) return;

  const upTokenId   = ids[0];
  const downTokenId = ids[1];

  const endTime = mk.endDate ? new Date(mk.endDate).getTime() : null;
  if (!endTime) return;

  const secsToEnd = (endTime - Date.now()) / 1000;
  if (secsToEnd < 10 || secsToEnd > WINDOW_SECS * 2) return;

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

  if (wsReady) wsSubscribe([upTokenId, downTokenId]);
  log(`Market ${pair}: ${slug}`);

  await restRefreshPrice(markets[slug]);
  log(`${pair} UP:${f4(markets[slug].upMid)} DOWN:${f4(markets[slug].downMid)}`);

  tradeLoop(markets[slug]).catch(e => log(`Loop crash ${pair}: ${e.message}`));
}

async function discover() {
  // Discover 3 windows: previous, current, next (reference bot pattern)
  const cw = currentWindowStart();
  const timestamps = [cw - WINDOW_SECS, cw, cw + WINDOW_SECS];
  await Promise.allSettled(timestamps.map(ep =>
    Promise.allSettled(TARGET_PAIRS.map(p => discoverMarket(p, ep)))
  ));
  for (const [slug, m] of Object.entries(markets)) {
    if (Date.now() > m.endTime + 15000) {
      delete wsTokenMap[m.upTokenId];
      delete wsTokenMap[m.downTokenId];
      delete markets[slug];
    }
  }
}

// ── BUY - exact 6 shares via FOK at best ask ──
async function buyShares(m, side, fixedPrice) {
  const tokenId  = side === 'up' ? m.upTokenId  : m.downTokenId;
  const tickSize = side === 'up' ? m.upTickSize  : m.dnTickSize;
  const negRisk  = side === 'up' ? m.upNegRisk   : m.dnNegRisk;
  const { Side, OrderType } = require('@polymarket/clob-client-v2');

  let attempt = 0;
  while (true) {
    const secsLeft = (m.endTime - Date.now()) / 1000;
    if (secsLeft <= FORCE_CLOSE_SECS) {
      log(`${m.pair} no time to enter (${Math.floor(secsLeft)}s left)`);
      return null;
    }

    let price = fixedPrice;

    // Demo mode: skip real order book, use fixedPrice directly
    if (!dryRun) {
      try {
        const ba = await trader.getBestBidAsk(tokenId);
        if (ba && ba.bestAsk && ba.bestAsk > 0) {
          price = ba.bestAsk;
        }
      } catch (_) {}
    }
    
    if (price < MIN_ENTRY_PRICE || price > MAX_ENTRY_PRICE) {
      log(`${m.pair} ${side.toUpperCase()} price ${f4(price)} outside safe range, skip`);
      return null;
    }

    attempt++;
    log(`${m.pair} BUY ${side.toUpperCase()} ${SHARES}sh @ ${f4(price)} FOK #${attempt}`);

    if (dryRun) {
      const cost = f2(SHARES * price);
      if (balance < cost) {
        log(`${m.pair} DEMO insufficient balance $${f2(balance)}`);
        return null;
      }
      balance = f2(balance - cost);
      log(`DEMO FILLED BUY ${m.pair} ${side.toUpperCase()} ${SHARES}sh@${f4(price)}`);
      log(`Balance: $${f2(balance)}`);
      return price;
    }

    const balBefore = await trader.getBalance();
    try {
      await trader._clob.createAndPostOrder(
        { tokenID: tokenId, price: f4(price), size: SHARES, side: Side.BUY },
        { tickSize, negRisk },
        OrderType.FOK
      );
    } catch (e) {
      log(`BUY ERR ${m.pair}: ${e.message.slice(0, 80)}`);
    }

    const balAfter = await trader.getBalance();
    const drop = f2(balBefore - balAfter);
    const expectedDrop = f2(SHARES * price);
    if (drop >= expectedDrop * 0.5) {
      balance = balAfter;
      log(`FILLED BUY ${m.pair} ${side.toUpperCase()} ${SHARES}sh cost~$${drop}`);
      log(`Balance: $${f2(balance)}`);
      await sleep(2000);
      return price;
    }

    log(`NOFILL BUY ${m.pair} (bal dropped $${drop}) - retry`);
    await sleep(FOK_RETRY_MS);
  }
}

// ── SELL - exact 6 shares via FOK at best bid ──
async function sellShares(m, side, reason) {
  const tokenId  = side === 'up' ? m.upTokenId  : m.downTokenId;
  const tickSize = side === 'up' ? m.upTickSize  : m.dnTickSize;
  const negRisk  = side === 'up' ? m.upNegRisk   : m.dnNegRisk;
  const { Side, OrderType } = require('@polymarket/clob-client-v2');

  log(`SELL ${m.pair} ${side.toUpperCase()} ${SHARES}sh - ${reason}`);

  let attempt = 0;
  while (true) {
    const secsLeft = (m.endTime - Date.now()) / 1000;
    if (secsLeft < HARD_SELL_SECS) {
      log(`DEADLINE ${m.pair} (${Math.floor(secsLeft)}s left) - auto-resolve`);
      return false;
    }

    let price = side === 'up' ? m.upMid : m.downMid;

    // Demo mode: skip real order book
    if (!dryRun) {
      try {
        const ba = await trader.getBestBidAsk(tokenId);
        if (ba && ba.bestBid && ba.bestBid > 0) {
          price = ba.bestBid;
        }
      } catch (_) {}
    }

    attempt++;
    log(`SELL #${attempt} ${m.pair} ${SHARES}sh @ ${f4(price)} (${Math.floor(secsLeft)}s left)`);

    if (dryRun) {
      const proceeds = f2(SHARES * price);
      balance = f2(balance + proceeds);
      log(`DEMO FILLED SELL ${m.pair} ${side.toUpperCase()} @${f4(price)}`);
      log(`Balance: $${f2(balance)}`);
      return true;
    }

    const balBefore = await trader.getBalance();
    try {
      await trader._clob.createAndPostOrder(
        { tokenID: tokenId, price: f4(price), size: SHARES, side: Side.SELL },
        { tickSize, negRisk },
        OrderType.FOK
      );
    } catch (e) {
      log(`SELL ERR ${m.pair}: ${e.message.slice(0, 80)}`);
    }

    const balAfter = await trader.getBalance();
    const rise = f2(balAfter - balBefore);
    const expectedRise = f2(SHARES * price);
    if (rise >= expectedRise * 0.5) {
      balance = balAfter;
      log(`FILLED SELL ${m.pair} ${side.toUpperCase()} ${SHARES}sh proceeds~$${rise}`);
      log(`Balance: $${f2(balance)}`);
      await sleep(2000);
      return true;
    }

    log(`NOFILL SELL ${m.pair} (bal rose $${rise}) - retry`);
    await sleep(FOK_SELL_RETRY_MS);
  }
}

// ── Core Trade Loop ──
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;
  log(`Trade loop started ${m.pair}`);

  // If window hasn't started yet, wait until it opens
  const nowMs = Date.now();
  if (m.windowStartMs > nowMs + 5000) {
    const sleepMs = m.windowStartMs - nowMs;
    log(`${m.pair} window starts in ${Math.ceil(sleepMs / 1000)}s, waiting...`);
    await sleep(sleepMs);
  }

  const entryOpenAt = m.windowStartMs + ENTRY_WAIT_SECS * 1000;
  const waitMs      = entryOpenAt - Date.now();
  if (waitMs > 0) {
    log(`${m.pair} waiting ${Math.ceil(waitMs / 1000)}s before entry`);
    await sleep(waitMs);
  }

  let currentSide = null;

  while (true) {
    const secsLeft = (m.endTime - Date.now()) / 1000;

    if (secsLeft <= 0) {
      log(`${m.pair} window ended`);
      m.done = true; break;
    }

    if (secsLeft <= FORCE_CLOSE_SECS && currentSide === null) {
      log(`${m.pair} <=${FORCE_CLOSE_SECS}s left, no entry`);
      m.done = true; break;
    }

    // Pick cheapest side on first entry, then flip after each sell
    if (currentSide === null) {
      await ensureFreshPrice(m);
      currentSide = m.upMid <= m.downMid ? 'up' : 'down';
      log(`${m.pair} cheapest = ${currentSide.toUpperCase()} (up:${f4(m.upMid)} dn:${f4(m.downMid)})`);
    }

    // Use the price captured at cheapest-side check (no re-fetch inside buy)
    const buyPrice = currentSide === 'up' ? m.upMid : m.downMid;
    log(`${m.pair} entry price: ${f4(buyPrice)}`);

    // ── BUY ──
    const entryPrice = await buyShares(m, currentSide, buyPrice);
    if (entryPrice === null) {
      m.done = true; break;
    }

    trades.unshift({
      ts: new Date().toTimeString().slice(0, 8),
      pair: m.pair, side: currentSide.toUpperCase(),
      action: 'BUY', price: f4(entryPrice), shares: SHARES,
    });
    if (trades.length > 200) trades.length = 200;

    // ── TRAILING STOP WATCH ──
    let peakPrice = entryPrice;
    log(`${m.pair} trailing watch - peak:${f4(peakPrice)}`);

    let sellReason = '';
    let refreshCounter = 0;
    while (true) {
      await sleep(200);

      refreshCounter++;
      if (refreshCounter % 5 === 0) await ensureFreshPrice(m);

      const cp      = currentSide === 'up' ? m.upMid : m.downMid;
      const secsNow = (m.endTime - Date.now()) / 1000;

      if (cp > 0 && cp > peakPrice) {
        peakPrice = cp;
        log(`${m.pair} new peak ${f4(peakPrice)}`);
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

    log(`${m.pair} ${currentSide.toUpperCase()} EXIT trigger - ${sellReason}`);

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
      log(`${m.pair} trade closed pnl:$${pnl}`);
    } else {
      log(`${m.pair} SELL failed - position may still be open. Stopping.`);
      m.done = true; break;
    }

    const secsAfterSell = (m.endTime - Date.now()) / 1000;
    if (secsAfterSell <= FORCE_CLOSE_SECS) {
      log(`${m.pair} no time for another trade (${Math.floor(secsAfterSell)}s left)`);
      m.done = true; break;
    }

    // FLIP
    const prev = currentSide;
    currentSide = currentSide === 'up' ? 'down' : 'up';
    log(`${m.pair} FLIP ${prev.toUpperCase()} -> ${currentSide.toUpperCase()}`);
  }

  log(`${m.pair} loop finished`);
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
    dryRun:       dryRun,
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
      dryRun:          dryRun,
      demoBalance:     DEMO_BALANCE,
    },
  };
}

async function setDryRun(v) {
  dryRun = !!v;
  if (dryRun) {
    balance = DEMO_BALANCE;
    startBalance = DEMO_BALANCE;
  }
  log(`Dry-run mode: ${dryRun ? 'ON (demo $' + DEMO_BALANCE + ')' : 'OFF (live)'}`);
  // Re-fetch live balance when toggling back to live
  if (!dryRun && trader) {
    try {
      const realBal = await trader.getBalance();
      if (realBal > 0) { balance = realBal; startBalance = realBal; }
    } catch (_) {}
  }
}
function getDryRun() { return dryRun; }

async function start(emit, logFn) {
  emitFn    = emit   || (() => {});
  slog      = logFn  || (() => {});
  startTime = Date.now();

  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    console.error('POLYMARKET_PRIVATE_KEY not set');
    process.exit(1);
  }

  try {
    trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY);
    trader.setLogFn(log);
    log('Authenticating...');
    await trader.authenticate();
    log(`Auth: ${trader.address}`);
    if (dryRun) {
      balance = DEMO_BALANCE;
      startBalance = DEMO_BALANCE;
      log(`DEMO MODE - Balance: $${f2(balance)}`);
    } else {
      const realBal = await trader.getBalance();
      if (realBal > 0) { balance = realBal; startBalance = realBal; }
      log(`LIVE - Balance: $${f2(balance)}`);
    }
  } catch (e) {
    log(`Auth failed: ${e.message}`);
    process.exit(1);
  }

  wsConnect();
  log('LIVE - starting main loop');
  setInterval(tick, TICK_MS);
}

module.exports = { start, snapshot, setDryRun, getDryRun };
