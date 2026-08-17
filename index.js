'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bot        = require('./cricket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

app.get('/api/hedge/status', (_, res) => {
  try { res.json(bot.buildState()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/pause', (req, res) => {
  try { res.json(bot.pauseTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/resume', (req, res) => {
  try { res.json(bot.resumeTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/set-mode', (req, res) => {
  const { live } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(bot.setMode(live)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>⛏ BTC 0.60 Martingale — 5m &amp; 15m</title>
<style>
  :root {
    --bg:#000; --bg2:#0a0a0a; --bg3:#111; --border:#333;
    --text:#fff; --muted:#888; --cyan:#00ccff; --green:#00ff88;
    --red:#ff4444; --yellow:#ffcc00; --gold:#ffaa00; --purple:#aa88ff;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Courier New',monospace;background:var(--bg);color:var(--text);font-size:12px;font-weight:bold;-webkit-text-size-adjust:100%}
  .header{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid var(--gold);padding:12px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
  .logo{font-size:16px;color:#fff}.logo span{color:var(--cyan)}
  .mode-badge{padding:3px 10px;border-radius:20px;font-size:10px;font-weight:bold}
  .mode-dry{background:#ffd74022;color:var(--yellow);border:1px solid var(--yellow)}
  .mode-live{background:#ff475722;color:#ff6b7a;border:1px solid #ff4757;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .toolbar{display:flex;gap:6px;padding:10px 14px 0;flex-wrap:wrap}
  .toolbar button{background:var(--cyan);color:#001018;border:none;padding:8px 12px;border-radius:6px;font-weight:bold;cursor:pointer;font-family:inherit;font-size:11px}
  .toolbar button.pause{background:var(--yellow)}.toolbar button.resume{background:var(--green);color:#fff}
  .toolbar button.live-toggle{background:var(--red);color:#fff}.toolbar button.live-toggle.is-live{background:var(--muted);color:#fff}
  .note{padding:6px 14px 0;font-size:9px;color:var(--muted);line-height:1.4}
  .shared-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:10px 14px 0}
  @media(max-width:700px){.shared-stats{grid-template-columns:repeat(2,1fr);gap:5px;padding:8px 10px 0}}
  .stat{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:6px 7px}
  .stat-lbl{font-size:7.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px}
  .stat-val{font-size:12px;font-weight:bold;color:#fff}
  .pnl-pos{color:var(--green)!important}.pnl-neg{color:var(--red)!important}
  .chart-card{margin:10px 14px 0;background:var(--bg2);border:2px solid var(--border);border-radius:10px;overflow:hidden}
  .chart-hdr{background:#0d1d30;padding:8px 12px;display:flex;justify-content:space-between;align-items:center}
  .chart-title{font-size:12px;color:#ddd}.chart-meta{font-size:8px;color:var(--muted);text-align:right}
  .equity-chart{display:block;width:100%;height:180px;background:#000}
  @media(max-width:600px){.equity-chart{height:130px}.chart-hdr{flex-direction:column;align-items:flex-start;gap:4px}}
  .panels{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 14px}
  @media(max-width:900px){.panels{grid-template-columns:1fr}}
  @media(max-width:600px){.panels{padding:8px 10px;gap:8px}}
  .panel{background:var(--bg2);border:2px solid var(--border);border-radius:10px;overflow:hidden}
  .panel-hdr{background:#0d1d30;padding:8px 12px;display:flex;justify-content:space-between;align-items:center}
  .panel-title{font-size:13px;color:#ddd}
  .panel-body{padding:10px 12px}
  .pstats{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px}
  @media(max-width:700px){.pstats{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:400px){.pstats{grid-template-columns:1fr 1fr;gap:4px}}
  .cw{background:#0a0a0a;border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:10px;margin-bottom:8px}
  .cw .hl{font-size:11.5px;margin-bottom:5px;padding-bottom:5px;border-bottom:1px dashed var(--border)}
  .cw .r{display:flex;justify-content:space-between;padding:1.5px 0;gap:6px}
  .cw .r span:last-child{text-align:right}
  .pill{font-size:8px;padding:2px 6px;border-radius:9px;white-space:nowrap}
  .p-wait{background:#ffd74022;color:var(--yellow);border:1px solid var(--yellow)}
  .p-rest{background:#e6a80022;color:var(--gold);border:1px solid var(--gold)}
  .p-open{background:#0099cc22;color:var(--cyan);border:1px solid var(--cyan)}
  .p-win{background:#00a85422;color:var(--green);border:1px solid var(--green)}
  .p-loss{background:#e8304a22;color:var(--red);border:1px solid var(--red)}
  .p-idle{background:var(--bg3);color:var(--muted);border:1px solid var(--border)}
  .ladder{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:6px 0}
  @media(max-width:400px){.ladder{grid-template-columns:repeat(2,1fr)}}
  .lvl{border:1px dashed var(--border);border-radius:6px;padding:4px 3px;text-align:center;font-size:8px;background:var(--bg3)}
  .lvl .lt{color:var(--muted);text-transform:uppercase;font-size:6.5px;letter-spacing:.3px}
  .lvl .la{font-size:10px;margin:1px 0}.lvl .ls{font-size:8px;min-height:10px}.lvl .lp{font-size:7px;color:var(--muted);min-height:9px}
  .lvl.active{border:2px solid var(--cyan);background:#0099cc11}
  .lvl.placed.up{border:2px solid var(--cyan);background:#0099cc22}
  .lvl.placed.down{border:2px solid var(--purple);background:#7c5cff22}
  .tw{background:var(--bg);border:1px solid var(--border);border-radius:6px;overflow:hidden;max-height:220px;display:flex;flex-direction:column}
  .tw-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;flex:1;overflow-y:auto}
  .tbl{border-collapse:collapse;min-width:600px}
  .tbl th{background:var(--bg3);color:var(--muted);padding:4px 5px;text-align:left;font-size:7.5px;text-transform:uppercase;position:sticky;top:0;white-space:nowrap}
  .tbl td{padding:3px 5px;border-bottom:1px solid var(--border);font-size:8.5px;white-space:nowrap}
  .empty{padding:12px;text-align:center;color:var(--muted);font-size:9px}
  .log-panel{margin:10px 14px;background:var(--bg2);border:2px solid var(--border);border-radius:10px;padding:10px 12px;max-height:260px;overflow-y:auto;overflow-x:auto;font-size:9.5px;line-height:1.4;color:#fff;font-weight:bold;-webkit-overflow-scrolling:touch}
  .log-panel div{padding:1px 0;white-space:nowrap}
  .banner{margin:8px 14px 0;padding:6px 12px;border-radius:6px;font-size:10px;background:#ffd74022;color:var(--yellow);border:1px solid var(--yellow)}
</style>
</head>
<body>
  <div class="header">
    <div class="logo">⛏ <span>BTC</span> MARTINGALE 5m/15m</div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>
  <div class="toolbar">
    <button id="pause-btn" class="pause">⏸ Pause</button>
    <button id="resume-btn" class="resume">▶ Resume</button>
    <button id="live-btn" class="live-toggle">🔴 Go LIVE</button>
  </div>
  <div class="note">Strategy: wait 1m(5m)/3m(15m) → watch 0.60+ → buy pullback to 0.60 → stop 0.49 → 1.5x MG re-entry (max 3). Separate windows.</div>
  <div id="start-banner" class="banner" style="display:none"></div>
  <div class="shared-stats" id="shared-stats"></div>
  <div class="chart-card">
    <div class="chart-hdr">
      <div class="chart-title">📈 Equity</div>
      <div id="chart-meta" class="chart-meta"></div>
    </div>
    <canvas id="equity-chart" class="equity-chart"></canvas>
  </div>
  <div class="panels">
    <div class="panel" id="panel-m5"></div>
    <div class="panel" id="panel-m15"></div>
  </div>
  <div class="log-panel" id="log-panel"><div class="empty">No logs yet</div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket=io();let latest={m5:null,m15:null};
function $(id){return document.getElementById(id)}
function fmt2(n){return(n==null||isNaN(n))?'—':Number(n).toFixed(2)}
function fmtPx(n){return(n==null||isNaN(n))?'—':Number(n).toFixed(3)}
function fmtPct(n){return(n==null||isNaN(n))?'—':(Number(n)*100).toFixed(1)+'%'}
function sgn(n){if(n==null||isNaN(n))return'—';return(n>0?'+$':(n<0?'-$':'±$'))+Math.abs(n).toFixed(2)}
function pClass(n){return n==null||isNaN(n)?'':n>0?'pnl-pos':(n<0?'pnl-neg':'')}
function fmtClock(ts){if(!ts)return'—';var d=new Date(ts*1000);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0')}
function fmtCountdown(ms){if(ms==null)return'—';var s=Math.max(0,Math.ceil(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function stat(label,value,cls){return'<div class="stat"><div class="stat-lbl">'+label+'</div><div class="stat-val '+(cls||'')+'">'+value+'</div></div>'}

function phaseInfo(t){
  if(!t)return{label:'—',cls:'p-idle'};
  if(t.skipped)return{label:'NO BET',cls:'p-idle'};
  if(t.settled)return{label:t.win===true?'WIN':(t.win===false?'LOSS':'DONE'),cls:t.win===true?'p-win':(t.win===false?'p-loss':'p-idle')};
  switch(t.phase){
    case'waiting':return{label:'WAIT '+fmtCountdown(t.countdownMs),cls:'p-wait'};
    case'awaiting-trigger':return{label:'ENTRY',cls:'p-open'};
    case'trading':return{label:'TRADING MG'+t.martingaleLevel,cls:'p-open'};
    case'pending-resolution':return{label:'RESOLVING',cls:'p-rest'};
    default:return{label:String(t.phase).toUpperCase(),cls:'p-idle'}
  }
}

function ladderHtml(s,t){
  var levels=[{d:s.entryDollars,tag:'E'}];
  (s.martingaleAmounts||[]).forEach(function(d,i){levels.push({d:d,tag:'MG'+(i+1)})});
  var html='<div class="ladder">';
  for(var i=0;i<levels.length;i++){
    var buy=t.buys&&t.buys[i];
    var cls='lvl';
    if(buy)cls+=' placed '+(buy.side==='up'?'up':'down');
    else if(t.buys&&t.buys.length===i&&(t.phase==='trading'||t.phase==='awaiting-trigger'))cls+=' active';
    var side=buy?(buy.side==='up'?'UP':'DOWN'):(t.buys&&t.buys.length===i&&t.phase==='trading'?'…':'—');
    var px=buy?fmtPx(buy.price):(t.buys&&t.buys.length===i&&t.phase==='trading'?'hold':'');
    html+='<div class="'+cls+'" title="'+levels[i].tag+' $'+levels[i].d+(buy?' — '+buy.side.toUpperCase()+' @'+fmtPx(buy.price)+' = '+fmt2(buy.shares)+'sh':'')+'">' +
      '<div class="lt">'+levels[i].tag+'</div><div class="la">$'+levels[i].d+'</div><div class="ls">'+side+'</div><div class="lp">'+px+'</div></div>';
  }
  return html+'</div>';
}

function currentWindowHtml(s){
  var t=s.current.btc;if(!t)return'<div class="empty">Waiting…</div>';
  var ph=phaseInfo(t);var leg=t.leg||{};
  var hasBuys=t.buys&&t.buys.length>0;
  var hl;
  if(t.skipped)hl='⏸ No bet';
  else if(t.settled)hl=(t.win===true?'🏆':'💸')+' '+(t.win?'WIN':'LOSS')+' '+sgn(t.pnl);
  else if(t.phase==='waiting')hl='⏳ '+fmtCountdown(t.countdownMs)+' → watch for 0.60+';
  else if(t.phase==='awaiting-trigger')hl='🎯 Watching 0.60+ pullback';
  else hl=(t.lastSide==='up'?'🔵':'🟣')+' '+(t.lastSide||'?').toUpperCase()+' stop '+(s.stopLossPrice||0.49);
  var html='<div class="cw"><div class="hl">'+hl+'</div>'+
    '<div class="r"><span>Window</span><span>'+(leg.slug||'…')+'</span></div>'+
    '<div class="r"><span>Phase</span><span class="pill '+ph.cls+'">'+ph.label+'</span></div>'+
    '<div class="r"><span>Closes</span><span>'+fmtCountdown(t.closeAt-Date.now())+'</span></div>'+
    '<div class="r"><span>UP</span><span>'+fmtPx(leg.upAsk)+'/'+fmtPx(leg.upBid)+'</span></div>'+
    '<div class="r"><span>DN</span><span>'+fmtPx(leg.downAsk)+'/'+fmtPx(leg.downBid)+'</span></div>'+
    '<div class="r"><span>Entry/Stop</span><span>'+fmtPx(s.entryPrice||0.60)+' / '+fmtPx(s.stopLossPrice||0.49)+'</span></div>'+
    ladderHtml(s,t);
  if(hasBuys){
    var lb=t.buys[t.buys.length-1];
    html+='<div class="r"><span>Side</span><span>'+lb.side.toUpperCase()+' $'+fmt2(lb.dollars)+' @'+fmtPx(lb.price)+'</span></div>'+
      '<div class="r"><span>Risked</span><span>$'+fmt2(t.totalCost)+'</span></div>'+
      '<div class="r"><span>Recovered</span><span>$'+fmt2(t.sellProceeds||0)+'</span></div>';
    if(t.settled)html+='<div class="r"><span>P&L</span><span class="'+pClass(t.pnl)+'">'+sgn(t.pnl)+'</span></div>';
    else html+='<div class="r"><span>Unrlzd</span><span class="'+pClass(t.unrealizedPnl)+'">'+sgn(t.unrealizedPnl)+'</span></div>';
  }
  return html+'</div>';
}

function historyRowsHtml(list){
  if(!list||!list.length)return'<tr><td colspan="8" class="empty">No resolved windows</td></tr>';
  return list.slice(0,25).map(function(h){
    var legs=(h.legs||[]).map(function(l){return l.side.toUpperCase()+' $'+l.dollars}).join('→');
    var entry=h.entrySide?h.entrySide.toUpperCase()+' $'+(h.legs&&h.legs[0]?h.legs[0].dollars:''):'—';
    return'<tr title="'+legs+'">'+
      '<td>'+fmtClock(h.windowTs)+'</td>'+
      '<td>'+entry+'</td>'+
      '<td>'+(h.martingaleLevels||0)+'</td>'+
      '<td>'+(h.winner||'?').toUpperCase()+'</td>'+
      '<td class="'+(h.win===true?'pnl-pos':(h.win===false?'pnl-neg':''))+'">'+(h.win==null?'—':(h.win?'WIN':'LOSS'))+'</td>'+
      '<td>-$'+fmt2(h.wager||0)+'</td>'+
      '<td>+$'+fmt2(h.payout||0)+'</td>'+
      '<td class="'+pClass(h.pnl)+'">'+sgn(h.pnl)+'</td></tr>';
  }).join('');
}

function panelHtml(key,title,s){
  if(!s)return'<div class="panel-hdr"><div class="panel-title">'+title+'</div></div><div class="panel-body"><div class="empty">Waiting…</div></div>';
  return'<div class="panel-hdr"><div class="panel-title">'+title+'</div>'+
    '<div class="mode-badge '+(s.dryRun?'mode-dry':'mode-live')+'" style="font-size:8px">'+(s.dryRun?'DEMO':'LIVE')+'</div></div>'+
    '<div class="panel-body"><div class="pstats">'+
      stat('Bank','$'+fmt2(s.bankroll))+
      stat('Equity','$'+fmt2(s.equity),pClass(s.equity-(s.startingCapital||0)))+
      stat('Win%',fmtPct(s.winRate))+
      stat('P&L',sgn(s.realizedPnl),pClass(s.realizedPnl))+
      stat('W/L',s.wins+'/'+s.losses)+
      stat('Max DD',fmtPct((s.maxDrawdown||{}).pct)+' '+sgn(-((s.maxDrawdown||{}).dollars||0)),pClass(-((s.maxDrawdown||{}).dollars||0)))+
      stat('Max MG',s.windowsReachedMaxMartingale)+
      stat('Fees','$'+fmt2(s.totalFeesPaid||0))+
    '</div>'+
    currentWindowHtml(s)+
    '<div class="tw"><div class="tw-scroll"><table class="tbl"><thead><tr>'+
      '<th>Time</th><th>Entry</th><th>MG</th><th>Winner</th><th>W/L</th><th>Cost</th><th>Payout</th><th>P&L</th>'+
    '</tr></thead><tbody>'+historyRowsHtml(s.history)+'</tbody></table></div></div></div>';
}

function drawdownOf(curve){
  var peak=-Infinity,maxPct=0,maxDollars=0;
  for(var i=0;i<curve.length;i++){
    if(curve[i].equity>peak)peak=curve[i].equity;
    var dd=peak>0?(peak-curve[i].equity)/peak:0;
    if(dd>maxPct){maxPct=dd;maxDollars=peak-curve[i].equity}
  }
  return{pct:maxPct,dollars:maxDollars}
}
function combinedCurve(){
  var a=latest.m15,b=latest.m5;
  var c15=a&&a.equityCurve,c5=b&&b.equityCurve;
  if(!c5||!c15)return(c5||c15||[]);
  var n=Math.min(c5.length,c15.length),out=[];
  for(var i=0;i<n;i++)out.push({t:c5[i].t,equity:Math.round((c5[i].equity+c15[i].equity)*100)/100});
  return out;
}
function sharedStatsHtml(){
  var a=latest.m15,b=latest.m5;
  if(!a&&!b)return'';
  var bankroll=(a?a.bankroll:0)+(b?b.bankroll:0);
  var equity=(a?a.equity:0)+(b?b.equity:0);
  var rpnl=(a?a.realizedPnlTotal:0)+(b?b.realizedPnlTotal:0);
  var decided=(a?a.windowsDecided:0)+(b?b.windowsDecided:0);
  var wins=(a?a.wins:0)+(b?b.wins:0);
  var winRate=decided>0?wins/decided:null;
  var dd=drawdownOf(combinedCurve());
  var fees=(a?a.totalFeesPaid:0)+(b?b.totalFeesPaid:0);
  return stat('Total Bank','$'+fmt2(bankroll))+
    stat('Total Equity','$'+fmt2(equity))+
    stat('Total P&L',sgn(rpnl),pClass(rpnl))+
    stat('Win Rate',fmtPct(winRate))+
    stat('Decided',decided)+
    stat('Max DD',fmtPct(dd.pct)+' '+sgn(dd.dollars),pClass(-(dd.dollars||0)))+
    stat('Fees','$'+fmt2(fees));
}

function drawEquityChart(){
  var canvas=$('equity-chart'),ctx=canvas.getContext('2d');
  var dpr=window.devicePixelRatio||1,W=canvas.clientWidth||800,H=canvas.clientHeight||180;
  canvas.width=W*dpr;canvas.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
  var series=[
    {label:'5m',st:latest.m5,color:'#0099cc',fill:'rgba(0,153,204,0.08)'},
    {label:'15m',st:latest.m15,color:'#ff9f43',fill:'rgba(255,159,67,0.10)'}
  ].filter(function(x){return x.st&&x.st.equityCurve&&x.st.equityCurve.length>=2});
  if(!series.length){ctx.fillStyle='#888';ctx.font='10px monospace';ctx.fillText('Collecting data…',14,24);$('chart-meta').textContent='';return}
  var min=Infinity,max=-Infinity;
  series.forEach(function(x){x.st.equityCurve.forEach(function(p){if(p.equity<min)min=p.equity;if(p.equity>max)max=p.equity});min=Math.min(min,x.st.startingCapital);max=Math.max(max,x.st.startingCapital)});
  var pad=10,xAt=function(i,len){return pad+(i/(len-1))*(W-pad*2)},yAt=function(v){return H-pad-((v-min)/((max-min)||1))*(H-pad*2)};
  ctx.strokeStyle='#333';ctx.lineWidth=1;
  for(var g=0;g<=4;g++){var gy=pad+(g/4)*(H-pad*2);ctx.beginPath();ctx.moveTo(pad,gy);ctx.lineTo(W-pad,gy);ctx.stroke()}
  var metas=[];
  series.forEach(function(x){
    var curve=x.st.equityCurve,vals=curve.map(function(p){return p.equity});
    ctx.strokeStyle=x.color;ctx.globalAlpha=.5;ctx.setLineDash([4,3]);ctx.beginPath();
    ctx.moveTo(pad,yAt(x.st.startingCapital));ctx.lineTo(W-pad,yAt(x.st.startingCapital));ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
    ctx.beginPath();ctx.moveTo(xAt(0,curve.length),yAt(vals[0]));
    for(var i=1;i<curve.length;i++)ctx.lineTo(xAt(i,curve.length),yAt(vals[i]));
    ctx.strokeStyle=x.color;ctx.lineWidth=2;ctx.stroke();
    ctx.lineTo(xAt(curve.length-1,curve.length),H-pad);ctx.lineTo(xAt(0,curve.length),H-pad);ctx.closePath();ctx.fillStyle=x.fill;ctx.fill();
    ctx.fillStyle=x.color;ctx.beginPath();ctx.arc(xAt(curve.length-1,curve.length),yAt(vals[curve.length-1]),3.5,0,Math.PI*2);ctx.fill();
    var dd=x.st.maxDrawdown||{};
    metas.push(x.label+': $'+fmt2(x.st.startingCapital)+'→$'+fmt2(vals[curve.length-1])+' DD'+fmtPct(dd.pct));
  });
  ctx.font='9px monospace';ctx.fillStyle='#888';ctx.fillText('$'+fmt2(max),12,14);ctx.fillText('$'+fmt2(min),12,H-4);
  $('chart-meta').textContent=metas.join(' | ');
}

function render(){
  var any=latest.m5||latest.m15,banner=$('start-banner');
  if(any&&any.waitingForBoundary&&any.boundaryWindowTs){banner.style.display='block';banner.textContent='⏳ Starting at '+fmtClock(any.boundaryWindowTs)+' UTC'}
  else banner.style.display='none';
  $('shared-stats').innerHTML=sharedStatsHtml();
  $('panel-m5').innerHTML=panelHtml('m5','BTC 5m — wait 1m',latest.m5);
  $('panel-m15').innerHTML=panelHtml('m15','BTC 15m — wait 3m',latest.m15);
  drawEquityChart();
  if(any){
    var live=(latest.m5&&!latest.m5.dryRun)||(latest.m15&&!latest.m15.dryRun);
    $('mode-badge').className='mode-badge '+(live?'mode-live':'mode-dry');
    $('mode-badge').textContent=live?'LIVE':'DEMO';
    $('live-btn').classList.toggle('is-live',live);
    $('live-btn').textContent=live?'⚠ DEMO':'🔴 LIVE';
  }
}

$('pause-btn').onclick=function(){fetch('/api/hedge/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})};
$('resume-btn').onclick=function(){fetch('/api/hedge/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})};
$('live-btn').onclick=function(){
  var live=(latest.m5&&!latest.m5.dryRun)||(latest.m15&&!latest.m15.dryRun),want=!live;
  if(want&&!confirm('Switch to LIVE mode?'))return;
  fetch('/api/hedge/set-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({live:want})});
};

var allLogs=[];
function renderLogs(){
  var el=$('log-panel');
  if(!allLogs.length){el.innerHTML='<div class="empty">No logs yet</div>';return}
  el.innerHTML=allLogs.slice(-120).map(function(l){
    var c='';
    if(l.indexOf('WIN')>=0)c=' style="color:#00ff88"';
    else if(l.indexOf('LOSS')>=0||l.indexOf('STOP')>=0)c=' style="color:#ff4444"';
    else if(l.indexOf('P&L')>=0)c=' style="color:#ffcc00"';
    return'<div'+c+'>'+l.replace(/</g,'&lt;')+'</div>';
  }).join('');
  el.scrollTop=el.scrollHeight;
}

socket.on('hedgeState:BTC-5m',function(s){latest.m5=s;render()});
socket.on('hedgeState:BTC-15m',function(s){latest.m15=s;render()});
socket.on('log',function(line){allLogs.push(line);if(allLogs.length>300)allLogs.shift();renderLogs()});

setInterval(render,1000);
setInterval(async function(){
  try{var res=await fetch('/api/hedge/status'),st=await res.json();
    if(st&&st.m5)latest.m5=st.m5;if(st&&st.m15)latest.m15=st.m15;render()
  }catch(e){}
},10000);
render();
</script>
</body>
</html>`);


const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log('⛏ BTC 0.60 Martingale Bot — 5m & 15m windows, separate demo capital per timeframe');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
