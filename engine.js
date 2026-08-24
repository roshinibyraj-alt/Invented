'use strict';

const GAMMA_API = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_WS = process.env.CLOB_WS || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WINDOW_SECONDS = 300;
const ASSETS = (process.env.ASSETS || 'btc,eth,sol,xrp').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const LEAD_ASSET = (process.env.LEAD_ASSET || 'btc').toLowerCase();
const START_BANKROLL = Number(process.env.START_BANKROLL || 20000);
const TRADE_SHARES = Number(process.env.TRADE_SHARES || 100);
const ENTRY_MAX_SUM = Number(process.env.ENTRY_MAX_SUM || 0.75);
const RESOLUTION_PRICE = Number(process.env.RESOLUTION_PRICE || 0.90);
const PRICE_HISTORY_MS = Number(process.env.PRICE_HISTORY_MS || 5000);
const TAKER_FEE_BPS = Number(process.env.TAKER_FEE_BPS || 0);
const SWEEP_INTERVAL_MS = Number(process.env.RESOLUTION_SWEEP_MS || 5000);

function round2(value) { return Math.round(value * 100) / 100; }
function round5(value) { return Math.round(value * 100000) / 100000; }
function windowStartFor(timeMs) { return Math.floor(timeMs / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(asset, start) { return `${asset}-updown-5m-${start}`; }

class MomentumLagEngine {
  constructor(options = {}) {
    this.WebSocketImpl = options.WebSocketImpl || require('ws');
    this.fetchImpl = options.fetchImpl || fetch;
    this.emitTick = options.onTick || (() => {});
    this.emitLog = options.onLog || (() => {});
    this.startedAt = Date.now();
    this.bankroll = START_BANKROLL;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.tickCount = 0;
    this.messageCount = 0;
    this.reconnects = 0;
    this.connected = false;
    this.lastMessageAt = null;
    this.equityCurve = [{ t: Date.now(), equity: START_BANKROLL }];
    this.logs = [];
    this.trades = [];
    this.positions = [];
    this.combos = [];
    this.resolvedCombos = [];
    this.markets = new Map();
    this.tokens = new Map();
    this.windows = new Map();
    this.history = new Map();
    this.discoveredWindows = new Set();
    this.activeWindowStart = null;
    this.socket = null;
    this.subscribedTokens = new Set();
    this.loopRunning = false;
    this.firedComboKeys = new Set();
    this.discoveryErrors = [];
    this.lastDiscoveryAt = null;
    this.discoveryRunning = false;
    this.connectionStartedAt = null;
    this.handshakeTimer = null;
  }

  log(message) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${message}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    this.emitLog(line);
  }

  parseJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  async getJSON(url, timeout = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'btc-divergence-bot/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  async discoverMarket(asset, start) {
    const slug = slugFor(asset, start);
    if (this.discoveredWindows.has(slug)) return this.markets.get(slug) || null;
    let market = null;
    try {
      const rows = await this.getJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
      market = Array.isArray(rows) ? rows[0] : null;
    } catch (error) {
      this.discoveryErrors.unshift(`${slug}: ${error.message}`);
      this.discoveryErrors=this.discoveryErrors.slice(0,8);
      this.log(`⚠️ Discovery ${slug}: ${error.message}`);
      return null;
    }
    this.lastDiscoveryAt=Date.now();
    if (!market || !market.conditionId || !market.clobTokenIds || market.closed) {
      this.discoveryErrors.unshift(`${slug}: market unavailable/closed`);
      this.discoveryErrors=this.discoveryErrors.slice(0,8);
      return null;
    }
    this.discoveredWindows.add(slug);
    const outcomes = this.parseJson(market.outcomes) || [];
    const tokenIds = this.parseJson(market.clobTokenIds) || [];
    const upIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'up');
    const downIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'down');
    if (upIndex < 0 || downIndex < 0 || !tokenIds[upIndex] || !tokenIds[downIndex]) {
      this.log(`⚠️ Invalid token mapping ${slug}`);
      return null;
    }
    const record = {
      slug,
      asset,
      conditionId: market.conditionId,
      title: market.question || slug,
      windowStart: start,
      windowEnd: start + WINDOW_SECONDS,
      tradingClosed: false,
      resolved: false,
      winner: null,
      resolutionSource: null,
      finalUpMax: null,
      finalDownMax: null,
      up: this.makeToken(tokenIds[upIndex], slug, asset, 'UP'),
      down: this.makeToken(tokenIds[downIndex], slug, asset, 'DOWN'),
    };
    this.markets.set(slug, record);
    this.tokens.set(record.up.tokenId, record.up);
    this.tokens.set(record.down.tokenId, record.down);
    this.subscribe([record.up.tokenId, record.down.tokenId]);
    this.log(`🎯 ${asset.toUpperCase()} 5m discovered ${slug} — WebSocket armed`);
    return record;
  }

  makeToken(tokenId, slug, asset, outcome) {
    return {
      tokenId: String(tokenId), slug, asset, outcome,
      bid: null, ask: null, mid: null, spread: null,
      previousMid: null, updatedAt: null,
    };
  }

  async discoverWindow(start, label) {
    await Promise.all(ASSETS.map(asset => this.discoverMarket(asset, start)));
    if (!this.activeWindowStart && this.hasOpenTradingMarket(start)) {
      this.activeWindowStart = start;
      this.log(`🚀 ${label} window active — ${start}`);
    }
  }

  hasOpenTradingMarket(start) {
    return [...this.markets.values()].some(market =>
      market.windowStart === start && !market.tradingClosed && market.up.tokenId);
  }

  subscribe(tokenIds) {
    let added = false;
    for (const tokenId of tokenIds.map(String)) {
      if (!this.subscribedTokens.has(tokenId)) { this.subscribedTokens.add(tokenId); added = true; }
    }
    if (!added || !this.socket || this.socket.readyState !== 1) return;
    this.sendSubscription();
  }

  sendSubscription() {
    this.socket.send(JSON.stringify({ assets_ids: [...this.subscribedTokens], type: 'market' }));
  }

  connect() {
    if (!this.WebSocketImpl || this.socket) return;
    this.connectionStartedAt = Date.now();
    try { this.socket = new this.WebSocketImpl(CLOB_WS); }
    catch (error) { this.socket = null; this.scheduleReconnect(); return; }
    const socket = this.socket;
    this.handshakeTimer = setTimeout(() => {
      if (this.socket === socket && !this.connected) {
        this.log('⏱️ CLOB handshake timeout — forcing reconnect');
        this.reconnects++;this.closeStaleSocket();
      }
    }, 3500);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      clearTimeout(this.handshakeTimer);
      this.connected = true;
      this.lastMessageAt = Date.now();
      this.log(`🔌 CLOB market WebSocket connected — ${this.subscribedTokens.size} tokens`);
      if (this.subscribedTokens.size) this.sendSubscription();
    };
    socket.onmessage = event => { if (this.socket === socket) this.handleMessage(String(event.data)); };
    socket.onerror = () => {};
    socket.onclose = () => {
      const hadSocket = this.socket === socket;
      clearTimeout(this.handshakeTimer);
      this.connected = false;
      this.socket = null;
      if (hadSocket) {
        this.reconnects++;
        this.log('⚠️ CLOB socket closed — reconnecting');
        this.scheduleReconnect();
      }
    };
  }

  closeStaleSocket() {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (!socket) return;
    try { socket.terminate ? socket.terminate() : socket.close(); }
    catch (_) { try { socket.close(); } catch (_) {} }
  }

  watchdogTick() {
    if (!this.socket) { this.connect(); return; }
    const now = Date.now();
    if (this.socket.readyState === 0 && now - this.connectionStartedAt > 3500) {
      this.log('⏱️ CLOB connection stuck — recycling');
      this.closeStaleSocket();
      return;
    }
    if (this.socket.readyState !== 1) return;
    const silence = now - (this.lastMessageAt || this.connectionStartedAt);
    if (silence > 4000) {
      try { this.socket.send('PING'); } catch (_) {}
    }
    if (silence > 9000) {
      this.log('⚠️ CLOB stream silent — recycling socket');
      this.reconnects++;this.closeStaleSocket();
    }
  }

  scheduleReconnect() {
    setTimeout(() => this.connect(), 300);
  }

  handleMessage(raw) {
    let events;
    try { events = JSON.parse(raw); } catch (_) { return; }
    if (!Array.isArray(events)) events = [events];
    this.messageCount++;
    this.lastMessageAt = Date.now();
    for (const event of events) this.processEvent(event);
    this.tickCount++;
    this.emitTick(this.publicMarkets());
  }

  processEvent(event) {
    const eventType = event.event_type;
    if (event.asset_id && Array.isArray(event.bids)) {
      const token = this.tokens.get(String(event.asset_id));
      if (token) {
        this.applyBook(token, event.bids, event.asks || []);
        const ownedMarket = this.markets.get(token.slug);
        if (ownedMarket && Date.now() / 1000 >= ownedMarket.windowEnd) this.resolveFromFinalPrices(ownedMarket);
        this.updatePositionMarks();this.evaluateSignals();
      }
      return;
    }
    if (Array.isArray(event.price_changes)) {
      for (const change of event.price_changes) {
        const token = this.tokens.get(String(change.asset_id));
        if (!token) continue;
        this.applyTop(token, change.best_bid, change.best_ask);
        const ownedMarket = this.markets.get(token.slug);
        if (ownedMarket && Date.now() / 1000 >= ownedMarket.windowEnd) this.resolveFromFinalPrices(ownedMarket);
      }
      this.updatePositionMarks();this.evaluateSignals();
    }
    void eventType;
  }

  applyBook(token, bids, asks) {
    const validBids = bids.filter(level => Number(level.size) > 0).map(level => ({ price: Number(level.price), size: Number(level.size) }));
    const validAsks = asks.filter(level => Number(level.size) > 0).map(level => ({ price: Number(level.price), size: Number(level.size) }));
    validBids.sort((a, b) => b.price - a.price);
    validAsks.sort((a, b) => a.price - b.price);
    this.setQuote(token, validBids[0]?.price ?? null, validAsks[0]?.price ?? null);
  }

  applyTop(token, bestBid, bestAsk) {
    const bid = bestBid == null ? token.bid : Number(bestBid);
    const ask = bestAsk == null ? token.ask : Number(bestAsk);
    this.setQuote(token, bid, ask);
  }

  setQuote(token, bid, ask) {
    const cleanBid = Number.isFinite(bid) && bid > 0 && bid <= 1 ? bid : null;
    const cleanAsk = Number.isFinite(ask) && ask > 0 && ask <= 1 ? ask : null;
    if (cleanBid === token.bid && cleanAsk === token.ask) return;
    token.bid = cleanBid;
    token.ask = cleanAsk;
    token.spread = cleanBid != null && cleanAsk != null ? round5(cleanAsk - cleanBid) : null;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.updatedAt = Date.now();
    this.pushHistory(token.tokenId, token.mid);
    const market = this.markets.get(token.slug);
    if (market) this.trackFinalPrices(market);
  }

  trackFinalPrices(market) {
    const nowSeconds = Date.now() / 1000;
    const elapsed = nowSeconds - market.windowStart;
    if (elapsed < WINDOW_SECONDS - 2) {
      market.finalUpMax = null;
      market.finalDownMax = null;
      return;
    }
    if (elapsed >= WINDOW_SECONDS) return;
    const upMid = Number.isFinite(market.up.mid) ? market.up.mid : null;
    const downMid = Number.isFinite(market.down.mid) ? market.down.mid : null;
    if (upMid != null && (market.finalUpMax == null || upMid > market.finalUpMax)) market.finalUpMax = upMid;
    if (downMid != null && (market.finalDownMax == null || downMid > market.finalDownMax)) market.finalDownMax = downMid;
  }

  resolveFromFinalPrices(market) {
    if (market.resolved || !Number.isFinite(market.finalUpMax) || !Number.isFinite(market.finalDownMax)) return false;
    const upStrong = market.finalUpMax > RESOLUTION_PRICE;
    const downStrong = market.finalDownMax > RESOLUTION_PRICE;
    if (upStrong === downStrong) return false;
    market.tradingClosed = true;
    market.resolved = true;
    market.winner = upStrong ? 'UP' : 'DOWN';
    market.resolutionSource = 'CLOB_FINAL_2S';
    return true;
  }

  pushHistory(tokenId, price) {
    if (!Number.isFinite(price)) return;
    const now = Date.now();
    const series = this.history.get(tokenId) || [];
    series.push({ t: now, p: price });
    while (series.length > 2 && now - series[0].t > PRICE_HISTORY_MS) series.shift();
    this.history.set(tokenId, series.slice(-240));
  }

  evaluateSignals() {
    const leadMarket = this.currentMarket(LEAD_ASSET);
    if (!leadMarket || leadMarket.windowStart !== this.activeWindowStart) return;
    if (!Number.isFinite(leadMarket.up.mid) || !Number.isFinite(leadMarket.down.mid)) return;

    for (const altAsset of ASSETS.filter(asset => asset !== LEAD_ASSET)) {
      const altMarket = this.markets.get(slugFor(altAsset, leadMarket.windowStart));
      if (!altMarket || altMarket.resolved) continue;
      for (const btcOutcome of ['UP', 'DOWN']) {
        const comboName = `${altAsset.toUpperCase()}_${btcOutcome === 'UP' ? 'DOWN' : 'UP'}`;
        const comboKey = `${leadMarket.windowStart}:${comboName}`;
        if (this.firedComboKeys.has(comboKey)) continue;
        const btcToken = btcOutcome === 'UP' ? leadMarket.up : leadMarket.down;
        const altOutcome = btcOutcome === 'UP' ? 'DOWN' : 'UP';
        const altToken = altOutcome === 'UP' ? altMarket.up : altMarket.down;
        if (!Number.isFinite(btcToken.mid) || !Number.isFinite(altToken.mid)) continue;
        const combinedMid = round5(btcToken.mid + altToken.mid);
        if (combinedMid >= ENTRY_MAX_SUM) continue;
        this.fireCombo({
          key: comboKey, name: comboName, windowStart: leadMarket.windowStart,
          btcMarket: leadMarket, btcToken, altMarket, altToken, combinedMid,
        });
      }
    }
  }

  currentMarket(asset) {
    return [...this.markets.values()].find(market =>
      market.asset === asset && !market.resolved && Date.now() / 1000 < market.windowEnd) || null;
  }

  fireCombo(signal) {
    const now = Date.now();
    if (now / 1000 >= signal.btcMarket.windowEnd) return;
    const legs = [signal.btcMarket, signal.altMarket].map((market, index) => {
      const token = index === 0 ? signal.btcToken : signal.altToken;
      const fillPrice = token.ask;
      const cost = Number.isFinite(fillPrice) ? round2(TRADE_SHARES * fillPrice) : NaN;
      const fee = Number.isFinite(cost) ? round2(cost * TAKER_FEE_BPS / 10000) : NaN;
      return {
        market, token, fillPrice, cost, fee,
        outcome: token.outcome, slug: market.slug, asset: market.asset,
        conditionId: market.conditionId, tokenId: token.tokenId,
      };
    });
    if (!legs.every(leg => Number.isFinite(leg.fillPrice))) return;
    const cost = round2(legs.reduce((sum, leg) => sum + leg.cost, 0));
    const fees = round2(legs.reduce((sum, leg) => sum + leg.fee, 0));
    if (cost + fees > this.bankroll) {
      this.log(`⚠️ ${signal.name} skipped — need $${round2(cost + fees)}, available $${this.bankroll}`);
      return;
    }
    this.firedComboKeys.add(signal.key);

    const comboId = `${signal.name}-${signal.windowStart}`;
    const openedAt = new Date(now).toISOString();
    const elapsed = Math.floor(now / 1000 - signal.windowStart);
    const positionLegs = legs.map((leg, index) => ({
      id: `${comboId}-${leg.asset}-${index}`, comboId, slug: leg.slug,
      asset: leg.asset, conditionId: leg.conditionId, outcome: leg.outcome,
      tokenId: leg.tokenId, shares: TRADE_SHARES, avgPrice: leg.fillPrice,
      entryPrice: leg.fillPrice, cost: leg.cost, fee: leg.fee, fills: 1,
      status: 'open', openedAt, markPrice: leg.token.mid,
      signal: {
        combo: signal.name, combinedMid: signal.combinedMid, elapsed,
        entryThreshold: ENTRY_MAX_SUM,
      },
    }));

    const combo = {
      id: comboId, name: signal.name, status: 'open', windowStart: signal.windowStart,
      windowEnd: signal.btcMarket.windowEnd, combinedEntryMid: signal.combinedMid,
      combinedAsk: round2(cost / TRADE_SHARES), cost, fees, payout: null, pnl: null,
      result: null, winner: null, resolutionSource: null,
      legs: positionLegs.map(leg => ({ ...leg })), openedAt,
    };
    this.positions.push(...positionLegs);
    this.combos.push(combo);
    this.bankroll = round2(this.bankroll - cost - fees);
    for (const leg of positionLegs) {
      const trade = {
        timestamp: now, orderType: 'PAPER-FOK', comboId, combo: signal.name,
        slug: leg.slug, asset: leg.asset, outcome: leg.outcome, shares: leg.shares,
        price: leg.avgPrice, cost: leg.cost, markPrice: leg.markPrice,
        pnl: this.positionPnl(leg), signal: leg.signal,
      };
      this.trades.push(trade);
      this.log(`⚡ BUY ${leg.asset.toUpperCase()} ${leg.outcome} ${TRADE_SHARES}sh @${leg.avgPrice.toFixed(3)} | ${signal.name} mid ${signal.combinedMid.toFixed(3)} < ${ENTRY_MAX_SUM.toFixed(2)} | $${leg.cost.toFixed(2)}`);
    }
    this.trades = this.trades.slice(-300);
    this.log(`✅ ${signal.name} OPEN — combined mid ${signal.combinedMid.toFixed(3)} · cost $${cost.toFixed(2)} · hold to resolution`);
    this.recordEquity();
  }

  positionPnl(position) {
    return round2(position.shares * (position.markPrice ?? position.avgPrice) - position.cost - position.fee);
  }

  comboMark(combo) {
    return round2(combo.legs.reduce((sum, leg) => {
      const market = this.markets.get(leg.slug);
      const token = leg.outcome === 'UP' ? market?.up : market?.down;
      return sum + leg.shares * (token?.mid ?? leg.markPrice ?? leg.entryPrice);
    }, 0));
  }

  comboUnrealizedPnl(combo) {
    return round2(this.comboMark(combo) - combo.cost - combo.fees);
  }

  updatePositionMarks() {
    for (const combo of this.combos) {
      if (combo.status !== 'open') continue;
      for (const leg of combo.legs) {
        const market = this.markets.get(leg.slug);
        const token = leg.outcome === 'UP' ? market?.up : market?.down;
        if (Number.isFinite(token?.mid)) leg.markPrice = token.mid;
      }
    }
    for (const position of this.positions) {
      if (position.status !== 'open') continue;
      const market = this.markets.get(position.slug);
      const token = position.outcome === 'UP' ? market?.up : market?.down;
      if (Number.isFinite(token?.mid)) position.markPrice = token.mid;
    }
  }

  settleResolvedCombos() {
    for (const combo of this.combos) {
      if (combo.status !== 'open') continue;
      const markets = combo.legs.map(leg => this.markets.get(leg.slug));
      if (!markets.every(market => market?.resolved && market.winner)) continue;
      let payout = 0;
      for (let index = 0; index < combo.legs.length; index++) {
        const leg = combo.legs[index];
        const won = leg.outcome === markets[index].winner;
        const legPayout = won ? leg.shares : 0;
        payout += legPayout;
        leg.status = won ? 'won' : 'lost';
        leg.won = won; leg.payout = round2(legPayout); leg.markPrice = won ? 1 : 0;
        leg.pnl = round2(legPayout - leg.cost - leg.fee);
        leg.winner = markets[index].winner; leg.resolutionSource = markets[index].resolutionSource;
        leg.resolvedAt = new Date().toISOString();
      }
      payout = round2(payout);
      const pnl = round2(payout - combo.cost - combo.fees);
      combo.status = 'settled'; combo.payout = payout; combo.pnl = pnl;
      combo.result = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT';
      combo.winner = combo.legs.filter(leg => leg.won).map(leg => `${leg.asset.toUpperCase()} ${leg.outcome}`).join(' + ') || 'none';
      combo.resolutionSource = markets.map(market => market.resolutionSource).join('/');
      combo.settledAt = new Date().toISOString();
      this.bankroll = round2(this.bankroll + payout);
      this.realizedPnl = round2(this.realizedPnl + pnl);
      if (pnl > 0) this.wins++; else if (pnl < 0) this.losses++;
      this.resolvedCombos.unshift({ ...combo, legs: combo.legs.map(leg => ({ ...leg })) });
      this.resolvedCombos = this.resolvedCombos.slice(0, 30);
      this.log(`🏁 [${combo.resolutionSource}] ${combo.name} ${combo.result} — winners ${combo.winner} · cost $${combo.cost.toFixed(2)}, payout $${payout.toFixed(2)}, P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    }
    // Backward-compatible public positions remain individual combo legs.
    this.positions = this.positions.filter(position => position.status === 'open');
  }

  activeComboSummaries() {
    return this.combos.filter(combo => combo.status === 'open').map(combo => ({
      ...combo, legs: combo.legs.map(leg => ({ ...leg })),
      markValue: this.comboMark(combo), unrealized: this.comboUnrealizedPnl(combo),
    })).reverse();
  }

  async retryDiscovery() {
    if (this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      const starts = [windowStartFor(Date.now()), windowStartFor(Date.now()) + WINDOW_SECONDS];
      const missing = [];
      for (const start of starts) {
        for (const asset of ASSETS) {
          if (!this.markets.has(slugFor(asset, start))) missing.push({ asset, start });
        }
      }
      if (missing.length) await Promise.all(missing.map(item => this.discoverMarket(item.asset, item.start)));
    } finally { this.discoveryRunning = false; }
  }

  async rotateAndSweep() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      const start = windowStartFor(Date.now());
      if (start !== this.activeWindowStart) {
        this.activeWindowStart = null;
        this.firedComboKeys.clear();
        await this.discoverWindow(start, 'New');
      }
      for (const market of this.markets.values()) {
        if (market.resolved || Date.now() / 1000 < market.windowEnd - 2) continue;
        this.trackFinalPrices(market);
        if (Date.now() / 1000 >= market.windowEnd) this.resolveFromFinalPrices(market);
      }
      this.settleResolvedCombos();
      this.pruneExpiredMarkets();
      this.recordEquity();
    } catch (error) {
      this.log(`⚠️ Loop: ${error.message}`);
    } finally { this.loopRunning = false; }
  }

  pruneExpiredMarkets() {
    const expiryCutoff = Date.now() / 1000 - 2;
    const expired = [...this.markets.values()].filter(market => market.windowEnd < expiryCutoff);
    if (!expired.length) return;

    for (const market of expired) {
      this.markets.delete(market.slug);
      this.tokens.delete(market.up.tokenId);
      this.tokens.delete(market.down.tokenId);
      this.history.delete(market.up.tokenId);
      this.history.delete(market.down.tokenId);
    }

    this.subscribedTokens = new Set([...this.tokens.values()].map(token => token.tokenId));
    if (this.socket?.readyState === 1) this.sendSubscription();
    this.log(`🧹 Released ${expired.length} expired market(s) — ${this.subscribedTokens.size} CLOB tokens active`);
  }

  publicMarkets() {
    const currentStart = windowStartFor(Date.now());
    return [...this.markets.values()]
      .filter(market => market.windowStart === currentStart)
      .sort((a, b) => a.asset.localeCompare(b.asset))
      .map(market => ({
        slug: market.slug, asset: market.asset, title: market.title,
        windowStart: market.windowStart, windowEnd: market.windowEnd,
        resolved: market.resolved, winner: market.winner,
        resolutionSource: market.resolutionSource,
        finalUpMax: market.finalUpMax, finalDownMax: market.finalDownMax,
        elapsed: Math.max(0, Math.floor(Date.now() / 1000 - market.windowStart)),
        remaining: Math.max(0, market.windowEnd - Math.floor(Date.now() / 1000)),
        up: publicToken(market.up), down: publicToken(market.down),
      }));
  }

  buildState() {
    this.updatePositionMarks();
    const openCombos = this.activeComboSummaries();
    const openValue = round2(openCombos.reduce((sum, combo) => sum + combo.markValue, 0));
    const unrealizedPnl = round2(openCombos.reduce((sum, combo) => sum + combo.unrealized, 0));
    const markValue = round2(this.bankroll + openValue);
    const activeStart = windowStartFor(Date.now());
    const currentDiscovered = ASSETS.filter(asset => this.markets.has(slugFor(asset, activeStart))).length;
    const nextDiscovered = ASSETS.filter(asset => this.markets.has(slugFor(asset, activeStart + WINDOW_SECONDS))).length;
    return {
      mode: 'AUTONOMOUS DEMO',
      strategy: 'BTC+ALT opposite-side combo <0.75 · hold to resolution',
      serverTime: Date.now(),
      connected: this.connected, tickCount: this.tickCount, messageCount: this.messageCount,
      reconnects: this.reconnects, lastMessageAt: this.lastMessageAt,
      subscribedTokens: this.subscribedTokens.size,
      discovery: {
        expectedMarkets: ASSETS.length,
        currentDiscovered, nextDiscovered,
        expectedTokens: ASSETS.length * 2 * (currentDiscovered === ASSETS.length && nextDiscovered === ASSETS.length ? 2 : 1),
        errors: this.discoveryErrors,
        lastDiscoveryAt: this.lastDiscoveryAt,
      },
      watchAssets: ASSETS, leadAsset: LEAD_ASSET.toUpperCase(),
      bankroll: this.bankroll, markValue, realizedPnl: this.realizedPnl,
      openValue, unrealizedPnl, totalPnl: round2(markValue - START_BANKROLL),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      markets: this.publicMarkets(),
      positions: this.positions.filter(position => position.status === 'open').slice().reverse(),
      combos: openCombos,
      resolvedCombos: this.resolvedCombos.slice(0, 20),
      trades: this.trades.slice(-160).reverse(),
      equityCurve: this.equityCurve.slice(-1500),
      logs: this.logs.slice(-220),
      config: {
        tradeShares: TRADE_SHARES, entryMaxSum: ENTRY_MAX_SUM,
        resolutionPrice: RESOLUTION_PRICE, feeBps: TAKER_FEE_BPS,
      },
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  recordEquity() {
    const state = this.buildState();
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || Date.now() - last.t > 1000 || Math.abs(last.equity - state.markValue) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: state.markValue });
      if (this.equityCurve.length > 2000) this.equityCurve.shift();
    }
  }

  async init() {
    const start = windowStartFor(Date.now());
    this.connect();
    await Promise.all([
      this.discoverWindow(start, 'Current'),
      this.discoverWindow(start + WINDOW_SECONDS, 'Next'),
    ]);
    setInterval(() => this.rotateAndSweep(), 250);
    setInterval(() => this.watchdogTick(), 500);
    setInterval(() => this.retryDiscovery(), 1500);
    this.log(`🚀 BTC correlation combo bot started | ${ASSETS.join('/')} | demo $${START_BANKROLL}`);
  }
}

function publicToken(token) {
  return {
    bid: token.bid, ask: token.ask, mid: token.mid, spread: token.spread,
    updatedAt: token.updatedAt,
  };
}

module.exports = {
  MomentumLagEngine,
  config: {
    ASSETS, LEAD_ASSET, START_BANKROLL, TRADE_SHARES,
    ENTRY_MAX_SUM, RESOLUTION_PRICE, TAKER_FEE_BPS,
  },
};
