'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { BotEngine, loadEquityFile } = require('./engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const port = process.env.PORT || 8080;
const EQUITY_FILE = process.env.EQUITY_FILE || path.join(__dirname, 'equity.json');
const initialEquity = loadEquityFile(EQUITY_FILE);

const engine = new BotEngine({
  initialEquity,
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
<title>CorrelBot — 0.30 Engine</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{color-scheme:dark}
body{background:#000;color:#e0e6ed;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;padding:12px}
.shell{max-width:1540px;margin:auto}

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

.kpis{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:6px;margin-bottom:10px}
.kpi{background:#060a0f;border:1px solid #16232f;border-radius:12px;padding:10px 12px}
.kpi .label{font-size:8px;text-transform:uppercase;color:#667e94;letter-spacing:.6px}
.kpi .value{font-size:18px;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi .small{font-size:8px;color:#617589;margin-top:2px}

.panel{background:#060a0f;border:1px solid #16232f;border-radius:13px;overflow:hidden;margin-bottom:10px}
.panel-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #14202c;font-size:11px;color:#8ea2b6}
.panel-head strong{font-size:11px}
.panel-body{padding:10px}

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
.age-badge{display:inline-block;font-size:7px;color:#7788;margin-left:4px}

.config-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;padding:10px}
.config-item{background:#080f18;border-radius:9px;padding:8px 10px;font-size:8px;color:#657b91}
.config-item b{display:block;font-size:11px;color:#fff;margin-top:3px}

.positions{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:10px}
.position-card{background:#060a0f;border:1px solid #16232f;border-radius:12px;padding:12px}
.pos-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.pos-name{font-size:14px;font-weight:800}
.pos-badge{font-size:8px;border-radius:99px;padding:3px 8px;font-weight:700}
.pos-badge.holding{color:#38d6ff;border:1px solid #38d6ff44;background:#38d6ff10}
.pos-badge.won{color:#00ff9d;border:1px solid #00ff9d44;background:#00ff9d10}
.pos-badge.lost{color:#ff5566;border:1px solid #ff556644;background:#ff556610}
.pos-meta{font-size:8px;color:#617589;margin-top:2px}
.pos-pnl{font-size:18px;margin-top:4px;font-variant-numeric:tabular-nums;font-weight:800}
.legs{display:grid;gap:6px;margin-top:8px}
.leg{background:#05090f;border:1px solid #12202c;border-radius:9px;padding:8px 10px}
.leg-top{display:flex;justify-content:space-between;align-items:center}
.tag{border-radius:6px;padding:2px 6px;font-size:9px;font-weight:700}
.tag-up{color:#28e0a5;background:#28e0a515;border:1px solid #28e0a533}
.tag-down{color:#ff6b81;background:#ff6b8115;border:1px solid #ff6b8133}
.leg-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:6px}
.metric{background:#080f18;border-radius:7px;padding:5px 6px;font-size:8px;color:#677d92}
.metric b{display:block;font-size:11px;color:#fff;margin-top:1px}

.results-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:10px}
.result-card{background:#060a0f;border:1px solid #16232f;border-radius:12px;padding:12px}
.result-header{display:flex;justify-content:space-between;align-items:center}
.result-pnl{font-size:18px;margin-top:4px;font-variant-numeric:tabular-nums}
.result-meta{font-size:8px;color:#617589;margin-top:2px}

.feeds{display:grid;gap:6px;padding:10px}
.feed-item{background:#080f18;border-radius:9px;padding:8px 10px;border:1px solid #152430}
.feed-time{font-size:8px;color:#556677}
.feed-main{font-size:11px;margin-top:3px}
.feed-detail{font-size:8px;color:#617589;margin-top:2px}

.chart{height:160px;padding:8px}
svg{width:100%;height:100%}

.logs{height:220px;overflow:auto;background:#010407;border-radius:10px;padding:8px;font-family:SFMono-Regular,Consolas,monospace;font-size:9px;font-weight:500;-webkit-overflow-scrolling:touch}
.log{white-space:pre-wrap;color:#95a7b9;padding:1px 0}
.log-info{color:#38d6ff}
.log-win{color:#00ff9d}
.log-loss{color:#ff4a68}
.empty{padding:20px;text-align:center;color:#445467;font-size:11px}

/* ── Side Martingale Strip ── */
.mg-strip{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px}
.mg-card{background:#08111c;border:1px solid #22364b;border-radius:10px;padding:12px}
.mg-card.up{border-left:3px solid #28e0a5}
.mg-card.down{border-left:3px solid #ff6b81}
.mg-name{font-size:12px;font-weight:800}
.mg-row{display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:#9fb1c4}
.mg-row b{font-size:16px;color:#fff;font-variant-numeric:tabular-nums}
.mg-badge{font-size:9px;border-radius:99px;padding:2px 8px;font-weight:700}
.mg-badge.ready{color:#00ff9d;border:1px solid #00ff9d44;background:#00ff9d10}
.mg-badge.losses{color:#ff5566;border:1px solid #ff556644;background:#ff556610}

/* ── Engine Tower ── */
.engine-shell{border-radius:15px;overflow:hidden;margin-bottom:12px;border:1px solid #16232f;border-top:3px solid #38d6ff}
.engine-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;background:#070d14;border-bottom:1px solid #14202c;flex-wrap:wrap}
.engine-name{font-size:14px;font-weight:800;letter-spacing:.2px}
.engine-name .chip{display:inline-block;border-radius:8px;padding:2px 8px;font-size:10px;margin-right:8px;vertical-align:2px;color:#38d6ff;background:#38d6ff15;border:1px solid #38d6ff44}
.engine-sub{font-size:8px;color:#6b8095;margin-top:3px}
.engine-stats{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.estat{background:#08111c;border:1px solid #22364b;border-radius:9px;padding:6px 10px;text-align:center;min-width:70px}
.estat .l{font-size:7px;color:#667e94;text-transform:uppercase;letter-spacing:.5px}
.estat .v{font-size:13px;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums}
.engine-body{background:#050a0f}
.engine-body .block-title{font-size:9px;color:#7f93a8;text-transform:uppercase;letter-spacing:.7px;padding:8px 14px 0}

/* ── Colors ── */
.green{color:#00ff9d!important}
.red{color:#ff4a68!important}
.blue{color:#38d6ff!important}
.gold{color:#ffd166!important}
.warn{color:#ffc861!important}
.white{color:#fff!important}

@media(max-width:1100px){.two-col,.mg-strip{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(5,1fr)}.markets,.positions,.results-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">

  <header class="topbar">
    <div class="brand">
      <div class="brand-icon">⚡</div>
      <div>
        <h1>CorrelBot</h1>
        <div class="sub">0.30 both-side maker limit · per-side martingale 1.5× · no SL · TP=resolution · lifetime equity</div>
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

  <!-- Top strip: live BTC prices -->
  <div class="panel">
    <div class="strip" style="display:flex;gap:12px;align-items:stretch;padding:10px;flex-wrap:wrap">
      <div style="display:flex;gap:20px;padding-right:12px;border-right:1px solid #14202c">
        <div>
          <div class="side-label up">BTC 5M UP</div>
          <div class="sp-value" style="font-size:30px;font-weight:800;font-variant-numeric:tabular-nums" id="stripUp">—</div>
          <div class="quote" id="stripUpQuote">bid — · ask —</div>
        </div>
        <div>
          <div class="side-label down">BTC 5M DOWN</div>
          <div class="sp-value" style="font-size:30px;font-weight:800;font-variant-numeric:tabular-nums" id="stripDown">—</div>
          <div class="quote" id="stripDownQuote">bid — · ask —</div>
        </div>
      </div>
      <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap" id="stripMg">
        <div class="empty">Waiting for window data…</div>
      </div>
    </div>
  </div>

  <!-- KPIs -->
  <section class="kpis" id="kpis"></section>

  <!-- Equity + Config -->
  <div class="two-col">
    <div class="panel">
      <div class="panel-head"><span>📈 Equity Curve (lifetime)</span><strong id="equityValue">—</strong></div>
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

  <!-- Side martingale state -->
  <div class="panel">
    <div class="panel-head"><span>🎰 Per-Side Martingale</span><strong>INDEPENDENT UP / DOWN</strong></div>
    <div class="mg-strip" id="mgStrip"></div>
  </div>

  <!-- Engine tower -->
  <div class="engine-shell">
    <div class="engine-head">
      <div>
        <div class="engine-name"><span class="chip">ENGINE</span>0.30 Both-Side Maker</div>
        <div class="engine-sub" id="engSub">Limit both sides @0.30 · independent UP/DOWN martingale · no SL · TP=resolution</div>
      </div>
      <div class="engine-stats" id="engStats"></div>
    </div>
    <div class="engine-body">
      <div class="block-title">Positions (Floating P&L) · <span id="engOpenCount">0 OPEN</span></div>
      <div class="positions" id="engPositions"></div>
      <div class="block-title">Resolved · <span id="engCounts">0</span></div>
      <div class="results-grid" id="engResults"></div>
      <div class="block-title">Trade Feed · <span id="engTradeCount">0 TRADES</span></div>
      <div class="feeds" id="engFeed"></div>
      <div class="block-title">Logs · <span id="engLogCount">0</span></div>
      <div class="logs" id="engLogs"></div>
    </div>
  </div>

</div>

<script src="/socket.io/socket.io.js"></script>
<script>
let S = null;
let lastTick = null;
let lastRender = 0;
let msgCount = 0, lastRateTime = Date.now(), rate = 0;
const $ = id => document.getElementById(id);

function safe(fn) { try { fn() } catch(e) { console.error(e) } }

const num  = v => Number(v||0).toLocaleString(undefined, {maximumFractionDigits:2});
const cash = v => '$' + Number(v||0).toFixed(2);
const money = v => { if (v==null) return '—'; const n=Number(v); return (n>0?'+$':n<0?'-$':'$') + Math.abs(n).toFixed(2); };
const tone = v => Number(v)>0 ? 'green' : Number(v)<0 ? 'red' : '';
const prc  = v => v==null ? '—' : Number(v).toFixed(3);
const clk  = s => { s=Math.max(0,Math.floor(s)); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); };
const esc  = x => String(x||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const age  = ms => { const s=Math.floor((Date.now()-ms)/1000); return s<=0?'now':s<60?s+'s':Math.floor(s/60)+'m'; };

const socket = io({ transports:['polling'], upgrade:false, reconnectionDelay:250, reconnectionDelayMax:1000, timeout:3000 });

socket.on('connect', () => { $('pConnection').textContent='LIVE'; $('pConnection').className='pill live'; });
socket.on('disconnect', () => { $('pConnection').textContent='RETRY'; $('pConnection').className='pill warn'; });
socket.on('tick', data => {
  if (!data || !data.windowStart) return;
  lastTick = data;
  if (data.messageCount!=null) { const now=Date.now(); if (now-lastRateTime>1000){rate=data.messageCount-msgCount;msgCount=data.messageCount;lastRateTime=now;} }
  if (Date.now()-lastRender >= 80) { safe(()=>renderLivePrices(data)); lastRender=Date.now(); }
});
socket.on('state', data => safe(()=>render(data)));

async function pollState() {
  try {
    const r = await fetch('/api/status');
    render(await r.json());
  } catch(e) { $('pConnection').textContent='RETRY'; $('pConnection').className='pill warn'; }
}
pollState();
setInterval(pollState, 1000);

function render(data) {
  if (S && S.windowStart !== data.windowStart) { lastTick = null; }
  S = data;

  $('pUptime').textContent = clk(data.uptime);
  $('pRate').textContent = rate + ' msg/s';
  $('pTokens').textContent = data.trackedTokens + ' TK';
  const clob = $('pClob');
  clob.textContent = data.connected ? 'CLOB LIVE' : 'CLOB POLL';
  clob.className = 'pill ' + (data.connected ? 'live' : 'warn');

  $('kpis').innerHTML = [
    ['Bankroll',    cash(data.bankroll), 'white'],
    ['Realized P&L',money(data.realizedPnl), data.realizedPnl>0?'green':data.realizedPnl<0?'red':''],
    ['Unrealized',  money(data.unrealizedPnl), data.unrealizedPnl>0?'green':data.unrealizedPnl<0?'red':''],
    ['Total P&L',   money(data.totalPnl), data.totalPnl>0?'green':data.totalPnl<0?'red':''],
    ['Wins',        data.wins||0, 'green'],
    ['Losses',      data.losses||0, 'red'],
    ['Win Rate',    data.winRate!=null ? data.winRate.toFixed(0)+'%' : '—', data.winRate>50?'green':''],
    ['Open',        (data.positions||[]).filter(p=>p.status==='open').length, 'blue'],
    ['Rebate est.', cash(data.makerRebateAccrued||0), (data.makerRebateAccrued||0)>0?'gold':'white'],
    ['Max DD',      cash(data.maxDrawdown||0), data.maxDrawdown>2000?'red':(data.maxDrawdown>0?'warn':'white')],
  ].map(([l,v,c]) => '<div class="kpi"><div class="label">'+l+'</div><div class="value '+(c||'')+'">'+v+'</div></div>').join('');

  $('equityValue').textContent = cash(data.markValue);
  renderChart(data.equityCurve || []);

  $('configGrid').innerHTML = [
    ['Limit price',    data.config.limitPrice.toFixed(2)],
    ['Base shares',    data.config.baseShares + ' SH per side'],
    ['Martingale',     data.config.multiplier.toFixed(1) + 'x per side'],
    ['TP',             'Resolution'],
    ['Stop loss',      'None'],
    ['Maker fee',      data.config.makerFeeRate + ' (limit/free)'],
    ['Taker fee rate', data.config.takerFeeRate.toFixed(2)],
    ['Maker rebate',   ((data.config.makerRebateRate||0.2)*100).toFixed(0)+'% of fee-equiv'],
  ].map(r => '<div class="config-item">'+r[0]+'<b>'+r[1]+'</b></div>').join('');

  renderLivePrices({ markets: data.markets || [], windowStart: data.windowStart });
  renderMarkets(data.markets || [], lastTick && lastTick.windowStart === data.windowStart ? lastTick : null);
  renderTopStrip(data);
  renderMgStrip(data);
  renderEngines(data);
  $('tickInfo').textContent = data.trackedTokens + ' TOKENS';
}

function renderTopStrip(data) {
  const mkt = (data.markets||[])[0];
  if (mkt) {
    if (mkt.up) {
      $('stripUp').textContent = prc(mkt.up.mid);
      $('stripUp').className = 'sp-value ' + (Number(mkt.up.mid)>=0.68?'green':'');
      $('stripUpQuote').textContent = 'bid '+prc(mkt.up.bid)+' · ask '+prc(mkt.up.ask);
    }
    if (mkt.down) {
      $('stripDown').textContent = prc(mkt.down.mid);
      $('stripDown').className = 'sp-value ' + (Number(mkt.down.mid)>=0.68?'green':'');
      $('stripDownQuote').textContent = 'bid '+prc(mkt.down.bid)+' · ask '+prc(mkt.down.ask);
    }
  }
  const open = (data.positions||[]).filter(p => p.status === 'open');
  const grid = $('stripMg');
  if (!open.length) {
    grid.innerHTML = '<div class="empty">No open positions this window</div>';
    return;
  }
  grid.innerHTML = open.slice(0,8).map(pos => {
    const unrealized = pos.unrealized || 0;
    const badge = pos.outcome === 'UP' ? 'tag-up' : 'tag-down';
    return '<div style="background:#08111c;border:1px solid #22364b;border-radius:10px;padding:10px;min-width:180px">'
      + '<div><span class="tag '+badge+'">'+pos.outcome+'</span> <b style="font-size:13px">'+pos.shares+' SH @ '+prc(pos.entryPrice)+'</b></div>'
      + '<div style="font-size:20px;font-weight:800;color:'+(unrealized>=0?'#00ff9d':'#ff4a68')+'">'+money(unrealized)+'</div>'
      + '<div style="font-size:9px;color:#7f93a8">Martingale #'+pos.martingaleIndex+' · Mark '+prc(pos.markPrice||pos.entryPrice)+'</div>'
      + '</div>';
  }).join('');
}

function renderMgStrip(data) {
  const mg = data.martingale || {};
  const up = mg['btc:UP'] || { shares: data.config.baseShares, losses: 0 };
  const dn = mg['btc:DOWN'] || { shares: data.config.baseShares, losses: 0 };
  $('mgStrip').innerHTML = mgCard('UP', up) + mgCard('DOWN', dn);
  function mgCard(outcome, st) {
    const cls = outcome === 'UP' ? 'up' : 'down';
    const badge = st.losses > 0 ? '<span class="mg-badge losses">'+st.losses+' LOSS(ES)</span>' : '<span class="mg-badge ready">READY</span>';
    return '<div class="mg-card '+cls+'">'
      + '<div class="mg-name">'+outcome+' — Independent Martingale</div>'+badge
      + '<div class="mg-row"><span>Next bet</span><b>'+st.shares+' SH</b></div>'
      + '<div class="mg-row"><span>Loss streak</span><b>'+st.losses+'</b></div>'
      + '<div class="mg-row"><span>Entry</span><b>@'+prc(data.config.limitPrice)+' limit</b></div>'
      + '</div>';
  }
}

function renderMarkets(markets, tickData) {
  if (!markets.length) { $('marketsGrid').innerHTML = '<div class="empty">Discovering current-window CLOB books…</div>'; return; }
  $('marketsGrid').innerHTML = markets.map(m => {
    const upId = m.asset.toUpperCase()+'_UP', dnId = m.asset.toUpperCase()+'_DN';
    const remaining = Math.max(0, m.windowEnd - Math.floor(Date.now()/1000));
    const elapsed = Math.max(0, Math.floor(Date.now()/1000 - m.windowStart));
    function sideBlock(outcome, token, id) {
      return '<div class="side">'
        + '<div class="side-label '+(outcome==='UP'?'up':'down')+'">'+outcome+'</div>'
        + '<div class="mid" id="mid-'+id+'">'+prc(token?.mid)+'</div>'
        + '<div class="quote">Bid <span id="bid-'+id+'">'+prc(token?.bid)+'</span> · Ask <span id="ask-'+id+'">'+prc(token?.ask)+'</span></div>'
        + '<div><span class="spread-badge">Spread '+prc(token?.spread)+'</span><span class="age-badge" id="age-'+id+'">'+(token?.updatedAt?age(token.updatedAt):'—')+'</span></div>'
        + '</div>';
    }
    return '<div class="market-card">'
      + '<div class="market-top"><div><div class="asset-name">'+m.asset.toUpperCase()+'</div><div class="asset-slug">'+esc(m.slug)+'</div></div>'
      + '<div class="timer" id="timer-'+m.asset+'">'+clk(remaining)+'<small>T+'+elapsed+'s</small></div></div>'
      + '<div class="sides">'+sideBlock('UP', m.up, upId)+sideBlock('DOWN', m.down, dnId)+'</div>'
      + '</div>';
  }).join('');
}

function renderLivePrices(tick) {
  if (!tick || !tick.markets) return;
  for (const m of tick.markets) {
    const upId = m.asset.toUpperCase()+'_UP', dnId = m.asset.toUpperCase()+'_DN';
    function upd(outcome, token, id) {
      if (!token) return;
      const midEl=$('mid-'+id), bidEl=$('bid-'+id), askEl=$('ask-'+id), ageEl=$('age-'+id);
      if (midEl) midEl.textContent = prc(token.mid);
      if (bidEl) bidEl.textContent = prc(token.bid);
      if (askEl) askEl.textContent = prc(token.ask);
      if (ageEl && token.updatedAt) ageEl.textContent = age(token.updatedAt);
      if (midEl) midEl.className = 'mid ' + (Number(token.mid)>=0.68?'green':'');
    }
    upd('UP', m.up, upId);
    upd('DOWN', m.down, dnId);
    if (m.windowEnd && m.asset==='btc') {
      const remaining = Math.max(0, m.windowEnd - Math.floor(Date.now()/1000));
      const elapsed = Math.max(0, Math.floor(Date.now()/1000 - m.windowStart));
      const tEl = $('timer-'+m.asset);
      if (tEl) tEl.innerHTML = clk(remaining)+'<small>T+'+elapsed+'s</small>';
      if (m.up) { $('stripUp').textContent = prc(m.up.mid); $('stripUpQuote').textContent = 'bid '+prc(m.up.bid)+' · ask '+prc(m.up.ask); }
      if (m.down) { $('stripDown').textContent = prc(m.down.mid); $('stripDownQuote').textContent = 'bid '+prc(m.down.bid)+' · ask '+prc(m.down.ask); }
    }
  }
}

function statsBox(label, value, color) {
  return '<div class="estat"><div class="l">'+label+'</div><div class="v '+(color||'')+'">'+value+'</div></div>';
}

function renderEngines(data) {
  $('engSub').textContent = 'Limit both sides @'+data.config.limitPrice.toFixed(2)+' · independent UP/DOWN martingale · no SL · TP=resolution';
  $('engStats').innerHTML =
    statsBox('Bankroll', cash(data.bankroll), 'white')
    + statsBox('Realized', money(data.realizedPnl), data.realizedPnl>0?'green':data.realizedPnl<0?'red':'')
    + statsBox('W / L', (data.wins||0)+'/'+(data.losses||0), '')
    + statsBox('Win%', data.winRate!=null ? data.winRate.toFixed(0)+'%' : '—', '')
    + statsBox('Open', (data.positions||[]).filter(p=>p.status==='open').length, 'blue')
    + statsBox('Rebate est.', cash(data.makerRebateAccrued||0), 'gold')
    + statsBox('Max Streak', data.maxConsecutiveLosses||0, '');

  renderPositions(data.positions || [], $('engPositions'), $('engOpenCount'));
  renderResults(data.resolvedPositions || [], $('engResults'));
  $('engCounts').textContent = (data.resolvedPositions||[]).length + ' settled';
  renderFeed(data.trades || [], $('engFeed'), $('engTradeCount'));
  renderLogs($('engLogs'), $('engLogCount'), data.logs || []);
}

function renderPositions(positions, grid, counter) {
  const open = positions.filter(p => p.status === 'open');
  counter.textContent = open.length + ' OPEN';
  if (!open.length) { grid.innerHTML = '<div class="empty">No open positions — waiting for ask ≤ '+prc(S?.config?.limitPrice)+'</div>'; return; }
  grid.innerHTML = open.map(pos => {
    const unrealized = pos.unrealized || 0;
    const markVal = pos.markValue || pos.cost;
    const elapsed = pos.openedAt ? Math.floor((Date.now() - new Date(pos.openedAt).getTime())/1000) : 0;
    const badge = pos.outcome === 'UP' ? 'tag-up' : 'tag-down';
    return '<div class="position-card">'
      + '<div class="pos-header"><div><div class="pos-name">⚡ '+pos.outcome+' <span class="tag '+badge+'">'+esc(pos.asset.toUpperCase())+'</span></div>'
      + '<div class="pos-meta">'+esc(pos.slug||'')+' · T+'+elapsed+'s · Martingale #'+pos.martingaleIndex+'</div></div>'
      + '<span class="pos-badge holding">HOLDING</span></div>'
      + '<div class="pos-pnl '+tone(unrealized)+'" id="floating-'+pos.id+'">'+money(unrealized)+'</div>'
      + '<div class="pos-meta">Mark '+cash(markVal)+' · Cost '+cash(pos.cost)+' · no SL</div>'
      + '<div class="legs"><div class="leg">'
      + '<div class="leg-top"><span class="tag '+badge+'">'+pos.outcome+'</span><span style="font-size:9px;color:#8fa3b7">'+pos.shares+' SH</span></div>'
      + '<div class="leg-metrics">'
      + '<div class="metric">ENTRY<b>'+prc(pos.entryPrice)+'</b></div>'
      + '<div class="metric">MARK<b id="mark-'+pos.id+'">'+prc(pos.markPrice||pos.entryPrice)+'</b></div>'
      + '<div class="metric">VALUE<b>'+cash(pos.shares*(pos.markPrice||pos.entryPrice))+'</b></div>'
      + '<div class="metric">P&L<b class="'+tone(unrealized)+'">'+money(unrealized)+'</b></div>'
      + '</div></div></div>'
      + '</div>';
  }).join('');
}

function updateFloating() {
  if (!S) return;
  for (const pos of (S.positions||[]).filter(p=>p.status==='open')) {
    const markEl = $('mark-'+pos.id);
    if (markEl) markEl.textContent = prc(pos.markPrice||pos.entryPrice);
    const unrl = pos.unrealized || 0;
    const floEl = $('floating-'+pos.id);
    if (floEl) { floEl.textContent = money(unrl); floEl.className = 'pos-pnl '+tone(unrl); }
  }
}

function renderResults(results, grid) {
  if (!results.length) { grid.innerHTML = '<div class="empty">No resolved bets yet</div>'; return; }
  grid.innerHTML = results.slice(0,20).map(r => {
    const won = r.won === true;
    const icon = won ? '✅' : '❌';
    const label = won ? 'WIN' : 'LOSS';
    return '<div class="result-card">'
      + '<div class="result-header"><div class="pos-name">⚡ '+esc((r.asset||'').toUpperCase())+' '+(r.outcome||'')+' · '+(r.martingaleIndex||0)+'</div>'
      + '<span class="pos-badge '+(won?'won':'lost')+'">'+icon+' '+label+'</span></div>'
      + '<div class="result-pnl '+tone(r.pnl)+'">'+money(r.pnl)+'</div>'
      + '<div class="result-meta">Payout '+cash(r.payout)+' · Cost '+cash(r.cost)+'</div>'
      + '</div>';
  }).join('');
}

function renderFeed(trades, grid, counter) {
  counter.textContent = (trades||[]).length + ' TRADES';
  if (!trades||!trades.length) { grid.innerHTML = '<div class="empty">No trades yet</div>'; return; }
  grid.innerHTML = trades.slice(0,40).map(t => {
    return '<div class="feed-item">'
      + '<div class="feed-time">'+new Date(t.timestamp).toLocaleTimeString()+' · '+esc(t.asset.toUpperCase())+' '+(t.outcome||'')+'</div>'
      + '<div class="feed-main"><span class="tag '+(t.outcome==='UP'?'tag-up':'tag-down')+'">'+t.asset.toUpperCase()+' '+t.outcome+'</span> '
      + num(t.shares)+' SH @ '+prc(t.price)+'</div>'
      + '<div class="feed-detail">'+cash(t.cost)+' · rebate est. '+cash(t.rebateEstimate||0)+'</div>'
      + '</div>';
  }).join('');
}

function renderLogs(panel, countEl, arr) {
  countEl.textContent = arr.length + ' LINES';
  panel.innerHTML = arr.slice(-300).map(line => {
    let cls = '';
    if (line.includes('WIN')) cls = 'log-win';
    else if (line.includes('LOSS') || line.includes('⚠️')) cls = 'log-loss';
    else if (line.includes('FILLED') || line.includes('LIMIT')) cls = 'log-info';
    return '<div class="log '+cls+'">'+esc(line)+'</div>';
  }).join('');
}

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
