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
  onTick: (markets, messageCount) => io.emit('tick', { t: Date.now(), windowStart: markets[0]?.windowStart ?? null, messageCount, markets }),
  onLog: (line) => { console.log(line); io.emit('log', line); },
});

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
.kpis{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:6px;margin-bottom:10px}
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
.config-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;padding:10px}
.config-item{background:#080f18;border-radius:9px;padding:8px 10px;font-size:8px;color:#657b91}
.config-item b{display:block;font-size:11px;color:#fff;margin-top:3px}
.positions{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:10px}
.position-card{background:#060a0f;border:1px solid #16232f;border-radius:12px;padding:12px}
.pos-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.pos-name{font-size:14px;font-weight:800}
.pos-badge{font-size:8px;border-radius:99px;padding:3px 8px;font-weight:700}
.pos-badge.holding{color:#38d6ff;border:1px solid #38d6ff44;background:#38d6ff10}
.pos-badge.tp{color:#ffd166;border:1px solid #ffd16644;background:#ffd16610}
.pos-badge.won{color:#00ff9d;border:1px solid #00ff9d44;background:#00ff9d10}
.pos-badge.lost{color:#ff5566;border:1px solid #ff556644;background:#ff556610}
.pos-meta{font-size:8px;color:#617589;margin-top:2px}
.pos-pnl{font-size:18px;margin-top:4px;font-variant-numeric:tabular-nums;font-weight:800}
.pos-tp-row{display:flex;gap:6px;margin-top:6px}
.pos-tp{background:#ffd16610;border:1px solid #ffd16633;border-radius:8px;padding:6px 8px;font-size:8px;color:#ffd166;flex:1}
.pos-tp b{display:block;font-size:10px;color:#fff;margin-top:2px}
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
.tag{border-radius:6px;padding:2px 6px;font-size:9px;font-weight:700}
.tag-up{color:#28e0a5;background:#28e0a515;border:1px solid #28e0a533}
.tag-down{color:#ff6b81;background:#ff6b8115;border:1px solid #ff6b8133}
.tag-tp{color:#ffd166;background:#ffd16615;border:1px solid #ffd16633}
.log-grid{display:grid;gap:2px;padding:10px}
.log{font-family:'SF Mono',ui-monospace,monospace;font-size:9px;padding:3px 8px;border-radius:6px;background:#080f18;color:#7f93a8}
.log-win{color:#00ff9d;background:#00ff9d08}
.log-loss{color:#ff5566;background:#ff556608}
.log-info{color:#38d6ff;background:#38d6ff08}
.log-tp{color:#ffd166;background:#ffd16608}
.chart{height:160px;padding:8px}
svg{width:100%;height:100%}
.empty{font-size:10px;color:#3d4f60;text-align:center;padding:20px}
</style>
</head>
<body>
<div class="shell">
  <div class="topbar">
    <div class="brand">
      <div class="brand-icon">📊</div>
      <div>
        <h1>CorrelBot</h1>
        <div class="sub">BTC 5m Binary · 0.30 Both-Side Limit · Cancel Opposite · TP@0.75 Half · 1.5× Martingale</div>
      </div>
    </div>
    <div class="pills">
      <div class="pill live" id="statusPill">● CONNECTING</div>
      <div class="pill" id="tickPill">ticks 0</div>
      <div class="pill blue" id="uptimePill">00:00:00</div>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="label">Bankroll</div><div class="value" id="bankroll">$20,000</div></div>
    <div class="kpi"><div class="label">Mark Value</div><div class="value" id="markValue">$20,000</div></div>
    <div class="kpi"><div class="label">Total P&L</div><div class="value" id="totalPnl">$0</div></div>
    <div class="kpi"><div class="label">Realized</div><div class="value" id="realizedPnl">$0</div></div>
    <div class="kpi"><div class="label">Wins / Losses</div><div class="value" id="winLoss">0 / 0</div><div class="small" id="winRate"></div></div>
    <div class="kpi"><div class="label">Consec Losses</div><div class="value" id="consecLoss">0</div><div class="small" id="maxConsecLoss">max 0</div></div>
    <div class="kpi"><div class="label">Max Drawdown</div><div class="value" id="maxDrawdown">$0</div></div>
    <div class="kpi"><div class="label">Maker Rebate</div><div class="value" id="rebate">$0</div></div>
    <div class="kpi"><div class="label">Strategy</div><div class="value" style="font-size:9px;color:#8fa3b7;line-height:1.4">Limit 0.30 both<br>Cancel opposite<br>TP 0.75 half<br>1.5× mg next window</div></div>
  </div>

  <div class="two-col">
    <div>
      <div class="panel">
        <div class="panel-head"><strong>Live Market</strong><span id="windowCount"></span></div>
        <div class="markets" id="marketsContainer"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><strong>Open Positions</strong><span id="posCount"></span></div>
        <div class="positions" id="positionsContainer"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><strong>Resolved</strong><span id="resCount"></span></div>
        <div class="results-grid" id="resolvedContainer"></div>
      </div>
    </div>
    <div>
      <div class="panel">
        <div class="panel-head"><strong>Config</strong></div>
        <div class="config-grid" id="configGrid"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><strong>Equity Curve</strong></div>
        <div class="chart"><svg id="equityChart"></svg></div>
      </div>
      <div class="panel">
        <div class="panel-head"><strong>Trade Feed</strong><span id="feedCount"></span></div>
        <div class="panel-body" style="max-height:320px;overflow-y:auto">
          <div class="feeds" id="feedContainer"></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><strong>Logs</strong><span id="logCount"></span></div>
        <div class="panel-body" style="max-height:320px;overflow-y:auto">
          <div class="log-grid" id="logContainer"></div>
        </div>
      </div>
    </div>
  </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
const $=id=>document.getElementById(id);
const S={};
let lastTick=null,lastRender=0;

function esc(s){return String(s).replace(/[&<>"]/g,c=>({'+':'&#43;','&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function money(n){n=n||0;return(n>=0?'+':'')+('$'+Math.abs(n).toFixed(2))}
function cash(n){return'$'+Number(n||0).toFixed(2)}
function num(n){return Number(n||0).toLocaleString()}
function prc(n){return n!=null?Number(n).toFixed(3):'—'}
function tone(n){return n>=0?'color:#00ff9d':'color:#ff5566'}

function uptimeFmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0')}

function renderMarkets(markets) {
  const c=$('marketsContainer');
  if(!markets||!markets.length){c.innerHTML='<div class="empty">Waiting for market discovery...</div>';return}
  c.innerHTML=markets.map(m=>{
    const remaining=m.remaining||0;
    const upMid=m.up.mid!=null?prc(m.up.mid):'—';
    const dnMid=m.down.mid!=null?prc(m.down.mid):'—';
    return '<div class="market-card">'
      +'<div class="market-top"><div><div class="asset-name">'+esc(m.asset.toUpperCase())+' 5m</div>'
      +'<div class="asset-slug">'+esc(m.title)+'</div></div>'
      +'<div class="timer">'+remaining+'s<small>remaining</small></div></div>'
      +'<div class="sides">'
      +'<div class="side"><div class="side-label up">▲ UP</div>'
      +'<div class="mid" style="color:#28e0a5" id="up-'+m.slug+'">'+upMid+'</div>'
      +'<div class="quote">Bid '+prc(m.up.bid)+' · Ask '+prc(m.up.ask)+'</div>'
      +(m.up.spread!=null?'<div class="spread-badge">spr '+prc(m.up.spread)+'</div>':'')+'</div>'
      +'<div class="side"><div class="side-label down">▼ DOWN</div>'
      +'<div class="mid" style="color:#ff6b81" id="dn-'+m.slug+'">'+dnMid+'</div>'
      +'<div class="quote">Bid '+prc(m.down.bid)+' · Ask '+prc(m.down.ask)+'</div>'
      +(m.down.spread!=null?'<div class="spread-badge">spr '+prc(m.down.spread)+'</div>':'')+'</div>'
      +'</div></div>';
  }).join('');
  $('windowCount').textContent=markets.length+' WINDOW(S)';
}

function renderLivePrices(tick) {
  if(!tick||!tick.markets)return;
  for(const m of tick.markets) {
    const ue=$('up-'+m.slug), de=$('dn-'+m.slug);
    if(ue)ue.textContent=prc(m.up.mid);
    if(de)de.textContent=prc(m.down.mid);
  }
}

function renderKpis(d) {
  $('bankroll').textContent=cash(d.bankroll);
  $('markValue').textContent=cash(d.markValue);
  const tp=d.totalPnl||0; const te=$('totalPnl'); te.textContent=money(tp); te.style.color=tp>=0?'#00ff9d':'#ff5566';
  const rp=d.realizedPnl||0; const re=$('realizedPnl'); re.textContent=money(rp); re.style.color=rp>=0?'#00ff9d':'#ff5566';
  $('winLoss').textContent=(d.wins||0)+' / '+(d.losses||0);
  $('winRate').textContent=d.winRate!=null?'Win rate '+d.winRate+'%':'';
  $('consecLoss').textContent=d.consecutiveLosses||0;
  $('maxConsecLoss').textContent='max '+(d.maxConsecutiveLosses||0);
  $('maxDrawdown').textContent=cash(d.maxDrawdown);
  $('rebate').textContent=cash(d.makerRebateAccrued);
  $('tickPill').textContent='ticks '+(d.tickCount||0);
  const sp=$('statusPill');
  if(d.connected){sp.textContent='● LIVE';sp.className='pill live'}else{sp.textContent='● OFFLINE';sp.className='pill bad'}
  $('uptimePill').textContent=uptimeFmt(d.uptime||0);
}

function renderMartingale(mg) {
  // Per-asset martingale state: { btc: { shares, losses } }
}

function renderPositions(positions) {
  const c=$('positionsContainer');
  if(!positions||!positions.length){c.innerHTML='<div class="empty">No open positions</div>';$('posCount').textContent='';return}
  c.innerHTML=positions.map(p=>{
    const badge=p.outcome==='UP'?'tag-up':'tag-down';
    const title=esc(p.asset.toUpperCase())+' '+p.outcome;
    const unrealized=p.unrealized||0;
    const markVal=p.markValue||0;
    const tpNote=p.tpSold?'TP SOLD @'+prc(p.tpPrice):'TP PENDING @0.75';
    const tpClass=p.tpSold?'pos-badge tp':'pos-badge holding';
    const tpBadgeLabel=p.tpSold?'TP DONE':'HOLDING';
    return '<div class="position-card">'
      +'<div class="pos-header"><div class="pos-name">'+title+'</div>'
      +'<div style="display:flex;gap:4px">'
      +'<span class="'+tpClass+'">'+tpBadgeLabel+'</span>'
      +'</div></div>'
      +'<div class="pos-pnl '+tone(unrealized)+'" id="floating-'+p.id+'">'+money(unrealized)+'</div>'
      +'<div class="pos-meta">Entry '+cash(p.entryPrice)+' · Remaining '+num(p.remainingShares)+'sh · Cost '+cash(p.cost)+'</div>'
      +'<div class="pos-tp-row">'
      +'<div class="pos-tp">Total<b>'+num(p.shares)+' SH</b></div>'
      +'<div class="pos-tp">Remaining<b>'+num(p.remainingShares)+' SH</b></div>'
      +'<div class="pos-tp">TP Status<b>'+tpNote+'</b></div>'
      +'<div class="pos-tp">Mark<b>'+prc(p.markPrice||p.entryPrice)+'</b></div>'
      +'</div>'
      +'</div>';
  }).join('');
  $('posCount').textContent=positions.length+' POSITION(S)';
}

function updateFloating() {
  if(!S||!S.positions)return;
  for(const p of S.positions) {
    const fl=$('floating-'+p.id);
    if(fl){const u=p.unrealized||0; fl.textContent=money(u); fl.style.color=u>=0?'#00ff9d':'#ff5566';}
  }
}

function renderResolved(results) {
  const c=$('resolvedContainer');
  if(!results||!results.length){c.innerHTML='<div class="empty">No resolved bets yet</div>';return}
  c.innerHTML=results.slice(0,20).map(r=>{
    const won=r.won===true;
    const icon=won?'✅':'❌';
    const label=won?'WIN':'LOSS';
    const tpInfo=r.tpSold?' · TP @'+prc(r.tpPrice):'';
    return '<div class="result-card">'
      +'<div class="result-header"><div class="pos-name">⚡ '+esc((r.asset||'').toUpperCase())+' '+(r.outcome||'')+' · mg#'+(r.martingaleIndex||0)+tpInfo+'</div>'
      +'<span class="pos-badge '+(won?'won':'lost')+'">'+icon+' '+label+'</span></div>'
      +'<div class="result-pnl '+(r.pnl>=0?'color:#00ff9d':'color:#ff5566')+'">'+money(r.pnl)+'</div>'
      +'<div class="result-meta">Payout '+cash(r.payout)+' · Cost '+cash(r.cost)+'</div>'
      +'</div>';
  }).join('');
  $('resCount').textContent=results.length+' RESOLVED';
}

function renderFeed(trades) {
  const c=$('feedContainer'), ct=$('feedCount');
  if(!trades||!trades.length){c.innerHTML='<div class="empty">No trades yet</div>';ct.textContent='0 TRADES';return}
  ct.textContent=trades.length+' TRADES';
  c.innerHTML=trades.slice(0,50).map(t=>{
    const isTp=t.orderType&&t.orderType.includes('TP');
    const tagClass=isTp?'tag-tp':(t.outcome==='UP'?'tag-up':'tag-down');
    const label=isTp?'💰 TP SELL':(t.asset.toUpperCase()+' '+(t.outcome||''));
    return '<div class="feed-item">'
      +'<div class="feed-time">'+new Date(t.timestamp).toLocaleTimeString()+' · '+esc(t.orderType||'')</div>'
      +'<div class="feed-main"><span class="tag '+tagClass+'">'+label+'</span> '
      +num(t.shares)+' SH @ '+prc(t.price)+'</div>'
      +'<div class="feed-detail">'+cash(t.cost)+(t.fee?' · fee '+cash(t.fee):'')+' · rebate '+cash(t.rebateEstimate||0)+'</div>'
      +'</div>';
  }).join('');
}

function renderLogs(arr) {
  const c=$('logContainer'), ct=$('logCount');
  ct.textContent=arr.length+' LINES';
  c.innerHTML=arr.slice(-300).map(line=>{
    let cls='';
    if(line.includes('WIN'))cls='log-win';
    else if(line.includes('LOSS')||line.includes('⚠️'))cls='log-loss';
    else if(line.includes('TP SELL')||line.includes('💰'))cls='log-tp';
    else if(line.includes('FILLED')||line.includes('LIMIT')||line.includes('cancelled'))cls='log-info';
    return '<div class="log '+cls+'">'+esc(line)+'</div>';
  }).join('');
}

function renderConfig(cfg) {
  const c=$('configGrid');
  c.innerHTML='<div class="config-item">Base Shares<b>'+cfg.baseShares+'</b></div>'
    +'<div class="config-item">Limit Price<b>'+cfg.limitPrice+'</b></div>'
    +'<div class="config-item">TP Price<b>'+cfg.tpPrice+'</b></div>'
    +'<div class="config-item">TP Ratio<b>'+(cfg.tpRatio*100)+'%</b></div>'
    +'<div class="config-item">MG Multiplier<b>'+cfg.multiplier+'×</b></div>'
    +'<div class="config-item">Resolution<b>≥'+cfg.resolutionPrice+'</b></div>'
    +'<div class="config-item">Taker Fee<b>'+(cfg.takerFeeRate*100)+'%</b></div>'
    +'<div class="config-item">Maker Rebate<b>'+(cfg.makerRebateRate*100)+'%</b></div>';
}

function renderChart(curve) {
  const svg=$('equityChart');
  if(!curve||!curve.length){svg.innerHTML='';return}
  const vals=curve.map(p=>p.equity),lo=Math.min(...vals),hi=Math.max(...vals),rng=(hi-lo)||1;
  const W=700,H=160,P=14;
  const pts=curve.map((p,i)=>[i/Math.max(1,curve.length-1)*W,H-P-(p.equity-lo)/rng*(H-P*2)]);
  const path='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');
  const last=pts.at(-1)||[0,H/2];
  const color=S&&S.totalPnl>=0?'#15ff9c':'#ff4a68';
  svg.innerHTML='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5"/>'
    +'<circle cx="'+last[0]+'" cy="'+last[1]+'" r="4" fill="'+color+'"/>';
}

function fullRender(d) {
  Object.assign(S,d);
  renderMarkets(d.markets);
  renderKpis(d);
  renderPositions(d.positions);
  renderResolved(d.resolvedPositions);
  renderFeed(d.trades);
  renderLogs(d.logs);
  renderConfig(d.config);
  renderChart(d.equityCurve);
}

// ── Socket Events ──────────────────────────────────────────
let socket=io();
socket.on('state', d=>fullRender(d));
socket.on('tick', tick=>{lastTick=tick;renderLivePrices(tick);});
socket.on('connect', ()=>$('statusPill').textContent='● CONNECTED');
socket.on('disconnect', ()=>$('statusPill').textContent='● RECONNECTING');
socket.on('log', line=>{
  const c=$('logContainer');
  if(!c)return;
  let cls='';
  if(line.includes('WIN'))cls='log-win';
  else if(line.includes('LOSS')||line.includes('⚠️'))cls='log-loss';
  else if(line.includes('TP SELL')||line.includes('💰'))cls='log-tp';
  else if(line.includes('FILLED')||line.includes('LIMIT')||line.includes('cancelled'))cls='log-info';
  const div=document.createElement('div');
  div.className='log '+cls;
  div.textContent=line;
  c.appendChild(div);
  c.scrollTop=c.scrollHeight;
});

setInterval(()=>{if(lastTick&&lastTick.markets){renderLivePrices(lastTick);updateFloating();}},50);
fetch('/api/status').then(r=>r.json()).then(d=>fullRender(d)).catch(()=>{});
</script>
</body>
</html>`;

app.get('/healthz', (_, res) => res.sendStatus(200));
app.get('/api/status', (_, res) => res.json(engine.buildState()));
app.get('/', (_, req) => req.type('html').send(dashboard));

io.on('connection', (socket) => socket.emit('state', engine.buildState()));
setInterval(() => io.emit('state', engine.buildState()), 250);

server.listen(port, '0.0.0.0', () => {
  console.log(`CorrelBot dashboard listening on :${port}`);
  engine.init().catch((err) => console.error(`Init failure: ${err.message}`));
});
