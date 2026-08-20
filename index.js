'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const CAPITAL_5 = Number(process.env.CAPITAL_5 || 4000);
const CAPITAL_15 = Number(process.env.CAPITAL_15 || 4000);
const BUCKET_INTERVAL_5 = Number(process.env.BUCKET_INTERVAL_5 || 20);
const BUCKET_INTERVAL_15 = Number(process.env.BUCKET_INTERVAL_15 || 60);
const SHARES_PER_SIDE = Number(process.env.SHARES_PER_SIDE || 10);
const OPPOSITE_DISCOUNT = Number(process.env.OPPOSITE_DISCOUNT || 0.10);
const FEE_THETA = Number(process.env.FEE_THETA || 0.07);

let engine5 = null, engine15 = null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.get('/healthz', (_, r) => r.sendStatus(200));
app.get('/api/hedge/status', (_, r) => {
  try { r.json({ m5: engine5 ? engine5.buildState() : null, m15: engine15 ? engine15.buildState() : null }); }
  catch (e) { r.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/pause', (_, r) => { try { if (engine5) engine5.pauseTrading(); if (engine15) engine15.pauseTrading(); r.json({ ok: true }); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });
app.post('/api/hedge/resume', (_, r) => { try { if (engine5) engine5.resumeTrading(); if (engine15) engine15.resumeTrading(); r.json({ ok: true }); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });
app.post('/api/hedge/set-mode', (req, r) => { const { live } = req.body || {}; if (typeof live !== 'boolean') return r.status(400).json({ ok: false, error: 'Missing "live"' }); try { if (engine5) engine5.setMode(live); if (engine15) engine15.setMode(live); r.json({ ok: true }); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });

const DASH = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>BTC Bucket Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:12px;font-weight:bold;-webkit-text-size-adjust:100%;overflow-x:hidden}
.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #00ccff;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:16px;color:#fff}.logo span{color:#00ccff}
.badge{padding:3px 10px;border-radius:20px;font-size:10px;font-weight:bold}
.badge-dem{background:#ffd74022;color:#ffcc00;border:1px solid #ffcc00}
.badge-live{background:#ff475722;color:#ff6b7a;border:1px solid #ff4757;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:8px 14px 0}
@media(max-width:600px){.stats-row{grid-template-columns:repeat(2,1fr);gap:5px;padding:8px 10px 0}}
.st{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:6px 7px}
.st-l{font-size:7px;color:#888;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.st-v{font-size:13px;font-weight:bold;color:#fff}
.pos{color:#00ff88!important}.neg{color:#ff4444!important}
.panel{margin:8px 14px 0;background:#0a0a0a;border:2px solid #333;border-radius:10px;overflow:hidden}
@media(max-width:600px){.panel{margin:6px 10px 0}}
.p-hd{background:#0d1d30;padding:8px 12px;display:flex;justify-content:space-between;align-items:center}
.p-title{font-size:14px;font-weight:bold;color:#fff}
.p-badge{font-size:9px;padding:2px 8px;border-radius:10px;background:#333;color:#aaa}
.p-body{padding:10px 12px}
.p-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px}
@media(max-width:600px){.p-stats{grid-template-columns:repeat(2,1fr)}}
.ps{background:#111;border:1px solid #333;border-radius:5px;padding:4px 6px}
.ps .l{font-size:7px;color:#888;text-transform:uppercase}
.ps .v{font-size:12px;font-weight:bold;color:#fff}
.price-box{background:#111;border:1px solid #444;border-radius:8px;padding:8px 10px;margin-bottom:8px}
.price-row{display:flex;justify-content:space-between;align-items:center}
.price-side{font-size:11px;font-weight:bold}
.price-side.up{color:#00ccff}.price-side.dn{color:#aa88ff}
.price-val{font-size:18px;font-weight:bold;color:#fff}
.price-val.up{color:#00ccff}.price-val.dn{color:#aa88ff}
.price-label{font-size:7px;color:#888;text-transform:uppercase}
.bucket-card{background:#111;border:1px solid #444;border-radius:6px;padding:8px 10px;margin-bottom:6px}
.bk-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.bk-id{font-size:9px;padding:2px 6px;border-radius:4px;font-weight:bold;background:#00ccff22;color:#00ccff;border:1px solid #00ccff}
.bk-status{font-size:9px;padding:2px 6px;border-radius:4px;font-weight:bold}
.bk-open{background:#ffcc0022;color:#ffcc00}.bk-both{background:#00ff8822;color:#00ff88}
.bk-leg{display:flex;gap:14px;flex-wrap:wrap;margin-top:4px}
.bk-item .lbl{color:#666;font-size:7px;text-transform:uppercase}
.bk-item .val{font-size:13px;font-weight:bold;color:#fff}
.bk-filled{color:#00ff88!important}.bk-waiting{color:#ffcc00!important}
.history-list{max-height:300px;overflow-y:auto}
.h-item{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1a1a1a;font-size:9px;gap:6px}
.h-result{font-size:10px;font-weight:bold;padding:1px 5px;border-radius:3px}
.h-win{background:#00ff8822;color:#00ff88}.h-loss{background:#ff444422;color:#ff4444}
.h-pnl{font-size:11px;font-weight:bold}
.log-box{margin:8px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px;max-height:200px;overflow-y:auto;font-size:9px;line-height:1.4;white-space:nowrap;-webkit-overflow-scrolling:touch}
@media(max-width:600px){.log-box{margin:6px 10px 0}}
.chart-box{margin:8px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
@media(max-width:600px){.chart-box{margin:6px 10px 0}}
.chart-box canvas{width:100%;height:120px;background:#111;border-radius:6px}
.section-hdr{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px}
</style></head><body>
<div class="hd"><div><div class="logo">BTC <span>Bucket Limit</span></div></div><div class="badge badge-dem" id="mode-badge">DEMO</div></div>
<div class="stats-row" id="stats-row"></div>
<div class="chart-box"><canvas id="eq-chart"></canvas></div>
<div class="panel" id="panel-m5"><div class="p-hd"><div class="p-title">5 Minute Windows</div><div class="p-badge" id="m5-badge">--</div></div><div class="p-body" id="m5-body"></div></div>
<div class="panel" id="panel-m15"><div class="p-hd"><div class="p-title">15 Minute Windows</div><div class="p-badge" id="m15-badge">--</div></div><div class="p-body" id="m15-body"></div></div>
<div class="log-box" id="log-box"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io(),latest={m5:null,m15:null},allLogs=[];
var $=function(id){return document.getElementById(id)};
var fmt2=function(n){return n!=null?Number(n).toFixed(2):'--'};
var fmt3=function(n){return n!=null?Number(n).toFixed(3):'--'};
var sgn=function(n){return n>0?'+$'+fmt2(n):n<0?'-$'+fmt2(Math.abs(n)):'$0.00'};
var pC=function(n){return n>0?'pos':n<0?'neg':''};

function priceHtml(leg){
  if(!leg||!leg.discovered)return'';
  return '<div class="price-box"><div class="price-row">'+
    '<div><div class="price-label">UP MID</div><div class="price-val up">'+fmt3(leg.upMid)+'</div></div>'+
    '<div style="text-align:right"><div class="price-label">DOWN MID</div><div class="price-val dn">'+fmt3(leg.downMid)+'</div></div>'+
    '</div><div style="text-align:center;margin-top:4px;font-size:9px;color:#888">'+(leg.secsLeft!=null?leg.secsLeft+'s left':'')+'</div></div>';
}

function bucketHtml(b){
  var bothFilled=b.cheapFilled&&b.expensiveFilled;
  var status=bothFilled?'BOTH FILLED':b.cheapFilled?'CHEAP ✓ / EXP WAITING':'WAITING CHEAP';
  var statusClass=bothFilled?'bk-both':'bk-open';
  var h='<div class="bucket-card">';
  h+='<div class="bk-header"><span class="bk-id">#'+b.id+'</span><span class="bk-status '+statusClass+'">'+status+'</span></div>';
  h+='<div class="bk-leg">';
  h+='<div class="bk-item"><div class="lbl">'+b.cheapSide.toUpperCase()+' (cheap)</div>';
  h+='<div class="val '+(b.cheapFilled?'bk-filled':'bk-waiting')+'">'+(b.cheapFilled?b.cheapShares+'sh @'+fmt3(b.cheapFillPrice):'target '+fmt3(b.cheapTarget))+'</div></div>';
  h+='<div class="bk-item"><div class="lbl">'+b.expSide.toUpperCase()+' (expensive)</div>';
  h+='<div class="val '+(b.expensiveFilled?'bk-filled':'bk-waiting')+'">'+(b.expensiveFilled?b.expensiveShares+'sh @'+fmt3(b.expensiveFillPrice):(b.expTarget?'target '+fmt3(b.expTarget):'pending'))+'</div></div>';
  h+='</div></div>';
  return h;
}

function panelHtml(st){
  if(!st)return'<div style="color:#666;padding:10px">Waiting...</div>';
  var h='';
  h+='<div class="p-stats">';
  h+='<div class="ps"><div class="l">Bankroll</div><div class="v">$'+fmt2(st.bankroll)+'</div></div>';
  h+='<div class="ps"><div class="l">Equity</div><div class="v '+pC(st.equity-st.startingCapital)+'">$'+fmt2(st.equity)+'</div></div>';
  h+='<div class="ps"><div class="l">Realized</div><div class="v '+pC(st.realizedPnl)+'">'+sgn(st.realizedPnl)+'</div></div>';
  h+='<div class="ps"><div class="l">Unrealized</div><div class="v '+pC(st.unrealizedPnl)+'">'+sgn(st.unrealizedPnl)+'</div></div>';
  h+='</div>';
  h+='<div class="p-stats">';
  h+='<div class="ps"><div class="l">Wins</div><div class="v pos">'+(st.wins||0)+'</div></div>';
  h+='<div class="ps"><div class="l">Losses</div><div class="v neg">'+(st.losses||0)+'</div></div>';
  h+='<div class="ps"><div class="l">Win Rate</div><div class="v">'+(st.winRate!=null?st.winRate+'%':'--')+'</div></div>';
  h+='<div class="ps"><div class="l">Open Buckets</div><div class="v">'+(st.openBucketCount||0)+'</div></div>';
  h+='</div>';

  // Live prices
  var leg=st.currentLeg;
  if(leg&&leg.discovered){
    h+=priceHtml(leg);
    // Accumulated shares
    h+='<div class="p-stats">';
    h+='<div class="ps"><div class="l">UP Shares</div><div class="v" style="color:#00ccff">'+(st.totalUpShares||0)+'</div></div>';
    h+='<div class="ps"><div class="l">DOWN Shares</div><div class="v" style="color:#aa88ff">'+(st.totalDownShares||0)+'</div></div>';
    h+='<div class="ps"><div class="l">Total Cost</div><div class="v">$'+fmt2(st.totalCost)+'</div></div>';
    h+='<div class="ps"><div class="l">Fees</div><div class="v">$'+fmt2(st.totalFeesPaid)+'</div></div>';
    h+='</div>';
  }

  // Open buckets
  var obs=st.openBuckets||[];
  if(obs.length){
    h+='<div class="section-hdr">Open Buckets ('+obs.length+')</div>';
    for(var i=0;i<obs.length;i++)h+=bucketHtml(obs[i]);
  }

  // History
  var hist=st.history||[];
  if(hist.length){
    h+='<div class="section-hdr">Resolved Windows</div>';
    h+='<div class="history-list">';
    for(var k=0;k<Math.min(hist.length,30);k++){
      var hw=hist[k];
      var resClass=hw.pnl>=0?'h-win':'h-loss';
      h+='<div class="h-item">';
      h+='<span style="color:#666;min-width:60px">'+hw.slug.replace('btc-updown-','').replace(/^\\d+m-/,'')+'</span>';
      h+='<span style="color:#aaa">'+hw.buckets+' buckets</span>';
      h+='<span style="color:#888">winner:'+(hw.winner||'?').toUpperCase()+'</span>';
      h+='<span class="h-result '+resClass+'">'+(hw.pnl>=0?'WIN':'LOSS')+'</span>';
      h+='<span class="h-pnl '+pC(hw.pnl)+'">'+sgn(hw.pnl)+'</span>';
      h+='</div>';
    }
    h+='</div>';
  }
  if(!leg||!leg.discovered)h+='<div style="color:#666;padding:8px;text-align:center">Waiting for window discovery...</div>';
  return h;
}

function drawChart(){
  var canvas=$('eq-chart');if(!canvas)return;
  var ctx=canvas.getContext('2d');
  var dpr=window.devicePixelRatio||1,W=canvas.clientWidth||800,H=canvas.clientHeight||120;
  canvas.width=W*dpr;canvas.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
  var curves=[];
  if(latest.m5&&latest.m5.equityCurve&&latest.m5.equityCurve.length>=2)curves.push({data:latest.m5.equityCurve,cap:latest.m5.startingCapital,color:'#0099cc'});
  if(latest.m15&&latest.m15.equityCurve&&latest.m15.equityCurve.length>=2)curves.push({data:latest.m15.equityCurve,cap:latest.m15.startingCapital,color:'#aa88ff'});
  if(!curves.length){ctx.fillStyle='#888';ctx.font='10px monospace';ctx.fillText('Collecting data...',14,20);return}
  var min=Infinity,max=-Infinity;
  curves.forEach(function(c){c.data.forEach(function(p){if(p.equity<min)min=p.equity;if(p.equity>max)max=p.equity});min=Math.min(min,c.cap);max=Math.max(max,c.cap)});
  var pad=10,xA=function(i,l){return pad+(i/(l-1))*(W-pad*2)},yA=function(v){return H-pad-((v-min)/((max-min)||1))*(H-pad*2)};
  ctx.strokeStyle='#333';ctx.lineWidth=1;for(var g=0;g<=4;g++){var gy=pad+(g/4)*(H-pad*2);ctx.beginPath();ctx.moveTo(pad,gy);ctx.lineTo(W-pad,gy);ctx.stroke()}
  curves.forEach(function(c){
    var d=c.data,vals=d.map(function(p){return p.equity});
    ctx.globalAlpha=.5;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(pad,yA(c.cap));ctx.lineTo(W-pad,yA(c.cap));ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
    ctx.beginPath();ctx.moveTo(xA(0,d.length),yA(vals[0]));for(var i=1;i<d.length;i++)ctx.lineTo(xA(i,d.length),yA(vals[i]));
    ctx.strokeStyle=c.color;ctx.lineWidth=2;ctx.stroke();
    ctx.lineTo(xA(d.length-1,d.length),H-pad);ctx.lineTo(xA(0,d.length),H-pad);ctx.closePath();ctx.fillStyle=c.color+'11';ctx.fill();
  });
  ctx.font='9px monospace';ctx.fillStyle='#888';
  if(max!==Infinity)ctx.fillText('$'+max.toFixed(0),4,14);
  if(min!==-Infinity)ctx.fillText('$'+min.toFixed(0),4,H-4);
}

function render(){
  var s5=latest.m5,s15=latest.m15;
  var totalPnl=(s5?s5.realizedPnl:0)+(s15?s15.realizedPnl:0);
  var totalEquity=(s5?s5.equity:0)+(s15?s15.equity:0);
  var totalW=(s5?s5.wins:0)+(s15?s15.wins:0);
  var totalL=(s5?s5.losses:0)+(s15?s15.losses:0);
  var totalUnreal=(s5?s5.unrealizedPnl:0)+(s15?s15.unrealizedPnl:0);
  var wr=totalW+totalL>0?((totalW/(totalW+totalL))*100).toFixed(1)+'%':'--';
  $('stats-row').innerHTML=[
    '<div class="st"><div class="st-l">Equity</div><div class="st-v">$'+fmt2(totalEquity)+'</div></div>',
    '<div class="st"><div class="st-l">Realized</div><div class="st-v '+pC(totalPnl)+'">'+sgn(totalPnl)+'</div></div>',
    '<div class="st"><div class="st-l">Unrealized</div><div class="st-v '+pC(totalUnreal)+'">'+sgn(totalUnreal)+'</div></div>',
    '<div class="st"><div class="st-l">W/L ('+wr+')</div><div class="st-v"><span class="pos">'+totalW+'W</span>/<span class="neg">'+totalL+'L</span></div></div>',
  ].join('');
  $('m5-body').innerHTML=panelHtml(s5);
  $('m5-badge').textContent=(s5?(s5.wins||0)+'W/'+(s5.losses||0)+'L':'--')+' | '+sgn(s5?s5.realizedPnl:0)+' | '+((s5&&s5.openBucketCount)||0)+' open';
  $('m15-body').innerHTML=panelHtml(s15);
  $('m15-badge').textContent=(s15?(s15.wins||0)+'W/'+(s15.losses||0)+'L':'--')+' | '+sgn(s15?s15.realizedPnl:0)+' | '+((s15&&s15.openBucketCount)||0)+' open';
  var live=(s5&&!s5.dryRun)||(s15&&!s15.dryRun);
  $('mode-badge').className='badge '+(live?'badge-live':'badge-dem');
  $('mode-badge').textContent=live?'LIVE':'DEMO';
  drawChart();
}

function renderLogs(){
  var el=$('log-box');if(!el)return;
  var wasAtBottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=allLogs.slice(-200).map(function(l){
    var c='';
    if(l.indexOf('FILLED')>=0)c=' style="color:#00ff88"';
    else if(l.indexOf('LOSS')>=0)c=' style="color:#ff4444"';
    else if(l.indexOf('BUCKET')>=0)c=' style="color:#00ccff"';
    else if(l.indexOf('RESOLVED')>=0)c=' style="color:#ffcc00"';
    return'<div'+c+'>'+l.replace(/</g,'&lt;')+'</div>';
  }).join('');
  if(wasAtBottom)el.scrollTop=el.scrollHeight;
}

socket.on('hedgeState:BTC-5m',function(s){latest.m5=s;render()});
socket.on('hedgeState:BTC-15m',function(s){latest.m15=s;render()});
socket.on('log',function(line){allLogs.push(line);if(allLogs.length>500)allLogs.shift();renderLogs()});
setInterval(render,1000);
setInterval(async function(){
  try{var res=await fetch('/api/hedge/status'),st=await res.json();
    if(st.m5)latest.m5=st.m5;if(st.m15)latest.m15=st.m15;render();
  }catch(e){}
},10000);
render();
</script></body></html>`;

app.get('/', (_, res) => { res.type('html').send(DASH); });

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log('⛏ BTC Bucket Limit Bot — 5m + 15m independent windows');
server.listen(PORT, '0.0.0.0', () => {
  console.log('🌐 Dashboard: http://0.0.0.0:' + PORT);
  (async () => {
    const trader = new PolymarketTrader(PK);
    await trader.authenticate();
    const mkEngine = (label, type, cap, winSec, interval, noTradeAfter, statsPath) => createEngine({
      label, windowType: type, startingCapital: cap,
      windowSeconds5: winSec, bucketIntervalSec: interval, noTradeAfterSec: noTradeAfter,
      sharesPerSide: SHARES_PER_SIDE, oppositeSideDiscount: OPPOSITE_DISCOUNT,
      feeTheta: FEE_THETA,
      statsStatePath: statsPath, trader, dryRun: DRY_RUN, emit, slog,
    });
    engine5 = mkEngine('BTC-5m', '5m', CAPITAL_5, 300, BUCKET_INTERVAL_5, 180, process.env.STATS_STATE_PATH || path.join(__dirname, 'stats-5m.json'));
    engine15 = mkEngine('BTC-15m', '15m', CAPITAL_15, 900, BUCKET_INTERVAL_15, 600, process.env.STATS_STATE_PATH_15 || path.join(__dirname, 'stats-15m.json'));
    await engine5.start();
    await engine15.start();
  })().catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
