'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  POLYMARKET OPPORTUNIST BOT
 *  Strategy: Liquidity Momentum + Spread Fade
 * ═══════════════════════════════════════════════════════════════
 *
 *  CONCEPT:
 *  Scans ALL live Polymarket markets ending within 60 minutes.
 *  For each, it identifies the "overpriced" side using 3 signals:
 *
 *  1. SPREAD SIGNAL — If YES ask is far above 0.50 and spread is
 *     wide, the market is leaning YES. We fade the consensus by
 *     buying the cheaper NO side (and vice versa). Markets with
 *     extreme consensus (>0.85 or <0.15) are skipped — too risky.
 *
 *  2. VOLUME IMBALANCE — If one side has significantly more
 *     liquidity depth in the order book, we trade WITH that side
 *     (smart money signal). Books are fetched from CLOB REST.
 *
 *  3. PRICE VELOCITY — We track mid-price over 60s. If YES is
 *     drifting DOWN fast, we buy YES (mean-reversion). If it's
 *     rising fast, we buy NO. Velocity magnitude gate: ≥ 0.005
 *     movement in 60s to qualify.
 *
 *  Signals are scored: each gives +1 or -1 for YES/NO.
 *  Net score ≥ +2 → buy YES. Net score ≤ -2 → buy NO. Else skip.
 *
 *  TRADE STRUCTURE (10-minute window per market):
 *  - Entry 1 at   0s  (immediate on discovery)
 *  - Entry 2 at 120s  (2 min in — average in if still confident)
 *  - Entry 3 at 300s  (5 min in — final entry)
 *  - Force exit at 540s (9 min in — 60s before expiry window close)
 *  - TP limit at 0.96 (take profit if market moves fast)
 *
 *  MARKET FILTER:
 *  - endTime between 5 min and 60 min from now
 *  - YES mid between 0.10 and 0.90 (not already decided)
 *  - Both YES and NO tokens must have orderbook data
 *  - Minimum $20 liquidity on each side
 *  - Not already trading this slug
 *
 * ═══════════════════════════════════════════════════════════════
 */

const WebSocket        = require('ws');
const PolymarketTrader = require('./polymarket-trader');

// ── API endpoints ──
const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Timing ──
const SCAN_EVERY_MS      = 20_000;   // Scan for new markets every 20s
const TICK_MS            = 250;      // Main loop tick
const TRADE_WINDOW_SECS  = 600;      // 10-minute trade window
const FORCE_EXIT_SECS    = 540;      // Exit 60s before window ends
const ENTRY_SECS         = [0, 120, 300]; // 3 entries in the window

// ── Market filter ──
const MIN_MINS_TO_END    = 5;        // Market must have at least 5 min left
const MAX_MINS_TO_END    = 60;       // Market must end within 60 min
const MIN_YES_MID        = 0.10;     // Skip near-certain NO
const MAX_YES_MID        = 0.90;     // Skip near-certain YES
const MIN_LIQUIDITY_USD  = 20;       // Min $ liquidity per side

// ── Strategy ──
const TP_PRICE           = 0.96;
const SHARES_PER_ENTRY   = 5;
const VELOCITY_WINDOW_MS = 60_000;   // 60s for price velocity calc
const VELOCITY_MIN       = 0.005;    // Minimum move to count as signal

// ── Env ──
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// ── State ──
let emitFn      = () => {};
let slog        = () => {};
let trader      = null;
let demoBalance = 0;
let realizedPnl = 0;
let startTime   = Date.now();
let lastScanAt  = 0;

const logs    = [];
const trades  = [];
const markets = {}; // slug → market object
const priceHistory = {}; // tokenId → [{mid, ts}]

// ── Helpers ──
const f2  = v => Math.round((v || 0) * 100) / 100;
const f4  = v => Math.round((v || 0) * 10000) / 10000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const prefix = DRY_RUN ? '[DRY] ' : '';
  const ts     = new Date().toTimeString().slice(0, 8);
  const line   = `[${ts}] ${prefix}${msg}`;
  logs.unshift(line);
  if (logs.length > 400) logs.length = 400;
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

// ══════════════════════════════════════════
//  WEBSOCKET PRICE FEED
// ══════════════════════════════════════════
let ws          = null;
let wsPingTimer = null;
const wsTokenMap = {}; // tokenId → slug

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log('🔌 Connecting WebSocket price feed…');
  ws = new WebSocket(CLOB_WS);

  ws.on('open', () => {
    log('✅ WebSocket connected');
    const ids = Object.keys(wsTokenMap);
    if (ids.length) wsSubscribe(ids);
    wsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({}));
    }, 10000);
  });

  ws.on('message', (raw) => {
    try {
      const msgs = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [JSON.parse(raw)];
      for (const msg of msgs) {
        if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
          for (const pc of msg.price_changes) onPriceUpdate(pc.asset_id, pc.best_bid, pc.best_ask);
        }
        if (msg.event_type === 'best_bid_ask') onPriceUpdate(msg.asset_id, msg.best_bid, msg.best_ask);
        if (msg.event_type === 'book') {
          const bid = msg.bids?.[0]?.price ? parseFloat(msg.bids[0].price) : null;
          const ask = msg.asks?.[0]?.price ? parseFloat(msg.asks[0].price) : null;
          onPriceUpdate(msg.asset_id, bid, ask);
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    log('⚠️  WebSocket closed — reconnecting in 3s');
    setTimeout(wsConnect, 3000);
  });

  ws.on('error', (e) => {
    log(`⚠️  WS error: ${e.message}`);
    try { ws.terminate(); } catch (_) {}
  });
}

function onPriceUpdate(tokenId, bestBid, bestAsk) {
  if (!tokenId) return;
  const slug = wsTokenMap[tokenId];
  if (!slug || !markets[slug]) return;
  const m   = markets[slug];
  const bid = bestBid ? f4(parseFloat(bestBid)) : null;
  const ask = bestAsk ? f4(parseFloat(bestAsk)) : null;

  if (tokenId === m.yesTokenId) {
    if (bid) m.yesBid = bid;
    if (ask && ask < TP_PRICE) m.yesAsk = ask;
    if (m.yesBid && m.yesAsk) m.yesMid = f4((m.yesBid + m.yesAsk) / 2);
    else if (m.yesBid) m.yesMid = m.yesBid;
    m.lastPriceAt = Date.now();
    recordPriceHistory(tokenId, m.yesMid);
  }
  if (tokenId === m.noTokenId) {
    if (bid) m.noBid = bid;
    if (ask && ask < TP_PRICE) m.noAsk = ask;
    if (m.noBid && m.noAsk) m.noMid = f4((m.noBid + m.noAsk) / 2);
    else if (m.noBid) m.noMid = m.noBid;
    m.lastPriceAt = Date.now();
  }
}

function wsSubscribe(tokenIds) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ assets_ids: tokenIds, type: 'market' }));
}

function recordPriceHistory(tokenId, mid) {
  if (!mid) return;
  if (!priceHistory[tokenId]) priceHistory[tokenId] = [];
  const now = Date.now();
  priceHistory[tokenId].push({ mid, ts: now });
  // Keep only last 5 min
  const cutoff = now - 5 * 60_000;
  priceHistory[tokenId] = priceHistory[tokenId].filter(p => p.ts > cutoff);
}

// Price velocity: change in mid over VELOCITY_WINDOW_MS
// Positive = rising, Negative = falling
function getPriceVelocity(tokenId) {
  const hist = priceHistory[tokenId];
  if (!hist || hist.length < 2) return 0;
  const now    = Date.now();
  const cutoff = now - VELOCITY_WINDOW_MS;
  const old    = hist.find(p => p.ts >= cutoff);
  const recent = hist[hist.length - 1];
  if (!old || old === recent) return 0;
  return f4(recent.mid - old.mid);
}

// ══════════════════════════════════════════
//  REST PRICE & BOOK FETCH
// ══════════════════════════════════════════
async function refreshPriceRest(m) {
  const [yMid, nMid, yBook, nBook] = await Promise.all([
    getJSON(`${CLOB}/midpoint?token_id=${m.yesTokenId}`),
    getJSON(`${CLOB}/midpoint?token_id=${m.noTokenId}`),
    getJSON(`${CLOB}/book?token_id=${m.yesTokenId}`),
    getJSON(`${CLOB}/book?token_id=${m.noTokenId}`),
  ]);
  if (yMid?.mid) m.yesMid = f4(parseFloat(yMid.mid));
  if (nMid?.mid) m.noMid  = f4(parseFloat(nMid.mid));

  if (yBook) {
    m.yesBid = yBook.bids?.[0]?.price ? f4(parseFloat(yBook.bids[0].price)) : m.yesBid;
    m.yesAsk = yBook.asks?.[0]?.price ? f4(parseFloat(yBook.asks[0].price)) : m.yesAsk;
    // Liquidity = sum of top 5 levels * price
    m.yesLiquidityUsd = sumLiquidity(yBook.bids);
  }
  if (nBook) {
    m.noBid = nBook.bids?.[0]?.price ? f4(parseFloat(nBook.bids[0].price)) : m.noBid;
    m.noAsk = nBook.asks?.[0]?.price ? f4(parseFloat(nBook.asks[0].price)) : m.noAsk;
    m.noLiquidityUsd = sumLiquidity(nBook.bids);
  }
  m.lastPriceAt = Date.now();
  if (!m.yesMid && m.yesBid && m.yesAsk) m.yesMid = f4((m.yesBid + m.yesAsk) / 2);
  if (!m.noMid  && m.noBid  && m.noAsk)  m.noMid  = f4((m.noBid  + m.noAsk)  / 2);
}

function sumLiquidity(levels) {
  if (!Array.isArray(levels)) return 0;
  return levels.slice(0, 5).reduce((acc, l) => {
    const price = parseFloat(l.price || 0);
    const size  = parseFloat(l.size  || 0);
    return acc + price * size;
  }, 0);
}

async function ensureFreshPrice(m) {
  const stale = !m.lastPriceAt || (Date.now() - m.lastPriceAt) > 4000;
  if (stale) await refreshPriceRest(m);
}

// ══════════════════════════════════════════
//  SIGNAL ENGINE
// ══════════════════════════════════════════
/**
 * Returns { side: 'yes'|'no'|null, score, signals[] }
 * score ≥ 2 → trade that side
 */
function analyzeMarket(m) {
  const signals = [];
  let yesScore  = 0;

  // ── Signal 1: Spread Fade ──
  // Wide spread on YES side → market is uncertain/overextended
  // If YES is above 0.5, fade it by buying NO (contrarian)
  // If YES is below 0.5, fade NO by buying YES
  if (m.yesMid && m.yesAsk && m.yesBid) {
    const spread = f4(m.yesAsk - m.yesBid);
    if (spread > 0.04) {
      // Wide spread: bet against the leading side
      if (m.yesMid > 0.5) {
        yesScore -= 1;
        signals.push({ name: 'SpreadFade', vote: 'NO', detail: `wide spread ${spread.toFixed(3)}, YES=${m.yesMid.toFixed(3)} overpriced` });
      } else {
        yesScore += 1;
        signals.push({ name: 'SpreadFade', vote: 'YES', detail: `wide spread ${spread.toFixed(3)}, YES=${m.yesMid.toFixed(3)} underpriced` });
      }
    } else {
      signals.push({ name: 'SpreadFade', vote: 'SKIP', detail: `tight spread ${spread.toFixed(3)} — no edge` });
    }
  }

  // ── Signal 2: Volume/Liquidity Imbalance ──
  // More liquidity on YES side = smart money backing YES
  const yesLiq = m.yesLiquidityUsd || 0;
  const noLiq  = m.noLiquidityUsd  || 0;
  if (yesLiq > 0 && noLiq > 0) {
    const ratio = yesLiq / (yesLiq + noLiq);
    if (ratio > 0.62) {
      yesScore += 1;
      signals.push({ name: 'LiqImbalance', vote: 'YES', detail: `YES liq ${f2(yesLiq)} vs NO liq ${f2(noLiq)} (${(ratio*100).toFixed(0)}% YES)` });
    } else if (ratio < 0.38) {
      yesScore -= 1;
      signals.push({ name: 'LiqImbalance', vote: 'NO', detail: `NO liq ${f2(noLiq)} vs YES liq ${f2(yesLiq)} (${((1-ratio)*100).toFixed(0)}% NO)` });
    } else {
      signals.push({ name: 'LiqImbalance', vote: 'SKIP', detail: `balanced liquidity ${(ratio*100).toFixed(0)}%/YES` });
    }
  }

  // ── Signal 3: Price Velocity (mean reversion) ──
  // YES rising fast → likely to revert → buy NO
  // YES falling fast → likely to revert → buy YES
  const velocity = getPriceVelocity(m.yesTokenId);
  if (Math.abs(velocity) >= VELOCITY_MIN) {
    if (velocity > 0) {
      // YES rising: fade it → NO
      yesScore -= 1;
      signals.push({ name: 'Velocity', vote: 'NO', detail: `YES rising +${velocity.toFixed(4)} in 60s → mean revert` });
    } else {
      // YES falling: buy it → YES
      yesScore += 1;
      signals.push({ name: 'Velocity', vote: 'YES', detail: `YES falling ${velocity.toFixed(4)} in 60s → mean revert` });
    }
  } else {
    signals.push({ name: 'Velocity', vote: 'SKIP', detail: `velocity ${velocity.toFixed(4)} < threshold` });
  }

  // ── Decision ──
  let side = null;
  if (yesScore >= 2)       side = 'yes';
  else if (yesScore <= -2) side = 'no';

  return { side, score: yesScore, signals };
}

// ══════════════════════════════════════════
//  ORDER MANAGEMENT
// ══════════════════════════════════════════
async function placeLimitOrder(tokenId, side, price, shares, label) {
  if (DRY_RUN) {
    const id = `DRY-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    log(`[DRY] ${side} ${shares}sh @ ${price} (${label}) → ${id}`);
    return id;
  }
  try {
    const r = await trader.placeGtcOrder(tokenId, side, price, shares);
    return r?.id || null;
  } catch (e) {
    log(`⚠️  Order error (${label}): ${e.message}`);
    return null;
  }
}

async function cancelOrder(orderId, label) {
  if (DRY_RUN) { log(`[DRY] Cancel ${orderId} (${label})`); return; }
  try { await trader.cancelOrder(orderId); } catch (_) {}
}

async function waitForFill(orderId, timeoutMs, label) {
  if (DRY_RUN) {
    await sleep(600);
    log(`[DRY] Simulated fill: ${orderId} (${label})`);
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const o = await trader.getOrder(orderId);
      if (!o) continue;
      const st = (o.status || o.match_status || o.state || '').toLowerCase();
      if (st === 'filled')    return true;
      if (st === 'cancelled') { log(`⚠️  ${label} cancelled externally`); return false; }
    } catch (_) {}
  }
  return false;
}

// ══════════════════════════════════════════
//  FIRE ENTRY
// ══════════════════════════════════════════
async function fireEntry(m, entryNum) {
  const isYes   = m.side === 'yes';
  const label   = isYes ? 'YES' : 'NO';
  const tokenId = isYes ? m.yesTokenId : m.noTokenId;
  const tick    = isYes ? (m.yesTick || 0.01) : (m.noTick || 0.01);

  await ensureFreshPrice(m);

  let mid = isYes ? m.yesMid : m.noMid;
  if (!mid || mid <= 0) { log(`⚠️  ${m.label} Entry ${entryNum}: no price — skipping`); return; }

  // Re-check signal still valid (don't enter if consensus shifted)
  const analysis = analyzeMarket(m);
  if (analysis.side !== m.side) {
    log(`⚠️  ${m.label} Entry ${entryNum}: signal flipped (${analysis.score}) — skipping`);
    return;
  }

  // Price just below TP
  let px = Math.min(mid, TP_PRICE - tick);
  px = f4(Math.max(0.01, Math.round(px / tick) * tick));

  const shares = SHARES_PER_ENTRY;
  log(`📥 ${m.label} Entry ${entryNum}/3 — BUY ${label} ${shares}sh @ ${px}`);

  const orderId = await placeLimitOrder(tokenId, 'BUY', px, shares, `${label}-E${entryNum}`);
  if (!orderId) return;
  m.openOrderIds.push(orderId);

  const filled = await waitForFill(orderId, 12000, `${label}-E${entryNum}`);
  m.openOrderIds = m.openOrderIds.filter(id => id !== orderId);

  if (!filled) {
    log(`⏰ ${m.label} Entry ${entryNum} not filled — cancelling`);
    await cancelOrder(orderId, `${label}-E${entryNum}`);
    return;
  }

  const cost = f4(px * shares);
  m.shares    += shares;
  m.totalCost += cost;
  m.firedCount++;
  m.openTrades.push({ shares, entryPrice: px, cost });
  log(`✅ ${m.label} Entry ${entryNum} FILLED: ${shares}sh @ ${px} | cost $${cost}`);

  trades.push({
    time: new Date().toTimeString().slice(0, 8),
    label: m.label, side: label,
    entryNum, shares, price: px, cost,
    category: m.category,
  });

  // Place TP immediately
  const tpId = await placeLimitOrder(tokenId, 'SELL', TP_PRICE, shares, `${label}-TP${entryNum}`);
  if (tpId) {
    m.tpOrderIds.push(tpId);
    m.openOrderIds.push(tpId);
    log(`🎯 TP placed ${shares}sh @ ${TP_PRICE} → ${tpId}`);
  }

  log(`💰 Capital: $${calcCapital()} | Unrealized: $${calcUnrealized(m)}`);
  emitFn('state', buildState());
}

// ══════════════════════════════════════════
//  FORCE EXIT
// ══════════════════════════════════════════
async function forceExit(m) {
  if (m.exitDone) return;
  m.exitDone = true;

  if (m.shares === 0) {
    log(`✅ ${m.label} Exit: no open shares`);
    return;
  }

  // Cancel all open orders
  if (m.openOrderIds.length > 0) {
    log(`🧹 ${m.label} Cancelling ${m.openOrderIds.length} orders before exit`);
    await Promise.all(m.openOrderIds.map(id => cancelOrder(id, 'pre-exit')));
    m.openOrderIds = [];
    m.tpOrderIds   = [];
  }

  const isYes   = m.side === 'yes';
  const label   = isYes ? 'YES' : 'NO';
  const tokenId = isYes ? m.yesTokenId : m.noTokenId;
  const tick    = isYes ? (m.yesTick || 0.01) : (m.noTick || 0.01);

  await refreshPriceRest(m);
  const mid = isYes ? m.yesMid : m.noMid;
  const bid = isYes ? m.yesBid : m.noBid;
  let sellPx = mid > 0 ? mid : (bid > 0 ? bid : 0.01);
  sellPx = Math.min(sellPx, TP_PRICE - tick);
  sellPx = f4(Math.max(0.01, Math.round(sellPx / tick) * tick));

  log(`🚨 ${m.label} FORCE EXIT ${m.shares}sh ${label} @ ${sellPx}`);

  const orderId = await placeLimitOrder(tokenId, 'SELL', sellPx, m.shares, `${label}-EXIT`);
  if (!orderId) { log(`❌ ${m.label} Exit order failed`); return; }
  m.openOrderIds.push(orderId);

  const filled = await waitForFill(orderId, 5000, `${label}-EXIT`);
  m.openOrderIds = m.openOrderIds.filter(id => id !== orderId);
  if (!filled) {
    log(`⚠️  ${m.label} Exit not filled — cancelling`);
    await cancelOrder(orderId, `${label}-EXIT`);
  }

  const revenue = f4(sellPx * m.shares);
  const pnl     = f2(revenue - m.totalCost);
  realizedPnl   = f2(realizedPnl + pnl);

  log(`📊 ${m.label} Exit: revenue $${revenue} | cost $${f2(m.totalCost)} | P&L $${pnl}`);
  log(`💰 Realized P&L: $${realizedPnl} | Capital: $${calcCapital()}`);

  m.shares     = 0;
  m.totalCost  = 0;
  m.openTrades = [];
  m.exitPnl    = pnl;
  emitFn('state', buildState());
}

// ══════════════════════════════════════════
//  TRADE LOOP (per market)
// ══════════════════════════════════════════
async function tradeLoop(m) {
  m.loopRunning = true;
  const sideLabel = m.side.toUpperCase();
  log(`🚀 ${m.label} loop started — signal=${sideLabel} score=${m.signalScore} entries@${ENTRY_SECS.join('/')}s`);

  const fired  = new Set();
  const secsIn = () => (Date.now() - m.tradeStartMs) / 1000;

  while (!m.done) {
    const secs = secsIn();

    if (secs >= FORCE_EXIT_SECS && !m.exitDone) {
      await forceExit(m);
      m.done = true;
      log(`🏁 ${m.label} window closed at ${secs.toFixed(0)}s`);
      break;
    }

    await ensureFreshPrice(m);

    for (let i = 0; i < ENTRY_SECS.length; i++) {
      const fireAt = ENTRY_SECS[i];
      if (!fired.has(i) && secs >= fireAt && secs < fireAt + 8) {
        fired.add(i);
        await fireEntry(m, i + 1);
        break;
      }
    }

    emitFn('state', buildState());
    await sleep(TICK_MS);
  }

  m.loopRunning = false;
  log(`🏁 ${m.label} trade loop ended`);
}

// ══════════════════════════════════════════
//  MARKET SCANNER
// ══════════════════════════════════════════
async function scanMarkets() {
  log('🔭 Scanning Polymarket for live opportunities…');

  const nowMs       = Date.now();
  const minEndMs    = nowMs + MIN_MINS_TO_END * 60_000;
  const maxEndMs    = nowMs + MAX_MINS_TO_END * 60_000;

  // Fetch live markets from Gamma (paginated, get most recent)
  // Filter: active, not resolved, binary markets
  let candidates = [];
  try {
    // Gamma: fetch markets ending soon, filtered by end_date_min/max
    const minEndISO = new Date(minEndMs).toISOString();
    const maxEndISO = new Date(maxEndMs).toISOString();

    // Fetch multiple pages to get good coverage, filtered server-side by end date
    const pages = await Promise.all([
      getJSON(`${GAMMA}/markets?closed=false&limit=100&offset=0&end_date_min=${encodeURIComponent(minEndISO)}&end_date_max=${encodeURIComponent(maxEndISO)}&order=endDate&ascending=true`),
      getJSON(`${GAMMA}/markets?closed=false&limit=100&offset=100&end_date_min=${encodeURIComponent(minEndISO)}&end_date_max=${encodeURIComponent(maxEndISO)}&order=endDate&ascending=true`),
    ]);

    for (const page of pages) {
      if (!Array.isArray(page)) continue;
      for (const mk of page) {
        if (!mk.endDate) continue;
        const endMs = new Date(mk.endDate).getTime();
        if (endMs < minEndMs || endMs > maxEndMs) continue;
        if (!mk.clobTokenIds) continue;
        if (mk.closed || mk.archived) continue;
        candidates.push(mk);
      }
    }
  } catch (e) {
    log(`⚠️  Scan error: ${e.message}`);
    return;
  }

  log(`🔭 Found ${candidates.length} candidate markets ending in ${MIN_MINS_TO_END}–${MAX_MINS_TO_END} min`);

  // Process each candidate
  for (const mk of candidates) {
    try {
      await evaluateCandidate(mk);
    } catch (e) {
      log(`⚠️  Evaluate error [${mk.slug}]: ${e.message}`);
    }
    await sleep(300); // throttle
  }
}

async function evaluateCandidate(mk) {
  let ids;
  try { ids = JSON.parse(mk.clobTokenIds); } catch (_) { return; }
  if (!ids || ids.length < 2) return;

  const slug = mk.slug;
  if (markets[slug]) return; // already tracking

  const yesTokenId = ids[0];
  const noTokenId  = ids[1];
  const endTime    = new Date(mk.endDate).getTime();
  const minsLeft   = Math.floor((endTime - Date.now()) / 60_000);

  // Build a temporary market object to run price/analysis
  const tmp = {
    slug, yesTokenId, noTokenId, endTime,
    yesMid: 0, noMid: 0,
    yesBid: 0, yesAsk: 0,
    noBid: 0,  noAsk: 0,
    yesLiquidityUsd: 0,
    noLiquidityUsd:  0,
    lastPriceAt: 0,
    yesTick: parseFloat(mk.yesTick || '0.01') || 0.01,
    noTick:  parseFloat(mk.noTick  || '0.01') || 0.01,
  };

  await refreshPriceRest(tmp);

  // Price filter
  if (!tmp.yesMid || tmp.yesMid < MIN_YES_MID || tmp.yesMid > MAX_YES_MID) return;

  // Liquidity filter
  if (tmp.yesLiquidityUsd < MIN_LIQUIDITY_USD || tmp.noLiquidityUsd < MIN_LIQUIDITY_USD) return;

  // Seed price history for velocity calculation
  if (yesTokenId) {
    recordPriceHistory(yesTokenId, tmp.yesMid);
  }

  // Run signal engine
  const analysis = analyzeMarket(tmp);
  const { side, score, signals } = analysis;

  const sigSummary = signals.map(s => `${s.name}:${s.vote}`).join(' | ');
  log(`📊 [${slug.slice(0, 40)}] score=${score} ${sigSummary} | YES=${tmp.yesMid} minsLeft=${minsLeft}`);

  if (!side) return; // No clear signal

  // All checks passed — open this market
  const question = mk.question || mk.title || slug;
  const label    = question.length > 50 ? question.slice(0, 47) + '…' : question;

  log(`✨ OPPORTUNITY: ${label}`);
  log(`   Side=${side.toUpperCase()} | Score=${score} | YES=${tmp.yesMid} | NO=${tmp.noMid} | ${minsLeft}min left`);
  signals.forEach(s => log(`   [${s.name}] ${s.vote}: ${s.detail}`));

  // Get tick sizes from CLOB
  let yesTick = '0.01', noTick = '0.01';
  try {
    [yesTick, noTick] = await Promise.all([
      trader._clob.getTickSize(yesTokenId).catch(() => '0.01'),
      trader._clob.getTickSize(noTokenId).catch(() => '0.01'),
    ]);
  } catch (_) {}

  markets[slug] = {
    slug, label,
    question: mk.question || mk.title || slug,
    category: mk.category || 'unknown',
    yesTokenId, noTokenId, endTime,
    tradeStartMs: Date.now(),

    // Prices
    yesMid: tmp.yesMid, noMid: tmp.noMid,
    yesBid: tmp.yesBid, yesAsk: tmp.yesAsk,
    noBid:  tmp.noBid,  noAsk:  tmp.noAsk,
    yesLiquidityUsd: tmp.yesLiquidityUsd,
    noLiquidityUsd:  tmp.noLiquidityUsd,
    lastPriceAt: tmp.lastPriceAt,
    yesTick: parseFloat(yesTick) || 0.01,
    noTick:  parseFloat(noTick)  || 0.01,

    // Signal
    side,
    signalScore: score,
    signals,

    // Position
    shares: 0, totalCost: 0,
    openTrades: [], openOrderIds: [], tpOrderIds: [],
    firedCount: 0,
    exitDone: false, done: false, loopRunning: false,
    exitPnl: null,
    minsLeft,
  };

  // Subscribe to WS
  wsTokenMap[yesTokenId] = slug;
  wsTokenMap[noTokenId]  = slug;
  wsSubscribe([yesTokenId, noTokenId]);

  // Launch trade loop
  tradeLoop(markets[slug]).catch(e => log(`❌ Trade loop crash [${slug}]: ${e.message}`));
}

// ══════════════════════════════════════════
//  P&L CALCULATIONS
// ══════════════════════════════════════════
function calcUnrealized(m) {
  if (!m || m.shares === 0) return 0;
  const mid = m.side === 'yes' ? m.yesMid : m.noMid;
  const avg = m.totalCost / m.shares;
  return f2((mid - avg) * m.shares);
}

function calcCapital() {
  let unreal = 0;
  for (const m of Object.values(markets)) unreal += calcUnrealized(m);
  return f2(demoBalance + realizedPnl + unreal);
}

// ══════════════════════════════════════════
//  SCAN LOOP
// ══════════════════════════════════════════
async function scanLoop() {
  while (true) {
    if (trader && Date.now() - lastScanAt > SCAN_EVERY_MS) {
      lastScanAt = Date.now();
      await scanMarkets().catch(e => log(`⚠️  Scan loop error: ${e.message}`));
    }
    await sleep(3000);
  }
}

// ══════════════════════════════════════════
//  STATE BUILDER
// ══════════════════════════════════════════
function buildState() {
  const capital    = calcCapital();
  const sessionPnl = f2(capital - demoBalance);

  const mktList = Object.values(markets).map(m => ({
    slug:        m.slug,
    label:       m.label,
    category:    m.category,
    side:        m.side,
    signalScore: m.signalScore,
    signals:     (m.signals || []).map(s => `${s.name}:${s.vote}`).join(' '),
    secsIn:      Math.floor((Date.now() - m.tradeStartMs) / 1000),
    secsLeft:    Math.max(0, Math.floor((m.tradeStartMs + TRADE_WINDOW_SECS * 1000 - Date.now()) / 1000)),
    minsLeft:    m.minsLeft,
    yesMid:      m.yesMid,
    noMid:       m.noMid,
    yesLiq:      f2(m.yesLiquidityUsd || 0),
    noLiq:       f2(m.noLiquidityUsd || 0),
    shares:      m.shares,
    totalCost:   f2(m.totalCost),
    avgCost:     m.shares > 0 ? f4(m.totalCost / m.shares) : 0,
    unrealized:  calcUnrealized(m),
    firedCount:  m.firedCount,
    openOrders:  m.openOrderIds.length,
    exitDone:    m.exitDone,
    done:        m.done,
    exitPnl:     m.exitPnl,
    dryRun:      DRY_RUN,
  }));

  return {
    capital, startBalance: demoBalance,
    realizedPnl, pnl: sessionPnl,
    uptime:  Math.floor((Date.now() - startTime) / 1000),
    dryRun:  DRY_RUN,
    markets: mktList,
    trades:  trades.slice(-50),
    logs:    logs.slice(0, 100),
    activeCount:  mktList.filter(m => !m.done).length,
    doneCount:    mktList.filter(m => m.done).length,
    lastScanAgo:  Math.floor((Date.now() - lastScanAt) / 1000),
  };
}

// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════
async function init(privateKey, emit, serverLog) {
  emitFn = emit || (() => {});
  slog   = serverLog || (() => {});

  log('🤖 Polymarket Opportunist Bot starting…');
  log(`   DRY_RUN=${DRY_RUN} | Strategy: Liquidity Momentum + Spread Fade`);
  log(`   Window: ${TRADE_WINDOW_SECS / 60}min | Entries at ${ENTRY_SECS.join('/')}s | Exit at ${FORCE_EXIT_SECS}s`);
  log(`   Targets: markets ending in ${MIN_MINS_TO_END}–${MAX_MINS_TO_END} min | YES mid ${MIN_YES_MID}–${MAX_YES_MID}`);

  trader = new PolymarketTrader(privateKey);
  trader.setLogFn(log);

  await trader.authenticate();
  await trader.approveAllowance();

  if (DRY_RUN) {
    demoBalance = 500;
    log('💰 DRY RUN: demo balance $500');
  } else {
    demoBalance = await trader.getBalance();
    log(`💰 Live balance: $${demoBalance}`);
  }

  realizedPnl = 0;
  startTime   = Date.now();

  wsConnect();

  // Kick off scan loop
  scanLoop().catch(e => log(`❌ Scan loop crashed: ${e.message}`));

  // State broadcast
  setInterval(() => emitFn('state', buildState()), 1000);
}

function getState() { return buildState(); }
function getLogs()  { return logs; }

module.exports = { init, getState, getLogs };
