'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MomentumLagEngine } = require('./engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const port = process.env.PORT || 8080;

const engine = new MomentumLagEngine({
  onTick: (markets, messageCount) => io.emit('tick', {
    t: Date.now(),
    windowStart: markets[0]?.windowStart ?? null,
    messageCount,
    markets,
  }),
  onLog: (line) => {
    console.log(line);
    io.emit('log', line);
  },
});

// ─── Dashboard HTML ──────────────────────────────────────────
const dashboard = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CorrelBot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{color-scheme:dark}
body{background:#000;color:#e0e6ed;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;padding:12px}
.shell{max-width:1540px;margin:auto}

/* ── Top Bar ── */
.topbar{display:flex;justify-content:space-between;align-items:center;background:#070b10;border:1px solid #172434;border-radius:14px;padding:14px 18px;margin-bottom:10px}
.brand{display:flex;align-items:center;gap:10px}
.brand-icon{font-size:26px}
h1{font-size:20px;letter-spacing:.3px}
.sub{font-size:9px;color:#7f93a8;margin-top:2px}
.pills{display:flex;gap:5px;flex-wrap:wrap;justify-content:right}
.pill{border:1px solid #22364b;background:#08111c;border-radius:999px;padding:5px 10px;font-size:9px;color:#9fb1c4;white-space:nowrap}
.pill.live{color:#00ff9d;border-color:#00ff9d55;background:#00ff9d10}
.pill.warn{color:#ffc861;border-color:#ffc86155;background:#ffc86110}
.pill.bad{color:#ff5566;border-color:#ff556655;background:#ff556610}
.pill.blue{color:#38d6ff;border-color:#38d6ff55;background:#38d6ff10}

/* ── KPIs ── */
.kpis{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:6px;margin-bottom:10px}
.kpi{background:#060a0f;border:1px solid #16232f;border-radius:12px;padding:10px 12px}
.kpi .label{font-size:8px;text-transform:uppercase;color:#667e94;letter-spacing:.6px}
.kpi .value{font-size:18px;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi .small{font-size:8px;color:#617589;margin-top:2px}

/* ── Panels ── */
.panel{background:#060a0f;border:1px solid #16232f;border-radius:13px;overflow:hidden;margin-bottom:10px}
.panel-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #14202c;font-size:11px;color:#8ea2b6}
.panel-head strong{font-size:11px}
.panel-body{padding:10px}

/* ── Layout Grids ── */
.two-col{display:grid;grid-template-columns:1fr 320px;gap:10px;margin-bottom:10px}
.markets{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:10px}
.market-card{background:#060a0f;border:1px solid #16232f;border-radius:13px;padding:12px}
.market-top{display:flex;justify-content:space-between;align-items:flex-start}
.asset-name{font-size:16px;font-weight:800}
.asset-slug{font-size:8px;color:#556677;margin-top:1px}
.timer{font-size:18px;color:#39d7ff;font-variant-numeric:tabular-nums;text-align:right;font-weight:800}
.timer small{display:block;font-size:8px;color:#65798d}
.sides{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.side{background:#05090f;border:1px solid #152430;border-radius:10px;padding:10px}
.side-label{font-size:10px;color:#8fa3b7;margin-bottom:4px}
.side-label.up{color:#28e0a5}
.side-label.down{color:#ff6b81}
.mid{font-size:28px;line-height:1.1;font-variant-numeric:tabular-nums;font-weight:800}
.quote{font-size:9px;color:#7f93a8;margin-top:4px}
.spread-badge{display:inline-block;font-size:8px;color:#ffd166;background:#ffd16615;border:1px solid #ffd16633;border-radius:6px;padding:1px 5px;margin-top:3px}
.age-badge{display:inline-block;font-size:8px;color:#7788;font-size:7px;margin-left:4px}

/* ── Strategy Panel ── */
.config-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;padding:10px}
.config-item{background:#080f18;border-radius:9px;padding:8px 10px;font-size:8px;color:#657b91}
.config-item b{display:block;font-size:11px;color:#fff;margin-top:3px}

/* ── Positions / Combos ── */
.positions{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:10px}
.position-card{background:#060a0f;border:1px solid #16232f;border-radius:12px;padding:12px}
.pos-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.pos-name{font-size:14px;font-weight:800}
.pos-badge{font-size:8px;border-radius:99px;padding:3px 8px;font-weight:700}
.pos-badge.holding{color:#38d6ff;border:1px solid #38d6ff44;background:#38d6ff10}
.pos-badge.won{color:#00ff9d;border:1px solid #00ff9d44;background:#00ff9d10}
.pos-badge.lost{color:#ff5566;border:1px solid #ff556644;background:#ff556610}
.pos-badge.settled{color:#888;border:1px solid #88888844;background:#88888810}
.pos-pnl{font-size:20px;margin:4px 0;font-variant-numeric:tabular-nums}
.pos-meta{font-size:8px;color:#617589}
.legs{display:grid;gap:6px;margin-top:8px}
.leg{background:#05090f;border:1px solid #12202c;border-radius:9px;padding:8px 10px}
.leg-top{display:flex;justify-content:space-between;align-items:center}
.tag{border-radius:6px;padding:2px 6px;font-size:9px;font-weight:700}
.tag-up{color:#28e0a5;background:#28e0a515;border:1px solid #28e0a533}
.tag-down{color:#ff6b81;background:#ff6b8115;border:1px solid #ff6b8133}
.leg-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:6px}
.metric{background:#080f18;border-radius:7px;padding:5px 6px;font-size:8px;color:#677d92}
.metric b{display:block;font-size:11px;color:#fff;margin-top:1px}
.combo-total{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:8px}

/* ── Results ── */
.results-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:10px}
.result-card{background:#060a0f;border:1px solid #16232f;border-radius:12px;padding:12px}
.result-header{display:flex;justify-content:space-between;align-items:center}
.result-icon{font-size:14px}
.result-pnl{font-size:18px;margin-top:4px;font-variant-numeric:tabular-nums}
.result-meta{font-size:8px;color:#617589;margin-top:2px}

/* ── Feed ── */
.feeds{display:grid;gap:6px;padding:10px}
.feed-item{background:#080f18;border-radius:9px;padding:8px 10px;border:1px solid #152430}
.feed-time{font-size:8px;color:#556677}
.feed-main{font-size:11px;margin-top:3px}
.feed-detail{font-size:8px;color:#617589;margin-top:2px}

/* ── Chart ── */
.chart{height:160px;padding:8px}
svg{width:100%;height:100%}

/* ── Logs ── */
.logs{height:220px;overflow:auto;background:#010407;border-radius:10px;padding:8px;font-family:SFMono-Regular,Consolas,monospace;font-size:9px;font-weight:500;-webkit-overflow-scrolling:touch}
.log{white-space:pre-wrap;color:#95a7b9;padding:1px 0}
.log-info{color:#38d6ff}
.log-win{color:#00ff9d}
.log-loss{color:#ff4a68}
.empty{padding:20px;text-align:center;color:#445467;font-size:11px}

/* ── Colors ── */
.green{color:#00ff9d!important}
.red{color:#ff4a68!important}
.blue{color:#38d6ff!important}
.gold{color:#ffd166!important}
.white{color:#fff!important}

/* ── Responsive ── */
@media(max-width:1100px){.two-col{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(4,1fr)}.markets,.positions,.results-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">

  <!-- Top Bar -->
  <header class="topbar">
    <div class="brand">
      <div class="brand-icon">⚡</div>
      <div>
        <h1>CorrelBot</h1>
        <div class="sub">Lagging side catch-up · strong ≥ 0.75 & weak ≤ 0.50 · GTC@0.99 · 1 combo/window · hold to resolution</div>
      </div>
    </div>
    <div class="pills">
      <span class="pill live" id="pConnection">CONNECTING</span>
      <span class="pill warn" id="pClob">CLOB</span>
      <span class="pill warn" id="pDiscovery">DISCOVERY</span>
      <span class="pill" id="pTokens">0 TK</span>
      <span class="pill" id="pRate">0 msg/s</span>
      <span class="pill blue" id="pUptime">00:00</span>
    </div>
  </header>

  <!-- KPIs -->
  <section class="kpis" id="kpis"></section>

  <!-- Equity Curve + Strategy Config -->
  <div class="two-col">
    <div class="panel">
      <div class="panel-head"><span>📈 Equity Curve</span><strong id="equityValue">—</strong></div>
      <div class="chart"><svg id="equityChart" preserveAspectRatio="none"></svg></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>⚙️ Strategy Rules</span><strong class="live">ACTIVE</strong></div>
      <div class="config-grid" id="configGrid"></div>
    </div>
  </div>

  <!-- Live Market Prices -->
  <div class="panel">
    <div class="panel-head"><span>📊 Live CLOB Order Books</span><strong id="tickInfo">WAITING</strong></div>
    <div class="markets" id="marketsGrid"></div>
  </div>

  <!-- Open Positions (Floating P&L) -->
  <div class="panel">
    <div class="panel-head"><span>🎯 Open Positions — Floating P&L</span><strong id="openCount">0 OPEN</strong></div>
    <div class="positions" id="positionsGrid"></div>
  </div>

  <!-- Resolved Positions -->
  <div class="panel">
    <div class="panel-head"><span>✅ Resolved Positions</span><strong>SETTLED</strong></div>
    <div class="results-grid" id="resultsGrid"></div>
  </div>

  <!-- Trade Feed -->
  <div class="panel">
    <div class="panel-head"><span>⚡ Trade Feed</span><strong id="tradeCount">0 TRADES</strong></div>
    <div class="feeds" id="feedGrid"></div>
  </div>

  <!-- Activity Log -->
  <div class="panel">
    <div class="panel-head"><span>📋 Activity Log</span><strong id="logCount">0</strong></div>
    <div class="logs" id="logsPanel"></div>
  </div>

</div>

<script src="/socket.io/socket.io.js"></script>
<script>
/* ─── State ─── */
let S = null;           // full server state
let lastTick = null;     // latest tick packet
let lastRender = 0;
let msgCount = 0, lastRateTime = Date.now(), rate = 0;
const logs = [];
const $ = id => document.getElementById(id);

function safe(fn) { try { fn() } catch(e) { console.error(e) } }

/* ─── Helpers ─── */
const num  = v => Number(v||0).toLocaleString(undefined, {maximumFractionDigits:2});
const cash = v => '$' + Number(v||0).toFixed(2);
const money = v => { if (v==null) return '—'; const n=Number(v); return (n>0?'+$':n<0?'-$':'$') + Math.abs(n).toFixed(2); };
const tone = v => Number(v)>0 ? 'green' : Number(v)<0 ? 'red' : '';
const prc  = v => v==null ? '—' : Number(v).toFixed(3);
const clk  = s => { s=Math.max(0,Math.floor(s)); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); };
const esc  = x => String(x||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const age  = ms => { const s=Math.floor((Date.now()-ms)/1000); return s<=0?'now':s<60?s+'s':Math.floor(s/60)+'m'; };

/* ─── Socket ─── */
const socket = io({ transports:['polling'], upgrade:false, reconnectionDelay:250, reconnectionDelayMax:1000, timeout:3000 });

socket.on('connect', () => { $('pConnection').textContent='LIVE'; $('pConnection').className='pill live'; });
socket.on('disconnect', () => { $('pConnection').textContent='RETRY'; $('pConnection').className='pill warn'; });
socket.on('log', line => { logs.push(line); if (logs.length>400) logs.shift(); safe(renderLogs); });
socket.on('tick', data => {
  if (!data || !data.windowStart) return;
  lastTick = data;
  if (data.messageCount!=null) { const now=Date.now(); if (now-lastRateTime>1000){rate=data.messageCount-msgCount;msgCount=data.messageCount;lastRateTime=now;} }
  if (Date.now()-lastRender >= 80) { safe(()=>renderLivePrices(data)); lastRender=Date.now(); }
});
socket.on('state', data => safe(()=>render(data)));

/* ─── Poll state every 1s as fallback ─── */
async function pollState() {
  try {
    const r = await fetch('/api/status');
    render(await r.json());
  } catch(e) {
    $('pConnection').textContent='RETRY';
    $('pConnection').className='pill warn';
  }
}
pollState();
setInterval(pollState, 1000);

/* ─── Main render ─── */
function render(data) {
  if (S && S.windowStart !== data.windowStart) { lastTick = null; }
  S = data;

  /* pills */
  $('pUptime').textContent = clk(data.uptime);
  $('pRate').textContent = rate + ' msg/s';
  $('pTokens').textContent = data.trackedTokens + ' TK';
  const clob = $('pClob');
  clob.textContent = data.connected ? 'CLOB LIVE' : 'CLOB POLL';
  clob.className = 'pill ' + (data.connected ? 'live' : 'warn');
  const disc = $('pDiscovery');
  disc.textContent = data.discovery.currentDiscovered + '/' + data.discovery.expectedMarkets + ' DISC';
  disc.className = 'pill ' + (data.discovery.currentDiscovered===data.discovery.expectedMarkets ? 'live' : 'warn');

  /* KPIs */
  $('kpis').innerHTML = [
    ['Bankroll',    cash(data.bankroll),                              'white'],
    ['Realized P&L',money(data.realizedPnl),                         data.realizedPnl>0?'green':data.realizedPnl<0?'red':''],
    ['Unrealized',  money(data.unrealizedPnl),                       data.unrealizedPnl>0?'green':data.unrealizedPnl<0?'red':''],
    ['Total P&L',   money(data.totalPnl),                            data.totalPnl>0?'green':data.totalPnl<0?'red':''],
    ['Wins',        data.wins||0,                                     'green'],
    ['Losses',      data.losses||0,                                   'red'],
    ['Win Rate',    data.winRate!=null ? data.winRate.toFixed(0)+'%' : '—', data.winRate>50?'green':''],
    ['Open',        (data.combos||[]).filter(c=>c.status==='open').length, 'blue'],
  ].map(([l,v,c]) => '<div class="kpi"><div class="label">'+l+'</div><div class="value '+(c||'')+'">'+v+'</div></div>').join('');

  /* equity */
  $('equityValue').textContent = cash(data.markValue);
  renderChart(data.equityCurve || []);

  /* strategy config */
  $('configGrid').innerHTML = [
    ['Strong side ≥',    data.config.strongThreshold.toFixed(2)],
    ['Weak side ≤',      data.config.weakThreshold.toFixed(2)],
    ['Trade window',     data.config.tradeWindow],
    ['Shares',           data.config.baseTradeShares + ' SH'],
    ['Entry',            'GTC@0.99 sweep'],
    ['Exit',             'Hold to resolution'],
    ['Combo type',       'Lagging side single leg'],
    ['Mark value',       cash(data.markValue)],
  ].map(r => '<div class="config-item">'+r[0]+'<b>'+r[1]+'</b></div>').join('');

  /* markets */
  const mktTick = lastTick && lastTick.windowStart === data.windowStart ? lastTick : null;
  renderMarkets(data.markets || [], mktTick);

  /* positions */
  renderPositions(data.combos || []);

  /* resolved */
  renderResults(data.resolvedCombos || []);

  /* feed */
  renderFeed(data.trades || []);

  /* logs */
  renderLogs();

  $('tickInfo').textContent = data.trackedTokens + ' TOKENS';
}

/* ─── Live Market Cards ─── */
function renderMarkets(markets, tickData) {
  if (!markets.length) {
    $('marketsGrid').innerHTML = '<div class="empty">Discovering current-window CLOB books…</div>';
    return;
  }
  $('marketsGrid').innerHTML = markets.map(m => {
    const upId  = m.asset.toUpperCase() + '_UP';
    const dnId  = m.asset.toUpperCase() + '_DN';
    const elapsed = Math.max(0, Math.floor(Date.now()/1000 - m.windowStart));
    const remaining = Math.max(0, m.windowEnd - Math.floor(Date.now()/1000));
    const upMid = m.up?.mid, upBid = m.up?.bid, upAsk = m.up?.ask, upSpread = m.up?.spread, upAge = m.up?.updatedAt;
    const dnMid = m.down?.mid, dnBid = m.down?.bid, dnAsk = m.down?.ask, dnSpread = m.down?.spread, dnAge = m.down?.updatedAt;

    function sideBlock(outcome, mid, bid, ask, spread, upd, id) {
      const signal = mid!=null && mid >= data_strong() ? 'green' : mid!=null && mid <= data_weak() ? 'red' : '';
      return '<div class="side">'
        + '<div class="side-label '+(outcome==='UP'?'up':'down')+'">'+outcome+'</div>'
        + '<div class="mid" id="mid-'+id+'">'+prc(mid)+'</div>'
        + '<div class="quote">Bid <span id="bid-'+id+'">'+prc(bid)+'</span> · Ask <span id="ask-'+id+'">'+prc(ask)+'</span></div>'
        + '<div><span class="spread-badge">Spread '+prc(spread)+'</span>'
        + '<span class="age-badge" id="age-'+id+'">'+(upd ? age(upd) : '—')+'</span></div>'
        + '</div>';
    }

    return '<div class="market-card">'
      + '<div class="market-top"><div><div class="asset-name">'+m.asset.toUpperCase()+'</div>'
      + '<div class="asset-slug">'+esc(m.slug)+'</div></div>'
      + '<div class="timer" id="timer-'+m.asset+'">'+clk(remaining)+'<small>T+'+elapsed+'s</small></div></div>'
      + '<div class="sides">'
      + sideBlock('UP', upMid, upBid, upAsk, upSpread, upAge, upId)
      + sideBlock('DOWN', dnMid, dnBid, dnAsk, dnSpread, dnAge, dnId)
      + '</div></div>';
  }).join('');
}

function data_strong() { return S?.config?.strongThreshold || 0.75; }
function data_weak()  { return S?.config?.weakThreshold  || 0.50; }

/* ─── Update live prices from tick (fast path) ─── */
function renderLivePrices(tick) {
  if (!tick || !tick.markets) return;
  for (const m of tick.markets) {
    const upId = m.asset.toUpperCase() + '_UP';
    const dnId = m.asset.toUpperCase() + '_DN';
    function updSide(outcome, token, id) {
      if (!token) return;
      const midEl = $('mid-'+id), bidEl = $('bid-'+id), askEl = $('ask-'+id), ageEl = $('age-'+id);
      if (midEl) midEl.textContent = prc(token.mid);
      if (bidEl) bidEl.textContent = prc(token.bid);
      if (askEl) askEl.textContent = prc(token.ask);
      if (ageEl && token.updatedAt) ageEl.textContent = age(token.updatedAt);
      /* recolor mid */
      if (midEl) {
        const v = Number(token.mid);
        midEl.className = 'mid ' + (v >= data_strong() ? 'green' : v <= data_weak() ? 'red' : '');
      }
    }
    updSide('UP', m.up, upId);
    updSide('DOWN', m.down, dnId);
    /* timer */
    if (m.windowEnd) {
      const remaining = Math.max(0, m.windowEnd - Math.floor(Date.now()/1000));
      const elapsed = Math.max(0, Math.floor(Date.now()/1000 - m.windowStart));
      const timerEl = $('timer-'+m.asset);
      if (timerEl) timerEl.innerHTML = clk(remaining)+'<small>T+'+elapsed+'s</small>';
    }
  }
}

/* ─── Floating Positions ─── */
function renderPositions(combos) {
  const open = combos.filter(c => c.status === 'open');
  $('openCount').textContent = open.length + ' OPEN';
  if (!open.length) {
    $('positionsGrid').innerHTML = '<div class="empty">No open positions — waiting for lagging side signal</div>';
    return;
  }
  $('positionsGrid').innerHTML = open.map(combo => {
    const unrealized = combo.unrealized || 0;
    const markVal = combo.markValue || combo.cost;
    const elapsed = combo.openedAt ? Math.floor((Date.now() - new Date(combo.openedAt).getTime())/1000) : 0;

    const legsHtml = (combo.legs||[]).map(leg => {
      const lMark = leg.shares * (leg.markPrice || leg.entryPrice);
      const lUnrl = leg.shares * ((leg.markPrice || leg.entryPrice) - leg.entryPrice);
      return '<div class="leg">'
        + '<div class="leg-top"><span class="tag '+(leg.outcome==='UP'?'tag-up':'tag-down')+'">'
        + leg.asset.toUpperCase()+' '+leg.outcome+'</span>'
        + '<span style="font-size:9px;color:#8fa3b7">'+leg.shares+' SH</span></div>'
        + '<div class="leg-metrics">'
        + '<div class="metric">ENTRY<b>'+prc(leg.entryPrice)+'</b></div>'
        + '<div class="metric">MARK<b id="mark-'+combo.id+'-'+leg.asset+'-'+leg.outcome+'">'+prc(leg.markPrice||leg.entryPrice)+'</b></div>'
        + '<div class="metric">VALUE<b>'+cash(lMark)+'</b></div>'
        + '<div class="metric">P&L<b class="'+tone(lUnrl)+'">'+money(lUnrl)+'</b></div>'
        + '</div></div>';
    }).join('');

    return '<div class="position-card">'
      + '<div class="pos-header"><div><div class="pos-name">'+esc(combo.name)+'</div>'
      + '<div class="pos-meta">'+esc(combo.slug||'')+' · T+'+elapsed+'s · strong '+prc(combo.strongPrice)+' lagging '+prc(combo.laggingPrice)+'</div></div>'
      + '<span class="pos-badge holding">HOLDING</span></div>'
      + '<div class="pos-pnl '+tone(unrealized)+'" id="floating-'+combo.id+'">'+money(unrealized)+'</div>'
      + '<div class="pos-meta">Mark: '+cash(markVal)+' · Cost: '+cash(combo.cost)+' · Fees: '+cash(combo.fees)+'</div>'
      + '<div class="legs">'+legsHtml+'</div>'
      + '<div class="combo-total">'
      + '<div class="metric">COST<b>'+cash(combo.cost)+'</b></div>'
      + '<div class="metric">MARK VALUE<b id="markval-'+combo.id+'">'+cash(markVal)+'</b></div>'
      + '<div class="metric">UNREALIZED<b id="unrealized-'+combo.id+'" class="'+tone(unrealized)+'">'+money(unrealized)+'</b></div>'
      + '<div class="metric">FEES<b>'+cash(combo.fees)+'</b></div>'
      + '</div></div>';
  }).join('');
}

/* ─── Fast-path floating P&L update from tick ─── */
function updateFloating() {
  if (!S) return;
  for (const combo of (S.combos||[]).filter(c=>c.status==='open')) {
    let totalMark = 0;
    for (const leg of combo.legs) {
      const markEl = $('mark-'+combo.id+'-'+leg.asset+'-'+leg.outcome);
      if (markEl) markEl.textContent = prc(leg.markPrice||leg.entryPrice);
      totalMark += leg.shares * (leg.markPrice || leg.entryPrice);
    }
    const unrl = totalMark - combo.cost - combo.fees;
    const floEl = $('floating-'+combo.id);
    if (floEl) { floEl.textContent = money(unrl); floEl.className = 'pos-pnl '+tone(unrl); }
    const mvEl = $('markval-'+combo.id);
    if (mvEl) mvEl.textContent = cash(totalMark);
    const uEl = $('unrealized-'+combo.id);
    if (uEl) { uEl.textContent = money(unrl); uEl.className = 'metric '+tone(unrl); }
  }
}

/* ─── Resolved ─── */
function renderResults(results) {
  if (!results.length) {
    $('resultsGrid').innerHTML = '<div class="empty">No resolved positions yet</div>';
    return;
  }
  $('resultsGrid').innerHTML = results.slice(0,20).map(r => {
    const icon = r.result==='WIN' ? '✅' : r.result==='LOSS' ? '❌' : '➖';
    return '<div class="result-card">'
      + '<div class="result-header"><div class="pos-name">'+esc(r.name)+'</div>'
      + '<span class="pos-badge '+(r.result==='WIN'?'won':'lost')+'">'+icon+' '+r.result+'</span></div>'
      + '<div class="result-pnl '+tone(r.pnl)+'">'+money(r.pnl)+'</div>'
      + '<div class="result-meta">Payout '+cash(r.payout)+' · Cost '+cash(r.cost)+' · Winners: '+esc(r.winner||'—')+'</div>'
      + '</div>';
  }).join('');
}

/* ─── Trade Feed ─── */
function renderFeed(trades) {
  $('tradeCount').textContent = (trades||[]).length + ' TRADES';
  if (!trades||!trades.length) {
    $('feedGrid').innerHTML = '<div class="empty">Waiting for lagging side entries…</div>';
    return;
  }
  $('feedGrid').innerHTML = trades.slice(0,40).map(t => {
    return '<div class="feed-item">'
      + '<div class="feed-time">'+new Date(t.timestamp).toLocaleTimeString()+' · '+esc(t.combo)+'</div>'
      + '<div class="feed-main"><span class="tag '+(t.outcome==='UP'?'tag-up':'tag-down')+'">'+t.asset.toUpperCase()+' '+t.outcome+'</span> '
      + num(t.shares)+' SH @ '+prc(t.price)+'</div>'
      + '<div class="feed-detail">Strong '+prc(t.signal?.strong)+' Lagging '+prc(t.signal?.lagging)+' · '+cash(t.cost)+'</div>'
      + '</div>';
  }).join('');
}

/* ─── Chart ─── */
function renderChart(curve) {
  const svg = $('equityChart');
  if (!curve || !curve.length) { svg.innerHTML=''; return; }
  const vals = curve.map(p=>p.equity), lo=Math.min(...vals), hi=Math.max(...vals), rng=(hi-lo)||1;
  const W=700, H=160, P=14;
  const pts = curve.map((p,i) => [i/Math.max(1,curve.length-1)*W, H-P-(p.equity-lo)/rng*(H-P*2)]);
  const path = 'M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');
  const last = pts.at(-1)||[0,H/2];
  const color = S && S.totalPnl>=0 ? '#15ff9c' : '#ff4a68';
  svg.innerHTML = '<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5"/>'
    + '<circle cx="'+last[0]+'" cy="'+last[1]+'" r="4" fill="'+color+'"/>';
}

/* ─── Logs ─── */
function renderLogs() {
  const panel = $('logsPanel');
  const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 60;
  $('logCount').textContent = logs.length;
  panel.innerHTML = logs.slice(-300).map(line => {
    let cls = '';
    if (line.includes('BUY')) cls = 'log-info';
    else if (line.includes('WIN')) cls = 'log-win';
    else if (line.includes('LOSS') || line.includes('⚠️')) cls = 'log-loss';
    return '<div class="log '+cls+'">'+esc(line)+'</div>';
  }).join('');
  if (nearBottom) panel.scrollTop = panel.scrollHeight;
}

/* ─── Refresh loop: live prices + floating P&L at 50ms ─── */
setInterval(() => safe(() => {
  if (lastTick && S && lastTick.windowStart === S.windowStart && Date.now()-lastRender >= 50) {
    renderLivePrices(lastTick);
    updateFloating();
    lastRender = Date.now();
  }
}), 50);

</script>
</body>
</html>`;

// ─── Routes ──────────────────────────────────────────────────
app.get('/healthz', (_, res) => res.sendStatus(200));
app.get('/api/status', (_, res) => res.json(engine.buildState()));
app.get('/', (_, req) => req.type('html').send(dashboard));

io.on('connection', (socket) => socket.emit('state', engine.buildState()));
setInterval(() => io.emit('state', engine.buildState()), 250);

server.listen(port, '0.0.0.0', () => {
  console.log(`CorrelBot dashboard listening on :${port}`);
  engine.init().catch((err) => console.error(`Init failure: ${err.message}`));
});
