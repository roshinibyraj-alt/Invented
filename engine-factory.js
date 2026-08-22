'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC EARLY FAVORITE ENGINE — momentum continuation
 * ═══════════════════════════════════════════════════════════════
 *
 *  One decision per window: buy the leading side at the decision time if it
 *  has reached the favorite threshold, then hold through resolution.
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
    label = 'BTC-DIP',
    startingCapital = 4000,
    windowType = '5m',
    windowSeconds5 = 300,
    baseShares = 50,
    entryAtSeconds = 30,
    minFavoritePrice = 0.64,
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

  function loadStats() {
    if (!statsStatePath) return null;
    try { return JSON.parse(fs.readFileSync(statsStatePath, 'utf8')); } catch (_) { return null; }
  }
  const saved = loadStats();

  function freshSideState() {
    return {
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
    } catch (e) { log(`⚠️ official resolution: ${e.message}`); }
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
      entryAttempted: false, entrySide: null,
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

  async function processEntry() {
    const leg = engine.leg;
    if (!leg?.discovered || leg.entryAttempted || leg.upMid == null || leg.downMid == null) return;
    const now = nowFn();
    const nowSec = Math.floor(now / 1000);
    const elapsedSec = nowSec - engine.leg.windowTs;

    if (elapsedSec < entryAtSeconds) return;
    leg.entryAttempted = true;

    const side = leg.upMid >= leg.downMid ? 'up' : 'down';
    const favoritePrice = getPrice(side);
    const underdogPrice = getPrice(side === 'up' ? 'down' : 'up');
    if (favoritePrice < minFavoritePrice || favoritePrice <= underdogPrice) {
      leg.entrySide = 'skipped';
      log(`⏭️ t=${elapsedSec}s SKIP — leading ${side.toUpperCase()} @${favoritePrice.toFixed(3)} < ${minFavoritePrice.toFixed(2)}`);
      return;
    }

    let entryPrice = round2(favoritePrice);
    if (!DRY_RUN) {
      const tokenId = side === 'up' ? leg.upTokenId : leg.downTokenId;
      const book = await trader.getBestBidAsk(tokenId);
      if (!book || book.bestAsk == null || book.bestAsk <= 0) {
        leg.entrySide = 'skipped';
        log(`⚠️ t=${elapsedSec}s SKIP — no executable ask`);
        return;
      }

      entryPrice = Math.min(0.99, Math.ceil(book.bestAsk * 100) / 100);
      const order = await trader.placeFokLimitOrder(tokenId, 'BUY', entryPrice, baseShares);
      if (!order.isFilled) {
        leg.entrySide = 'skipped';
        log(`❌ ${side.toUpperCase()} ORDER REJECTED @${entryPrice.toFixed(2)} — no fallback`);
        return;
      }
    }

    const fee = computeFee(baseShares, entryPrice);
    const cost = round2(baseShares * entryPrice + fee);
    engine.bankroll = round2(engine.bankroll - cost);
    engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
    const pos = { id: ++posSeq, side, entryPrice, shares: baseShares, cost };
    engine[side].positions.push(pos);
    leg.entrySide = side;
    log(`🎯 ${side.toUpperCase()} FAVORITE #${pos.id} — ${baseShares}sh @${entryPrice.toFixed(2)} | HOLD | cost $${cost.toFixed(2)} | t=${elapsedSec}s`);
  }

  function settleWindow(winner) {
    let totalPnl = 0;
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
        totalPnl += pnl;
        log(`🏁 ${side.toUpperCase()} #${pos.id} RESOLVED — ${winner === side ? 'WIN' : 'LOSS'} ${sgn2(pnl)}`);
      }
      st.positions = [];
      if (st.trades.length > 0) {
        const sideTotal = round2(st.trades.reduce((a, t) => a + t.pnl, 0));
        engine.history.unshift({
          windowTs: engine.leg.windowTs, slug: engine.leg.slug, side,
          trades: st.trades.length, pnl: sideTotal, bankrollAfter: engine.bankroll,
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
          await processEntry();
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
      return {
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
      strategy: 'early-favorite',
      entryAtSeconds, minFavoritePrice, baseShares,
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
    log(`⛏ ${label} — Early Favorite Engine`);
    log(`⚙️ t=${entryAtSeconds}s | Leading ≥${minFavoritePrice.toFixed(2)} | ${baseShares}sh | hold to resolution`);
    log(`⚙️ Capital $${capital.toFixed(2)} | ${DRY_RUN ? 'DEMO' : 'LIVE'}`);
    mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine };
