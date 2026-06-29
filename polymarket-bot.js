'use strict';

const WebSocket        = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Window & timing ──
const WINDOW_SECS       = 300;
const DISCOVER_EVERY_MS = 15000;
const TICK_MS           = 500;

// ── Strategy config ──
const SHARES          = 6;          // shares per order attempt on each side
const PRICE_OFFSET    = 0.03;       // limit = ask - 0.03
const FILL_WAIT_MS    = 20000;      // cancel if not filled in 20 s
const ENTRY_INTERVAL  = 25;         // place orders every 25 s into window
const LAST_ENTRY_SECS = 125;        // last entry attempt at 125 s
const NUKE_SECS       = 230;        // at 230 s: force-sell any remaining position at market

const TARGET_PAIRS = ['BTC'];

// ── Runtime state ──
let emitFn       = () => {};
let slog         = () => {};
let trader       = null;
let balance      = 0;
let startBalance = 0;
let startTime    = Date.now();
const BOT_START_TIME = Date.now();

const logs    = [];
const trades  = [];
const markets = {};
let lastDiscoverAt  = 0;
let heartbeatId     = '';
let lastHeartbeatAt = 0;

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
let ws          = null;
let wsPingTimer = null;
const wsTokenMap = {};

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log('🔌 Connecting price WebSocket…');
  ws = new WebSocket(CLOB_WS);

  ws.on('open', () => {
    log('✅ Price WebSocket connected');
    const tokenIds = Object.keys(wsTokenMap);
    if (tokenIds.length > 0) wsSubscribe(tokenIds);
    wsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({}));
    }, 10000);
  });

  ws.on('message', (raw) => {
    try {
      const msgs = JSON.parse(raw);
      const arr  = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of arr) {
        if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
          for (const pc of msg.price_changes) updateMarketPrice(pc.asset_id, pc.best_bid, pc.best_ask);
        }
        if (msg.event_type === 'best_bid_ask') {
          updateMarketPrice(msg.asset_id, msg.best_bid, msg.best_ask);
        }
        if (msg.event_type === 'book') {
          const bestBid = msg.bids?.[0]?.price ? parseFloat(msg.bids[0].price) : null;
          const bestAsk = msg.asks?.[0]?.price ? parseFloat(msg.asks[0].price) : null;
          updateMarketPrice(msg.asset_id, bestBid, bestAsk);
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    log('⚠️  Price WebSocket closed — reconnecting in 2s');
    setTimeout(wsConnect, 2000);
  });

  ws.on('error', (e) => {
    log(`⚠️  WS error: ${e.message}`);
    try { ws.terminate(); } catch (_) {}
  });
}

function updateMarketPrice(tokenId, bestBid, bestAsk) {
  if (!tokenId) return;
  const slug = wsTokenMap[tokenId];
  if (!slug || !markets[slug]) return;
  const m   = markets[slug];
  const bid = bestBid ? f4(parseFloat(bestBid)) : null;
  const ask = bestAsk ? f4(parseFloat(bestAsk)) : null;
  if (tokenId === m.upTokenId) {
    if (bid) m.upBestBid = bid;
    if (ask) m.upBestAsk = ask;
    const b = m.upBestBid, a = m.upBestAsk;
    if (b && a) { m.upMid = f4((b + a) / 2); m.lastPriceAt = Date.now(); }
    else if (bid || ask) { m.upMid = bid || ask; m.lastPriceAt = Date.now(); }
  }
  if (tokenId === m.downTokenId) {
    if (bid) m.dnBestBid = bid;
    if (ask) m.dnBestAsk = ask;
    const b = m.dnBestBid, a = m.dnBestAsk;
    if (b && a) { m.downMid = f4((b + a) / 2); m.lastPriceAt = Date.now(); }
    else if (bid || ask) { m.downMid = bid || ask; m.lastPriceAt = Date.now(); }
  }
}

function wsSubscribe(tokenIds) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ assets_ids: tokenIds, type: 'market' }));
}

async function restRefreshPrice(m) {
  const [ur, dr, ubba, dbba] = await Promise.all([
    getJSON(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
    getJSON(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
    getJSON(`${CLOB}/book?token_id=${m.upTokenId}`),
    getJSON(`${CLOB}/book?token_id=${m.downTokenId}`),
  ]);
  if (ur?.mid)  m.upMid   = f4(parseFloat(ur.mid));
  if (dr?.mid)  m.downMid = f4(parseFloat(dr.mid));
  if (ubba?.bids?.[0]?.price) m.upBestBid = f4(parseFloat(ubba.bids[0].price));
  if (ubba?.asks?.[0]?.price) m.upBestAsk = f4(parseFloat(ubba.asks[0].price));
  if (dbba?.bids?.[0]?.price) m.dnBestBid = f4(parseFloat(dbba.bids[0].price));
  if (dbba?.asks?.[0]?.price) m.dnBestAsk = f4(parseFloat(dbba.asks[0].price));
  if (!m.upBestAsk && m.upMid)   { m.upBestAsk = f4(m.upMid + 0.01); m.upBestBid = f4(m.upMid - 0.01); }
  if (!m.dnBestAsk && m.downMid) { m.dnBestAsk = f4(m.downMid + 0.01); m.dnBestBid = f4(m.downMid - 0.01); }
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

  const windowStartMs    = endTime - WINDOW_SECS * 1000;
  const secsIntoWindow   = (Date.now() - windowStartMs) / 1000;

  // Allow joining as long as we're before the last entry point
  if (secsIntoWindow > LAST_ENTRY_SECS) {
    log(`⏭️  ${pair} window already past last entry (${Math.floor(secsIntoWindow)}s in) — waiting for next`);
    return;
  }

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

  log(`🔍 ${pair} window found: ${slug} ends in ${Math.floor(secsToEnd)}s (${Math.floor(secsIntoWindow)}s in)`);

  markets[slug] = {
    slug, pair,
    upTokenId: ids[0], downTokenId: ids[1],
    endTime, windowStartMs,
    upMid: 0.5, downMid: 0.5,
    upBestBid: 0, upBestAsk: 0,
    dnBestBid: 0, dnBestAsk: 0,
    lastPriceAt: 0,
    upTickSize, upNegRisk, dnTickSize, dnNegRisk,
    // ── Position tracking ──
    upShares:   0,    // confirmed filled UP shares
    downShares: 0,    // confirmed filled DOWN shares
    upCost:     0,    // total cost paid for UP shares
    downCost:   0,    // total cost paid for DOWN shares
    // ── State flags ──
    merging:    false,  // cash-out in progress
    nuking:     false,  // force-sell in progress
    done:       false,
    loopRunning: false,
    // ── Entry tracking ──
    lastEntryAt: 0,     // timestamp of last entry tick
    nextEntrySlot: 0,   // which 25s slot to attempt next (0,1,2,3,4,5)
  };

  wsTokenMap[ids[0]] = slug;
  wsTokenMap[ids[1]] = slug;
  wsSubscribe([ids[0], ids[1]]);
  await restRefreshPrice(markets[slug]);

  tradeLoop(markets[slug]).catch(e => log(`❌ Loop crash ${pair}: ${e.message}`));
}

// ─────────────────────────────────────────────────────────────
//  SINGLE-SIDE ENTRY: place GTC limit buy, wait up to 20s, cancel if not filled
//  Returns number of shares confirmed filled (0 or SHARES)
// ─────────────────────────────────────────────────────────────
async function tryEntry(m, side) {
  // side = 'up' or 'down'
  const isUp     = side === 'up';
  const tokenId  = isUp ? m.upTokenId  : m.downTokenId;
  const ask      = isUp ? m.upBestAsk  : m.dnBestAsk;
  const mid      = isUp ? m.upMid      : m.downMid;
  const tickSize = isUp ? m.upTickSize : m.dnTickSize;
  const negRisk  = isUp ? m.upNegRisk  : m.dnNegRisk;
  const label    = isUp ? 'UP' : 'DOWN';

  // Price rule: UP side only when price < 0.50, DOWN side only when price > 0.50
  const currentPrice = mid || ask || 0.5;
  if (isUp  && currentPrice >= 0.50) {
    log(`⏸  ${label} price ${currentPrice} >= 0.50 — skip`);
    return 0;
  }
  if (!isUp && currentPrice <= 0.50) {
    log(`⏸  ${label} price ${currentPrice} <= 0.50 — skip`);
    return 0;
  }

  if (!ask || ask <= 0) {
    log(`⚠️  ${label} no ask price available — skip`);
    return 0;
  }

  // Limit price = ask - 0.03, snapped to tick
  const tick     = parseFloat(tickSize) || 0.01;
  const rawPrice = ask - PRICE_OFFSET;
  const price    = f4(Math.max(0.01, Math.round(rawPrice / tick) * tick));

  if (price <= 0.01) {
    log(`⚠️  ${label} computed price ${price} too low — skip`);
    return 0;
  }

  log(`📥 Placing ${label} GTC limit BUY ${SHARES}sh @ ${price} (ask=${ask})`);

  let orderId;
  try {
    const resp = await trader.placeGtcOrder(tokenId, 'BUY', price, SHARES);
    orderId = resp?.id;
    if (!orderId) throw new Error('no orderID returned');
  } catch (e) {
    log(`❌ ${label} order placement failed: ${e.message}`);
    return 0;
  }

  // Poll for fill for up to FILL_WAIT_MS
  const deadline = Date.now() + FILL_WAIT_MS;
  let filled = false;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const order = await trader.getOrder(orderId);
      if (!order) continue;
      const status      = (order.status || '').toUpperCase();
      const matchStatus = (order.match_status || order.matchStatus || '').toLowerCase();
      const state       = (order.state || '').toLowerCase();
      if (status === 'FILLED' || matchStatus === 'filled' || state === 'filled') {
        filled = true;
        break;
      }
      if (status === 'CANCELLED' || matchStatus === 'cancelled') {
        log(`⚠️  ${label} order cancelled externally`);
        return 0;
      }
    } catch (_) {}
  }

  if (!filled) {
    // Cancel the unfilled order
    log(`⏰ ${label} order not filled in 20s — cancelling`);
    try { await trader.cancelOrder(orderId); } catch (_) {}
    return 0;
  }

  const cost = f4(price * SHARES);
  log(`✅ ${label} FILLED ${SHARES}sh @ ${price} (cost $${cost})`);

  if (isUp) {
    m.upShares += SHARES;
    m.upCost   += cost;
  } else {
    m.downShares += SHARES;
    m.downCost   += cost;
  }

  trades.push({
    time: new Date().toTimeString().slice(0, 8),
    pair: m.pair,
    side: label,
    shares: SHARES,
    price,
    cost,
  });

  emitFn('state', buildState());
  return SHARES;
}

// ─────────────────────────────────────────────────────────────
//  CASH OUT: both sides have 6 shares — sell both via GTC market bids
//  This is off-chain, no gas needed
// ─────────────────────────────────────────────────────────────
async function cashOut(m) {
  if (m.merging) return;
  m.merging = true;
  log(`💰 CASH OUT: ${m.upShares} UP + ${m.downShares} DOWN shares → selling both sides`);

  // Sell UP shares at best bid (or slightly above to ensure fill)
  const upSell   = async () => {
    await ensureFreshPrice(m);
    const bid   = m.upBestBid || f4((m.upMid || 0.5) - 0.01);
    const price = f4(Math.max(0.01, bid));
    log(`💸 Selling ${m.upShares} UP @ ${price}`);
    try {
      const r = await trader.placeGtcOrder(m.upTokenId, 'SELL', price, m.upShares);
      if (r?.id) {
        await trader.waitForFill(r.id, 15000);
        log(`✅ UP sell filled`);
      }
    } catch (e) { log(`⚠️  UP sell error: ${e.message}`); }
  };

  // Sell DOWN shares at best bid
  const downSell = async () => {
    await ensureFreshPrice(m);
    const bid   = m.dnBestBid || f4((m.downMid || 0.5) - 0.01);
    const price = f4(Math.max(0.01, bid));
    log(`💸 Selling ${m.downShares} DOWN @ ${price}`);
    try {
      const r = await trader.placeGtcOrder(m.downTokenId, 'SELL', price, m.downShares);
      if (r?.id) {
        await trader.waitForFill(r.id, 15000);
        log(`✅ DOWN sell filled`);
      }
    } catch (e) { log(`⚠️  DOWN sell error: ${e.message}`); }
  };

  // Run both sells in parallel
  await Promise.all([
    m.upShares   > 0 ? upSell()   : Promise.resolve(),
    m.downShares > 0 ? downSell() : Promise.resolve(),
  ]);

  const totalCost    = f4(m.upCost + m.downCost);
  const mergedValue  = f4(Math.min(m.upShares, m.downShares) * 1.0);
  log(`📊 Cash-out complete. Cost: $${totalCost} | Pairs merged value: $${mergedValue}`);

  m.upShares   = 0;
  m.downShares = 0;
  m.upCost     = 0;
  m.downCost   = 0;
  m.done       = true;

  balance = await trader.getBalance();
  emitFn('state', buildState());
}

// ─────────────────────────────────────────────────────────────
//  FORCE SELL at 230s: FOK market sell any remaining position
// ─────────────────────────────────────────────────────────────
async function forceSell(m) {
  if (m.nuking) return;
  m.nuking = true;
  log(`🚨 FORCE SELL at 230s — liquidating all positions`);

  const jobs = [];

  if (m.upShares > 0) {
    jobs.push((async () => {
      log(`🔥 Force-selling ${m.upShares} UP shares (FOK market)`);
      try {
        const r = await trader.placeFokSell(m.upTokenId, m.upShares);
        log(`🔥 UP force-sell → ${r.isFilled ? 'FILLED' : 'NOT FILLED'} avg:${r.avgPrice}`);
      } catch (e) { log(`⚠️  UP force-sell error: ${e.message}`); }
    })());
  }

  if (m.downShares > 0) {
    jobs.push((async () => {
      log(`🔥 Force-selling ${m.downShares} DOWN shares (FOK market)`);
      try {
        const r = await trader.placeFokSell(m.downTokenId, m.downShares);
        log(`🔥 DOWN force-sell → ${r.isFilled ? 'FILLED' : 'NOT FILLED'} avg:${r.avgPrice}`);
      } catch (e) { log(`⚠️  DOWN force-sell error: ${e.message}`); }
    })());
  }

  if (jobs.length === 0) {
    log(`✅ No positions to force-sell`);
  } else {
    await Promise.all(jobs);
  }

  m.upShares   = 0;
  m.downShares = 0;
  m.done       = true;

  balance = await trader.getBalance();
  emitFn('state', buildState());
}

// ─────────────────────────────────────────────────────────────
//  MAIN TRADE LOOP for one market window
// ─────────────────────────────────────────────────────────────
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;

  log(`🚀 Trade loop started for ${m.pair} | window ends ${new Date(m.endTime).toTimeString().slice(0,8)}`);

  // Figure out which 25s slots we've already passed
  const secsIntoWindow = () => (Date.now() - m.windowStartMs) / 1000;

  // The slots we attempt: 0s, 25s, 50s, 75s, 100s, 125s
  const entrySlots = [0, 25, 50, 75, 100, 125];
  let slotIndex = 0;

  // Fast-forward past already-elapsed slots (if bot joined mid-window)
  while (slotIndex < entrySlots.length && secsIntoWindow() > entrySlots[slotIndex] + 2) {
    log(`⏩ Skipping already-elapsed slot ${entrySlots[slotIndex]}s`);
    slotIndex++;
  }

  while (!m.done) {
    const secs = secsIntoWindow();

    // ── 230s: force-sell any remaining position ──
    if (secs >= NUKE_SECS && !m.nuking) {
      await forceSell(m);
      break;
    }

    // ── Check if we have a full set → cash out immediately ──
    if (m.upShares >= SHARES && m.downShares >= SHARES && !m.merging && !m.nuking) {
      await cashOut(m);
      break;
    }

    // ── Entry tick: is it time for the next 25s slot? ──
    if (slotIndex < entrySlots.length) {
      const targetSec = entrySlots[slotIndex];

      if (secs >= targetSec) {
        log(`⏱  Entry slot ${targetSec}s (secs into window: ${secs.toFixed(1)})`);
        slotIndex++;

        // Refresh prices before deciding
        await ensureFreshPrice(m);

        // Run both sides in parallel — each decides independently based on its own price
        await Promise.all([
          m.upShares   < SHARES && !m.merging ? tryEntry(m, 'up')   : Promise.resolve(),
          m.downShares < SHARES && !m.merging ? tryEntry(m, 'down') : Promise.resolve(),
        ]);

        // Check merge immediately after any fill
        if (m.upShares >= SHARES && m.downShares >= SHARES && !m.merging) {
          await cashOut(m);
          break;
        }

        emitFn('state', buildState());
      }
    }

    await sleep(TICK_MS);
  }

  log(`🏁 Trade loop ended for ${m.pair}`);
  m.loopRunning = false;
}

// ── Discovery loop ──
async function discoverLoop() {
  while (true) {
    if (trader && Date.now() - lastDiscoverAt > DISCOVER_EVERY_MS) {
      lastDiscoverAt = Date.now();
      for (const pair of TARGET_PAIRS) {
        await discoverMarket(pair).catch(e => log(`⚠️  Discover error ${pair}: ${e.message}`));
      }
    }
    await sleep(2000);
  }
}

// ── Heartbeat ──
async function heartbeatLoop() {
  while (true) {
    if (trader) {
      try {
        if (!heartbeatId) {
          const r = await trader._clob.createApiKey?.().catch(() => null);
          heartbeatId = r?.id || 'ok';
        }
        await trader._clob.getOk?.().catch(() => null);
        lastHeartbeatAt = Date.now();
      } catch (_) {}
    }
    await sleep(30000);
  }
}

// ─────────────────────────────────────────────────────────────
//  STATE for dashboard
// ─────────────────────────────────────────────────────────────
function buildState() {
  const mktList = Object.values(markets).map(m => {
    const secs = (Date.now() - m.windowStartMs) / 1000;
    return {
      slug:        m.slug,
      pair:        m.pair,
      secsIn:      Math.floor(secs),
      secsLeft:    Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
      upPrice:     m.upMid,
      downPrice:   m.downMid,
      upAsk:       m.upBestAsk,
      downAsk:     m.dnBestAsk,
      upBid:       m.upBestBid,
      downBid:     m.dnBestBid,
      upShares:    m.upShares,
      downShares:  m.downShares,
      upCost:      f2(m.upCost),
      downCost:    f2(m.downCost),
      totalCost:   f2(m.upCost + m.downCost),
      pnl:         f2((m.upShares + m.downShares) * 0 - m.upCost - m.downCost), // live pnl needs sell price
      merging:     m.merging,
      nuking:      m.nuking,
      done:        m.done,
    };
  });
  return {
    balance:      f2(balance),
    startBalance: f2(startBalance),
    pnl:          f2(balance - startBalance),
    uptime:       Math.floor((Date.now() - startTime) / 1000),
    markets:      mktList,
    trades:       trades.slice(-50),
    logs:         logs.slice(0, 80),
  };
}

// ─────────────────────────────────────────────────────────────
//  EXPORTS (called by server.js)
// ─────────────────────────────────────────────────────────────
async function init(privateKey, emit, serverLog) {
  emitFn = emit || (() => {});
  slog   = serverLog || (() => {});

  log('🤖 Sniper bot starting…');

  trader = new PolymarketTrader(privateKey);
  trader.setLogFn(log);

  await trader.authenticate();
  await trader.approveAllowance();

  balance      = await trader.getBalance();
  startBalance = balance;
  startTime    = Date.now();

  log(`💰 Balance: $${balance}`);

  wsConnect();
  discoverLoop().catch(e => log(`❌ Discover loop: ${e.message}`));
  heartbeatLoop().catch(() => {});

  // Emit state every 2s
  setInterval(() => emitFn('state', buildState()), 2000);
}

function getState() { return buildState(); }
function getLogs()  { return logs; }

module.exports = { init, getState, getLogs };
