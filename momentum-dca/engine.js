'use strict';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const WINDOW_SECONDS = 300;
const BUY_INTERVAL_MS = 12000;      // buy every ~12s (range 8-18s)
const ENTRY_DELAY_S = 15;            // start 15s after window open
const MIN_ORDER_SHARES = 5;

// Three fixed size tiers (like the master wallet)
const SIZE_CHEAP  = 40;   // when price < 0.30
const SIZE_MID    = 80;   // default
const SIZE_STRONG = 150;  // when price > 0.60 and trending up

function round2(n) { return Math.round(n * 100) / 100; }

function createMomentumEngine(cfg, trader) {
  const {
    label = 'MOMENTUM-DCA',
    startingCapital = 10000,
    perWindowBudget = 1200,
    feeTheta = 0.07,
    rebatePct = 0,
  } = cfg;

  const engine = {
    bankroll: startingCapital,
    startingCapital,
    equity: startingCapital,
    wins: 0, losses: 0, windowsDecided: 0,
    realizedPnlTotal: 0,
    totalFeesPaid: 0, totalVolume: 0,
    equityCurve: [{ t: Date.now(), equity: startingCapital }],
    history: [],
    current: null,
    maxDrawdown: { pct: 0, dollars: 0 },
  };

  let log = () => {};
  let slog = () => {};
  const nowFn = () => Date.now();
  const nowSec = () => Math.floor(Date.now() / 1000);

  function getJSON(url, timeout = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(url, { signal: ctrl.signal })
      .then(r => { clearTimeout(timer); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch(e => { clearTimeout(timer); throw e; });
  }

  function computeFee(shares, price) {
    return shares * feeTheta * price * (1 - price);
  }

  // ── Market Discovery ──
  function freshLeg(windowTs, slugPrefix) {
    const slug = `${slugPrefix}${windowTs}`;
    return {
      slug, conditionId: null, upTokenId: null, downTokenId: null,
      upAsk: null, upBid: null, downAsk: null, downBid: null,
      discovered: false, lastDiscoveryAttempt: 0,
      resolved: false, winner: null, resolutionMethod: null,
    };
  }

  async function discoverLeg(leg) {
    if (leg.discovered) return;
    const now = nowFn();
    if (now - leg.lastDiscoveryAttempt < 5000) return;
    leg.lastDiscoveryAttempt = now;
    try {
      const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(leg.slug)}`);
      const ev = Array.isArray(events) ? events[0] : null;
      if (!ev || !ev.markets || !ev.markets.length) return;
      const mk = ev.markets[0];
      leg.conditionId = mk.conditionId;
      const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
      const tokenIds = typeof mk.clobTokenIds === 'string' ? JSON.parse(mk.clobTokenIds) : (mk.clobTokenIds || []);
      const tokens = outcomes.map((o, i) => ({ outcome: o, token_id: tokenIds[i] || null }));
      const up = tokens.find(t => /up/i.test(t.outcome));
      const down = tokens.find(t => /down/i.test(t.outcome));
      if (!up || !down || !up.token_id || !down.token_id) return;
      leg.upTokenId = up.token_id;
      leg.downTokenId = down.token_id;
      leg.discovered = true;
      log(`🎯 discovered ${leg.slug} — Up ${String(up.token_id).slice(0,10)}… / Down ${String(down.token_id).slice(0,10)}…`);
    } catch (e) {
      log(`⚠️ discover failed: ${e.message}`);
    }
  }

  async function refreshLegPrices(leg) {
    if (!leg.upTokenId || !leg.downTokenId) return;
    try {
      const [upAsk, upBid, dnAsk, dnBid] = await Promise.all([
        getJSON(`${CLOB}/price?token_id=${leg.upTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${leg.upTokenId}&side=SELL`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${leg.downTokenId}&side=BUY`).catch(() => null),
        getJSON(`${CLOB}/price?token_id=${leg.downTokenId}&side=SELL`).catch(() => null),
      ]);
      leg.upAsk = upAsk?.price != null ? Number(upAsk.price) : null;
      leg.upBid = upBid?.price != null ? Number(upBid.price) : null;
      leg.downAsk = dnAsk?.price != null ? Number(dnAsk.price) : null;
      leg.downBid = dnBid?.price != null ? Number(dnBid.price) : null;
    } catch (_) {}
  }

  // ── Trade Execution ──
  async function executeBuy(tokenId, shares, price) {
    if (!trader) return { ok: false, reason: 'no-trader' };
    if (shares < MIN_ORDER_SHARES) return { ok: false, reason: 'below-min' };
    try {
      const resp = await trader.placeFokLimitOrder(tokenId, 'BUY', price, shares);
      if (resp && resp.isFilled) {
        const avgPrice = resp.avgPrice || price;
        const filled = resp.filledShares || shares;
        const notional = round2(filled * avgPrice);
        const fee = computeFee(filled, avgPrice);
        const netFee = round2(fee - round2(fee * rebatePct));
        const cost = round2(notional + netFee);
        engine.totalFeesPaid = round2(engine.totalFeesPaid + fee);
        engine.totalVolume = round2(engine.totalVolume + notional);
        return { ok: true, filled, avgPrice, notional, fee, cost };
      }
      return { ok: false, reason: 'not-filled' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // ── Momentum Tracking ──
  function momentumScore(leg) {
    // Simple: higher ask = more momentum on that side
    const up = leg.upAsk || 0;
    const dn = leg.downAsk || 0;
    return { up, dn, delta: up - dn };
  }

  function pickSize(price, sideMomentum, otherMomentum) {
    // If price is cheap (<0.30), accumulate small
    if (price < 0.30) return SIZE_CHEAP;
    // If this side has momentum AND price > 0.60, go big
    if (price > 0.60 && sideMomentum > otherMomentum) return SIZE_STRONG;
    // Default
    return SIZE_MID;
  }

  // ── Window Management ──
  function freshTrade(windowTs) {
    return {
      windowTs,
      closeAt: (windowTs + WINDOW_SECONDS) * 1000,
      leg: freshLeg(windowTs, 'btc-updown-5m-'),
      phase: 'waiting',
      buys: [],
      sells: [],
      lastUpAsk: 0, lastDnAsk: 0,
      upShares: 0, dnShares: 0,
      upCost: 0, dnCost: 0,
      totalSpent: 0,
      totalShares: 0,
      buyCount: 0,
      pnl: null, win: null, settled: false,
      momentumHistory: [],
    };
  }

  async function tick() {
    const now = nowFn();
    const t = engine.current;

    // New window?
    const windowTs = Math.floor(nowSec() / WINDOW_SECONDS) * WINDOW_SECONDS;
    if (!t || t.windowTs !== windowTs) {
      // Settle previous
      if (t && !t.settled) await settle(t);
      engine.current = freshTrade(windowTs);
      log(`🆕 window ${windowTs} opened — starting in ${ENTRY_DELAY_S}s`);
    }

    const cur = engine.current;
    if (cur.settled) return;

    // Discover market
    if (!cur.leg.discovered) {
      await discoverLeg(cur.leg);
      return;
    }

    // Refresh prices
    await refreshLegPrices(cur.leg);

    // Check window end
    if (now >= cur.closeAt) {
      await settle(cur);
      return;
    }

    // Wait period
    const secsIntoWindow = (now / 1000) - windowTs;
    if (secsIntoWindow < ENTRY_DELAY_S) {
      cur.phase = 'waiting';
      return;
    }

    // Check budget
    if (cur.totalSpent >= perWindowBudget) {
      cur.phase = 'budget-exceeded';
      return;
    }

    // Momentum analysis
    const mom = momentumScore(cur.leg);
    cur.momentumHistory.push({ t: now, up: mom.up, dn: mom.dn });
    if (cur.momentumHistory.length > 30) cur.momentumHistory.shift();

    // Buy BOTH sides
    const upAsk = cur.leg.upAsk;
    const dnAsk = cur.leg.downAsk;

    if (upAsk != null && upAsk > 0.01 && upAsk < 0.99) {
      const upShares = pickSize(upAsk, mom.up, mom.dn);
      const upCost = round2(upShares * upAsk);
      if (cur.totalSpent + upCost <= perWindowBudget && engine.bankroll >= upCost) {
        const res = await executeBuy(cur.leg.upTokenId, upShares, upAsk);
        if (res.ok) {
          cur.upShares = round2(cur.upShares + res.filled);
          cur.upCost = round2(cur.upCost + res.cost);
          cur.totalSpent = round2(cur.totalSpent + res.cost);
          cur.totalShares = round2(cur.totalShares + res.filled);
          cur.buyCount++;
          engine.bankroll = round2(engine.bankroll - res.cost);
          cur.buys.push({ side: 'up', shares: res.filled, price: res.avgPrice, cost: res.cost, ts: now });
          log(`📈 UP ${res.filled}sh @${res.avgPrice.toFixed(3)} = $${res.cost.toFixed(2)} (mom: ${mom.up.toFixed(2)} vs ${mom.dn.toFixed(2)})`);
        }
      }
    }

    // Re-check budget for DOWN
    if (cur.totalSpent >= perWindowBudget) { cur.phase = 'budget-exceeded'; return; }

    if (dnAsk != null && dnAsk > 0.01 && dnAsk < 0.99) {
      const dnShares = pickSize(dnAsk, mom.dn, mom.up);
      const dnCost = round2(dnShares * dnAsk);
      if (cur.totalSpent + dnCost <= perWindowBudget && engine.bankroll >= dnCost) {
        const res = await executeBuy(cur.leg.downTokenId, dnShares, dnAsk);
        if (res.ok) {
          cur.dnShares = round2(cur.dnShares + res.filled);
          cur.dnCost = round2(cur.dnCost + res.cost);
          cur.totalSpent = round2(cur.totalSpent + res.cost);
          cur.totalShares = round2(cur.totalShares + res.filled);
          cur.buyCount++;
          engine.bankroll = round2(engine.bankroll - res.cost);
          cur.buys.push({ side: 'down', shares: res.filled, price: res.avgPrice, cost: res.cost, ts: now });
          log(`📉 DN ${res.filled}sh @${res.avgPrice.toFixed(3)} = $${res.cost.toFixed(2)} (mom: ${mom.dn.toFixed(2)} vs ${mom.up.toFixed(2)})`);
        }
      }
    }

    cur.phase = 'trading';
  }

  async function settle(t) {
    if (t.settled) return;
    t.settled = true;

    // Try fast resolution
    const leg = t.leg;
    if (!leg.resolved && leg.conditionId) {
      try {
        const mkts = await getJSON(`${GAMMA}/markets?condition_id=${leg.conditionId}`);
        const mk = Array.isArray(mkts) ? mkts[0] : null;
        if (mk && mk.closed) {
          const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : (mk.outcomePrices || []);
          const outcomes = typeof mk.outcomes === 'string' ? JSON.parse(mk.outcomes) : (mk.outcomes || []);
          const upIdx = outcomes.findIndex(o => /up/i.test(o));
          const dnIdx = outcomes.findIndex(o => /down/i.test(o));
          if (upIdx >= 0 && dnIdx >= 0) {
            const upWin = prices[upIdx] != null && Number(prices[upIdx]) >= 0.5;
            leg.winner = upWin ? 'up' : 'down';
            leg.resolved = true;
            leg.resolutionMethod = 'final-price';
          }
        }
      } catch (_) {}
    }

    // Calculate P&L
    let payout = 0;
    if (leg.winner === 'up') payout = t.upShares;
    else if (leg.winner === 'down') payout = t.dnShares;

    const pnl = round2(payout - t.totalSpent);
    engine.bankroll = round2(engine.bankroll + payout);
    engine.realizedPnlTotal = round2(engine.realizedPnlTotal + pnl);
    engine.windowsDecided++;

    const won = t.totalSpent > 0 && pnl > 0;
    if (t.totalSpent > 0) {
      if (won) engine.wins++; else engine.losses++;
    }

    t.pnl = pnl;
    t.win = t.totalSpent > 0 ? won : null;
    t.winner = leg.winner;

    engine.history.unshift({
      windowTs: t.windowTs, slug: leg.slug, winner: leg.winner,
      upShares: t.upShares, dnShares: t.dnShares,
      upCost: t.upCost, dnCost: t.dnCost,
      totalSpent: t.totalSpent, totalShares: t.totalShares,
      buyCount: t.buyCount, payout, pnl,
      resolvedAt: nowFn(),
    });
    if (engine.history.length > 200) engine.history.pop();

    const summary = leg.winner ? `winner ${leg.winner.toUpperCase()}` : 'unresolved';
    log(`🏁 [${leg.slug}] ${summary} — UP ${t.upShares}sh/$${t.upCost.toFixed(2)} DN ${t.dnShares}sh/$${t.dnCost.toFixed(2)} | spent $${t.totalSpent.toFixed(2)} payout $${payout.toFixed(2)} P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    recordEquity();
  }

  function recordEquity() {
    engine.equity = round2(engine.bankroll);
    engine.equityCurve.push({ t: Date.now(), equity: engine.equity });
    if (engine.equityCurve.length > 2000) engine.equityCurve.shift();
    // Drawdown
    const peak = engine.equityCurve.reduce((m, p) => Math.max(m, p.equity), 0);
    if (peak > 0) {
      const dd = (peak - engine.equity) / peak;
      if (dd > engine.maxDrawdown.pct) {
        engine.maxDrawdown = { pct: round2(dd), dollars: round2(peak - engine.equity) };
      }
    }
  }

  function buildState() {
    const t = engine.current;
    return {
      label, bankroll: engine.bankroll, equity: engine.equity,
      startingCapital, perWindowBudget,
      wins: engine.wins, losses: engine.losses,
      winRate: engine.windowsDecided > 0 ? round2((engine.wins / engine.windowsDecided) * 100) : null,
      windowsDecided: engine.windowsDecided,
      realizedPnlTotal: engine.realizedPnlTotal,
      totalFeesPaid: engine.totalFeesPaid, totalVolume: engine.totalVolume,
      maxDrawdown: engine.maxDrawdown,
      dryRun: !trader,
      current: t ? {
        slug: t.leg?.slug, phase: t.phase,
        upAsk: t.leg?.upAsk, upBid: t.leg?.upBid,
        downAsk: t.leg?.downAsk, downBid: t.leg?.downBid,
        upShares: t.upShares, dnShares: t.dnShares,
        upCost: t.upCost, dnCost: t.dnCost,
        totalSpent: t.totalSpent, totalShares: t.totalShares,
        buyCount: t.buyCount,
        timeLeft: Math.max(0, t.closeAt - nowFn()),
      } : null,
      history: engine.history.slice(0, 30),
      equityCurve: engine.equityCurve,
      config: { feeTheta, rebatePct, entryDelay: ENTRY_DELAY_S, buyInterval: BUY_INTERVAL_MS },
    };
  }

  async function start() {
    slog(`⛏ ${label} — Momentum DCA bot, fully automatic`);
    slog(`⚙️  Capital: $${startingCapital}. Budget/window: $${perWindowBudget}. Sizes: ${SIZE_CHEAP}/${SIZE_MID}/${SIZE_STRONG}sh`);
    slog(`⚙️  Entry delay: ${ENTRY_DELAY_S}s. Buy interval: ~${BUY_INTERVAL_MS/1000}s. Both sides always.`);
    if (!trader) slog('⚠️  DEMO MODE — no trader connected');

    while (true) {
      try {
        await tick();
      } catch (e) {
        log(`⚠️ tick error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, BUY_INTERVAL_MS));
    }
  }

  return { start, buildState, _log: (fn) => { log = fn; }, _slog: (fn) => { slog = fn; } };
}

module.exports = { createMomentumEngine };
