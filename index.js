'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const CAPITAL = Number(process.env.CAPITAL || 4000);
const BASE_SHARES = Number(process.env.BASE_SHARES || 50);
const ENTRY_SECOND = Number(process.env.ENTRY_SECOND || 30);
const MIN_FAVORITE_PRICE = Number(process.env.MIN_FAVORITE_PRICE || 0.64);

let engine = null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.get('/healthz', (_, r) => r.sendStatus(200));
app.get('/api/hedge/status', (_, r) => {
  try { r.json({ engine: engine ? engine.buildState() : null }); }
  catch (e) { r.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/pause', (_, r) => { try { if (engine) engine.pauseTrading(); r.json({ ok: true }); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });
app.post('/api/hedge/resume', (_, r) => { try { if (engine) engine.resumeTrading(); r.json({ ok: true }); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });

const DASH = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>BTC Early Favorite Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:12px;font-weight:bold;-webkit-text-size-adjust:100%;overflow-x:hidden}
.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #00ccff;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:16px;color:#fff}.logo span{color:#00ccff}
.badge{padding:3px 10px;border-radius:20px;font-size:10px}
.badge-dem{background:#ffd74022;color:#ffcc00;border:1px solid #ffcc00}
.badge-live{background:#ff475722;color:#ff6b7a;border:1px solid #ff4757}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:8px 14px 0}
@media(max-width:600px){.stats-row{grid-template-columns:repeat(2,1fr)}}
.st{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:6px 7px}
.st-l{font-size:7px;color:#888;text-transform:uppercase;margin-bottom:2px}
.st-v{font-size:13px;color:#fff}
.pos{color:#00ff88!important}.neg{color:#ff4444!important}
.panel{margin:8px 14px 0;background:#0a0a0a;border:2px solid #333;border-radius:10px;overflow:hidden}
@media(max-width:600px){.panel{margin:6px 10px 0}}
.p-hd{background:#0d1d30;padding:8px 12px;display:flex;justify-content:space-between;align-items:center}
.p-title{font-size:14px;color:#fff}.p-badge{font-size:9px;padding:2px 8px;border-radius:10px;background:#333;color:#aaa}
.p-body{padding:10px 12px}
.price-box{background:#111;border:1px solid #444;border-radius:8px;padding:8px 10px;margin-bottom:8px;display:flex;justify-content:space-around}
.price-item{text-align:center}
.price-label{font-size:7px;color:#888;text-transform:uppercase}
.price-val{font-size:20px;color:#fff}
.side-card{background:#111;border:1px solid #444;border-radius:8px;padding:8px 10px;margin-bottom:6px}
.sc-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.sc-name{font-size:13px}.sc-up{color:#00ccff}.sc-down{color:#aa88ff}
.position-tag{display:inline-block;padding:2px 6px;margin:2px;border-radius:3px;font-size:9px;background:#00ff8822;color:#00ff88;border:1px solid #00ff88}
.history-list{max-height:300px;overflow-y:auto}
.h-item{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:10px;gap:6px;flex-wrap:wrap}
.h-result{font-size:10px;padding:1px 5px;border-radius:3px;font-weight:bold}
.h-win{background:#00ff8822;color:#00ff88}.h-loss{background:#ff444422;color:#ff4444}
.log-box{margin:8px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px;max-height:240px;overflow-x:auto;overflow-y:auto;font-size:11px;line-height:1.45;white-space:pre;-webkit-overflow-scrolling:touch}
@media(max-width:600px){.log-box{margin:6px 10px 0}}
.chart-box{margin:8px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
@media(max-width:600px){.chart-box{margin:6px 10px 0}}
.chart-box canvas{width:100%;height:120px;background:#111;border-radius:6px}
</style></head><body>
<div class="hd"><div><div class="logo">BTC <span>Early Favorite</span></div></div><div class="badge badge-dem" id="mode-badge">DEMO</div></div>
<div class="stats-row" id="stats-row"></div>
<div class="chart-box"><canvas id="eq-chart"></canvas></div>
<div class="panel"><div class="p-hd"><div class="p-title">5 MINUTE WINDOWS</div><div class="p-badge" id="eng-badge">--</div></div><div class="p-body" id="eng-body"></div></div>
<div class="log-box" id="log-box"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io(),latest=null,allLogs=[];
var $=function(id){return document.getElementById(id)};
var fmt2=function(n){return n!=null?Number(n).toFixed(2):'--'};
var fmt3=function(n){return n!=null?Number(n).toFixed(3):'--'};
var sgn=function(n){return n>0?'+$'+fmt2(n):n<0?'-$'+fmt2(Math.abs(n)):'$0.00'};
var pC=function(n){return n>0?'pos':n<0?'neg':''};

function sideHtml(name,st){
  if(!st)return'';
  var posList=st.positions||[];
  var h='<div class="side-card">';
  h+='<div class="sc-head">';
  h+='<span class="sc-name sc-'+name+'">'+name.toUpperCase()+'</span>';
  h+='<span style="color:#fff;font-size:13px;font-weight:bold">'+st.totalShares+' SH</span>';
  h+='<span style="font-size:11px" class="'+pC(st.totalUnrealized)+'">'+sgn(st.totalUnrealized)+'</span>';
  h+='</div>';
  if(posList.length){
    for(var i=0;i<posList.length;i++){
      var p=posList[i];
      h+='<div style="font-size:12px;font-weight:bold;margin-top:5px">#'+p.id+' · '+p.shares+'sh @'+fmt2(p.entryPrice)+' · '+sgn(p.unrealizedPnl)+'</div>';
    }
  }
  h+='</div>';
  return h;
}

function panelHtml(st){
  if(!st)return'<div style="color:#666;padding:10px">Waiting...</div>';
  var h='';
  h+='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px">';
  h+='<div style="background:#111;border:1px solid #333;border-radius:5px;padding:4px 6px"><div style="font-size:7px;color:#888;text-transform:uppercase">Bankroll</div><div style="font-size:13px;color:#fff">$'+fmt2(st.bankroll)+'</div></div>';
  h+='<div style="background:#111;border:1px solid #333;border-radius:5px;padding:4px 6px"><div style="font-size:7px;color:#888;text-transform:uppercase">Realized</div><div style="font-size:13px" class="'+pC(st.realizedPnl)+'">'+sgn(st.realizedPnl)+'</div></div>';
  h+='<div style="background:#111;border:1px solid #333;border-radius:5px;padding:4px 6px"><div style="font-size:7px;color:#888;text-transform:uppercase">Float P&L</div><div style="font-size:13px" class="'+pC(st.unrealizedPnl)+'">'+sgn(st.unrealizedPnl)+'</div></div>';
  h+='<div style="background:#111;border:1px solid #333;border-radius:5px;padding:4px 6px"><div style="font-size:7px;color:#888;text-transform:uppercase">W/L</div><div style="font-size:13px;color:#fff"><span class="pos">'+(st.wins||0)+'W</span>/<span class="neg">'+(st.losses||0)+'L</span></div></div>';
  h+='</div>';

  var leg=st.currentLeg;
  if(leg&&leg.discovered){
    h+='<div class="price-box">';
    h+='<div class="price-item"><div class="price-label">UP MID</div><div class="price-val up" style="color:#00ccff">'+fmt3(leg.upMid)+'</div></div>';
    h+='<div class="price-item"><div class="price-label">Countdown</div><div class="price-val" style="color:#ffcc00">'+(leg.secsLeft||0)+'s</div></div>';
    h+='<div class="price-item"><div class="price-label">DOWN MID</div><div class="price-val" style="color:#aa88ff">'+fmt3(leg.downMid)+'</div></div>';
    h+='</div>';
  }

  h+=sideHtml('up',st.up);
  h+=sideHtml('down',st.down);

  var hist=st.history||[];
  if(hist.length){
    h+='<div style="font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px">Recent Windows</div>';
    h+='<div class="history-list">';
    for(var k=0;k<Math.min(hist.length,30);k++){
      var hw=hist[k];
      var resClass=hw.pnl>=0?'h-win':'h-loss';
      h+='<div class="h-item">';
      h+='<span style="color:#666;min-width:60px">'+hw.slug.replace('btc-updown-5m-','')+'</span>';
      h+='<span style="color:#aaa">'+hw.side.toUpperCase()+'</span>';
      h+='<span style="color:#888">'+hw.trades+' trades</span>';
      h+='<span class="h-result '+resClass+'">'+(hw.pnl>=0?'WIN':'LOSS')+'</span>';
      h+='<span style="font-size:11px" class="'+pC(hw.pnl)+'">'+sgn(hw.pnl)+'</span>';
      h+='</div>';
    }
    h+='</div>';
  }
  return h;
}

function drawChart(){
  var canvas=$('eq-chart');if(!canvas)return;
  var ctx=canvas.getContext('2d');
  var dpr=window.devicePixelRatio||1,W=canvas.clientWidth||800,H=canvas.clientHeight||120;
  canvas.width=W*dpr;canvas.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
  if(!latest||!latest.equityCurve||latest.equityCurve.length<2){ctx.fillStyle='#888';ctx.font='10px monospace';ctx.fillText('Collecting data...',14,20);return}
  var d=latest.equityCurve,cap=latest.startingCapital||4000;
  var min=Infinity,max=-Infinity;
  d.forEach(function(p){if(p.equity<min)min=p.equity;if(p.equity>max)max=p.equity});min=Math.min(min,cap);max=Math.max(max,cap);
  var pad=10,xA=function(i,l){return pad+(i/(l-1))*(W-pad*2)},yA=function(v){return H-pad-((v-min)/((max-min)||1))*(H-pad*2)};
  ctx.strokeStyle='#333';ctx.lineWidth=1;for(var g=0;g<=4;g++){var gy=pad+(g/4)*(H-pad*2);ctx.beginPath();ctx.moveTo(pad,gy);ctx.lineTo(W-pad,gy);ctx.stroke()}
  var vals=d.map(function(p){return p.equity});
  ctx.globalAlpha=.5;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(pad,yA(cap));ctx.lineTo(W-pad,yA(cap));ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
  ctx.beginPath();ctx.moveTo(xA(0,d.length),yA(vals[0]));for(var i=1;i<d.length;i++)ctx.lineTo(xA(i,d.length),yA(vals[i]));
  ctx.strokeStyle='#00ccff';ctx.lineWidth=2;ctx.stroke();
  ctx.lineTo(xA(d.length-1,d.length),H-pad);ctx.lineTo(xA(0,d.length),H-pad);ctx.closePath();ctx.fillStyle='#00ccff11';ctx.fill();
}

function render(){
  var st=latest;
  $('stats-row').innerHTML=[
    '<div class="st"><div class="st-l">Equity</div><div class="st-v">$'+fmt2(st?st.equity:0)+'</div></div>',
    '<div class="st"><div class="st-l">Realized</div><div class="st-v '+pC(st?st.realizedPnl:0)+'">'+sgn(st?st.realizedPnl:0)+'</div></div>',
    '<div class="st"><div class="st-l">W/L</div><div class="st-v"><span class="pos">'+(st?(st.wins||0):0)+'W</span>/<span class="neg">'+(st?(st.losses||0):0)+'L</span></div></div>',
    '<div class="st"><div class="st-l">Fees</div><div class="st-v">$'+fmt2(st?st.totalFeesPaid:0)+'</div></div>',
  ].join('');
  $('eng-body').innerHTML=panelHtml(st);
  $('eng-badge').textContent=(st?(st.wins||0)+'W/'+(st.losses||0)+'L':'--')+' | '+sgn(st?st.realizedPnl:0);
  var live=st&&!st.dryRun;
  $('mode-badge').className='badge '+(live?'badge-live':'badge-dem');
  $('mode-badge').textContent=live?'LIVE':'DEMO';
  drawChart();
}

function renderLogs(){
  var el=$('log-box');if(!el)return;
  var wasAtBottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=allLogs.slice(-200).map(function(l){
    var c='';
    if(l.indexOf('FAVORITE')>=0)c=' style="color:#00ccff"';
    else if(l.indexOf('RESOLVED')>=0)c=' style="color:'+(l.indexOf('WIN')>=0?'#00ff88':'#ff4444')+'"';
    else if(l.indexOf('RESOLVED')>=0)c=' style="color:#ffcc00"';
    return'<div'+c+'>'+l.replace(/</g,'&lt;')+'</div>';
  }).join('');
  if(wasAtBottom)el.scrollTop=el.scrollHeight;
}

socket.on('hedgeState:BTC-FAV',function(s){latest=s;render()});
socket.on('log',function(line){allLogs.push(line);if(allLogs.length>500)allLogs.shift();renderLogs()});
setInterval(render,1000);
setInterval(async function(){
  try{var res=await fetch('/api/hedge/status'),st=await res.json();
    if(st.engine)latest=st.engine;render();
  }catch(e){}
},10000);
render();
</script></body></html>`;

app.get('/', (_, res) => { res.type('html').send(DASH); });

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('PRIVATE_KEY env var missing'); process.exit(1); }

console.log('BTC Early Favorite Engine');
server.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard: http://0.0.0.0:' + PORT);
  (async () => {
    const trader = new PolymarketTrader(PK);
    await trader.authenticate();
    engine = createEngine({
      label: 'BTC-FAV',
      windowType: '5m',
      startingCapital: CAPITAL,
      windowSeconds5: 300,
      baseShares: BASE_SHARES,
      entryAtSeconds: ENTRY_SECOND,
      minFavoritePrice: MIN_FAVORITE_PRICE,
      statsStatePath: process.env.STATS_STATE_PATH || path.join(__dirname, 'stats-dip.json'),
      trader, dryRun: DRY_RUN, emit, slog,
    });
    await engine.start();
  })().catch(e => {
    console.error('Bot init failed:', e.message);
    process.exit(1);
  });
});
