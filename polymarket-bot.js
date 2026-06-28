'use strict';

const WebSocket        = require('ws');
const PolymarketTrader = require('./polymarket-trader');

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const TICK_MS           = 500;
const DISCOVER_EVERY_MS = 15000;
const WINDOW_SECS       = 300;
const TARGET_PAIRS      = ['BTC'];

// Accumulation strategy params
const UP_INTERVAL    = 10000;  // ms
const DOWN_INTERVAL  = 10000;  // ms
const SELL_AT_SECS   = 270;    // 4.5 min – stop accumulation, place sells
const SELL_PRICE     = 0.99;
const BUY_SLIP       = 0.02;   // buy at mid - 0.02

let dryRun = process.env.DRY_RUN === 'true';
const DEMO_BALANCE = parseFloat(process.env.DEMO_BALANCE || '1000');

let emitFn     = () => {};
let slog       = () => {};
let trader     = null;
let cashBalance = 0;
let startBalance = 0;
let startTime  = Date.now();

const logs     = [];
const trades   = [];
const markets  = {};
let lastDiscoverAt = 0;

// Per-market accumulation state
const accState = {};

const f2 = v => Math.round((v || 0) * 100) / 100;
const f4 = v => Math.round((v || 0) * 10000) / 10000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts   = new Date().toTimeString().slice(0, 8);
  const line = `[${ts}] ${msg}`;
  logs.unshift(line);
  if (logs.length > 500) logs.length = 500;
  if (slog) slog(line);
}

async function getJSON(url) {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 10000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? r.json() : null;
  } catch (_) { return null; }
}

// ── Balance / Equity ──
function calcEquity() {
  let openValue = 0;
  for (const [slug, as] of Object.entries(accState)) {
    const m = markets[slug];
    if (!m) continue;
    if (as.resolved) {
      if (as.winner === 'up')   openValue += as.up.shares * 1.0;
      if (as.winner === 'down') openValue += as.down.shares * 1.0;
    } else {
      if (as.up.shares > 0 && !as.upSellFilled)
        openValue += as.up.shares * m.upMid;
      if (as.down.shares > 0 && !as.downSellFilled)
        openValue += as.down.shares * m.downMid;
    }
  }
  return cashBalance + openValue;
}

// ── WebSocket price feed ──
let ws = null, wsReady = false, wsPingTimer = null;
const wsTokenMap = {};

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log('Connecting WS...');
  ws = new WebSocket(CLOB_WS);
  ws.on('open', () => {
    wsReady = true;
    log('WS connected');
    const ids = Object.keys(wsTokenMap);
    if (ids.length) wsSubscribe(ids);
    wsPingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000);
  });
  ws.on('message', raw => {
    try {
      const msgs = JSON.parse(raw);
      const arr  = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of arr) {
        const t = msg.asset_id, p = parseFloat(msg.price || msg.mid_price || '0');
        if (!t || !p) continue;
        const slug = wsTokenMap[t];
        if (!slug || !markets[slug]) continue;
        const m = markets[slug];
        if (t === m.upTokenId) { m.upMid = f4(p); m.lastPriceAt = Date.now(); }
        if (t === m.downTokenId) { m.downMid = f4(p); m.lastPriceAt = Date.now(); }
      }
    } catch (_) {}
  });
  ws.on('close', () => {
    wsReady = false;
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    log('WS closed – reconnect 2s');
    setTimeout(wsConnect, 2000);
  });
  ws.on('error', e => { log(`WS err: ${e.message}`); try { ws.terminate(); } catch(_) {} });
}

function wsSubscribe(ids) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ auth: {}, type: 'market', assets_ids: ids }));
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
  if (!m.lastPriceAt || Date.now() - m.lastPriceAt > 3000) await restRefreshPrice(m);
}

function currentWindowStart() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / WINDOW_SECS) * WINDOW_SECS;
}

// ── Market Discovery ──
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

  const endTime = mk.endDate ? new Date(mk.endDate).getTime() : null;
  if (!endTime) return;
  const secsToEnd = (endTime - Date.now()) / 1000;
  if (secsToEnd < 10 || secsToEnd > WINDOW_SECS * 2) return;

  const upTokenId = ids[0], downTokenId = ids[1];
  let tickSize = '0.01', negRisk = false;
  try {
    const tsData = await getJSON(`${CLOB}/tick-size?token_id=${upTokenId}`);
    if (tsData?.minimum_tick_size) tickSize = tsData.minimum_tick_size;
    const nrData = await getJSON(`${CLOB}/neg-risk?token_id=${upTokenId}`);
    if (nrData?.neg_risk !== undefined) negRisk = nrData.neg_risk;
  } catch (_) {}

  // Save market info
  const marketInfo = {
    slug, pair: mk.question || pair, upTokenId, downTokenId,
    upMid: 0, downMid: 0, lastPriceAt: 0,
    endTime, windowStartMs: ws_ts * 1000,
    upTickSize: tickSize, dnTickSize: tickSize,
    upNegRisk: negRisk, dnNegRisk: negRisk,
    gammaId: mk.id || mk._id,  // save for resolution check
    outcomes: mk.outcomes || [],
    loopRunning: false, done: false,
  };

  markets[slug] = marketInfo;

  wsTokenMap[upTokenId] = slug;
  wsTokenMap[downTokenId] = slug;
  if (wsReady) wsSubscribe([upTokenId, downTokenId]);
  log(`Market ${pair}: ${slug}`);
  await restRefreshPrice(markets[slug]);
  log(`${pair} UP:${f4(markets[slug].upMid)} DOWN:${f4(markets[slug].downMid)}`);

  // Init accumulation state
  accState[slug] = {
    up:   { shares: 0, totalCost: 0, buyCount: 0 },
    down: { shares: 0, totalCost: 0, buyCount: 0 },
    phase: 'idle',     // idle → accumulating → selling → resolved
    lastUpBuy: 0,
    lastDownBuy: 0,
    sellUpOrderId: null,
    sellDownOrderId: null,
    resolved: false,
    winner: null,
    upSellFilled: false,
    downSellFilled: false,
    resolutionChecked: false,
  };

  tradeLoop(markets[slug]).catch(e => log(`Loop crash ${pair}: ${e.message}`));
}

async function discover() {
  const cw = currentWindowStart();
  const timestamps = [cw - WINDOW_SECS, cw, cw + WINDOW_SECS];
  await Promise.allSettled(timestamps.map(ep =>
    Promise.allSettled(TARGET_PAIRS.map(p => discoverMarket(p, ep)))
  ));
  // Cleanup old markets
  for (const [slug, m] of Object.entries(markets)) {
    if (Date.now() > m.endTime + 60000) {
      delete wsTokenMap[m.upTokenId];
      delete wsTokenMap[m.downTokenId];
      delete markets[slug];
      delete accState[slug];
    }
  }
}

// ── Check Polymarket resolution ──
async function checkResolution(m) {
  // Try multiple endpoints to find resolution data
  for (const endpoint of [
    `${GAMMA}/events?slug=${m.slug}`,
    m.gammaId ? `${GAMMA}/markets/${m.gammaId}` : null,
  ].filter(Boolean)) {
    try {
      const d = await getJSON(endpoint);
      if (!d) continue;
      // events endpoint returns array, markets endpoint returns object
      const mk = Array.isArray(d) ? d[0]?.markets?.[0] : d;
      if (!mk) continue;

      // Check closed status (various field names)
      const closed = mk.closed === true || mk.closed === 'true' || mk.status === 'closed' || mk.status === 'resolved';
      if (!closed) continue;

      // Try to find the winning outcome
      const outcome = mk.outcome || mk.winning_outcome || mk.winner_outcome || mk.resolved_outcome || '';
      const outcomes = mk.outcomes || [];

      // Match outcome name to index
      const outcomeIdx = outcomes.indexOf(outcome);
      if (outcomeIdx >= 0) {
        let ids;
        try { ids = JSON.parse(mk.clobTokenIds); } catch (_) { continue; }
        if (ids[outcomeIdx] === m.upTokenId) return 'up';
        if (ids[outcomeIdx] === m.downTokenId) return 'down';
      }

      // Fallback: winner field with token ID or side name
      const w = (mk.winner || '').toString().toLowerCase();
      if (w === m.upTokenId || w === 'up' || w === 'yes' || w === '1') return 'up';
      if (w === m.downTokenId || w === 'down' || w === 'no' || w === '0') return 'down';

      // Check winningOutcomeId field
      if (mk.winningOutcomeId === m.upTokenId) return 'up';
      if (mk.winningOutcomeId === m.downTokenId) return 'down';

      // Check if one side's price is at 1.0/0.0 after resolution
      // (Polymarket resolved tokens trade at $1 winner, $0 loser on secondary)
    } catch (_) { continue; }
  }
  return null;
}

// ── Place a buy order (demo or real) ──
async function placeBuy(m, side, shares) {
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;
  const mid = side === 'up' ? m.upMid : m.downMid;
  const buyPrice = f4(Math.max(mid - BUY_SLIP, 0.01));
  const cost = f2(shares * buyPrice);

  if (cashBalance < cost) {
    log(`INSUFFICIENT cash $${f2(cashBalance)} for ${side} ${shares}sh`);
    return null;
  }

  if (dryRun) {
    cashBalance = f2(cashBalance - cost);
    return { price: buyPrice, cost, orderId: 'demo_' + side + '_' + Date.now() };
  }

  try {
    const ord = await trader.placeGtcOrder(tokenId, 'BUY', buyPrice, shares);
    const orderId = ord?.id || null;
    if (orderId) {
      cashBalance = f2(cashBalance - cost);
      log(`BUY ${side} ${shares}sh@${f4(buyPrice)} id:${orderId.slice(0,10)}`);
      return { price: buyPrice, cost, orderId };
    }
  } catch (e) {
    log(`BUY err ${side}: ${e.message.slice(0,60)}`);
  }
  return null;
}

// ── Place sell at 0.99 ──
async function placeSell(m, side, shares) {
  if (shares <= 0) return null;
  const tokenId = side === 'up' ? m.upTokenId : m.downTokenId;

  if (dryRun) {
    log(`SELL ${side} ${shares}sh@${SELL_PRICE}`);
    return 'demo_' + side + '_sell';
  }

  try {
    const ord = await trader.placeGtcOrder(tokenId, 'SELL', SELL_PRICE, shares);
    if (ord?.id) {
      log(`SELL ${side} ${shares}sh@${SELL_PRICE} id:${ord.id.slice(0,10)}`);
      return ord.id;
    }
  } catch (e) {
    log(`SELL err ${side}: ${e.message.slice(0,60)}`);
  }
  return null;
}

// ── Cancel order ──
async function cancelOrder(orderId) {
  if (dryRun || !orderId) return;
  try { await trader.cancelOrder(orderId); } catch (_) {}
}

// ── Core Trade Loop (Accumulation Strategy) ──
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;
  const as = accState[m.slug];
  log(`Trade loop ${m.pair}`);

  // Wait for window to open
  if (m.windowStartMs > Date.now() + 2000) {
    const w = m.windowStartMs - Date.now();
    log(`${m.pair} window in ${Math.ceil(w/1000)}s`);
    await sleep(w);
  }

  // Start accumulation
  as.phase = 'accumulating';
  as.lastUpBuy = 0;
  as.lastDownBuy = 0;
  log(`${m.pair} accumulation started`);

  // Main loop
  let accumulationEnded = false;
  let resolveRetries = 0;
  while (true) {
    const now = Date.now();
    const elapsed = now - m.windowStartMs;
    // Keep loop alive for up to 10 minutes total (600s) for resolution checking
    if (elapsed >= 600000) break;

    await ensureFreshPrice(m);

    // Phase 1: Accumulation (0 to 270s)
    if (!accumulationEnded && elapsed < SELL_AT_SECS * 1000) {
      // UP buy every 10s
      if (elapsed - as.lastUpBuy >= UP_INTERVAL) {
        as.lastUpBuy = elapsed;
        const shares = elapsed < 150000 ? (m.upMid < 0.50 ? 20 : 10) : (m.upMid < 0.50 ? 10 : 20);
        const result = await placeBuy(m, 'up', shares);
        if (result) {
          as.up.shares += shares;
          as.up.totalCost = f2(as.up.totalCost + result.cost);
          as.up.buyCount++;
          log(`UP ACCUM ${shares}sh@${f4(result.price)} tot:${as.up.shares}sh cost:$${f2(as.up.totalCost)}`);
        }
      }

      // DOWN buy every 15s
      if (elapsed - as.lastDownBuy >= DOWN_INTERVAL) {
        as.lastDownBuy = elapsed;
        const shares = elapsed < 150000 ? (m.downMid < 0.50 ? 20 : 10) : (m.downMid < 0.50 ? 10 : 20);
        const result = await placeBuy(m, 'down', shares);
        if (result) {
          as.down.shares += shares;
          as.down.totalCost = f2(as.down.totalCost + result.cost);
          as.down.buyCount++;
          log(`DOWN ACCUM ${shares}sh@${f4(result.price)} tot:${as.down.shares}sh cost:$${f2(as.down.totalCost)}`);
        }
      }
    }

    // Phase 2: Place sells at 0.99 (at 270s)
    if (elapsed >= SELL_AT_SECS * 1000 && !accumulationEnded && m.upMid > 0 && m.downMid > 0) {
      accumulationEnded = true;
      as.phase = 'selling';
      log(`${m.pair} ACCUM ENDED at ${Math.floor(elapsed/1000)}s — placing sells@${SELL_PRICE}`);

      if (as.up.shares > 0) {
        const oid = await placeSell(m, 'up', as.up.shares);
        if (oid) as.sellUpOrderId = oid;
      }
      if (as.down.shares > 0) {
        const oid = await placeSell(m, 'down', as.down.shares);
        if (oid) as.sellDownOrderId = oid;
      }

      const total = as.up.totalCost + as.down.totalCost;
      log(`${m.pair} invested $${f2(total)} | UP ${as.up.shares}sh $${f2(as.up.totalCost)} | DOWN ${as.down.shares}sh $${f2(as.down.totalCost)}`);
    }

    // Phase 3: Check if 0.99 sells filled (demo: price >= 0.99)
    if (as.phase === 'selling' && !as.resolved) {
      if (dryRun) {
        if (as.up.shares > 0 && m.upMid >= SELL_PRICE && !as.upSellFilled) {
          const proceeds = f2(as.up.shares * SELL_PRICE);
          cashBalance = f2(cashBalance + proceeds);
          as.up.shares = 0;
          as.upSellFilled = true;
          log(`UP SELL FILLED @0.99 proceeds:$${proceeds}`);
        }
        if (as.down.shares > 0 && m.downMid >= SELL_PRICE && !as.downSellFilled) {
          const proceeds = f2(as.down.shares * SELL_PRICE);
          cashBalance = f2(cashBalance + proceeds);
          as.down.shares = 0;
          as.downSellFilled = true;
          log(`DOWN SELL FILLED @0.99 proceeds:$${proceeds}`);
        }
      } else {
        // Real: check via getOpenOrders
        try {
          const openOrders = await trader.getOpenOrders();
          const openIds = new Set((openOrders || []).map(o => o.id));
          if (as.sellUpOrderId && !as.upSellFilled && !openIds.has(as.sellUpOrderId)) {
            as.upSellFilled = true;
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            log(`UP SELL FILLED @0.99`);
          }
          if (as.sellDownOrderId && !as.downSellFilled && !openIds.has(as.sellDownOrderId)) {
            as.downSellFilled = true;
            try { const b = await trader.getBalance(); if (b > 0) cashBalance = b; } catch(_) {}
            log(`DOWN SELL FILLED @0.99`);
          }
        } catch (_) {}
      }
    }

    // Phase 4: Window ended – check resolution with retry
    // If both sides already sold at 0.99, skip resolution
    const bothSold = as.upSellFilled && as.downSellFilled;
    if (elapsed >= WINDOW_SECS * 1000 && !as.resolved && !bothSold) {
      if (!as.resolutionChecked || resolveRetries < 10) {
        if (!as.resolutionChecked) {
          as.resolutionChecked = true;
          as.phase = 'resolving';
          log(`${m.pair} window ended – checking resolution...`);
        }
        // Wait before each retry (first check immediate, then every 15s)
        if (resolveRetries > 0) {
          log(`${m.pair} resolution retry ${resolveRetries}/10...`);
          await sleep(15000);
        }
        resolveRetries++;

        const winner = await checkResolution(m);
        if (winner) {
          as.resolved = true;
          as.phase = 'resolved';
          as.winner = winner;
          log(`${m.pair} resolved: ${winner.toUpperCase()} wins`);

          if (winner === 'up' && as.up.shares > 0 && !as.upSellFilled) {
            const value = f2(as.up.shares * 1.0);
            cashBalance = f2(cashBalance + value);
            as.up.shares = 0;
            log(`UP credited $${value}`);
          }
          if (winner === 'down' && as.down.shares > 0 && !as.downSellFilled) {
            const value = f2(as.down.shares * 1.0);
            cashBalance = f2(cashBalance + value);
            as.down.shares = 0;
            log(`DOWN credited $${value}`);
          }

          const totalPnL = f2(cashBalance - startBalance);
          log(`${m.pair} final capital: $${f2(cashBalance)} PnL: $${totalPnL}`);
        } else if (resolveRetries >= 10) {
          log(`${m.pair} max retries reached – market unresolved`);
        }
      }
    }

    // If resolved, stop looping
    if (as.resolved) break;

    await sleep(TICK_MS);
  }

  // Final cleanup
  if (!as.resolved) {
    log(`${m.pair} unresolved – cleaning up`);
    if (as.sellUpOrderId) await cancelOrder(as.sellUpOrderId);
    if (as.sellDownOrderId) await cancelOrder(as.sellDownOrderId);
  }

  m.done = true;
  m.loopRunning = false;
  log(`${m.pair} loop finished`);
}

// ── Main tick ──
let lastEquityRecord = 0;
const equityHistory = [];

async function tick() {
  const now = Date.now();
  if (now - lastDiscoverAt >= DISCOVER_EVERY_MS) {
    lastDiscoverAt = now;
    await discover();
  }
  // Record equity every 5s
  if (now - lastEquityRecord >= 5000) {
    lastEquityRecord = now;
    equityHistory.push({ t: now - startTime, v: calcEquity() });
    if (equityHistory.length > 1000) equityHistory.splice(0, equityHistory.length - 1000);
  }
  emitFn('snapshot', snapshot());
}

function snapshot() {
  const equity = calcEquity();
  const pnl    = f2(equity - startBalance);

  const activeMarkets = Object.values(markets).map(m => {
    const as = accState[m.slug] || { up: { shares: 0, totalCost: 0, buyCount: 0 }, down: { shares: 0, totalCost: 0, buyCount: 0 }, phase: 'idle', resolved: false, winner: null, upSellFilled: false, downSellFilled: false };
    const elapsed = Math.max(0, (Date.now() - m.windowStartMs) / 1000);
    return {
      slug: m.slug, pair: m.pair,
      upMid: f4(m.upMid), dnMid: f4(m.downMid),
      secsLeft: Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
      elapsed: Math.floor(elapsed),
      phase: as.phase,
      resolved: as.resolved, winner: as.winner,
      upShares: as.up.shares, upCost: f2(as.up.totalCost), upBuys: as.up.buyCount, upSellFilled: as.upSellFilled,
      dnShares: as.down.shares, dnCost: f2(as.down.totalCost), dnBuys: as.down.buyCount, dnSellFilled: as.downSellFilled,
    };
  });

  return {
    dryRun, balance: f2(equity), cashBalance: f2(cashBalance),
    startBalance: f2(startBalance), pnl,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeMarkets, totalTrades: 0,
    recentTrades: [],
    activityLog: logs.slice(0, 80),
    equityHistory: equityHistory.slice(-500),
    strategy: {
      dryRun, demoBalance: DEMO_BALANCE,
      upInterval: UP_INTERVAL/1000, downInterval: DOWN_INTERVAL/1000,
      sellAt: SELL_AT_SECS, sellPrice: SELL_PRICE, slip: BUY_SLIP,
    },
  };
}

async function setDryRun(v) {
  dryRun = !!v;
  if (dryRun) { cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE; }
  log(`Dry-run: ${dryRun ? 'ON $' + DEMO_BALANCE : 'OFF'}`);
  equityHistory.length = 0;
  if (!dryRun && trader) {
    try { const b = await trader.getBalance(); if (b > 0) { cashBalance = b; startBalance = b; } } catch (_) {}
  }
}
function getDryRun() { return dryRun; }

async function start(emit, logFn) {
  emitFn = emit || (() => {});
  slog = logFn || (() => {});
  startTime = Date.now();
  if (!process.env.POLYMARKET_PRIVATE_KEY) { console.error('No private key'); process.exit(1); }

  try {
    trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY);
    trader.setLogFn(log);
    log('Authenticating...');
    await trader.authenticate();
    log(`Auth: ${trader.address}`);
    if (dryRun) { cashBalance = DEMO_BALANCE; startBalance = DEMO_BALANCE; log(`DEMO $${f2(cashBalance)}`); }
    else { const b = await trader.getBalance(); if (b > 0) { cashBalance = b; startBalance = b; } log(`LIVE $${f2(cashBalance)}`); }
  } catch (e) { log(`Auth fail: ${e.message}`); process.exit(1); }

  wsConnect();
  log('Starting main loop');
  setInterval(tick, TICK_MS);
}

module.exports = { start, snapshot, setDryRun, getDryRun };
