'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC DIP-BUY ENGINE — Volatility-scaled, asymmetric payoff
 * ═══════════════════════════════════════════════════════════════
 *
 *  Core idea: buy sharp dips (oversold bounces), size by conviction.
 *
 *  1. Track rolling peak per side (highest since last fill).
 *  2. Signal: price drops ≥ DIP_THRESHOLD from peak while in range.
 *  3. Position size scales with drop depth: bigger dip = more shares.
 *  4. TP scales with entry price: cheaper entry = wider profit target.
 *     e.g. entry @0.25 → TP @0.35 (+40%), entry @0.70 → TP @0.80 (+14%).
 *  5. No stop loss — cheap entries have asymmetric upside ($1 payout).
 *  6. Max 4 open positions per side per window (exposure cap).
 *  7. Cooldown 8s between entries per side.
 *  8. Trade entire window. UP/DOWN independent. Single engine 0.10–0.90.
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
    baseShares = 50,           // shares at minimum signal
    maxShares = 200,           // shares at maximum signal
    dipThreshold = 0.12,       // minimum drop from peak to trigger
    cooldownMs = 8000,         // ms between entries per side
    maxPositionsPerSide = 4,   // exposure cap
    rangeMin = 0.10,
    rangeMax = 0.90,
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
      rollingPeak: 0,          // highest since last fill
      lastEntryAt: 0,          // timestamp of last entry
      positions: [],            // open positions
      trades: [],               // completed trades this window
      priceHistory: [],         // recent prices for volatility calc
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
    pending: [],
    lastResolutionPoll: 0,
    lastPriceFetch: 0,
    lastEquityRecord: 0,
    totalFeesPaid: saved ? saved.totalFeesPaid || 0 : 0,
    logs: [],
  };

  function log(msg) {
    const line = `[${label}] ${new Date().toISOString()} ${msg}`;
    console.log(line);
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

  // Calculate dynamic position size based on dip depth
  // Deeper dip = more conviction = more shares
  function calcShares(drop) {
    // Normalize: drop of 0.12 = minimum, drop of 0.40+ = maximum
    const conviction = Math.min(1.0, Math.max(0, (drop - dipThreshold) / 0.28));
    return Math.max(baseShares, Math.min(maxShares, Math.floor((baseShares + conviction * (maxShares - baseShares)) / 10) * 10));
  }

  // Dynamic TP: cheaper entry = wider target (asymmetric payoff)
  // Entry @0.20 → TP @0.32 (+60%)
  // Entry @0.40 → TP @0.52 (+30%)
  // Entry @0.60 → TP @0.72 (+20%)
  // Entry @0.80 → TP @0.92 (+15%)
  function calcTP(entryPrice) {
    const pctGain = Math.max(0.12, 0.55 - entryPrice * 0.55);
    return round3(Math.min(0.97, entryPrice + pctGain));
  }

  function processSideTick(side, price) {
    const st = engine[side];
    if (price == null) return;

    // Track rolling peak (resets after each fill)
    if (price > st.rollingPeak) st.rollingPeak = price;

    // Record price history for volatility tracking
    st.priceHistory.push({ t: nowFn(), p: price });
    if (st.priceHistory.length > 300) st.priceHistory.shift();

    // Check TP on open positions
    for (let i = st.positions.length - 1; i >= 0; i--) {
      const pos = st.positions[i];
      if (price >= pos.tpPrice) {
        const proceeds = round2(pos.shares * pos.tpPrice);
        const fee = computeFee(pos.shares, pos.tpPrice);
        const net = round2(proceeds - fee);
        const pnl = round2(net - pos.cost);
        engine.bankroll = round2(engine.bankroll + net);
        engine.realizedPnl = round2(engine.realizedPnl + pnl);
        engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
        if (pnl > 0) engine.wins++; else engine.losses++;
        st.trades.push({ side, type: 'TP', entry: pos.entryPrice, exit: pos.tpPrice, shares: pos.shares, pnl });
        log(`✅ ${side.toUpperCase()} TP #${pos.id} — ${pos.shares}sh @${pos.tpPrice.toFixed(3)} | PnL ${sgn2(pnl)} | $${engine.bankroll.toFixed(2)}`);
        st.positions.splice(i, 1);
        // Reset rolling peak after a fill so next signal needs fresh momentum
        st.rollingPeak = price;
      }
    }

    // Check entry signal: deep dip from rolling peak
    const drop = st.rollingPeak - price;
    const cooldownOk = (nowFn() - st.lastEntryAt) >= cooldownMs;
    const canEnter = st.positions.length < maxPositionsPerSide;

    if (drop >= dipThreshold && price >= rangeMin && price <= rangeMax && cooldownOk && canEnter) {
      const shares = calcShares(drop);
      const fee = computeFee(shares, price);
      const cost = round2(shares * price + fee);
      const tp = calcTP(price);
      engine.bankroll = round2(engine.bankroll - cost);
      engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);

      const pos = {
        id: ++posSeq,
        side,
        entryPrice: round3(price),
        shares,
        cost,
        tpPrice: tp,
        dipDepth: round3(drop),
      };
      st.positions.push(pos);
      st.lastEntryAt = nowFn();
      // Reset peak so we need a NEW rally before next signal
      st.rollingPeak = price;

      log(`🎯 ${side.toUpperCase()} DIP BUY #${pos.id} — ${shares}sh @${pos.entryPrice.toFixed(3)} (dip ${round3(drop)} from ${st.rollingPeak + drop}) | TP @${tp.toFixed(3)} | cost $${cost.toFixed(2)}`);
    }
  }

  function settleWindow(winner) {
    let totalPnl = 0;
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

        if (engine.pending.length && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
          engine.lastResolutionPoll = now;
          const still = [];
          for (const p of engine.pending) {
            if (!p.resolved) await resolveLegOfficial(p);
            if (!p.resolved) still.push(p);
          }
          engine.pending = still;
        }

        if (leg.discovered) {
          processSideTick('up', leg.upMid);
          processSideTick('down', leg.downMid);
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
        rollingPeak: st.rollingPeak,
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
      dipThreshold, baseShares, maxShares, maxPositionsPerSide, cooldownMs,
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
    log(`⛏ ${label} — Dip-Buy Engine [${rangeMin}–${rangeMax}]`);
    log(`⚙️ Dip ≥${dipThreshold} | Shares ${baseShares}–${maxShares} (scaled by depth)`);
    log(`⚙️ Dynamic TP (cheaper=+60%, expensive=+15%) | No SL | Max ${maxPositionsPerSide}/side | Cooldown ${(cooldownMs/1000).toFixed(0)}s`);
    log(`⚙️ Capital $${capital.toFixed(2)} | ${DRY_RUN ? 'DEMO' : 'LIVE'}`);
    mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine };
