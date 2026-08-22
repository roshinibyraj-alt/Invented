'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC INDEPENDENT LIMIT LADDER ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 *  Every 20 seconds each side independently places one 50-share GTC buy
 *  0.10 below its current midpoint. Filled shares hold through resolution.
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS            = 200;
const DISCOVERY_RETRY_MS = 500;
const RESOLUTION_POLL_MS = 1000;
const EQUITY_RECORD_MS   = 1000;
const WINNER_PRICE       = 0.90;

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function sgn2(n) { return (n > 0 ? '+$' : (n < 0 ? '-$' : '±$')) + Math.abs(n).toFixed(2); }

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function createEngine(cfg) {
  const {
    label = 'BTC-LADDER',
    startingCapital = 4000,
    windowType = '5m',
    windowSeconds5 = 300,
    baseShares = 50,
    orderIntervalSeconds = 20,
    limitOffset = 0.10,
    rangeMin = 0.25,
    rangeMax = 0.99,
    feeTheta = 0.07,
    trader,
    dryRun = true,
    statsStatePath,
    emit = () => {},
    slog = () => {},
    nowFn = Date.now,
    tickMs = TICK_MS,
    priceRefreshMs = 200,
  } = cfg;

  const winSec = windowSeconds5;
  const capital = round2(startingCapital);
  let DRY_RUN = dryRun;
  let posSeq = 0;
  let orderSeq = 0;
  let lastOrderPoll = 0;

  function loadStats() {
    if (!statsStatePath) return null;
    try { return JSON.parse(fs.readFileSync(statsStatePath, 'utf8')); } catch (_) { return null; }
  }
  const saved = loadStats();

  function freshSideState() {
    return {
      orders: [],
      positions: [],
      trades: [],
    };
  }

  const engine = {
    bankroll: saved ? saved.bankroll : capital,
    realizedPnl: saved ? saved.realizedPnl || 0 : 0,
    wins: saved ? saved.wins || 0 : 0,
    losses: saved ? saved.losses || 0 : 0,
    history: saved && Array.isArray(saved.history) ? saved.history : [],
    equityCurve: saved && Array.isArray(saved.equityCurve) && saved.equityCurve.length
      ? saved.equityCurve : [{ t: nowFn(), equity: capital }],
    up: freshSideState(),
    down: freshSideState(),
    leg: null,
    lastPriceFetch: 0,
    lastEquityRecord: 0,
    totalFeesPaid: saved ? saved.totalFeesPaid || 0 : 0,
    logs: [],
  };

  function log(msg) {
    const line = `[${label}] ${new Date().toISOString()} ${msg}`;
    engine.logs.push(line);
    if (engine.logs.length > 300) engine.logs.shift();
    slog(line);
  }

  function saveStats() {
    if (!statsStatePath) return;
    try {
      fs.writeFileSync(statsStatePath, JSON.stringify({
        bankroll: engine.bankroll, realizedPnl: engine.realizedPnl,
        wins: engine.wins, losses: engine.losses,
        history: engine.history.slice(0, 100),
        equityCurve: engine.equityCurve.slice(-300),
        totalFeesPaid: engine.totalFeesPaid, savedAt: nowFn(),
      }));
    } catch (_) {}
  }

  // ── Market discovery ──
  function parseTokens(mk) {
    try {
      const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
      const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
      return outcomes.map((o, i) => ({ outcome: o, token_id: tokenIds[i] || null }));
    } catch (_) { return []; }
  }

  function freshLeg(windowTs) {
    return {
      slug: `btc-updown-${windowType}-${windowTs}`,
      windowTs, closeAt: (windowTs + winSec) * 1000,
      conditionId: null, upTokenId: null, downTokenId: null,
      upMid: null, downMid: null,
      discovered: false, lastDiscoveryAttempt: 0,
      nextLadderAt: winSec > 0 ? 20 : 0,
      resolved: false, winner: null,
    };
  }

  async function discoverLeg(leg) {
    try {
      const candidates = [leg.slug];
      const prefix = leg.slug.split('-').slice(0, -1).join('-');
      candidates.push(`${prefix}-${leg.windowTs - winSec}`);
      candidates.push(`${prefix}-${leg.windowTs + winSec}`);
      for (const slug of candidates) {
        const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`).catch(() => null);
        const event = Array.isArray(events) ? events[0] : null;
        if (!event) continue;
        const mk = (event.markets || [])[0];
        if (!mk) continue;
        const tokens = parseTokens(mk);
        const up = tokens.find(t => /up/i.test(t.outcome));
        const down = tokens.find(t => /down/i.test(t.outcome));
        if (!up || !down || !up.token_id || !down.token_id) continue;
        leg.conditionId = mk.conditionId || null;
        leg.upTokenId = up.token_id;
        leg.downTokenId = down.token_id;
        leg.slug = slug;
        leg.discovered = true;
        log(`🎯 leg discovered ${slug}`);
        return;
      }
    } catch (e) { log(`⚠️ discoverLeg: ${e.message}`); }
  }

  async function refreshLegPrices(leg) {
    if (!leg.upTokenId || !leg.downTokenId) return;
    try {
      const [upM, downM] = await Promise.all([
        getJSON(`${CLOB}/midpoint?token_id=${leg.upTokenId}`).catch(() => null),
        getJSON(`${CLOB}/midpoint?token_id=${leg.downTokenId}`).catch(() => null),
      ]);
      if (upM?.mid != null) leg.upMid = parseFloat(upM.mid);
      if (downM?.mid != null) leg.downMid = parseFloat(downM.mid);
    } catch (_) {}
  }

  async function attemptFastResolution(leg) {
    if (leg.resolved) return true;
    if (leg.upMid != null && leg.upMid > WINNER_PRICE) { leg.resolved = true; leg.winner = 'up'; return true; }
    if (leg.downMid != null && leg.downMid > WINNER_PRICE) { leg.resolved = true; leg.winner = 'down'; return true; }
    return false;
  }

  async function resolveLegOfficial(leg) {
    if (leg.resolved) return true;
    try {
      let mk = null;
      if (leg.conditionId) {
        const arr = await getJSON(`${GAMMA}/markets?condition_ids=${encodeURIComponent(leg.conditionId)}`);
        mk = Array.isArray(arr) ? arr[0] : null;
      }
      if (!mk) {
        const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(leg.slug)}`);
        const ev = Array.isArray(events) ? events[0] : null;
        mk = ev ? (ev.markets || [])[0] : null;
      }
      if (mk && mk.closed === true && mk.outcomePrices) {
        const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : mk.outcomePrices;
        const tokens = parseTokens(mk);
        const upIdx = tokens.findIndex(t => String(t.token_id) === String(leg.upTokenId));
        if (upIdx >= 0 && prices[upIdx] != null) {
          leg.resolved = true;
          leg.winner = parseFloat(prices[upIdx]) >= 0.5 ? 'up' : 'down';
          log(`🏁 official resolution — winner ${leg.winner.toUpperCase()}`);
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  // ── Trading ──
  function getPrice(side) { return side === 'up' ? engine.leg.upMid : engine.leg.downMid; }
  function computeFee(shares, price) { return shares * feeTheta * price * (1 - price); }

  async function placeLadderOrder(side, elapsedSec) {
    const leg = engine.leg;
    const currentPrice = getPrice(side);
    if (currentPrice == null || currentPrice < rangeMin || currentPrice > rangeMax) return;

    const targetCents = Math.round((currentPrice - limitOffset) * 100);
    const limitPrice = round2(Math.max(0.01, Math.floor(targetCents) / 100));
    const record = {
      id: ++orderSeq,
      side,
      signalPrice: round3(currentPrice),
      price: limitPrice,
      shares: baseShares,
      filledShares: 0,
      placedAtMs: nowFn(),
      placedAtSecond: elapsedSec,
      status: 'OPEN',
      orderId: null,
    };

    if (!DRY_RUN) {
      const tokenId = side === 'up' ? leg.upTokenId : leg.downTokenId;
      const response = await trader.placeGtcOrder(tokenId, 'BUY', limitPrice, baseShares);
      record.orderId = response.id;
    }

    engine[side].orders.push(record);
    log(`📥 ${side.toUpperCase()} LIMIT #${record.id} — ${baseShares}sh @${limitPrice.toFixed(2)} | signal ${currentPrice.toFixed(3)} | t=${elapsedSec}s`);
  }

  async function processLadderInterval() {
    const leg = engine.leg;
    if (!leg?.discovered || leg.upMid == null || leg.downMid == null) return;
    const elapsedSec = Math.floor(nowFn() / 1000) - leg.windowTs;
    if (elapsedSec < leg.nextLadderAt || elapsedSec >= winSec) return;

    leg.nextLadderAt = (Math.floor(elapsedSec / orderIntervalSeconds) + 1) * orderIntervalSeconds;
    for (const side of ['up', 'down']) {
      try { await placeLadderOrder(side, elapsedSec); }
      catch (e) { log(`❌ ${side.toUpperCase()} ORDER FAILED t=${elapsedSec}s — ${e.message}`); }
    }
  }

  function applyFill(record, fillShares, fillPrice) {
    if (fillShares <= 0) return;
    const fee = computeFee(fillShares, fillPrice);
    const cost = round2(fillShares * fillPrice + fee);
    engine.bankroll = round2(engine.bankroll - cost);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    const priorShares = record.filledShares;
    const priorAverage = record.avgFillPrice || 0;
    const totalShares = round3(priorShares + fillShares);
    record.avgFillPrice = priorShares > 0
      ? round3(((priorShares * priorAverage) + (fillShares * fillPrice)) / totalShares)
      : round3(fillPrice);
    record.filledShares = round3(record.filledShares + fillShares);
    record.status = record.filledShares >= record.shares - 1e-9 ? 'FILLED' : 'PARTIAL';
    const pos = {
      id: ++posSeq,
      orderId: record.id,
      side: record.side,
      entryPrice: fillPrice,
      shares: fillShares,
      cost,
      filledAtMs: nowFn(),
    };
    engine[record.side].positions.push(pos);
    engine[record.side].trades.push({
      side: record.side,
      type: 'fill',
      entry: fillPrice,
      shares: fillShares,
      pnl: 0,
    });
    log(`🎯 ${record.side.toUpperCase()} FILL #${pos.id} — ${fillShares}sh @${fillPrice.toFixed(2)} | cost $${cost.toFixed(2)} | order #${record.id}`);
  }

  async function syncLiveOrder(record) {
    const state = await trader.getOrder(record.orderId);
    const originalSize = parseFloat(state?.original_size ?? state?.size ?? record.shares);
    const filledShares = parseFloat(state?.size_matched ?? state?.filled_size ?? state?.taker_amount ?? '0');
    const safeFilled = Number.isFinite(filledShares) ? Math.min(originalSize || record.shares, Math.max(0, filledShares)) : 0;
    const newShares = round3(safeFilled - record.filledShares);
    const cumulativeAverage = parseFloat(state?.avg_price ?? state?.avg_fill_price ?? record.price);
    let marginalPrice = record.price;
    if (Number.isFinite(cumulativeAverage) && cumulativeAverage > 0) {
      const priorShares = record.filledShares;
      const priorAverage = record.avgFillPrice || 0;
      marginalPrice = priorShares > 0 && safeFilled > priorShares
        ? ((safeFilled * cumulativeAverage) - (priorShares * priorAverage)) / (safeFilled - priorShares)
        : cumulativeAverage;
      marginalPrice = Math.min(0.99, Math.max(0.01, marginalPrice));
    }
    applyFill(record, newShares, marginalPrice);
    const status = String(state?.status || '').toUpperCase();
    if (status === 'CANCELLED' && record.status !== 'FILLED') record.status = safeFilled > 0 ? 'PARTIAL' : 'CANCELLED';
  }

  function processDemoFills() {
    const leg = engine.leg;
    for (const side of ['up', 'down']) {
      const price = getPrice(side);
      if (price == null) continue;
      for (const record of engine[side].orders) {
        if ((record.status === 'OPEN' || record.status === 'PARTIAL') && price <= record.price) {
          applyFill(record, round3(record.shares - record.filledShares), record.price);
        }
      }
    }
  }

  async function syncLiveFills() {
    const openRecords = ['up', 'down'].flatMap(side => engine[side].orders)
      .filter(record => record.orderId && record.status !== 'FILLED' && record.status !== 'CANCELLED');
    if (!openRecords.length) return;
    for (const record of openRecords) {
      try { await syncLiveOrder(record); }
      catch (e) { log(`⚠️ ORDER SYNC #${record.id}: ${e.message}`); }
    }
  }

  async function cancelWindowOrders(oldLeg) {
    for (const side of ['up', 'down']) {
      for (const record of engine[side].orders) {
        if (record.status === 'FILLED' || record.status === 'CANCELLED') continue;
        try {
          if (!DRY_RUN && record.orderId) await trader.cancelOrder(record.orderId);
          if (!DRY_RUN && record.orderId) await syncLiveOrder(record);
          if (record.status !== 'FILLED') record.status = record.filledShares > 0 ? 'PARTIAL' : 'CANCELLED';
          if (record.status !== 'FILLED') log(`🚫 CANCELLED ${side.toUpperCase()} LIMIT #${record.id} @${record.price.toFixed(2)}`);
        } catch (e) {
          log(`⚠️ CANCEL FAIL ${side.toUpperCase()} #${record.id}: ${e.message}`);
        }
      }
    }
    void oldLeg;
  }

  function settleWindow(winner) {
    let totalPnl = 0;
    let resolvedCount = 0;
    log(`🏁 WINDOW RESOLVED — ${String(winner).toUpperCase()}`);
    for (const side of ['up', 'down']) {
      const st = engine[side];
      for (const pos of st.positions) {
        const payout = winner === side ? pos.shares : 0;
        const pnl = round2(payout - pos.cost);
        engine.bankroll = round2(engine.bankroll + payout);
        engine.realizedPnl = round2(engine.realizedPnl + pnl);
        if (pnl > 0) engine.wins++; else engine.losses++;
        st.trades.push({ side, type: 'resolution', entry: pos.entryPrice, exit: winner === side ? 1.0 : 0, shares: pos.shares, pnl });
        resolvedCount++;
        totalPnl += pnl;
        log(`🏁 ${side.toUpperCase()} #${pos.id} RESOLVED — ${winner === side ? 'WIN' : 'LOSS'} ${sgn2(pnl)}`);
      }
      st.positions = [];
      if (st.trades.length > 0) {
        const sideTotal = round2(st.trades.reduce((a, t) => a + t.pnl, 0));
        engine.history.unshift({
          windowTs: engine.leg.windowTs, slug: engine.leg.slug, side,
          trades: resolvedCount, pnl: sideTotal, bankrollAfter: engine.bankroll,
        });
      }
    }
    if (engine.history.length > 300) engine.history.length = 300;
    saveStats();
  }

  // ── Main loop ──
  async function mainLoop() {
    while (true) {
      try {
        const now = nowFn();
        const nowSec = Math.floor(now / 1000);
        const windowTs = Math.floor(nowSec / winSec) * winSec;

        if (!engine.leg || engine.leg.windowTs !== windowTs) {
          if (engine.leg) {
            const oldLeg = engine.leg;
            await cancelWindowOrders(oldLeg);
            if (!oldLeg.resolved) await attemptFastResolution(oldLeg);
            if (!oldLeg.resolved) await resolveLegOfficial(oldLeg);
            settleWindow(oldLeg.winner);
          }
          engine.leg = freshLeg(windowTs);
          engine.up = freshSideState();
          engine.down = freshSideState();
          log(`🆕 window t=${windowTs}`);
        }

        const leg = engine.leg;

        if (!leg.discovered && now - leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
          leg.lastDiscoveryAttempt = now;
          await discoverLeg(leg);
        }

        if (now - engine.lastPriceFetch >= priceRefreshMs) {
          engine.lastPriceFetch = now;
          await refreshLegPrices(leg);
        }

        if (leg.discovered) {
          await processLadderInterval();
          processDemoFills();
          if (!DRY_RUN && now - lastOrderPoll >= 500) {
            lastOrderPoll = now;
            await syncLiveFills();
          }
        }

        if (now - engine.lastEquityRecord >= EQUITY_RECORD_MS) {
          engine.lastEquityRecord = now;
          let mtm = 0;
          for (const side of ['up', 'down']) {
            const p = getPrice(side);
            for (const pos of engine[side].positions) {
              if (p != null) mtm += pos.shares * p;
            }
          }
          engine.equityCurve.push({ t: now, equity: round2(engine.bankroll + mtm) });
          if (engine.equityCurve.length > 10000) engine.equityCurve.shift();
        }

        emitState();
      } catch (e) { log(`⚠️ Loop error: ${e.message}`); }
      await new Promise(res => setTimeout(res, tickMs));
    }
  }

  // ── Dashboard state ──
  function buildState() {
    const leg = engine.leg;
    function sideInfo(name, st) {
      const p = name === 'up' ? (leg?.upMid || 0) : (leg?.downMid || 0);
      const openOrders = st.orders.filter(order => order.status === 'OPEN' || order.status === 'PARTIAL');
      return {
        orders: st.orders.slice(-20),
        openOrders: openOrders.map(order => ({ ...order })),
        openOrderCount: openOrders.length,
        openOrderShares: openOrders.reduce((sum, order) => sum + (order.shares - order.filledShares), 0),
        positions: st.positions.map(pos => ({
          ...pos,
          unrealizedPnl: round2(pos.shares * p - pos.cost),
        })),
        totalUnrealized: round2(st.positions.reduce((a, pos) => a + (pos.shares * p - pos.cost), 0)),
        totalShares: st.positions.reduce((a, pos) => a + pos.shares, 0),
        tradesThisWindow: st.trades.length,
      };
    }
    const decided = engine.wins + engine.losses;
    const totalUnreal = round2(
      engine.up.positions.reduce((a, pos) => a + pos.shares * (leg?.upMid || 0) - pos.cost, 0) +
      engine.down.positions.reduce((a, pos) => a + pos.shares * (leg?.downMid || 0) - pos.cost, 0)
    );
    return {
      label, windowSeconds: winSec, dryRun: DRY_RUN,
      strategy: 'independent-limit-ladder',
      orderIntervalSeconds, limitOffset, rangeMin, rangeMax, baseShares,
      bankroll: engine.bankroll, startingCapital: capital,
      realizedPnl: engine.realizedPnl,
      unrealizedPnl: totalUnreal,
      equity: round2(engine.bankroll + totalUnreal),
      equityCurve: engine.equityCurve.slice(-200),
      wins: engine.wins, losses: engine.losses,
      winRate: decided > 0 ? round2(engine.wins / decided * 100) : null,
      up: sideInfo('up', engine.up),
      down: sideInfo('down', engine.down),
      currentLeg: leg ? {
        slug: leg.slug, discovered: leg.discovered,
        upMid: leg.upMid, downMid: leg.downMid,
        secsLeft: Math.max(0, Math.round((leg.closeAt - nowFn()) / 1000)),
      } : null,
      history: engine.history.slice(0, 30),
      logs: engine.logs.slice(-50),
      totalFeesPaid: engine.totalFeesPaid,
    };
  }

  function emitState() { emit('hedgeState:' + label, buildState()); }
  function pauseTrading() { return { ok: true }; }
  function resumeTrading() { return { ok: true }; }
  function setMode(live) { DRY_RUN = !live; log(`⚙️ ${live ? 'LIVE' : 'DEMO'}`); return { ok: true }; }

  async function start() {
    log(`⛏ ${label} — Independent Limit Ladder`);
    log(`⚙️ Every ${orderIntervalSeconds}s | ${baseShares}sh @ mid-${limitOffset.toFixed(2)} | range ${rangeMin.toFixed(2)}-${rangeMax.toFixed(2)} | hold to resolution`);
    log(`⚙️ Capital $${capital.toFixed(2)} | ${DRY_RUN ? 'DEMO' : 'LIVE'}`);
    mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine };
