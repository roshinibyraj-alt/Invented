'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { BotEngine, loadEquityFile } = require('./engine');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 8080;
const EQUITY_FILE = process.env.EQUITY_FILE || path.join(__dirname, 'equity.json');
const initialEquity = loadEquityFile(EQUITY_FILE);

const engine = new BotEngine({
  initialEquity,
  onLog: (line) => console.log(line),
});

const dashboard = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CorrelBot — 0.30 Engine</title>
<style>
*{box-sizing:border-box}
:root{--bg:#000;--panel:#070707;--line:#222;--muted:#9d9d9d;--up:#00ff85;--down:#ff4a68;--amber:#ffc400;--blue:#38d6ff}
html,body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;font-weight:800;margin:0}
body{padding:10px;font-size:15px}
.wrap{max-width:1180px;margin:auto}
.topbar{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:8px}
.btc{width:38px;height:38px;border-radius:50%;background:#f7931a;display:grid;place-items:center;font-size:22px}
h1{font-size:19px;margin:0;line-height:1.1;text-transform:uppercase}
.sub{font-size:10px;color:var(--muted);letter-spacing:.4px;margin-top:2px}
.status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.pill{border:1px solid var(--line);padding:4px 7px;font-size:10px;white-space:nowrap;border-radius:6px}
.live{color:var(--up);border-color:#084b31}.warn{color:var(--amber);border-color:#5a4300}.bad{color:var(--down);border-color:#5c1622}.blue{color:var(--blue);border-color:#0d3a4a}
.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:8px}
.box,.panel{background:var(--panel);border:1px solid var(--line);padding:9px;border-radius:8px}
.label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.value{font-size:19px;margin-top:2px}.value.positive{color:var(--up)}.value.negative{color:var(--down)}
.small{font-size:9px;color:var(--muted);margin-top:2px}
.two-col{display:grid;grid-template-columns:minmax(280px,1fr) minmax(260px,.75fr);gap:8px}
.clock{font-size:38px;line-height:1}.clock small{font-size:12px;color:var(--muted)}
.market{margin-bottom:8px}
.prices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.side{border:1px solid var(--line);padding:9px;background:#000;border-radius:8px}
.side-name{font-size:12px}.side-price{font-size:34px;line-height:1;margin:3px 0}
.side.up .side-price{color:var(--up)}.side.down .side-price{color:var(--down)}
.quote-row{display:flex;justify-content:space-between;font-size:12px}.quote-row span:last-child{color:#ddd}
.spread{display:inline-block;font-size:10px;color:var(--amber);margin-top:2px}
.position-name{font-size:20px}.pnl{font-size:30px;margin:2px 0}
.entry{font-size:10px;color:var(--muted);margin-bottom:4px}
.small-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:8px}
.mini{background:#000;border:1px solid var(--line);padding:6px;border-radius:6px}
.mini .label{font-size:8px}.mini .value{font-size:13px}
.tp-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;margin-left:6px;vertical-align:middle}
.tp-badge.done{color:var(--amber);border:1px solid #5a4300;background:#1a1200}
.tp-badge.hold{color:var(--blue);border:1px solid #0d3a4a;background:#00131a}
.wide{margin-top:8px}.empty{color:var(--muted);padding:10px;border:1px dashed #333;text-align:center}
.chart{width:100%;height:120px;display:block}
.section-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#fff;text-transform:uppercase}
.list{max-height:230px;overflow:auto;margin-top:6px}
.result,.trade-item{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #161616;padding:7px 0;font-size:12px}
.buy{color:var(--up)}.sell{color:var(--down)}.tp{color:var(--amber)}.dim{color:var(--muted);font-size:10px;font-weight:700}
.results-grid{display:grid;gap:6px}
.feeds{display:grid;gap:6px}
.logs{height:200px;overflow:auto;background:#010407;border-radius:8px;padding:8px;font-family:"Courier New",monospace;font-size:10px;line-height:1.45;color:#e4e4e4;margin-top:6px;white-space:pre-wrap}
.log-win{color:var(--up)}.log-loss{color:var(--down)}.log-tp{color:var(--amber)}.log-info{color:var(--blue)}
@media(max-width:860px){
 .metrics{grid-template-columns:repeat(2,1fr)}
 .two-col{grid-template-columns:1fr}
}
@media(max-width:1100px){.metrics{grid-template-columns:repeat(3,1fr)}}
@media(max-width:720px){
 body{padding:6px;font-size:13px}
 h1{font-size:16px}.topbar{grid-template-columns:1fr}.status{justify-content:flex-start}
 .side-price{font-size:30px}.pnl{font-size:27px}.clock{font-size:32px}
 .list,.logs{max-height:170px}
}
</style>
</head>
<body><div class="wrap">
<header class="topbar">
 <div class="brand"><div class="btc">₿</div><div><h1>CorrelBot</h1><div class="sub">0.30 BOTH-SIDE LIMIT · CANCEL OPPOSITE · TP@0.75 HALF · 1.5× MG · BASE 133 · CLOB</div></div></div>
 <div class="status">
   <span id="statusPill" class="pill warn">CONNECTING</span>
   <span id="tickPill" class="pill">POLLS 0</span>
   <span id="uptimePill" class="pill blue">00:00:00</span>
 </div>
</header>

<div class="metrics">
 <div class="box"><div class="label">Bankroll</div><div class="value" id="bankroll">$20,000</div></div>
 <div class="box"><div class="label">Mark Value</div><div class="value" id="markValue">$20,000</div></div>
 <div class="box"><div class="label">Total P&L</div><div class="value" id="totalPnl">$0</div></div>
 <div class="box"><div class="label">Realized</div><div class="value" id="realizedPnl">$0</div></div>
 <div class="box"><div class="label">Wins / Losses</div><div class="value" id="winLoss">0 / 0</div><div class="small" id="winRate"></div></div>
 <div class="box"><div class="label">Consec Losses</div><div class="value" id="consecLoss">0</div><div class="small" id="maxConsecLoss">max 0</div></div>
 <div class="box"><div class="label">Max Drawdown</div><div class="value negative" id="maxDrawdown">$0</div></div>
 <div class="box"><div class="label">Maker Rebate</div><div class="value" id="rebate">$0</div></div>
 <div class="box"><div class="label">Window Delta</div><div class="value" id="deltaVal">—</div><div class="small" id="deltaLean"></div></div>
 <div class="box"><div class="label">Signal Hit-rate</div><div class="value" id="sigHitrate">—</div><div class="small" id="sigBets"></div></div>
</div>

<div class="two-col">
 <div>
   <div class="box market">
     <div class="section-head"><span>Live Market</span><span id="windowCount"></span></div>
     <div id="marketBody"></div>
   </div>
   <div class="box wide">
     <div class="section-head"><span>Open Position</span><span id="posCount"></span></div>
     <div id="posBody"></div>
   </div>
   <div class="box wide">
     <div class="section-head"><span>Resolved</span><span id="resCount"></span></div>
     <div id="resBody"></div>
   </div>
 </div>
 <div>
   <div class="box">
     <div class="section-head"><span>Config</span></div>
     <div id="configBody" style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px;margin-top:6px"></div>
   </div>
   <div class="box wide">
     <div class="section-head"><span>Equity</span></div>
     <svg class="chart" id="equityChart"></svg>
   </div>
   <div class="box wide">
     <div class="section-head"><span>Trade Feed</span><span id="feedCount"></span></div>
     <div class="list"><div class="feeds" id="feedContainer"></div></div>
   </div>
   <div class="box wide">
     <div class="section-head"><span>Logs</span><span id="logCount"></span></div>
     <div class="logs" id="logContainer"></div>
   </div>
 </div>
</div>
</div>
<script>
const $=id=>document.getElementById(id);
const S={};
let pollCount=0;

function esc(s){return String(s).replace(/[&<>"]/g,c=>({'+':'&#43;','&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function money(n){n=n||0;return(n>=0?'+':'−')+('$'+Math.abs(n).toFixed(2))}
function cash(n){return'$'+Number(n||0).toFixed(2)}
function num(n){return Number(n||0).toLocaleString()}
function prc(n){return n!=null?Number(n).toFixed(3):'—'}
function tone(n){return n>=0?'positive':'negative'}
function uptimeFmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0')}

function renderMarket(market) {
  const body=$('marketBody');
  if(!market){body.innerHTML='<div class="empty">Waiting for market discovery...</div>';return}
  const r=market.remaining||0, e=market.elapsed||0;
  body.innerHTML='<div class="clock">'+r+'s<small> T+'+e+'s</small></div>'
    +'<div class="prices">'
    +'<div class="side up"><div class="side-name">▲ UP</div><div class="side-price">'+prc(market.up.mid)+'</div>'
    +'<div class="quote-row"><span>Bid</span><span>'+prc(market.up.bid)+'</span></div>'
    +'<div class="quote-row"><span>Ask</span><span>'+prc(market.up.ask)+'</span></div>'
    +(market.up.spread!=null?'<div class="spread">SPR '+prc(market.up.spread)+'</div>':'')+'</div>'
    +'<div class="side down"><div class="side-name">▼ DOWN</div><div class="side-price">'+prc(market.down.mid)+'</div>'
    +'<div class="quote-row"><span>Bid</span><span>'+prc(market.down.bid)+'</span></div>'
    +'<div class="quote-row"><span>Ask</span><span>'+prc(market.down.ask)+'</span></div>'
    +(market.down.spread!=null?'<div class="spread">SPR '+prc(market.down.spread)+'</div>':'')+'</div>'
    +'</div>';
  $('windowCount').textContent=(market.title||'');
}

function renderPosition(pos) {
  const body=$('posBody');
  if(!pos){body.innerHTML='<div class="empty">No open position</div>';$('posCount').textContent='';return}
  const unrl=pos.unrealized||0;
  const tpCls=pos.tpSold?'done':'hold';
  const tpLbl=pos.tpSold?'TP DONE @'+prc(pos.tpPrice):'TP PENDING 0.75';
  $('posCount').textContent=pos.asset.toUpperCase()+' '+pos.outcome;
  body.innerHTML='<div style="display:flex;align-items:center;flex-wrap:wrap">'
    +'<span class="position-name">'+(pos.outcome==='UP'?'▲':'▼')+' '+pos.outcome+'</span>'
    +'<span class="tp-badge '+tpCls+'">'+tpLbl+'</span></div>'
    +'<div class="pnl '+tone(unrl)+'">'+money(unrl)+'</div>'
    +'<div class="entry">Entry '+cash(pos.entryPrice)+' · '+num(pos.shares)+' SH total · '+num(pos.remainingShares)+' SH remaining · cost '+cash(pos.cost)+' · mg#'+(pos.martingaleIndex||0)+'</div>'
    +'<div class="small-grid">'
    +'<div class="mini"><div class="label">Total</div><div class="value">'+num(pos.shares)+' SH</div></div>'
    +'<div class="mini"><div class="label">Remaining</div><div class="value">'+num(pos.remainingShares)+' SH</div></div>'
    +'<div class="mini"><div class="label">Mark</div><div class="value">'+prc(pos.markPrice||pos.entryPrice)+'</div></div>'
    +'</div>';
}

function renderResults(results) {
  const body=$('resBody');
  if(!results||!results.length){body.innerHTML='<div class="empty">No resolved yet</div>';return}
  body.innerHTML=results.slice(0,15).map(r=>{
    const won=r.won===true;
    const icon=won?'✅':'❌';
    const tpInfo=r.tpSold?' · TP@'+prc(r.tpPrice):'';
    return '<div class="result">'
      +'<div><span class="'+(won?'buy':'sell')+'">'+icon+' '+esc(r.asset.toUpperCase())+' '+(r.outcome||'')+'</span>'
      +'<div class="dim">mg#'+(r.martingaleIndex||0)+tpInfo+' · payout '+cash(r.payout)+' · cost '+cash(r.cost)+'</div></div>'
      +'<div class="'+(r.pnl>=0?'buy':'sell')+'">'+money(r.pnl)+'</div>'
      +'</div>';
  }).join('');
  $('resCount').textContent=results.length+' BETS';
}

function renderFeed(trades) {
  const c=$('feedContainer'), ct=$('feedCount');
  if(!trades||!trades.length){c.innerHTML='<div class="empty">No trades yet</div>';ct.textContent='0';return}
  ct.textContent=trades.length+' TRADES';
  c.innerHTML=trades.slice(0,30).map(t=>{
    const isTp=t.orderType&&t.orderType.includes('TP');
    const cls=isTp?'tp':(t.outcome==='UP'?'buy':'sell');
    const label=isTp?'💰 TP':(t.asset.toUpperCase()+' '+(t.outcome||''));
    return '<div class="trade-item">'
      +'<div><span class="'+cls+'">'+label+'</span>'
      +'<div class="dim">'+new Date(t.timestamp).toLocaleTimeString()+' · '+num(t.shares)+' SH @ '+prc(t.price)+'</div></div>'
      +'<div style="text-align:right"><div>'+cash(t.cost)+(t.fee?' · <span class="dim">'+cash(t.fee)+' fee</span>':'')+'</div>'
      +'<div class="dim">rebate '+cash(t.rebateEstimate||0)+'</div></div>'
      +'</div>';
  }).join('');
}

function renderLogs(arr) {
  const c=$('logContainer'), ct=$('logCount');
  ct.textContent=arr.length+' LINES';
  c.innerHTML=arr.slice(-40).map(line=>{
    let cls='';
    if(line.includes('WIN'))cls='log-win';
    else if(line.includes('LOSS'))cls='log-loss';
    else if(line.includes('TP SELL')||line.includes('💰'))cls='log-tp';
    else if(line.includes('FILLED')||line.includes('LIMIT')||line.includes('cancelled')||line.includes('⚠️'))cls='log-info';
    return '<div class="'+cls+'">'+esc(line)+'</div>';
  }).join('');
}

function renderConfig(cfg) {
  const c=$('configBody');
  if(!cfg)return;
  c.innerHTML='<div class="mini"><div class="label">Base</div><div class="value">'+cfg.baseShares+' SH</div></div>'
    +'<div class="mini"><div class="label">Entry</div><div class="value">'+cfg.limitPrice+'</div></div>'
    +'<div class="mini"><div class="label">TP</div><div class="value">'+cfg.tpPrice+'</div></div>'
    +'<div class="mini"><div class="label">TP Ratio</div><div class="value">'+(cfg.tpRatio*100)+'%</div></div>'
    +'<div class="mini"><div class="label">MG</div><div class="value">'+cfg.multiplier+'×</div></div>'
    +'<div class="mini"><div class="label">Taker Fee</div><div class="value">'+(cfg.takerFeeRate*100)+'%</div></div>'
    +'<div class="mini"><div class="label">Rebate</div><div class="value">'+(cfg.makerRebateRate*100)+'%</div></div>'
    +'<div class="mini"><div class="label">Resolution</div><div class="value">≥'+cfg.resolutionPrice+'</div></div>';
}

function renderChart(curve) {
  const svg=$('equityChart');
  if(!curve||!curve.length){svg.innerHTML='';return}
  const vals=curve.map(p=>p.equity),lo=Math.min(...vals),hi=Math.max(...vals),rng=(hi-lo)||1;
  const W=700,H=120,P=12;
  const pts=curve.map((p,i)=>[i/Math.max(1,curve.length-1)*W,H-P-(p.equity-lo)/rng*(H-P*2)]);
  const path='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');
  const last=pts.at(-1)||[0,H/2];
  const color=S&&S.totalPnl>=0?'#00ff85':'#ff4a68';
  svg.innerHTML='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5"/>'
    +'<circle cx="'+last[0]+'" cy="'+last[1]+'" r="4" fill="'+color+'"/>';
}

function renderKpis(d) {
  $('bankroll').textContent=cash(d.bankroll);
  $('markValue').textContent=cash(d.markValue);
  const tp=d.totalPnl||0; const te=$('totalPnl'); te.textContent=money(tp); te.className='value '+tone(tp);
  const rp=d.realizedPnl||0; const re=$('realizedPnl'); re.textContent=money(rp); re.className='value '+tone(rp);
  $('winLoss').textContent=(d.wins||0)+' / '+(d.losses||0);
  $('winRate').textContent=d.winRate!=null?'Win rate '+d.winRate+'%':'';
  $('consecLoss').textContent=d.consecutiveLosses||0;
  $('maxConsecLoss').textContent='max '+(d.maxConsecutiveLosses||0);
  $('maxDrawdown').textContent=cash(d.maxDrawdown);
  $('rebate').textContent=cash(d.makerRebateAccrued);
  const sig=d.signal||{};
  const del=sig.deltaPct;
  const dv=$('deltaVal');
  if(del!=null){dv.textContent=(del>=0?'+':'')+del.toFixed(3)+'%';dv.className='value '+tone(del)}
  else{dv.textContent='—';dv.className='value'}
  const lean=sig.lean||'NEUTRAL';
  const dl=$('deltaLean');
  if(lean==='UP'){dl.textContent='→ UP · cancels DOWN';dl.style.color='#00ff85'}
  else if(lean==='DOWN'){dl.textContent='→ DOWN · cancels UP';dl.style.color='#ff4a68'}
  else{dl.textContent='→ NEUTRAL · both legs';dl.style.color='#9d9d9d'}
  const sh=$('sigHitrate');
  if(d.signalTotal>0){sh.textContent=Math.round(d.signalHits/d.signalTotal*100)+'%'}else{sh.textContent='—'}
  $('sigBets').textContent=(d.signalBets||0)+' lean bets';
  pollCount++;
  $('tickPill').textContent='POLLS '+pollCount;
  const sp=$('statusPill');
  if(d.connected){sp.textContent='● LIVE';sp.className='pill live'}else{sp.textContent='● OFFLINE';sp.className='pill bad'}
  $('uptimePill').textContent=uptimeFmt(d.uptime||0);
}

function fullRender(d) {
  Object.assign(S,d);
  renderKpis(d);
  renderMarket(d.markets&&d.markets[0]);
  renderPosition(d.positions&&d.positions[0]);
  renderResults(d.resolvedPositions);
  renderFeed(d.trades);
  renderLogs(d.logs);
  renderConfig(d.config);
  renderChart(d.equityCurve);
}

async function poll() {
  try {
    const r=await fetch('/api/status');
    const d=await r.json();
    fullRender(d);
  } catch(e) {
    const sp=$('statusPill');
    if(sp){sp.textContent='● OFFLINE';sp.className='pill bad'}
  }
}
setInterval(poll,1000);
poll();
</script>
</body>
</html>`;

app.get('/healthz', (_, res) => res.sendStatus(200));
app.get('/api/status', (_, res) => res.json(engine.buildState()));
app.get('/', (_, req) => req.type('html').send(dashboard));

server.listen(port, '0.0.0.0', () => {
  console.log(`CorrelBot dashboard listening on :${port}`);
  engine.init().catch((err) => console.error(`Init failure: ${err.message}`));
});
