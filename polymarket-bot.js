'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 * POLYMARKET 5-MINUTE BITCOIN TIME-INTERVAL SCALPING BOT
 * ═══════════════════════════════════════════════════════════════
 * * STRATEGY LOGIC:
 * - Single Asset Focus: BTC ONLY
 * - 5-Minute Epochs: Tracks progress from 0 to 300 seconds.
 * - Phase 1 (0s - 135s): Every 15 seconds, dynamically evaluates the book,
 * identifies the CHEAPEST side, and places a 10-share (compounded) Maker Limit Order at Mid.
 * - Phase 2 (136s - 270s): Every 15 seconds, dynamically evaluates the book,
 * identifies the EXPENSIVE side, and places a 20-share (compounded) Maker Limit Order at Mid.
 * - Phase 3 (280s): Cancels any resting buy orders and places a Limit Sell Order for all
 * positions at 0.99.
 * - Phase 4 (300s): Let remaining open positions expire cleanly to Polymarket's resolution.
 * * COMPOUNDING MODEL (Option A):
 * - Base sizes (10/20) scale proportionally with account Net Asset Value growth.
 * Size = Base * (Current Bankroll / Total Seed Capital)
 * ═══════════════════════════════════════════════════════════════
 */

const PolymarketTrader = require('./polymarket-trader');

// ── API Endpoints ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

// ── Engine Timing ──
const TICK_MS               = 500; // Engine checks state twice per second
const POLY_PRICE_REFRESH_MS = 1000;
const WINDOW_SECS           = 300; // 5-minute windows
const INTERVAL_SECS         = 15;  // 15-second execution ticks

// ── Configuration & Env ──
const DRY_RUN       = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL || 2000);
const TARGET_ASSET  = 'BTC';

// Base share parameters
const PHASE_1_BASE_SHARES = 10;
const PHASE_2_BASE_SHARES = 20;
const TAKE_PROFIT_PRICE   = 0.99;

// Fees & Rebates Structure
const CRYPTO_TAKER_FEE_RATE     = 0.07;
const CRYPTO_MAKER_REBATE_SHARE = 0.20;

// ── System State Engine ──
let emitFn         = () => {};
let slog           = () => {};
let trader         = null;
let startTime      = Date.now();
let logs           = [];
let trades         = [];
let tradingEnabled = true;

let lastPolyPriceFetch = 0;
let totalEquityCurve   = [];

// ── BTC Main State ──
let btcState = {
  symbol: TARGET_ASSET,
  tradable: false,
  windowStart: null,
  windowEnd: null,
  slug: null,
  conditionId: null,
  upTokenId: null,
  downTokenId: null,
  upAsk: null, upBid: null, downAsk: null, downBid: null,
  bankroll: TOTAL_CAPITAL,
  realizedPnl: 0,
  feesPaid: 0,
  rebatesEarned: 0,
  wins: 0, losses: 0,
  resolvedThisWindow: true,
  equityCurve: [{ t: Date.now(), equity: TOTAL_CAPITAL }],
  
  // Track order tracking history inside the specific window loop
  executedIntervals: new Set(), // Store interval checkpoints (e.g. 15, 30, 45...) to prevent double execution
  activePositions: { Up: 0, Down: 0 },
  tpPlaced: false
};

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  slog(line);
}
function r2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }
function nowSec() { return Date.now() / 1000; }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-time-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'polymarket-time-bot/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Order Execution Mechanisms
// ─────────────────────────────────────────
async function placeLimitBuy(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitBuy(tokenId, shares, price);
  return { id: `dry-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
async function placeLimitSell(tokenId, price, shares) {
  if (!DRY_RUN && trader) return await trader.limitSell(tokenId, shares, price);
  return { id: `dry-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
}
function makerRebate(shares, price) {
  return round5(shares * CRYPTO_TAKER_FEE_RATE * price * (1 - price) * CRYPTO_MAKER_REBATE_SHARE);
}

// ─────────────────────────────────────────
//  Compounding Sizing Math (Option A)
// ─────────────────────────────────────────
function calculateCompoundedShares(baseShares) {
  const factor = btcState.bankroll / TOTAL_CAPITAL;
  // Maintain at least the base parameters size if bankroll is matching or lower
  const compounded = baseShares * Math.max(factor, 1.0);
  return r2(compounded);
}

// ─────────────────────────────────────────
//  Polymarket 5m Pipeline Resolution
// ─────────────────────────────────────────
function currentWindowStart(tsSec = nowSec()) {
  return Math.floor(tsSec / WINDOW_SECS) * WINDOW_SECS;
}
function slugFor(symbol, windowStartSec) {
  return `${symbol.toLowerCase()}-updown-5m-${windowStartSec}`;
}
function qOf(m) { return (m.question || m.groupItemTitle || m.title || '').toLowerCase(); }

function parseMarketTokens(m) {
  try {
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
    const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
    return outcomes.map((outcome, i) => ({ outcome, token_id: tokenIds[i] || null }));
  } catch (_) { return []; }
}

async function loadBtcWindow() {
  const ws = currentWindowStart();
  if (btcState.windowStart === ws && btcState.upTokenId) return;

  try {
    const slug = slugFor(TARGET_ASSET, ws);
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
    if (!event || !event.markets || !event.markets.length) {
      btcState.tradable = false;
      return;
    }
    const market = event.markets.find(m => { const q = qOf(m); return q.includes('up') || q.includes('down'); }) || event.markets[0];
    
    const tokens = parseMarketTokens(market);
    const upTok = tokens.find(t => (t.outcome || '').toLowerCase() === 'up')?.token_id;
    const downTok = tokens.find(t => (t.outcome || '').toLowerCase() === 'down')?.token_id;

    if (!upTok || !downTok) {
      btcState.tradable = false;
      return;
    }

    btcState.windowStart = ws;
    btcState.windowEnd = ws + WINDOW_SECS;
    btcState.slug = slug;
    btcState.conditionId = market.conditionId || null;
    btcState.upTokenId = upTok;
    btcState.downTokenId = downTok;
    btcState.tradable = true;
    btcState.resolvedThisWindow = false;
    btcState.executedIntervals.clear();
    btcState.tpPlaced = false;
    
    log(`⏰ New BTC Window Loaded: ${slug} | Compounding Multiplier: x${(btcState.bankroll / TOTAL_CAPITAL).toFixed(2)}`);
  } catch (err) {
    btcState.tradable = false;
  }
}

// ─────────────────────────────────────────
//  Real-time Book Processing
// ─────────────────────────────────────────
async function refreshPrices() {
  if (!btcState.tradable || !btcState.upTokenId) return;
  const requests = [
    { token_id: btcState.upTokenId, side: 'BUY' }, { token_id: btcState.upTokenId, side: 'SELL' },
    { token_id: btcState.downTokenId, side: 'BUY' }, { token_id: btcState.downTokenId, side: 'SELL' }
  ];

  try {
    const data = await postJSON(`${CLOB}/prices`, requests);
    if (Array.isArray(data)) {
      for (const row of data) {
        const tid = row.token_id || row.asset_id || row.tokenId;
        const side = (row.side || '').toUpperCase();
        const price = parseFloat(row.price);
        if (!Number.isFinite(price)) continue;

        if (tid === btcState.upTokenId) {
          if (side === 'BUY') btcState.upAsk = price; else btcState.upBid = price;
        } else if (tid === btcState.downTokenId) {
          if (side === 'BUY') btcState.downAsk = price; else btcState.downBid = price;
        }
      }
    }
  } catch (_) { /* Fallback to standard tracking array next tick */ }
}

// ─────────────────────────────────────────
//  Execution Pipeline Framework
// ─────────────────────────────────────────
async function handleMicroIntervalExecution(elapsedSecs) {
  // Identify exact integer block interval execution point
  const currentIntervalBlock = Math.floor(elapsedSecs / INTERVAL_SECS) * INTERVAL_SECS;
  
  if (currentIntervalBlock <= 0 || btcState.executedIntervals.has(currentIntervalBlock)) return;
  if (currentIntervalBlock > 270) return; // Core interval blocks end inside Phase 2 boundaries

  if (btcState.upAsk == null || btcState.upBid == null || btcState.downAsk == null || btcState.downBid == null) return;

  // Calculate dynamic Mid Prices
  const upMid = r2((btcState.upAsk + btcState.upBid) / 2);
  const downMid = r2((btcState.downAsk + btcState.downBid) / 2);

  let targetedSide = null;
  let executionPrice = null;
  let allocationShares = 0;

  // ── Phase 1 Block Execution ──
  if (currentIntervalBlock <= 135) {
    targetedSide = upMid <= downMid ? 'Up' : 'Down';
    executionPrice = targetedSide === 'Up' ? upMid : downMid;
    allocationShares = calculateCompoundedShares(PHASE_1_BASE_SHARES);
    log(`🔭 [Tick ${currentIntervalBlock}s] Phase 1: Cheapest Selection -> ${targetedSide} (Mid: ${executionPrice})`);
  } 
  // ── Phase 2 Block Execution ──
  else if (currentIntervalBlock > 135 && currentIntervalBlock <= 270) {
    targetedSide = upMid >= downMid ? 'Up' : 'Down';
    executionPrice = targetedSide === 'Up' ? upMid : downMid;
    allocationShares = calculateCompoundedShares(PHASE_2_BASE_SHARES);
    log(`🔭 [Tick ${currentIntervalBlock}s] Phase 2: Expensive Selection -> ${targetedSide} (Mid: ${executionPrice})`);
  }

  if (targetedSide) {
    const targetTokenId = targetedSide === 'Up' ? btcState.upTokenId : btcState.downTokenId;
    const totalOrderCost = r2(executionPrice * allocationShares);

    if (totalOrderCost <= btcState.bankroll) {
      await placeLimitBuy(targetTokenId, executionPrice, allocationShares);
      
      // Simulate Maker execution model properties
      const rebate = makerRebate(allocationShares, executionPrice);
      btcState.bankroll = r2(btcState.bankroll - totalOrderCost + rebate);
      btcState.rebatesEarned = r2(btcState.rebatesEarned + rebate);
      btcState.activePositions[targetedSide] += allocationShares;

      log(`✅ Order Routed: Maker Limit Buy ${allocationShares} shares on ${targetedSide} at Mid ${executionPrice}`);
      
      const record = { time: new Date().toISOString().slice(11, 19), symbol: TARGET_ASSET, side: 'BUY', outcome: targetedSide, reason: `INTERVAL_${currentIntervalBlock}S`, price: executionPrice, shares: allocationShares, cost: totalOrderCost, rebate };
      trades.push(record);
    } else {
      log(`⚠️ Liquidity Skip: Insufficient capital to execute ${allocationShares} shares ($${totalOrderCost})`);
    }
  }

  btcState.executedIntervals.add(currentIntervalBlock);
}

async function executeTakeProfitRouting() {
  if (btcState.tpPlaced) return;
  log(`🎯 [Target Window Check: 280s] Phase 3: Executing Maker Exit Strategies at ${TAKE_PROFIT_PRICE}`);

  // Route Take Profits for Up Positions
  if (btcState.activePositions.Up > 0) {
    await placeLimitSell(btcState.upTokenId, TAKE_PROFIT_PRICE, btcState.activePositions.Up);
    const rebate = makerRebate(btcState.activePositions.Up, TAKE_PROFIT_PRICE);
    btcState.bankroll = r2(btcState.bankroll + (btcState.activePositions.Up * TAKE_PROFIT_PRICE) + rebate);
    btcState.rebatesEarned = r2(btcState.rebatesEarned + rebate);
    log(`💰 TP Maker order dispatched for ${btcState.activePositions.Up} Up shares.`);
  }

  // Route Take Profits for Down Positions
  if (btcState.activePositions.Down > 0) {
    await placeLimitSell(btcState.downTokenId, TAKE_PROFIT_PRICE, btcState.activePositions.Down);
    const rebate = makerRebate(btcState.activePositions.Down, TAKE_PROFIT_PRICE);
    btcState.bankroll = r2(btcState.bankroll + (btcState.activePositions.Down * TAKE_PROFIT_PRICE) + rebate);
    btcState.rebatesEarned = r2(btcState.rebatesEarned + rebate);
    log(`💰 TP Maker order dispatched for ${btcState.activePositions.Down} Down shares.`);
  }

  btcState.tpPlaced = true;
}

async function finalizeWindowSettlement() {
  if (btcState.resolvedThisWindow) return;
  btcState.resolvedThisWindow = true;

  try {
    const event = await getJSON(`${GAMMA}/events/slug/${encodeURIComponent(btcState.slug)}`);
    const market = (event.markets || []).find(m => m.conditionId === btcState.conditionId) || event.markets[0];
    
    if (market && market.closed === true && market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      
      let winnerIndex = parseFloat(prices[0]) > parseFloat(prices[1]) ? 0 : 1;
      const winner = (outcomes[winnerIndex] || '').trim().toLowerCase();
      const winSide = winner === 'up' ? 'Up' : 'Down';

      log(`💥 Polymarket Resolution Finalized: Winning outcome is [${winSide}]`);

      // Account for native payouts (1.00 for win side shares if any remained unliquidated)
      const heldShares = btcState.activePositions[winSide];
      if (heldShares > 0) {
        const resolutionPayout = r2(heldShares * 1.0);
        btcState.bankroll = r2(btcState.bankroll + resolutionPayout);
        btcState.wins++;
        log(`💰 Resolution Payout Claimed: +$${resolutionPayout} on ${heldShares} won shares.`);
      } else {
        btcState.losses++;
      }
    }
  } catch (_) {
    log(`⚠️ Resolution engine lookup error. Carrying native allocations forward.`);
  }

  // Reset counters for next rotation block
  btcState.activePositions = { Up: 0, Down: 0 };
  
  // Track continuous global equity tracking line
  totalEquityCurve.push({ t: Date.now(), equity: btcState.bankroll });
  btcState.equityCurve.push({ t: Date.now(), equity: btcState.bankroll });
}

// ─────────────────────────────────────────
//  Main Loop Control Flow Architecture
// ─────────────────────────────────────────
async function processBtcEngineTick() {
  const ws = currentWindowStart();
  if (btcState.windowStart === null || ws !== btcState.windowStart) {
    if (!btcState.resolvedThisWindow) await finalizeWindowSettlement();
    await loadBtcWindow();
  }

  if (!btcState.tradable || !tradingEnabled) return;

  const elapsedSecs = nowSec() - btcState.windowStart;

  // Interval execution logic check (0s - 270s)
  if (elapsedSecs <= 270) {
    await handleMicroIntervalExecution(elapsedSecs);
  }
  // Take profit conversion window block (280s - 299s)
  else if (elapsedSecs >= 280 && elapsedSecs < 300) {
    await executeTakeProfitRouting();
  }
  // Market window expiration resolution cut-off (300s+)
  else if (elapsedSecs >= 300) {
    await finalizeWindowSettlement();
  }
}

let loopRunning = false;
async function mainLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastPolyPriceFetch >= POLY_PRICE_REFRESH_MS) {
        lastPolyPriceFetch = now;
        await refreshPrices();
      }
      await processBtcEngineTick();
      emitFn('state', buildState());
    } catch (e) {
      log(`⚠️ State Processing Engine Error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

// ─────────────────────────────────────────
//  Dashboard State Formatter UI Payload
// ─────────────────────────────────────────
function buildState() {
  const markValue = r2(btcState.bankroll);
  const pairStates = [{
    symbol: btcState.symbol,
    tradable: btcState.tradable,
    slug: btcState.slug,
    windowEnd: btcState.windowEnd,
    secsToEnd: btcState.windowEnd ? Math.max(0, Math.floor(btcState.windowEnd - nowSec())) : null,
    upAsk: btcState.upAsk, upBid: btcState.upBid, downAsk: btcState.downAsk, downBid: btcState.downBid,
    deficit: 0,
    flipsUsed: 0,
    bankroll: btcState.bankroll,
    realizedPnl: btcState.realizedPnl,
    unrealizedPnl: 0,
    markValue,
    feesPaid: btcState.feesPaid,
    rebatesEarned: btcState.rebatesEarned,
    wins: btcState.wins,
    losses: btcState.losses,
    currentPosition: (btcState.activePositions.Up > 0 || btcState.activePositions.Down > 0) ? {
      side: `Up: ${btcState.activePositions.Up}sh / Down: ${btcState.activePositions.Down}sh`,
      state: btcState.tpPlaced ? 'TP_ROUTED' : 'ACCUMULATING',
      entryPrice: 0,
      shares: btcState.activePositions.Up + btcState.activePositions.Down,
      cost: 0
    } : null,
    pendingFlip: null,
    equityCurve: btcState.equityCurve
  }];

  return {
    dryRun: DRY_RUN,
    tradingEnabled,
    pairs: [TARGET_ASSET],
    totalCapital: TOTAL_CAPITAL,
    perPairCapital: TOTAL_CAPITAL,
    totalBankroll: btcState.bankroll,
    totalMarkValue: markValue,
    totalRealizedPnl: btcState.realizedPnl,
    totalUnrealizedPnl: 0,
    totalPnl: r2(markValue - TOTAL_CAPITAL),
    totalWins: btcState.wins, totalLosses: btcState.losses,
    totalFeesPaid: btcState.feesPaid,
    totalRebatesEarned: btcState.rebatesEarned,
    totalDeficit: 0,
    winRate: (btcState.wins + btcState.losses) > 0 ? r2((btcState.wins / (btcState.wins + btcState.losses)) * 100) : null,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    config: { entryTriggerPrice: 0, fixedTpPrice: TAKE_PROFIT_PRICE, baseShares: PHASE_1_BASE_SHARES, flipTargetProfit: 0, maxFlipsPerWindow: 0 },
    pairStates,
    totalEquityCurve,
    logs: logs.slice(-100),
    trades: trades.slice(-80).reverse()
  };
}

// ─────────────────────────────────────────
//  System Module Operations
// ─────────────────────────────────────────
function setPairs(list) { return { ok: true, pairs: [TARGET_ASSET], perPairCapital: TOTAL_CAPITAL }; }
function pauseTrading() { tradingEnabled = false; return { ok: true }; }
function resumeTrading() { tradingEnabled = true; return { ok: true }; }
function getStatus() { return { ok: true, ...buildState() }; }

async function init(privateKey, emit, slogFn) {
  emitFn = emit;
  slog = slogFn;
  log(`🚀 Initializing BTC Time-Interval Scalper Frame...`);
  
  trader = new PolymarketTrader(privateKey);
  await trader.authenticate();

  mainLoop().catch(e => log(`❌ Fatal Crash: ${e.message}`));
}

module.exports = { init, setPairs, pauseTrading, resumeTrading, getStatus, buildState };
