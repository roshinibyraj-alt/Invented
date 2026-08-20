'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BTC BUCKET LIMIT ENGINE — 5m + 15m Up/Down windows
 * ═══════════════════════════════════════════════════════════════
 *
 *  Every 20s (5m) / 60s (15m), create a "bucket":
 *
 *  1. Snapshot current UP/DOWN mid prices.
 *  2. Identify CHEAP side (lower price) and EXPENSIVE side.
 *  3. Place resting GTC limit buy on CHEAP side at exactly its current price.
 *  4. When price walks through → cheap leg FILLED.
 *  5. Immediately place GTC limit buy on EXPENSIVE side at
 *     (current expensive price − 0.10).
 *  6. When that walks through → expensive leg FILLED.
 *  7. Buckets stay open until filled — no timeout.
 *  8. Multiple buckets can be open simultaneously.
 *  9. At window end, winner pays $1/share; PnL = payouts − total cost.
 *
 *  10 shares per side per bucket. No stop loss, no martingale.
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
    label = 'BTC-BUCKET',
    startingCapital = 4000,
    windowType = '5m',
    windowSeconds5 = 300,
    bucketIntervalSec = 20,
    sharesPerSide = 10,
    oppositeSideDiscount = 0.10,
    feeTheta = 0.07,
    rebatePct = 0,
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
  let tradeSeq = 0;

  function loadStats() {
    if (!statsStatePath) return null;
    try {
      const raw = fs.readFileSync(statsStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.bankroll === 'number') return parsed;
    } catch (_) {}
    return null;
  }
  const saved = loadStats();

  const engine = {
    bankroll: saved ? saved.bankroll : capital,
    realizedPnl: saved ? saved.realizedPnl || 0 : 0,
    wins: saved ? saved.wins || 0 : 0,
    losses: saved ? saved.losses || 0 : 0,
    history: saved && Array.isArray(saved.history) ? saved.history : [],
    equityCurve: saved && Array.isArray(saved.equityCurve) && saved.equityCurve.length
      ? saved.equityCurve : [{ t: nowFn(), equity: capital }],
    current: null,
    pending: [],
    buckets: [],
    lastResolutionPoll: 0,
    lastPriceFetch: 0,
    lastEquityRecord: 0,
    lastBucketAt: 0,
    totalFeesPaid: saved ? saved.totalFeesPaid || 0 : 0,
    logs: [],
  };

  function log(msg) {
    const line = `[${label}] ${new Date().toISOString()} ${msg}`;
    console.log(line);
    engine.logs.push(line);
    if (engine.logs.length > 200) engine.logs.shift();
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
    } catch (e) { log(`⚠️ discoverLeg failed: ${e.message}`); }
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
        const downIdx = tokens.findIndex(t => String(t.token_id) === String(leg.downTokenId));
        if (upIdx >= 0 && downIdx >= 0 && prices[upIdx] != null) {
          leg.resolved = true;
          leg.winner = parseFloat(prices[upIdx]) >= 0.5 ? 'up' : 'down';
          log(`🏁 official resolution — winner ${leg.winner.toUpperCase()}`);
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  // ── Bucket management ──
  function createBucket(leg, now) {
    const upP = leg.upMid, downP = leg.downMid;
    if (upP == null || downP == null) return;
    let cheapSide, cheapPrice, expSide, expPrice;
    if (upP <= downP) { cheapSide = 'up'; cheapPrice = upP; expSide = 'down'; expPrice = downP; }
    else { cheapSide = 'down'; cheapPrice = downP; expSide = 'up'; expPrice = upP; }
    // Price range guard: cheap must be in 0.10–0.90
    if (cheapPrice < 0.10 || cheapPrice > 0.90) return;
    const bucket = {
      id: ++tradeSeq,
      createdAt: now,
      leg,
      cheapSide, cheapTargetPrice: round3(cheapPrice),
      expSide, expTargetPrice: null,
      cheapFilled: false, expensiveFilled: false,
      cheapFillPrice: null, expensiveFillPrice: null,
      cheapShares: 0, expensiveShares: 0,
      cheapCost: 0, expensiveCost: 0,
      cheapOrderId: null, expensiveOrderId: null,
      settled: false,
    };
    engine.buckets.push(bucket);
    log(`🪣 BUCKET #${bucket.id} — cheap ${cheapSide.toUpperCase()} @${cheapPrice.toFixed(3)} | expensive ${expSide.toUpperCase()} @${expPrice.toFixed(3)} | placing GTC limit buy ${cheapSide.toUpperCase()} ${sharesPerSide}sh @${cheapPrice.toFixed(3)}`);
    placeCheapLimit(bucket);
  }

  async function placeCheapLimit(bucket) {
    const tokenId = bucket.cheapSide === 'up' ? bucket.leg.upTokenId : bucket.leg.downTokenId;
    if (!tokenId) return;
    if (!DRY_RUN && trader) {
      try {
        const resp = await trader.placeGtcOrder(tokenId, 'BUY', bucket.cheapTargetPrice, sharesPerSide);
        bucket.cheapOrderId = resp.id;
        log(`📤 GTC placed: ${bucket.cheapSide.toUpperCase()} ${sharesPerSide}sh @${bucket.cheapTargetPrice.toFixed(3)} id:${resp.id?.slice(0, 12)}`);
      } catch (e) { log(`⚠️ GTC place failed: ${e.message}`); }
    }
  }

  function checkCheapFill(bucket) {
    if (bucket.cheapFilled) return;
    const mid = bucket.cheapSide === 'up' ? bucket.leg.upMid : bucket.leg.downMid;
    if (mid == null) return;
    // Walk-through: price dropped to or below our target
    if (mid <= bucket.cheapTargetPrice) {
      bucket.cheapFilled = true;
      bucket.cheapFillPrice = bucket.cheapTargetPrice;
      bucket.cheapShares = sharesPerSide;
      const fee = sharesPerSide * feeTheta * bucket.cheapFillPrice * (1 - bucket.cheapFillPrice);
      bucket.cheapCost = round2(sharesPerSide * bucket.cheapFillPrice + fee);
      engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
      engine.bankroll = round2(engine.bankroll - bucket.cheapCost);
      log(`✅ BUCKET #${bucket.id} CHEAP FILLED — ${bucket.cheapSide.toUpperCase()} ${sharesPerSide}sh @${bucket.cheapFillPrice.toFixed(3)} (cost $${bucket.cheapCost.toFixed(2)})`);
      // Now place expensive side at discount
      placeExpensiveLimit(bucket);
    }
  }

  function placeExpensiveLimit(bucket) {
    const mid = bucket.expSide === 'up' ? bucket.leg.upMid : bucket.leg.downMid;
    if (mid == null) return;
    bucket.expTargetPrice = round3(Math.max(0.01, mid - oppositeSideDiscount));
    log(`📤 BUCKET #${bucket.id} placing expensive ${bucket.expSide.toUpperCase()} ${sharesPerSide}sh @${bucket.expTargetPrice.toFixed(3)} (${oppositeSideDiscount} below current ${mid.toFixed(3)})`);
    if (!DRY_RUN && trader) {
      const tokenId = bucket.expSide === 'up' ? bucket.leg.upTokenId : bucket.leg.downTokenId;
      if (tokenId) {
        trader.placeGtcOrder(tokenId, 'BUY', bucket.expTargetPrice, sharesPerSide)
          .then(resp => { bucket.expensiveOrderId = resp.id; })
          .catch(e => log(`⚠️ expensive GTC failed: ${e.message}`));
      }
    }
  }

  function checkExpensiveFill(bucket) {
    if (!bucket.cheapFilled || bucket.expensiveFilled || bucket.expTargetPrice == null) return;
    const mid = bucket.expSide === 'up' ? bucket.leg.upMid : bucket.leg.downMid;
    if (mid == null) return;
    if (mid <= bucket.expTargetPrice) {
      bucket.expensiveFilled = true;
      bucket.expensiveFillPrice = bucket.expTargetPrice;
      bucket.expensiveShares = sharesPerSide;
      const fee = sharesPerSide * feeTheta * bucket.expensiveFillPrice * (1 - bucket.expensiveFillPrice);
      bucket.expensiveCost = round2(sharesPerSide * bucket.expensiveFillPrice + fee);
      engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
      engine.bankroll = round2(engine.bankroll - bucket.expensiveCost);
      log(`✅ BUCKET #${bucket.id} EXPENSIVE FILLED — ${bucket.expSide.toUpperCase()} ${sharesPerSide}sh @${bucket.expensiveFillPrice.toFixed(3)} (cost $${bucket.expensiveCost.toFixed(2)})`);
    }
  }

  function settleBucket(bucket, winner) {
    if (bucket.settled) return;
    bucket.settled = true;
    let payout = 0;
    if (winner === bucket.cheapSide) payout += bucket.cheapShares;
    if (winner === bucket.expSide) payout += bucket.expensiveShares;
    const totalCost = round2(bucket.cheapCost + bucket.expensiveCost);
    const pnl = round2(payout - totalCost);
    engine.bankroll = round2(engine.bankroll + payout);
    engine.realizedPnl = round2(engine.realizedPnl + pnl);
    const won = pnl > 0;
    if (bucket.cheapShares > 0 || bucket.expensiveShares > 0) {
      if (won) engine.wins++; else engine.losses++;
    }
    log(`🏁 BUCKET #${bucket.id} settled — winner ${winner?.toUpperCase() || '?'} | cheap ${bucket.cheapFilled ? `${bucket.cheapShares}sh@${bucket.cheapFillPrice?.toFixed(3)}` : 'unfilled'} | expensive ${bucket.expensiveFilled ? `${bucket.expensiveShares}sh@${bucket.expensiveFillPrice?.toFixed(3)}` : 'unfilled'} | cost $${totalCost.toFixed(2)} payout $${payout.toFixed(2)} PnL ${sgn2(pnl)}`);
    return { bucketId: bucket.id, winner, payout, totalCost, pnl, won };
  }

  // ── Main loop ──
  async function mainLoop() {
    while (true) {
      try {
        const now = nowFn();
        const nowSec = Math.floor(now / 1000);
        const windowTs = Math.floor(nowSec / winSec) * winSec;

        // Window transition
        if (!engine.current || engine.current.windowTs !== windowTs) {
          // Resolve old window's buckets
          if (engine.current) {
            const oldLeg = engine.current;
            if (!oldLeg.resolved) await attemptFastResolution(oldLeg);
            if (!oldLeg.resolved) await resolveLegOfficial(oldLeg);
            const winner = oldLeg.winner;
            const results = [];
            for (const b of engine.buckets) {
              if (!b.settled) {
                const r = settleBucket(b, winner);
                if (r) results.push(r);
              }
            }
            if (results.length) {
              const totalPnl = round2(results.reduce((a, r) => a + r.pnl, 0));
              engine.history.unshift({
                windowTs: oldLeg.windowTs, slug: oldLeg.slug, winner,
                buckets: results.length, pnl: totalPnl,
                bankrollAfter: engine.bankroll, resolvedAt: now,
              });
              if (engine.history.length > 300) engine.history.pop();
              log(`📊 WINDOW ${oldLeg.windowTs} RESOLVED — ${results.length} buckets, total PnL ${sgn2(totalPnl)}, bankroll $${engine.bankroll.toFixed(2)}`);
            }
            engine.buckets = [];
          }
          // New window
          engine.current = freshLeg(windowTs);
          engine.lastBucketAt = 0;
          log(`🆕 window t=${windowTs} opened`);
        }

        const leg = engine.current;

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

        // Create new bucket every interval
        if (leg.discovered && nowSec < leg.closeAt / 1000) {
          const elapsed = nowSec - windowTs;
          if (elapsed - engine.lastBucketAt >= bucketIntervalSec) {
            engine.lastBucketAt = elapsed;
            createBucket(leg, now);
          }
        }

        // Check fills on all open buckets
        for (const b of engine.buckets) {
          if (b.settled) continue;
          checkCheapFill(b);
          checkExpensiveFill(b);
        }

        // Equity recording
        if (now - engine.lastEquityRecord >= EQUITY_RECORD_MS) {
          engine.lastEquityRecord = now;
          let mtm = 0;
          for (const b of engine.buckets) {
            if (b.settled) continue;
            if (b.cheapFilled) {
              const p = b.cheapSide === 'up' ? leg.upMid : leg.downMid;
              if (p != null) mtm += b.cheapShares * p;
            }
            if (b.expensiveFilled) {
              const p = b.expSide === 'up' ? leg.upMid : leg.downMid;
              if (p != null) mtm += b.expensiveShares * p;
            }
          }
          const totalCost = round2(engine.buckets.filter(b => !b.settled).reduce((a, b) => a + b.cheapCost + b.expensiveCost, 0));
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
    const leg = engine.current;
    const openBuckets = engine.buckets.filter(b => !b.settled).map(b => ({
      id: b.id,
      cheapSide: b.cheapSide, cheapTarget: b.cheapTargetPrice,
      cheapFilled: b.cheapFilled, cheapFillPrice: b.cheapFillPrice,
      cheapShares: b.cheapShares, cheapCost: b.cheapCost,
      expSide: b.expSide, expTarget: b.expTargetPrice,
      expensiveFilled: b.expensiveFilled, expensiveFillPrice: b.expensiveFillPrice,
      expensiveShares: b.expensiveShares, expensiveCost: b.expensiveCost,
    }));
    const settledBuckets = engine.buckets.filter(b => b.settled);
    let totalUpShares = 0, totalDownShares = 0, totalCost = 0, unrealized = 0;
    for (const b of openBuckets) {
      if (b.cheapFilled) {
        totalCost += b.cheapCost;
        if (b.cheapSide === 'up') { totalUpShares += b.cheapShares; if (leg?.upMid != null) unrealized += b.cheapShares * leg.upMid - b.cheapCost; }
        else { totalDownShares += b.cheapShares; if (leg?.downMid != null) unrealized += b.cheapShares * leg.downMid - b.cheapCost; }
      }
      if (b.expensiveFilled) {
        totalCost += b.expensiveCost;
        if (b.expSide === 'up') { totalUpShares += b.expensiveShares; if (leg?.upMid != null) unrealized += b.expensiveShares * leg.upMid - b.expensiveCost; }
        else { totalDownShares += b.expensiveShares; if (leg?.downMid != null) unrealized += b.expensiveShares * leg.downMid - b.expensiveCost; }
      }
    }
    const decided = engine.wins + engine.losses;
    return {
      label, windowSeconds: winSec, bucketIntervalSec,
      dryRun: DRY_RUN,
      bankroll: engine.bankroll,
      startingCapital: capital,
      realizedPnl: engine.realizedPnl,
      unrealizedPnl: round2(unrealized),
      totalCost: round2(totalCost),
      totalUpShares, totalDownShares,
      equity: round2(engine.bankroll + unrealized),
      equityCurve: engine.equityCurve.slice(-200),
      wins: engine.wins, losses: engine.losses,
      winRate: decided > 0 ? round2(engine.wins / decided * 100) : null,
      openBuckets,
      openBucketCount: openBuckets.length,
      settledBucketCount: settledBuckets.length,
      currentLeg: leg ? {
        slug: leg.slug, discovered: leg.discovered,
        upMid: leg.upMid, downMid: leg.downMid,
        windowTs: leg.windowTs, closeAt: leg.closeAt,
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
  function setMode(live) { DRY_RUN = !live; log(`⚙️ ${live ? 'LIVE' : 'DEMO'} mode`); return { ok: true }; }

  async function start() {
    log(`⛏ ${label} — Bucket Limit Strategy, ${windowType} windows`);
    log(`⚙️ Every ${bucketIntervalSec}s: snapshot → place cheap GTC limit → wait walk-through → place expensive at -${oppositeSideDiscount}`);
    log(`⚙️ ${sharesPerSide}sh per side | no stop loss | hold to resolution | range 0.10–0.90`);
    log(`⚙️ Capital: $${capital.toFixed(2)} | Mode: ${DRY_RUN ? 'DEMO' : 'LIVE'}`);
    mainLoop().catch(e => log(`❌ Fatal: ${e.message}`));
  }

  return { start, pauseTrading, resumeTrading, setMode, buildState };
}

module.exports = { createEngine };
