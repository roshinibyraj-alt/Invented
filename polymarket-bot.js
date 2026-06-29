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

// ── Arbitrage Strategy Config ──
const ENTRY_WAIT_SECS  = 10;    // wait 10s after window open for prices to settle
const ARB_SHARES       = 6;     // shares to buy on each side per arb
const ARB_THRESHOLD    = 0.97;  // buy both when combined ask <= this (guaranteed profit on resolution)
const ARB_EXIT_PROFIT  = 0.995; // sell early if combined bid reaches this (lock in instant profit)
const FORCE_CLOSE_SECS = 10;    // no new entries in last 10s, attempt early-exit sell
const NUKE_SECS        = 5;     // T-5s: nuclear close of all open positions

// ── Order config ──
const SELL_RETRY_MS    = 300;

const TARGET_PAIRS = ['BTC'];

let emitFn       = () => {};
let slog         = () => {};
let trader       = null;
let balance      = 0;
let startBalance = 0;
let startTime    = Date.now();
const BOT_START_TIME = Date.now(); // used to skip mid-window markets on deploy

const logs    = [];
const trades  = [];
const markets = {};
let lastDiscoverAt  = 0;
let heartbeatId     = '';   // docs: use empty string for first call, then chain the returned id
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
// Docs: wss://ws-subscriptions-clob.polymarket.com/ws/market
// Subscribe with: { assets_ids: [...], type: "market" }  ← lowercase "market"
// price_change events give: best_bid, best_ask per asset_id
// book events give: full bids/asks snapshot on subscribe
let ws          = null;
let wsPingTimer = null;
const wsTokenMap = {}; // tokenId → slug

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log('🔌 Connecting price WebSocket…');
  ws = new WebSocket(CLOB_WS);

  ws.on('open', () => {
    log('✅ Price WebSocket connected');
    const tokenIds = Object.keys(wsTokenMap);
    if (tokenIds.length > 0) wsSubscribe(tokenIds);
    // Docs say to send ping every 10s
    wsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({}));
    }, 10000);
  });

  ws.on('message', (raw) => {
    try {
      const msgs = JSON.parse(raw);
      const arr  = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of arr) {
        // price_change: has price_changes array with best_bid/best_ask per asset
        if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
          for (const pc of msg.price_changes) {
            updateMarketPrice(pc.asset_id, pc.best_bid, pc.best_ask);
          }
        }
        // best_bid_ask: direct best_bid/best_ask per asset
        if (msg.event_type === 'best_bid_ask') {
          updateMarketPrice(msg.asset_id, msg.best_bid, msg.best_ask);
        }
        // book snapshot: first ask = best ask, first bid = best bid
        if (msg.event_type === 'book') {
          const bestBid = msg.bids?.[0]?.price ? parseFloat(msg.bids[0].price) : null;
          const bestAsk = msg.asks?.[0]?.price ? parseFloat(msg.asks[0].price) : null;
          updateMarketPrice(msg.asset_id, bestBid, bestAsk);
          // Also update midpoint for trailing stop
          if (bestBid && bestAsk) {
            const mid = f4((bestBid + bestAsk) / 2);
            const slug = wsTokenMap[msg.asset_id];
            if (slug && markets[slug]) {
              const m = markets[slug];
              if (msg.asset_id === m.upTokenId)   m.upMid  = mid;
              if (msg.asset_id === m.downTokenId)  m.downMid = mid;
              m.lastPriceAt = Date.now();
            }
          }
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
  const m = markets[slug];
  const bid = bestBid ? f4(parseFloat(bestBid)) : null;
  const ask = bestAsk ? f4(parseFloat(bestAsk)) : null;
  if (tokenId === m.upTokenId) {
    if (bid) m.upBestBid = bid;
    if (ask) m.upBestAsk = ask;
    // Update mid using whichever values we have — fall back to last known
    const b = m.upBestBid, a = m.upBestAsk;
    if (b && a) { m.upMid = f4((b + a) / 2); m.lastPriceAt = Date.now(); }
    else if (bid) { m.upMid = bid; m.lastPriceAt = Date.now(); }   // only bid arrived
    else if (ask) { m.upMid = ask; m.lastPriceAt = Date.now(); }   // only ask arrived
  }
  if (tokenId === m.downTokenId) {
    if (bid) m.dnBestBid = bid;
    if (ask) m.dnBestAsk = ask;
    const b = m.dnBestBid, a = m.dnBestAsk;
    if (b && a) { m.downMid = f4((b + a) / 2); m.lastPriceAt = Date.now(); }
    else if (bid) { m.downMid = bid; m.lastPriceAt = Date.now(); }
    else if (ask) { m.downMid = ask; m.lastPriceAt = Date.now(); }
  }
}

// Docs: subscription message format
function wsSubscribe(tokenIds) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    assets_ids: tokenIds,
    type: 'market',   // ← docs confirm lowercase "market"
  }));
}

// REST midpoint fallback if WS is stale >3s
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

// ── Order status check ──
// Docs confirmed exact status strings from GET /data/order/{orderID}:
//   ORDER_STATUS_LIVE     = still open
//   ORDER_STATUS_MATCHED  = filled ✅
//   ORDER_STATUS_CANCELED = cancelled
async function checkOrderStatus(orderId) {
  try {
    const order = await trader.getOrder(orderId);
    if (!order) return 'open';
    const s = order.status || '';
    if (s === 'ORDER_STATUS_MATCHED')  return 'filled';
    if (s === 'ORDER_STATUS_CANCELED' ||
        s === 'ORDER_STATUS_CANCELED_MARKET_RESOLVED' ||
        s === 'ORDER_STATUS_INVALID')  return 'cancelled';
    return 'open'; // ORDER_STATUS_LIVE or unknown
  } catch (_) { return 'open'; }
}

// Safe cancel: cancel then verify — catches ghost fills in the cancel window
async function safeCancel(orderId) {
  try { await trader.cancelOrder(orderId); } catch (_) {}
  await sleep(CANCEL_VERIFY_MS);
  return checkOrderStatus(orderId); // returns 'filled' | 'cancelled' | 'open'
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

  // Skip this window if we deployed mid-window — wait for the next clean window
  // A window is "clean" if the bot started before ENTRY_WAIT_SECS had elapsed
  const secsIntoWindow = (BOT_START_TIME - windowStartMs) / 1000;
  if (secsIntoWindow > ENTRY_WAIT_SECS) {
    log(`⏭️  ${pair} deployed mid-window (${Math.floor(secsIntoWindow)}s in) — skipping, waiting for next window`);
    return;
  }

  // Cache tickSize + negRisk once at discovery — avoids per-order API calls
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
    upBestBid: 0, upBestAsk: 0,
    dnBestBid: 0, dnBestAsk: 0,
    // arb state
    arbUpBought: false, arbDownBought: false, arbEntryPrice: 0, exitStarted: false,
    loopRunning: false, done: false,
    upTickSize, upNegRisk, dnTickSize, dnNegRisk,
  };

  wsTokenMap[ids[0]] = slug;
  wsTokenMap[ids[1]] = slug;
  wsSubscribe([ids[0], ids[1]]); // triggers book snapshot immediately
  await restRefreshPrice(markets[slug]); // seed mid before WS warms up

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

// Safe status extractor — clob client sometimes returns a plain string instead of {status, ...}
function respStatus(resp) {
  if (!resp) return '';
  if (typeof resp === 'string') return resp.toLowerCase();
  if (typeof resp.status === 'string') return resp.status.toLowerCase();
  return '';
}
function respError(resp) {
  if (!resp) return 'null response';
  if (typeof resp === 'string') return resp.slice(0, 150);
  return resp?.errorMsg || resp?.error || respStatus(resp) || 'unknown';
}

// ── Arbitrage Buy — FAK market order for one side ──
// amount = dollars (shares × ask), price = slippage cap
async function arbBuy(m, side) {
  const tokenId  = side === 'up' ? m.upTokenId  : m.downTokenId;
  const tickSize = side === 'up' ? m.upTickSize  : m.dnTickSize;
  const negRisk  = side === 'up' ? m.upNegRisk   : m.dnNegRisk;
  const { Side, OrderType } = require('@polymarket/clob-client-v2');

  const ask = side === 'up' ? m.upBestAsk : m.dnBestAsk;
  if (!ask || ask <= 0) {
    log(`⚠️  ${m.pair} ARB ${side.toUpperCase()} no ask price`);
    return false;
  }

  const spendAmount = f4(ARB_SHARES * ask);
  log(`🛒 ARB BUY ${side.toUpperCase()} ${ARB_SHARES}sh ~$${spendAmount} @ ${f4(ask)}`);

  try {
    const resp = await trader._clob.createAndPostMarketOrder(
      { tokenID: tokenId, side: Side.BUY, amount: spendAmount, price: ask },
      { tickSize, negRisk },
      OrderType.FAK
    );
    if (respStatus(resp) === 'matched') {
      log(`✅ ARB BUY ${side.toUpperCase()} filled @${f4(ask)}`);
      return true;
    }
    log(`❌ ARB BUY ${side.toUpperCase()} not filled: ${respError(resp)}`);
    return false;
  } catch (e) {
    log(`❌ ARB BUY ${side.toUpperCase()} error: ${e.message.slice(0, 120)}`);
    return false;
  }
}

// ── Arbitrage Sell — FOK market order, chases live bid each retry ──
// amount = shares, price = live bid (refreshed every attempt)
async function arbSell(m, side, label) {
  const tokenId  = side === 'up' ? m.upTokenId  : m.downTokenId;
  const tickSize = side === 'up' ? m.upTickSize  : m.dnTickSize;
  const negRisk  = side === 'up' ? m.upNegRisk   : m.dnNegRisk;
  const { Side, OrderType } = require('@polymarket/clob-client-v2');

  let attempt = 0;
  while (true) {
    const secsLeft = (m.endTime - Date.now()) / 1000;
    if (secsLeft < NUKE_SECS) {
      log(`⌛ ${m.pair} ${label} SELL ${side.toUpperCase()} — deadline, letting resolve on-chain`);
      return false;
    }

    await ensureFreshPrice(m);
    const bid = side === 'up'
      ? (m.upBestBid  || m.upMid)
      : (m.dnBestBid  || m.downMid);

    if (!bid || bid <= 0) { await sleep(SELL_RETRY_MS); continue; }

    attempt++;
    log(`📤 ${label} SELL ${side.toUpperCase()} ${ARB_SHARES}sh @ bid ${f4(bid)} — FOK #${attempt}`);
    try {
      const resp = await trader._clob.createAndPostMarketOrder(
        { tokenID: tokenId, side: Side.SELL, amount: ARB_SHARES, price: bid },
        { tickSize, negRisk },
        OrderType.FOK
      );
      if (respStatus(resp) === 'matched') {
        log(`✅ ${label} SELL ${side.toUpperCase()} filled @${f4(bid)}`);
        return true;
      }
      log(`🔁 ${label} SELL ${side.toUpperCase()} not filled (${respError(resp)}) — retry`);
    } catch (e) {
      log(`⚠️  ${label} SELL ${side.toUpperCase()} error: ${e.message.slice(0, 100)}`);
    }
    await sleep(SELL_RETRY_MS);
  }
}

// ── Nuclear Close — at T-5s sell every open arb position, no exceptions ──
const nukedMarkets = new Set();

async function emergencyCloseAll(m) {
  if (nukedMarkets.has(m.slug)) return;
  nukedMarkets.add(m.slug);
  log(`🚨 ${m.pair} NUKE — T-${NUKE_SECS}s force-sell ALL open arb positions`);
  const { Side, OrderType } = require('@polymarket/clob-client-v2');

  const sellSide = async (side) => {
    const tokenId  = side === 'up' ? m.upTokenId  : m.downTokenId;
    const tickSize = side === 'up' ? m.upTickSize  : m.dnTickSize;
    const negRisk  = side === 'up' ? m.upNegRisk   : m.dnNegRisk;
    let bid = side === 'up' ? (m.upBestBid || m.upMid) : (m.dnBestBid || m.downMid);
    if (!bid || bid <= 0) { log(`⚠️  NUKE ${side.toUpperCase()} no price`); return; }
    const floorPrice = Math.max(0.01, f4(bid * 0.80));
    try {
      const resp = await trader._clob.createAndPostMarketOrder(
        { tokenID: tokenId, side: Side.SELL, amount: ARB_SHARES, price: floorPrice },
        { tickSize, negRisk },
        OrderType.FOK
      );
      const st = respStatus(resp);
      if (st !== 'matched') {
        // FOK failed — FAK fallback
        const r2 = await trader._clob.createAndPostMarketOrder(
          { tokenID: tokenId, side: Side.SELL, amount: ARB_SHARES, price: floorPrice },
          { tickSize, negRisk },
          OrderType.FAK
        );
        log(`${respStatus(r2) === 'matched' ? '✅' : '❌'} NUKE FAK ${side.toUpperCase()}: ${respError(r2)}`);
      } else {
        log(`✅ NUKE SELL ${side.toUpperCase()} cleared`);
      }
    } catch (e) { log(`❌ NUKE ${side.toUpperCase()} error: ${e.message.slice(0, 80)}`); }
  };

  // Only sell sides that were actually bought in this window
  const tasks = [];
  if (m.arbUpBought)   tasks.push(sellSide('up'));
  if (m.arbDownBought) tasks.push(sellSide('down'));
  if (tasks.length) await Promise.all(tasks);
  log(`🏁 ${m.pair} NUKE complete`);
}

// ── Core Arbitrage Loop ──
// Strategy: watch combined ask (upAsk + downAsk). When it dips below ARB_THRESHOLD,
// buy both sides simultaneously. Both tokens always resolve to $1.00 combined —
// so buying at $0.97 combined = guaranteed $0.03/share profit on resolution.
// Early exit: if combined bid rises above ARB_EXIT_PROFIT, sell both for instant profit.
async function tradeLoop(m) {
  if (m.loopRunning) return;
  m.loopRunning = true;
  log(`🚀 ${m.pair} arb loop started`);

  // Wait for prices to settle after window open
  const entryOpenAt = m.windowStartMs + ENTRY_WAIT_SECS * 1000;
  const waitMs = entryOpenAt - Date.now();
  if (waitMs > 0) {
    log(`⏳ ${m.pair} waiting ${Math.ceil(waitMs / 1000)}s for prices to settle`);
    await sleep(waitMs);
  }

  let arbCount = 0; // how many arb positions opened this window

  while (true) {
    const secsLeft = (m.endTime - Date.now()) / 1000;

    if (secsLeft <= NUKE_SECS) {
      log(`⏳ ${m.pair} T-${Math.floor(secsLeft)}s — handing to nuke`);
      break;
    }
    // Start exit attempts at T-60s so we have plenty of retries before resolution
    if (secsLeft <= 60 && (m.arbUpBought || m.arbDownBought)) {
      if (!m.exitStarted) {
        m.exitStarted = true;
        log(`⏳ ${m.pair} T-${Math.floor(secsLeft)}s — starting pre-resolution exit, selling all open sides`);
      }
      const tasks = [];
      if (m.arbUpBought)   tasks.push(arbSell(m, 'up',   'PRE-RES').then(ok => { if (ok) m.arbUpBought   = false; }));
      if (m.arbDownBought) tasks.push(arbSell(m, 'down', 'PRE-RES').then(ok => { if (ok) m.arbDownBought = false; }));
      await Promise.all(tasks);
      if (!m.arbUpBought && !m.arbDownBought) {
        log(`✅ ${m.pair} all positions cleared before resolution`);
        m.done = true; break;
      }
      await sleep(300);
      continue;
    }
    if (secsLeft <= FORCE_CLOSE_SECS) {
      await sleep(200);
      continue;
    }

    await ensureFreshPrice(m);

    const upAsk   = m.upBestAsk  || m.upMid;
    const dnAsk   = m.dnBestAsk  || m.downMid;
    const upBid   = m.upBestBid  || m.upMid;
    const dnBid   = m.dnBestBid  || m.downMid;
    const combined = f4((upAsk || 0) + (dnAsk || 0));
    const combinedBid = f4((upBid || 0) + (dnBid || 0));

    if (!upAsk || !dnAsk || combined <= 0) {
      await sleep(200);
      continue;
    }

    // ── EARLY EXIT: if combined bid > ARB_EXIT_PROFIT, lock in profit immediately ──
    // e.g. bought at 0.96 combined, combined bid is now 0.99 → sell both now for +$0.18
    if (m.arbUpBought && m.arbDownBought && combinedBid >= ARB_EXIT_PROFIT) {
      log(`💰 ${m.pair} early exit! combined bid ${f4(combinedBid)} >= ${ARB_EXIT_PROFIT} — selling both`);
      const [soldUp, soldDn] = await Promise.all([
        arbSell(m, 'up',   'PROFIT-EXIT'),
        arbSell(m, 'down', 'PROFIT-EXIT'),
      ]);
      if (soldUp)  m.arbUpBought   = false;
      if (soldDn)  m.arbDownBought = false;

      if (!m.arbUpBought && !m.arbDownBought) {
        const exitCombined = combinedBid;
        const pnl = f2((exitCombined - m.arbEntryPrice) * ARB_SHARES);
        log(`✅ ${m.pair} arb closed — entry:${f4(m.arbEntryPrice)} exit:${f4(exitCombined)} pnl:$${pnl}`);
        trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair,
          action: 'ARB-CLOSE', entryPrice: f4(m.arbEntryPrice), exitPrice: f4(exitCombined), pnl });
        if (trades.length > 200) trades.length = 200;
        // Look for another arb opportunity if time allows
        m.arbEntryPrice = 0;
        arbCount++;
      }
      await sleep(200);
      continue;
    }

    // ── ENTRY: if combined ask < ARB_THRESHOLD and not already in a position ──
    if (!m.arbUpBought && !m.arbDownBought && combined < ARB_THRESHOLD) {
      // Check balance
      let availBal = balance;
      try { availBal = await trader.getBalance(); } catch (_) {}
      const needed = f4(ARB_SHARES * (upAsk + dnAsk));
      if (availBal < needed) {
        log(`⛔ ${m.pair} arb: need $${needed} but balance $${f4(availBal)} — skip`);
        await sleep(500);
        continue;
      }

      log(`🎯 ${m.pair} ARB OPPORTUNITY — combined ask ${f4(combined)} < ${ARB_THRESHOLD} — buying both sides`);
      m.arbEntryPrice = combined;

      // Buy both sides simultaneously — if one fails we immediately sell the other
      const [boughtUp, boughtDn] = await Promise.all([
        arbBuy(m, 'up'),
        arbBuy(m, 'down'),
      ]);

      m.arbUpBought   = boughtUp;
      m.arbDownBought = boughtDn;

      if (boughtUp && boughtDn) {
        log(`✅ ${m.pair} BOTH sides filled @ combined ${f4(combined)} — holding for resolution or early exit`);
        trades.unshift({ ts: new Date().toTimeString().slice(0,8), pair: m.pair,
          action: 'ARB-OPEN', combined: f4(combined), shares: ARB_SHARES,
          estProfit: f2((1.00 - combined) * ARB_SHARES) });
        if (trades.length > 200) trades.length = 200;
      } else if (boughtUp && !boughtDn) {
        // One-sided fill — dangerous, sell UP immediately to avoid directional risk
        log(`⚠️  ${m.pair} only UP filled — bailing, selling UP to avoid directional exposure`);
        await arbSell(m, 'up', 'BAIL');
        m.arbUpBought = false;
      } else if (!boughtUp && boughtDn) {
        log(`⚠️  ${m.pair} only DOWN filled — bailing, selling DOWN`);
        await arbSell(m, 'down', 'BAIL');
        m.arbDownBought = false;
      } else {
        log(`❌ ${m.pair} both sides failed to fill — will retry next opportunity`);
      }
      await sleep(500);
      continue;
    }

    // Log opportunity scanner every 30s
    if (!m._lastScanLog || Date.now() - m._lastScanLog >= 30000) {
      log(`🔍 ${m.pair} scanning — combined ask:${f4(combined)} threshold:${ARB_THRESHOLD} secsLeft:${Math.floor(secsLeft)}`);
      m._lastScanLog = Date.now();
    }

    await sleep(200); // scan 5x per second
  }

  log(`✅ ${m.pair} arb loop finished — ${arbCount} arbs executed this window`);
  m.loopRunning = false;
}

// ── Heartbeat — docs: must send every 5s or all open orders are cancelled ──
// Chain heartbeat_id from each response; use empty string for first call
async function sendHeartbeat() {
  try {
    const resp = await trader._clob.postHeartbeat(heartbeatId);
    heartbeatId = resp?.heartbeat_id ?? resp?.id ?? heartbeatId;
  } catch (e) {
    log(`⚠️  Heartbeat error: ${e.message.slice(0, 60)}`);
  }
}

// ── Main tick (discovery + heartbeat — prices come via WS) ──
async function tick() {
  const now = Date.now();

  // Send heartbeat every 5s — docs say 10s timeout with 5s buffer
  if (now - lastHeartbeatAt >= 5000) {
    lastHeartbeatAt = now;
    sendHeartbeat(); // fire-and-forget, don't await — must not block tick
  }

  if (now - lastDiscoverAt >= DISCOVER_EVERY_MS) {
    lastDiscoverAt = now;
    await discover();
  }

  // Nuclear close — fire emergencyCloseAll for any market at T-5s
  // Runs independently so it catches positions even if the trade loop is mid-operation
  for (const m of Object.values(markets)) {
    const secsLeft = (m.endTime - Date.now()) / 1000;
    if (secsLeft <= NUKE_SECS && secsLeft > 0 && !nukedMarkets.has(m.slug)) {
      emergencyCloseAll(m).catch(e => log(`❌ Nuke error ${m.pair}: ${e.message}`));
    }
  }

  emitFn('snapshot', snapshot());
}

// ── Snapshot ──
function snapshot() {
  const activeMarkets = Object.values(markets).map(m => ({
    slug: m.slug, pair: m.pair,
    upMid: f4(m.upMid), dnMid: f4(m.downMid),
    upAsk: f4(m.upBestAsk), dnAsk: f4(m.dnBestAsk),
    upBid: f4(m.upBestBid), dnBid: f4(m.dnBestBid),
    secsLeft: Math.max(0, Math.floor((m.endTime - Date.now()) / 1000)),
    loopRunning: m.loopRunning, done: m.done,
  }));
  return {
    balance: f2(balance), startBalance: f2(startBalance),
    pnl: f2(balance - startBalance),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeMarkets, totalTrades: trades.length,
    recentTrades: trades.slice(0, 60),
    activityLog: logs.slice(0, 80),
    strategy: {
      shares: ARB_SHARES, trailingDist: TRAILING_DIST,
      entryWaitSecs: ENTRY_WAIT_SECS, forceCloseSecs: FORCE_CLOSE_SECS,
      minEntryPrice: MIN_ENTRY_PRICE, maxEntryPrice: MAX_ENTRY_PRICE,
    },
  };
}

async function setDryRun() { log('⚠️  setDryRun — live-only bot, ignored'); }
function getDryRun() { return false; }

// ── Start ──
async function start(emit, logFn) {
  emitFn = emit || (() => {}); slog = logFn || (() => {});
  startTime = Date.now();

  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    console.error('❌ POLYMARKET_PRIVATE_KEY not set'); process.exit(1);
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
    log(`❌ Auth failed: ${e.message}`); process.exit(1);
  }

  wsConnect();
  log('🔴 LIVE — main loop started');
  setInterval(tick, TICK_MS);
}

module.exports = { start, snapshot, setDryRun, getDryRun };
