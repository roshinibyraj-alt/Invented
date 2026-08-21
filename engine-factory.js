'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC TRAILING LIMIT ENGINE — 5m Up/Down windows only
 * ═══════════════════════════════════════════════════════════════
 *
 *  Range: 0.60–0.90. Trailing limit buy on local peak.
 *
 *  1. No trades first 60s / last 30s.
 *  2. Track local peak per side (price rose then started dropping).
 *  3. Place limit buy at peak − 0.05.
 *  4. New higher peak → cancel old limit, place at new_peak − 0.05.
 *  5. Price walks through → FILLED. TP = entry + 0.10. SL = 0.45 hard.
 *  6. TP hit → sell at profit. SL hit → force sell at loss.
 *  7. After TP/SL → can re-enter same side if conditions met again.
 *  8. UP and DOWN tracked independently.
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const TICK_MS            = 100;
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
    label = 'BTC-TRAIL',
    startingCapital = 4000,
    windowType = '5m',
    windowSeconds5 = 300,
    sharesPerTrade = 100,
    trailDistance = 0.05,
    takeProfitDistance = 0.10,
    stopLossPrice = 0.45,
    rangeMin = 0.60,
    rangeMax = 0.90,
    noTradeFirstSec = 60,
    noTradeLastSec = 30,
    feeTheta = 0.07,
    trader,
    dryRun = true,
    statsStatePath,
    emit = () => {},
    slog = () => {},
    nowFn = Date.now,
    tickMs = TICK_MS,
    priceRefreshMs = 100,
  } = cfg;

  const winSec = windowSeconds5;
  const capital = round2(startingCapital);
  let DRY_RUN = dryRun;

  function loadStats() {
    if (!statsStatePath) return null;
    try {
      const raw = fs.readFileSync(statsStatePath, 'utf8');
      return JSON.parse(raw);
    } catch (_) { return null; }
  }
  const saved = loadStats();

  // Per-side state
  function freshSideState() {
    return {
      peak: 0,             // highest price seen this cycle
      prevPrice: 0,        // previous tick price for local peak detection
      limitActive: false,
      limitPrice: null,
      positionOpen: false,
      entryPrice: null,
      shares: 0,
      cost: 0,
      tpPrice: null,
      trades: [],           // completed trades this window
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
        totalFeesPaid: engine.totalFeesPaid,
        savedAt: nowFn(),
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

  // ── Trading logic per side ──
  function getPrice(side) {
    return side === 'up' ? engine.leg.upMid : engine.leg.downMid;
  }

  function computeFee(shares, price) {
    return shares * feeTheta * price * (1 - price);
  }

  function resetSide(side) {
    engine[side] = freshSideState();
  }

  function processSideTick(side, price, nowSec, secsLeft) {
    const st = engine[side];
    if (price == null) return;

    // Track peak (highest price seen this cycle)
    if (price > st.peak) st.peak = price;

    // If position open — check TP and SL
    if (st.positionOpen) {
      // Take Profit
      if (st.tpPrice != null && price >= st.tpPrice) {
        const proceeds = round2(st.shares * st.tpPrice);
        const fee = computeFee(st.shares, st.tpPrice);
        const netProceeds = round2(proceeds - fee);
        const pnl = round2(netProceeds - st.cost);
        engine.bankroll = round2(engine.bankroll + netProceeds);
        engine.realizedPnl = round2(engine.realizedPnl + pnl);
        engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
        const won = pnl > 0;
        if (won) engine.wins++; else engine.losses++;
        st.trades.push({ side, type: 'TP', entry: st.entryPrice, exit: st.tpPrice, shares: st.shares, pnl });
        log(`✅ ${side.toUpperCase()} TP HIT — sold ${st.shares}sh @${st.tpPrice.toFixed(3)} | PnL ${sgn2(pnl)} | bankroll $${engine.bankroll.toFixed(2)}`);
        resetSide(side);
        return;
      }
      // Stop Loss
      if (price <= stopLossPrice) {
        const exitPrice = Math.max(price, 0.01);
        const proceeds = round2(st.shares * exitPrice);
        const fee = computeFee(st.shares, exitPrice);
        const netProceeds = round2(proceeds - fee);
        const pnl = round2(netProceeds - st.cost);
        engine.bankroll = round2(engine.bankroll + netProceeds);
        engine.realizedPnl = round2(engine.realizedPnl + pnl);
        engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
        engine.losses++;
        st.trades.push({ side, type: 'SL', entry: st.entryPrice, exit: exitPrice, shares: st.shares, pnl });
        log(`🛑 ${side.toUpperCase()} STOP LOSS — sold ${st.shares}sh @${exitPrice.toFixed(3)} | PnL ${sgn2(pnl)} | bankroll $${engine.bankroll.toFixed(2)}`);
        resetSide(side);
        return;
      }
      return;
    }

    // If limit active — check walk-through fill
    if (st.limitActive && st.limitPrice != null) {
      if (price <= st.limitPrice) {
        // FILL!
        const fillPrice = st.limitPrice;
        const fee = computeFee(sharesPerTrade, fillPrice);
        const cost = round2(sharesPerTrade * fillPrice + fee);
        engine.bankroll = round2(engine.bankroll - cost);
        engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
        st.positionOpen = true;
        st.entryPrice = fillPrice;
        st.shares = sharesPerTrade;
        st.cost = cost;
        st.tpPrice = round3(fillPrice + takeProfitDistance);
        st.limitActive = false;
        st.limitPrice = null;
        log(`🎯 ${side.toUpperCase()} FILLED — ${sharesPerTrade}sh @${fillPrice.toFixed(3)} | TP @${st.tpPrice.toFixed(3)} | SL @${stopLossPrice} | cost $${cost.toFixed(2)}`);
        return;
      }
    }

    // Check if we should place/update a limit order
    // Only during trading window (after first N sec, before last M sec)
    if (secsLeft > noTradeLastSec && !st.positionOpen) {
      // Price must be in range
      if (price >= rangeMin && price <= rangeMax) {
        // Detect local peak: price was rising, now started dropping
        if (st.prevPrice > 0 && price < st.prevPrice && st.peak >= rangeMin && st.peak <= rangeMax) {
          const newLimitPrice = round3(st.peak - trailDistance);
          if (newLimitPrice >= rangeMin - 0.05) {
            if (!st.limitActive || st.limitPrice !== newLimitPrice) {
              st.limitActive = true;
              st.limitPrice = newLimitPrice;
              log(`📤 ${side.toUpperCase()} LIMIT @${newLimitPrice.toFixed(3)} (peak ${st.peak.toFixed(3)} − ${trailDistance})`);
            }
          }
        }
      } else {
        // Out of range — cancel any active limit
        if (st.limitActive) {
          st.limitActive = false;
          st.limitPrice = null;
        }
      }
    } else if (secsLeft <= noTradeLastSec && st.limitActive) {
      // Cancel limit near window end
      st.limitActive = false;
      st.limitPrice = null;
    }

    // Update prevPrice for next tick's local peak detection
    st.prevPrice = price;
  }

  // ── Window lifecycle ──
  function settleWindow(winner) {
    // Close any open positions at resolution
    for (const side of ['up', 'down']) {
      const st = engine[side];
      if (st.positionOpen) {
        // Winner pays $1/share, loser $0
        const payout = winner === side ? st.shares : 0;
        const pnl = round2(payout - st.cost);
        engine.bankroll = round2(engine.bankroll + payout);
        engine.realizedPnl = round2(engine.realizedPnl + pnl);
        const won = pnl > 0;
        if (won) engine.wins++; else engine.losses++;
        st.trades.push({ side, type: 'resolution', entry: st.entryPrice, exit: winner === side ? 1.0 : 0, shares: st.shares, pnl });
        log(`🏁 ${side.toUpperCase()} RESOLVED — ${winner === side ? 'WIN' : 'LOSS'} ${sgn2(pnl)} | bankroll $${engine.bankroll.toFixed(2)}`);
      }
      // Record window summary if there were any trades
      if (st.trades.length > 0) {
        const totalPnl = round2(st.trades.reduce((a, t) => a + t.pnl, 0));
        engine.history.unshift({
          windowTs: engine.leg.windowTs,
          slug: engine.leg.slug,
          side,
          trades: st.trades.length,
          pnl: totalPnl,
          bankrollAfter: engine.bankroll,
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

        // Window transition
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
          log(`🆕 window t=${windowTs} opened`);
        }

        const leg = engine.leg;

        // Discovery
        if (!leg.discovered && now - leg.lastDiscoveryAttempt >= DISCOVERY_RETRY_MS) {
          leg.lastDiscoveryAttempt = now;
          await discoverLeg(leg);
        }

        // Price refresh
        if (now - engine.lastPriceFetch >= priceRefreshMs) {
          engine.lastPriceFetch = now;
          await refreshLegPrices(leg);
        }

        // Resolution polling for pending
        if (engine.pending.length && now - engine.lastResolutionPoll >= RESOLUTION_POLL_MS) {
          engine.lastResolutionPoll = now;
          const still = [];
          for (const p of engine.pending) {
            if (!p.resolved) await resolveLegOfficial(p);
            if (!p.resolved) still.push(p);
          }
          engine.pending = still;
        }

        // Process trading
        if (leg.discovered) {
          const elapsed = nowSec - windowTs;
          const secsLeft = Math.max(0, Math.round((leg.closeAt - now) / 1000));

          if (elapsed >= noTradeFirstSec && secsLeft > noTradeLastSec) {
            processSideTick('up', leg.upMid, nowSec, secsLeft);
            processSideTick('down', leg.downMid, nowSec, secsLeft);
          }
        }

        // Equity recording
        if (now - engine.lastEquityRecord >= EQUITY_RECORD_MS) {
          engine.lastEquityRecord = now;
          let mtm = 0;
          for (const side of ['up', 'down']) {
            const st = engine[side];
            if (st.positionOpen) {
              const p = getPrice(side);
              if (p != null) mtm += st.shares * p;
            }
          }
          engine.equityCurve.push({ t: now, equity: round2(engine.bankroll + mtm) });
          if (engine.equityCurve.length > 10000) engine.equityCurve.shift();
        }

        emitState();
      } catch (e) {
        log(`⚠️ Loop error: ${e.message}`);
      }
      await new Promise(res => setTimeout(res, tickMs));
    }
  }

  // ── Dashboard state ──
  function buildState() {
    const leg = engine.leg;
    function sideInfo(name, st) {
      return {
        peak: st.peak,
        limitActive: st.limitActive,
        limitPrice: st.limitPrice,
        positionOpen: st.positionOpen,
        entryPrice: st.entryPrice,
        shares: st.shares,
        tpPrice: st.tpPrice,
        unrealizedPnl: st.positionOpen && leg ? (() => {
          const p = name === 'up' ? leg.upMid : leg.downMid;
          return p != null ? round2(st.shares * p - st.cost) : 0;
        })() : 0,
        tradesThisWindow: st.trades,
      };
    }
    const decided = engine.wins + engine.losses;
    return {
      label, windowSeconds: winSec, dryRun: DRY_RUN,
      bankroll: engine.bankroll, startingCapital: capital,
      realizedPnl: engine.realizedPnl,
      equity: round2(engine.bankroll + (engine.up.positionOpen ? engine.up.shares * (leg?.upMid || 0) : 0) + (engine.down.positionOpen ? engine.down.shares * (leg?.downMid || 0) : 0)),
      equityCurve: engine.equityCurve.slice(-200),
      wins: engine.wins, losses: engine.losses,
      winRate: decided > 0 ? round2(engine.wins / decided * 100) : null,
      up: sideInfo('up', engine.up),
      down: sideInfo('down', engine.down),
      currentLeg: leg ? {
        slug: leg.slug, discovered: leg.discovered,
        upMid: leg.upMid, downMid: leg.downMid,
        secsLeft: leg ? Math.max(0, Math.round((leg.closeAt - nowFn()) / 1000)) : 0,
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
    log(`⛏ ${label} — Trailing Limit, ${windowType} windows`);
    log(`⚙️ Range ${rangeMin}–${rangeMax} | Trail ${trailDistance} | TP +${takeProfitDistance} | SL ${stopLossPrice}`);
    log(`⚙️ No trades first ${noTradeFirstSec}s / last ${noTradeLastSec}s | Both sides independent`);
    log(`⚙️ Capital: $${capital.toFixed(2)} | Mode: ${DRY_RUN ? 'DEMO' : 'LIVE'}`);
    mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine };
